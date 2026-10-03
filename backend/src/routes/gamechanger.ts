/**
 * GameChanger Integration Routes
 *
 *   POST   /api/scoreboards/:id/gc/configure       — enable + save creds + team name
 *   POST   /api/scoreboards/:id/gc/login           — start Selenium login (may require 2FA)
 *   POST   /api/scoreboards/:id/gc/verify          — submit 2FA code to complete login
 *   GET    /api/scoreboards/:id/gc/status          — connection status
 *   POST   /api/scoreboards/:id/gc/search-team     — search teams by name (post-login)
 *   POST   /api/scoreboards/:id/gc/link-team       — link a team to this scoreboard
 *   POST   /api/scoreboards/:id/gc/refresh-game    — re-fetch games list & pick live/most-recent
 *   POST   /api/scoreboards/:id/gc/toggle-polling  — pause/resume live polling
 *   POST   /api/scoreboards/:id/gc/disable         — disable GC sync + clear tokens
 *
 * Active Selenium sessions (for 2FA continuation) are held in-memory keyed by scoreboard ID.
 */

import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db.js';
import { getPoolStats } from '../db.js';
import { GameChangerSession } from '../gamechanger-session.js';
import { GC } from '../gamechanger-api-helper.js';
import { getDiagnostics, invalidateGameCache, isDiagEnabled } from '../gamechanger-poller.js';

export const gamechangerRouter = Router();

// ── In-memory session store for 2FA continuation ────────────────────────
// Keyed by scoreboardId. Sessions expire after 10 minutes.
interface PendingSession {
  session: GameChangerSession;
  email: string;
  createdAt: number;
}
const pendingSessions = new Map<number, PendingSession>();

const SESSION_TTL_MS = 10 * 60 * 1000;

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingSessions.entries()) {
    if (now - pending.createdAt > SESSION_TTL_MS) {
      pending.session.close().catch(() => {});
      pendingSessions.delete(id);
      console.log(`[gc] expired pending session for scoreboard ${id}`);
    }
  }
}, 60_000).unref();

// ── Routes ───────────────────────────────────────────────────────────────

/**
 * Configure GameChanger integration for a scoreboard.
 * Saves credentials + team name, marks as enabled.
 * Does NOT perform login — call /gc/login separately.
 */
gamechangerRouter.post('/:id/gc/configure', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }
    const { email, password, teamName } = req.body ?? {};
    if (!email || !password || !teamName) {
      return res.status(400).json({ error: 'email, password, and teamName required' });
    }

    await queryOne(
      `UPDATE scoreboards
       SET gc_enabled = true,
           gc_email = $2,
           gc_password = $3,
           gc_team_name = $4,
           gc_status = 'configured',
           gc_last_error = NULL
       WHERE id = $1`,
      [id, email, password, teamName]
    );
    res.json({ success: true, message: 'GameChanger configured. Call /gc/login to connect.' });
  } catch (err) {
    console.error('[gc] configure error:', err);
    res.status(500).json({ error: 'Failed to configure GameChanger' });
  }
});

/**
 * Start GameChanger login via Selenium.
 * If 2FA is required, returns requiresVerificationCode: true and holds the
 * browser session open for /gc/verify.
 */
