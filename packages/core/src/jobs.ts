import { config } from "./config.ts";
import { withTransaction, type Queryable } from "./db.ts";
import type { ErrorKind, JobKind, JobState, PipelineEvent, VideoStatus } from "./domain.ts";

export interface JobRow {
  id: string;
  video_id: string;
  kind: JobKind;
  target_height: number;
  state: JobState;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  progress: number;
  last_error: string | null;
  error_kind: ErrorKind | null;
  next_attempt_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Thrown when a worker's attempt number no longer matches the row: someone else owns the job now. */
export class StaleLeaseError extends Error {
  constructor(readonly jobId: string, readonly attempt: number) {
    super(`Lease lost for job ${jobId} (attempt ${attempt})`);
    this.name = "StaleLeaseError";
  }
}

/**
 * A failure worth retrying: a network blip, a timeout, a full disk, a
 * deadlock. The job gets another attempt after a backoff delay, up to
 * max_attempts.
 */
export class RetryableError extends Error {
  override name = "RetryableError";
}

/**
 * A failure that retrying can't fix: corrupt or unsupported input. The job
 * fails immediately and is dead-lettered (PROJECT_OVERVIEW: "Corrupt or
 * unsupported input should fail without repeated retries").
 */
export class PermanentError extends Error {
  override name = "PermanentError";
}

export const PIPELINE_CHANNEL = "pipeline";

// ---------------------------------------------------------------------------
// Pure logic (no I/O) — unit tested directly.
// ---------------------------------------------------------------------------

/**
 * Derives a video's overall status from its jobs. Returns null when there is
 * nothing to derive yet (no jobs: the video is still uploading).
 *
 *   probe failed                      → failed  (nothing can be produced)
 *   all jobs terminal, ≥1 rendition   → ready   (even if some renditions failed)
 *   all jobs terminal, 0 renditions   → failed
 *   any job started or finished       → processing
 *   otherwise                         → queued
 */
export function computeVideoStatus(
  jobs: ReadonlyArray<{ kind: JobKind; state: JobState }>,
  renditionCount: number,
): VideoStatus | null {
  if (jobs.length === 0) return null;
  if (jobs.some((j) => j.kind === "probe" && j.state === "failed")) return "failed";
  const isTerminal = (s: JobState) => s === "completed" || s === "failed";
  if (jobs.every((j) => isTerminal(j.state))) return renditionCount > 0 ? "ready" : "failed";
  if (jobs.some((j) => j.state !== "pending")) return "processing";
  return "queued";
}

/**
 * Unknown errors count as retryable: most surprises in a pipeline (network,
 * storage, a deadlock) are transient, and max_attempts bounds the cost of
 * being wrong. Only errors that explicitly say "retrying won't help" are permanent.
 */
export function classifyError(err: unknown): ErrorKind {
  return err instanceof PermanentError ? "permanent" : "retryable";
}

/**
 * Delay before retry number `attempt` (1-based: the delay after the first
 * failed attempt is attempt=1). Exponential with "equal jitter": half the
 * exponential delay is guaranteed, the other half is random. The guaranteed
 * half makes delays actually increase; the random half spreads out workers that
 * failed together (e.g. during an outage) so they don't all retry in lockstep.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const exponential = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EmitEventInput {
  videoId: string;
  type: string;
  jobId?: string | null;
  attempt?: number | null;
  workerId?: string | null;
  detail?: Record<string, unknown>;
  /** false = notify listeners only, don't add a timeline row (e.g. progress ticks). */
  persist?: boolean;
}

/**
 * Records a timeline event and NOTIFYs listeners. Call it inside the same
 * transaction as the state change it describes: Postgres only delivers the
 * NOTIFY if the transaction commits, so listeners never hear about changes
 * that were rolled back.
 */
