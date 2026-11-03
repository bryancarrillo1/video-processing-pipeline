// Local process supervisor: runs the API, web UI, dispatcher and N workers, prefixes
// their logs, and restarts any process that dies, just as Docker's
// `restart: unless-stopped` or Kubernetes would. That restart is what lets you
// `kill -9` a worker mid-job and watch the system recover.
//
//   npm run dev                # 2 workers
//   npm run dev -- --workers 3

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { workers: { type: "string", default: "2" } } });
const workerCount = Number(values.workers);

// Workers exit at once without ffmpeg, and the restart loop below would just
// repeat that every second. Check up front instead.
for (const tool of [process.env.FFMPEG_PATH ?? "ffmpeg", process.env.FFPROBE_PATH ?? "ffprobe"]) {
  if (spawnSync(tool, ["-version"]).status !== 0) {
    console.error(`${tool} not found. Install ffmpeg (macOS: brew install ffmpeg; Debian: apt install ffmpeg).`);
    process.exit(1);
  }
}

interface Service {
  name: string;
  /** Script to run with Node (tsx registered as the TypeScript loader). */
  entry: string;
  args?: string[];
  cwd?: string;
  color: number;
  child?: ChildProcess;
}

const services: Service[] = [
  { name: "api", entry: "apps/api/src/main.ts", color: 36 },
  // Vite dev server for the UI at http://localhost:5173 (proxies /api to :3000).
  { name: "web", entry: "../../node_modules/vite/bin/vite.js", cwd: "apps/web", args: ["--clearScreen", "false"], color: 34 },
  { name: "dispatcher", entry: "apps/dispatcher/src/main.ts", color: 35 },
  ...Array.from({ length: workerCount }, (_, i) => ({
    name: `worker-${i + 1}`,
    entry: "apps/worker/src/main.ts",
    color: 33 - (i % 2),
  })),
];
const width = Math.max(...services.map((s) => s.name.length));
let shuttingDown = false;

function prefixLines(svc: Service, chunk: Buffer): void {
  const tag = `\x1b[${svc.color}m${svc.name.padEnd(width)} |\x1b[0m `;
  for (const line of chunk.toString().split("\n")) if (line.trim()) process.stdout.write(tag + line + "\n");
}

function start(svc: Service): void {
  // One plain Node process per service (tsx registered as a loader), so its
  // PID is the real worker: `kill -9 <pid>` is a genuine crash.
  const child = spawn(process.execPath, ["--import", "tsx", svc.entry, ...(svc.args ?? [])], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    ...(svc.cwd ? { cwd: svc.cwd } : {}),
  });
  svc.child = child;
  child.stdout!.on("data", (c: Buffer) => prefixLines(svc, c));
  child.stderr!.on("data", (c: Buffer) => prefixLines(svc, c));
  prefixLines(svc, Buffer.from(`pid ${child.pid}`));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    prefixLines(svc, Buffer.from(`exited (${signal ?? code}); restarting in 1s`));
    setTimeout(() => start(svc), 1000);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    for (const svc of services) svc.child?.kill("SIGTERM");
  });
}

services.forEach(start);
