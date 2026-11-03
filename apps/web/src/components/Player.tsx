import { useEffect, useRef, useState } from "react";
// The "light" build leaves out what we don't use (subtitles, alternate audio,
// DRM) and is ~40% smaller. Its types are declared in vite-env.d.ts.
import Hls, { Events, type NetworkDetails } from "hls.js/light";
import type { PlaybackInfo } from "@vpp/core/domain";
import { api } from "../lib/api.ts";
import { formatBitrate } from "../lib/pipeline.ts";
import { cx } from "./ui.tsx";
import styles from "./Player.module.css";

// The "Watch" path from PROJECT_OVERVIEW: ask the API *where* to play from
// (GET /videos/:id/playback), then fetch the manifest and segments straight
// from the CDN. The API never touches video bytes.
//
// Loaded lazily by VideoPage (React.lazy), so hls.js is only downloaded by
// pages that play video.

interface Level {
  index: number;
  height: number;
  width: number;
  bitrate: number;
}

/** "auto" lets hls.js pick by measured bandwidth; a number pins that rung. */
type Quality = "auto" | number;

/**
 * Where the last segment came from, nearest first:
 *   BROWSER: the browser's own HTTP cache (segments are immutable, so it keeps them)
 *   HIT:     the CDN edge cache
 *   MISS:    the CDN fetched it from storage
 */
type SegmentSource = "BROWSER" | "HIT" | "MISS";

interface CdnStats {
  last: SegmentSource | null;
  browser: number;
  hits: number;
  misses: number;
}

