import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { JobEventView, JobView, RenditionView, VideoDetail } from "@vpp/core/domain";
import { api, ApiError } from "../lib/api.ts";
import {
  buildLanes,
  buildSteps,
  describeEvent,
  formatBitrate,
  formatDuration,
  formatRelative,
  jobLabel,
  shortWorker,
  type Lane,
  type Step,
} from "../lib/pipeline.ts";
import { useLiveQuery, useNow } from "../hooks/useLiveQuery.ts";
import { JobStateBadge, ProgressBar, ResolutionChips, Spinner, StatusBadge, cx } from "../components/ui.tsx";
import styles from "./VideoPage.module.css";

// Code-split: hls.js is a few hundred KB and only this page needs it.
const Player = lazy(() => import("../components/Player.tsx"));

export function VideoPage() {
  const { videoId = "" } = useParams();
  const { data: video, error, loading } = useLiveQuery(
    videoId,
    () => api.getVideo(videoId),
    (e) => e.videoId === videoId,
  );

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div className={styles.notFound}>
        <h1>{error instanceof ApiError && error.status === 404 ? "Video not found" : "Couldn't load video"}</h1>
        <p className="muted">{error.message}</p>
        <Link to="/" className="btn">
          ← Back to library
        </Link>
      </div>
    );
  }
  if (!video) return null;
  return <VideoView video={video} />;
}

function VideoView({ video }: { video: VideoDetail }) {
  // Tick only while something is moving: a running job's clock or a retry countdown.
  const clockNow = Date.now();
  const ticking = video.jobs.some(
    (j) => j.state === "running" || (j.state === "pending" && new Date(j.nextAttemptAt).getTime() > clockNow),
  );
  const now = useNow(ticking);
  const lanes = useMemo(() => buildLanes(video.jobs, video.source), [video.jobs, video.source]);
  const steps = useMemo(() => buildSteps(video.status, video.jobs), [video.status, video.jobs]);
  const labelFor = useMemo(() => {
    const byId = new Map(video.jobs.map((j) => [j.jobId, jobLabel(j)]));
    return (jobId: string) => byId.get(jobId);
  }, [video.jobs]);

  return (
    <article className={styles.page}>
      <Link to="/" className={styles.back}>
        ← Library
      </Link>

      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1>{video.title}</h1>
          <StatusBadge status={video.status} />
        </div>
        <div className={styles.subRow}>
          <ResolutionChips available={video.availableResolutions} />
          {video.source && (
            <span className="muted" title="What the probe found in the uploaded file">
              Source {video.source.width}×{video.source.height} · {formatDuration(video.source.durationS * 1000)} ·{" "}
              {Math.round(video.source.frameRate * 100) / 100} fps
            </span>
          )}
          <span className="muted">Uploaded {formatRelative(video.createdAt)}</span>
          <code className={styles.id}>{video.videoId}</code>
        </div>
      </header>

      <Stepper steps={steps} />

      <div className={styles.columns}>
        <div className={styles.mainCol}>
          {video.manifestVersion > 0 ? (
            <Suspense fallback={<PlayerPlaceholder video={video} />}>
              <Player videoId={video.videoId} manifestVersion={video.manifestVersion} poster={video.thumbnailUrl} />
            </Suspense>
          ) : (
            <PlayerPlaceholder video={video} />
          )}

          {video.renditions.length > 0 && <Renditions renditions={video.renditions} />}

          <section className={`card ${styles.panel}`}>
            <div className={styles.panelHead}>
              <h2>Pipeline</h2>
              <span className="muted">
                {video.jobs.length} job{video.jobs.length === 1 ? "" : "s"} · updates live
              </span>
            </div>
            <div className={styles.lanes}>
              {lanes.map((lane) => (
                <LaneRow key={lane.key} lane={lane} now={now} />
              ))}
            </div>
          </section>
        </div>

        <aside className={`card ${styles.panel} ${styles.timelinePanel}`}>
          <div className={styles.panelHead}>
            <h2>Event timeline</h2>
            <span className="muted">{video.events.length} events</span>
          </div>
          <Timeline events={video.events} labelFor={labelFor} />
        </aside>
      </div>
    </article>
  );
}

