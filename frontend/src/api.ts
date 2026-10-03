import axios from 'axios';
import type {
  Scoreboard,
  CreateScoreboardPayload,
  UpdateStatePayload,
  UpdateScoreboardPayload,
  DisplayState,
  StreamStatusPayload,
} from './types.js';

// Re-exported here so React components can import both the API helpers and
// the payload type from one place (avoids `import type` from two paths).
export type { StreamStatusPayload };

const client = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

export async function listScoreboards(): Promise<Scoreboard[]> {
  const res = await client.get<{ scoreboards: Scoreboard[] }>('/scoreboards');
  return res.data.scoreboards;
}

export async function getScoreboard(id: number): Promise<Scoreboard> {
  const res = await client.get<{ scoreboard: Scoreboard }>(`/scoreboards/${id}`);
  return res.data.scoreboard;
}

export async function createScoreboard(
  payload: CreateScoreboardPayload
): Promise<Scoreboard> {
  const res = await client.post<{ scoreboard: Scoreboard }>('/scoreboards', payload);
  return res.data.scoreboard;
}

export async function updateScoreboardState(
  id: number,
  payload: UpdateStatePayload
): Promise<Scoreboard> {
  const res = await client.put<{ scoreboard: Scoreboard }>(
    `/scoreboards/${id}/state`,
    payload
  );
  return res.data.scoreboard;
}

export async function updateScoreboard(
  id: number,
  payload: UpdateScoreboardPayload
): Promise<Scoreboard> {
  const res = await client.put<{ scoreboard: Scoreboard }>(
    `/scoreboards/${id}`,
    payload
  );
  return res.data.scoreboard;
}

export async function deleteScoreboard(id: number): Promise<void> {
  await client.delete(`/scoreboards/${id}`);
}

// ── GameChanger integration ────────────────────────────────────────────

export interface GCStatus {
  enabled: boolean;
  pollingEnabled?: boolean;
  connected: boolean;
  canReachApi?: boolean;
  status: string; // 'connected' | 'disconnected' | 'error' | 'pending_login' | 'disabled'
  email?: string;
  teamName?: string;
  teamId?: string;
  lastSync?: string | null;
  lastError?: string | null;
}

export async function gcConfigure(
  id: number,
  payload: { email: string; password: string; teamName: string }
): Promise<void> {
  await client.post(`/scoreboards/${id}/gc/configure`, payload);
}

export async function gcLogin(
  id: number,
  password?: string
): Promise<{ success: boolean; requiresVerificationCode?: boolean; connected?: boolean; message?: string }> {
  const res = await client.post(`/scoreboards/${id}/gc/login`, password ? { password } : {});
  return res.data;
}

export async function gcVerify(
  id: number,
  verificationCode: string
): Promise<{ success: boolean; connected?: boolean; message?: string }> {
  const res = await client.post(`/scoreboards/${id}/gc/verify`, { verificationCode });
  return res.data;
}

export async function gcStatus(id: number): Promise<GCStatus> {
  const res = await client.get<GCStatus>(`/scoreboards/${id}/gc/status`);
  return res.data;
}

/**
 * Toggle live polling on/off without disconnecting from GameChanger.
 * Useful to pause API usage when no game is active.
 */
export async function gcTogglePolling(
  id: number,
  enabled: boolean
): Promise<{ success: boolean; pollingEnabled: boolean }> {
  const res = await client.post<{ success: boolean; pollingEnabled: boolean }>(
    `/scoreboards/${id}/gc/toggle-polling`,
    { enabled }
  );
  return res.data;
}

export async function gcSearchTeam(
  id: number,
  teamName?: string
): Promise<{ teams: Array<{ id: string; name: string }>; count: number }> {
  const res = await client.post(`/scoreboards/${id}/gc/search-team`, teamName ? { teamName } : {});
  return res.data;
}

/**
 * Search GameChanger for a team by name and auto-link it.
 *
 * Possible responses from the backend:
 *   { matched: true, teamId, teamName, season?, location?, players? }
 *     → exactly one team matched, polling has been enabled
 *   { matched: 'multiple', query, teams: [...] }
 *     → multiple matches, frontend should show a picker
 *   { matched: false, query }
 *     → no matches
 */
