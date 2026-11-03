import { Link } from "react-router";
import { api } from "../lib/api.ts";
import { formatRelative } from "../lib/pipeline.ts";
import { useLiveQuery, useNow } from "../hooks/useLiveQuery.ts";
import { ResolutionChips, Spinner, StatusBadge, Thumbnail } from "../components/ui.tsx";
import styles from "./LibraryPage.module.css";

export function LibraryPage() {
  // Any event for any of my videos can change the list: refetch on all of them.
  const { data: videos, error, loading } = useLiveQuery("library", api.listVideos, () => true);
  useNow(true, 15_000); // keep "2m ago" labels fresh

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1>Your videos</h1>
          <p className="muted">{videos ? `${videos.length} video${videos.length === 1 ? "" : "s"}` : " "}</p>
        </div>
        <Link to="/upload" className="btn btn-primary">
          + Upload video
        </Link>
      </div>

      {loading && <Spinner />}
      {error && <p className={styles.error}>Couldn't load videos: {error.message}</p>}

      {videos?.length === 0 && (
        <div className={`card ${styles.empty}`}>
          <h2>No videos yet</h2>
          <p className="muted">
            Upload one to watch it move through the pipeline: probe, fan-out, and three transcodes, live.
          </p>
          <Link to="/upload" className="btn btn-primary">
            Upload your first video
          </Link>
        </div>
      )}

      {videos && videos.length > 0 && (
        <ul className={styles.grid}>
          {videos.map((v) => (
            <li key={v.videoId}>
              <Link to={`/videos/${v.videoId}`} className={`card ${styles.tile}`}>
                <Thumbnail videoId={v.videoId} url={v.thumbnailUrl} status={v.status} progress={v.progress} />
                <div className={styles.body}>
                  <h3 className={styles.title} title={v.title}>
                    {v.title}
                  </h3>
                  <div className={styles.meta}>
                    <StatusBadge status={v.status} />
                    <span className={styles.time}>{formatRelative(v.createdAt)}</span>
                  </div>
                  <ResolutionChips available={v.availableResolutions} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
