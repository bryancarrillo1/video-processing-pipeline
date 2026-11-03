import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermanentError } from "@vpp/core";
import { makeClip } from "../../../scripts/clip.ts";
import {
  eligibleHeights,
  gopFrames,
  parseFrameRate,
  parsePlaylist,
  parseProbeOutput,
  parseProgressLine,
  peakBandwidth,
  probeFile,
  scaleFilter,
  slowReadRate,
  transcodeToHls,
  validateSource,
  verifyRendition,
  type MediaInfo,
} from "../src/media.ts";

const media = (o: Partial<MediaInfo> = {}): MediaInfo => ({
  width: 1920, height: 1080, durationS: 10, frameRate: 30, videoCodec: "h264", hasAudio: true, ...o,
});

describe("pure helpers", () => {
  it("parses ffprobe frame rates", () => {
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("0/0")).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
  });

  it("never upscales, and names portrait videos by their short side", () => {
    expect(eligibleHeights({ width: 1920, height: 1080 })).toEqual([360, 720, 1080]);
    expect(eligibleHeights({ width: 1280, height: 720 })).toEqual([360, 720]);
    expect(eligibleHeights({ width: 1080, height: 1920 })).toEqual([360, 720, 1080]);
    expect(eligibleHeights({ width: 426, height: 240 })).toEqual([]);
    expect(scaleFilter({ width: 1920, height: 1080 }, 720)).toBe("scale=-2:720");
    expect(scaleFilter({ width: 1080, height: 1920 }, 720)).toBe("scale=720:-2");
  });

  it("rejects input that retrying can't fix as permanent", () => {
    expect(() => validateSource(media({ durationS: 31 * 60 }), 30 * 60)).toThrow(PermanentError);
    expect(() => validateSource(media({ durationS: 31 * 60 }), 30 * 60)).toThrow("31 min long; the limit is 30 min");
    expect(() => validateSource(media({ width: 426, height: 240 }), 1800)).toThrow("Source is 240p");
    expect(() => validateSource(media({ durationS: NaN }), 1800)).toThrow(PermanentError);
    expect(() => validateSource(media(), 1800)).not.toThrow();
    expect(() => parseProbeOutput({ streams: [{ codec_type: "audio" }], format: {} })).toThrow(PermanentError);
  });

  it("reads ffprobe JSON, falling back from a 0/0 average frame rate", () => {
    const info = parseProbeOutput({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "0/0", r_frame_rate: "25/1" },
        { codec_type: "audio" },
      ],
      format: { duration: "12.5" },
    });
    expect(info).toEqual({ width: 1280, height: 720, durationS: 12.5, frameRate: 25, videoCodec: "h264", hasAudio: true });
  });

  it("sizes the GOP in frames from the frame rate (2 s)", () => {
    expect(gopFrames(30)).toBe(60);
    expect(gopFrames(29.97)).toBe(60);
    expect(gopFrames(24)).toBe(48);
  });

  it("maps slow mode onto ffmpeg's -readrate", () => {
    expect(slowReadRate(1)).toBeNull();
    expect(slowReadRate(5)).toBe(1);
    expect(slowReadRate(10)).toBe(0.5);
  });

  it("parses -progress output and playlists", () => {
    expect(parseProgressLine("out_time_us=1500000")).toBe(1.5);
    expect(parseProgressLine("out_time_us=N/A")).toBeNull();
    expect(parseProgressLine("frame=10")).toBeNull();

    const pl = parsePlaylist("#EXTM3U\n#EXTINF:4.000000,\nseg_0000.ts\n#EXTINF:1.5,\nseg_0001.ts\n#EXT-X-ENDLIST\n");
    expect(pl).toEqual({
      segments: [{ uri: "seg_0000.ts", durationS: 4 }, { uri: "seg_0001.ts", durationS: 1.5 }],
      ended: true,
    });
    expect(parsePlaylist("#EXTM3U\n#EXTINF:4,\nseg_0000.ts\n").ended).toBe(false);
    expect(() => parsePlaylist("<html>")).toThrow("Not an HLS playlist");
  });

  it("uses the peak segment bit rate as BANDWIDTH, not the average", () => {
    expect(peakBandwidth([{ bytes: 500_000, durationS: 4 }, { bytes: 500_000, durationS: 2 }])).toBe(2_000_000);
  });
});