export type GCLinkByNameResult =
  | { matched: true; teamId: string; teamName: string; season: string | null; location: string | null; players: number | null }
  | { matched: 'multiple'; query: string; teams: Array<{ id: string; name: string; season: string | null; location: string | null; players: number | null }> }
  | { matched: false; query: string };

export async function gcLinkTeamByName(id: number, teamName: string): Promise<GCLinkByNameResult> {
  const res = await client.post<GCLinkByNameResult>(`/scoreboards/${id}/gc/link-team-by-name`, { teamName });
  return res.data;
}

export async function gcLinkTeam(id: number, teamId: string, teamName?: string): Promise<void> {
  await client.post(`/scoreboards/${id}/gc/link-team`, { teamId, teamName });
}

export interface GCRefreshGameResult {
  success: boolean;
  picked: { id: string; status: string | null; startTs: string | null; reason: 'live' | 'most-recent' } | null;
  totalGames: number;
  message: string;
}

/**
 * Force an immediate games-list refresh and re-pick the live or most
 * recent game for the linked team. The poller's cache is invalidated,
 * so the next poll tick (~1s when live, ~5s when idle) will sync the
 * new game's state.
 */
export async function gcRefreshGame(id: number): Promise<GCRefreshGameResult> {
  const res = await client.post<GCRefreshGameResult>(`/scoreboards/${id}/gc/refresh-game`);
  return res.data;
}

export async function gcDisable(id: number): Promise<void> {
  await client.post(`/scoreboards/${id}/gc/disable`);
}

// ── YouTube Live streaming ──────────────────────────────────────────────

/**
 * Fetch current stream status (status, last error, started-at, RTMP URL).
 * Cheap query — safe to poll as a fallback.
 */
export async function streamStatus(id: number): Promise<StreamStatusPayload> {
  const res = await client.get<StreamStatusPayload>(`/scoreboards/${id}/stream/status`);
  return res.data;
}

/**
 * Save the YouTube stream key (legacy/manual flow). Deprecated — the OAuth
 * flow in /api/auth/youtube/start replaces this. Kept for backward compat
 * with any scoreboards that have a manually-pasted key in the DB.
 */
export async function updateStreamKey(
  id: number,
  payload: { streamKey?: string; rtmpUrl?: string | null }
): Promise<StreamStatusPayload> {
  const res = await client.put<StreamStatusPayload>(`/scoreboards/${id}/stream/key`, payload);
  return res.data;
}

/**
 * Save the Twitch stream key (operator-pasted from their Twitch dashboard).
 * Pass streamKey='' to clear. The full key is persisted to DB but never
 * echoed back — only a masked version is returned on subsequent /status calls
 * (and only when Twitch is the active platform).
 *
 * `channelName` is the actual Twitch LOGIN (the lowercase username that
 * appears after twitch.tv/ in your channel URL), NOT a display name.
 * Twitch requires this format — anything else 404s the embed. The backend
 * normalises to lowercase and validates the format.
 */
export async function updateTwitchStreamKey(
  id: number,
  payload: { streamKey?: string; channelName?: string | null }
): Promise<StreamStatusPayload & { twitchChannelName?: string | null }> {
  const res = await client.put(`/scoreboards/${id}/stream/twitch/key`, payload);
  return res.data;
}

/**
 * Switch which platform is the active streaming destination. Refuses while
 * a stream is starting/live — operator must Stop first. Also refuses if
 * the requested platform has no credentials configured (returns a friendly
 * error message guiding the operator to Settings).
 */
export async function setStreamPlatform(
  id: number,
  platform: 'youtube' | 'twitch'
): Promise<StreamStatusPayload> {
  const res = await client.put<StreamStatusPayload>(`/scoreboards/${id}/stream/platform`, { platform });
  return res.data;
}

/**
 * Check if a scoreboard has a YouTube account connected via OAuth.
 */
export async function youtubeStatus(id: number): Promise<{
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  email: string | null;
  tokenExpiresAt: string | null;
}> {
  const res = await client.get(`/scoreboards/${id}/youtube/status`);
  return res.data;
}

