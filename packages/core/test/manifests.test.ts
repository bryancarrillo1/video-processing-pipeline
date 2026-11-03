import { afterAll, describe, expect, it } from "vitest";
import {
  buildMasterPlaylist,
  masterManifestKey,
  mediaUrl,
  pool,
  publishManifest,
  type ManifestVariant,
} from "../src/index.ts";

afterAll(() => pool.end());

const videoId = "6f1c1d3e-0000-4000-8000-000000000001";
const variant = (height: number, width: number, bandwidth: number | null, attempt = 1): ManifestVariant => ({
  height,
  outputWidth: width,
  outputHeight: height,
  bandwidth,
  outputPrefix: `renditions/${videoId}/${height}/a${attempt}/`,
});

describe("buildMasterPlaylist", () => {
  it("lists every rendition, lowest first, with paths relative to the master", () => {
    const text = buildMasterPlaylist(videoId, [variant(720, 1280, 2_400_000, 2), variant(360, 640, 700_000)], 30);
    expect(text).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        "#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,FRAME-RATE=30.000",
        "360/a1/index.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=30.000",
        // The retried rendition's own attempt folder: the manifest points at what was verified.
        "720/a2/index.m3u8",
        "",
      ].join("\n"),
    );
  });

  it("uses the real encoded size, so portrait video advertises 360x640", () => {
    const portrait = { ...variant(360, 0, 500_000), outputWidth: 360, outputHeight: 640 };
    expect(buildMasterPlaylist(videoId, [portrait], null)).toContain("BANDWIDTH=500000,RESOLUTION=360x640\n");
  });

  it("refuses to publish what it can't describe", () => {
    expect(() => buildMasterPlaylist(videoId, [], 30)).toThrow(/at least one/);
    // BANDWIDTH is mandatory in HLS; a player can't choose a variant without it.
    expect(() => buildMasterPlaylist(videoId, [variant(360, 640, null)], 30)).toThrow(/BANDWIDTH/);
    const elsewhere = { ...variant(360, 640, 1), outputPrefix: "renditions/other-video/360/a1/" };
    expect(() => buildMasterPlaylist(videoId, [elsewhere], 30)).toThrow(/outside/);
  });
});

describe("publishManifest", () => {
  it("serializes renditions that finish at the same moment: v1 then v2, and v2 lists both", async () => {
    // Without the video row lock, both transactions read manifest_version 0
    // and each publishes a v1 that's missing the other's rendition: the
    // pointer ends at v1 and one finished rendition is never advertised.
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO videos (id, owner_id, title, source_key, status, frame_rate)
       VALUES ($1, 'manifest-test', 'race', 'x', 'processing', 30)`,
      [id],
    );
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      // Like two transcodes' completion transactions: each has recorded its rendition...
      for (const [c, h, w] of [[c1, 360, 640], [c2, 720, 1280]] as const) {
        await c.query(
          `INSERT INTO renditions (video_id, height, output_width, output_height, bandwidth, segment_count, output_prefix)
           VALUES ($1, $2, $3, $2, $4, 1, $5)`,
          [id, h, w, h * 1000, `renditions/${id}/${h}/a1/`],
        );
      }
      // ...and now both publish at once. Whichever gets the lock commits first,
      // which lets the other through.
      const versions = await Promise.all(
        [c1, c2].map((c) => publishManifest(c, id).then(async (v) => (await c.query("COMMIT"), v))),
      );
      expect(versions.sort()).toEqual([1, 2]);
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c2.query("ROLLBACK").catch(() => {});
      c1.release();
      c2.release();
    }

    const { rows } = await pool.query(`SELECT manifest_version FROM videos WHERE id = $1`, [id]);
    expect(rows[0].manifest_version).toBe(2);

    // Fetched through the CDN: v2 lists both, and v1 (still there, unchanged) lists one.
    const v2 = await (await fetch(mediaUrl(masterManifestKey(id, 2)))).text();
    expect(v2.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    const v1 = await (await fetch(mediaUrl(masterManifestKey(id, 1)))).text();
    expect(v1.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);

    const { rows: events } = await pool.query(
      `SELECT detail FROM job_events WHERE video_id = $1 AND type = 'manifest_published' ORDER BY id`,
      [id],
    );
    expect(events.map((e) => e.detail.version)).toEqual([1, 2]);
    expect(events[1].detail.resolutions).toEqual([360, 720]);
  });
});
