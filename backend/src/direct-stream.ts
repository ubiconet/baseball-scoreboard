/**
 * Direct HLS streaming pipeline.
 *
 * In 'direct' stream mode, the Pi (or any RTMP source) pushes to a local
 * ffmpeg listener on the Mac mini. ffmpeg re-packages the RTMP stream into
 * HLS (.m3u8 + .ts segments) under a per-scoreboard public directory.
 * Express serves those files at /stream-hls/:id/index.m3u8.
 *
 * Why this exists:
 *   - Bypasses YouTube's rate limit + 10K units/day quota
 *   - Lower latency (no YouTube CDN hop)
 *   - Test pipelines work even when YouTube Data API is exhausted
 *   - Direct HLS playback in the watch page via hls.js
 *
 * Requirements:
 *   - ffmpeg in PATH (/opt/homebrew/bin/ffmpeg on Mac mini)
 *   - Port 1935 reachable from the Pi (via Cloudflare tunnel, see direct_stream_ingest_url)
 *
 * Limitations (intentional, for v1):
 *   - Single concurrent publisher per scoreboard (any new push kills the prior ffmpeg)
 *   - HLS segments retained for 10s (window=2, hls_list_size=4 ≈ 8s lookahead)
 *   - No recording to disk (live-only)
 *   - No authentication on the ingest URL — relies on the obscurity of the
 *     scoreboard ID + a random stream key. Adequate for personal field use;
 *     NOT for public production.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import { join, resolve } from 'path';
import { queryOne } from './db.js';
import { getSocketForScoreboard, emitStreamStatus } from './socket.js';
import type { StreamStatus } from './types.js';

// ── Config ──────────────────────────────────────────────────────────────

/** Port the RTMP listener accepts pushes on. */
const RTMP_PORT = Number(process.env.DIRECT_RTMP_PORT) || 1935;

/** Per-scoreboard HLS output root. Served at /stream-hls/:id/ by Express. */
const HLS_ROOT = resolve(process.cwd(), 'public', 'hls');

/** ffmpeg path. */
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';

/** Stream key (per-scoreboard, random). Generated on first start if missing. */
function generateStreamKey(): string {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
}

// ── State ───────────────────────────────────────────────────────────────

interface DirectStreamState {
  scoreboardId: number;
  ffmpeg: ChildProcess | null;
  startedAt: Date;
}

const activeStreams = new Map<number, DirectStreamState>();

// ── DB helpers ──────────────────────────────────────────────────────────

interface DirectStreamRow {
  id: number;
  stream_mode: string;
  direct_stream_ingest_url: string | null;
  stream_key: string | null;
  stream_resolution: '720p' | '1080p';
}

async function loadDirectStreamRow(scoreboardId: number): Promise<DirectStreamRow | null> {
  return queryOne<DirectStreamRow>(
    `SELECT id, stream_mode, direct_stream_ingest_url, stream_key, stream_resolution
     FROM scoreboards WHERE id = $1`,
    [scoreboardId]
  );
}

async function ensureStreamKey(scoreboardId: number): Promise<string> {
  const row = await queryOne<{ stream_key: string | null }>(
    `SELECT stream_key FROM scoreboards WHERE id = $1`,
    [scoreboardId]
  );
  if (row?.stream_key) return row.stream_key;
  const key = generateStreamKey();
  await queryOne(
    `UPDATE scoreboards SET stream_key = $2 WHERE id = $1`,
    [scoreboardId, key]
  );
  return key;
}

