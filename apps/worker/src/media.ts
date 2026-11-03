import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PermanentError, TARGET_HEIGHTS, config } from "@vpp/core";

// Everything that touches ffprobe/ffmpeg. The handlers decide *what* to do
// with a video; this module knows *how*. The pure helpers at the top have no
// I/O and are unit tested directly (test/media.test.ts).

/** What ffprobe found in the uploaded file. */
export interface MediaInfo {
  width: number;
  height: number;
  durationS: number;
  frameRate: number;
  videoCodec: string;
  hasAudio: boolean;
}

/** The part of MediaInfo a transcode needs; stored on the video row by the probe. */
export type SourceMedia = Pick<MediaInfo, "width" | "height" | "durationS" | "frameRate">;

/** HLS segment length. Each segment holds two GOPs. */
export const SEGMENT_SECONDS = 4;
const GOP_SECONDS = 2;

// Bitrate ceiling per output height (kbit/s), roughly the usual streaming ladder.
const MAX_KBPS: Record<number, number> = { 360: 800, 720: 2800, 1080: 5000 };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** ffprobe reports frame rates as fractions: "30000/1001" → 29.97. Returns 0 if unknown. */
export function parseFrameRate(rate: string | undefined): number {
  const [num, den = "1"] = (rate ?? "").split("/");
  const value = Number(num) / Number(den);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The side that names the resolution. A portrait 1080×1920 phone video is
 * "1080p", the same way video sites label it, so we compare the short side.
 */
export function shortSide(media: Pick<MediaInfo, "width" | "height">): number {
  return Math.min(media.width, media.height);
}

/** Output heights worth producing: never upscale ("where the source supports them"). */
export function eligibleHeights(media: Pick<MediaInfo, "width" | "height">): number[] {
  return TARGET_HEIGHTS.filter((h) => h <= shortSide(media));
}

/**
 * Turns `ffprobe -show_format -show_streams` JSON into MediaInfo. A file with
 * no video stream is a permanent failure: no number of retries will add one.
 */
export function parseProbeOutput(json: unknown): MediaInfo {
  type Stream = { codec_type?: string; codec_name?: string; width?: number; height?: number;
    avg_frame_rate?: string; r_frame_rate?: string; duration?: string };
  const data = json as { streams?: Stream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && s.width && s.height);
  if (!video) throw new PermanentError("No video stream found in the uploaded file");
  // Variable-frame-rate sources may report 0/0 averages; fall back to the
  // nominal rate, then to 30.
  const frameRate = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate) || 30;
  return {
    width: video.width!,
    height: video.height!,
    durationS: Number(data.format?.duration ?? video.duration ?? NaN),
    // Very high rates (screen recordings at 120 fps) are capped: 60 is plenty to stream.
    frameRate: Math.min(60, Math.round(frameRate * 1000) / 1000),
    videoCodec: video.codec_name ?? "unknown",
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** Input limits from PROJECT_OVERVIEW. Breaking one is permanent: retrying won't shorten the video. */
export function validateSource(media: MediaInfo, maxDurationS: number): void {
  if (!Number.isFinite(media.durationS) || media.durationS <= 0) {
    throw new PermanentError("Couldn't determine the video's duration");
  }
  if (media.durationS > maxDurationS) {
    throw new PermanentError(
      `Video is ${formatMinutes(media.durationS)} long; the limit is ${formatMinutes(maxDurationS)}`,
    );
  }
  if (eligibleHeights(media).length === 0) {
    throw new PermanentError(`Source is ${shortSide(media)}p; the smallest output is ${TARGET_HEIGHTS[0]}p`);
  }
}

function formatMinutes(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * Keyframe interval in frames. Every rendition uses the same frame rate and
 * the same GOP, and scene-cut keyframes are off, so keyframes (and therefore
 * segment boundaries) land at identical timestamps in every rendition. That's
 * what lets a player switch quality at any segment boundary.
 */
export function gopFrames(frameRate: number): number {
  return Math.max(1, Math.round(frameRate * GOP_SECONDS));
}

/** Scales the short side to `height`, keeping the aspect ratio (-2 = "even number that fits"). */
export function scaleFilter(media: Pick<MediaInfo, "width" | "height">, height: number): string {
  return media.height > media.width ? `scale=${height}:-2` : `scale=-2:${height}`;
}

/**
 * Chaos "slow mode" for real work: ffmpeg's -readrate caps how fast it reads
 * input, as a multiple of real time. slowFactor 5 → real time, 10 → half that.
 * Returns null (full speed) when slow mode is off.
 */
export function slowReadRate(slowFactor: number): number | null {
  return slowFactor > 1 ? 5 / slowFactor : null;
}

/** `-progress pipe:1` prints key=value lines; returns seconds encoded so far, or null for other lines. */
export function parseProgressLine(line: string): number | null {
  const match = /^out_time_us=(\d+)$/.exec(line.trim());
  return match ? Number(match[1]) / 1e6 : null;
}

export interface Playlist {
  segments: Array<{ uri: string; durationS: number }>;
  /** #EXT-X-ENDLIST present: the encoder finished writing it. */
  ended: boolean;
}

/** Minimal media-playlist parser: just what verification needs. */
export function parsePlaylist(text: string): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== "#EXTM3U") throw new Error("Not an HLS playlist");
  const segments: Playlist["segments"] = [];
  let pending: number | null = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) pending = Number.parseFloat(line.slice("#EXTINF:".length));
    else if (line && !line.startsWith("#") && pending !== null) {
      segments.push({ uri: line, durationS: pending });
      pending = null;
    }
  }
  return { segments, ended: lines.includes("#EXT-X-ENDLIST") };
}

