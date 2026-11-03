import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  NO_CHAOS,
  enqueueJob,
  pool,
  receiveJobMessages,
  deleteJobMessage,
  redriveJob,
  requestWorkerKill,
  updateChaos,
  withTransaction,
  type ChaosSettings,
} from "@vpp/core";
import { buildApp } from "../../api/src/server.ts";
import { dispatchOnce, runDispatcher } from "../../dispatcher/src/dispatcher.ts";
import { reconcileOnce } from "../../dispatcher/src/reconciler.ts";
import { SimulatedCrash, runtime } from "../src/faults.ts";
import { pollOnce, runWorker } from "../src/worker.ts";
import { useFakeHandlers } from "./fake-handlers.ts";

useFakeHandlers();

const user = `reliability-${crypto.randomUUID()}`;
const headers = { "x-user-id": user };
const quiet = { info() {}, warn() {}, error() {} };
const never = new AbortController().signal;
const realCrash = runtime.crash;
let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterEach(async () => {
  await updateChaos(NO_CHAOS);
  runtime.crash = realCrash;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** A video with a single transcode job (no upload needed: the fake handlers don't read it). */
async function videoWithJob(): Promise<{ videoId: string; jobId: string }> {
  const videoId = crypto.randomUUID();
  const jobId = await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO videos (id, owner_id, title, source_key, status) VALUES ($1, $2, 'reliability', 'x', 'queued')`,
      [videoId, user],
    );
    return enqueueJob(tx, { videoId, kind: "transcode", targetHeight: 360 });
  });
  return { videoId, jobId: jobId! };
}

async function job(jobId: string) {
  const { rows } = await pool.query(
    `SELECT state, attempt, max_attempts, error_kind, last_error, next_attempt_at FROM processing_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0];
}

async function eventTypes(jobId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT type FROM job_events WHERE job_id = $1 ORDER BY id`, [jobId]);
  return rows.map((r) => r.type);
}

type JobSnapshot = Awaited<ReturnType<typeof job>>;

/** Runs dispatcher + worker until the job reaches one of `states` (or satisfies a predicate). */
async function pumpUntil(jobId: string, until: string[] | ((j: JobSnapshot) => boolean), timeoutMs = 15_000) {
  const done = typeof until === "function" ? until : (j: JobSnapshot) => until.includes(j.state);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await job(jobId);
    if (done(j)) return j;
    if (Date.now() > deadline) throw new Error(`job stuck in ${j.state}`);
    await dispatchOnce();
    await pollOnce("test-worker", never, { waitSeconds: 1, log: quiet });
  }
}

async function chaos(patch: Partial<ChaosSettings>) {
  await updateChaos({ ...NO_CHAOS, ...patch });
}

/** Reads the dead-letter queue and returns the job ids found (deleting the messages). */
async function drainDeadLetters(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const msgs = await receiveJobMessages({ queue: "dead-letter", max: 10, waitSeconds: 0, visibilityTimeoutSeconds: 30 });
    if (!msgs.length) break;
    for (const m of msgs) {
      ids.push(JSON.parse(m.Body!).jobId);
      await deleteJobMessage(m.ReceiptHandle!, "dead-letter");
    }
  }
  return ids;
}

/** Deletes every visible message in the jobs queue without processing it. */
async function drainJobsQueue(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const msgs = await receiveJobMessages({ max: 10, waitSeconds: 0, visibilityTimeoutSeconds: 30 });
    if (!msgs.length) return;
    for (const m of msgs) await deleteJobMessage(m.ReceiptHandle!);
  }
}

describe("retries", () => {
  it("retries a transient failure with backoff and then succeeds", async () => {
    const { jobId } = await videoWithJob();
    await chaos({ failureRate: 1 });
    // First attempt failed and a retry is scheduled.
    await pumpUntil(jobId, (j) => j.state === "pending" && j.attempt === 1);
    const afterFailure = await job(jobId);
    expect(afterFailure).toMatchObject({ attempt: 1, error_kind: "retryable" });
    expect(afterFailure.last_error).toMatch(/injected transient failure/);
    expect(new Date(afterFailure.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 50);

    await chaos({ failureRate: 0 });
    const done = await pumpUntil(jobId, ["completed"]);
    expect(done.attempt).toBe(2);
    expect(await eventTypes(jobId)).toEqual(["job_created", "claimed", "retry_scheduled", "claimed", "completed"]);
  });

  it("holds a retry back until its backoff delay has passed", async () => {
    const { jobId } = await videoWithJob();
    await chaos({ failureRate: 1 });
    await pumpUntil(jobId, (j) => j.state === "pending" && j.attempt === 1);
    // Push the retry far into the future, as a long backoff would.
    await pool.query(`UPDATE processing_jobs SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [jobId]);
    await pool.query(`UPDATE outbox SET available_at = now() + interval '1 hour' WHERE job_id = $1 AND sent_at IS NULL`, [jobId]);

    await dispatchOnce();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM outbox WHERE job_id = $1 AND sent_at IS NULL`, [jobId]);
    expect(rows[0].n).toBe(1); // not sent yet
  });

  it("dead-letters a job after four failed attempts (three retries)", async () => {
    const { jobId, videoId } = await videoWithJob();
    await chaos({ failureRate: 1 });
    const failed = await pumpUntil(jobId, ["failed"]);
    expect(failed).toMatchObject({ attempt: 4, max_attempts: 4, error_kind: "retryable" });

    const types = await eventTypes(jobId);
    expect(types.filter((t) => t === "retry_scheduled")).toHaveLength(3);
    expect(types.slice(-2)).toEqual(["failed", "dead_lettered"]);

    await dispatchOnce(); // relays the dead-letter outbox row
    expect(await drainDeadLetters()).toContain(jobId);
    const { rows } = await pool.query(`SELECT status FROM videos WHERE id = $1`, [videoId]);
    expect(rows[0].status).toBe("failed");
  });

  it("fails a permanent error immediately, without retries", async () => {
    const { jobId } = await videoWithJob();
    await chaos({ permanentFailures: true });
    const failed = await pumpUntil(jobId, ["failed"]);
    expect(failed).toMatchObject({ attempt: 1, error_kind: "permanent" });
    expect(await eventTypes(jobId)).toEqual(["job_created", "claimed", "failed", "dead_lettered"]);
  });
});

describe("redrive", () => {
  it("gives a failed job a fresh budget without ever resetting its fencing token", async () => {
    const { jobId } = await videoWithJob();
    await chaos({ permanentFailures: true });
    await pumpUntil(jobId, ["failed"]);
    await chaos({});

    expect(await redriveJob(jobId, "test")).toBe(true);
    expect(await job(jobId)).toMatchObject({ state: "pending", attempt: 1, max_attempts: 5 });
    expect(await redriveJob(jobId, "test")).toBe(false); // idempotent

    const done = await pumpUntil(jobId, ["completed"]);
    expect(done.attempt).toBe(2); // the token kept increasing
  });

  it("redrives everything in the dead-letter queue via the admin API", async () => {
    await drainDeadLetters();
    const { jobId } = await videoWithJob();
    await chaos({ permanentFailures: true });
    await pumpUntil(jobId, ["failed"]);
    await dispatchOnce(); // job lands in the DLQ
    await chaos({});

    const res = await app.inject({ method: "POST", url: "/admin/dlq/redrive", headers });
    expect(res.json()).toMatchObject({ messages: 1, redriven: 1 });
    expect((await job(jobId)).state).toBe("pending");
  });

  it("refuses to retry a job that isn't failed", async () => {
    const { jobId } = await videoWithJob();
    const res = await app.inject({ method: "POST", url: `/admin/jobs/${jobId}/retry`, headers });
    expect(res.statusCode).toBe(409);
  });
});

describe("reconciler", () => {
  it("turns a crashed worker's expired lease into a scheduled retry", async () => {
    // Flush leftovers from earlier tests first, so the crash token can only
    // be spent on our job.
    await dispatchOnce();
    await drainJobsQueue();
    const { jobId } = await videoWithJob();
    await chaos({ crashNext: 1 });
    runtime.crash = () => {
      throw new SimulatedCrash("test crash");
    };
    await dispatchOnce();
    // The worker "dies" after doing the work but before committing it.
    for (let i = 0; i < 10 && (await job(jobId)).state === "pending"; i++) {
      await pollOnce("doomed-worker", never, { waitSeconds: 1, log: quiet }).catch((e) => {
        if (!(e instanceof SimulatedCrash)) throw e;
      });
    }
    expect(await job(jobId)).toMatchObject({ state: "running", attempt: 1 });

    await pool.query(`UPDATE processing_jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`, [jobId]);
    const result = await reconcileOnce();
    expect(result.leasesExpired).toBeGreaterThanOrEqual(1);
    expect(await job(jobId)).toMatchObject({ state: "pending", attempt: 1, error_kind: "retryable" });
    expect((await eventTypes(jobId)).slice(-2)).toEqual(["lease_expired", "retry_scheduled"]);

    runtime.crash = realCrash;
    const done = await pumpUntil(jobId, ["completed"]);
    expect(done.attempt).toBe(2);
  });

  it("dead-letters a job whose last attempt's worker died", async () => {
    const { jobId } = await videoWithJob();
    await pool.query(
      `UPDATE processing_jobs SET state = 'running', attempt = 4, lease_owner = 'ghost',
              lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [jobId],
    );
    await reconcileOnce();
    expect(await job(jobId)).toMatchObject({ state: "failed", attempt: 4 });
    expect((await eventTypes(jobId)).slice(-3)).toEqual(["lease_expired", "failed", "dead_lettered"]);
  });

  it("requeues a pending job whose queue message was lost", async () => {
    const { jobId } = await videoWithJob();
    await dispatchOnce();
    // The message vanishes (e.g. someone purged the queue): drain it unprocessed.
    await drainJobsQueue();
    await pool.query(`UPDATE processing_jobs SET next_attempt_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);

    const result = await reconcileOnce();
    expect(result.lostJobsRequeued).toBeGreaterThanOrEqual(1);
    expect((await eventTypes(jobId)).at(-1)).toBe("requeued");
    expect((await pumpUntil(jobId, ["completed"])).attempt).toBe(1);
  });
});

describe("chaos controls", () => {
  it("pausing the dispatcher lets work pile up safely in the outbox", async () => {
    const { jobId } = await videoWithJob();
    await chaos({ dispatcherPaused: true });
    const stop = new AbortController();
    const running = runDispatcher(stop.signal, quiet);
    await new Promise((r) => setTimeout(r, 600));
    const unsent = async () =>
      (await pool.query(`SELECT count(*)::int AS n FROM outbox WHERE job_id = $1 AND sent_at IS NULL`, [jobId])).rows[0].n;
    expect(await unsent()).toBe(1);

    await chaos({ dispatcherPaused: false });
    await new Promise((r) => setTimeout(r, 600));
    stop.abort();
    await running;
    expect(await unsent()).toBe(0);
  });

  it("kills a worker from the registry, mid-job", async () => {
    const crashes: string[] = [];
    runtime.crash = ((reason: string) => {
      crashes.push(reason);
    }) as typeof runtime.crash;

    const stop = new AbortController();
    const workerId = `kill-target-${Date.now()}`;
    const running = runWorker(workerId, stop.signal, quiet);
    await new Promise((r) => setTimeout(r, 200)); // registered + first heartbeat
    const system = (await app.inject({ url: "/admin/system", headers })).json();
    expect(system.workers.map((w: { workerId: string }) => w.workerId)).toContain(workerId);

    const res = await app.inject({ method: "POST", url: `/admin/workers/${workerId}/kill`, headers });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(crashes[0]).toMatch(/killed from the System page/);
    stop.abort();
    await running;
  });

  it("validates chaos updates and reports system state", async () => {
    const bad = await app.inject({ method: "PATCH", url: "/admin/chaos", headers, payload: { failureRate: 2 } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PATCH", url: "/admin/chaos", headers, payload: { slowFactor: 3 } });
    expect(ok.json()).toMatchObject({ slowFactor: 3, failureRate: 0 });

    const system = (await app.inject({ url: "/admin/system", headers })).json();
    expect(system).toMatchObject({ chaos: { slowFactor: 3 }, queues: { jobs: {}, deadLetter: {} } });
    expect(typeof system.outboxBacklog).toBe("number");
    expect(Object.keys(system.jobsByState).sort()).toEqual(["completed", "failed", "pending", "running"]);
  });

  it("requires a known worker to kill", async () => {
    expect(await requestWorkerKill(pool, "nobody")).toBe(false);
    const res = await app.inject({ method: "POST", url: "/admin/workers/nobody/kill", headers });
    expect(res.statusCode).toBe(404);
  });
});
