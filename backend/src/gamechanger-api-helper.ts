/**
 * GameChanger API Helper — adapted from BaseballScout proven implementation.
 *
 * Handles:
 *   - HMAC request signing for /auth endpoint
 *   - Token refresh with concurrency lock + token rotation
 *   - Data API calls (team search, games, details) with auto-retry on 401
 *
 * DB adapter: uses scoreboard's raw pg query/queryOne helpers.
 * Per-scoreboard (not per-tenancy) — each scoreboard can have its own GC creds.
 */

import * as crypto from 'crypto';
import { queryOne } from './db.js';

/**
 * GameChanger's `/auth` endpoint requires HMAC signing with the web app's
 * static signing credential. This ships in the web.gc.com JS bundle as
 * EDEN_AUTH_CLIENT_KEY. Both values overridable via env in case GC rotates them.
 */
const GC_AUTH_SIGNING_CLIENT_ID =
  process.env.GC_AUTH_SIGNING_CLIENT_ID || '86fdf441-602b-49dc-9c67-f603a07b2fbf';
const GC_AUTH_SIGNING_CLIENT_KEY =
  process.env.GC_AUTH_SIGNING_CLIENT_KEY || 'QWzgAOSZ1vTCmkL033jTvC1zSHoj4jNfDhfmTnJ/t8c=';

const GC_API_BASE = 'https://api.team-manager.gc.com';

export class GameChangerAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'GameChangerAPIError';
  }
}

// ── DB row shape for GC fields ──────────────────────────────────────────

interface GCScoreboardRow {
  id: number;
  gc_device_id: string | null;
  gc_auth_token: string | null;
  gc_refresh_token: string | null;
  gc_client_id: string | null;
}

// ── Token extraction helpers ────────────────────────────────────────────

function extractToken(authToken: string | null): string {
  if (!authToken) throw new GameChangerAPIError('No authentication token available');
  try {
    const tokenObj = JSON.parse(authToken);
    if (tokenObj.access?.data) {
      const tokenData = tokenObj.access.data;
      if (tokenData.includes('%3A') || tokenData.includes('%7C')) return decodeURIComponent(tokenData);
      return tokenData;
    }
  } catch { /* not JSON */ }
  if (authToken.includes('%3A') || authToken.includes('%7C')) return decodeURIComponent(authToken);
  return authToken;
}

function extractRefreshToken(refreshToken: string | null): string {
  if (!refreshToken) throw new GameChangerAPIError('No refresh token available');
  try {
    const tokenObj = JSON.parse(refreshToken);
    if (tokenObj.refresh?.data) {
      const tokenData = tokenObj.refresh.data;
      if (tokenData.includes('%3A') || tokenData.includes('%7C')) return decodeURIComponent(tokenData);
      return tokenData;
    }
  } catch { /* not JSON */ }
  if (refreshToken.includes('%3A') || refreshToken.includes('%7C')) return decodeURIComponent(refreshToken);
  return refreshToken;
}

// ── Credential loading from DB ──────────────────────────────────────────

async function loadCredentials(scoreboardId: number): Promise<{
  deviceId: string;
  authToken: string;
  refreshToken: string | null;
  clientId: string | null;
}> {
  const row = await queryOne<GCScoreboardRow>(
    'SELECT id, gc_device_id, gc_auth_token, gc_refresh_token, gc_client_id FROM scoreboards WHERE id = $1',
    [scoreboardId]
  );
  if (!row) throw new GameChangerAPIError(`Scoreboard not found: ${scoreboardId}`);
  if (!row.gc_device_id || !row.gc_auth_token) {
    throw new GameChangerAPIError('GameChanger credentials not configured for this scoreboard');
  }
  return {
    deviceId: row.gc_device_id,
    authToken: extractToken(row.gc_auth_token),
    refreshToken: row.gc_refresh_token ? extractRefreshToken(row.gc_refresh_token) : null,
    clientId: row.gc_client_id || null,
  };
}

// ── HMAC signing ────────────────────────────────────────────────────────

/**
 * Recursive value flattener mirroring GameChanger's valuesForSigner.
 * Object keys sorted alphabetically, values flattened into a single array.
 */
