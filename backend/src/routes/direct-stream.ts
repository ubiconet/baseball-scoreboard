/**
 * Direct HLS streaming routes.
 *
 *   GET   /api/scoreboards/:id/stream/direct/status  — current direct stream status
 *   POST  /api/scoreboards/:id/stream/direct/start   — start the local ffmpeg RTMP listener
 *   POST  /api/scoreboards/:id/stream/direct/stop    — stop the local ffmpeg RTMP listener
 *   PUT   /api/scoreboards/:id/stream/mode           — switch between 'youtube' and 'direct'
 *
 * The HLS playlist + segments are served by Express at /stream-hls/:id/ from
 * src/index.ts (a static middleware pointing at public/hls/).
 */

import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db.js';
import {
  startDirectStream,
  stopDirectStream,
  resetDirectStream,
  getActiveHlsUrl,
  getDirectStreamStatus,
} from '../direct-stream.js';
import { emitStreamStatus, getSocketForScoreboard, getPiRemoteAddress } from '../socket.js';
import { maskStreamKey } from '../types.js';

export const directStreamRouter = Router();

interface ModeRow {
  id: number;
  stream_mode: 'youtube' | 'direct';
  stream_key: string | null;
  direct_stream_ingest_url: string | null;
  stream_status: string;
  stream_resolution: '720p' | '1080p';
  stream_test_pattern: boolean;
}

/**
 * GET current direct stream status. Returns the active HLS URL when streaming,
 * null otherwise. Cheap, no DB hit beyond the row scan.
 */
directStreamRouter.get('/:id/stream/direct/status', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }
    const row = await queryOne<ModeRow>(
      `SELECT id, stream_mode, stream_key, direct_stream_ingest_url, stream_status,
              stream_resolution, stream_test_pattern
       FROM scoreboards WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

    const hlsUrl = getActiveHlsUrl(id);
    const status = getDirectStreamStatus(id);
    res.json({
      mode: row.stream_mode,
      active: !!hlsUrl,
      hlsUrl,                                 // e.g. /stream-hls/6/index.m3u8
      ingestUrl: row.direct_stream_ingest_url, // RTMP URL the Pi should push to
      streamKeyMasked: maskStreamKey(row.stream_key ?? null),
      resolution: row.stream_resolution ?? '720p',
      status: row.stream_status,              // DB-side stream_status
      testPattern: !!row.stream_test_pattern, // persisted test-pattern setting
      startedAt: status.startedAt?.toISOString() ?? null,
      isPiConnected: !!getSocketForScoreboard(id),
      piRemoteAddress: getPiRemoteAddress(id) ?? null,
    });
  } catch (err) {
    console.error('[direct-stream] status error:', err);
    res.status(500).json({ error: 'Failed to get direct stream status' });
  }
});

/**
 * POST start direct stream. Spawns a long-lived ffmpeg listener on the
 * Mac mini that re-packages incoming RTMP into HLS files.
 *
 * Body: { ingestUrl?: string } — optional override for the RTMP URL the Pi
 *        should push to. If omitted, uses direct_stream_ingest_url from DB
 *        (or auto-detects the LAN host).
 */
directStreamRouter.post('/:id/stream/direct/start', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }

  // Confirm the scoreboard is in direct mode
  const row = await queryOne<ModeRow>(
    `SELECT id, stream_mode, stream_key, direct_stream_ingest_url, stream_status, stream_resolution
     FROM scoreboards WHERE id = $1`,
    [id]
  );
  if (!row) return res.status(404).json({ error: 'Scoreboard not found' });
  if (row.stream_mode !== 'direct') {
    return res.status(400).json({ error: 'Scoreboard is not in direct stream mode. Set mode=direct first.' });
  }
  if (row.stream_status === 'live' || row.stream_status === 'starting') {
    return res.status(400).json({ error: `Stream already ${row.stream_status}. Stop it first.` });
  }

  const { resolution } = req.body as { resolution?: '720p' | '1080p' };
  if (resolution !== undefined && resolution !== null && resolution !== '720p' && resolution !== '1080p') {
    return res.status(400).json({ error: "resolution must be '720p' or '1080p'" });
  }

  try {
    const result = await startDirectStream(id, { resolution });
    res.json({
      success: true,
      status: 'starting',
      rtmpUrl: result.rtmpUrl,
      hlsUrl: result.hlsUrl,
      streamKey: result.streamKey,
      ingestHost: result.ingestHost,
      resolution: result.resolution,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[direct-stream] start error for scoreboard ${id}:`, err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST stop direct stream. Kills the ffmpeg listener.
 */
directStreamRouter.post('/:id/stream/direct/stop', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }
  try {
    await stopDirectStream(id);
    res.json({ success: true, status: 'idle' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[direct-stream] stop error for scoreboard ${id}:`, err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST hard-reset the direct HLS stream. Kills any wedged listener ffmpeg
 * with SIGKILL, emits stream:cmd reset to the Pi, and forces the DB row
 * back to idle. Use when /stream/direct/start refuses with
 * "Stream already starting. Stop it first." but nothing is actually
 * running on port 1935.
 */
directStreamRouter.post('/:id/stream/direct/reset', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }
  try {
    const result = await resetDirectStream(id);
    res.json({ success: true, status: 'idle', ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[direct-stream] reset error for scoreboard ${id}:`, err);
    res.status(500).json({ error: message });
  }
});

