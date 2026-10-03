-- ============================================================
-- Migration 003: Drop NOT NULL on stream_output_width/height
-- ============================================================
--
-- Migration 002 set these columns to NOT NULL because the original
-- design assumed the operator always wants downscaling. But the
-- "Source (no scaling)" UI preset means output == capture size,
-- which is signalled by NULL output dims (the Pi's stream_scoreboard.py
-- passes them through as "no --output-width/--height" → no scaling).
--
-- So the meaning of NULL is legitimate: "no scaling". Drop the
-- NOT NULL constraint.

ALTER TABLE scoreboards
    ALTER COLUMN stream_output_width DROP NOT NULL,
    ALTER COLUMN stream_output_height DROP NOT NULL;

COMMENT ON COLUMN scoreboards.stream_output_width IS
    'Encoder output width, or NULL for no scaling (capture == output). Sent to Pi as --output-width; when NULL, the Pi passes capture width through unchanged.';
COMMENT ON COLUMN scoreboards.stream_output_height IS
    'Encoder output height, or NULL for no scaling. See stream_output_width.';