/**
 * Disconnect (revoke) the YouTube account linked to a scoreboard.
 */
export async function youtubeDisconnect(id: number): Promise<{ success: boolean }> {
  const res = await client.delete(`/scoreboards/${id}/youtube/disconnect`);
  return res.data;
}

/**
 * Start streaming on the Pi. Backend emits stream:cmd over the socket to
 * the Pi, which will start ffmpeg and respond with stream:status events.
 *
 * Pass `{ testPattern: true }` to push ffmpeg's testsrc2 filter instead of
 * camera frames — useful for setup/testing when the camera isn't connected.
 */
export async function streamStart(
  id: number,
  opts: { testPattern?: boolean; title?: string; description?: string } = {}
): Promise<{ success: boolean; status: string; rtmpUrl?: string; isConnected: boolean; platform?: 'youtube' | 'twitch' }> {
  // Only include testPattern in the body when explicitly provided.
  // Omitting it lets the backend fall back to the persisted setting
  // (set via Settings → Test Pattern).
  const body: Record<string, unknown> = {};
  if (opts.testPattern !== undefined) body.testPattern = opts.testPattern;
  if (opts.title) body.title = opts.title;
  if (opts.description) body.description = opts.description;
  const res = await client.post(`/scoreboards/${id}/stream/start`, body);
  return res.data;
}

/**
 * Stop streaming. Sends stream:cmd over the socket to the Pi.
 */
export async function streamStop(id: number): Promise<{ success: boolean; status: string; piConnected: boolean }> {
  const res = await client.post(`/scoreboards/${id}/stream/stop`);
  return res.data;
}

/**
 * Hard-reset the stream state for a scoreboard. Cross-mode — works for
 * youtube, twitch, and direct. Recovers from wedged 'starting' /
 * 'stopping' / 'error' states by killing the Mac-side listener (if direct),
 * telling the Pi to reset, and forcing the DB row to idle.
 *
 * The operator should click Reset when /stream/start refuses with
 * "Stream already starting" or "Stream already stopping" but nothing is
 * actually running. Refuses to be called when a fresh Start would
 * already succeed (i.e. status === 'idle').
 */
export async function streamReset(
  id: number
): Promise<{
  success: boolean;
  status: string;
  previousStatus: string;
  platform: string;
  mode: string;
}> {
  const res = await client.post(`/scoreboards/${id}/stream/reset`);
  return res.data;
}

/**
 * Persist the test-pattern setting for a scoreboard. When true, the Pi
 * pushes ffmpeg's testsrc2 filter to the RTMP endpoint instead of camera
 * frames. This is the default for the next Start Stream call; the body
 * of /stream/start can still override it on a per-call basis.
 */
export async function setStreamTestPattern(id: number, enabled: boolean): Promise<StreamStatusPayload> {
  const res = await client.put<StreamStatusPayload>(`/scoreboards/${id}/stream/test-pattern`, { enabled });
  return res.data;
}

/**
 * Persist Pi encoder settings. Body fields are all optional — backend
 * accepts partial updates (e.g. change just fps without touching output
 * dims). Forwarded to the Pi as CLI args on the NEXT Start Stream call —
 * operator must Stop + Start to apply mid-stream.
 *
 * `outputWidth`/`outputHeight`: null = no scaling (use capture size).
 *   Backend enforces the (null, null) / (480, 360) / (320, 240) presets —
 *   sending arbitrary dimensions 400s.
 */
export async function setStreamEncoding(
  id: number,
  payload: {
    outputWidth?: number | null;
    outputHeight?: number | null;
    fps?: number;
    audioBitrate?: string;
  }
): Promise<StreamStatusPayload> {
  const res = await client.put<StreamStatusPayload>(`/scoreboards/${id}/stream/encoding`, payload);
  return res.data;
}

// ── Direct HLS streaming ──────────────────────────────────────────────

/**
 * Get current direct HLS stream status (m3u8 URL, RTMP ingest URL, etc).
 */
