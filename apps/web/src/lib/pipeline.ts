// Pure view-model helpers for the pipeline UI. No React, no I/O, so they're
// unit tested directly (apps/web/test/pipeline.test.ts).
import { TARGET_HEIGHTS, type JobEventView, type JobView, type SourceInfo, type VideoStatus } from "@vpp/core/domain";

// ---------------------------------------------------------------------------
// Lanes: one row per job in the pipeline view
// ---------------------------------------------------------------------------

export type Lane =
  | { kind: "job"; key: string; label: string; job: JobView }
  // A transcode that doesn't exist yet because the probe hasn't fanned out.
  | { kind: "placeholder"; key: string; label: string }
  // A transcode the probe decided not to create (no upscaling), or couldn't.
  | { kind: "skipped"; key: string; label: string; reason: string };

export function jobLabel(job: Pick<JobView, "kind" | "targetHeight">): string {
  return job.kind === "probe" ? "Probe" : `Transcode ${job.targetHeight}p`;
}

/**
 * Probe first, then one lane per target height. Heights without a job yet
 * show as placeholders so the layout doesn't jump when the fan-out happens.
 * Once the probe has finished, a missing height was skipped on purpose: the
 * fan-out commits in the same transaction as the probe's completion, so there
 * is no in-between state where it's still coming.
 */
export function buildLanes(jobs: JobView[], source: Pick<SourceInfo, "width" | "height"> | null = null): Lane[] {
  const probe = jobs.find((j) => j.kind === "probe");
  const lanes: Lane[] = [
    probe
      ? { kind: "job", key: probe.jobId, label: jobLabel(probe), job: probe }
      : { kind: "placeholder", key: "probe", label: "Probe" },
  ];
  const heights = new Set<number>([
    ...TARGET_HEIGHTS,
    ...jobs.filter((j) => j.kind === "transcode").map((j) => j.targetHeight),
  ]);
  const skipReason =
    probe?.state === "failed"
      ? "probe failed: nothing to transcode"
      : source
        ? `source is ${Math.min(source.width, source.height)}p: no upscaling`
        : "not needed for this source";
  for (const height of [...heights].sort((a, b) => a - b)) {
    const job = jobs.find((j) => j.kind === "transcode" && j.targetHeight === height);
    const label = `Transcode ${height}p`;
    lanes.push(
      job
        ? { kind: "job", key: job.jobId, label: jobLabel(job), job }
        : probe?.state === "completed" || probe?.state === "failed"
          ? { kind: "skipped", key: `t${height}`, label, reason: skipReason }
          : { kind: "placeholder", key: `t${height}`, label },
    );
  }
  return lanes;
}

// ---------------------------------------------------------------------------
// Stepper: Uploaded → Queued → Probe → Transcode → Ready
// ---------------------------------------------------------------------------

export type StepState = "done" | "active" | "todo" | "failed";
export interface Step {
  label: string;
  state: StepState;
}

export function buildSteps(status: VideoStatus, jobs: JobView[]): Step[] {
  const probe = jobs.find((j) => j.kind === "probe");
  const transcodes = jobs.filter((j) => j.kind === "transcode");
  const terminal = (j: JobView) => j.state === "completed" || j.state === "failed";

  const uploaded: StepState = status === "uploading" ? "active" : "done";
  const queued: StepState = status === "uploading" ? "todo" : probe && probe.state !== "pending" ? "done" : "active";
  const probeStep: StepState = !probe || probe.state === "pending"
    ? "todo"
    : probe.state === "failed" ? "failed" : probe.state === "running" ? "active" : "done";
  const transcode: StepState = transcodes.length === 0
    ? "todo"
    : transcodes.every(terminal)
      ? transcodes.some((j) => j.state === "completed") ? "done" : "failed"
      : "active";
  const ready: StepState = status === "ready" ? "done" : status === "failed" ? "failed" : "todo";

  return [
    { label: "Uploaded", state: uploaded },
    { label: "Queued", state: queued },
    { label: "Probe", state: probeStep },
    { label: "Transcode", state: transcode },
    { label: "Ready", state: ready },
  ];
}

// ---------------------------------------------------------------------------
// Timeline event descriptions
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface EventDescription {
  title: string;
  tone: Tone;
  /** One-line "why this matters", shown under notable events. */
  note?: string;
}