async function setStreamStatus(
  scoreboardId: number,
  status: StreamStatus,
  lastError: string | null = null
): Promise<void> {
  await queryOne(
    `UPDATE scoreboards
     SET stream_status = $2,
         stream_last_error = $3,
         stream_started_at = CASE
           WHEN $2 = 'live' AND stream_status <> 'live' THEN NOW()
           WHEN $2 IN ('idle', 'error') THEN NULL
           ELSE stream_started_at
         END
     WHERE id = $1`,
    [scoreboardId, status, lastError]
  );
  const row = await queryOne<{ stream_started_at: Date | null; stream_rtmp_url: string | null }>(
    `SELECT stream_started_at, stream_rtmp_url FROM scoreboards WHERE id = $1`,
    [scoreboardId]
  );
  emitStreamStatus(scoreboardId, {
    status,
    lastError,
    startedAt: row?.stream_started_at instanceof Date
      ? row.stream_started_at.toISOString()
      : row?.stream_started_at
        ? String(row.stream_started_at)
        : null,
    rtmpUrl: row?.stream_rtmp_url,
    isConnected: !!getSocketForScoreboard(scoreboardId),
  });
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Start a direct HLS stream for a scoreboard.
 *
 * Spawns a long-running ffmpeg process that listens for an RTMP push on
 * `rtmp://0.0.0.0:${RTMP_PORT}/live/<streamKey>` and re-packages the
 * inbound video/audio into HLS segments under `HLS_ROOT/<scoreboardId>/`.
 *
 * If a stream is already running for this scoreboard, it is stopped first.
 */
export async function startDirectStream(
  scoreboardId: number,
  options: { ffmpegBin?: string; resolution?: '720p' | '1080p' } = {}
): Promise<{ rtmpUrl: string; streamKey: string; hlsUrl: string; ingestHost: string; resolution: '720p' | '1080p' }> {
  // Idempotent — stop any prior stream for this scoreboard
  if (activeStreams.has(scoreboardId)) {
    await stopDirectStream(scoreboardId);
  }

  const row = await loadDirectStreamRow(scoreboardId);
  if (!row) throw new Error(`Scoreboard ${scoreboardId} not found`);
  if (row.stream_mode !== 'direct') {
    throw new Error(`Scoreboard ${scoreboardId} is not in direct stream mode`);
  }

  // Resolution: caller can override, otherwise use whatever's persisted in DB
  const resolution: '720p' | '1080p' = options.resolution ?? row.stream_resolution ?? '720p';

  // Ensure we have a stream key. We use the *same* stream_key column that
  // YouTube mode uses, since the field name is generic and there's no risk
  // of collision (a given scoreboard is in one mode at a time).
  const streamKey = await ensureStreamKey(scoreboardId);

  // Prepare HLS output dir
  const hlsDir = join(HLS_ROOT, String(scoreboardId));
  await fsMkdir(hlsDir, { recursive: true });
  // Clean any stale segments from a prior session
  for (const f of readdirSync(hlsDir)) {
    try { unlinkSync(join(hlsDir, f)); } catch { /* best-effort */ }
  }

  await setStreamStatus(scoreboardId, 'starting');

  const ffmpegBin = options.ffmpegBin || FFMPEG_BIN;
  const ingestUrl = `rtmp://0.0.0.0:${RTMP_PORT}/live/${streamKey}`;
  const m3u8Path = join(hlsDir, 'index.m3u8');

  // ffmpeg flags:
  //   -listen 1: act as RTMP server, wait for an incoming publisher
  //   -f flv: incoming is RTMP-wrapped FLV
  //   -c copy: no re-encode (Pi already sends H.264/AAC). If Pi sends
  //            something else we'll need to add transcoding here.
  //   -f hls: write HLS playlist + segments
  //   -hls_time 2: 2-second segments
  //   -hls_list_size 4: keep 4 segments in the live window (~8s lookahead)
  //   -hls_flags delete_segments+independent_segments: clean up old segments,
  //            make each segment independently decodable
  //   -hls_segment_filename: explicit segment name pattern
  const args = [
    '-y',
    '-listen', '1',
    '-i', ingestUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', join(hlsDir, 'seg_%03d.ts'),
    m3u8Path,
  ];

  console.log(`[direct-stream] scoreboard ${scoreboardId} starting ffmpeg listener`);
  console.log(`[direct-stream]   ingest: ${ingestUrl}`);
  console.log(`[direct-stream]   hls:    ${m3u8Path}`);

  const ff = spawn(ffmpegBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state: DirectStreamState = {
    scoreboardId,
    ffmpeg: ff,
    startedAt: new Date(),
  };
  activeStreams.set(scoreboardId, state);

  // Log ffmpeg output
  ff.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[direct-stream ${scoreboardId} ffmpeg] ${msg}`);
  });
  ff.stdout?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[direct-stream ${scoreboardId} ffmpeg] ${msg}`);
  });

  // When ffmpeg sees a publisher connect, it actually starts producing HLS.
  // We use the existence of the m3u8 file as our 'live' signal — poll for it.
  const livePoller = setInterval(async () => {
    if (!activeStreams.has(scoreboardId)) {
      clearInterval(livePoller);
      return;
    }
    if (existsSync(m3u8Path) && statSync(m3u8Path).size > 0) {
      clearInterval(livePoller);
      console.log(`[direct-stream] scoreboard ${scoreboardId} is LIVE (HLS available)`);
      await setStreamStatus(scoreboardId, 'live');
    }
  }, 1_000);

  ff.on('exit', async (code, signal) => {
    clearInterval(livePoller);
    activeStreams.delete(scoreboardId);
    console.log(`[direct-stream] scoreboard ${scoreboardId} ffmpeg exited (code=${code}, sig=${signal})`);
    if (code === 0 || signal === 'SIGTERM') {
      await setStreamStatus(scoreboardId, 'idle');
    } else {
      await setStreamStatus(scoreboardId, 'error', `ffmpeg exited with code ${code}`);
    }
  });

  ff.on('error', async (err) => {
    console.error(`[direct-stream] scoreboard ${scoreboardId} ffmpeg spawn error:`, err);
    await setStreamStatus(scoreboardId, 'error', `ffmpeg spawn failed: ${err.message}`);
    activeStreams.delete(scoreboardId);
  });

  // The public URL the watch page will hit (same Express server, /stream-hls/...)
  // For LAN-local testing: http://localhost:4020/stream-hls/<id>/index.m3u8
  // Via tunnel: https://scoreboard.ubiconet.com/stream-hls/<id>/index.m3u8
  const hlsUrl = `/stream-hls/${scoreboardId}/index.m3u8`;

  // What we tell the Pi to push to. The Pi is on the LAN, so we can give it
  // the LAN IP + RTMP port directly. If `direct_stream_ingest_url` is set in
  // the DB, that overrides the default (used when Pi is off-LAN).
  const ingestHost = row.direct_stream_ingest_url || `rtmp://${process.env.LAN_HOST || 'localhost'}:${RTMP_PORT}/live`;

  // Persist the RTMP URL we expect the Pi to use, for display in the UI
  await queryOne(
    `UPDATE scoreboards SET stream_rtmp_url = $2 WHERE id = $1`,
    [scoreboardId, `${ingestHost.replace(/^rtmp:\/\/[^/]+/, '')}/${streamKey}`]
  );

  // Tell the Pi to start pushing to our local listener. If the Pi is offline,
  // we just log a warning — the listener will still accept RTMP from anyone
  // (including the Mac mini itself for local testing).
  //
  // IMPORTANT: the Pi's stream_scoreboard.py appends stream_key to the rtmp_url
  // we send (target = f"{rtmp_url}/{stream_key}"). So we send ONLY the base URL
  // here (e.g. rtmp://192.168.1.163:1935/live), and let the Pi concatenate the
  // key. Sending the key in both places would result in /key/key in the URL.
  const rtmpBaseForPi = ingestHost;  // e.g. rtmp://192.168.1.163:1935/live

  const sendStartCmd = () => {
    const piSocket = getSocketForScoreboard(scoreboardId);
    if (piSocket) {
      console.log(`[direct-stream] telling Pi to push to ${rtmpBaseForPi}/${streamKey} @ ${resolution}`);
      // Read the persistent testPattern setting so the Pi pushes the
      // ffmpeg testsrc2 filter instead of camera frames when the
      // operator has it enabled in Settings. Same field name as the
      // YouTube start cmd so the Pi's command_listener handles both
      // stream modes uniformly.
      queryOne<{ stream_test_pattern: boolean }>(
        'SELECT stream_test_pattern FROM scoreboards WHERE id = $1',
        [scoreboardId]
      ).then((tpRow) => {
        piSocket.emit('stream:cmd', {
          action: 'start',
          streamKey,
          rtmpUrl: rtmpBaseForPi,
          resolution,
          testPattern: !!(tpRow?.stream_test_pattern),
        });
      }).catch((err) => {
        // Non-fatal: fall through to a default-false emit so the Pi
        // gets the start command even if the DB read hiccups.
        console.warn(`[direct-stream] could not read stream_test_pattern: ${err}`);
        piSocket.emit('stream:cmd', {
          action: 'start',
          streamKey,
          rtmpUrl: rtmpBaseForPi,
          resolution,
          testPattern: false,
        });
      });
      return true;
    }
    return false;
  };

  if (!sendStartCmd()) {
    // Pi socket not connected yet (e.g. we just restarted the backend). Retry
    // for up to 5s with 200ms backoff. The Pi reconnects automatically when
    // its socket reconnects to the room.
    console.warn(`[direct-stream] no Pi socket for scoreboard ${scoreboardId} — will retry for up to 5s`);
    let attempts = 0;
    const retry = setInterval(() => {
      attempts += 1;
      if (sendStartCmd()) {
        clearInterval(retry);
      } else if (attempts >= 25) {
        clearInterval(retry);
        console.warn(`[direct-stream] gave up waiting for Pi socket after 5s — listener will still accept publishers from anywhere`);
      }
    }, 200);
  }

  return { rtmpUrl: `${rtmpBaseForPi}/${streamKey}`, streamKey, hlsUrl, ingestHost: rtmpBaseForPi, resolution };
  }

