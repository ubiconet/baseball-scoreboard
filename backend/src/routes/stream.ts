/**
 * YouTube / Twitch Live Streaming Routes
 *
 *   GET   /api/scoreboards/:id/stream/status         — current stream status + Pi connection
 *   PUT   /api/scoreboards/:id/stream/key            — save YouTube stream key (legacy/manual)
 *   PUT   /api/scoreboards/:id/stream/twitch/key     — save Twitch stream key + channel name
 *   PUT   /api/scoreboards/:id/stream/platform       — switch active destination (youtube | twitch)
 *   PUT   /api/scoreboards/:id/stream/test-pattern   — toggle test-pattern (Pi pushes testsrc2)
 *   PUT   /api/scoreboards/:id/stream/encoding       — set Pi encoder settings (resolution/fps/audio)
 *   POST  /api/scoreboards/:id/stream/start          — emit stream:cmd to Pi to begin streaming
 *   POST  /api/scoreboards/:id/stream/stop           — emit stream:cmd to Pi to stop streaming
 *
 * The Pi receives commands via the existing socket.io connection (no separate
 * network path needed). The stream key never leaves the server unencrypted in
 * API responses — only a masked version is returned on GET, and the masked
 * version returned is for the *active* platform only.
 */

import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db.js';
import { getSocketForScoreboard, emitStreamStatus, getPiRemoteAddress } from '../socket.js';
import { createBroadcastAndStartStream, endBroadcast } from '../youtube-stream.js';
import { resetDirectStream } from '../direct-stream.js';
import { maskStreamKey, type StreamStatus, type StreamPlatform } from '../types.js';

export const streamRouter = Router();

const VALID_PLATFORMS: StreamPlatform[] = ['youtube', 'twitch'];
const VALID_STATUSES: StreamStatus[] = ['idle', 'starting', 'live', 'stopping', 'error'];

