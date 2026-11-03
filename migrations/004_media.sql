-- M5: real media. The probe records what the source really is (not what the
-- client claimed); transcodes record what they produced and verified.

ALTER TABLE videos
  ADD COLUMN duration_s     real,
  ADD COLUMN width          int,
  ADD COLUMN height         int,
  ADD COLUMN frame_rate     real,
  -- Key in the public media bucket; attempt-scoped like rendition outputs.
  ADD COLUMN thumbnail_key  text;

-- `height` stays the rung's name (360/720/1080 = the short side). The actual
-- pixel size differs for portrait or unusual aspect ratios, so store it too.
ALTER TABLE renditions
  ADD COLUMN output_width   int,
  ADD COLUMN output_height  int,
  -- Peak bits/s over any one segment: what an HLS master playlist's BANDWIDTH
  -- attribute means, so M6 can write the manifest straight from this row.
  ADD COLUMN bandwidth      int,
  ADD COLUMN segment_count  int;