describe("ffmpeg", () => {
  let dir: string;
  let clip: string;
  let source: MediaInfo;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "vpp-media-test-"));
    clip = await makeClip({ width: 1280, height: 720, seconds: 6 });
    source = await probeFile(clip);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("probes a real file", () => {
    expect(source).toMatchObject({ width: 1280, height: 720, frameRate: 30, videoCodec: "h264", hasAudio: true });
    expect(source.durationS).toBeCloseTo(6, 0);
  });

  it("treats a file ffprobe can't read as permanently bad", async () => {
    const junk = path.join(dir, "junk.mp4");
    await writeFile(junk, "definitely not a video");
    await expect(probeFile(junk)).rejects.toBeInstanceOf(PermanentError);
    await expect(probeFile(junk)).rejects.toThrow("Not a readable video file");
  });

  it("encodes renditions whose segment boundaries line up, and verifies them", async () => {
    const outputs = [];
    for (const height of [360, 720]) {
      const outDir = await mkdtemp(path.join(dir, `r${height}-`));
      const ticks: number[] = [];
      await transcodeToHls({ src: clip, outDir, height, media: source, readRate: null, onProgress: (f) => ticks.push(f) });
      const verified = await verifyRendition(outDir, { height, media: source });
      expect(verified).toMatchObject({ height, segmentCount: 2 });
      expect(verified.files.at(-1)!.name).toBe("index.m3u8"); // playlist published last
      expect(verified.bandwidth).toBeGreaterThan(0);
      expect(ticks.at(-1)).toBeCloseTo(1, 1);
      outputs.push(parsePlaylist(await readFile(path.join(outDir, "index.m3u8"), "utf8")).segments);
    }
    // Same segment durations in every rendition: a player can switch at any boundary.
    expect(outputs[0]!.map((s) => s.durationS)).toEqual(outputs[1]!.map((s) => s.durationS));
  });

  it("refuses to verify output that is incomplete", async () => {
    const outDir = await mkdtemp(path.join(dir, "broken-"));
    await transcodeToHls({ src: clip, outDir, height: 360, media: source, readRate: null });
    const playlistPath = path.join(outDir, "index.m3u8");
    const playlist = await readFile(playlistPath, "utf8");

    // An encode cut short: no end marker.
    await writeFile(playlistPath, playlist.replace("#EXT-X-ENDLIST", ""));
    await expect(verifyRendition(outDir, { height: 360, media: source })).rejects.toThrow("no #EXT-X-ENDLIST");

    // Every file exists, but a segment is empty: existence alone isn't enough.
    await writeFile(playlistPath, playlist);
    await truncate(path.join(outDir, "seg_0001.ts"), 0);
    await expect(verifyRendition(outDir, { height: 360, media: source })).rejects.toThrow("seg_0001.ts is missing or empty");

    // Wrong size: verification checks what was actually encoded.
    await expect(verifyRendition(outDir, { height: 720, media: source })).rejects.toThrow(/verification failed/);
  });

  it("stops ffmpeg as soon as the job is aborted", async () => {
    const outDir = await mkdtemp(path.join(dir, "abort-"));
    const abort = new AbortController();
    const started = Date.now();
    // Throttled to half real time, this encode would take ~12 s.
    const encode = transcodeToHls({ src: clip, outDir, height: 360, media: source, readRate: 0.5, signal: abort.signal });
    setTimeout(() => abort.abort(), 300);
    await expect(encode).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