export async function emitEvent(tx: Queryable, e: EmitEventInput): Promise<void> {
  if (e.persist !== false) {
    await tx.query(
      `INSERT INTO job_events (video_id, job_id, type, attempt, worker_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.videoId, e.jobId ?? null, e.type, e.attempt ?? null, e.workerId ?? null, e.detail ?? {}],
    );
  }
  const { rows } = await tx.query<{ owner_id: string }>(`SELECT owner_id FROM videos WHERE id = $1`, [e.videoId]);
  const payload: PipelineEvent = {
    videoId: e.videoId,
    ownerId: rows[0]?.owner_id ?? "",
    type: e.type,
    jobId: e.jobId ?? null,
  };
  await tx.query(`SELECT pg_notify($1, $2)`, [PIPELINE_CHANNEL, JSON.stringify(payload)]);
}

// ---------------------------------------------------------------------------
// Creating jobs
// ---------------------------------------------------------------------------

/**
 * Creates a job and its outbox row in the caller's transaction. Idempotent:
 * if the (video, kind, height) job already exists, nothing happens and null is
 * returned — so retried requests and redelivered probe messages can't fan out twice.
 */
export async function enqueueJob(
  tx: Queryable,
  job: { videoId: string; kind: JobKind; targetHeight?: number },
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO processing_jobs (video_id, kind, target_height, max_attempts) VALUES ($1, $2, $3, $4)
     ON CONFLICT (video_id, kind, target_height) DO NOTHING RETURNING id`,
    [job.videoId, job.kind, job.targetHeight ?? 0, config.JOB_MAX_ATTEMPTS],
  );
  const jobId = rows[0]?.id;
  if (!jobId) return null;
  await tx.query(`INSERT INTO outbox (job_id) VALUES ($1)`, [jobId]);
  await emitEvent(tx, {
    videoId: job.videoId,
    jobId,
    type: "job_created",
    detail: { kind: job.kind, targetHeight: job.targetHeight ?? 0 },
  });
  return jobId;
}

// ---------------------------------------------------------------------------
// Claiming and finishing jobs
// ---------------------------------------------------------------------------

export async function getJob(db: Queryable, jobId: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(`SELECT * FROM processing_jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

/**
 * Atomically takes ownership of a job for one lease period. Succeeds only if
 * the job is pending, or running under a lease that has already expired (its
 * worker presumably died), and it still has attempts left. Returns null if
 * someone else holds it, it's done, or it's out of attempts (the reconciler
 * then fails and dead-letters it).
 *
 * The returned `attempt` is this worker's fencing token.
 */
export async function claimJob(jobId: string, workerId: string): Promise<JobRow | null> {
  return withTransaction(async (tx) => {
    // The CTE reads the row as it was before this statement (all parts of one
    // statement share a snapshot), so we can tell a normal claim from a
    // takeover of a dead worker's expired lease, worth flagging in the UI.
    // It must NOT say FOR UPDATE: it's evaluated lazily, after the UPDATE has
    // modified the row, and Postgres silently skips rows "updated by the
    // current command" when locking, so prev would come back empty.
    const { rows } = await tx.query<JobRow & { prev_owner: string | null; prev_state: JobState }>(
      `WITH prev AS (SELECT state, lease_owner FROM processing_jobs WHERE id = $1)
       UPDATE processing_jobs
          SET state = 'running',
              attempt = attempt + 1,
              lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3),
              started_at = coalesce(started_at, now()),
              progress = 0
        WHERE id = $1
          AND next_attempt_at <= now()
          AND attempt < max_attempts
          AND (state = 'pending' OR (state = 'running' AND lease_expires_at < now()))
        RETURNING processing_jobs.*, (SELECT lease_owner FROM prev) AS prev_owner, (SELECT state FROM prev) AS prev_state`,
      [jobId, workerId, config.JOB_LEASE_SECONDS],
    );
    const row = rows[0];
    if (!row) return null;
    const { prev_owner, prev_state, ...job } = row;
    const takeover = prev_state === "running";
    await emitEvent(tx, {
      videoId: job.video_id,
      jobId,
      type: "claimed",
      attempt: job.attempt,
      workerId,
      detail: takeover ? { takeover: true, previousOwner: prev_owner } : {},
    });
    await recomputeVideoStatus(tx, job.video_id);
    return job;
  });
}

/**
 * Heartbeat: pushes the lease forward while work is in progress. Returns false
 * if the lease is already gone (expired and claimed by someone else), in which
 * case the caller must stop working on the job.
 */
export async function extendLease(job: JobRow): Promise<boolean> {
  const res = await withTransaction((tx) =>
    tx.query(
      `UPDATE processing_jobs SET lease_expires_at = now() + make_interval(secs => $3)
        WHERE id = $1 AND attempt = $2 AND state = 'running'`,
      [job.id, job.attempt, config.JOB_LEASE_SECONDS],
    ),
  );
  return res.rowCount === 1;
}

/**
 * Graceful handoff on shutdown: gives the job back (pending, no lease) so
 * another worker can claim it immediately rather than after the lease expires.
 * Fenced like every other write; returns false if we no longer owned it.
 */
export async function releaseJob(job: JobRow, workerId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const res = await tx.query(
      `UPDATE processing_jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, progress = 0
        WHERE id = $1 AND attempt = $2 AND state = 'running'`,
      [job.id, job.attempt],
    );
    if (res.rowCount === 0) return false;
    await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "released", attempt: job.attempt, workerId });
    await recomputeVideoStatus(tx, job.video_id);
    return true;
  });
}

/** Fenced: only writes if `attempt` still matches. Progress ticks are notify-only. */
export async function updateProgress(job: JobRow, progress: number): Promise<void> {
  await withTransaction(async (tx) => {
    const res = await tx.query(
      `UPDATE processing_jobs SET progress = $3 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
      [job.id, job.attempt, progress],
    );
    if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
    await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "progress", persist: false });
  });
}

