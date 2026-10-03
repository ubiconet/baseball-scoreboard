/**
 * GameChanger Background Poller
 *
 * Every POLL_INTERVAL_MS, for each scoreboard with gc_enabled=true and a
 * connected auth state, fetches the live (or most recent) game for the
 * configured team and updates the scoreboard state if it has changed.
 *
 * On state change, emits a socket push to display clients via emitStateUpdate.
 *
 * Manual scoreboard edits still work — they just get overwritten by the next
 * poll if the GC game state differs. To take manual control, disable GC.
 */

import { query, queryOne } from './db.js';
import { GC, GameChangerAPIError } from './gamechanger-api-helper.js';
import { emitStateUpdate } from './socket.js';
import { mapRowToScoreboard, type ScoreboardRow } from './state-helpers.js';

const POLL_INTERVAL_MS = 1_000;       // 1 second when a live game is active
const POLL_INTERVAL_IDLE_MS = 5_000;  // 5 seconds when no live game — short enough to catch games going live quickly
const GAME_ID_REFRESH_LIVE_MS = 5 * 60 * 1000; // refresh every 5 min while a live game is active
const GAME_ID_REFRESH_IDLE_MS = 5_000; // 5s when no live game — catch games going live quickly
const POLL_LOG_PREFIX = '[gc-poller]';
// Set to true to enable verbose per-step timing in syncOne. Surfaced via
// /api/scoreboards/:id/gc/diagnostics so the operator can toggle it without
// restarting the backend.
const DIAG_ENABLED = process.env.GC_DIAG === '1';

let pollerTimer: NodeJS.Timeout | null = null;
let pollInProgress = false;

/** Set by syncOne when a board transitions from no-live to live game. */
let liveGameJustAppeared = false;

// ── In-memory cache: last known game ID + plays count per scoreboard ────
// Avoids re-fetching the 48-game list every poll. Game ID lookup is refreshed
// every GAME_ID_REFRESH_INTERVAL_MS, or when plays count stops changing.
interface GameCache {
  gameId: string | null;
  playsCount: number;      // last seen plays.length
  lastPlayHash: string;    // hash of last play's details — detects pitch-by-pitch changes
  lastIdLookup: number;    // timestamp of last full games-list fetch
  lastGameStatus: string;  // 'live' | 'completed' | etc.
}
const gameCache = new Map<number, GameCache>();

// ── Diagnostics: per-board rolling samples for live monitoring ─────────
// Holds the last N sync attempts for each scoreboard, so /api/diagnostics
// can show the operator whether the poller is slow / failing.
interface SyncSample {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome: 'state-changed' | 'no-change' | 'idle' | 'no-live-game' | 'error';
  steps: Record<string, number>;  // step name → ms
  apiCalls: Array<{ url: string; durationMs: number; status: number }>;
  error?: string;
}
const diagnostics = new Map<number, SyncSample[]>();
const DIAG_HISTORY = 20;

export function getDiagnostics(scoreboardId: number): SyncSample[] {
  return diagnostics.get(scoreboardId) ?? [];
}
export function isDiagEnabled(): boolean {
  return DIAG_ENABLED;
}

// ── Types for GC API responses ──────────────────────────────────────────

interface GCGame {
  id: string;
  game_status?: string;
  start_ts?: string;
  home_away?: string;
  score?: { team?: number; opponent_team?: number };
  opponent_team?: { name?: string; id?: string };
}

interface GCPlay {
  order: number;
  inning: number;
  half: string; // "top" | "bottom"
  outs: number;
  home_score?: number;
  away_score?: number;
  at_plate_details?: Array<{ template: string }>;
  name_template?: { template: string };
  final_details?: Array<{ template: string }>;
}

interface GCDetails extends GCGame {
  line_score?: {
    team?: { scores?: number[]; totals?: number[] };
    opponent_team?: { scores?: number[]; totals?: number[] };
  };
}

interface GCPlayer {
  id: string;
  first_name: string;
  last_name: string;
  number: string;
}

interface PlayByPlay {
  plays?: GCPlay[];
  team_players?: Record<string, GCPlayer[]>;
}

interface ScoreboardGCConfig {
  id: number;
  unique_identifier: string;
  gc_team_id: string;
  gc_team_name: string | null;
  home_team_name: string;
  away_team_name: string;
  gc_team_names_extracted: boolean;
}

// ── Main poll loop ──────────────────────────────────────────────────────

export function startGCPoller(): void {
  if (pollerTimer) {
    console.warn(`${POLL_LOG_PREFIX} Already running — not starting twice`);
    return;
  }
  console.log(
    `${POLL_LOG_PREFIX} Started (live: ${POLL_INTERVAL_MS}ms, idle: ${POLL_INTERVAL_IDLE_MS}ms)`
  );
  scheduleNextTick(POLL_INTERVAL_MS);
}

