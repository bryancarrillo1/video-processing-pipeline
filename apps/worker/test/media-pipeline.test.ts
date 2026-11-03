import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { VideoDetail } from "@vpp/core";

// End to end with real media: API → storage → dispatcher → worker (ffprobe,
// ffmpeg) → media bucket → API. A low duration limit lets one test exercise
// the "too long" rule without a 30-minute fixture; config is read at import
// time, so set it before importing anything.
process.env.MAX_DURATION_SECONDS = "10";

const { pool } = await import("@vpp/core");
const { buildApp } = await import("../../api/src/server.ts");
const { dispatchOnce } = await import("../../dispatcher/src/dispatcher.ts");
const { pollOnce } = await import("../src/worker.ts");
const { parsePlaylist } = await import("../src/media.ts");
const { makeClip } = await import("../../../scripts/clip.ts");

let app: FastifyInstance;
const headers = { "x-user-id": `media-${crypto.randomUUID()}` };
const quiet = { info() {}, warn() {}, error() {} };
const never = new AbortController().signal;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Uploads `bytes` the way a client does (presigned PUT) and completes the upload. */
async function upload(bytes: Uint8Array<ArrayBuffer>, title = "Media test"): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/videos",
    headers,
    payload: { title, fileName: "clip.mp4", fileSizeBytes: bytes.length },
  });
  const { videoId, uploadId, uploadUrl } = created.json();
  expect((await fetch(uploadUrl, { method: "PUT", body: bytes })).ok).toBe(true);
  await app.inject({ method: "POST", url: `/videos/${videoId}/uploads/${uploadId}/complete`, headers });
  return videoId;
}

const detail = async (videoId: string): Promise<VideoDetail> =>
  (await app.inject({ url: `/videos/${videoId}`, headers })).json();

/** Runs dispatcher + one worker until the video settles (ready or failed). */
async function processVideo(videoId: string, timeoutMs = 60_000): Promise<VideoDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await detail(videoId);
    if (d.status === "ready" || d.status === "failed") return d;
    if (Date.now() > deadline) throw new Error(`video stuck in ${d.status}`);
    await dispatchOnce();
    await pollOnce("media-worker", never, { waitSeconds: 1, log: quiet });
  }
}

describe("real media pipeline", () => {
  it("probes, fans out and transcodes a 1080p upload into verified, public HLS renditions", async () => {
    const videoId = await upload(await readFile(await makeClip({ width: 1920, height: 1080, seconds: 5 })));
    const d = await processVideo(videoId);

    expect(d).toMatchObject({ status: "ready", playbackReady: true, availableResolutions: [360, 720, 1080] });
    expect(d.source).toMatchObject({ width: 1920, height: 1080, frameRate: 30 });
    expect(d.source!.durationS).toBeCloseTo(5, 0);
    for (const job of d.jobs) expect(job).toMatchObject({ state: "completed", attempt: 1 });

    // The thumbnail and every playlist are public: fetched with no credentials.
    const thumb = await fetch(d.thumbnailUrl!);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect((await thumb.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const segmentDurations: number[][] = [];
    for (const r of d.renditions) {
      expect(r.playlistUrl).toContain(`/renditions/${videoId}/${r.height}/a1/index.m3u8`);
      expect(r.bandwidth).toBeGreaterThan(0);
      const res = await fetch(r.playlistUrl);
      expect(res.ok).toBe(true);
      const playlist = parsePlaylist(await res.text());
      expect(playlist.ended).toBe(true);
      expect(playlist.segments).toHaveLength(r.segmentCount!);
      // Each segment referenced by the playlist is really there.
      const seg = await fetch(new URL(playlist.segments[0]!.uri, r.playlistUrl));
      expect(seg.headers.get("content-type")).toBe("video/mp2t");
      segmentDurations.push(playlist.segments.map((s) => s.durationS));
    }
    expect(d.renditions.map((r) => [r.outputWidth, r.outputHeight])).toEqual([[640, 360], [1280, 720], [1920, 1080]]);
    // Aligned segments across all renditions (fixed GOP).
    expect(new Set(segmentDurations.map((s) => s.join(","))).size).toBe(1);

    // The timeline says what the probe found.
    const probeDone = d.events.find((e) => e.type === "completed" && e.jobId === d.jobs[0]!.jobId);
    expect(probeDone?.detail).toMatchObject({ width: 1920, height: 1080, renditions: [360, 720, 1080] });
  }, 90_000);

  it("never upscales: a 720p source gets 360p and 720p only", async () => {
    const videoId = await upload(await readFile(await makeClip({ width: 1280, height: 720, seconds: 2 })));
    const d = await processVideo(videoId);
    expect(d.status).toBe("ready");
    expect(d.jobs.map((j) => [j.kind, j.targetHeight])).toEqual([["probe", 0], ["transcode", 360], ["transcode", 720]]);
    expect(d.availableResolutions).toEqual([360, 720]);
  });

  it("keeps a portrait video upright and names it by its short side", async () => {
    const videoId = await upload(await readFile(await makeClip({ width: 360, height: 640, seconds: 2, audio: false })));
    const d = await processVideo(videoId);
    expect(d.status).toBe("ready");
    expect(d.availableResolutions).toEqual([360]);
    expect(d.renditions.map((r) => [r.outputWidth, r.outputHeight])).toEqual([[360, 640]]);
  });

  it("fails a corrupt upload permanently on the first attempt and dead-letters it", async () => {
    const videoId = await upload(new TextEncoder().encode("this is not a video, just some bytes"));
    const d = await processVideo(videoId);
    expect(d.status).toBe("failed");
    expect(d.jobs).toHaveLength(1); // no fan-out
    expect(d.jobs[0]).toMatchObject({ kind: "probe", state: "failed", attempt: 1, errorKind: "permanent" });
    expect(d.jobs[0]!.lastError).toMatch(/Not a readable video file/);
    expect(d.thumbnailUrl).toBeNull();
    expect(d.events.map((e) => e.type)).toContain("dead_lettered");
  });

  it("rejects a video over the duration limit without retrying", async () => {
    const videoId = await upload(await readFile(await makeClip({ width: 640, height: 360, seconds: 12, audio: false })));
    const d = await processVideo(videoId);
    expect(d.jobs[0]).toMatchObject({ state: "failed", attempt: 1, errorKind: "permanent" });
    expect(d.jobs[0]!.lastError).toBe("Video is 12 s long; the limit is 10 s");
  });
});
