// ── Streaming platform ────────────────────────────────────────────────────
// Two RTMP destinations are supported. The active target is selected by
// streamPlatform; both can be configured simultaneously so the operator
// can swap mid-game (e.g. YouTube primary, Twitch backup).
export type StreamPlatform = 'youtube' | 'twitch';

/** RTMP ingest URLs per platform — used by stream.ts to build the stream:cmd. */
export const STREAM_INGEST_URLS: Record<StreamPlatform, string> = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  twitch: 'rtmp://live.twitch.tv/app',
};

export interface Scoreboard {
  id: number;
  uniqueIdentifier: string;
  displayName: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  inning: number;
  half: 'top' | 'bottom';
  balls: number;
  strikes: number;
  outs: number;
  runnerOnFirst: boolean;
  runnerOnSecond: boolean;
  runnerOnThird: boolean;
  batterName: string;
  batterNumber: string;
  pitcherName: string;
  pitcherNumber: string;
  gameId: string | null;
  stateVersion: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;

  // Streaming — both YouTube and Twitch are configurable; streamPlatform
  // picks which one is active. streamKeyMasked + twitchStreamKeyMasked are
  // both exposed so the Settings UI can show what's configured for each.
  streamPlatform: StreamPlatform;
  // YouTube (OAuth-driven; streamKeyMasked reflects the current broadcast's
  // stream name when a broadcast is active, otherwise the channel-level key)
  streamKeyMasked?: string;
  // Twitch (manual key paste)
  twitchStreamKeyMasked?: string;
  twitchChannelName: string | null;
  streamEnabled: boolean;
  streamStatus: 'idle' | 'starting' | 'live' | 'stopping' | 'error';
  streamLastError: string | null;
  streamStartedAt: string | null;
  streamRtmpUrl: string | null;
  streamMode: 'youtube' | 'direct';
  directStreamIngestUrl: string | null;
  streamResolution: '720p' | '1080p';
  // Pi-streamer video encoding settings (see migration 002).
  // outputWidth = null means "no scaling — use capture width".
  streamOutputWidth: number | null;
  streamOutputHeight: number | null;
  streamFps: number;
  streamAudioBitrate: string;
  // A/V tuning knobs (see migration 004). Gain is applied by the
  // Pi's ffmpeg audio chain on the next Start; brightness/contrast
  // are UVC percentages (0..200, 100 = neutral) applied live via
  // camera_tune AND on the next Start. null = camera default.
  streamAudioGainDb: number;
  streamCameraBrightness: number | null;
  streamCameraContrast: number | null;
  // Team whose GameChanger stream is being polled — the "home" team for
  // viewer-facing highlights. Set on the scoreboard row when GC is
  // connected; null otherwise.
  gcTeamName: string | null;
}

export type StreamStatus = 'idle' | 'starting' | 'live' | 'stopping' | 'error';

export interface StreamStatusPayload {
  status: StreamStatus;
  lastError: string | null;
  startedAt: string | null;
  rtmpUrl: string | null;
  isConnected: boolean;
  // Active streaming platform. Lets the UI show which destination the
  // current stream is going to. Falls back to 'youtube' for legacy clients.
  platform?: StreamPlatform;
  // Masked key of the active platform's stream key (the OTHER platform's
  // key is exposed on the Settings endpoint only, not in poll responses).
  streamKeyMasked?: string;
  // Whether the active platform is configured (YouTube = OAuth, Twitch =
  // manual key). Mirrors streamEnabled semantically but per-platform.
  streamEnabled?: boolean;
  // Mirrors the persisted encoding settings so the StreamSettings
  // UI can read them without a second DB round-trip. Optional
  // because legacy clients may not send it.
  encoding?: StreamEncodingSettings;
}

/**
 * Video + audio encoding settings for the Pi streamer. Mirrors the
 * `stream_output_width` / `_output_height` / `_fps` / `_audio_bitrate`
 * columns. Forwarded to the Pi as `--output-width` / `--output-height`
 * / `--fps` / `--audio-bitrate` CLI args on every Start Stream.
 *
 * `outputWidth`/`outputHeight` are null when the operator picked
 * "Source (no scaling)" — capture size == output size. The Pi's
 * FFmpegStreamer defaults pick this up by passing through width/height
 * when output dims are null.
 */
export interface StreamEncodingSettings {
  outputWidth: number | null;
  outputHeight: number | null;
  fps: number;
  audioBitrate: string;
  // A/V tuning knobs (migration 004). audioGainDb: ffmpeg volume
  // filter gain, -10..30 dB (applies on next Start). cameraBrightness
  // / cameraContrast: UVC 0..200 with 100 neutral, null = camera
  // default (applies live via camera-tune + on next Start).
  audioGainDb: number;
  cameraBrightness: number | null;
  cameraContrast: number | null;
}

export interface DisplayState {
  h: number;
  a: number;
  i: number;
  hf: 't' | 'b';
  b: number;
  s: number;
  o: number;
  v: number;
}