/** Reschedule the next tick at the given delay. */
function scheduleNextTick(delayMs: number): void {
  if (pollerTimer) clearTimeout(pollerTimer);
  pollerTimer = setTimeout(async () => {
    const tickStart = Date.now();
    const liveJustAppeared = await tick();
    const tickDuration = Date.now() - tickStart;
    // Determine next interval. If a live game just appeared, switch to fast
    // polling immediately rather than waiting for the next cache-stale check.
    let nextDelay: number;
    if (liveJustAppeared) {
      nextDelay = POLL_INTERVAL_MS;
    } else {
      const anyLive = Array.from(gameCache.values()).some((c) => c.lastGameStatus === 'live');
      nextDelay = anyLive ? POLL_INTERVAL_MS : POLL_INTERVAL_IDLE_MS;
    }
    // Subtract the time the tick took so the effective cadence is the target
    // interval, not interval + tick_duration. Without this, a 500ms tick plus
    // a 2000ms delay yields 2.5s between fetches instead of 2s.
    const compensatedDelay = Math.max(50, nextDelay - tickDuration);
    scheduleNextTick(compensatedDelay);
  }, delayMs);
  pollerTimer.unref?.();
}

export function stopGCPoller(): void {
  if (pollerTimer) {
    clearTimeout(pollerTimer);
    pollerTimer = null;
    console.log(`${POLL_LOG_PREFIX} Stopped`);
  }
}

/**
 * Drop any cached gameId / game status for this board so the next tick
 * re-fetches the games list. Call this whenever the linked GC team
 * changes — otherwise the poller would keep polling the old team's
 * old game.
 */
export function invalidateGameCache(scoreboardId: number): void {
  if (gameCache.delete(scoreboardId)) {
    console.log(`${POLL_LOG_PREFIX} invalidated game cache for scoreboard ${scoreboardId}`);
  }
}

async function tick(): Promise<boolean> {
  // Returns true if a live game was just detected (caller should schedule fast poll).
  if (pollInProgress) return false;
  pollInProgress = true;
  liveGameJustAppeared = false; // reset at start of each tick
  try {
    const boards = await query<ScoreboardGCConfig>(
      `SELECT id, unique_identifier, gc_team_id, gc_team_name, home_team_name, away_team_name, gc_team_names_extracted
       FROM scoreboards
       WHERE gc_enabled = true
         AND gc_polling_enabled = true
         AND gc_team_id IS NOT NULL
         AND gc_auth_token IS NOT NULL
         AND gc_status = 'connected'`
    );

    if (boards.length === 0) return false;

    // Process each scoreboard in parallel — they're independent.
    // Each syncOne may set liveGameJustAppeared=true if a new live game was found.
    await Promise.allSettled(boards.map((b) => syncOne(b)));
    return liveGameJustAppeared;
  } catch (err) {
    console.error(`${POLL_LOG_PREFIX} Tick error:`, err);
    return false;
  } finally {
    pollInProgress = false;
  }
}

// ── Per-scoreboard sync ─────────────────────────────────────────────────

