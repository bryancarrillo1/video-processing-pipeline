import { pool, withTransaction, type Queryable } from "./db.ts";
import { emitEvent } from "./jobs.ts";
import { masterManifestKey, putMediaObject } from "./storage.ts";

// The master manifest is the one file a player opens: it lists every playable
// rendition, and the player picks among them as bandwidth changes
// (PROJECT_OVERVIEW: "manifests tell the player what is available").
//
// Publication is "immutable files, swapped by pointer":
//   1. write a brand-new master.v{n+1}.m3u8 (never overwrite a published one)
//   2. move videos.manifest_version to n+1 in the same transaction that
//      records the rendition
// A CDN can then cache every manifest forever: a new rendition means a new
// URL, not a changed file, so nothing ever needs invalidating.

export interface ManifestVariant {
  /** Rung name (360/720/1080). */
  height: number;
  outputWidth: number | null;
  outputHeight: number | null;
  /** Peak bits/s over any one segment; HLS requires it on every variant. */
  bandwidth: number | null;
  /** Where the rendition lives, e.g. "renditions/{videoId}/720/a1/". */
  outputPrefix: string;
}

const MPEGURL = "application/vnd.apple.mpegurl";

// ---------------------------------------------------------------------------
// Pure logic (no I/O): unit tested directly.
// ---------------------------------------------------------------------------

/**
 * Renders an HLS master playlist. Variant URIs are relative to the master's own
 * location (renditions/{videoId}/), so the same file works behind any host.
 *
 * EXT-X-INDEPENDENT-SEGMENTS is a promise we can keep because of M5's fixed
 * GOP: every segment starts on a keyframe, at the same timestamp in every
 * rendition, so a player may switch quality at any segment boundary.
 */
export function buildMasterPlaylist(
  videoId: string,
  variants: readonly ManifestVariant[],
  frameRate: number | null,
): string {
  if (variants.length === 0) throw new Error("A master manifest needs at least one rendition");
  const base = `renditions/${videoId}/`;
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  // Lowest first: players that don't measure bandwidth start with the first entry.
  for (const v of [...variants].sort((a, b) => a.height - b.height)) {
    if (!v.bandwidth) throw new Error(`Rendition ${v.height}p has no measured BANDWIDTH`);
    if (!v.outputPrefix.startsWith(base)) throw new Error(`Rendition ${v.height}p lives outside ${base}`);
    const attrs = [`BANDWIDTH=${v.bandwidth}`];
    if (v.outputWidth && v.outputHeight) attrs.push(`RESOLUTION=${v.outputWidth}x${v.outputHeight}`);
    if (frameRate) attrs.push(`FRAME-RATE=${frameRate.toFixed(3)}`);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, `${v.outputPrefix.slice(base.length)}index.m3u8`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Writes master.v{n+1}.m3u8 listing every recorded rendition and points the
 * video at it. Call it inside the transaction that inserts a rendition row, so
 * "rendition recorded" and "rendition advertised" commit together.
 *
 * The video row lock is what makes this safe when two renditions finish at
 * once: the second transaction waits here until the first commits, then sees
 * its rendition and its version, and publishes n+2 listing both. Without it,
 * both would read version n and each publish an n+1 missing the other's
 * rendition. (FOR NO KEY UPDATE, not FOR UPDATE, for the reason given on
 * recomputeVideoStatus: this transaction already holds a foreign-key lock on
 * the row.)
 *
 * The file is uploaded before the pointer commits, so the pointer can never
 * reference a missing object. If the transaction rolls back, the upload is an
 * orphan that nothing ever pointed to, like an abandoned a{attempt}/ prefix;
 * the next publish may reuse its version number, which is safe because no
 * player or cache was ever handed that URL.
 */
export async function publishManifest(tx: Queryable, videoId: string): Promise<number> {
  const { rows: [video] } = await tx.query<{ manifest_version: number; frame_rate: number | null }>(
    `SELECT manifest_version, frame_rate FROM videos WHERE id = $1 FOR NO KEY UPDATE`,
    [videoId],
  );
  if (!video) throw new Error(`Video ${videoId} not found`);
  // A new statement after the lock: under READ COMMITTED it sees every
  // rendition committed by whoever held the lock before us.
  const { rows } = await tx.query<{
    height: number; output_width: number | null; output_height: number | null; bandwidth: number | null;
    output_prefix: string;
  }>(
    `SELECT height, output_width, output_height, bandwidth, output_prefix
       FROM renditions WHERE video_id = $1 ORDER BY height`,
    [videoId],
  );
  const variants = rows.map((r): ManifestVariant => ({
    height: r.height,
    outputWidth: r.output_width,
    outputHeight: r.output_height,
    bandwidth: r.bandwidth,
    outputPrefix: r.output_prefix,
  }));

  const version = video.manifest_version + 1;
  await putMediaObject(masterManifestKey(videoId, version), buildMasterPlaylist(videoId, variants, video.frame_rate), MPEGURL);
  await tx.query(`UPDATE videos SET manifest_version = $2, updated_at = now() WHERE id = $1`, [videoId, version]);
  await emitEvent(tx, {
    videoId,
    type: "manifest_published",
    detail: { version, resolutions: variants.map((v) => v.height) },
  });
  return version;
}

/**
 * One-off for videos processed before M6: they have verified renditions but
 * no master manifest. Run by `npm run setup`; does nothing once caught up.
 */
export async function backfillManifests(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT v.id FROM videos v
      WHERE v.manifest_version = 0
        AND EXISTS (SELECT 1 FROM renditions r WHERE r.video_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM renditions r WHERE r.video_id = v.id AND r.bandwidth IS NULL)`,
  );
  for (const { id } of rows) await withTransaction((tx) => publishManifest(tx, id));
  return rows.length;
}