function valuesForSigner(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesForSigner(v));
  switch (typeof value) {
    case 'object':
      return value
        ? Object.keys(value as Record<string, unknown>)
            .sort()
            .flatMap((k) => valuesForSigner((value as Record<string, unknown>)[k]))
        : ['null'];
    case 'string':
      return [value];
    case 'number':
      return [`${value}`];
    case 'undefined':
      return [];
    default:
      throw new Error(`Unknown type: ${typeof value}`);
  }
}

/**
 * Build HMAC signature headers for /auth endpoint.
 * Returns gc-signature value (`<nonce>.<base64hmac>`) and timestamp.
 */
function signAuthPayload(payload: Record<string, unknown>): {
  signature: string;
  timestamp: number;
} {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(32).toString('base64');
  const values = valuesForSigner(payload);

  const key = Buffer.from(GC_AUTH_SIGNING_CLIENT_KEY, 'base64');
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(Buffer.from(`${timestamp}|`, 'utf8'));
  hmac.update(Buffer.from(nonce, 'base64')); // raw nonce bytes
  hmac.update(Buffer.from('|', 'utf8'));
  hmac.update(Buffer.from(values.join('|'), 'utf8'));
  const sig = hmac.digest('base64');

  return { signature: `${nonce}.${sig}`, timestamp };
}

// ── Token refresh ───────────────────────────────────────────────────────

/** Per-scoreboard refresh lock — prevents concurrent refresh storms */
const refreshInProgress = new Map<number, Promise<string>>();

async function refreshAuthToken(scoreboardId: number): Promise<string> {
  const existing = refreshInProgress.get(scoreboardId);
  if (existing) {
    console.log(`[gc] Refresh already in progress for scoreboard ${scoreboardId} — waiting`);
    return existing;
  }

  const promise = executeRefresh(scoreboardId);
  refreshInProgress.set(scoreboardId, promise);
  try {
    return await promise;
  } finally {
    refreshInProgress.delete(scoreboardId);
  }
}

async function executeRefresh(scoreboardId: number): Promise<string> {
  console.log(`[gc] Refreshing auth token for scoreboard ${scoreboardId}...`);
  const creds = await loadCredentials(scoreboardId);
  if (!creds.refreshToken) {
    throw new GameChangerAPIError('No refresh token available — re-authentication required');
  }

  const requestBody = { type: 'refresh' };
  const { signature, timestamp } = signAuthPayload(requestBody);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Gc-App-Name': 'web',
    'Gc-App-Version': '0.0.0',
    'Gc-Client-Id': GC_AUTH_SIGNING_CLIENT_ID,
    'Gc-Device-Id': creds.deviceId,
    'Gc-Timestamp': `${timestamp}`,
    'Gc-Signature': signature,
    'Gc-Token': creds.refreshToken,
  };

  const response = await fetch(`${GC_API_BASE}/auth`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  let authResponse: unknown;
  try {
    authResponse = JSON.parse(responseText);
  } catch {
    authResponse = responseText;
  }

  if (!response.ok) {
    console.error(`[gc] Token refresh failed: ${response.status}`, authResponse);
    if (response.status === 401 || response.status === 403) {
      // Refresh token revoked/expired — clear stored tokens
      await queryOne(
        `UPDATE scoreboards
         SET gc_auth_token = NULL, gc_refresh_token = NULL,
             gc_status = 'disconnected', gc_last_error = $2
         WHERE id = $1`,
        [scoreboardId, `Refresh failed (${response.status}) — re-login required`]
      );
    }
    throw new GameChangerAPIError(
      `Failed to refresh auth token: ${response.statusText}`,
      response.status,
      authResponse
    );
  }

  const authObj = authResponse as { access?: { data?: string } | string; refresh?: { data?: string } | string };
  const newAccessToken =
    typeof authObj.access === 'object' ? authObj.access?.data : authObj.access;
  if (!newAccessToken) {
    throw new GameChangerAPIError('Invalid refresh response: missing access token');
  }

  console.log(`[gc] Successfully refreshed auth token for scoreboard ${scoreboardId}`);
  const newRefreshToken =
    typeof authObj.refresh === 'object' ? authObj.refresh?.data : authObj.refresh;
  const newRefreshStr =
    typeof newRefreshToken === 'string' ? newRefreshToken : creds.refreshToken;

  await queryOne(
    `UPDATE scoreboards
     SET gc_auth_token = $2,
         gc_refresh_token = $3,
         gc_status = 'connected',
         gc_last_error = NULL,
         gc_last_sync = NOW()
     WHERE id = $1`,
    [scoreboardId, JSON.stringify(authResponse), newRefreshStr]
  );

  return extractToken(JSON.stringify(authResponse));
}