export interface ScoreboardRow {
  id: number;
  unique_identifier: string;
  display_name: string;
  home_team_name: string;
  away_team_name: string;
  home_score: number;
  away_score: number;
  inning: number;
  half: 'top' | 'bottom';
  balls: number;
  strikes: number;
  outs: number;
  runner_on_first: boolean;
  runner_on_second: boolean;
  runner_on_third: boolean;
  batter_name: string;
  batter_number: string;
  pitcher_name: string;
  pitcher_number: string;
  game_id: string | null;
  state_version: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  stream_key: string | null;
  stream_platform: 'youtube' | 'twitch';
  twitch_stream_key: string | null;
  twitch_channel_name: string | null;
  stream_enabled: boolean;
  stream_status: string;
  stream_last_error: string | null;
  stream_started_at: Date | null;
  stream_rtmp_url: string | null;
  stream_mode: 'youtube' | 'direct';
  direct_stream_ingest_url: string | null;
  stream_resolution: '720p' | '1080p';
  // Pi-streamer video encoding knobs (see backend migration 002).
  // NULL output dims = "use capture size, no scaling" — the
  // stream_scoreboard.py defaults pick this up automatically.
  stream_output_width: number | null;
  stream_output_height: number | null;
  stream_fps: number;
  stream_audio_bitrate: string;
  // A/V tuning knobs (see backend migration 004).
  stream_audio_gain_db: number;
  stream_camera_brightness: number | null;
  stream_camera_contrast: number | null;
  // Team whose GameChanger stream is being polled — highlighted in the
  // viewer overlay as the "home side" for the local audience. Not used
  // by the editor UI; only relevant to the Pi streamer + watch page so
  // spectators can see which team is "ours".
  gc_team_name: string | null;
}

export interface CreateScoreboardInput {
  uniqueIdentifier: string;
  displayName?: string;
  homeTeamName?: string;
  awayTeamName?: string;
}

export interface UpdateStateInput {
  homeScore?: number;
  awayScore?: number;
  inning?: number;
  half?: 'top' | 'bottom';
  balls?: number;
  strikes?: number;
  outs?: number;
  runnerOnFirst?: boolean;
  runnerOnSecond?: boolean;
  runnerOnThird?: boolean;
  batterName?: string;
  batterNumber?: string;
  pitcherName?: string;
  pitcherNumber?: string;
  gameId?: string | null;
}

export interface UpdateScoreboardInput {
  uniqueIdentifier?: string;
  displayName?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  gameId?: string | null;
}

export function mapRowToScoreboard(row: ScoreboardRow): Scoreboard {
  return {
    id: row.id,
    uniqueIdentifier: row.unique_identifier,
    displayName: row.display_name,
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
    homeScore: row.home_score,
    awayScore: row.away_score,
    inning: row.inning,
    half: row.half,
    balls: row.balls,
    strikes: row.strikes,
    outs: row.outs,
    runnerOnFirst: row.runner_on_first,
    runnerOnSecond: row.runner_on_second,
    runnerOnThird: row.runner_on_third,
    batterName: row.batter_name,
    batterNumber: row.batter_number,
    pitcherName: row.pitcher_name,
    pitcherNumber: row.pitcher_number,
    gameId: row.game_id,
    stateVersion: row.state_version,
    isActive: row.is_active,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    streamKeyMasked: row.stream_key ? maskStreamKey(row.stream_key) : undefined,
    streamPlatform: (row.stream_platform as 'youtube' | 'twitch') || 'youtube',
    twitchStreamKeyMasked: row.twitch_stream_key ? maskStreamKey(row.twitch_stream_key) : undefined,
    twitchChannelName: row.twitch_channel_name,
    streamEnabled: row.stream_enabled,
    streamStatus: (row.stream_status as Scoreboard['streamStatus']) || 'idle',
    streamLastError: row.stream_last_error,
    streamStartedAt:
      row.stream_started_at instanceof Date
        ? row.stream_started_at.toISOString()
        : row.stream_started_at
          ? String(row.stream_started_at)
          : null,
    streamRtmpUrl: row.stream_rtmp_url,
    streamMode: (row.stream_mode as 'youtube' | 'direct') || 'youtube',
    directStreamIngestUrl: row.direct_stream_ingest_url,
    streamResolution: (row.stream_resolution as '720p' | '1080p') || '720p',
    streamOutputWidth: row.stream_output_width ?? null,
    streamOutputHeight: row.stream_output_height ?? null,
    streamFps: row.stream_fps ?? 30,
    streamAudioBitrate: row.stream_audio_bitrate ?? '64k',
    streamAudioGainDb: row.stream_audio_gain_db ?? 10,
    streamCameraBrightness: row.stream_camera_brightness ?? null,
    streamCameraContrast: row.stream_camera_contrast ?? null,
    gcTeamName: row.gc_team_name ?? null,
  };
}

/** Return only the last 4 chars of a stream key, prefixed with "****" for masking. */
export function maskStreamKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  return `****${key.slice(-4)}`;
}