// Encoder setting whitelists — kept narrow on purpose so the frontend
// dropdowns and the Pi's CLI both agree on the available values.
// Adding a new option here is a 3-place change: migration CHECK
// constraint, this allowlist, and the frontend dropdown.
const VALID_FPS = [15, 24, 30] as const;
const VALID_AUDIO_BITRATES = ['64k', '96k', '128k'] as const;
// Output resolution presets the UI offers. NULL = "Source" (no
// scaling — encoder output == capture size). The 320×240 preset is
// the aggressive-clean-motion option for the hw encoder's fixed
// ~200 kbps rate.
const VALID_OUTPUT_PRESETS: ReadonlyArray<{
  label: string;
  width: number | null;
  height: number | null;
}> = [
  { label: 'source (no scaling)', width: null, height: null },
  { label: '480×360 (recommended)', width: 480, height: 360 },
  { label: '320×240 (max quality)', width: 320, height: 240 },
];
function isValidPreset(w: number | null, h: number | null): boolean {
  return VALID_OUTPUT_PRESETS.some(
    (p) => p.width === w && p.height === h
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface StreamRow {
  id?: number; // optional — used by buildStatusResponse for piRemoteAddress lookup; SELECTs always project it but the type is shared with non-fetching callers.
  stream_key: string | null;
  stream_platform: StreamPlatform;
  twitch_stream_key: string | null;
  twitch_channel_name: string | null;
  stream_enabled: boolean;
  stream_status: string;
  stream_last_error: string | null;
  stream_started_at: Date | null;
  stream_rtmp_url: string | null;
  stream_test_pattern: boolean;
  // Encoder settings — see migration 002. SELECTs always project
  // them so the /status response can populate the encoding field
  // in StreamStatusPayload.
  stream_output_width: number | null;
  stream_output_height: number | null;
  stream_fps: number;
  stream_audio_bitrate: string;
}

/**
 * Pick the masked key + enabled flag for the *active* platform so the
 * frontend's polling endpoint reveals nothing about the inactive platform.
 *   - youtube → stream_key + stream_enabled (which currently drives both modes)
 *   - twitch  → twitch_stream_key + twitch-key-set check
 */
function pickActiveKeyMasked(row: StreamRow): string | undefined {
  if (row.stream_platform === 'twitch') {
    return row.twitch_stream_key ? maskStreamKey(row.twitch_stream_key) : undefined;
  }
  return row.stream_key ? maskStreamKey(row.stream_key) : undefined;
}

/** Whether the active platform is configured (so the UI can enable Start). */
function pickActiveEnabled(row: StreamRow): boolean {
  if (row.stream_platform === 'twitch') {
    // Twitch needs both the stream key AND the channel name. The channel
    // name drives the watch-page embed URL — without it, Start would
    // appear to succeed but spectators would see "Stream offline".
    return !!row.twitch_stream_key && !!row.twitch_channel_name && !!row.twitch_channel_name.trim();
  }
  return !!row.stream_enabled;
}

function buildStatusResponse(row: StreamRow, isConnected: boolean) {
  return {
    status: (row.stream_status as StreamStatus) || 'idle',
    lastError: row.stream_last_error,
    startedAt:
      row.stream_started_at instanceof Date
        ? row.stream_started_at.toISOString()
        : row.stream_started_at
          ? String(row.stream_started_at)
          : null,
    rtmpUrl: row.stream_rtmp_url,
    // Active platform + its masked key only. The inactive platform's key
    // is exposed on the dedicated Settings endpoints, never here.
    platform: row.stream_platform,
    streamKeyMasked: pickActiveKeyMasked(row),
    streamEnabled: pickActiveEnabled(row),
    testPattern: !!row.stream_test_pattern,
    // Persisted Pi encoder settings (see migration 002). UI mirrors
    // these in the Video Encoding dropdowns in StreamSettings.
    encoding: {
      outputWidth: row.stream_output_width,
      outputHeight: row.stream_output_height,
      fps: row.stream_fps,
      audioBitrate: row.stream_audio_bitrate,
    },
    isConnected,
    // Remote IP:port of the connected Pi socket (if any). Lets the operator
    // SSH into the streamer without scanning the LAN — the IP can change
    // when the Pi reconnects to a different DHCP lease, so this is live.
    piRemoteAddress: row.id != null ? getPiRemoteAddress(row.id) ?? null : null,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────

/**
 * GET current stream status. Cheap query — useful as a polling fallback for
 * browsers that lose the socket. Returns only the active platform's masked
 * key so an idle observer can't enumerate the inactive destination's state.
 */
streamRouter.get('/:id/stream/status', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const row = await queryOne<StreamRow>(
      `SELECT id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
              stream_enabled, stream_status, stream_last_error,
              stream_started_at, stream_rtmp_url, stream_test_pattern,
              stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate
       FROM scoreboards WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

    const isConnected = !!getSocketForScoreboard(id);
    res.json(buildStatusResponse(row, isConnected));
  } catch (err) {
    console.error('[stream] status error:', err);
    res.status(500).json({ error: 'Failed to get stream status' });
  }
});

/**
 * PUT YouTube stream key (and optional RTMP URL). The full key is persisted
 * to DB but never echoed back in responses — only a masked version.
 * Legacy/manual flow. The OAuth flow in /api/auth/youtube/start is the
 * recommended path for YouTube.
 */
streamRouter.put('/:id/stream/key', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const { streamKey, rtmpUrl } = req.body as { streamKey?: unknown; rtmpUrl?: unknown };

    const updates: string[] = [];
    const params: unknown[] = [];

    if (streamKey !== undefined) {
      if (typeof streamKey !== 'string' || streamKey.length === 0) {
        return res.status(400).json({ error: 'streamKey must be a non-empty string' });
      }
      if (streamKey.length > 512) {
        return res.status(400).json({ error: 'streamKey too long (max 512 chars)' });
      }
      params.push(streamKey);
      updates.push(`stream_key = $${params.length}`);
    }

    if (rtmpUrl !== undefined) {
      if (rtmpUrl !== null && (typeof rtmpUrl !== 'string' || rtmpUrl.length === 0)) {
        return res.status(400).json({ error: 'rtmpUrl must be a string or null' });
      }
      params.push(rtmpUrl || null);
      updates.push(`stream_rtmp_url = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (streamKey !== undefined) {
      updates.push('stream_enabled = true');
    }

    params.push(id);
    const row = await queryOne<StreamRow>(
      `UPDATE scoreboards SET ${updates.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
                 stream_enabled, stream_status, stream_last_error,
                 stream_started_at, stream_rtmp_url`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

    const isConnected = !!getSocketForScoreboard(id);
    res.json({
      success: true,
      ...buildStatusResponse(row, isConnected),
    });
  } catch (err) {
    console.error('[stream] update key error:', err);
    res.status(500).json({ error: 'Failed to update stream key' });
  }
});

/**
 * PUT Twitch stream key (and optional channel name). The full key is
 * persisted to DB but never echoed back. Pass `streamKey: ''` to clear.
 *
 * Body: { streamKey: string, channelName?: string | null }
 */
streamRouter.put('/:id/stream/twitch/key', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const { streamKey, channelName } = req.body as { streamKey?: unknown; channelName?: unknown };

    // Either field can be omitted (= "don't touch"), or explicitly set.
    // The endpoint requires at least one of them to be present so we don't
    // accept no-op PUTs.
    if (streamKey === undefined && channelName === undefined) {
      return res.status(400).json({ error: 'Provide streamKey and/or channelName' });
    }

    // streamKey validation: string, length 0..512. Empty string = explicit clear.
    // Omitted = leave unchanged.
    let updateKey = false;
    let newKey: string | null | undefined = undefined;
    if (streamKey !== undefined) {
      if (typeof streamKey !== 'string') {
        return res.status(400).json({ error: 'streamKey must be a string (use "" to clear)' });
      }
      if (streamKey.length > 512) {
        return res.status(400).json({ error: 'streamKey too long (max 512 chars)' });
      }
      updateKey = true;
      newKey = streamKey.length > 0 ? streamKey : null;
    }

    // channelName validation: this is the actual Twitch login (the lowercase
    // username from twitch.tv/<login>). Must be a non-empty string with no
    // spaces — Twitch would 404 the embed otherwise. null/omitted = don't touch.
    let updateLogin = false;
    let newLogin: string | null | undefined = undefined;
    if (channelName !== undefined) {
      if (channelName === null) {
        updateLogin = true;
        newLogin = null;
      } else if (typeof channelName === 'string') {
        const trimmed = channelName.trim();
        if (trimmed.length > 0) {
          if (/\s/.test(trimmed)) {
            return res.status(400).json({ error: 'channelName cannot contain spaces — use the Twitch login, not the display name' });
          }
          if (!/^[a-z0-9_]+$/i.test(trimmed)) {
            return res.status(400).json({ error: 'channelName must contain only letters, numbers, and underscores (Twitch login format)' });
          }
          if (trimmed.length > 64) {
            return res.status(400).json({ error: 'channelName too long (max 64 chars)' });
          }
          updateLogin = true;
          // Normalise to lowercase — Twitch logins are always lowercase and
          // the embed/watch URLs are case-sensitive.
          newLogin = trimmed.toLowerCase();
        }
        // empty/whitespace string = no-op (don't touch). Operator who wants
        // to clear the login should pass null explicitly.
      } else {
        return res.status(400).json({ error: 'channelName must be a string or null' });
      }
    }

    // Build the SET clause from whichever fields were provided.
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updateKey) {
      params.push(newKey);
      sets.push(`twitch_stream_key = $${params.length}`);
    }
    if (updateLogin) {
      params.push(newLogin);
      sets.push(`twitch_channel_name = $${params.length}`);
    }
    params.push(id);

    const row = await queryOne<StreamRow>(
      `UPDATE scoreboards SET ${sets.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
                 stream_enabled, stream_status, stream_last_error,
                 stream_started_at, stream_rtmp_url, stream_test_pattern,
                 stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

    const isConnected = !!getSocketForScoreboard(id);
    res.json({
      success: true,
      ...buildStatusResponse(row, isConnected),
      twitchChannelName: row.twitch_channel_name,
    });
  } catch (err) {
    console.error('[stream] update twitch key error:', err);
    res.status(500).json({ error: 'Failed to update Twitch stream key' });
  }
});

/**
 * PUT active streaming platform. Body: { platform: 'youtube' | 'twitch' }.
 *
 * Refuses to switch mid-stream — the operator must Stop first. Switching
 * platforms does not touch the other platform's credentials (they live in
 * separate columns).
 */
streamRouter.put('/:id/stream/platform', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const { platform } = req.body as { platform?: unknown };
    if (typeof platform !== 'string' || !VALID_PLATFORMS.includes(platform as StreamPlatform)) {
      return res.status(400).json({ error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` });
    }
    const newPlatform = platform as StreamPlatform;

    // Refuse mid-stream switches — could leave the Pi's ffmpeg pushing to a
    // destination the operator no longer wants.
    const cur = await queryOne<{ stream_status: string; stream_platform: StreamPlatform }>(
      'SELECT stream_status, stream_platform FROM scoreboards WHERE id = $1',
      [id]
    );
    if (!cur) return res.status(404).json({ error: 'Scoreboard not found' });
    if (cur.stream_status === 'live' || cur.stream_status === 'starting') {
      return res
        .status(400)
        .json({ error: `Cannot switch platform while stream is ${cur.stream_status}. Stop it first.` });
    }

    // NOTE: We deliberately allow switching to a platform with no credentials
    // configured. The operator may be selecting the platform precisely to
    // paste a key into it. /stream/start is where credentials are enforced —
    // it returns a clear error if the active platform isn't ready. The Settings
    // UI also shows an "active platform not ready" hint and disables Start
    // via the streamEnabled flag in /status.

    const row = await queryOne<StreamRow>(
      `UPDATE scoreboards SET stream_platform = $1
       WHERE id = $2
       RETURNING id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
                 stream_enabled, stream_status, stream_last_error,
                 stream_started_at, stream_rtmp_url, stream_test_pattern,
                 stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate`,
      [newPlatform, id]
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

    const isConnected = !!getSocketForScoreboard(id);
    res.json({
      success: true,
      ...buildStatusResponse(row, isConnected),
    });
  } catch (err) {
    console.error('[stream] update platform error:', err);
    res.status(500).json({ error: 'Failed to update streaming platform' });
  }
});

