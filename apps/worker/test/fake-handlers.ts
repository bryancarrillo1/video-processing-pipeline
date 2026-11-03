import { setTimeout as sleep } from "node:timers/promises";
import {
  TARGET_HEIGHTS,
  enqueueJob,
  markJobCompleted,
  recomputeVideoStatus,
  updateProgress,
  withTransaction,
  type JobKind,
} from "@vpp/core";
import { handlers, type JobHandler } from "../src/handlers.ts";

// Test doubles for the media handlers: the M2 placeholders. They sleep instead
// of running ffmpeg, so tests about claims, leases, retries and crashes stay
// fast and don't need real video files. They call the same fault hooks and do
// the same fenced writes as the real handlers, which is what those tests
// exercise. (Real media is covered in media-pipeline.test.ts.)

export function fakeHandlers(stepMs: number): Record<JobKind, JobHandler> {
  return {
    async probe({ job, workerId, signal, faults }) {
      faults.atStart();
      await sleep(stepMs * faults.slowFactor, undefined, { signal });
      await faults.beforeCommit();
      await withTransaction(async (tx) => {
        await markJobCompleted(tx, job, workerId);
        for (const height of TARGET_HEIGHTS) {
          await enqueueJob(tx, { videoId: job.video_id, kind: "transcode", targetHeight: height });
        }
        await recomputeVideoStatus(tx, job.video_id);
      });
    },
    async transcode({ job, workerId, signal, faults }) {
      faults.atStart();
      for (let step = 1; step <= 10; step++) {
        await sleep(stepMs * faults.slowFactor, undefined, { signal });
        await updateProgress(job, step / 10);
      }
      await faults.beforeCommit();
      await withTransaction(async (tx) => {
        await markJobCompleted(tx, job, workerId);
        await tx.query(
          `INSERT INTO renditions (video_id, height, output_prefix) VALUES ($1, $2, $3)
           ON CONFLICT (video_id, height) DO NOTHING`,
          [job.video_id, job.target_height, `fake/${job.video_id}/${job.target_height}/a${job.attempt}/`],
        );
        await recomputeVideoStatus(tx, job.video_id);
      });
    },
  };
}

/**
 * Swaps the worker's handlers for fakes for the rest of this test file.
 * Vitest gives each test file its own module instances, so this can't leak
 * into other files.
 */
export function useFakeHandlers(stepMs = 10): void {
  Object.assign(handlers, fakeHandlers(stepMs));
}