/**
 * HLS BANDWIDTH is the *peak* bit rate of any segment, not the average: a
 * player that picks a rendition by it must not stall on the busiest segment.
 */
export function peakBandwidth(segments: Array<{ bytes: number; durationS: number }>): number {
  return Math.round(Math.max(0, ...segments.map((s) => (s.bytes * 8) / Math.max(s.durationS, 0.001))));
}

// ---------------------------------------------------------------------------
// Running ffmpeg / ffprobe
// ---------------------------------------------------------------------------

/** A tool exited non-zero. `stderr` holds the tail of what it printed. */
export class ProcessError extends Error {
  constructor(readonly tool: string, readonly exitCode: number | null, readonly stderr: string) {
    super(`${tool} exited with ${exitCode}: ${lastLine(stderr) || "no output"}`);
    this.name = "ProcessError";
  }
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

// Live ffmpeg/ffprobe processes, so a simulated crash can take them down too.
// A real crash kills the whole container, children included; on a dev laptop
// `process.exit` would otherwise leave an orphaned ffmpeg running.
const children = new Set<ChildProcess>();
export function killChildren(): void {
  for (const child of children) child.kill("SIGKILL");
}

/**
 * Spawns a tool and resolves with its stdout. With `onLine`, stdout is
 * streamed line by line instead (for -progress). Aborting `signal` kills the
 * process: that's how a lost lease or a shutdown stops an encode mid-way.
 */
function run(
  tool: string,
  args: string[],
  opts: { signal?: AbortSignal | undefined; onLine?: (line: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal, killSignal: "SIGKILL" });
    children.add(child);
    let stdout = "";
    let partial = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (!opts.onLine) {
        stdout += chunk;
        return;
      }
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      lines.forEach(opts.onLine);
    });
    // Keep only the tail: ffmpeg can be chatty, and the end is what explains a failure.
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.on("error", (err: NodeJS.ErrnoException) => {
      children.delete(child);
      reject(
        err.code === "ENOENT"
          ? new Error(`${tool} not found: install ffmpeg (brew install ffmpeg) or set FFMPEG_PATH / FFPROBE_PATH`)
          : err,
      );
    });
    child.on("close", (code) => {
      children.delete(child);
      if (code === 0) resolve(stdout);
      else if (!opts.signal?.aborted) reject(new ProcessError(path.basename(tool), code, stderr));
    });
  });
}

/** Fails fast at worker startup instead of on the first job. */
export async function checkTools(): Promise<void> {
  await run(config.FFMPEG_PATH, ["-version"]);
  await run(config.FFPROBE_PATH, ["-version"]);
}

/**
 * Inspects a local file. If ffprobe can't read it at all ("Invalid data found
 * when processing input"), the upload is corrupt or not a video: permanent.
 */
export async function probeFile(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  let out: string;
  try {
    out = await run(
      config.FFPROBE_PATH,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { signal },
    );
  } catch (err) {
    if (err instanceof ProcessError) {
      throw new PermanentError(`Not a readable video file (${lastLine(err.stderr).replace(`${file}: `, "")})`);
    }
    throw err;
  }
  return parseProbeOutput(JSON.parse(out));
}