/**
 * PUT test-pattern toggle. When true, the Pi pushes ffmpeg's testsrc2 filter
 * to the RTMP endpoint instead of camera frames. Persists in DB so the
 * StreamPanel reads the same value on every load. Body: { enabled: boolean }.
 */
streamRouter.put('/:id/stream/test-pattern', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }
    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const row = await queryOne<StreamRow>(
      `UPDATE scoreboards SET stream_test_pattern = $1
       WHERE id = $2
       RETURNING id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
                 stream_enabled, stream_status, stream_last_error,
                 stream_started_at, stream_rtmp_url, stream_test_pattern,
                 stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate`,
      [enabled, id]
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });
    const isConnected = !!getSocketForScoreboard(id);
    res.json({
      success: true,
      ...buildStatusResponse(row, isConnected),
    });
  } catch (err) {
    console.error('[stream] test-pattern update error:', err);
    res.status(500).json({ error: 'Failed to update test pattern' });
  }
});

/**
 * PUT encoder settings. Body shape:
 *   { outputWidth: number | null, outputHeight: number | null,
 *     fps: number,                audioBitrate: string }
 *
 * All fields optional — caller can update one knob without touching
 * the others. Output dims must come from VALID_OUTPUT_PRESETS
 * (source / 480×360 / 320×240) — the Pi's V4L2 M2M encoder requires
 * even pixel dimensions for hardware downscaling.
 *
 * Persists to DB; the next /stream/start picks them up and forwards
 * to the Pi as --output-width / --output-height / --fps / --audio-bitrate
 * flags. Doesn't restart a running stream — operator has to Stop and
 * Start again to apply the new encoder settings (FFmpeg can't change
 * resolution mid-stream).
 */