gamechangerRouter.post('/:id/gc/login', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const board = await queryOne<{
      gc_email: string;
      gc_password: string;
    }>(
      'SELECT gc_email, gc_password FROM scoreboards WHERE id = $1',
      [id]
    );
    if (!board?.gc_email || !board?.gc_password) {
      return res.status(400).json({ error: 'GameChanger not configured for this scoreboard' });
    }

    // Close any existing pending session
    const existing = pendingSessions.get(id);
    if (existing) {
      await existing.session.close().catch(() => {});
      pendingSessions.delete(id);
    }

    // Construct the session with credentials (the constructor builds the
    // stable deviceId from credentials.email). Then init() boots the headless
    // browser and login() performs the GC auth flow.
    const session = new GameChangerSession({
      email: board.gc_email,
      password: board.gc_password,
    });
    await session.init();

    // login() throws VERIFICATION_CODE_REQUIRED if GC needs a 2FA code. We
    // catch that case and route to the verify endpoint — it is NOT a failure.
    let needs2FA = false;
    try {
      await session.login();
    } catch (err) {
      if (err instanceof Error && err.name === 'VERIFICATION_CODE_REQUIRED') {
        needs2FA = true;
      } else {
        throw err; // genuine login failure — bubble up to catch block
      }
    }

    if (needs2FA || session.requires2FA) {
      pendingSessions.set(id, {
        session,
        email: board.gc_email,
        createdAt: Date.now(),
      });
      return res.json({
        success: true,
        requiresVerificationCode: true,
        message: 'Check your email for the verification code, then submit it via /gc/verify',
      });
    }

    // No 2FA — tokens were already captured during login() → waitForLoginSuccess().
    const auth = session.getAuth();
    await session.close().catch(() => {});
    if (!auth) {
      return res.status(500).json({ error: 'Login succeeded but failed to capture auth tokens' });
    }

    await queryOne(
      `UPDATE scoreboards
       SET gc_auth_token = $2,
           gc_refresh_token = $3,
           gc_client_id = $4,
           gc_device_id = $5,
           gc_status = 'connected',
           gc_last_error = NULL
       WHERE id = $1`,
      [id, auth.authToken, auth.refreshToken, auth.clientId, auth.deviceId]
    );
    await session.close();
    res.json({ success: true, connected: true, message: 'Login successful' });
  } catch (err) {
    console.error('[gc] login error:', err);
    await queryOne(
      'UPDATE scoreboards SET gc_status = $2, gc_last_error = $3 WHERE id = $1',
      [Number(req.params.id), 'error', err instanceof Error ? err.message : String(err)]
    );
    res.status(500).json({ error: 'Login failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Submit 2FA verification code to complete a pending login.
 */
gamechangerRouter.post('/:id/gc/verify', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { verificationCode } = req.body ?? {};
    if (!verificationCode || typeof verificationCode !== 'string') {
      return res.status(400).json({ error: 'verificationCode required' });
    }

    const pending = pendingSessions.get(id);
    if (!pending) {
      return res.status(400).json({ error: 'No pending login session. Call /gc/login first.' });
    }

    // Inject the code into the session so continue2FA() picks it up, then
    // wait for the browser flow to complete and tokens to be captured.
    pending.session.credentials.verificationCode = verificationCode;
    await pending.session.continue2FA();
    const auth = pending.session.getAuth();
    await pending.session.close().catch(() => {});
    pendingSessions.delete(id);

    if (!auth) {
      return res.status(500).json({ error: '2FA succeeded but failed to capture auth tokens' });
    }

    await queryOne(
      `UPDATE scoreboards
       SET gc_auth_token = $2,
           gc_refresh_token = $3,
           gc_client_id = $4,
           gc_device_id = $5,
           gc_status = 'connected',
           gc_last_error = NULL
       WHERE id = $1`,
      [id, auth.authToken, auth.refreshToken, auth.clientId, auth.deviceId]
    );
    res.json({ success: true, connected: true, message: 'Login successful' });
  } catch (err) {
    console.error('[gc] verify error:', err);
    res.status(500).json({ error: 'Verification failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Get GameChanger connection status.
 * Performs a live "canary" API call to verify the connection actually works.
 */
gamechangerRouter.get('/:id/gc/status', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const board = await queryOne<{
      gc_enabled: boolean;
      gc_polling_enabled: boolean;
      gc_status: string;
      gc_email: string;
      gc_team_id: string;
      gc_team_name: string;
      gc_last_sync: Date;
      gc_last_error: string;
    }>(
      `SELECT gc_enabled, gc_polling_enabled, gc_status, gc_email, gc_team_id, gc_team_name,
              gc_last_sync, gc_last_error
       FROM scoreboards WHERE id = $1`,
      [id]
    );
    if (!board) return res.status(404).json({ error: 'Scoreboard not found' });

    let canReach = false;
    if (board.gc_status === 'connected' && board.gc_team_id) {
      try {
        await GC.getTeamGames(id, board.gc_team_id);
        canReach = true;
      } catch (err) {
        canReach = false;
      }
    }

    res.json({
      enabled: board.gc_enabled,
      pollingEnabled: board.gc_polling_enabled,
      // `connected` mirrors canReachApi — the frontend gates polling toggle
      // and Change Team on status?.connected, so we always include it.
      connected: canReach,
      status: board.gc_status,
      canReachApi: canReach,
      email: board.gc_email,
      teamId: board.gc_team_id,
      teamName: board.gc_team_name,
      lastSync: board.gc_last_sync,
      lastError: board.gc_last_error,
    });
  } catch (err) {
    console.error('[gc] status error:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * Search teams by name. Returns candidate list.
 * Used after login to let the user pick the right team if auto-match is ambiguous.
 */
gamechangerRouter.post('/:id/gc/search-team', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { teamName } = req.body ?? {};
    if (!teamName || typeof teamName !== 'string') {
      return res.status(400).json({ error: 'teamName required' });
    }

    const results = await GC.searchTeams(id, teamName);
    res.json({ teams: results });
  } catch (err) {
    console.error('[gc] search-team error:', err);
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('401') ? 401 : 500;
    res.status(status).json({ error: 'Search failed', detail: message });
  }
});

/**
 * Search teams by name and link to the scoreboard.
 *
 * Accepts { teamName } and:
 *  - Returns { matched: true, teamId, teamName } if exactly one result → UI auto-links
 *  - Returns { matched: 'multiple', teams: [...] } if multiple → UI shows picker
 *  - Returns { matched: false } if no results → UI shows error
 *
 * When exactly one result is found we auto-link it AND enable polling,
 * so the user gets a one-click experience for unambiguous searches.
 */
gamechangerRouter.post('/:id/gc/link-team-by-name', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { teamName } = req.body ?? {};
    if (!teamName || typeof teamName !== 'string') {
      return res.status(400).json({ error: 'teamName required' });
    }

    const teams = (await GC.searchTeams(id, teamName)) as Array<{
      id: string;
      public_id: string;
      name: string;
      season?: { name?: string; year?: number };
      location?: { city?: string; state?: string; country?: string };
      number_of_players?: number;
    }>;

    if (!teams || teams.length === 0) {
      return res.json({ matched: false, query: teamName });
    }

    if (teams.length === 1) {
      const team = teams[0];
      // Store the public_id, not the internal UUID — GameChanger's public API
      // expects the 12-char slug in URL paths (e.g. /teams/WC0c0MdfH8eC/games).
      const slug = team.public_id || team.id;
      await queryOne(
        `UPDATE scoreboards
         SET gc_team_id = $2,
             gc_team_name = $3,
             gc_polling_enabled = true,
             gc_last_error = NULL,
             game_id = NULL,
             gc_last_sync = NULL
         WHERE id = $1`,
        [id, slug, team.name]
      );
      // Force the next poll tick to re-fetch the games list for the
      // newly linked team instead of continuing to poll the old team's
      // cached gameId.
      invalidateGameCache(id);
      console.log(`[gc] scoreboard ${id} auto-linked to team "${team.name}" (${slug})`);
      return res.json({
        matched: true,
        teamId: slug,
        teamName: team.name,
        season: team.season ? `${team.season.name ?? ''} ${team.season.year ?? ''}`.trim() : null,
        location: team.location
          ? [team.location.city, team.location.state, team.location.country]
              .filter(Boolean)
              .join(', ')
          : null,
        players: team.number_of_players ?? null,
      });
    }

    // Multiple matches — let the user pick
    return res.json({
      matched: 'multiple',
      query: teamName,
      teams: teams.map((t) => ({
        // Expose public_id as the id we send back to the frontend for linking.
        // GC's public API URL paths use the public_id slug, not the internal UUID.
        id: t.public_id || t.id,
        public_id: t.public_id,
        name: t.name,
        season: t.season ? `${t.season.name ?? ''} ${t.season.year ?? ''}`.trim() : null,
        location: t.location
          ? [t.location.city, t.location.state, t.location.country].filter(Boolean).join(', ')
          : null,
        players: t.number_of_players ?? null,
      })),
    });
  } catch (err) {
    console.error('[gc] link-team-by-name error:', err);
    res.status(500).json({ error: 'Failed to search teams' });
  }
});

/**
 * Link a specific team to this scoreboard (after search-team returns candidates).
 */
gamechangerRouter.post('/:id/gc/link-team', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { teamId, teamName } = req.body ?? {};
    if (!teamId || !teamName) {
      return res.status(400).json({ error: 'teamId and teamName required' });
    }

    await queryOne(
      `UPDATE scoreboards
       SET gc_team_id = $2,
           gc_team_name = $3,
           gc_polling_enabled = true,
           game_id = NULL,
           gc_last_sync = NULL
       WHERE id = $1`,
      [id, teamId, teamName]
    );
    // Drop the cached gameId for this board — the next poll will pick
    // the live or most-recent game for the newly linked team.
    invalidateGameCache(id);
    res.json({ success: true, message: `Linked to team "${teamName}" — polling started` });
  } catch (err) {
    console.error('[gc] link-team error:', err);
    res.status(500).json({ error: 'Failed to link team' });
  }
});

/**
 * Toggle live polling on/off without disconnecting from GameChanger.
 * Preserves credentials and team config — just pauses the poller.
 */
gamechangerRouter.post('/:id/gc/toggle-polling', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }

    const updated = await queryOne(
      `UPDATE scoreboards
       SET gc_polling_enabled = $2
       WHERE id = $1
       RETURNING id, gc_polling_enabled`,
      [id, enabled]
    );
    if (!updated) return res.status(404).json({ error: 'Scoreboard not found' });
    res.json({ success: true, pollingEnabled: updated.gc_polling_enabled });
  } catch (err) {
    console.error('[gc] toggle-polling error:', err);
    res.status(500).json({ error: 'Failed to toggle polling' });
  }
});

