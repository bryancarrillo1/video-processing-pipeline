// Chaos walkthrough: drives the real UI in headless Chromium through every
// M4 failure scenario and saves a screenshot of each, against a running stack.
//
//   JOB_LEASE_SECONDS=10 npm run dev                # in one terminal
//   npm run demo:chaos -- --out screenshots/chaos   # in another
//
// Scenarios: transient failures with backoff, a permanent failure fixed by an
// operator retry, killing a busy worker, a dispatcher outage, and a crash
// between doing the work and committing it. Exits non-zero if any scenario
// doesn't recover or the page logs an error.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright";
import { makeClip } from "./clip.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "screenshots/chaos" },
    url: { type: "string", default: "http://localhost:5173" },
  },
});
const out = path.resolve(values.out);
const base = values.url;
await mkdir(out, { recursive: true });
// Real video, so every scenario runs real ffprobe/ffmpeg work. 8 s is long
// enough to kill a worker mid-encode once slow mode makes it real time.
const clip = await readFile(await makeClip({ width: 1920, height: 1080, seconds: 8 }));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const shot = (name: string) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
const api = (method: string, url: string, data?: unknown) =>
  page.request
    .fetch(`${base}/api${url}`, { method, ...(data === undefined ? {} : { data }) })
    .then((r) => r.json().catch(() => null));

async function upload(title: string): Promise<string> {
  const created = await api("POST", "/videos", { title, fileName: "clip.mp4", fileSizeBytes: clip.length });
  await page.request.put(created.uploadUrl, { data: clip });
  await api("POST", `/videos/${created.videoId}/uploads/${created.uploadId}/complete`);
  return created.videoId;
}
const status = async (videoId: string): Promise<string> => (await api("GET", `/videos/${videoId}`)).status;
const pageHas = (p: Page, text: string) =>
  p.evaluate((t) => document.body.innerText.toLowerCase().includes(t), text.toLowerCase());

async function waitFor(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await page.waitForTimeout(300);
  }
}
function step(name: string) {
  console.log(`▸ ${name}`);
}

try {
  await page.goto(base);
  await page.fill("#username", "chaos-demo");
  await page.click("button:has-text('Continue')");
  await page.waitForSelector("text=Your videos");
  await api("POST", "/admin/chaos/reset");

  step("System page at rest");
  await page.click("nav >> text=System");
  await page.waitForSelector("text=Fault injection");
  await waitFor(
    async () => (await api("GET", "/admin/system")).workers.filter((w: { alive: boolean }) => w.alive).length >= 2,
    15_000,
    "two live workers",
  );
  await page.waitForTimeout(1200);
  await shot("1-system-normal");

  step("Transient failures → retries with backoff");
  await api("PATCH", "/admin/chaos", { failureRate: 0.6 });
  const flaky = await upload("Flaky storage (60% transient failures)");
  await page.goto(`${base}/videos/${flaky}`);
  await waitFor(() => pageHas(page, "retrying in"), 30_000, "a retry countdown");
  await shot("2-retry-backoff");
  await waitFor(async () => ["ready", "failed"].includes(await status(flaky)), 90_000, "flaky video to settle");
  await page.waitForTimeout(800);
  await shot("3-retries-settled");
  console.log(`  final status: ${await status(flaky)}`);

  step("Permanent failure → dead-letter → operator retry");
  await api("PATCH", "/admin/chaos", { failureRate: 0, permanentFailures: true });
  const corrupt = await upload("Unsupported codec (permanent failure)");
  await page.goto(`${base}/videos/${corrupt}`);
  await waitFor(async () => (await status(corrupt)) === "failed", 30_000, "permanent failure");
  await page.waitForSelector("text=Retry job");
  await page.waitForTimeout(500);
  await shot("4-permanent-failed");
  await api("POST", "/admin/chaos/reset");
  await page.click("text=Retry job");
  await waitFor(async () => (await status(corrupt)) === "ready", 60_000, "ready after operator retry");
  await page.waitForTimeout(800);
  await shot("5-after-operator-retry");

  step("Kill a busy worker from the System page");
  await api("PATCH", "/admin/chaos", { slowFactor: 5 });
  const killed = await upload("Kill a worker mid-transcode");
  await page.goto(`${base}/system`);
  await page.waitForSelector("li:has-text('Transcode')", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.locator("li", { hasText: "Transcode" }).first().locator("button:has-text('Kill')").click();
  await waitFor(() => pageHas(page, "presumed dead"), 20_000, "the killed worker to show as dead");
  await shot("6-worker-killed");
  await api("PATCH", "/admin/chaos", { slowFactor: 1 });
  await waitFor(async () => (await status(killed)) === "ready", 120_000, "ready after the kill");
  await page.goto(`${base}/videos/${killed}`);
  await page.waitForSelector("text=Event timeline");
  await page.waitForTimeout(800);
  await shot("7-after-kill");

  step("Dispatcher outage → outbox backlog → drain");
  await page.goto(`${base}/system`);
  await page.locator("label", { hasText: "Pause dispatcher" }).locator("input").check();
  await page.waitForTimeout(800);
  const outage = await upload("Uploaded while the dispatcher was down");
  await waitFor(async () => (await api("GET", "/admin/system")).outboxBacklog > 0, 10_000, "an outbox backlog");
  await page.waitForTimeout(1200);
  await shot("8-dispatcher-paused");
  console.log(`  status while paused: ${await status(outage)}`);
  await page.locator("label", { hasText: "Pause dispatcher" }).locator("input").uncheck();
  await waitFor(async () => (await status(outage)) === "ready", 60_000, "ready after resuming");

  step("Crash after the work, before the DB commit");
  await page.click("text=Arm one crash");
  const crashed = await upload("Crash after output, before DB commit");
  await waitFor(async () => (await status(crashed)) === "ready", 120_000, "ready after the crash");
  await page.goto(`${base}/videos/${crashed}`);
  await page.waitForSelector("text=Event timeline");
  await page.waitForTimeout(800);
  await shot("9-after-crash");
} finally {
  await api("POST", "/admin/chaos/reset").catch(() => {});
  await browser.close();
}

if (errors.length) {
  console.error("Page errors:", errors);
  process.exit(1);
}
console.log(`Chaos walkthrough passed. Screenshots in ${out}`);
