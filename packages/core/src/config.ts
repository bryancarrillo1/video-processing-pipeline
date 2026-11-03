import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Like a pydantic BaseSettings: parse process.env once, fail fast on bad values,
// and get a fully typed object back. Defaults match docker-compose.yml.
const ConfigSchema = z.object({
  DATABASE_URL: z.string().default("postgres://vpp:vpp@localhost:5433/vpp"),
  S3_ENDPOINT: z.url().default("http://localhost:8333"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default("vpp"),
  S3_SECRET_KEY: z.string().default("vpp-secret"),
  // Private originals: reachable only through presigned URLs.
  S3_BUCKET: z.string().default("videos"),
  // Public-read outputs: renditions, playlists, thumbnails.
  MEDIA_BUCKET: z.string().default("media"),
  // Base URL the *browser* uses for media. Defaults to the bucket on the S3
  // endpoint; M6 points it at the CDN instead.
  MEDIA_PUBLIC_URL: z.url().optional(),
  API_PORT: z.coerce.number().int().default(3000),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 ** 3),
  // Browser origins allowed to PUT directly to storage (the UI dev server and the M9 gateway).
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://localhost:8080")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  SESSION_SECRET: z.string().min(32).default("dev-only-session-secret-change-me-in-prod"),

  SQS_ENDPOINT: z.url().default("http://localhost:9324"),
  SQS_QUEUE_NAME: z.string().default("jobs"),
  SQS_DLQ_NAME: z.string().default("jobs-dlq"),

  // How long a claimed job is reserved for one worker before others may take it.
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  // Media processing (M5). Binaries are looked up on PATH unless overridden.
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  // PROJECT_OVERVIEW input limit: "up to 30 minutes per video".
  MAX_DURATION_SECONDS: z.coerce.number().positive().default(30 * 60),
  // Scratch space for downloads and ffmpeg output; one subdirectory per attempt.
  WORK_DIR: z.string().default(path.join(os.tmpdir(), "vpp-work")),

  // Retries (PROJECT_OVERVIEW: "increasing delays with jitter").
  RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
  // Default attempts per job: "three retries means up to four attempts".
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),

  // Reconciler (runs inside the dispatcher).
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  // A pending job this overdue, with no unsent outbox row, is assumed lost.
  RECONCILE_STALE_PENDING_SECONDS: z.coerce.number().int().positive().default(60),

  // Worker registry heartbeat; a worker silent for 5 beats is considered dead.
  WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(1_000),
})
  // Fill in defaults that depend on other settings. `transform` changes the
  // parsed (output) type too, so MEDIA_PUBLIC_URL is a plain string from here on.
  .transform((c) => ({ ...c, MEDIA_PUBLIC_URL: c.MEDIA_PUBLIC_URL ?? `${c.S3_ENDPOINT}/${c.MEDIA_BUCKET}` }));

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);

