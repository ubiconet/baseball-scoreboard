-- ============================================================
-- Migration 004: Stream A/V tuning (audio gain + camera image)
-- ============================================================
--
-- Adds per-scoreboard knobs for the stream's audio volume and
-- camera image, adjustable from Settings → Live Stream →
-- Audio & Image:
--
--   stream_audio_gain_db     — digital gain applied by ffmpeg's
--                              `volume` filter in the audio encode
--                              chain. Default 10 dB matches the
--                              previously hardcoded +10 dB boost
--                              (camera mic captures ~-37 dBFS room
--                              tone). Range: -10..30 dB.
--   stream_camera_brightness — UVC-style percentage, 0..200 with
--                              100 = neutral. NULL = camera default.
--   stream_camera_contrast   — same scale as brightness.
--
-- The gain applies on the next Start Stream (ffmpeg is spawned per
-- stream). Brightness/contrast are additionally forwarded LIVE via
-- stream:cmd {action:'camera_tune'} so the operator sees the effect
-- (and the live preview) without restarting the stream.

ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_audio_gain_db INTEGER NOT NULL DEFAULT 10;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_camera_brightness INTEGER;  -- NULL = camera default
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_camera_contrast INTEGER;    -- NULL = camera default

COMMENT ON COLUMN scoreboards.stream_audio_gain_db IS
    'Audio gain in dB applied by ffmpeg -af volume= on the Pi. Range -10..30, default 10. Applies on next Start Stream.';
COMMENT ON COLUMN scoreboards.stream_camera_brightness IS
    'UVC camera brightness, 0..200 with 100 = neutral. NULL = camera default. Applied live via camera_tune and on stream start.';
COMMENT ON COLUMN scoreboards.stream_camera_contrast IS
    'UVC camera contrast, 0..200 with 100 = neutral. NULL = camera default. Applied live via camera_tune and on stream start.';
