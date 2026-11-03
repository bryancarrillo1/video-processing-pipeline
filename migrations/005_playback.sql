-- M6: playback. Master manifests are immutable files (master.v{n}.m3u8);
-- this column is the pointer to the current one. 0 = nothing published yet.
-- Moving the pointer is a row update under the video's lock, so two renditions
-- finishing together publish v{n+1} and v{n+2}, never two different v{n+1}s.
ALTER TABLE videos
  ADD COLUMN manifest_version int NOT NULL DEFAULT 0 CHECK (manifest_version >= 0);
