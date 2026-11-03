import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  config,
  downloadOriginal,
  enqueueJob,
  listMediaObjects,
  markJobCompleted,
  pool,
  recomputeVideoStatus,
  renditionPrefix,
  thumbnailKey,
  updateProgress,
  uploadMediaFile,
  withTransaction,
  type JobKind,
  type JobRow,
} from "@vpp/core";
import type { Faults } from "./faults.ts";
import {
  eligibleHeights,
  extractThumbnail,
  probeFile,
  slowReadRate,
  transcodeToHls,
  validateSource,
  verifyRendition,
  type SourceMedia,
} from "./media.ts";

export interface JobContext {
  job: JobRow;
  workerId: string;
  signal: AbortSignal;
  faults: Faults;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/**
 * Inspects the original for real: is it decodable, how big and how long is it?
 * Then it grabs a thumbnail and fans out one transcode per eligible height.
 * Bad input (not a video, too long, too small) fails permanently, with no retries.
 */
const probe: JobHandler = async ({ job, workerId, signal, faults }) => {
  faults.atStart();
  const { source_key } = await loadVideo(job.video_id);

  await withWorkDir(job, async (dir) => {
    const src = path.join(dir, "source");
    await downloadOriginal(source_key, src, signal);
    await updateProgress(job, 0.3);

    const media = await probeFile(src, signal);
    validateSource(media, config.MAX_DURATION_SECONDS);
    const heights = eligibleHeights(media);
    await updateProgress(job, 0.6);

    const thumbPath = path.join(dir, "thumb.jpg");
    await extractThumbnail(src, thumbPath, media.durationS, signal);
    const thumbKey = thumbnailKey(job.video_id, job.attempt);
    await uploadMediaFile(thumbKey, thumbPath, "image/jpeg");

    await faults.beforeCommit();
    await withTransaction(async (tx) => {
      // Fence first: if we no longer own the job, nothing below is written.
      await markJobCompleted(tx, job, workerId, { ...media, renditions: heights });
      await tx.query(
        `UPDATE videos SET duration_s = $2, width = $3, height = $4, frame_rate = $5, thumbnail_key = $6,
                updated_at = now()
          WHERE id = $1`,
        [job.video_id, media.durationS, media.width, media.height, media.frameRate, thumbKey],
      );
      // Fan-out is idempotent thanks to UNIQUE(video_id, kind, target_height).
      for (const height of heights) {
        await enqueueJob(tx, { videoId: job.video_id, kind: "transcode", targetHeight: height });
      }
      await recomputeVideoStatus(tx, job.video_id);
    });
  });
};

/**
 * Encodes one HLS rendition, verifies it, publishes it to the media bucket,
 * checks what storage actually holds, and only then records the rendition.
 * A `renditions` row therefore always means "complete, verified, playable".
 */
const transcode: JobHandler = async ({ job, workerId, signal, faults }) => {
  faults.atStart();
  const video = await loadVideo(job.video_id);
  const media = video.media;
  // Unreachable in practice: transcode jobs are only created by a completed probe.
  if (!media) throw new Error("Source metadata missing; the probe hasn't recorded it");
  const report = progressReporter(job);

  await withWorkDir(job, async (dir) => {
    const src = path.join(dir, "source");
    await downloadOriginal(video.source_key, src, signal);
    report(0.05);

    const outDir = path.join(dir, "out");
    await mkdir(outDir);
    await transcodeToHls({
      src,
      outDir,
      height: job.target_height,
      media,
      readRate: slowReadRate(faults.slowFactor),
      signal,
      // Encoding is the bulk of the work: 5% → 85%.
      onProgress: (f) => report(0.05 + f * 0.8),
    });

    const output = await verifyRendition(outDir, { height: job.target_height, media }, signal);
    report(0.9);

    // Publish under an attempt-scoped prefix, segments first and the playlist
    // last, so a playlist in storage implies its segments are there too.
    const prefix = renditionPrefix(job.video_id, job.target_height, job.attempt);
    for (const file of output.files) {
      const type = file.name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
      await uploadMediaFile(prefix + file.name, path.join(outDir, file.name), type);
    }
    await verifyStored(prefix, output.files);

    await faults.beforeCommit();
    await withTransaction(async (tx) => {
      await markJobCompleted(tx, job, workerId, {
        width: output.width,
        height: output.height,
        bandwidth: output.bandwidth,
        segmentCount: output.segmentCount,
        outputPrefix: prefix,
      });
      await tx.query(
        `INSERT INTO renditions (video_id, height, output_width, output_height, bandwidth, segment_count, output_prefix)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (video_id, height) DO NOTHING`,
        [job.video_id, job.target_height, output.width, output.height, output.bandwidth, output.segmentCount, prefix],
      );
      await recomputeVideoStatus(tx, job.video_id);
    });
  });
};

// `Record<JobKind, JobHandler>` makes the compiler insist on a handler for
// every job kind — add a kind to the union and this line stops compiling.
// Tests swap these for fast fakes (test/fake-handlers.ts), the same way they
// swap runtime.crash, to exercise the job machinery without ffmpeg.
export const handlers: Record<JobKind, JobHandler> = { probe, transcode };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadVideo(videoId: string): Promise<{ source_key: string; media: SourceMedia | null }> {
  const { rows } = await pool.query<{
    source_key: string; width: number | null; height: number | null; duration_s: number | null;
    frame_rate: number | null;
  }>(`SELECT source_key, width, height, duration_s, frame_rate FROM videos WHERE id = $1`, [videoId]);
  const v = rows[0];
  if (!v) throw new Error(`Video ${videoId} not found`);
  const media =
    v.width && v.height && v.duration_s && v.frame_rate
      ? { width: v.width, height: v.height, durationS: v.duration_s, frameRate: v.frame_rate }
      : null;
  return { source_key: v.source_key, media };
}

/**
 * A scratch directory private to this attempt, always removed afterwards.
 * (A crashed worker leaves its directory behind; the next attempt has a
 * different name, so it can't trip over the leftovers.)
 */
async function withWorkDir<T>(job: JobRow, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(config.WORK_DIR, `${job.id}-a${job.attempt}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Re-checks the published copy, not the local one: every file must be in
 * storage with exactly the size we wrote. This is the "verify existing output
 * before recording completion" step from PROJECT_OVERVIEW.
 */
async function verifyStored(prefix: string, files: Array<{ name: string; bytes: number }>): Promise<void> {
  const stored = await listMediaObjects(prefix);
  for (const f of files) {
    const size = stored.get(prefix + f.name);
    if (size !== f.bytes) {
      throw new Error(`Published output incomplete: ${f.name} is ${size ?? "missing"} in storage, expected ${f.bytes} bytes`);
    }
  }
}

/**
 * ffmpeg reports progress several times a second; the UI needs far less.
 * Writes at most ~3 times a second and only on a visible change. Ticks are
 * fire-and-forget (ffmpeg's output can't wait on the database) but chained so
 * they land in order. Errors are dropped: if the lease is gone, the heartbeat
 * notices and aborts the encode.
 */
function progressReporter(job: JobRow): (fraction: number) => void {
  let last = 0;
  let lastAt = 0;
  let chain = Promise.resolve();
  return (fraction) => {
    const now = Date.now();
    if (fraction - last < 0.01 || now - lastAt < 300) return;
    last = fraction;
    lastAt = now;
    chain = chain.then(() => updateProgress(job, fraction)).catch(() => {});
  };
}