streamRouter.put('/:id/stream/encoding', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const body = (req.body ?? {}) as {
      outputWidth?: unknown;
      outputHeight?: unknown;
      fps?: unknown;
      audioBitrate?: unknown;
    };

    // Build the SET clause dynamically so partial updates work.
    const sets: string[] = [];
    const params: unknown[] = [];

    // Output dims: must be one of the presets or both null.
    let nextOutputWidth: number | null | undefined;
    let nextOutputHeight: number | null | undefined;
    if (body.outputWidth !== undefined || body.outputHeight !== undefined) {
      // Frontend sends both fields together when changing resolution.
      // Allow either number or null; reject anything else.
      const parseDim = (v: unknown): number | null => {
        if (v === null) return null;
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          throw new Error('outputWidth/outputHeight must be a positive integer or null');
        }
        return v;
      };
      try {
        nextOutputWidth = body.outputWidth === undefined ? undefined : parseDim(body.outputWidth);
        nextOutputHeight = body.outputHeight === undefined ? undefined : parseDim(body.outputHeight);
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }
      // If only one was sent, refuse — keep dims consistent.
      if ((nextOutputWidth === undefined) !== (nextOutputHeight === undefined)) {
        return res.status(400).json({
          error: 'outputWidth and outputHeight must be sent together (or both omitted)',
        });
      }
      // If both sent, validate the (width, height) pair is a known preset.
      if (nextOutputWidth !== undefined && nextOutputHeight !== undefined) {
        if (!isValidPreset(nextOutputWidth, nextOutputHeight)) {
          return res.status(400).json({
            error:
              'outputWidth/outputHeight must be a supported preset: ' +
              VALID_OUTPUT_PRESETS.map((p) => p.label).join(', '),
          });
        }
        params.push(nextOutputWidth);
        sets.push(`stream_output_width = $${params.length}`);
        params.push(nextOutputHeight);
        sets.push(`stream_output_height = $${params.length}`);
      }
    }

    if (body.fps !== undefined) {
      if (typeof body.fps !== 'number' || !VALID_FPS.includes(body.fps as 15 | 24 | 30)) {
        return res.status(400).json({
          error: `fps must be one of ${VALID_FPS.join(', ')}`,
        });
      }
      params.push(body.fps);
      sets.push(`stream_fps = $${params.length}`);
    }

    if (body.audioBitrate !== undefined) {
      if (
        typeof body.audioBitrate !== 'string' ||
        !VALID_AUDIO_BITRATES.includes(body.audioBitrate as '64k' | '96k' | '128k')
      ) {
        return res.status(400).json({
          error: `audioBitrate must be one of ${VALID_AUDIO_BITRATES.join(', ')}`,
        });
      }
      params.push(body.audioBitrate);
      sets.push(`stream_audio_bitrate = $${params.length}`);
    }

    // Empty body = no-op (don't write). Return the current state.
    if (sets.length === 0) {
      const cur = await queryOne<StreamRow>(
        `SELECT id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
                stream_enabled, stream_status, stream_last_error,
                stream_started_at, stream_rtmp_url, stream_test_pattern,
                stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate
         FROM scoreboards WHERE id = $1`,
        [id]
      );
      if (!cur) return res.status(404).json({ error: 'Scoreboard not found' });
      return res.json({
        success: true,
        ...buildStatusResponse(cur, !!getSocketForScoreboard(id)),
      });
    }

    params.push(id);
    const row = await queryOne<StreamRow>(
      `UPDATE scoreboards SET ${sets.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, stream_key, stream_platform, twitch_stream_key, twitch_channel_name,
                 stream_enabled, stream_status, stream_last_error,
                 stream_started_at, stream_rtmp_url, stream_test_pattern,
                 stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });
    const isConnected = !!getSocketForScoreboard(id);
    res.json({
      success: true,
      ...buildStatusResponse(row, isConnected),
    });
  } catch (err) {
    console.error('[stream] encoding update error:', err);
    res.status(500).json({ error: 'Failed to update encoding settings' });
  }
});

/**
 * POST start stream. Platform-aware:
 *   - youtube → create a fresh broadcast via the OAuth client, get the
 *               per-broadcast stream name, and tell the Pi to push there.
 *   - twitch  → use the operator-pasted key + Twitch ingest URL directly.
 *               No broadcast lifecycle to manage.
 *
 * Body: { title?: string, description?: string, testPattern?: boolean }
 */
streamRouter.post('/:id/stream/start', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }

  // Pull everything we need to decide which path to take + validate preconditions.
  const sb = await queryOne<{
    youtube_channel_id: string | null;
    stream_platform: StreamPlatform;
    twitch_stream_key: string | null;
    twitch_channel_name: string | null;
    stream_status: string;
    stream_test_pattern: boolean;
    // Encoder settings — read here so we can include them in the
    // stream:cmd payload to the Pi (migration 002). output_width/height
    // can be NULL when the operator picked "Source (no scaling)".
    stream_output_width: number | null;
    stream_output_height: number | null;
    stream_fps: number;
    stream_audio_bitrate: string;
  }>(
    `SELECT youtube_channel_id, stream_platform, twitch_stream_key, twitch_channel_name,
            stream_status, stream_test_pattern,
            stream_output_width, stream_output_height, stream_fps, stream_audio_bitrate
     FROM scoreboards WHERE id = $1`,
    [id]
  );
  if (!sb) return res.status(404).json({ error: 'Scoreboard not found' });
  if (sb.stream_status === 'live' || sb.stream_status === 'starting') {
    return res.status(400).json({ error: `Stream already ${sb.stream_status}. Stop it first.` });
  }

  // Check Pi is connected before any platform-specific work (creating a
  // YouTube broadcast burns API quota, Twitch needs the operator to have
  // pasted a key).
  const piSocket = getSocketForScoreboard(id);
  if (!piSocket) {
    await queryOne(
      `UPDATE scoreboards
       SET stream_status = 'error', stream_last_error = 'Pi is not connected'
       WHERE id = $1`,
      [id]
    );
    emitStreamStatus(id, {
      status: 'error',
      lastError: 'Pi is not connected',
      startedAt: null,
      rtmpUrl: null,
      isConnected: false,
      platform: sb.stream_platform,
      streamKeyMasked: undefined,
      streamEnabled: false,
    });
    return res.status(503).json({ error: 'Pi is not connected. Cannot start stream.' });
  }

  // Move status to 'starting' immediately so the UI updates while we wait
  // for YouTube (1-3s) — Twitch is instant so this still feels responsive.
  await queryOne(
    `UPDATE scoreboards SET stream_status = 'starting', stream_last_error = NULL WHERE id = $1`,
    [id]
  );
  emitStreamStatus(id, {
    status: 'starting',
    lastError: null,
    startedAt: null,
    rtmpUrl: null,
    isConnected: true,
    platform: sb.stream_platform,
    streamKeyMasked: undefined,
    streamEnabled: true,
  });

  try {
    // testPattern precedence: explicit body field wins, otherwise fall back
    // to the persistent setting in DB.
    const testPattern = req.body?.testPattern !== undefined
      ? Boolean(req.body.testPattern)
      : !!sb.stream_test_pattern;

    // ── Platform-specific key + URL resolution ─────────────────────────
    let streamKey: string;
    let rtmpUrl: string;
    let broadcastId: string | undefined;

    if (sb.stream_platform === 'twitch') {
      if (!sb.twitch_stream_key) {
        throw new Error('No Twitch stream key configured. Add one in Settings → Live Stream → Twitch.');
      }
      // We also need the channel name to build the watch-page embed URL.
      // Without it the Pi would happily stream to Twitch but spectators
      // would see "Stream offline" — fail fast instead.
      if (!sb.twitch_channel_name || !sb.twitch_channel_name.trim()) {
        throw new Error('No Twitch channel name configured. Add one in Settings → Live Stream → Twitch.');
      }
      // Twitch's RTMP URL is fixed — same global ingest for all channels.
      streamKey = sb.twitch_stream_key;
      rtmpUrl = 'rtmp://live.twitch.tv/app';
      // broadcastId is unused for Twitch — Helix doesn't have a broadcast lifecycle.
    } else {
      // YouTube path — OAuth-driven, creates a fresh broadcast per start.
      if (!sb.youtube_channel_id) {
        throw new Error('No YouTube account connected. Connect one in Settings first.');
      }
      const yt = await createBroadcastAndStartStream(id, {
        title: req.body?.title,
        description: req.body?.description,
      });
      streamKey = yt.streamName;
      rtmpUrl = yt.rtmpUrl;
      broadcastId = yt.broadcastId;
    }

    // Persist the resolved rtmp_url so /status returns the active ingest.
    await queryOne(
      `UPDATE scoreboards SET stream_rtmp_url = $1 WHERE id = $2`,
      [rtmpUrl, id]
    );

    // Tell the Pi to start pushing. Payload shape matches the documented
    // Socket.IO contract — Pi doesn't care which platform it is, just the
    // URL + key.
    //
    // Encoding settings (outputWidth/Height/fps/audioBitrate) are
    // forwarded as the Pi's stream_scoreboard.py CLI flags. The Pi
    // applies them when it spawns ffmpeg; no need to re-spawn the
    // streamer for a config change (start_streaming takes new args
    // on each call). NULL output dims = "no scaling" — the Pi passes
    // capture width through to encoder output.
    piSocket.emit('stream:cmd', {
      action: 'start',
      streamKey,
      rtmpUrl,
      broadcastId,
      testPattern,
      outputWidth: sb.stream_output_width,
      outputHeight: sb.stream_output_height,
      fps: sb.stream_fps,
      audioBitrate: sb.stream_audio_bitrate,
    });

    res.json({
      success: true,
      status: 'starting',
      platform: sb.stream_platform,
      rtmpUrl,
      isConnected: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stream] start error for scoreboard ${id} (${sb.stream_platform}):`, err);
    await queryOne(
      `UPDATE scoreboards
       SET stream_status = 'error', stream_last_error = $2
       WHERE id = $1`,
      [id, message]
    );
    emitStreamStatus(id, {
      status: 'error',
      lastError: message,
      startedAt: null,
      rtmpUrl: null,
      isConnected: true,
      platform: sb.stream_platform,
      streamKeyMasked: undefined,
      streamEnabled: true,
    });
    res.status(500).json({ error: message });
  }
});

