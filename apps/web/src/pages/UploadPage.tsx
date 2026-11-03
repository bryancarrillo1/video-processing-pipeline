import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { formatBytes } from "../lib/pipeline.ts";
import { uploadVideo, type UploadState } from "../lib/upload.ts";
import { ProgressBar, cx } from "../components/ui.tsx";
import styles from "./UploadPage.module.css";

const MAX_BYTES = 5 * 1024 ** 3;

interface Selected {
  file: File;
  // Generated per file selection and reused on retry, so retrying after a
  // failure resumes the same video instead of creating a duplicate.
  idempotencyKey: string;
}

export function UploadPage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [title, setTitle] = useState("");
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  const busy = state.phase === "creating" || state.phase === "uploading" || state.phase === "finalizing";
  const tooBig = selected ? selected.file.size > MAX_BYTES : false;
  const empty = selected ? selected.file.size === 0 : false;

  function choose(file: File | undefined) {
    if (!file || busy) return;
    setSelected({ file, idempotencyKey: crypto.randomUUID() });
    setTitle(file.name.replace(/\.[^.]+$/, ""));
    setState({ phase: "idle" });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files[0]);
  }

  async function start() {
    if (!selected) return;
    abortRef.current = new AbortController();
    try {
      const videoId = await uploadVideo({
        file: selected.file,
        title: title.trim() || selected.file.name,
        idempotencyKey: selected.idempotencyKey,
        onState: setState,
        signal: abortRef.current.signal,
      });
      navigate(`/videos/${videoId}`);
    } catch (err) {
      const cancelled = err instanceof DOMException && err.name === "AbortError";
      setState({ phase: "error", message: cancelled ? "Upload cancelled." : (err as Error).message });
    }
  }

  return (
    <section className={styles.wrap}>
      <h1>Upload a video</h1>
      <p className="muted">
        Bytes go <strong>directly from your browser to object storage</strong> through a presigned URL; the API
        only hands out the URL and verifies the result.
      </p>

      <div
        className={cx(styles.drop, dragging && styles.dropActive, selected && styles.dropFilled)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => choose(e.target.files?.[0])}
        />
        {selected ? (
          <div className={styles.file}>
            <div className={styles.fileIcon}>▶</div>
            <div>
              <div className={styles.fileName}>{selected.file.name}</div>
              <div className="muted">
                {formatBytes(selected.file.size)} · {selected.file.type || "unknown type"}
              </div>
            </div>
            {!busy && <span className={styles.change}>Change</span>}
          </div>
        ) : (
          <>
            <div className={styles.dropIcon}>⬆</div>
            <div className={styles.dropTitle}>Drop a video here, or click to choose</div>
            <div className="muted">Up to 5 GB</div>
          </>
        )}
      </div>

      {selected && (
        <div className={`card ${styles.form}`}>
          <label htmlFor="title" className={styles.label}>
            Title
          </label>
          <input
            id="title"
            className="input"
            value={title}
            maxLength={200}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
          {selected.file.type && !selected.file.type.startsWith("video/") && (
            <p className={styles.warn}>
              This doesn't look like a video. It will still upload, but the probe will reject it as a
              permanent failure (a good way to see one).
            </p>
          )}
          {tooBig && <p className={styles.errorText}>Files over 5 GB aren't supported.</p>}
          {empty && <p className={styles.errorText}>This file is empty.</p>}

          <Steps state={state} total={selected.file.size} />

          {state.phase === "error" && <p className={styles.errorText}>{state.message}</p>}

          <div className={styles.actions}>
            {busy ? (
              <button className="btn" onClick={() => abortRef.current?.abort()} disabled={state.phase !== "uploading"}>
                Cancel
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void start()} disabled={tooBig || empty}>
                {state.phase === "error" ? "Retry upload" : "Upload"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

type StepStatus = "todo" | "active" | "done";

function Steps({ state, total }: { state: UploadState; total: number }) {
  // Where each step stands, derived from the single UploadState value.
  const order = ["creating", "uploading", "finalizing", "done"] as const;
  const at = state.phase === "idle" || state.phase === "error" ? -1 : order.indexOf(state.phase);
  const status = (i: number): StepStatus => (at > i ? "done" : at === i ? "active" : "todo");

  const uploading = state.phase === "uploading" ? state : null;
  const pct = uploading && uploading.total > 0 ? uploading.loaded / uploading.total : at > 1 ? 1 : 0;

  return (
    <ol className={styles.steps}>
      <Step status={status(0)} title="Reserve video" detail="POST /videos returns a presigned upload URL" />
      <Step
        status={status(1)}
        title="Upload to storage"
        detail={
          uploading
            ? `${formatBytes(uploading.loaded)} of ${formatBytes(total)} · ${formatBytes(uploading.bytesPerSecond)}/s`
            : `PUT ${formatBytes(total)} straight to S3`
        }
      >
        {status(1) !== "todo" && <ProgressBar value={pct} state={status(1) === "done" ? "completed" : "running"} />}
      </Step>
      <Step status={status(2)} title="Verify & queue" detail="API checks the object, commits a probe job + outbox row" />
    </ol>
  );
}

function Step(props: { status: StepStatus; title: string; detail: string; children?: ReactNode }) {
  return (
    <li className={cx(styles.step, styles[props.status])}>
      <span className={styles.marker}>{props.status === "done" ? "✓" : ""}</span>
      <div className={styles.stepBody}>
        <div className={styles.stepTitle}>{props.title}</div>
        <div className={styles.stepDetail}>{props.detail}</div>
        {props.children}
      </div>
    </li>
  );
}