/** Grabs one frame, 360 px tall, as the library thumbnail. */
export async function extractThumbnail(src: string, out: string, durationS: number, signal?: AbortSignal) {
  // A little way in: the very first frame is often black.
  const at = Math.min(2, durationS / 4).toFixed(2);
  await run(
    config.FFMPEG_PATH,
    ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", at, "-i", src,
     "-frames:v", "1", "-vf", "scale=-2:360", "-q:v", "4", out],
    { signal },
  );
  // ffmpeg exits 0 without writing anything if there was no frame to grab.
  if (!(await stat(out).catch(() => null))?.size) throw new Error("Thumbnail extraction produced no image");
}

/**
 * Encodes one HLS rendition into `outDir` (index.m3u8 + seg_NNNN.ts),
 * reporting progress as a 0–1 fraction of the source duration.
 */
export async function transcodeToHls(opts: {
  src: string;
  outDir: string;
  height: number;
  media: SourceMedia;
  readRate: number | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const { src, outDir, height, media, readRate, signal, onProgress } = opts;
  const gop = String(gopFrames(media.frameRate));
  const maxKbps = MAX_KBPS[height] ?? Math.round(height * 4.6);
  // prettier-ignore
  const args = [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    ...(readRate ? ["-readrate", readRate.toFixed(3)] : []),
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?", // first video stream; audio if there is any
    "-vf", scaleFilter(media, height),
    "-r", String(media.frameRate), // constant frame rate, so a GOP in frames is a GOP in seconds
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
    "-crf", "23", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`,
    "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", // fixed GOP: aligned segments
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
    "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(outDir, "seg_%04d.ts"),
    "-progress", "pipe:1", "-nostats",
    path.join(outDir, "index.m3u8"),
  ];
  await run(config.FFMPEG_PATH, args, {
    signal,
    onLine: (line) => {
      const seconds = parseProgressLine(line);
      if (seconds !== null && onProgress) onProgress(Math.min(1, seconds / media.durationS));
    },
  });
}

export interface VerifiedRendition {
  width: number;
  height: number;
  bandwidth: number;
  segmentCount: number;
  /** Every file to publish (segments first, playlist last) with its size. */
  files: Array<{ name: string; bytes: number }>;
}

/**
 * Verify before publish (PROJECT_OVERVIEW: "file existence alone is
 * insufficient"). The playlist must be complete, every segment it lists must
 * exist and be non-empty, and ffprobe must decode the result at the right
 * size and roughly the source's duration. A failure here is retryable: the
 * input was fine (the probe proved it), so the encode itself went wrong.
 */
export async function verifyRendition(
  outDir: string,
  expected: { height: number; media: SourceMedia },
  signal?: AbortSignal,
): Promise<VerifiedRendition> {
  const fail = (why: string): never => {
    throw new Error(`Output verification failed: ${why}`);
  };
  const playlistPath = path.join(outDir, "index.m3u8");
  const playlist = parsePlaylist(await readFile(playlistPath, "utf8").catch(() => fail("no playlist written")));
  if (!playlist.ended) fail("playlist has no #EXT-X-ENDLIST (encode cut short)");
  if (playlist.segments.length === 0) fail("playlist lists no segments");

  const files: VerifiedRendition["files"] = [];
  const sized: Array<{ bytes: number; durationS: number }> = [];
  for (const seg of playlist.segments) {
    const bytes = (await stat(path.join(outDir, seg.uri)).catch(() => null))?.size ?? 0;
    if (bytes === 0) fail(`segment ${seg.uri} is missing or empty`);
    files.push({ name: seg.uri, bytes });
    sized.push({ bytes, durationS: seg.durationS });
  }

  // Decode check: does it actually play back at the size and length we expect?
  const out = await probeFile(playlistPath, signal).catch((err: Error) => fail(`ffprobe can't read it (${err.message})`));
  if (shortSide(out) !== expected.height) fail(`expected ${expected.height}p, got ${out.width}×${out.height}`);
  const tolerance = Math.max(1, expected.media.durationS * 0.05);
  if (Math.abs(out.durationS - expected.media.durationS) > tolerance) {
    fail(`duration ${out.durationS.toFixed(1)} s, source is ${expected.media.durationS.toFixed(1)} s`);
  }

  files.push({ name: "index.m3u8", bytes: (await stat(playlistPath)).size });
  return {
    width: out.width,
    height: out.height,
    bandwidth: peakBandwidth(sized),
    segmentCount: playlist.segments.length,
    files,
  };
}
