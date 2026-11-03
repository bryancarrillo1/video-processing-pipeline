import { createHash } from "node:crypto";
import {
  AppError,
  NotFoundError,
  config,
  emitEvent,
  enqueueJob,
  headObjectSize,
  mediaUrl,
  originalKey,
  pool,
  presignUpload,
  recomputeVideoStatus,
  withTransaction,
  type CreateVideoResponse,
  type ErrorKind,
  type JobEventView,
  type JobView,
  type JobKind,
  type JobState,
  type RenditionView,
  type UploadSessionStatus,
  type VideoDetail,
  type VideoStatus,
  type VideoSummary,
} from "@vpp/core";

export interface CreateVideoInput {
  title: string;
  fileName: string;
  fileSizeBytes: number;
}

export interface VideoStatusResponse {
  videoId: string;
  status: VideoStatus;
  playbackReady: boolean;
  availableResolutions: number[];
}

// Thrown inside the transaction to roll it back when another request with the
// same idempotency key won the race. Never escapes this module.
class IdempotencyRaceLost extends Error {}

// ---------------------------------------------------------------------------
// POST /videos
// ---------------------------------------------------------------------------

/**
 * Creates the video + upload session and returns a presigned upload URL.
 *
 * Idempotency: with a key, a retry returns the *same* videoId/uploadId instead
 * of creating a duplicate video. We store IDs rather than the full response so a
 * replay gets a freshly signed URL (the original may have expired).
 */
export async function createVideo(
  ownerId: string,
  input: CreateVideoInput,
  idempotencyKey?: string,
): Promise<{ response: CreateVideoResponse; replayed: boolean }> {
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  if (idempotencyKey) {
    const existing = await findIdempotentResult(ownerId, idempotencyKey, requestHash);
    if (existing) return { response: await buildCreateResponse(existing, input), replayed: true };
  }

  try {
    const ids = await withTransaction(async (tx) => {
      const videoId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO videos (id, owner_id, title, source_key) VALUES ($1, $2, $3, $4)`,
        [videoId, ownerId, input.title, originalKey(videoId)],
      );
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO upload_sessions (video_id, object_key, file_name, expected_size)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [videoId, originalKey(videoId), input.fileName, input.fileSizeBytes],
      );
      const uploadId = rows[0]!.id;

      if (idempotencyKey) {
        // If a concurrent request already inserted this key, this INSERT waits
        // for that transaction to commit, then inserts nothing. We roll back our
        // own video so exactly one video exists per key.
        const inserted = await tx.query(
          `INSERT INTO idempotency_keys (owner_id, key, request_hash, video_id, upload_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [ownerId, idempotencyKey, requestHash, videoId, uploadId],
        );
        if (inserted.rowCount === 0) throw new IdempotencyRaceLost();
      }
      return { videoId, uploadId };
    });
    return { response: await buildCreateResponse(ids, input), replayed: false };
  } catch (err) {
    if (!(err instanceof IdempotencyRaceLost) || !idempotencyKey) throw err;
    const winner = await findIdempotentResult(ownerId, idempotencyKey, requestHash);
    if (!winner) throw err; // unreachable: the conflicting row was committed
    return { response: await buildCreateResponse(winner, input), replayed: true };
  }
}

async function findIdempotentResult(
  ownerId: string,
  key: string,
  requestHash: string,
): Promise<{ videoId: string; uploadId: string } | null> {
  const { rows } = await pool.query<{ request_hash: string; video_id: string; upload_id: string }>(
    `SELECT request_hash, video_id, upload_id FROM idempotency_keys WHERE owner_id = $1 AND key = $2`,
    [ownerId, key],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new AppError(422, "idempotency_key_reused", "Idempotency-Key was already used with a different request body");
  }
  return { videoId: row.video_id, uploadId: row.upload_id };
}