/**
 * POST stop stream. Tells the Pi to stop pushing (via socket) and — for
 * YouTube — transitions the broadcast to 'complete'. Twitch has nothing to
 * clean up server-side (the stream just stops).
 */
streamRouter.post('/:id/stream/stop', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }

  const row = await queryOne<{ stream_status: string; stream_platform: StreamPlatform }>(
    'SELECT stream_status, stream_platform FROM scoreboards WHERE id = $1',
    [id]
  );
  if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

  // Tell Pi to stop ffmpeg first (it can take a moment to finalize)
  const piSocket = getSocketForScoreboard(id);
  if (piSocket) {
    piSocket.emit('stream:cmd', { action: 'stop' });
  }

  await queryOne(
    `UPDATE scoreboards SET stream_status = 'stopping', stream_started_at = NULL WHERE id = $1`,
    [id]
  );
  emitStreamStatus(id, {
    status: 'stopping',
    lastError: null,
    startedAt: null,
    rtmpUrl: null,
    isConnected: !!piSocket,
    platform: row.stream_platform,
    streamKeyMasked: undefined,
    streamEnabled: true,
  });

  // End the broadcast only for YouTube (Twitch has no lifecycle to close).
  if (row.stream_platform === 'youtube') {
    try {
      await endBroadcast(id);
    } catch (err) {
      console.error(`[stream] endBroadcast error for scoreboard ${id}:`, err);
      // Continue — local state is already updated; broadcast may have already ended
    }
  }

  // Re-emit final idle status so the UI catches up
  emitStreamStatus(id, {
    status: 'idle',
    lastError: null,
    startedAt: null,
    rtmpUrl: null,
    isConnected: !!getSocketForScoreboard(id),
    platform: row.stream_platform,
    streamKeyMasked: undefined,
    streamEnabled: true,
  });

  res.json({
    success: true,
    status: 'idle',
    platform: row.stream_platform,
    piConnected: !!piSocket,
  });
});