/**
 * Stop a direct HLS stream for a scoreboard. Kills the ffmpeg listener
 * (which closes any active publisher connection), cleans up the HLS dir,
 * and tells the Pi to stop pushing.
 */
export async function stopDirectStream(scoreboardId: number): Promise<void> {
  const state = activeStreams.get(scoreboardId);
  if (!state) return;

  console.log(`[direct-stream] stopping stream for scoreboard ${scoreboardId}`);

  // Tell the Pi to stop pushing first — it'll terminate its ffmpeg and the
  // listener's input stream will close cleanly.
  const piSocket = getSocketForScoreboard(scoreboardId);
  if (piSocket) {
    piSocket.emit('stream:cmd', { action: 'stop' });
  }

  state.ffmpeg?.kill('SIGTERM');
  // Give it 2s to exit cleanly, then SIGKILL
  await new Promise((r) => setTimeout(r, 2_000));
  if (state.ffmpeg && !state.ffmpeg.killed) {
    state.ffmpeg.kill('SIGKILL');
  }
  activeStreams.delete(scoreboardId);
  await setStreamStatus(scoreboardId, 'idle');

  // Clean HLS dir
  const hlsDir = join(HLS_ROOT, String(scoreboardId));
  if (existsSync(hlsDir)) {
    for (const f of readdirSync(hlsDir)) {
      try { unlinkSync(join(hlsDir, f)); } catch { /* best-effort */ }
    }
    try { rmdirSync(hlsDir); } catch { /* best-effort */ }
  }
}

