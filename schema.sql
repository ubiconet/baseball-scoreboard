-- ============================================================
-- Electronic Scoreboard Management - Database Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS scoreboards (
    id              SERIAL PRIMARY KEY,
    unique_identifier TEXT NOT NULL UNIQUE,       -- short slug/code, e.g. 'field-1'
    display_name    TEXT NOT NULL DEFAULT '',
    home_team_name  TEXT NOT NULL DEFAULT 'Home',
    away_team_name  TEXT NOT NULL DEFAULT 'Away',

    -- Scoreboard state (1:1 with the board — always exactly one current state)
    home_score      INTEGER NOT NULL DEFAULT 0,
    away_score      INTEGER NOT NULL DEFAULT 0,
    inning          INTEGER NOT NULL DEFAULT 1,
    half            TEXT NOT NULL DEFAULT 'top',  -- 'top' | 'bottom'
    balls           INTEGER NOT NULL DEFAULT 0,   -- 0-3
    strikes         INTEGER NOT NULL DEFAULT 0,    -- 0-2
    outs            INTEGER NOT NULL DEFAULT 0,    -- 0-2
    game_id         TEXT,                          -- for GameChanger integration

    state_version   INTEGER NOT NULL DEFAULT 1,    -- bumped on every state change (for ETag/polling)
    is_active       BOOLEAN NOT NULL DEFAULT true,

    -- GameChanger integration (optional live game sync)
    gc_enabled          BOOLEAN NOT NULL DEFAULT false,
    gc_polling_enabled  BOOLEAN NOT NULL DEFAULT true,  -- pause/resume without disconnecting
    gc_email        TEXT,
    gc_password     TEXT,
    gc_team_name    TEXT,
    gc_team_id      TEXT,
    gc_auth_token   TEXT,
    gc_refresh_token TEXT,
    gc_client_id    TEXT,
    gc_device_id    TEXT,
    gc_status       TEXT NOT NULL DEFAULT 'disconnected',
    gc_last_sync    TIMESTAMPTZ,
    gc_last_error   TEXT,

    -- YouTube Live streaming (Pi streams via ffmpeg → RTMP)
    stream_key          TEXT,                              -- YouTube stream key (per-scoreboard)
    stream_platform     TEXT NOT NULL DEFAULT 'youtube' CHECK (stream_platform IN ('youtube','twitch')),
    twitch_stream_key   TEXT,                              -- Twitch stream key (operator-pasted)
    twitch_channel_name TEXT,                              -- Optional Twitch channel label (display only)
    stream_enabled      BOOLEAN NOT NULL DEFAULT false,    -- user opt-in for streaming
    stream_status       TEXT NOT NULL DEFAULT 'idle',      -- idle | starting | live | stopping | error
    stream_last_error   TEXT,
    stream_started_at   TIMESTAMPTZ,
    stream_rtmp_url     TEXT,                              -- last-used rtmp URL (youtube or twitch ingest)
    stream_mode         TEXT NOT NULL DEFAULT 'youtube',  -- 'youtube' | 'direct'
    stream_resolution   TEXT NOT NULL DEFAULT '720p' CHECK (stream_resolution IN ('720p','1080p')),
    stream_test_pattern BOOLEAN NOT NULL DEFAULT false,   -- when true, Pi pushes ffmpeg testsrc2 instead of camera
    direct_stream_ingest_url TEXT,                        -- RTMP URL the Pi pushes to in direct mode (e.g. rtmp://mac-mini:1935/live)

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup by unique_identifier (scoreboard display polling path)
CREATE INDEX IF NOT EXISTS idx_scoreboards_identifier ON scoreboards(unique_identifier);
CREATE INDEX IF NOT EXISTS idx_scoreboards_active ON scoreboards(is_active) WHERE is_active = true;

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scoreboards_updated ON scoreboards;
CREATE TRIGGER trg_scoreboards_updated BEFORE UPDATE ON scoreboards
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