/**
 * POST hard-reset the stream for a scoreboard. Cross-mode — works for
 * youtube, twitch, and direct. Recovers from wedged 'starting' / 'stopping'
 * / 'error' states by:
 *   1. Killing any direct-mode ffmpeg listener with SIGKILL
 *   2. Emitting stream:cmd { action: 'reset' } to the Pi so it tears
 *      down its ffmpeg pipeline
 *   3. Ending any YouTube broadcast that's stuck in 'ready' or 'testing'
 *   4. Forcing the DB row to stream_status='idle', clearing
 *      stream_last_error, stream_started_at, stream_rtmp_url
 *   5. Emitting stream:status idle so the watch page resets
 *
 * Refuses if the stream is currently 'live' AND in YouTube mode with an
 * active broadcast — the operator should Stop first for that case.
 * Direct and Twitch modes always allow reset (the Pi ffmpeg is killed).
 */
streamRouter.post('/:id/stream/reset', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid scoreboard id' });
  }

  const row = await queryOne<{
    stream_status: string;
    stream_platform: StreamPlatform;
    stream_mode: string;
  }>(
    'SELECT stream_status, stream_platform, stream_mode FROM scoreboards WHERE id = $1',
    [id]
  );
  if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

  // 1. Force-stop any direct-mode listener (SIGKILL — the polite SIGTERM
  //    path is what got us into this mess).
  if (row.stream_mode === 'direct') {
    try {
      await resetDirectStream(id);
    } catch (err) {
      console.error(`[stream] reset: resetDirectStream error for scoreboard ${id}:`, err);
      // Continue — DB cleanup below still runs
    }
  }

  // 2. Tell the Pi to reset (covers YouTube/Twitch modes where there's
  //    no Mac-side listener to kill, and direct mode where the Pi's own
  //    ffmpeg pipeline might be wedged independently).
  const piSocket = getSocketForScoreboard(id);
  if (piSocket) {
    piSocket.emit('stream:cmd', { action: 'reset' });
  }

  // 3. End any YouTube broadcast stuck in the lifecycle. Best-effort —
  //    the broadcast may already be 'complete' or never got created.
  if (row.stream_platform === 'youtube') {
    try {
      await endBroadcast(id);
    } catch (err) {
      console.error(`[stream] reset: endBroadcast error for scoreboard ${id}:`, err);
    }
  }

  // 4. Force the DB row to idle. This is the source-of-truth fix — even
  //    if the Pi never acks, the next Start call will succeed because
  //    stream_status is no longer 'starting'/'stopping'.
  await queryOne(
    `UPDATE scoreboards
     SET stream_status = 'idle',
         stream_last_error = NULL,
         stream_started_at = NULL,
         stream_rtmp_url = NULL
     WHERE id = $1`,
    [id]
  );

  // 5. Emit fresh idle status so all open sockets (operator UI + watch
  //    page) reset their cached state immediately.
  emitStreamStatus(id, {
    status: 'idle',
    lastError: null,
    startedAt: null,
    rtmpUrl: null,
    isConnected: !!getSocketForScoreboard(id),
    platform: row.stream_platform,
    streamKeyMasked: undefined,
    streamEnabled: true,
  });

  console.log(`[stream] reset complete for scoreboard ${id} (was ${row.stream_status}, mode=${row.stream_mode}, platform=${row.stream_platform})`);

  res.json({
    success: true,
    status: 'idle',
    previousStatus: row.stream_status,
    platform: row.stream_platform,
    mode: row.stream_mode,
  });
});

