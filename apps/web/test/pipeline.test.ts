import { describe, expect, it } from "vitest";
import type { JobEventView, JobView } from "@vpp/core/domain";
import {
  buildLanes,
  buildSteps,
  describeEvent,
  formatBitrate,
  formatBytes,
  formatDuration,
  shortWorker,
} from "../src/lib/pipeline.ts";

function job(overrides: Partial<JobView>): JobView {
  return {
    jobId: crypto.randomUUID(),
    kind: "transcode",
    targetHeight: 360,
    state: "pending",
    attempt: 0,
    maxAttempts: 4,
    progress: 0,
    leaseOwner: null,
    lastError: null,
    errorKind: null,
    nextAttemptAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<JobEventView>): JobEventView {
  return { id: 1, jobId: null, type: "x", attempt: null, workerId: null, detail: {}, at: new Date().toISOString(), ...overrides };
}

describe("buildLanes", () => {
  it("shows placeholders for every stage before any job exists", () => {
    const lanes = buildLanes([]);
    expect(lanes.map((l) => [l.kind, l.label])).toEqual([
      ["placeholder", "Probe"],
      ["placeholder", "Transcode 360p"],
      ["placeholder", "Transcode 720p"],
      ["placeholder", "Transcode 1080p"],
    ]);
  });

  it("puts the probe first and transcodes in height order, filling in real jobs", () => {
    const lanes = buildLanes([
      job({ targetHeight: 1080 }),
      job({ kind: "probe", targetHeight: 0, state: "running" }),
      job({ targetHeight: 360 }),
    ]);
    expect(lanes.map((l) => [l.kind, l.label])).toEqual([
      ["job", "Probe"],
      ["job", "Transcode 360p"],
      ["placeholder", "Transcode 720p"],
      ["job", "Transcode 1080p"],
    ]);
  });

  it("marks heights the probe didn't fan out as skipped, with the reason", () => {
    // Fan-out commits with the probe's completion, so a missing job after
    // that is final: the source was too small to upscale from.
    const jobs = [job({ kind: "probe", targetHeight: 0, state: "completed" }), job({ targetHeight: 360 })];
    const lanes = buildLanes(jobs, { width: 1280, height: 720 }).filter((l) => l.kind === "skipped");
    expect(lanes).toEqual([
      { kind: "skipped", key: "t720", label: "Transcode 720p", reason: expect.any(String) },
      { kind: "skipped", key: "t1080", label: "Transcode 1080p", reason: "source is 720p: no upscaling" },
    ]);
    const failed = buildLanes([job({ kind: "probe", targetHeight: 0, state: "failed" })]);
    expect(failed.slice(1).map((l) => l.kind === "skipped" && l.reason)).toEqual(
      Array(3).fill("probe failed: nothing to transcode"),
    );
  });
});

describe("buildSteps", () => {
  const states = (s: ReturnType<typeof buildSteps>) => s.map((x) => x.state);

  it("is on 'Uploaded' while bytes are still uploading", () => {
    expect(states(buildSteps("uploading", []))).toEqual(["active", "todo", "todo", "todo", "todo"]);
  });

  it("is on 'Queued' until a worker claims the probe", () => {
    expect(states(buildSteps("queued", [job({ kind: "probe", state: "pending" })]))).toEqual([
      "done", "active", "todo", "todo", "todo",
    ]);
  });

  it("shows transcoding active while renditions run", () => {
    const jobs = [job({ kind: "probe", state: "completed" }), job({ state: "completed" }), job({ state: "running" })];
    expect(states(buildSteps("processing", jobs))).toEqual(["done", "done", "done", "active", "todo"]);
  });

  it("marks a failed probe and video as failed", () => {
    expect(states(buildSteps("failed", [job({ kind: "probe", state: "failed" })]))).toEqual([
      "done", "done", "failed", "todo", "failed",
    ]);
  });
});

describe("describeEvent", () => {
  const labelFor = () => "Transcode 720p";

  it("flags takeovers of a dead worker's lease as warnings with an explanation", () => {
    const d = describeEvent(event({ type: "claimed", jobId: "j", attempt: 2, detail: { takeover: true } }), labelFor);
    expect(d).toMatchObject({ title: "Transcode 720p reclaimed (attempt 2)", tone: "warning" });
    expect(d.note).toMatch(/lease expired/);
  });

  it("treats a claim after a scheduled retry as routine", () => {
    expect(describeEvent(event({ type: "claimed", jobId: "j", attempt: 2 }), labelFor)).toEqual({
      title: "Transcode 720p claimed (attempt 2)",
      tone: "info",
    });
  });

  it("explains scheduled retries and permanent failures", () => {
    const retry = describeEvent(
      event({
        type: "retry_scheduled",
        jobId: "j",
        attempt: 1,
        detail: { error: "Storage write timed out", delayMs: 2300, nextAttempt: 2, maxAttempts: 4 },
      }),
      labelFor,
    );
    expect(retry.title).toBe("Transcode 720p attempt 1 failed; retrying in 2.3 s");
    expect(retry.note).toContain("Retry 2/4");
    const permanent = describeEvent(
      event({ type: "failed", jobId: "j", attempt: 1, detail: { reason: "permanent", error: "Unsupported codec" } }),
      labelFor,
    );
    expect(permanent).toMatchObject({ title: "Transcode 720p failed permanently", tone: "danger" });
  });

  it("treats a first claim as routine", () => {
    expect(describeEvent(event({ type: "claimed", jobId: "j", attempt: 1 }), labelFor)).toEqual({
      title: "Transcode 720p claimed",
      tone: "info",
    });
  });

  it("explains fencing rejections", () => {
    const d = describeEvent(event({ type: "stale_write_rejected", jobId: "j" }), labelFor);
    expect(d.tone).toBe("danger");
    expect(d.note).toMatch(/Fencing/);
  });

  it("summarizes what the probe found and what a transcode verified", () => {
    const probe = describeEvent(
      event({
        type: "completed",
        jobId: "j",
        detail: { width: 1920, height: 1080, durationS: 12.5, frameRate: 30, videoCodec: "h264", hasAudio: true, renditions: [360, 720, 1080] },
      }),
      () => "Probe",
    );
    expect(probe.title).toBe("Probe completed: 1920×1080, 12.5 s");
    expect(probe.note).toBe("h264 at 30 fps with audio. Fanning out: 360p, 720p, 1080p.");
    const transcode = describeEvent(
      event({ type: "completed", jobId: "j", detail: { width: 1280, height: 720, bandwidth: 2_400_000, segmentCount: 3 } }),
      labelFor,
    );
    expect(transcode).toMatchObject({ title: "Transcode 720p completed and published", tone: "success" });
    expect(transcode.note).toBe("Verified before publishing: 3 segments at 1280×720, peak 2.4 Mbps.");
  });

  it("describes status transitions", () => {
    expect(describeEvent(event({ type: "video_status", detail: { from: "processing", to: "ready" } }), labelFor)).toEqual({
      title: "Video processing → ready",
      tone: "success",
    });
  });
});

describe("formatting", () => {
  it("formats bytes, durations and worker ids", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 MB");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(8_200)).toBe("8.2 s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(shortWorker("Bryans-MacBook-Pro-19081")).toBe("Bryans-MacBo…:19081");
    expect(shortWorker("worker-7")).toBe("worker:7");
    expect(formatBitrate(812_345)).toBe("812 kbps");
    expect(formatBitrate(2_449_000)).toBe("2.4 Mbps");
  });
});