/**
 * Force an immediate games-list refresh and re-pick the live (or most
 * recent) game for the linked team. Useful when the operator knows a
 * new game has just gone live and doesn't want to wait for the
 * poller's regular refresh cycle.
 */
gamechangerRouter.post('/:id/gc/refresh-game', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const board = await queryOne<{ gc_team_id: string | null; gc_status: string }>(
      `SELECT gc_team_id, gc_status FROM scoreboards WHERE id = $1`,
      [id]
    );
    if (!board) return res.status(404).json({ error: 'Scoreboard not found' });
    if (!board.gc_team_id) {
      return res.status(400).json({ error: 'No team linked. Link a team first.' });
    }
    if (board.gc_status !== 'connected') {
      return res.status(400).json({ error: `Not connected to GameChanger (status: ${board.gc_status})` });
    }

    // Fetch games list synchronously so we can return which game was selected
    const games = (await GC.getTeamGames(id, board.gc_team_id)) as Array<{
      id: string;
      game_status?: string;
      start_ts?: string;
      [k: string]: unknown;
    }>;

    if (!Array.isArray(games) || games.length === 0) {
      invalidateGameCache(id);
      return res.json({ success: true, picked: null, message: 'No games found for this team' });
    }

    // Filter out future-scheduled games — we only care about the live game
    // or the most recent played/completed game.
    const now = Date.now();
    const pastOrLiveGames = games.filter((g) => {
      const startMs = g.start_ts ? new Date(g.start_ts).getTime() : 0;
      // No start_ts = treat as past (defensive). Future games (>1h ahead) are skipped.
      if (!startMs) return true;
      return startMs <= now + 60 * 60 * 1000; // within the next hour still counts
    });

    // Prefer a live game first
    let picked = pastOrLiveGames.find((g) => g.game_status === 'live');
    let reason: 'live' | 'most-recent' = 'live';

    // Otherwise the most recently played game (largest start_ts <= now)
    if (!picked) {
      const sorted = [...pastOrLiveGames].sort(
        (a, b) =>
          new Date(b.start_ts ?? 0).getTime() - new Date(a.start_ts ?? 0).getTime()
      );
      picked = sorted[0];
      reason = 'most-recent';
    }

    // Clear the cached gameId so the next poll tick re-fetches details/pbp
    invalidateGameCache(id);

    res.json({
      success: true,
      picked: picked
        ? {
            id: picked.id,
            status: picked.game_status ?? null,
            startTs: picked.start_ts ?? null,
            reason,
          }
        : null,
      totalGames: games.length,
      eligibleGames: pastOrLiveGames.length,
      message: picked
        ? `Picked ${reason} game — polling will sync state on the next tick.`
        : 'No live or past games for this team (all games are in the future)',
    });
  } catch (err) {
    console.error('[gc] refresh-game error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to refresh game';
    res.status(500).json({ error: msg });
  }
});