/**
 * PUT update stream mode ('youtube' | 'direct'), optional ingest URL,
 * and optional resolution ('720p' | '1080p').
 *
 * When switching to direct, also enables stream_enabled (user intent).
 * When switching to youtube, does NOT disable — user can still have a key
 * persisted from before. They manage the YouTube side via StreamSettings.
 */
directStreamRouter.put('/:id/stream/mode', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }

  const { mode, ingestUrl, resolution } = req.body as {
    mode?: unknown;
    ingestUrl?: unknown;
    resolution?: unknown;
  };
  if (mode !== 'youtube' && mode !== 'direct') {
    return res.status(400).json({ error: "mode must be 'youtube' or 'direct'" });
  }
  if (ingestUrl !== undefined && ingestUrl !== null && (typeof ingestUrl !== 'string' || !ingestUrl.startsWith('rtmp://'))) {
    return res.status(400).json({ error: 'ingestUrl must be an rtmp:// URL or null' });
  }
  if (resolution !== undefined && resolution !== null && resolution !== '720p' && resolution !== '1080p') {
    return res.status(400).json({ error: "resolution must be '720p' or '1080p'" });
  }

  // Build the update
  const updates: string[] = ['stream_mode = $2'];
  const params: unknown[] = [id, mode];
  if (ingestUrl !== undefined) {
    params.push(ingestUrl || null);
    updates.push(`direct_stream_ingest_url = $${params.length}`);
  }
  if (resolution !== undefined && resolution !== null) {
    params.push(resolution);
    updates.push(`stream_resolution = $${params.length}`);
  }
  if (mode === 'direct') {
    // User intent: turn on direct streaming
    updates.push('stream_enabled = true');
  }

  const row = await queryOne<ModeRow>(
    `UPDATE scoreboards SET ${updates.join(', ')}
     WHERE id = $1
     RETURNING id, stream_mode, stream_key, direct_stream_ingest_url, stream_status, stream_resolution`,
    params
  );
  if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

  // If we're switching away from direct while a direct stream is running, kill it
  if (mode === 'youtube' && getActiveHlsUrl(id)) {
    await stopDirectStream(id);
  }

  res.json({
    success: true,
    mode: row.stream_mode,
    ingestUrl: row.direct_stream_ingest_url,
    streamKeyMasked: maskStreamKey(row.stream_key ?? null),
    resolution: row.stream_resolution,
  });
});
