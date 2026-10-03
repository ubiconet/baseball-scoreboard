-- ============================================================
-- Migration 002: Video encoding settings for Pi streamer
-- ============================================================
--
-- Adds persistent per-scoreboard knobs for the encoder pipeline
-- that the operator can tweak from Settings → Live Stream. These
-- are forwarded to the Pi on every Start Stream so the operator
-- doesn't have to SSH into the Pi to change resolution / fps /
-- audio bitrate between games.
--
-- Why output_width/output_height and not just stream_resolution?
-- The existing `stream_resolution` column ('720p' | '1080p') is
-- owned by the direct-mode (Mac-side HLS) pipeline. The Pi uses
-- V4L2 M2M hardware downscaling from capture (640×480) to a
-- smaller encode output, which is a different concept. Adding
-- separate columns keeps the two pipelines independent — no
-- behavior change to direct mode.
--
-- Defaults preserve Steve's current manually-launched args:
--   capture=640x480, output=480x360, fps=30, audio=64k.
-- output_width/output_height are NULL by default, which the
-- backend treats as "no scaling" (capture == output).

ALTER TABLE scoreboards
    ADD COLUMN IF NOT EXISTS stream_output_width INTEGER,
    ADD COLUMN IF NOT EXISTS stream_output_height INTEGER,
    ADD COLUMN IF NOT EXISTS stream_fps INTEGER NOT NULL DEFAULT 30
        CHECK (stream_fps IN (15, 24, 30)),
    ADD COLUMN IF NOT EXISTS stream_audio_bitrate TEXT NOT NULL DEFAULT '64k'
        CHECK (stream_audio_bitrate IN ('64k', '96k', '128k'));

-- Backfill output dims to Steve's current production values so
-- any scoreboards that existed before this migration pick up
-- the downscaled-by-default behavior. (Existing streams that
-- were running with --output-width/--height at the CLI are not
-- affected; this just makes the persisted value match what was
-- actually being used.)
UPDATE scoreboards
   SET stream_output_width = 480,
       stream_output_height = 360
 WHERE stream_output_width IS NULL
   AND stream_output_height IS NULL;

-- Keep these columns NULLABLE. NULL = "no scaling — pass capture
-- width through to encoder output" (the "Source" UI preset).
-- Originally this migration set NOT NULL, but migration 003
-- reverted that after the UI shipped with the Source option.

COMMENT ON COLUMN scoreboards.stream_output_width IS
    'Encoder output width, or NULL for no scaling (capture == output). Sent to Pi as --output-width; when NULL, the Pi passes capture width through unchanged.';
COMMENT ON COLUMN scoreboards.stream_output_height IS
    'Encoder output height, or NULL for no scaling. See stream_output_width.';
COMMENT ON COLUMN scoreboards.stream_fps IS
    'Capture + encode frame rate. Sent to Pi as --fps. Constrained to common broadcast values (15/24/30).';
COMMENT ON COLUMN scoreboards.stream_audio_bitrate IS
    'AAC audio bitrate. Sent to Pi as --audio-bitrate. Constrained to common values (64k/96k/128k). 64k is sufficient for voice-over-baseball; 128k for music.';