export function describeEvent(e: JobEventView, labelFor: (jobId: string) => string | undefined): EventDescription {
  const job = (e.jobId && labelFor(e.jobId)) || "Job";
  const d = e.detail;
  switch (e.type) {
    case "upload_completed":
      return { title: "Upload verified in storage", tone: "info" };
    case "job_created": {
      const label = d.kind === "probe" ? "Probe" : `Transcode ${String(d.targetHeight)}p`;
      return { title: `${label} job queued via outbox`, tone: "neutral" };
    }
    case "claimed":
      if (d.takeover) {
        return {
          title: `${job} reclaimed (attempt ${e.attempt ?? "?"})`,
          tone: "warning",
          note: "The previous attempt's lease expired, so another worker took over.",
        };
      }
      return e.attempt && e.attempt > 1
        ? { title: `${job} claimed (attempt ${e.attempt})`, tone: "info" }
        : { title: `${job} claimed`, tone: "info" };
    case "completed":
      // Older (pre-M5) events carry no detail; they just say "completed".
      if (typeof d.durationS === "number" && Array.isArray(d.renditions)) {
        const heights = (d.renditions as number[]).map((h) => `${h}p`).join(", ");
        return {
          title: `${job} completed: ${String(d.width)}×${String(d.height)}, ${formatDuration(d.durationS * 1000)}`,
          tone: "success",
          note: `${String(d.videoCodec)} at ${String(d.frameRate)} fps${d.hasAudio ? " with audio" : ", no audio"}. Fanning out: ${heights}.`,
        };
      }
      if (typeof d.bandwidth === "number") {
        return {
          title: `${job} completed and published`,
          tone: "success",
          note: `Verified before publishing: ${String(d.segmentCount)} segments at ${String(d.width)}×${String(d.height)}, peak ${formatBitrate(d.bandwidth)}.`,
        };
      }
      return { title: `${job} completed`, tone: "success" };
    case "retry_scheduled":
      return {
        title: `${job} attempt ${e.attempt ?? "?"} failed; retrying in ${formatDuration(Number(d.delayMs ?? 0))}`,
        tone: "warning",
        note: `${String(d.error ?? "")}. Retry ${String(d.nextAttempt)}/${String(d.maxAttempts)} after an exponential backoff with jitter.`,
      };
    case "failed":
      return d.reason === "permanent"
        ? {
            title: `${job} failed permanently`,
            tone: "danger",
            note: `${String(d.error ?? "")}. Permanent errors aren't retried.`,
          }
        : {
            title: `${job} failed after ${e.attempt ?? "all"} attempts`,
            tone: "danger",
            note: String(d.error ?? ""),
          };
    case "dead_lettered":
      return { title: `${job} sent to the dead-letter queue`, tone: "danger" };
    case "redriven":
      return {
        title: `${job} retried by an operator`,
        tone: "info",
        note: "A fresh attempt budget. The attempt number keeps counting up: it's the fencing token.",
      };
    case "stale_write_rejected":
      return {
        title: `${job}: stale write rejected`,
        tone: "danger",
        note: "Fencing: this worker lost its lease, so its result was discarded.",
      };
    case "released":
      return {
        title: `${job} handed back (worker shutting down)`,
        tone: "warning",
        note: "Graceful shutdown released the lease so another worker could take over immediately.",
      };
    case "lease_expired":
      return {
        title: `${job}: worker stopped responding`,
        tone: "warning",
        note: "Its lease expired without a heartbeat (crash or kill). The reconciler counted the attempt as failed.",
      };
    case "requeued":
      return {
        title: `${job} re-queued by the reconciler`,
        tone: "warning",
        note: "It was overdue with no message in flight, so its queue message was presumed lost.",
      };
    case "manifest_published": {
      const heights = Array.isArray(d.resolutions) ? (d.resolutions as number[]).map((h) => `${h}p`).join(", ") : "";
      return {
        title: `Master manifest v${String(d.version)} published: ${heights}`,
        tone: "success",
        note:
          Number(d.version) > 1
            ? "A new immutable file; the playback URL now points at it, so players and the CDN pick it up with nothing to invalidate."
            : "Playable from here on, even while other renditions are still processing.",
      };
    }
    case "video_status":
      return { title: `Video ${String(d.from)} → ${String(d.to)}`, tone: d.to === "failed" ? "danger" : d.to === "ready" ? "success" : "neutral" };
    default:
      return { title: e.type.replaceAll("_", " "), tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Bits per second, as players and encoders quote it. */
export function formatBitrate(bps: number): string {
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Worker IDs are `<hostname>-<pid>`; hostnames can be long, the pid is what you'd `kill`. */
export function shortWorker(id: string): string {
  const dash = id.lastIndexOf("-");
  if (dash < 0) return id;
  const host = id.slice(0, dash);
  return `${host.length > 12 ? `${host.slice(0, 12)}…` : host}:${id.slice(dash + 1)}`;
}
