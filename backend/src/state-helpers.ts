/**
 * Shared state helpers — field mapping, validation, row→camelCase mapping.
 *
 * Used by both REST route handlers and the socket state:change handler
 * so validation logic stays in one place.
 */

import type { Scoreboard } from './types.js';
import type { ScoreboardRow as RowFromTypes } from './types.js';

/** DB row shape (snake_case from pg) */
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
  // Pi-streamer video encoding settings. Forwarded to the Pi on
  // every Start Stream so the operator can tweak resolution / fps
  // / audio bitrate from Settings → Live Stream without SSHing
  // into the Pi. NULL output_width/height = no scaling
  // (capture == output, used when operator picks "Source" in the
  // settings dropdown).
  stream_output_width: number | null;
  stream_output_height: number | null;
  stream_fps: number;
  stream_audio_bitrate: string;
  // Team whose GameChanger stream is being polled — the "home" team
  // for viewer-facing highlights. Mirrored from types.ScoreboardRow.
  gc_team_name: string | null;
  youtube_last_broadcast_id: string | null;
  youtube_last_stream_id: string | null;
}

/** Map camelCase API field names → snake_case DB columns */
export const stateFieldMap: Record<string, string> = {
  homeScore: 'home_score',
  awayScore: 'away_score',
  inning: 'inning',
  half: 'half',
  balls: 'balls',
  strikes: 'strikes',
  outs: 'outs',
  runnerOnFirst: 'runner_on_first',
  runnerOnSecond: 'runner_on_second',
  runnerOnThird: 'runner_on_third',
  batterName: 'batter_name',
  batterNumber: 'batter_number',
  pitcherName: 'pitcher_name',
  pitcherNumber: 'pitcher_number',
  gameId: 'game_id',
};

/**
 * Validate a state patch from the socket or REST.
 * Returns only known keys with valid values, or null if the patch is empty/invalid.
 */
export function validateStateFields(patch: Record<string, unknown>): Record<string, number | string | boolean | null> | null {
  const result: Record<string, number | string | boolean | null> = {};
  let hasAny = false;

  if ('homeScore' in patch) {
    const v = Number(patch.homeScore);
    if (!Number.isInteger(v) || v < 0) return null;
    result.homeScore = v; hasAny = true;
  }
  if ('awayScore' in patch) {
    const v = Number(patch.awayScore);
    if (!Number.isInteger(v) || v < 0) return null;
    result.awayScore = v; hasAny = true;
  }
  if ('inning' in patch) {
    const v = Number(patch.inning);
    if (!Number.isInteger(v) || v < 1) return null;
    result.inning = v; hasAny = true;
  }
  if ('half' in patch) {
    if (patch.half !== 'top' && patch.half !== 'bottom') return null;
    result.half = patch.half; hasAny = true;
  }
  if ('balls' in patch) {
    const v = Number(patch.balls);
    if (!Number.isInteger(v) || v < 0 || v > 3) return null;
    result.balls = v; hasAny = true;
  }
  if ('strikes' in patch) {
    const v = Number(patch.strikes);
    if (!Number.isInteger(v) || v < 0 || v > 2) return null;
    result.strikes = v; hasAny = true;
  }
  if ('outs' in patch) {
    const v = Number(patch.outs);
    if (!Number.isInteger(v) || v < 0 || v > 2) return null;
    result.outs = v; hasAny = true;
  }
  // Baserunners — accept booleans (preferred) or 0/1 from older clients.
  if ('runnerOnFirst' in patch) {
    result.runnerOnFirst = Boolean(patch.runnerOnFirst); hasAny = true;
  }
  if ('runnerOnSecond' in patch) {
    result.runnerOnSecond = Boolean(patch.runnerOnSecond); hasAny = true;
  }
  if ('runnerOnThird' in patch) {
    result.runnerOnThird = Boolean(patch.runnerOnThird); hasAny = true;
  }
  // Batter / pitcher identity — operator-entered text. Number is stored as
  // string so "1B" / "C" / "DH" can be used in addition to plain digits.
  const textFields = ['batterName', 'batterNumber', 'pitcherName', 'pitcherNumber'] as const;
  for (const f of textFields) {
    if (f in patch) {
      const v = patch[f];
      if (v === null) {
        result[f] = '';
      } else if (typeof v === 'string') {
        // Trim and cap length to avoid abuse / paste-bombs
        result[f] = v.trim().slice(0, 60);
      } else {
        result[f] = String(v).trim().slice(0, 60);
      }
      hasAny = true;
    }
  }
  if ('gameId' in patch) {
    result.gameId = patch.gameId === null ? null : String(patch.gameId);
    hasAny = true;
  }

  return hasAny ? result : null;
}

// Re-export the canonical mapper from types.ts to keep a single source of truth.
export { mapRowToScoreboard } from './types.js';
