import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  StaleLeaseError,
  claimJob,
  enqueueJob,
  markJobCompleted,
  recomputeVideoStatus,
  pool,
  receiveJobMessages,
  deleteJobMessage,
  sendJobMessage,
  withTransaction,
} from "@vpp/core";
import { buildApp } from "../../api/src/server.ts";
import { dispatchOnce } from "../../dispatcher/src/dispatcher.ts";
import { pollOnce, runWorker } from "../src/worker.ts";
import { useFakeHandlers } from "./fake-handlers.ts";

// The job machinery, with fake handlers; real ffmpeg is in media-pipeline.test.ts.
useFakeHandlers();

let app: FastifyInstance;
const user = `pipeline-${crypto.randomUUID()}`;
const headers = { "x-user-id": user };
const quiet = { info() {}, warn() {}, error() {} };
const never = new AbortController().signal;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Creates a video, uploads bytes to storage, and completes the upload. */
async function uploadVideo(): Promise<string> {
  const bytes = new TextEncoder().encode("placeholder bytes");
  const created = await app.inject({
    method: "POST",
    url: "/videos",
    headers,
    payload: { title: "Pipeline test", fileName: "a.mp4", fileSizeBytes: bytes.length },
  });
  const { videoId, uploadId, uploadUrl } = created.json();
  await fetch(uploadUrl, { method: "PUT", body: bytes });
  const done = await app.inject({ method: "POST", url: `/videos/${videoId}/uploads/${uploadId}/complete`, headers });
  expect(done.statusCode).toBe(202);
  return videoId;
}

/** Drives dispatcher + one worker in-process until the predicate holds. */
async function pumpUntil(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("pipeline did not settle in time");
    await dispatchOnce();
    await pollOnce("test-worker", never, { waitSeconds: 1, log: quiet });
  }
}

async function videoDetail(videoId: string) {
  return (await app.inject({ url: `/videos/${videoId}`, headers })).json();
}

describe("processing pipeline (fake handlers)", () => {
  it("completing an upload creates exactly one probe job and outbox row, even when repeated", async () => {
    const videoId = await uploadVideo();
    const { rows: [upload] } = await pool.query(`SELECT id FROM upload_sessions WHERE video_id = $1`, [videoId]);
    await app.inject({ method: "POST", url: `/videos/${videoId}/uploads/${upload.id}/complete`, headers });

    const { rows } = await pool.query(
      `SELECT j.kind, count(o.id)::int AS outbox
         FROM processing_jobs j JOIN outbox o ON o.job_id = j.id
        WHERE j.video_id = $1 GROUP BY j.kind`,
      [videoId],
    );
    expect(rows).toEqual([{ kind: "probe", outbox: 1 }]);
  });

  it("runs probe → fan-out → transcodes until the video is ready", async () => {
    const videoId = await uploadVideo();
    await pumpUntil(async () => (await videoDetail(videoId)).status === "ready");

    const detail = await videoDetail(videoId);
    expect(detail).toMatchObject({ status: "ready", playbackReady: true, availableResolutions: [360, 720, 1080] });
    expect(detail.jobs).toHaveLength(4);
    for (const job of detail.jobs) expect(job).toMatchObject({ state: "completed", attempt: 1, progress: 1 });

    // The library summary reports aggregate transcode progress for the card's bar.
    const list = (await app.inject({ url: "/videos", headers })).json();
    expect(list.videos.find((v: { videoId: string }) => v.videoId === videoId)).toMatchObject({ progress: 1 });

    const types = detail.events.map((e: { type: string }) => e.type);
    expect(types).toContain("upload_completed");
    expect(types.filter((t: string) => t === "claimed")).toHaveLength(4);
    expect(types).toContainEqual("video_status");
  });

  it("treats a duplicate delivery of a finished job as a no-op", async () => {
    const videoId = await uploadVideo();
    await pumpUntil(async () => (await videoDetail(videoId)).status === "ready");
    const { rows: [probe] } = await pool.query(
      `SELECT id FROM processing_jobs WHERE video_id = $1 AND kind = 'probe'`,
      [videoId],
    );

    // Simulate the at-least-once queue delivering the probe message again.
    await sendJobMessage({ jobId: probe.id });
    await pollOnce("test-worker", never, { waitSeconds: 1, log: quiet });

    const detail = await videoDetail(videoId);
    expect(detail.jobs).toHaveLength(4); // no second fan-out
    expect(detail.jobs[0]).toMatchObject({ kind: "probe", attempt: 1 });
  });
});