/**
 * Hard reset — kills the listener ffmpeg (even if it wedges), cleans the
 * HLS dir, and leaves the DB in 'idle' with no error. Used by the operator
 * "Reset" button to recover from wedged start/stop states. Safe to call
 * when no stream is active (no-op).
 */
export async function resetDirectStream(scoreboardId: number): Promise<{
  killed: boolean;
  hadActiveStream: boolean;
}> {
  const state = activeStreams.get(scoreboardId);
  if (!state) return { killed: false, hadActiveStream: false };

  console.log(`[direct-stream] RESET stream for scoreboard ${scoreboardId} (force-clean)`);

  // Skip the polite SIGTERM dance — go straight to SIGKILL on the listener.
  // The whole point of reset is to recover when the polite path hangs.
  if (state.ffmpeg && !state.ffmpeg.killed) {
    try { state.ffmpeg.kill('SIGKILL'); } catch { /* best-effort */ }
  }
  // Also tell the Pi to reset, in case it has its own wedged ffmpeg.
  const piSocket = getSocketForScoreboard(scoreboardId);
  if (piSocket) {
    piSocket.emit('stream:cmd', { action: 'reset' });
  }
  activeStreams.delete(scoreboardId);
  await setStreamStatus(scoreboardId, 'idle');

  // Clean HLS dir (same as stopDirectStream)
  const hlsDir = join(HLS_ROOT, String(scoreboardId));
  if (existsSync(hlsDir)) {
    for (const f of readdirSync(hlsDir)) {
      try { unlinkSync(join(hlsDir, f)); } catch { /* best-effort */ }
    }
    try { rmdirSync(hlsDir); } catch { /* best-effort */ }
  }
  return { killed: true, hadActiveStream: true };
}

/**
 * Return the HLS playlist URL if a direct stream is active, else null.
 * Used by the display endpoint to tell the watch page what to play.
 */
export function getActiveHlsUrl(scoreboardId: number): string | null {
  return activeStreams.has(scoreboardId)
    ? `/stream-hls/${scoreboardId}/index.m3u8`
    : null;
}

/**
 * Return current direct-stream status for a scoreboard. Used by the
 * /api/scoreboards/:id/stream/direct/status route.
 */
export function getDirectStreamStatus(scoreboardId: number): {
  active: boolean;
  startedAt: Date | null;
} {
  const state = activeStreams.get(scoreboardId);
  return {
    active: !!state,
    startedAt: state?.startedAt ?? null,
  };
}

// ── Filesystem helper (avoids importing fs everywhere) ─────────────────

async function fsMkdir(path: string, opts: { recursive?: boolean }): Promise<void> {
  try {
    mkdirSync(path, opts);
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
}
