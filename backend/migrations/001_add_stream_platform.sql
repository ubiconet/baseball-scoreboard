-- ============================================================
-- Migration 001: Add streaming platform selector
-- ============================================================
--
-- Adds support for both YouTube and Twitch as RTMP destinations.
-- The user configures both in Settings and selects which one is
-- active via stream_platform. The stream_key column is reused for
-- YouTube's broadcast stream name (existing behaviour); Twitch uses
-- a dedicated twitch_stream_key column so we don't clobber the
-- YouTube key when swapping platforms.
--
-- Default is 'youtube' so existing rows keep working unchanged.

ALTER TABLE scoreboards
    ADD COLUMN IF NOT EXISTS stream_platform TEXT NOT NULL DEFAULT 'youtube'
        CHECK (stream_platform IN ('youtube', 'twitch')),
    ADD COLUMN IF NOT EXISTS twitch_stream_key TEXT,
    ADD COLUMN IF NOT EXISTS twitch_channel_name TEXT;

-- Backfill is automatic via DEFAULT. New columns are nullable (Twitch key)
-- or have a safe default (stream_platform).

COMMENT ON COLUMN scoreboards.stream_platform IS
    'Active RTMP destination. youtube = YouTube Live (uses OAuth, per-broadcast key). twitch = Twitch (manual stream key, persistent).';
COMMENT ON COLUMN scoreboards.twitch_stream_key IS
    'Twitch stream key pasted by the operator. Kept separate from stream_key (YouTube) so toggling platforms does not clobber either.';
COMMENT ON COLUMN scoreboards.twitch_channel_name IS
    'Optional human-readable label for the Twitch channel (purely informational, not used by the stream).';
