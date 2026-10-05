-- ============================================================
-- Migration 005: GameChanger as a third streaming platform
-- ============================================================
--
-- GameChanger (GC) gives you a per-event RTMP URL + stream key
-- (copied from the GC app's "Other Camera → Switch To Insecure
-- Ingest (RTMP)" flow). Unlike YouTube/Twitch there is no fixed
-- ingest — BOTH the URL and the key are user inputs, and both
-- rotate per event/game, so the operator must paste fresh ones
-- before each game.
--
-- Both columns are nullable: GC is optional and unconfigured by
-- default. The platform switch (stream_platform = 'gamechanger')
-- only requires them at Start Stream time.

ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS gc_stream_url TEXT;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS gc_stream_key TEXT;

COMMENT ON COLUMN scoreboards.gc_stream_url IS
    'GameChanger per-event RTMP ingest URL (rtmp:// or rtmps://, from GC app → External Camera → Other Camera). Rotates per event — copy a fresh one before each game. No fixed ingest exists for GC.';
COMMENT ON COLUMN scoreboards.gc_stream_key IS
    'GameChanger per-event stream key pasted by the operator. Rotates with the URL per event. Kept separate from the YouTube/Twitch keys so swapping platforms clobbers nothing.';

-- Relax the stream_platform CHECK (added in migration 001) to admit
-- 'gamechanger'. The inline constraint from 001 is named
-- <table>_<column>_check; drop and recreate it with the widened
-- allowlist. Without this the platform-switch UPDATE would fail at
-- the DB level even though the API accepts the value.
ALTER TABLE scoreboards DROP CONSTRAINT IF EXISTS scoreboards_stream_platform_check;
ALTER TABLE scoreboards
    ADD CONSTRAINT scoreboards_stream_platform_check
    CHECK (stream_platform IN ('youtube', 'twitch', 'gamechanger'));