async function buildCreateResponse(
  ids: { videoId: string; uploadId: string },
  input: CreateVideoInput,
): Promise<CreateVideoResponse> {
  const expiresAt = new Date(Date.now() + config.UPLOAD_URL_TTL_SECONDS * 1000);
  return {
    ...ids,
    uploadUrl: await presignUpload(originalKey(ids.videoId), input.fileSizeBytes),
    uploadUrlExpiresAt: expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /videos/:videoId/uploads/:uploadId/complete
// ---------------------------------------------------------------------------

interface UploadSessionRow {
  object_key: string;
  // pg returns Postgres `bigint` as a string, because JS numbers can't represent
  // every 64-bit integer exactly. We convert explicitly where we use it.
  expected_size: string;
  status: UploadSessionStatus;
  owner_id: string;
  video_status: VideoStatus;
}

/**
 * Verifies the bytes really landed in storage, then moves the video to `queued`.
 *
 * Safe to call repeatedly: a completed session just reports current state, and
 * the conditional UPDATEs (`WHERE status = 'pending'`) mean two concurrent
 * calls can't both "win" the transition.
 */
export async function completeUpload(
  ownerId: string,
  videoId: string,
  uploadId: string,
): Promise<{ videoId: string; status: VideoStatus }> {
  const { rows } = await pool.query<UploadSessionRow>(
    `SELECT s.object_key, s.expected_size, s.status, v.owner_id, v.status AS video_status
       FROM upload_sessions s JOIN videos v ON v.id = s.video_id
      WHERE s.id = $1 AND s.video_id = $2`,
    [uploadId, videoId],
  );
  const session = rows[0];
  // Same 404 for "doesn't exist" and "not yours" so IDs can't be probed.
  if (!session || session.owner_id !== ownerId) throw new NotFoundError("Upload");

  if (session.status === "completed") return { videoId, status: session.video_status };

  const actualSize = await headObjectSize(session.object_key);
  if (actualSize === null) {
    throw new AppError(409, "upload_incomplete", "No uploaded object found; upload the file before completing");
  }
  const expectedSize = Number(session.expected_size);
  if (actualSize !== expectedSize) {
    throw new AppError(422, "size_mismatch", "Uploaded object size does not match fileSizeBytes", {
      expectedSize,
      actualSize,
    });
  }

  const status = await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE upload_sessions SET status = 'completed', completed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [uploadId],
    );
    const moved = await tx.query(
      `UPDATE videos SET status = 'queued', updated_at = now()
        WHERE id = $1 AND status = 'uploading'`,
      [videoId],
    );
    if (moved.rowCount) await emitEvent(tx, { videoId, type: "upload_completed" });
    // Transactional outbox: the probe job and the instruction to enqueue it
    // commit together with the status change, or not at all. The API never
    // talks to the queue directly; the dispatcher does.
    await enqueueJob(tx, { videoId, kind: "probe" });
    return recomputeVideoStatus(tx, videoId);
  });

  return { videoId, status };
}

// ---------------------------------------------------------------------------
// Reads: status, library, detail
// ---------------------------------------------------------------------------

interface VideoRow {
  id: string;
  title: string;
  status: VideoStatus;
  created_at: Date;
  thumbnail_key: string | null;
  // Aggregated from `renditions`: only verified outputs are ever listed.
  heights: number[];
  progress: number | null;
}

// One query for both list and detail views; `$2` optionally narrows to one video.
const VIDEO_SELECT = `
  SELECT v.id, v.title, v.status, v.created_at, v.thumbnail_key,
         coalesce(array_agg(r.height ORDER BY r.height) FILTER (WHERE r.height IS NOT NULL), '{}') AS heights,
         (SELECT avg(j.progress)::float8 FROM processing_jobs j
           WHERE j.video_id = v.id AND j.kind = 'transcode') AS progress
    FROM videos v
    LEFT JOIN renditions r ON r.video_id = v.id
   WHERE v.owner_id = $1 AND ($2::uuid IS NULL OR v.id = $2)
   GROUP BY v.id
   ORDER BY v.created_at DESC
   LIMIT 100`;