/**
 * Marks the job completed — but only if this worker's attempt still owns it.
 * Must run in the same transaction as the job's other result writes, so that
 * either all of them land or none do. `detail` goes on the timeline event
 * (what the probe found, what the transcode verified).
 */
export async function markJobCompleted(
  tx: Queryable,
  job: JobRow,
  workerId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const res = await tx.query(
    `UPDATE processing_jobs
        SET state = 'completed', progress = 1, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND attempt = $2 AND state = 'running'`,
    [job.id, job.attempt],
  );
  if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
  await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "completed", attempt: job.attempt, workerId, detail });
}

export interface FailureInput {
  error: string;
  kind: ErrorKind;
  /** Who observed the failure: a worker id, or "reconciler". */
  actor: string;
}

/**
 * Records a failed attempt and decides what happens next, in the caller's
 * transaction:
 *   - retryable with attempts left → back to `pending` with a backoff delay,
 *     plus an outbox row that only becomes due after that delay
 *   - permanent, or out of attempts → `failed`, plus a dead-letter outbox row
 *
 * Fenced on (attempt, state = 'running'), like every result write.
 * Returns what it did so callers can log it.
 */
export async function recordFailure(
  tx: Queryable,
  job: JobRow,
  failure: FailureInput,
): Promise<"retry_scheduled" | "dead_lettered"> {
  const retry = failure.kind === "retryable" && job.attempt < job.max_attempts;

  if (retry) {
    const delayMs = backoffDelayMs(job.attempt, { baseMs: config.RETRY_BASE_MS, maxMs: config.RETRY_MAX_MS });
    const res = await tx.query<{ next_attempt_at: Date }>(
      `UPDATE processing_jobs
          SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, progress = 0,
              last_error = $3, error_kind = 'retryable',
              next_attempt_at = now() + make_interval(secs => $4::float8 / 1000)
        WHERE id = $1 AND attempt = $2 AND state = 'running'
        RETURNING next_attempt_at`,
      [job.id, job.attempt, failure.error, delayMs],
    );
    if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
    // The outbox row becomes due at the same moment the job does, so the
    // dispatcher only sends it once a worker is allowed to claim it.
    await tx.query(`INSERT INTO outbox (job_id, available_at) VALUES ($1, $2)`, [job.id, res.rows[0]!.next_attempt_at]);
    await emitEvent(tx, {
      videoId: job.video_id,
      jobId: job.id,
      type: "retry_scheduled",
      attempt: job.attempt,
      workerId: failure.actor,
      detail: { error: failure.error, delayMs, nextAttempt: job.attempt + 1, maxAttempts: job.max_attempts },
    });
    await recomputeVideoStatus(tx, job.video_id);
    return "retry_scheduled";
  }

  const res = await tx.query(
    `UPDATE processing_jobs
        SET state = 'failed', finished_at = now(), last_error = $3, error_kind = $4,
            lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND attempt = $2 AND state = 'running'`,
    [job.id, job.attempt, failure.error, failure.kind],
  );
  if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
  // Dead-lettering goes through the outbox too, so it commits atomically with
  // the failure: there's never a failed job missing from the DLQ, or vice versa.
  await tx.query(`INSERT INTO outbox (job_id, queue) VALUES ($1, 'dead-letter')`, [job.id]);
  await emitEvent(tx, {
    videoId: job.video_id,
    jobId: job.id,
    type: "failed",
    attempt: job.attempt,
    workerId: failure.actor,
    detail: {
      error: failure.error,
      errorKind: failure.kind,
      reason: failure.kind === "permanent" ? "permanent" : "exhausted",
    },
  });
  await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "dead_lettered", attempt: job.attempt });
  await recomputeVideoStatus(tx, job.video_id);
  return "dead_lettered";
}

