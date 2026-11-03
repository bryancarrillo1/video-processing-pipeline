// Browser smoke test: drives the real UI in headless Chromium against a running
// stack (`npm run dev`) and saves screenshots along the way.
//
//   npm run smoke:ui                      # screenshots → ./screenshots
//   npm run smoke:ui -- --out /tmp/shots  # elsewhere
//
// Covers: login, CORS upload straight to S3, live SSE updates on the pipeline
// page, real thumbnails and verified renditions from the media bucket, HLS
// playback through the CDN (starting before processing finishes, surviving
// manifest upgrades, manual quality, cache HITs), the library view and the
// phone layout. Fails on any console error.
// (The CI version with assertions arrives in M9.)

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { makeClip } from "./clip.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "screenshots" },
    url: { type: "string", default: "http://localhost:5173" },
  },
});
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });

// A real 1080p video (generated, not committed), long enough that the
// transcodes are visibly running for a few seconds.
const clip = await makeClip({ width: 1920, height: 1080, seconds: 20 });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (name: string, fullPage = false) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage });

try {
  await page.goto(values.url);
  await shot("1-login");
  await page.fill("#username", `smoke-${Date.now().toString(36)}`);
  await page.click("button:has-text('Continue')");
  await page.waitForSelector("text=Your videos");
  await page.waitForSelector("text=Live");
  await shot("2-library-empty");

  await page.click("text=+ Upload video");
  await page.setInputFiles("input[type=file]", clip);
  await page.fill("#title", "Smoke test video");
  await shot("3-upload");
  await page.click("button:has-text('Upload')");
  await page.waitForURL(/\/videos\//, { timeout: 20_000 });

  // Live updates: a job must show as running without a page reload.
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("running"), null, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1000);
  await shot("4-pipeline-running", true);

  // Playback starts at the first verified rendition, before the others finish.
  await page.waitForSelector("[data-testid=player]", { timeout: 60_000 });
  const statusAtFirstPlay = await page.textContent("h1 + span");
  // Muted so headless autoplay rules allow play() without a click.
  await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=player]")!;
    v.muted = true;
    return v.play();
  });
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("[data-testid=player]")!.currentTime > 0.5);
  await shot("5-playing-while-processing", true);

  await page.waitForFunction(() => document.querySelector("h1 + span")?.textContent === "ready", null, {
    timeout: 90_000,
  });
  await page.waitForSelector("text=Verified renditions");
  await page.waitForFunction(() => document.querySelectorAll("a[href$='index.m3u8']").length === 3);
  // Two manifest upgrades later (v1 → v3), still playing, from where it was.
  await page.waitForSelector("text=master.v3.m3u8");
  await page.waitForTimeout(1500);
  const afterUpgrade = await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=player]")!;
    return { t: v.currentTime, playing: !v.paused || v.ended };
  });
  if (!afterUpgrade.playing || afterUpgrade.t < 1) throw new Error(`Playback didn't survive the upgrade: ${JSON.stringify(afterUpgrade)}`);
  const qualities = await page.$$eval("select[aria-label=Quality] option", (os) => os.map((o) => o.textContent));
  if (qualities.length !== 4) throw new Error(`Expected Auto + 3 qualities, got ${JSON.stringify(qualities)}`);
  await page.selectOption("select[aria-label=Quality]", "360");
  await page.waitForFunction(() => document.body.innerText.includes("360p · 640×360"), null, { timeout: 15_000 });
  await page.waitForFunction(() => /HIT|MISS|BROWSER/.test(document.querySelector("[data-testid=cdn-status]")?.textContent ?? ""));
  await shot("6-pipeline-ready", true);

  // A second viewer, with an empty browser cache, gets the segments the first
  // viewer already pulled through the CDN from the edge: HITs, not storage.
  const viewer = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: await page.context().storageState() });
  const second = await viewer.newPage();
  second.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await second.goto(page.url());
  await second.waitForSelector("[data-testid=player]");
  await second.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=player]")!;
    v.muted = true;
    return v.play();
  });
  await second.waitForFunction(
    () => Number(document.querySelector("[data-testid=cdn-status]")?.getAttribute("data-hits")) > 0,
    null,
    { timeout: 15_000 },
  );
  await second.waitForTimeout(1500);
  await second.screenshot({ path: path.join(out, "7-second-viewer-cdn-hit.png") });
  await viewer.close();
  console.log(`Player appeared while the video was "${statusAtFirstPlay}"; qualities: ${qualities.join(" | ")}`);

  await page.click("text=← Library");
  await page.waitForSelector("text=Your videos");
  // The probe's thumbnail, loaded anonymously from the public media bucket.
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>("a[href^='/videos/'] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await page.waitForTimeout(400);
  await shot("8-library");

  await page.setViewportSize({ width: 400, height: 860 });
  await page.goBack();
  await page.waitForSelector("text=Event timeline");
  await page.waitForTimeout(600);
  await shot("9-mobile", true);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error("Console errors:", errors);
  process.exit(1);
}
console.log(`UI smoke passed. Screenshots in ${out}`);