function toSummary(row: VideoRow): VideoSummary {
  return {
    videoId: row.id,
    title: row.title,
    status: row.status,
    // Playback readiness is independent of overall status: one finished
    // rendition is enough to start watching while the others keep processing.
    playbackReady: row.heights.length > 0,
    availableResolutions: row.heights,
    progress: row.progress,
    thumbnailUrl: row.thumbnail_key ? mediaUrl(row.thumbnail_key) : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function findVideo(ownerId: string, videoId: string): Promise<VideoSummary> {
  const { rows } = await pool.query<VideoRow>(VIDEO_SELECT, [ownerId, videoId]);
  if (!rows[0]) throw new NotFoundError("Video");
  return toSummary(rows[0]);
}

export async function listVideos(ownerId: string): Promise<VideoSummary[]> {
  const { rows } = await pool.query<VideoRow>(VIDEO_SELECT, [ownerId, null]);
  return rows.map(toSummary);
}

export async function getVideoStatus(ownerId: string, videoId: string): Promise<VideoStatusResponse> {
  const { videoId: id, status, playbackReady, availableResolutions } = await findVideo(ownerId, videoId);
  return { videoId: id, status, playbackReady, availableResolutions };
}

export async function getVideoDetail(ownerId: string, videoId: string): Promise<VideoDetail> {
  const summary = await findVideo(ownerId, videoId);

  const { rows: [source] } = await pool.query<{
    width: number | null; height: number | null; duration_s: number | null; frame_rate: number | null;
  }>(`SELECT width, height, duration_s, frame_rate FROM videos WHERE id = $1`, [videoId]);

  const { rows: renditions } = await pool.query<{
    height: number; output_width: number | null; output_height: number | null; bandwidth: number | null;
    segment_count: number | null; output_prefix: string; verified_at: Date;
  }>(
    `SELECT height, output_width, output_height, bandwidth, segment_count, output_prefix, verified_at
       FROM renditions WHERE video_id = $1 ORDER BY height`,
    [videoId],
  );

  const { rows: jobs } = await pool.query<{
    id: string; kind: JobKind; target_height: number; state: JobState; attempt: number;
    max_attempts: number; progress: number; lease_owner: string | null; last_error: string | null;
    error_kind: ErrorKind | null; next_attempt_at: Date; started_at: Date | null; finished_at: Date | null;
  }>(
    `SELECT id, kind, target_height, state, attempt, max_attempts, progress, lease_owner,
            last_error, error_kind, next_attempt_at, started_at, finished_at
       FROM processing_jobs WHERE video_id = $1
      ORDER BY (kind = 'probe') DESC, target_height`,
    [videoId],
  );

  const { rows: events } = await pool.query<{
    id: string; job_id: string | null; type: string; attempt: number | null;
    worker_id: string | null; detail: Record<string, unknown>; at: Date;
  }>(
    `SELECT id, job_id, type, attempt, worker_id, detail, at
       FROM job_events WHERE video_id = $1 ORDER BY id DESC LIMIT 200`,
    [videoId],
  );

  return {
    ...summary,
    // The probe fills these in; until then we only know what the client claimed.
    source:
      source?.width && source.height && source.duration_s !== null && source.frame_rate !== null
        ? { width: source.width, height: source.height, durationS: source.duration_s, frameRate: source.frame_rate }
        : null,
    renditions: renditions.map((r): RenditionView => ({
      height: r.height,
      outputWidth: r.output_width,
      outputHeight: r.output_height,
      bandwidth: r.bandwidth,
      segmentCount: r.segment_count,
      playlistUrl: mediaUrl(`${r.output_prefix}index.m3u8`),
      verifiedAt: r.verified_at.toISOString(),
    })),
    jobs: jobs.map((j): JobView => ({
      jobId: j.id,
      kind: j.kind,
      targetHeight: j.target_height,
      state: j.state,
      attempt: j.attempt,
      maxAttempts: j.max_attempts,
      progress: j.progress,
      leaseOwner: j.lease_owner,
      lastError: j.last_error,
      errorKind: j.error_kind,
      nextAttemptAt: j.next_attempt_at.toISOString(),
      startedAt: j.started_at?.toISOString() ?? null,
      finishedAt: j.finished_at?.toISOString() ?? null,
    })),
    events: events.map((e): JobEventView => ({
      id: Number(e.id), // bigserial arrives as a string, like bigint above
      jobId: e.job_id,
      type: e.type,
      attempt: e.attempt,
      workerId: e.worker_id,
      detail: e.detail,
      at: e.at.toISOString(),
    })),
  };
}
