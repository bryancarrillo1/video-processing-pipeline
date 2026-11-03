import { afterAll, expect, it } from "vitest";

// Regression test: a job that runs longer than one lease must still finish on
// its first attempt, because the heartbeat keeps renewing the lease. Without
// it, the lease expires mid-job, another worker reclaims the job, and fencing
// rejects every attempt forever (a livelock the M2 chaos run actually hit).
//
// Config is read at import time and Vitest isolates modules per test file, so
// we set a 1s lease here and import everything afterwards. Fake handlers with
// 300 ms steps make each job take ~3 s.
process.env.JOB_LEASE_SECONDS = "1";

const { pool, withTransaction, enqueueJob } = await import("@vpp/core");
const { dispatchOnce } = await import("../../dispatcher/src/dispatcher.ts");
const { pollOnce } = await import("../src/worker.ts");
const { useFakeHandlers } = await import("./fake-handlers.ts");
useFakeHandlers(300);

afterAll(() => pool.end());

it("keeps a long-running job's lease alive until it completes", async () => {
  // Arrange a transcode job directly (no upload needed for the fake handler).
  const videoId = crypto.randomUUID();
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO videos (id, owner_id, title, source_key, status) VALUES ($1, 'hb', 'hb', 'x', 'processing')`,
      [videoId],
    );
    await enqueueJob(tx, { videoId, kind: "transcode", targetHeight: 360 });
  });

  const quiet = { info() {}, warn() {}, error() {} };
  const signal = new AbortController().signal;
  const started = Date.now();
  await dispatchOnce();

  // Two competing workers. If worker A's lease lapses mid-job, the message
  // becomes visible again and worker B will reclaim the job as attempt 2.
  const isDone = async () => {
    const { rows } = await pool.query(`SELECT state FROM processing_jobs WHERE video_id = $1`, [videoId]);
    return rows[0].state === "completed";
  };
  const workerLoop = async (id: string) => {
    while (Date.now() - started < 8_000 && !(await isDone())) {
      await pollOnce(id, signal, { waitSeconds: 1, log: quiet });
    }
  };
  await Promise.all([workerLoop("hb-worker-a"), workerLoop("hb-worker-b")]);

  const { rows: [job] } = await pool.query(
    `SELECT state, attempt FROM processing_jobs WHERE video_id = $1`,
    [videoId],
  );
  expect(Date.now() - started).toBeGreaterThan(2500); // really outlived the 1s lease
  expect(job).toEqual({ state: "completed", attempt: 1 });
  const { rows: stale } = await pool.query(
    `SELECT 1 FROM job_events WHERE video_id = $1 AND type = 'stale_write_rejected'`,
    [videoId],
  );
  expect(stale).toHaveLength(0);
}, 20_000);