/**
 * Operator action ("redrive"): gives a failed job a fresh budget of attempts.
 *
 * Note what does NOT happen: `attempt` is never reset. It's the fencing token,
 * so it must only ever increase; a zombie from attempt 3 must not become
 * valid again. Instead the ceiling moves: max_attempts = attempt + budget.
 * Returns false if the job isn't failed (already redriven, or never failed),
 * which makes redriving idempotent.
 */
export async function redriveJob(jobId: string, actor: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<JobRow>(
      `UPDATE processing_jobs
          SET state = 'pending', max_attempts = attempt + $2, next_attempt_at = now(),
              progress = 0, error_kind = NULL, finished_at = NULL
        WHERE id = $1 AND state = 'failed'
        RETURNING *`,
      [jobId, config.JOB_MAX_ATTEMPTS],
    );
    const job = rows[0];
    if (!job) return false;
    await tx.query(`INSERT INTO outbox (job_id) VALUES ($1)`, [job.id]);
    await emitEvent(tx, {
      videoId: job.video_id,
      jobId: job.id,
      type: "redriven",
      attempt: job.attempt,
      workerId: actor,
      detail: { maxAttempts: job.max_attempts },
    });
    await recomputeVideoStatus(tx, job.video_id);
    return true;
  });
}

/**
 * Re-derives the video's status from its jobs and renditions. Locks the video
 * row first, so two jobs finishing at the same moment are serialized here
 * instead of overwriting each other's update.
 *
 * Why FOR NO KEY UPDATE and not FOR UPDATE: by the time we get here, the
 * transaction has inserted a job_events row, and that foreign key took
 * FOR KEY SHARE on this video row. FOR UPDATE conflicts with KEY SHARE, so two
 * transactions that each hold KEY SHARE and each want FOR UPDATE deadlock.
 * FOR NO KEY UPDATE (the lock an UPDATE of non-key columns takes anyway) is
 * compatible with KEY SHARE but still conflicts with itself, so concurrent
 * recomputes for one video remain serialized.
 */
export async function recomputeVideoStatus(tx: Queryable, videoId: string): Promise<VideoStatus> {
  const { rows: videoRows } = await tx.query<{ status: VideoStatus }>(
    `SELECT status FROM videos WHERE id = $1 FOR NO KEY UPDATE`,
    [videoId],
  );
  const current = videoRows[0]!.status;
  const { rows: jobs } = await tx.query<{ kind: JobKind; state: JobState }>(
    `SELECT kind, state FROM processing_jobs WHERE video_id = $1`,
    [videoId],
  );
  const { rows: countRows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM renditions WHERE video_id = $1`,
    [videoId],
  );
  const next = computeVideoStatus(jobs, countRows[0]!.n);
  if (!next || next === current) return current;

  await tx.query(`UPDATE videos SET status = $2, updated_at = now() WHERE id = $1`, [videoId, next]);
  await emitEvent(tx, { videoId, type: "video_status", detail: { from: current, to: next } });
  return next;
}

/** Convenience for code paths that aren't already inside a transaction. */
export function recordEvent(e: EmitEventInput): Promise<void> {
  return withTransaction((tx) => emitEvent(tx, e));
}