export default function Player({
  videoId,
  manifestVersion,
  poster,
}: {
  videoId: string;
  /** From the live video detail: when it bumps, a new manifest is out. */
  manifestVersion: number;
  poster: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [playing, setPlaying] = useState<Level | null>(null);
  const [quality, setQuality] = useState<Quality>("auto");
  const [bandwidth, setBandwidth] = useState<number | null>(null);
  const [cdn, setCdn] = useState<CdnStats>({ last: null, browser: 0, hits: 0, misses: 0 });
  const [upgrade, setUpgrade] = useState<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const infoRef = useRef<PlaybackInfo | null>(null);
  // Read inside hls.js callbacks without re-running the effect that owns them.
  const qualityRef = useRef<Quality>("auto");
  // Where to pick up after an upgrade. Saved by the old player's cleanup:
  // by the time the new effect runs, hls.destroy() has already reset the
  // <video> element to 0 and paused it.
  const resumeRef = useRef<{ at: number; playing: boolean } | null>(null);

  // 1. Where to play from. Re-asked whenever the manifest version moves; a
  //    `stale` flag drops a slow response that a newer request overtook.
  useEffect(() => {
    let stale = false;
    api
      .getPlayback(videoId)
      .then((next) => {
        if (stale) return;
        setError(null);
        const prev = infoRef.current;
        // Never go backwards (an out-of-order response for an older version).
        if (prev && prev.manifestVersion >= next.manifestVersion) return;
        if (prev) {
          const added = next.availableResolutions.filter((h) => !prev.availableResolutions.includes(h));
          setUpgrade(
            `Upgraded to manifest v${next.manifestVersion}` +
              (added.length ? `: ${added.map((h) => `${h}p`).join(", ")} added` : ""),
          );
        }
        infoRef.current = next;
        setInfo(next);
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [videoId, manifestVersion]);

  useEffect(() => {
    if (!upgrade) return;
    const t = setTimeout(() => setUpgrade(null), 6000);
    return () => clearTimeout(t);
  }, [upgrade]);

  // 2. Attach the player to the current manifest. A new manifest version is a
  //    new URL (manifests are immutable), so "upgrade" means: load the new
  //    one at the same position and keep playing if we were.
  const playbackUrl = info?.playbackUrl;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackUrl) return;
    const { at: resumeAt, playing: wasPlaying } = resumeRef.current ?? { at: 0, playing: false };
    resumeRef.current = null;

    if (!Hls.isSupported()) {
      // Safari/iOS play HLS natively: adaptive switching is automatic and the
      // quality menu and CDN readout aren't available.
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playbackUrl;
        video.addEventListener("loadedmetadata", () => (video.currentTime = resumeAt), { once: true });
        if (wasPlaying) void video.play().catch(() => {});
        return () => {
          resumeRef.current = { at: video.currentTime, playing: !video.paused && !video.ended };
        };
      }
      setError("This browser can't play HLS");
      return;
    }

    const hls = new Hls({ startPosition: resumeAt > 0 ? resumeAt : -1 });
    hlsRef.current = hls;

    hls.on(Events.MANIFEST_PARSED, () => {
      const next = hls.levels.map((l, index) => ({ index, height: l.height, width: l.width, bitrate: l.bitrate }));
      setLevels(next);
      // Keep a pinned quality across upgrades if the new manifest still has it.
      const pinned = qualityRef.current;
      const keep = pinned === "auto" ? -1 : next.findIndex((l) => rungOf(l) === pinned);
      hls.currentLevel = keep;
      if (keep === -1 && pinned !== "auto") {
        qualityRef.current = "auto";
        setQuality("auto");
      }
      if (wasPlaying) void video.play().catch(() => {});
    });
    hls.on(Events.LEVEL_SWITCHED, (_e, data) => {
      const l = hls.levels[data.level];
      if (l) setPlaying({ index: data.level, height: l.height, width: l.width, bitrate: l.bitrate });
    });
    hls.on(Events.FRAG_LOADED, (_e, data) => {
      setBandwidth(hls.bandwidthEstimate);
      const source = segmentSource(data.frag.url, data.networkDetails);
      if (source) {
        setCdn((c) => ({
          last: source,
          browser: c.browser + (source === "BROWSER" ? 1 : 0),
          hits: c.hits + (source === "HIT" ? 1 : 0),
          misses: c.misses + (source === "MISS" ? 1 : 0),
        }));
      }
    });
    hls.on(Events.ERROR, (_e, data) => {
      if (data.fatal) setError(`Playback error: ${data.details}`);
    });

    hls.loadSource(playbackUrl);
    hls.attachMedia(video);
    return () => {
      resumeRef.current = { at: video.currentTime, playing: !video.paused && !video.ended };
      hls.destroy();
      hlsRef.current = null;
    };
  }, [playbackUrl]);

  const choose = (q: Quality) => {
    qualityRef.current = q;
    setQuality(q);
    const hls = hlsRef.current;
    if (!hls) return;
    // currentLevel switches now (flushing the buffer); -1 hands control back to ABR.
    hls.currentLevel = q === "auto" ? -1 : levels.findIndex((l) => rungOf(l) === q);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.stage}>
        <video
          ref={videoRef}
          className={styles.video}
          controls
          playsInline
          poster={poster ?? undefined}
          data-testid="player"
        />
        {upgrade && <div className={styles.toast}>{upgrade}</div>}
      </div>

      <div className={styles.bar}>
        <label className={styles.quality}>
          <span>Quality</span>
          <select
            value={String(quality)}
            onChange={(e) => choose(e.target.value === "auto" ? "auto" : Number(e.target.value))}
            disabled={levels.length === 0}
            aria-label="Quality"
          >
            <option value="auto">Auto{quality === "auto" && playing ? ` (${rungOf(playing)}p)` : ""}</option>
            {[...levels].reverse().map((l) => (
              <option key={l.index} value={rungOf(l)}>
                {rungOf(l)}p · {formatBitrate(l.bitrate)}
              </option>
            ))}
          </select>
        </label>

        <Stat label="Playing" value={playing ? `${rungOf(playing)}p · ${playing.width}×${playing.height}` : "—"} />
        <Stat
          label="Bandwidth"
          value={bandwidth ? formatBitrate(bandwidth) : "—"}
          title="hls.js's running estimate from segment downloads; Auto picks the best rung that fits"
        />
        <span
          className={styles.stat}
          title="Where the last segment came from: HIT = the CDN edge cache, MISS = the CDN fetched it from storage, BROWSER = this browser's own cache"
        >
          <span className={styles.statLabel}>CDN</span>
          <span
            className={cx(styles.cdn, cdn.last && styles[`src_${cdn.last}`])}
            data-testid="cdn-status"
            data-hits={cdn.hits}
          >
            {cdn.last ?? "—"}
          </span>
          {cdn.last && (
            <span className={styles.statFaint}>
              {cdn.hits} hit{cdn.hits === 1 ? "" : "s"} · {cdn.misses} miss{cdn.misses === 1 ? "" : "es"}
              {cdn.browser > 0 && ` · ${cdn.browser} local`}
            </span>
          )}
        </span>
        {info && (
          <a className={styles.manifest} href={info.playbackUrl} target="_blank" rel="noreferrer" title={info.playbackUrl}>
            master.v{info.manifestVersion}.m3u8 ↗
          </a>
        )}
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className={styles.stat} title={title}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </span>
  );
}

/** The rung name (short side), so a portrait 360×640 level reads "360p". */
function rungOf(l: Pick<Level, "width" | "height">): number {
  return Math.min(l.width, l.height) || l.height;
}

/**
 * The CDN reports HIT/MISS in X-Cache-Status, but a response the browser
 * replays from its own cache carries the header from when it was first
 * fetched. Resource Timing tells the two apart: nothing transferred over the
 * network means the browser served it. (Cross-origin, that needs the CDN's
 * Timing-Allow-Origin header; without one, transferSize always reads 0.)
 */
function segmentSource(url: string, details: NetworkDetails | null): SegmentSource | null {
  const timing = performance.getEntriesByName(url).at(-1) as PerformanceResourceTiming | undefined;
  // The buffer holds ~250 entries by default; a long video would fill it.
  if (performance.getEntriesByType("resource").length > 200) performance.clearResourceTimings();
  if (timing && timing.transferSize === 0 && timing.decodedBodySize > 0) return "BROWSER";
  const status = header(details, "x-cache-status");
  return status === "HIT" ? "HIT" : status ? "MISS" : null;
}

/** Reads a response header from whichever loader hls.js used (XHR by default, or fetch). */
function header(details: NetworkDetails | null, name: string): string | null {
  if (details instanceof XMLHttpRequest) return details.getResponseHeader(name);
  if (details instanceof Response) return details.headers.get(name);
  return null;
}
