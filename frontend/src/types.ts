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

  // Streaming — YouTube and/or Twitch can be configured; streamPlatform
  // picks which one is active.
  streamPlatform: 'youtube' | 'twitch';
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
  // Pi-streamer video encoding settings (see backend migration 002).
  // outputWidth = null means "no scaling — use capture width".
  streamOutputWidth: number | null;
  streamOutputHeight: number | null;
  streamFps: number;
  streamAudioBitrate: string;
}

export type StreamStatus = 'idle' | 'starting' | 'live' | 'stopping' | 'error';

export interface StreamStatusPayload {
  status: StreamStatus;
  lastError: string | null;
  startedAt: string | null;
  rtmpUrl: string | null;
  isConnected: boolean;
  // Active streaming platform (which destination the current/next stream
  // will be pushed to). Added 2026 when the platform selector shipped.
  platform?: 'youtube' | 'twitch';
  // Masked key for the ACTIVE platform only. Other platform's key is
  // exposed on its dedicated settings endpoint, never here.
  streamKeyMasked?: string;
  // Whether the active platform is configured (YouTube = OAuth, Twitch =
  // manual key). Mirrors the per-platform readiness.
  streamEnabled?: boolean;
  testPattern?: boolean;
  // Remote IP:port of the connected Pi socket (if any). Added so the
  // operator UI can show "Pi connected from 192.168.1.205:54321" — lets
  // Steve SSH into the streamer without scanning the LAN when the Pi's
  // IP has changed. null when the Pi is offline.
  piRemoteAddress?: string | null;
  // Persisted Pi encoder settings (see backend migration 002). UI mirrors
  // these in the Video Encoding dropdowns in StreamSettings. Optional
  // because legacy backends don't send it.
  encoding?: {
    outputWidth: number | null;
    outputHeight: number | null;
    fps: number;
    audioBitrate: string;
  };
}

export interface StreamInfo {
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'error';
  mode?: 'youtube' | 'direct';
  // Active streaming platform — 'twitch' is added alongside 'youtube' and
  // 'direct' (the latter is the local ffmpeg HLS path). The watch page
  // picks which embed to render based on this.
  platform?: 'youtube' | 'twitch' | 'direct';
  youtubeWatchUrl?: string | null;
  youtubeEmbedUrl?: string | null;
  directHlsUrl?: string | null;
  // Twitch embed fields. Embed URL is the official player.twitch.tv iframe
  // (no auth needed for public streams). The frontend appends parent= to
  // match its hostname because Twitch's CSP requires it.
  twitchWatchUrl?: string | null;
  twitchEmbedUrl?: string | null;
  twitchChannelName?: string | null;
  startedAt?: string | null;
}

export interface DirectStreamStatus {
  mode: 'youtube' | 'direct';
  active: boolean;
  hlsUrl: string | null;
  ingestUrl: string | null;
  streamKeyMasked: string;
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'error';
  startedAt: string | null;
  isPiConnected: boolean;
  resolution: '720p' | '1080p';
  testPattern?: boolean;
}

export interface DisplayState {
  h: number;
  a: number;
  i: number;
  hf: 't' | 'b';
  b: number;
  s: number;
  o: number;
  r1?: number;  // 1 = runner on first, 0/absent = empty (Pi wire format)
  r2?: number;
  r3?: number;
  bn?: string;  // batter name (empty string when unset)
  bj?: string;  // batter jersey / position number
  pn?: string;  // pitcher name
  pj?: string;  // pitcher jersey / position number
  v: number;
  // Extended fields returned by /api/display/:identifier — used by the
  // public viewer page. Optional because the socket push payload doesn't
  // include them (kept minimal for bandwidth).
  home_team?: string;
  away_team?: string;
  stream?: StreamInfo;
}

export interface CreateScoreboardPayload {
  uniqueIdentifier: string;
  displayName?: string;
  homeTeamName?: string;
  awayTeamName?: string;
}

export interface UpdateStatePayload {
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

export interface UpdateScoreboardPayload {
  uniqueIdentifier?: string;
  displayName?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  gameId?: string | null;
}
