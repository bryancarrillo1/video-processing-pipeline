import { pool } from "@vpp/core";
import { checkTools } from "./media.ts";
import { makeWorkerId, runWorker } from "./worker.ts";

// No ffmpeg, no work: say so once, clearly, instead of failing every job.
await checkTools().catch((err: Error) => {
  console.error(`[worker] ${err.message}`);
  process.exit(1);
});

const workerId = makeWorkerId();
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}

console.info(`[${workerId}] started`);
await runWorker(workerId, shutdown.signal);
await pool.end();
console.info(`[${workerId}] stopped`);