// ── Data API client ─────────────────────────────────────────────────────

export class GC {
  /**
   * Make an authenticated request to the GameChanger data API.
   * Auto-refreshes on 401 and retries once.
   */
  static async makeRequest(
    scoreboardId: number,
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    retryOnAuthFailure = true
  ): Promise<unknown> {
    const creds = await loadCredentials(scoreboardId);

    const headers: Record<string, string> = {
      'Gc-App-Name': 'web',
      'Gc-Device-Id': creds.deviceId,
      'Gc-Token': creds.authToken,
    };
    if (creds.clientId) headers['Gc-Client-Id'] = creds.clientId;
    if (body && method !== 'GET') headers['Content-Type'] = 'application/json';

    const fetchOptions: RequestInit = { method, headers };
    if (body && method !== 'GET') fetchOptions.body = JSON.stringify(body);

    const response = await fetch(url, fetchOptions);
    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (response.status === 401 && retryOnAuthFailure) {
      console.log(`[gc] 401 on ${url} — refreshing token...`);
      const newToken = await refreshAuthToken(scoreboardId);
      headers['Gc-Token'] = newToken;
      return GC.makeRequest(scoreboardId, url, method, body, false);
    }

    if (!response.ok) {
      // Some GC responses come back with status 200 but an error payload in
      // the body — surface those so they're not silently masked.
      const detail =
        responseData && typeof responseData === 'object' && 'error' in (responseData as Record<string, unknown>)
          ? ` body=${JSON.stringify((responseData as Record<string, unknown>).error)}`
          : responseData && typeof responseData !== 'object'
            ? ` body=${String(responseData).slice(0, 200)}`
            : '';
      throw new GameChangerAPIError(
        `GameChanger API request failed: ${response.status} ${response.statusText}${detail}`.trim(),
        response.status,
        responseData
      );
    }

    return responseData;
  }

  // ── Team operations ──────────────────────────────────────────────────

  /** Search teams by name. Returns array of team result objects. */
  static async searchTeams(scoreboardId: number, teamName: string): Promise<unknown[]> {
    const url = `${GC_API_BASE}/search?start_at_page=0`;
    const response = (await GC.makeRequest(scoreboardId, url, 'POST', { name: teamName })) as {
      hits?: Array<{ type: string; result?: unknown }>;
    };
    if (!response?.hits) return [];
    return response.hits
      .filter((hit) => hit.type === 'team' && hit.result)
      .map((hit) => hit.result);
  }

  /** Get all games for a team (includes live/completed/scheduled). */
  static async getTeamGames(scoreboardId: number, teamId: string): Promise<unknown> {
    return GC.makeRequest(scoreboardId, `${GC_API_BASE}/public/teams/${teamId}/games`);
  }

  /** Get detailed game info including scores and status. */
  static async getGameDetails(scoreboardId: number, gameId: string): Promise<unknown> {
    return GC.makeRequest(
      scoreboardId,
      `${GC_API_BASE}/public/game-stream-processing/${gameId}/details?include=line_scores`
    );
  }

  /** Get play-by-play data (includes inning/outs/balls/strikes for live games). */
  static async getPlayByPlay(scoreboardId: number, gameId: string): Promise<unknown> {
    return GC.makeRequest(scoreboardId, `${GC_API_BASE}/game-stream-processing/${gameId}/plays`);
  }
}

// ── Exports for route layer ─────────────────────────────────────────────

export {
  GC_AUTH_SIGNING_CLIENT_ID,
  GC_AUTH_SIGNING_CLIENT_KEY,
  signAuthPayload,
  refreshAuthToken,
  extractToken,
  extractRefreshToken,
};