async function syncOne(board: ScoreboardGCConfig): Promise<void> {
  const startedAt = Date.now();
  const steps: Record<string, number> = {};
  const apiCalls: Array<{ url: string; durationMs: number; status: number }> = [];
  let outcome: SyncSample['outcome'] = 'idle';
  let errorMsg: string | undefined;

  // Wrap the API helper's network call so we can record per-call timing.
  // We use a sentinel timestamp that the helper records via a hook on fetch
  // when DIAG_ENABLED — implemented as a wrapping fetch in gamechanger-api-helper
  // would be intrusive, so instead we just measure around the calls here.
  const mark = (name: string) => {
    steps[name] = (steps[name] ?? 0) + 1;
  };

  try {
    const cache = gameCache.get(board.id) ?? {
      gameId: null,
      playsCount: 0,
      lastPlayHash: '',
      lastIdLookup: 0,
      lastGameStatus: '',
    };

    // 1. Determine which game to poll.
    //    Only hit the full games-list endpoint when we don't have a cached ID
    //    or the cache is stale. Stale window depends on whether we have a
    //    live game: 5 min when live (saves calls), 30s when idle (so new
    //    games appear quickly without a 30s lag spike).
    const now = Date.now();
    const refreshWindow = cache.lastGameStatus === 'live' ? GAME_ID_REFRESH_LIVE_MS : GAME_ID_REFRESH_IDLE_MS;
    const cacheStale = now - cache.lastIdLookup > refreshWindow;
    let gameId = cache.gameId;
    let gameStatus = cache.lastGameStatus;

    if (!gameId || cacheStale) {
      const t0 = Date.now();
      const games = (await GC.getTeamGames(board.id, board.gc_team_id)) as GCGame[];
      apiCalls.push({ url: `team-games(${board.gc_team_id})`, durationMs: Date.now() - t0, status: 200 });
      steps.gamesListMs = Date.now() - t0;
      mark('gamesList');

      if (DIAG_ENABLED) {
            console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: games-list fetch took ${steps.gamesListMs}ms (${Array.isArray(games) ? games.length : 0} games)`);
            // Debug: list live-flagged games
            const withLive = games.filter(g => g.game_status === 'live' || (g as any).live === true || (g as any).state === 'live');
            if (withLive.length) {
              console.log(`[gc-debug] games-list: ${withLive.length} marked live: ${withLive.map(g => `${g.id} status=${g.game_status}`).join('; ')}`);
            }
            // Show top 3 games with their game_status
            console.log(`[gc-debug] games-list top 3: ${games.slice(0, 3).map(g => `${g.id.slice(0,8)} status=${JSON.stringify(g.game_status)} ts=${g.start_ts}`).join(' | ')}`);
          }
      if (!Array.isArray(games) || games.length === 0) {
        outcome = 'no-live-game';
        return;
      }

      // Filter out future-scheduled games — we only care about the live game
      // or the most recent played/completed game. (Mirrors the logic in
      // the refresh-game route.)
      const nowMs = Date.now();
      const eligible = games.filter((g) => {
        const startMs = g.start_ts ? new Date(g.start_ts).getTime() : 0;
        if (!startMs) return true;
        return startMs <= nowMs + 60 * 60 * 1000;
      });

      // Prefer a live game; fall back to most recent eligible game
      let target: GCGame | undefined = eligible.find((g) => g.game_status === 'live');
      if (target) {
        gameStatus = 'live';
      } else {
        const sorted = [...eligible].sort(
          (a, b) =>
            new Date(b.start_ts ?? 0).getTime() - new Date(a.start_ts ?? 0).getTime()
        );
        target = sorted[0];
        gameStatus = target?.game_status ?? '';
      }

      gameId = target?.id ?? null;
      cache.lastIdLookup = now;
      const previousGameStatus = cache.lastGameStatus;
      cache.lastGameStatus = gameStatus;

      // If the game ID changed (new game started), reset plays count
      if (gameId && gameId !== cache.gameId) {
        cache.playsCount = 0;
        cache.lastPlayHash = '';
        console.log(
          `${POLL_LOG_PREFIX} ${board.unique_identifier}: new game detected (${gameId}, status: ${gameStatus})`
        );
      }
      cache.gameId = gameId;
      gameCache.set(board.id, cache);

      if (!gameId) {
        outcome = 'no-live-game';
        return;
      }

      // If a live game just appeared (cache had no live, now there's one),
      // signal to the outer scheduler to switch to fast polling immediately.
      // The cache-stale check above would otherwise make us wait 30s before
      // re-checking, which causes a big lag spike when games go live.
      if (gameStatus === 'live' && previousGameStatus !== 'live') {
        liveGameJustAppeared = true;
        console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: live game detected, switching to fast poll`);
      }
    }

    const isLive = gameStatus === 'live';

    // 1b. If the most recent game is completed (no live game), we still
    //     want to fetch details ONCE per new game so team names get
    //     extracted and written to the DB (for YouTube broadcast titles).
    //     We skip the expensive play-by-play fetch entirely. Once we've
    //     extracted the team names, we set game_names_extracted so we don't
    //     re-fetch details every tick.
    if (!isLive) {
      const t0 = Date.now();
      // Team-name extraction is gated by the `gc_team_names_extracted` flag
      // so we only hit the details API once per linked game. This avoids
      // burning API quota on idle ticks.
      if (!board.gc_team_names_extracted) {
        try {
          const details = (await GC.getGameDetails(board.id, gameId)) as GCDetails | null;
          if (details) {
            const teamPatch = extractTeamNamesOnly(details, board);
            if (teamPatch) {
              await queryOne(
                `UPDATE scoreboards
                 SET home_team_name = COALESCE($2, home_team_name),
                     away_team_name = COALESCE($3, away_team_name),
                     gc_team_names_extracted = true
                 WHERE id = $1`,
                [board.id, teamPatch.homeTeamName ?? null, teamPatch.awayTeamName ?? null]
              );
              console.log(
                `${POLL_LOG_PREFIX} ${board.unique_identifier}: team names extracted ` +
                  `(${teamPatch.awayTeamName} @ ${teamPatch.homeTeamName})`
              );
            }
          }
        } catch (err) {
          console.warn(
            `${POLL_LOG_PREFIX} ${board.unique_identifier}: team-name fetch failed:`,
            err
          );
        }
      }
      await queryOne('UPDATE scoreboards SET gc_last_sync = NOW() WHERE id = $1', [board.id]);
      steps.touchSyncMs = Date.now() - t0;
      outcome = 'no-live-game';
      return;
    }

    // 2. Fetch play-by-play ONLY (lightest call, has everything we need for
    //    inning/half/outs/count). The score is also embedded in plays via
    //    home_score/away_score, but those are unreliable mid-game — we only
    //    use them as a fallback if details fetch is skipped.
    const t1 = Date.now();
    const pbp = (await GC.getPlayByPlay(board.id, gameId)) as PlayByPlay | null;
    steps.pbpFetchMs = Date.now() - t1;
    apiCalls.push({ url: `plays(${gameId})`, durationMs: steps.pbpFetchMs, status: 200 });
    mark('pbp');
    if (DIAG_ENABLED) {
      console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: play-by-play fetch took ${steps.pbpFetchMs}ms (${pbp?.plays?.length ?? 0} plays)`);
    }
    const plays = pbp?.plays;
    if (!plays || plays.length === 0) {
      outcome = 'no-change';
      return;
    }

    // 2b. Check if the game has transitioned to completed. GameChanger marks
    //     the game complete but our cache still says "live" until the 5-min
    //     refresh. Detect this by checking the last play's name_template —
    //     completed games have a "Game over" or "Final" indicator. Cheaper
    //     than doing a full details fetch.
    const lastPlayForStatus = plays[plays.length - 1];
    const lastNameTemplate = (lastPlayForStatus?.name_template?.template || '').toLowerCase();
    const gameAppearsFinal =
      lastNameTemplate.includes('game over') ||
      lastNameTemplate.includes('final') ||
      lastNameTemplate.includes('end of game');
    if (gameAppearsFinal && cache.lastGameStatus === 'live') {
      cache.lastGameStatus = 'completed';
      gameCache.set(board.id, cache);
      console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: game ended, switching to idle`);
    }

    // 3. Detect changes. GameChanger updates the last play's at_plate_details
    //    in-place when a new pitch is thrown (plays count stays the same).
    //    So we hash the last play's key fields to detect pitch-by-pitch updates.
    const lastPlay = plays[plays.length - 1];
    const playHash = `${plays.length}:${lastPlay.inning}:${lastPlay.half}:${lastPlay.outs}:${
      JSON.stringify(lastPlay.at_plate_details || [])
    }`;
    const stateChanged = playHash !== cache.lastPlayHash;
    const previousHash = cache.lastPlayHash;
    cache.playsCount = plays.length;
    cache.lastPlayHash = playHash;
    gameCache.set(board.id, cache);

    if (DIAG_ENABLED) {
      console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: hash=${playHash.slice(0, 60)}... changed=${stateChanged}`);
    }

    // 4. Fetch details (every poll) — we need this for the score
    //    (authoritative, not derived from plays) and for `home_away` /
    //    team IDs which we use to resolve batter/pitcher names from
    //    the per-team player lists in `pbp.team_players`.
    const t3 = Date.now();
    const details = (await GC.getGameDetails(board.id, gameId)) as GCDetails | null;
    steps.detailsFetchMs = Date.now() - t3;
    apiCalls.push({ url: `details(${gameId})`, durationMs: steps.detailsFetchMs, status: 200 });
    mark('details');
    if (DIAG_ENABLED) {
      console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: details fetch took ${steps.detailsFetchMs}ms`);
      if (details) {
        console.log(`[gc-debug] details keys: ${Object.keys(details).join(',')}`);
        console.log(`[gc-debug] details.game_status=${JSON.stringify(details.game_status)} state=${JSON.stringify((details as any).state)} status=${JSON.stringify((details as any).status)} live=${JSON.stringify((details as any).live)}`);
      }
    }

    if (!stateChanged) {
      // No new plays or pitches — just refresh last_sync, skip the rest
      const t2 = Date.now();
      await queryOne('UPDATE scoreboards SET gc_last_sync = NOW() WHERE id = $1', [board.id]);
      steps.touchSyncMs = Date.now() - t2;
      outcome = 'no-change';
      return;
    }

    if (DIAG_ENABLED) {
      console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: STATE CHANGED (was "${previousHash.slice(0, 40)}..." → "${playHash.slice(0, 40)}...")`);
    }

    // 5. Extract scoreboard state from last play + details
    const patch = extractStateFromGame(details, lastPlay, plays, pbp?.team_players, board);
    if (!patch) {
      outcome = 'no-change';
      return;
    }

    // 6. Check if state actually changed (compare against current DB state)
    const t4 = Date.now();
    const current = await queryOne<ScoreboardRow>(
      'SELECT * FROM scoreboards WHERE id = $1',
      [board.id]
    );
    steps.currentReadMs = Date.now() - t4;
    if (!current) {
      outcome = 'error';
      errorMsg = 'scoreboard row missing';
      return;
    }

    const changed = hasStateChanged(current, patch);
    if (!changed) {
      // State unchanged — just update last_sync timestamp
      const t5 = Date.now();
      await queryOne('UPDATE scoreboards SET gc_last_sync = NOW() WHERE id = $1', [board.id]);
      steps.touchSyncMs = Date.now() - t5;
      outcome = 'no-change';
      if (DIAG_ENABLED) {
        console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: hash differed but DB state unchanged — skipping update`);
      }
      return;
    }

    // 7. Apply the update + bump version
    const t6 = Date.now();
    const updated = await queryOne<ScoreboardRow>(
      `UPDATE scoreboards
       SET home_score = $2,
           away_score = $3,
           inning = $4,
           half = $5,
           balls = $6,
           strikes = $7,
           outs = $8,
           batter_name = $9,
           batter_number = $10,
           pitcher_name = $11,
           pitcher_number = $12,
           home_team_name = COALESCE($14, home_team_name),
           away_team_name = COALESCE($15, away_team_name),
           game_id = $13,
           state_version = state_version + 1,
           gc_last_sync = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        board.id,
        patch.homeScore,
        patch.awayScore,
        patch.inning,
        patch.half,
        patch.balls,
        patch.strikes,
        patch.outs,
        patch.batterName ?? '',
        patch.batterNumber ?? '',
        patch.pitcherName ?? '',
        patch.pitcherNumber ?? '',
        gameId,
        patch.homeTeamName ?? null,
        patch.awayTeamName ?? null,
      ]
    );
    steps.dbUpdateMs = Date.now() - t6;
    if (DIAG_ENABLED) {
      console.log(`${POLL_LOG_PREFIX} ${board.unique_identifier}: DB update took ${steps.dbUpdateMs}ms`);
    }

    // 8. Push to display clients via socket
    if (updated) {
      const t7 = Date.now();
      emitStateUpdate(mapRowToScoreboard(updated));
      steps.emitMs = Date.now() - t7;
      outcome = 'state-changed';
      // Always log real updates (not gated by DIAG_ENABLED) — these are the
      // events the operator cares about most. Use INFO so it shows by default.
      console.log(
        `${POLL_LOG_PREFIX} ${board.unique_identifier}: ${isLive ? 'live' : 'recent'} game synced ` +
          `(H:${patch.homeScore} A:${patch.awayScore} I:${patch.inning}${patch.half[0]} ` +
          `${patch.balls}-${patch.strikes}-${patch.outs}) total=${Date.now() - startedAt}ms ` +
          `pbp=${steps.pbpFetchMs ?? 0}ms details=${steps.detailsFetchMs ?? 0}ms db=${steps.dbUpdateMs ?? 0}ms`
      );
    } else {
      outcome = 'no-change';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorMsg = message;
    outcome = 'error';
    if (err instanceof GameChangerAPIError && err.statusCode === 401) {
      await queryOne(
        `UPDATE scoreboards SET gc_status = 'disconnected', gc_last_error = $2 WHERE id = $1`,
        [board.id, `Auth failed: ${message}`]
      );
      console.warn(
        `${POLL_LOG_PREFIX} ${board.unique_identifier}: auth failed — marked disconnected`
      );
    } else {
      console.error(`${POLL_LOG_PREFIX} ${board.unique_identifier} sync error:`, message);
      await queryOne('UPDATE scoreboards SET gc_last_error = $2, gc_last_sync = NOW() WHERE id = $1', [
        board.id,
        message.substring(0, 500),
      ]);
    }
  } finally {
    // Clear any stale last_error after a successful tick so the editor
    // doesn't keep showing an error from a prior code version.
    if (outcome !== 'error') {
      await queryOne(
        'UPDATE scoreboards SET gc_last_error = NULL, gc_last_sync = NOW() WHERE id = $1 AND gc_last_error IS NOT NULL',
        [board.id]
      );
    }
    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;
    if (DIAG_ENABLED || outcome === 'error') {
      const breakdown = Object.entries(steps)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(' ');
      console.log(
        `${POLL_LOG_PREFIX} ${board.unique_identifier}: outcome=${outcome} duration=${durationMs}ms ${breakdown}${errorMsg ? ` err="${errorMsg.slice(0, 100)}"` : ''}`
      );
    }
    // Record into the rolling diagnostics buffer regardless of DIAG_ENABLED
    // (lightweight and lets us inspect performance even after the fact).
    const sample: SyncSample = { startedAt, finishedAt, durationMs, outcome, steps, apiCalls, error: errorMsg };
    const history = diagnostics.get(board.id) ?? [];
    history.push(sample);
    if (history.length > DIAG_HISTORY) history.shift();
    diagnostics.set(board.id, history);
  }
}

// ── State extraction ────────────────────────────────────────────────────
/** Player info we extracted from the PBP data. */
interface ScoreboardPatch {
  homeScore: number;
  awayScore: number;
  inning: number;
  half: 'top' | 'bottom';
  balls: number;
  strikes: number;
  outs: number;
  batterName?: string;
  batterNumber?: string;
  pitcherName?: string;
  pitcherNumber?: string;
  homeTeamName?: string;   // derived from GC opponent_team + gc_team_name
  awayTeamName?: string;   // derived from GC opponent_team + gc_team_name
}

// NOTE: baserunners (runner_on_first/second/third) are intentionally
// NOT extracted from GameChanger. GC's PBP data exposes runner state
// indirectly via final_details clause parsing, but the data is too
// inconsistent to derive reliably. These fields are operator-set only.

/**
 * Extract scoreboard state from game details + plays.
 *
 *   - Scores come from `details.score` (the authoritative running score).
 *     When details is null (no change since last poll), scores are derived
 *     from the last play's home_score/away_score as a fallback.
 *   - Inning / half come from the last play
 *   - Outs come from the max outs value across all plays in the current half-inning
 *     (the last play is a placeholder with outs:0 while the at-bat is in progress)
 *   - Balls / strikes are derived from the last play's `at_plate_details`
 *     ("Ball N", "Strike N looking/swinging", "Foul")
 */
function extractStateFromGame(
  details: GCDetails | null,
  lastPlay: GCPlay,
  allPlays: GCPlay[],
  teamPlayers: Record<string, GCPlayer[]> | undefined,
  board: ScoreboardGCConfig
): ScoreboardPatch | null {
  const isHome = details?.home_away === 'home' || inferHomeAway(allPlays, board);

  // Scores — prefer details.score (authoritative), fall back to last play
  let teamScore = 0;
  let oppScore = 0;
  if (details?.score) {
    teamScore = details.score.team ?? 0;
    oppScore = details.score.opponent_team ?? 0;
  } else {
    // Fallback: scan plays backwards for the highest score values
    // (the last play's score may be 0/0 placeholder for current at-bat)
    for (let i = allPlays.length - 1; i >= 0; i--) {
      const p = allPlays[i];
      if ((p.home_score ?? 0) > 0 || (p.away_score ?? 0) > 0) {
        // Need to know if we're home or away to map these correctly.
        // Plays use absolute home/away — if we're away, team=away_score.
        if (isHome) {
          teamScore = p.home_score ?? 0;
          oppScore = p.away_score ?? 0;
        } else {
          teamScore = p.away_score ?? 0;
          oppScore = p.home_score ?? 0;
        }
        break;
      }
    }
  }
  const homeScore = isHome ? teamScore : oppScore;
  const awayScore = isHome ? oppScore : teamScore;

  // Inning / half from the last play
  const inning = lastPlay.inning ?? 1;
  const half: 'top' | 'bottom' = String(lastPlay.half).toLowerCase().startsWith('b')
    ? 'bottom'
    : 'top';

  // Outs — scan all plays in this half-inning, take max (last play may be placeholder)
  const outs = maxOutsInHalfInning(allPlays, inning, half);

  // Balls / strikes from the current at-bat's pitch sequence
  const { balls, strikes } = deriveCount(lastPlay.at_plate_details);

  // Batter / pitcher — resolve UUIDs from the per-team player rosters.
  // Falls back to empty strings (UI hides the line) if GC didn't provide them.
  const { batterName, batterNumber, pitcherName, pitcherNumber } =
    extractPlayers(lastPlay, allPlays, teamPlayers);

  // Team names — pull from GC's opponent_team field + the linked team's name.
  // GC's home_away tells us which side OUR team is on for this game; the
  // opponent's name comes from details.opponent_team. Both go into the
  // YouTube broadcast title, so accuracy matters here.
  let homeTeamName: string | undefined;
  let awayTeamName: string | undefined;
  const ourTeamName = board.gc_team_name?.trim();
  const oppTeamName = details?.opponent_team?.name?.trim();
  if (DIAG_ENABLED) {
    console.log(
      `[gc-debug] team-name-extract: home_away=${details?.home_away} our="${ourTeamName}" opp="${oppTeamName}"`
    );
  }
  if (ourTeamName && oppTeamName) {
    if (details?.home_away === 'home') {
      homeTeamName = ourTeamName;
      awayTeamName = oppTeamName;
    } else if (details?.home_away === 'away') {
      homeTeamName = oppTeamName;
      awayTeamName = ourTeamName;
    } else {
      // home_away not in details — fall back to gc_team_name being home
      // (matches GC's default for the team the scoreboard is linked to)
      homeTeamName = ourTeamName;
      awayTeamName = oppTeamName;
    }
  }

  return {
    homeScore,
    awayScore,
    inning: Math.max(1, inning),
    half,
    balls,
    strikes,
    outs: Math.min(2, Math.max(0, outs)),
    batterName,
    batterNumber,
    pitcherName,
    pitcherNumber,
    homeTeamName,
    awayTeamName,
  };
}

/**
 * Extract only the team names from a game details payload.
 *
 * Used during the "no live game" idle path so we still populate team
 * names for the YouTube broadcast title without paying the cost of
 * fetching the full play-by-play. Returns null if either name can't be
 * determined — caller should leave existing DB values untouched.
 */
function extractTeamNamesOnly(
  details: GCDetails,
  board: ScoreboardGCConfig
): { homeTeamName: string; awayTeamName: string } | null {
  const ourTeamName = board.gc_team_name?.trim();
  const oppTeamName = details.opponent_team?.name?.trim();
  if (!ourTeamName || !oppTeamName) return null;
  if (details.home_away === 'away') {
    return { homeTeamName: oppTeamName, awayTeamName: ourTeamName };
  }
  // 'home' or undefined — our team is home (matches GC default)
  return { homeTeamName: ourTeamName, awayTeamName: oppTeamName };
}

/** Player info we extracted from the PBP data. */
interface ExtractedPlayers {
  batterName: string;
  batterNumber: string;
  pitcherName: string;
  pitcherNumber: string;
}

/**
 * Resolve batter/pitcher player UUIDs from the PBP data into names/numbers.
 *
 *   - BATTER: parsed from `lastPlay.name_template` which is always of the form
 *     "${<uuid>} at bat" when a new at-bat starts (and "Ground Out" etc. when
 *     the at-bat ended). We look the UUID up in `pbp.team_players` to get the
 *     matching roster entry's name and jersey number.
 *
 *   - PITCHER: not in the current at-bat's metadata, but GameChanger's
 *     `final_details` strings for strikeouts/walks/HBPs/etc. include a
 *     `... ${<uuid>} pitching` clause. We scan recent plays for that
 *     pattern. The pitcher is on the *opposite* team from the batter.
 *
 * Baserunners (runner_on_first/second/third) are NOT derived here — GC's
 * PBP data exposes them indirectly via final_details clauses, but the
 * data is too inconsistent to derive reliably. Those fields are
 * operator-controlled via the REST API and editor UI.
 */
function extractPlayers(
  lastPlay: GCPlay,
  allPlays: GCPlay[],
  teamPlayers: Record<string, GCPlayer[]> | undefined
): ExtractedPlayers {
  const empty: ExtractedPlayers = {
    batterName: '', batterNumber: '', pitcherName: '', pitcherNumber: '',
  };
  if (!teamPlayers) return empty;

  // Build a flat lookup map of UUID → player across both teams
  const byId = new Map<string, GCPlayer>();
  for (const roster of Object.values(teamPlayers)) {
    for (const p of roster || []) byId.set(p.id, p);
  }

  // ── Batter: walk backwards through plays to find the most recent
  //    "${<uuid>} at bat" template. GameChanger inserts lineup-change
  //    plays (e.g. "Lineup changed: Pinch runner ${...}") between
  //    half-innings, so we may need to skip a few before finding the
  //    real current at-bat.
  let batter: GCPlayer | null = null;
  for (let i = allPlays.length - 1; i >= 0; i--) {
    const tmplStr = allPlays[i].name_template?.template || '';
    const m = tmplStr.match(/\$\{([0-9a-f-]{36})\}\s+at bat/i);
    if (m) {
      batter = byId.get(m[1]) || null;
      break;
    }
  }
  const batterUuid = batter?.id ?? null;

  // ── Pitcher: scan recent plays for "... ${<uuid>} pitching" ──
  // Search broadly (last 24 plays) so we don't miss a pitching change
  // that happened a few batters ago.
  const pitcherScanEnd = allPlays.length;
  const pitcherScanStart = Math.max(0, pitcherScanEnd - 24);
  let pitcherUuid: string | null = null;
  for (let i = pitcherScanEnd - 1; i >= pitcherScanStart; i--) {
    const p = allPlays[i];
    if (!p.final_details) continue;
    for (const detail of p.final_details) {
      const m = (detail.template || '').match(/\$\{([0-9a-f-]{36})\}\s+pitching/i);
      if (m && (!batterUuid || m[1] !== batterUuid)) {
        pitcherUuid = m[1];
        break;
      }
    }
    if (pitcherUuid) break;
  }
  const pitcher = pitcherUuid ? byId.get(pitcherUuid) : null;

  return {
    batterName: batter ? `${batter.first_name.charAt(0)}. ${batter.last_name}` : '',
    batterNumber: batter?.number || '',
    pitcherName: pitcher ? `${pitcher.first_name.charAt(0)}. ${pitcher.last_name}` : '',
    pitcherNumber: pitcher?.number || '',
  };
}

/**
 * Replay final_details across the current half-inning to determine which
 * bases are occupied. We track each runner's last-known position based on
 * the baserunning clauses in `final_details` templates:
 *
 *   "${<uuid>} remains at 1st"          → on 1st, no movement
 *   "${<uuid>} remains at 2nd"          → on 2nd, no movement
 *   "${<uuid>} remains at 3rd"          → on 3rd, no movement
 *   "${<uuid>} advances to 1st"         → moved to 1st
 *   "${<uuid>} advances to 2nd"         → moved to 2nd (was on 1st)
 *   "${<uuid>} advances to 3rd"         → moved to 3rd (was on 2nd)
 *   "${<uuid>} scores"                  → left bases (scored)
 *   "${<uuid>} out advancing to 2nd"    → out, base now empty
 *   "${<uuid>} out at 2nd"              → out, base empty
 *   "${<uuid>} out at home" / "out at the plate" → out, no base change
 *
 * Strategy: walk plays in order, maintaining a Map<uuid, '1st'|'2nd'|'3rd'|null>.
 * At the end, anyone still in the map at a base = runner on that base.
 */
// (Baserunner derivation removed — GC's PBP data is too inconsistent to
//  derive baserunner state reliably. Baserunners are operator-set only.)

/**
 * Best-effort guess of whether our team is home or away when details is null.
 * Looks at any play that has differing home/away scores and checks which side
 * matches our team's scoring pattern. Falls back to 'away' (common default).
 */
function inferHomeAway(plays: GCPlay[], _board: ScoreboardGCConfig): boolean {
  // Without details we can't know for sure — default to away.
  // (This only affects the fallback path when details fetch is skipped,
  // which happens when plays haven't changed — in that case the scoreboard
  // already has the correct score from the previous poll.)
  return false;
}

/**
 * Find the true out count for a given half-inning.
 * GameChanger creates a placeholder play for the current at-bat with outs:0,
 * so the last play's outs is unreliable mid-at-bat. Instead, take the maximum
 * outs value across all plays in this half-inning.
 */
function maxOutsInHalfInning(
  plays: GCPlay[],
  inning: number,
  half: 'top' | 'bottom'
): number {
  let max = 0;
  for (const p of plays) {
    if (p.inning === inning && String(p.half).toLowerCase().startsWith(half[0])) {
      if ((p.outs ?? 0) > max) max = p.outs;
    }
  }
  return max;
}

/**
 * Derive the current balls/strikes count from the at_plate_details array.
 *
 * Templates look like:
 *   "Ball 1", "Ball 2", "Ball 3"
 *   "Strike 1 looking", "Strike 2 swinging", "Strike 3 swinging"
 *   "Foul"            — counts as a strike unless already at 2
 *   "In play"         — at-bat ended (ball put in play)
 *
 * We replay the pitch sequence: balls and strikes accumulate, fouls add a
 * strike only when strikes < 2.
 *
 * Note: we do NOT reset to 0-0 when an at-bat ends. GameChanger creates a
 * fresh play record for the next batter with an empty at_plate_details,
 * which naturally yields 0-0. If we reset here, we'd hide the final count
 * of a completed at-bat during the window before the next play is created.
 */
function deriveCount(details: Array<{ template: string }> | undefined): {
  balls: number;
  strikes: number;
} {
  if (!details || details.length === 0) return { balls: 0, strikes: 0 };

  let balls = 0;
  let strikes = 0;

  for (const { template } of details) {
    const t = template.toLowerCase();
    if (t.startsWith('ball ')) {
      balls += 1;
    } else if (t.startsWith('strike ')) {
      strikes += 1;
    } else if (t === 'foul') {
      if (strikes < 2) strikes += 1;
    }
    // "In play" and other terminal events don't change the count — the
    // next batter's play will have empty details and reset naturally.
  }

  return {
    balls: Math.min(3, balls),
    strikes: Math.min(2, strikes),
  };
}

/**
 * Compare current DB state against the new patch.
 * Returns true if any field differs.
 */
function hasStateChanged(current: ScoreboardRow, patch: ScoreboardPatch): boolean {
  return (
    current.home_score !== patch.homeScore ||
    current.away_score !== patch.awayScore ||
    current.inning !== patch.inning ||
    current.half !== patch.half ||
    current.balls !== patch.balls ||
    current.strikes !== patch.strikes ||
    current.outs !== patch.outs
  );
}
