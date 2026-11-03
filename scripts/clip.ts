// Generates test videos with ffmpeg's built-in test pattern (testsrc2) and a
// sine tone, so the repo never has to commit binary fixtures. Used by the
// integration tests, the UI smoke test and the chaos walkthrough.
// (A slice of M9's scripts/seed.ts, pulled forward for M5.)

import { execFile } from "node:child_process";
import { access, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ClipOptions {
  width: number;
  height: number;
  seconds: number;
  fps?: number;
  audio?: boolean;
}

/** Returns the path of a matching clip, generating it on first use (cached in the OS temp dir). */
export async function makeClip({ width, height, seconds, fps = 30, audio = true }: ClipOptions): Promise<string> {
  const file = path.join(os.tmpdir(), `vpp-clip-${width}x${height}-${seconds}s-${fps}fps${audio ? "" : "-mute"}.mp4`);
  if (await access(file).then(() => true, () => false)) return file;

  // Write under a unique name, then rename: concurrent callers never see half a file.
  const tmp = `${file}.${process.pid}.${Date.now()}.mp4`;
  // prettier-ignore
  await exec(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
    ...(audio ? ["-c:a", "aac", "-shortest"] : []),
    "-movflags", "+faststart",
    tmp,
  ]);
  await rename(tmp, file);
  return file;
}
