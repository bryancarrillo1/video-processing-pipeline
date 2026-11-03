import type { JobState, VideoStatus } from "@vpp/core/domain";
import { TARGET_HEIGHTS } from "@vpp/core/domain";
import type { Tone } from "../lib/pipeline.ts";
import styles from "./ui.module.css";

// Joins class names, skipping falsy ones: cx("a", cond && "b").
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

// `Record<VideoStatus, …>` forces an entry for every status: add one to the
// union in @vpp/core and this file stops compiling until it's handled here.
const VIDEO_TONE: Record<VideoStatus, Tone | "accent"> = {
  uploading: "neutral",
  queued: "info",
  processing: "accent",
  ready: "success",
  failed: "danger",
};

const JOB_TONE: Record<JobState, Tone | "accent"> = {
  pending: "neutral",
  running: "accent",
  completed: "success",
  failed: "danger",
};

export function Badge({ tone, pulse, children }: { tone: Tone | "accent"; pulse?: boolean; children: string }) {
  return <span className={cx(styles.badge, styles[tone], pulse && styles.pulse)}>{children}</span>;
}

export function StatusBadge({ status }: { status: VideoStatus }) {
  return (
    <Badge tone={VIDEO_TONE[status]} pulse={status === "processing" || status === "queued"}>
      {status}
    </Badge>
  );
}

export function JobStateBadge({ state }: { state: JobState }) {
  return (
    <Badge tone={JOB_TONE[state]} pulse={state === "running"}>
      {state}
    </Badge>
  );
}

/** One chip per target resolution; filled when that rendition is playable. */
export function ResolutionChips({ available }: { available: number[] }) {
  return (
    <div className={styles.chips} aria-label={`Playable at: ${available.join(", ") || "none yet"}`}>
      {TARGET_HEIGHTS.map((h) => (
        <span key={h} className={cx(styles.chip, available.includes(h) && styles.chipOn)}>
          {h}p
        </span>
      ))}
    </div>
  );
}

export function ProgressBar({ value, state }: { value: number; state: JobState | "idle" }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={styles.track} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={cx(
          styles.fill,
          state === "completed" && styles.fillDone,
          state === "failed" && styles.fillFailed,
          state === "running" && styles.fillActive,
        )}
        style={{ width: `${state === "completed" ? 100 : pct}%` }}
      />
    </div>
  );
}

/**
 * The frame the probe extracted, served from the public media bucket. Until
 * the probe has run (or if it failed), a deterministic gradient per video.
 */
export function Thumbnail({
  videoId,
  url,
  status,
  progress,
}: {
  videoId: string;
  url: string | null;
  status: VideoStatus;
  progress: number | null;
}) {
  let hash = 0;
  for (const ch of videoId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const background = `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 50) % 360} 65% 40%))`;
  const busy = status === "queued" || status === "processing";
  return (
    <div className={styles.thumb} style={{ background }}>
      {url && <img className={styles.thumbImg} src={url} alt="" loading="lazy" />}
      <div className={styles.thumbIcon}>
        {busy ? (
          <div className={styles.spinner} />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
        )}
      </div>
      {busy && progress !== null && (
        <div className={styles.thumbBar}>
          <div className={styles.thumbBarFill} style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export function Spinner() {
  return <div className={styles.spinner} role="status" aria-label="Loading" />;
}