/**
 * Poller diagnostics — last N sync samples for the requested scoreboard.
 * Useful for diagnosing GC latency. Enable verbose per-step logging by
 * setting GC_DIAG=1 in the backend environment.
 */
gamechangerRouter.get('/:id/gc/diagnostics', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }
  const samples = getDiagnostics(id);
  // Summary: average duration per outcome over the rolling window.
  const summary: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
  for (const s of samples) {
    const bucket = summary[s.outcome] ?? (summary[s.outcome] = { count: 0, avgMs: 0, maxMs: 0 });
    bucket.count++;
    bucket.avgMs = (bucket.avgMs * (bucket.count - 1) + s.durationMs) / bucket.count;
    if (s.durationMs > bucket.maxMs) bucket.maxMs = s.durationMs;
  }
  res.json({
    diagEnabled: isDiagEnabled(),
    sampleCount: samples.length,
    pool: getPoolStats(),
    summary,
    samples: samples.map((s) => ({
      startedAt: new Date(s.startedAt).toISOString(),
      durationMs: s.durationMs,
      outcome: s.outcome,
      steps: s.steps,
      apiCalls: s.apiCalls,
      error: s.error,
    })),
  });
});

/**
 * Disable GameChanger integration for a scoreboard.
 * Clears all tokens but preserves email/team config in case user re-enables.
 */
gamechangerRouter.post('/:id/gc/disable', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    // Close any pending session
    const pending = pendingSessions.get(id);
    if (pending) {
      await pending.session.close().catch(() => {});
      pendingSessions.delete(id);
    }

    await queryOne(
      `UPDATE scoreboards
       SET gc_enabled = false,
           gc_polling_enabled = false,
           gc_status = 'disabled',
           gc_auth_token = NULL,
           gc_refresh_token = NULL,
           gc_client_id = NULL,
           gc_device_id = NULL,
           gc_last_error = NULL
       WHERE id = $1`,
      [id]
    );
    res.json({ success: true, message: 'GameChanger integration disabled' });
  } catch (err) {
    console.error('[gc] disable error:', err);
    res.status(500).json({ error: 'Failed to disable GameChanger' });
  }
});