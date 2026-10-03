import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../db.js';
import { mapRowToScoreboard, type ScoreboardRow } from '../state-helpers.js';
import type { UpdateScoreboardInput } from '../types.js';
import {
  ValidationError,
  validateStateInput,
  sanitizeUniqueIdentifier,
  sanitizeOptionalString,
} from '../validation.js';
import { emitStateUpdate, emitLedRefresh } from '../socket.js';

export const scoreboardsRouter = Router();

scoreboardsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await query<ScoreboardRow>(
      'SELECT * FROM scoreboards ORDER BY created_at ASC'
    );
    res.json({ scoreboards: rows.map(mapRowToScoreboard) });
  } catch (err) {
    console.error('GET /api/scoreboards error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

scoreboardsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const row = await queryOne<ScoreboardRow>(
      'SELECT * FROM scoreboards WHERE id = $1',
      [id]
    );
    if (!row) {
      return res.status(404).json({ error: 'Scoreboard not found' });
    }
    res.json({ scoreboard: mapRowToScoreboard(row) });
  } catch (err) {
    handleError(err, res);
  }
});

scoreboardsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const uniqueIdentifier = sanitizeUniqueIdentifier(req.body?.uniqueIdentifier);
    const displayName = sanitizeOptionalString(req.body?.displayName, 'displayName') ?? '';
    const homeTeamName =
      sanitizeOptionalString(req.body?.homeTeamName, 'homeTeamName') ?? 'Home';
    const awayTeamName =
      sanitizeOptionalString(req.body?.awayTeamName, 'awayTeamName') ?? 'Away';

    let row: ScoreboardRow | null;
    try {
      row = await queryOne<ScoreboardRow>(
        `INSERT INTO scoreboards (unique_identifier, display_name, home_team_name, away_team_name)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [uniqueIdentifier, displayName, homeTeamName, awayTeamName]
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return res
          .status(409)
          .json({ error: `uniqueIdentifier "${uniqueIdentifier}" already exists` });
      }
      throw err;
    }

    res.status(201).json({ scoreboard: mapRowToScoreboard(row as ScoreboardRow) });
  } catch (err) {
    handleError(err, res);
  }
});

scoreboardsRouter.put('/:id/state', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const input = req.body ?? {};
    validateStateInput(input);

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (input.homeScore !== undefined) add('home_score', input.homeScore);
    if (input.awayScore !== undefined) add('away_score', input.awayScore);
    if (input.inning !== undefined) add('inning', input.inning);
    if (input.half !== undefined) add('half', input.half);
    if (input.balls !== undefined) add('balls', input.balls);
    if (input.strikes !== undefined) add('strikes', input.strikes);
    if (input.outs !== undefined) add('outs', input.outs);
    if (input.runnerOnFirst !== undefined) add('runner_on_first', input.runnerOnFirst);
    if (input.runnerOnSecond !== undefined) add('runner_on_second', input.runnerOnSecond);
    if (input.runnerOnThird !== undefined) add('runner_on_third', input.runnerOnThird);
    if (input.batterName !== undefined) add('batter_name', String(input.batterName).slice(0, 60));
    if (input.batterNumber !== undefined) add('batter_number', String(input.batterNumber).slice(0, 60));
    if (input.pitcherName !== undefined) add('pitcher_name', String(input.pitcherName).slice(0, 60));
    if (input.pitcherNumber !== undefined) add('pitcher_number', String(input.pitcherNumber).slice(0, 60));
    if (input.gameId !== undefined) add('game_id', input.gameId);

    if (sets.length === 0) {
      const current = await queryOne<ScoreboardRow>(
        'SELECT * FROM scoreboards WHERE id = $1',
        [id]
      );
      if (!current) {
        return res.status(404).json({ error: 'Scoreboard not found' });
      }
      return res.json({ scoreboard: mapRowToScoreboard(current) });
    }

    sets.push('state_version = state_version + 1');
    params.push(id);

    const row = await queryOne<ScoreboardRow>(
      `UPDATE scoreboards SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (!row) {
      return res.status(404).json({ error: 'Scoreboard not found' });
    }

    // Push real-time update to all subscribed display clients
    const updated = mapRowToScoreboard(row);
    emitStateUpdate(updated);

    res.json({ scoreboard: updated });
  } catch (err) {
    handleError(err, res);
  }
});

scoreboardsRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const body: UpdateScoreboardInput = req.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (body.uniqueIdentifier !== undefined) {
      add('unique_identifier', sanitizeUniqueIdentifier(body.uniqueIdentifier));
    }
    if (body.displayName !== undefined) {
      const v = sanitizeOptionalString(body.displayName, 'displayName');
      if (v !== undefined) add('display_name', v);
    }
    if (body.homeTeamName !== undefined) {
      const v = sanitizeOptionalString(body.homeTeamName, 'homeTeamName');
      if (v !== undefined) add('home_team_name', v);
    }
    if (body.awayTeamName !== undefined) {
      const v = sanitizeOptionalString(body.awayTeamName, 'awayTeamName');
      if (v !== undefined) add('away_team_name', v);
    }
    if (body.gameId !== undefined) {
      add('game_id', body.gameId === null ? null : String(body.gameId));
    }

    if (sets.length > 0) {
      params.push(id);
      let row: ScoreboardRow | null;
      try {
        row = await queryOne<ScoreboardRow>(
          `UPDATE scoreboards SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params
        );
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return res.status(409).json({ error: 'uniqueIdentifier already exists' });
        }
        throw err;
      }
      if (!row) {
        return res.status(404).json({ error: 'Scoreboard not found' });
      }
      return res.json({ scoreboard: mapRowToScoreboard(row) });
    }

    const current = await queryOne<ScoreboardRow>(
      'SELECT * FROM scoreboards WHERE id = $1',
      [id]
    );
    if (!current) {
      return res.status(404).json({ error: 'Scoreboard not found' });
    }
    res.json({ scoreboard: mapRowToScoreboard(current) });
  } catch (err) {
    handleError(err, res);
  }
});

scoreboardsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const row = await queryOne<ScoreboardRow>(
      'DELETE FROM scoreboards WHERE id = $1 RETURNING *',
      [id]
    );
    if (!row) {
      return res.status(404).json({ error: 'Scoreboard not found' });
    }
    res.json({ deleted: true, id });
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * POST /api/scoreboards/:id/led-refresh
 *
 * Re-initializes the Pi's MAX7219 8x8 LED chain (and clears the indicator
 * LEDs) without restarting the scoreboard_leds.py process. Useful when the
 * matrices get into a bad state due to SPI noise, a USB glitch, etc.
 *
 * The Pi's scoreboard_leds.py listens for the `led:refresh` socket event and
 * runs the same MAX7219 init sequence the luma library runs on first boot.
 * Also broadcasts to the browser so the editor UI can confirm the refresh
 * was dispatched.
 *
 * Body (optional):
 *   { requestedBy?: string }  — free-form identifier (e.g. operator name)
 *                               for the audit log.
 */
scoreboardsRouter.post('/:id/led-refresh', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const row = await queryOne<ScoreboardRow>(
      'SELECT id FROM scoreboards WHERE id = $1',
      [id]
    );
    if (!row) {
      return res.status(404).json({ error: 'Scoreboard not found' });
    }
    const requestedBy =
      typeof req.body?.requestedBy === 'string' && req.body.requestedBy.trim().length > 0
        ? req.body.requestedBy.trim().slice(0, 64)
        : undefined;
    emitLedRefresh(id, {
      requestedAt: new Date().toISOString(),
      requestedBy,
    });
    console.log(
      `[api] LED refresh requested for scoreboard ${id}${requestedBy ? ` by ${requestedBy}` : ''}`
    );
    res.json({
      success: true,
      scoreboardId: id,
      requestedAt: new Date().toISOString(),
    });
  } catch (err) {
    handleError(err, res);
  }
});

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('id must be a positive integer');
  }
  return id;
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === '23505';
  }
  return false;
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof ValidationError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  console.error('Route error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
