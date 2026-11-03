// Domain types shared by the API, dispatcher, workers and the web UI.
// This file must stay free of Node-only imports: the browser bundle imports it
// via "@vpp/core/domain".

// A union of string literals is TypeScript's lightweight enum (≈ Python's Literal[...]).
// `as const` keeps the array's element types as literals so we can derive the type from it.
export const VIDEO_STATUSES = ["uploading", "queued", "processing", "ready", "failed"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const UPLOAD_SESSION_STATUSES = ["pending", "completed"] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export type JobKind = "probe" | "transcode";
export type JobState = "pending" | "running" | "completed" | "failed";
export type ErrorKind = "retryable" | "permanent";

/** Output heights we produce, smallest first. */
export const TARGET_HEIGHTS = [360, 720, 1080] as const;

// ---------------------------------------------------------------------------
// API response shapes. The UI imports these too, so both sides compile
// against one definition.
// ---------------------------------------------------------------------------

export interface CreateVideoResponse {
  videoId: string;
  uploadId: string;
  uploadUrl: string;
  uploadUrlExpiresAt: string;
}

export interface VideoSummary {
  videoId: string;
  title: string;
  status: VideoStatus;
  playbackReady: boolean;
  availableResolutions: number[];
  /** Mean progress of transcode jobs (0–1), or null before any exist. */
  progress: number | null;
  /** A frame from the source, extracted by the probe; null until then. */
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface JobView {
  jobId: string;
  kind: JobKind;
  targetHeight: number;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  progress: number;
  leaseOwner: string | null;
  lastError: string | null;
  errorKind: ErrorKind | null;
  /** When a pending job may next be claimed (in the future while backing off). */
  nextAttemptAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEventView {
  id: number;
  jobId: string | null;
  type: string;
  attempt: number | null;
  workerId: string | null;
  detail: Record<string, unknown>;
  at: string;
}

/** What the probe found in the uploaded file (null until the probe completes). */
export interface SourceInfo {
  width: number;
  height: number;
  durationS: number;
  frameRate: number;
}

/** A verified, playable output. Only renditions that passed verification exist. */
export interface RenditionView {
  /** The rung: 360, 720 or 1080 (the short side, so portrait video fits the same ladder). */
  height: number;
  /** Actual encoded size, e.g. 1280×720, or 720×1280 for portrait. */
  outputWidth: number | null;
  outputHeight: number | null;
  /** Peak bits/s over any one segment (HLS BANDWIDTH). */
  bandwidth: number | null;
  segmentCount: number | null;
  /** The rendition's own HLS playlist; the master manifest arrives in M6. */
  playlistUrl: string;
  verifiedAt: string;
}

export interface VideoDetail extends VideoSummary {
  source: SourceInfo | null;
  renditions: RenditionView[];
  jobs: JobView[];
  events: JobEventView[];
}

/** Fault-injection settings (one global row), editable from the System page. */
export interface ChaosSettings {
  failureRate: number;
  permanentFailures: boolean;
  slowFactor: number;
  dispatcherPaused: boolean;
  crashNext: number;
}

export interface WorkerView {
  workerId: string;
  hostname: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  /** False once the heartbeat has stopped (crashed); the reconciler then removes it. */
  alive: boolean;
  currentJob: { jobId: string; label: string; videoId: string; videoTitle: string } | null;
  killRequested: boolean;
}

export interface SystemView {
  workers: WorkerView[];
  chaos: ChaosSettings;
  queues: {
    jobs: { visible: number; inFlight: number };
    deadLetter: { visible: number; inFlight: number };
  };
  /** Outbox rows not yet sent: grows while the dispatcher is paused or down. */
  outboxBacklog: number;
  jobsByState: Record<JobState, number>;
}

/** Payload pushed over Server-Sent Events. A hint to refetch, not the state itself. */
export interface PipelineEvent {
  videoId: string;
  ownerId: string;
  type: string;
  jobId: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, "not_found", `${what} not found`);
  }
}