describe("fencing", () => {
  it("rejects a completion from a worker whose lease expired and was taken over", async () => {
    const videoId = await uploadVideo();
    const { rows: [{ id: jobId }] } = await pool.query(
      `SELECT id FROM processing_jobs WHERE video_id = $1 AND kind = 'probe'`,
      [videoId],
    );

    const first = await claimJob(jobId, "worker-a");
    expect(first?.attempt).toBe(1);
    expect(await claimJob(jobId, "worker-b")).toBeNull(); // lease still live

    // Worker A stalls (GC pause, network partition…) and its lease runs out.
    await pool.query(`UPDATE processing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const second = await claimJob(jobId, "worker-b");
    expect(second?.attempt).toBe(2);

    // A wakes up and tries to commit its result with its stale token.
    await expect(withTransaction((tx) => markJobCompleted(tx, first!, "worker-a"))).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
    // B, the current owner, succeeds.
    await withTransaction((tx) => markJobCompleted(tx, second!, "worker-b"));

    // The second claim is recorded as a takeover of A's dead lease (the UI flags it).
    const { rows: claims } = await pool.query(
      `SELECT attempt, detail FROM job_events WHERE job_id = $1 AND type = 'claimed' ORDER BY id`,
      [jobId],
    );
    expect(claims).toEqual([
      { attempt: 1, detail: {} },
      { attempt: 2, detail: { takeover: true, previousOwner: "worker-a" } },
    ]);
  });
});

describe("dispatcher", () => {
  it("sends each outbox row once even with concurrent dispatchers (SKIP LOCKED)", async () => {
    // Drain anything already queued so we count only our messages.
    while ((await receiveJobMessages({ max: 10, waitSeconds: 0, visibilityTimeoutSeconds: 30 })).length) {
      /* received messages stay invisible for 30s, which is all we need here */
    }
    const ids = await Promise.all([uploadVideo(), uploadVideo(), uploadVideo()]);
    const [a, b] = await Promise.all([dispatchOnce(), dispatchOnce()]);
    expect(a + b).toBeGreaterThanOrEqual(3);

    const received: string[] = [];
    for (let i = 0; i < 5; i++) {
      const msgs = await receiveJobMessages({ max: 10, waitSeconds: 1, visibilityTimeoutSeconds: 30 });
      for (const m of msgs) {
        received.push(JSON.parse(m.Body!).jobId);
        await deleteJobMessage(m.ReceiptHandle!);
      }
    }
    const { rows } = await pool.query(
      `SELECT id FROM processing_jobs WHERE video_id = ANY($1) AND kind = 'probe'`,
      [ids],
    );
    for (const { id } of rows) expect(received.filter((r) => r === id)).toHaveLength(1);
  });
});

describe("aggregate status locking", () => {
  it("doesn't deadlock when two jobs of the same video finish at the same time", async () => {
    // Regression: inserting a job_events row takes FOR KEY SHARE on the parent
    // video (foreign key). recomputeVideoStatus used SELECT … FOR UPDATE, which
    // conflicts with KEY SHARE, so two finishing transactions deadlocked. Seen
    // in the M3 browser smoke test. The fix is FOR NO KEY UPDATE.
    const videoId = await uploadVideo();
    await pumpUntil(async () => (await videoDetail(videoId)).jobs.length === 4);
    // Make two transcode jobs claimable right now (they may already be done).
    const { rows } = await pool.query(
      `UPDATE processing_jobs SET state = 'pending', lease_expires_at = NULL
        WHERE video_id = $1 AND kind = 'transcode' AND target_height IN (360, 720) RETURNING id`,
      [videoId],
    );
    const [j1, j2] = await Promise.all(rows.map((r: { id: string }, i: number) => claimJob(r.id, `w${i}`)));

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      // Both transactions now hold KEY SHARE on the video via their event inserts.
      await markJobCompleted(c1, j1!, "w0");
      await markJobCompleted(c2, j2!, "w1");

      // With FOR UPDATE this blocks on c2's KEY SHARE (and deadlocks once c2 asks too).
      const first = await Promise.race([
        recomputeVideoStatus(c1, videoId).then(() => "locked"),
        new Promise((r) => setTimeout(() => r("blocked"), 2000)),
      ]);
      expect(first).toBe("locked");

      // c2 must still wait for c1: recomputes for one video stay serialized.
      const second = recomputeVideoStatus(c2, videoId);
      await c1.query("COMMIT");
      await second;
      await c2.query("COMMIT");
    } finally {
      // c2 first: if c1 is stuck waiting on c2's lock, this releases it.
      await c2.query("ROLLBACK").catch(() => {});
      await c1.query("ROLLBACK").catch(() => {});
      c1.release();
      c2.release();
    }
  }, 20_000);
});

describe("graceful shutdown", () => {
  it("hands a running job to another worker immediately instead of after the lease", async () => {
    const videoId = crypto.randomUUID();
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO videos (id, owner_id, title, source_key, status) VALUES ($1, $2, 'handoff', 'x', 'processing')`,
        [videoId, user],
      );
      await enqueueJob(tx, { videoId, kind: "transcode", targetHeight: 720 });
    });
    await dispatchOnce();

    // Worker A runs until it holds our job, then is told to shut down mid-way.
    const shutdownA = new AbortController();
    const runA = runWorker("worker-a", shutdownA.signal, quiet);
    for (let i = 0; i < 400; i++) {
      const { rows } = await pool.query(`SELECT lease_owner FROM processing_jobs WHERE video_id = $1`, [videoId]);
      if (rows[0].lease_owner === "worker-a") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    shutdownA.abort();
    await runA;

    // Worker B picks it up right away: lease is 5 s in tests, we allow 2 s.
    const started = Date.now();
    while (Date.now() - started < 2000) {
      await pollOnce("worker-b", never, { waitSeconds: 1, log: quiet });
      const { rows } = await pool.query(`SELECT state FROM processing_jobs WHERE video_id = $1`, [videoId]);
      if (rows[0].state === "completed") break;
    }
    const { rows: [job] } = await pool.query(
      `SELECT state, attempt FROM processing_jobs WHERE video_id = $1`,
      [videoId],
    );
    expect(job).toEqual({ state: "completed", attempt: 2 });
    const { rows: events } = await pool.query(
      `SELECT type, worker_id FROM job_events WHERE video_id = $1 AND type IN ('released', 'claimed') ORDER BY id`,
      [videoId],
    );
    expect(events).toEqual([
      { type: "claimed", worker_id: "worker-a" },
      { type: "released", worker_id: "worker-a" },
      { type: "claimed", worker_id: "worker-b" },
    ]);
  });
});