function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className={styles.stepper}>
      {steps.map((s) => (
        <li key={s.label} className={cx(styles.stepItem, styles[`step_${s.state}`])}>
          <span className={styles.stepDot}>{s.state === "done" ? "✓" : s.state === "failed" ? "✕" : ""}</span>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** Shown until a master manifest exists (and while the player chunk loads). */
function PlayerPlaceholder({ video }: { video: VideoDetail }) {
  // The probe's thumbnail doubles as the poster frame, dimmed behind the text.
  const poster = video.thumbnailUrl
    ? { backgroundImage: `linear-gradient(rgb(11 13 18 / 72%), rgb(11 13 18 / 72%)), url(${video.thumbnailUrl})` }
    : undefined;
  return (
    <div className={styles.player} style={poster}>
      {video.manifestVersion > 0 ? (
        <Spinner />
      ) : video.status === "failed" ? (
        <div className={styles.playerTitle}>Processing failed: nothing playable</div>
      ) : (
        <>
          <Spinner />
          <div className={styles.playerTitle}>Waiting for the first rendition</div>
          <div className={styles.playerNote}>Playback starts as soon as any resolution is verified.</div>
        </>
      )}
    </div>
  );
}

/** Outputs that passed verification and are published. Only these are ever advertised. */
function Renditions({ renditions }: { renditions: RenditionView[] }) {
  return (
    <section className={`card ${styles.panel}`}>
      <div className={styles.panelHead}>
        <h2>Verified renditions</h2>
        <span className="muted">HLS · 4 s segments, aligned across renditions</span>
      </div>
      <ul className={styles.renditions}>
        {renditions.map((r) => (
          <li key={r.height}>
            <strong>{r.height}p</strong>
            <span>{r.outputWidth && r.outputHeight ? `${r.outputWidth}×${r.outputHeight}` : "—"}</span>
            <span>{r.bandwidth ? `peak ${formatBitrate(r.bandwidth)}` : "—"}</span>
            <span>{r.segmentCount ?? "—"} segments</span>
            <a href={r.playlistUrl} target="_blank" rel="noreferrer">
              index.m3u8 ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RetryButton({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className={styles.retry}>
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          // No refetch needed: the "redriven" event arrives over SSE.
          api.retryJob(jobId).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
        }}
      >
        {busy ? "Retrying…" : "Retry job"}
      </button>
      {error && <span className={styles.laneErrorInline}>{error}</span>}
    </span>
  );
}

function LaneRow({ lane, now }: { lane: Lane; now: number }) {
  if (lane.kind === "placeholder" || lane.kind === "skipped") {
    return (
      <div className={cx(styles.lane, styles.lanePlaceholder, lane.kind === "skipped" && styles.laneSkipped)}>
        <div className={styles.laneLabel}>{lane.label}</div>
        <div className={styles.laneWaiting}>
          {lane.kind === "skipped" ? `skipped: ${lane.reason}` : "waiting for probe to fan out"}
        </div>
      </div>
    );
  }
  const job: JobView = lane.job;
  const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
  const ended = job.finishedAt ? new Date(job.finishedAt).getTime() : job.state === "running" ? now : null;
  const elapsed = started && ended ? ended - started : null;
  const retryIn = job.state === "pending" && job.attempt > 0 ? new Date(job.nextAttemptAt).getTime() - now : null;

  return (
    <div
      className={cx(
        styles.lane,
        job.state === "running" && styles.laneRunning,
        retryIn !== null && styles.laneRetrying,
        job.state === "failed" && styles.laneFailed,
      )}
    >
      <div className={styles.laneLabel}>{lane.label}</div>
      <div className={styles.laneState}>
        <JobStateBadge state={job.state} />
      </div>
      <div className={styles.laneProgress}>
        <ProgressBar value={job.progress} state={job.state} />
        <span className={styles.pct}>{Math.round((job.state === "completed" ? 1 : job.progress) * 100)}%</span>
      </div>
      <div className={styles.laneMeta}>
        <span className={cx(job.attempt > 1 && styles.retried)} title="Attempt number (also the fencing token)">
          attempt {job.attempt}/{job.maxAttempts}
        </span>
        {job.leaseOwner && (
          <span className={styles.worker} title={`Lease held by ${job.leaseOwner}`}>
            {shortWorker(job.leaseOwner)}
          </span>
        )}
        {elapsed !== null && job.state !== "pending" && <span>{formatDuration(elapsed)}</span>}
        {retryIn !== null && (
          <span className={styles.retried}>
            {retryIn > 0 ? `retrying in ${formatDuration(retryIn)}` : "retry due, waiting for a worker"}
          </span>
        )}
        {job.errorKind === "permanent" && <span className={styles.permanent}>permanent error</span>}
      </div>
      {job.lastError && job.state !== "completed" && (
        <div className={styles.laneError}>
          <span>{job.lastError}</span>
          {job.state === "failed" && <RetryButton jobId={job.jobId} />}
        </div>
      )}
    </div>
  );
}

function Timeline({
  events,
  labelFor,
}: {
  events: JobEventView[];
  labelFor: (jobId: string) => string | undefined;
}) {
  if (events.length === 0) return <p className="muted">No events yet.</p>;
  return (
    <ol className={styles.timeline}>
      {events.map((e) => {
        const d = describeEvent(e, labelFor);
        return (
          <li key={e.id} className={cx(styles.event, styles[`tone_${d.tone}`])}>
            <span className={styles.eventDot} />
            <div className={styles.eventBody}>
              <div className={styles.eventTitle}>{d.title}</div>
              {d.note && <div className={styles.eventNote}>{d.note}</div>}
              <div className={styles.eventMeta}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], { hour12: false })}</time>
                {e.workerId && <span>{shortWorker(e.workerId)}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