// ── Internal helper for socket.ts to update DB and validate status ───────

/**
 * Called by socket.ts when the Pi sends stream:status. Validates and persists.
 */
export async function applyStreamStatusFromPi(
  scoreboardId: number,
  payload: { status: string; error?: string | null }
): Promise<{ status: StreamStatus; startedAt: string | null; rtmpUrl: string | null; platform: StreamPlatform } | null> {
  if (!VALID_STATUSES.includes(payload.status as StreamStatus)) {
    console.warn(`[stream] invalid status from Pi: ${payload.status}`);
    return null;
  }
  const status = payload.status as StreamStatus;

  // Update DB. Only set started_at when transitioning to 'live'.
  const row = await queryOne<{
    stream_started_at: Date | null;
    stream_rtmp_url: string | null;
    stream_platform: StreamPlatform;
  }>(
    `UPDATE scoreboards
     SET stream_status = $2,
         stream_last_error = $3,
         stream_started_at = CASE
           WHEN $2 = 'live' AND stream_status <> 'live' THEN NOW()
           WHEN $2 IN ('idle', 'error') THEN NULL
           ELSE stream_started_at
         END
     WHERE id = $1
     RETURNING stream_started_at, stream_rtmp_url, stream_platform`,
    [scoreboardId, status, payload.error || null]
  );
  if (!row) return null;

  const startedAt =
    row.stream_started_at instanceof Date
      ? row.stream_started_at.toISOString()
      : row.stream_started_at
        ? String(row.stream_started_at)
        : null;

  return {
    status,
    startedAt,
    rtmpUrl: row.stream_rtmp_url,
    platform: row.stream_platform,
  };
}