export async function directStreamStatus(id: number): Promise<import('./types.js').DirectStreamStatus> {
  const res = await client.get<import('./types.js').DirectStreamStatus>(`/scoreboards/${id}/stream/direct/status`);
  return res.data;
}

/**
 * Start direct HLS stream. Spawns a local ffmpeg listener on the Mac mini.
 * Returns the RTMP URL the Pi should push to, plus the resolution used.
 */
export async function directStreamStart(
  id: number,
  resolution?: '720p' | '1080p'
): Promise<{
  success: boolean;
  status: string;
  rtmpUrl: string;
  hlsUrl: string;
  streamKey: string;
  ingestHost: string;
  resolution: string;
}> {
  const res = await client.post(`/scoreboards/${id}/stream/direct/start`, { resolution });
  return res.data;
}

/**
 * Stop direct HLS stream. Kills the local ffmpeg listener.
 */
export async function directStreamStop(id: number): Promise<{ success: boolean; status: string }> {
  const res = await client.post(`/scoreboards/${id}/stream/direct/stop`);
  return res.data;
}

/**
 * Switch stream mode between 'youtube' and 'direct'. Optionally set the
 * RTMP ingest URL the Pi should push to in direct mode and the resolution.
 */
export async function setStreamMode(
  id: number,
  mode: 'youtube' | 'direct',
  ingestUrl?: string | null,
  resolution?: '720p' | '1080p'
): Promise<{ success: boolean; mode: string; ingestUrl: string | null; streamKeyMasked: string; resolution: string }> {
  const res = await client.put(`/scoreboards/${id}/stream/mode`, { mode, ingestUrl, resolution });
  return res.data;
}

export function displayUrl(uniqueIdentifier: string): string {
  // Use relative path so it works through tunnels/proxies without
  // needing to know the host. The Vite dev proxy forwards /display
  // to the backend, and through a Cloudflare Tunnel the single
  // hostname handles both frontend and proxied backend routes.
  return `${window.location.origin}/display/${uniqueIdentifier}`;
}

/**
 * Public watch page URL — what the operator pastes into a messenger
 * so others can view the scoreboard live. Same host as displayUrl
 * but routes to the React app's PublicScoreboard component instead
 * of the JSON API.
 */
export function watchUrl(uniqueIdentifier: string): string {
  return `${window.location.origin}/watch/${uniqueIdentifier}`;
}

/**
 * Fetch compact display state for a scoreboard by identifier.
 * Used by the public viewer page (no auth required) and as a polling
 * fallback when the WebSocket drops.
 */
export async function fetchDisplayState(uniqueIdentifier: string): Promise<DisplayState> {
  const res = await fetch(displayUrl(uniqueIdentifier));
  if (!res.ok) throw new Error(`display fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Look up a scoreboard's numeric id by its public identifier. Used by the
 * viewer page so it can subscribe to the right socket.io room.
 * Returns null if the scoreboard doesn't exist or is inactive.
 */
export async function lookupScoreboardIdByIdentifier(
  uniqueIdentifier: string
): Promise<number | null> {
  try {
    const res = await client.get<{ scoreboards: Scoreboard[] }>('/scoreboards');
    const sb = (res.data.scoreboards ?? []).find(
      (s) => s.uniqueIdentifier === uniqueIdentifier && s.isActive
    );
    return sb?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask the backend to send a `led:refresh` socket event to the Pi running this
 * scoreboard. The Pi re-initializes its MAX7219 8x8 chain and gpiozero
 * indicator LEDs without restarting the service — same visual outcome as a
 * reboot, but faster and without dropping the WebSocket.
 *
 * Returns the API response payload (success, requestedAt, etc.) and throws
 * on HTTP failure so the caller can show an error toast.
 */
export async function refreshLeds(
  scoreboardId: number,
  requestedBy?: string
): Promise<{ success: boolean; scoreboardId: number; requestedAt: string }> {
  const res = await client.post<{
    success: boolean;
    scoreboardId: number;
    requestedAt: string;
  }>(`/scoreboards/${scoreboardId}/led-refresh`, requestedBy ? { requestedBy } : {});
  return res.data;
}
