/**
 * Socket.io singleton + state change handler.
 *
 * - Singleton io instance avoids circular imports between index.ts and routes
 * - Room-based subscriptions for per-scoreboard filtering
 * - state:change handler: operator pushes a patch via socket, we persist
 *   to DB and broadcast the updated state to all OTHER subscribed clients
 *   (display boards, other operators) in one hop — no REST round trip
 * - stream:cmd / stream:status: control channel for the Pi streamer
 *   (Pi subscribes like a normal socket client, browser commands target it
 *    by scoreboard room)
 * - stream:preview: Pi → browser JPEG relay for the live camera preview
 *   (size + rate guarded, re-emitted to the scoreboard room)
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { queryOne } from './db.js';
import {
  mapRowToScoreboard,
  validateStateFields,
  stateFieldMap,
  type ScoreboardRow,
} from './state-helpers.js';
import { applyStreamStatusFromPi } from './routes/stream.js';
import type { StreamStatusPayload } from './types.js';

let ioInstance: SocketIOServer | null = null;

// Map of socket.id → { scoreboardId, role }
// 'role' distinguishes Pi streamers (which receive stream:cmd and reply with
// stream:status) from browser clients (which only consume state:update +
// stream:status for display). Without this, the stream router can't tell
// them apart and stream:cmd ends up hitting whichever socket joined last
// (usually the browser that just clicked "Start Stream").
interface SocketMetadata {
  scoreboardId: number;
  role: 'pi' | 'browser';
  remoteAddress?: string; // <ip>:<port> for Pi sockets — used to surface "which Pi is connected" in the operator UI so the operator can SSH without scanning the LAN.
}
const socketToScoreboard = new Map<string, SocketMetadata>();

// ── Camera preview relay guards ─────────────────────────────────────────
// stream:preview frames come from the Pi roughly once per second while the
// operator has the preview pane open. Cap the payload size and the relay
// rate so a buggy/compromised emitter can't flood the scoreboard room.
const PREVIEW_MAX_BYTES = 200 * 1024; // 200KB decoded JPEG
const PREVIEW_MIN_INTERVAL_MS = 500; // min spacing between relayed frames
const previewLastEmit = new Map<number, number>(); // scoreboardId → last emit ts

/**
 * Return the remote IP:port of the most-recently-connected Pi socket for
 * a scoreboard, or undefined if no Pi is currently subscribed. Used by
 * /api/scoreboards/:id/stream/status to tell the operator which Pi is
 * streaming — handy when the LAN layout has multiple Pis and the IP has
 * changed since boot.
 */
export function getPiRemoteAddress(scoreboardId: number): string | undefined {
  if (!ioInstance) return undefined;
  const room = scoreboardRoom(scoreboardId);
  const socketIds = ioInstance.sockets.adapter.rooms.get(room);
  if (!socketIds || socketIds.size === 0) return undefined;
  // Walk all Pi sockets in the room; prefer the most recently joined one
  // (matches getSocketForScoreboard's tiebreak so the address we report
  // is for the socket the backend is actually sending stream:cmd to).
  let addr: string | undefined;
  for (const id of socketIds) {
    const meta = socketToScoreboard.get(id);
    if (meta?.role !== 'pi') continue;
    if (meta.remoteAddress) addr = meta.remoteAddress;
  }
  return addr;
}

/** Called once at server startup from index.ts */
export function setSocketIO(io: SocketIOServer): void {
  ioInstance = io;
}

/** Room name convention for a given scoreboard ID */
export function scoreboardRoom(id: number): string {
  return `scoreboard:${id}`;
}

/**
 * Get the most-recently-subscribed socket for a scoreboard ID.
 * Used by the stream router to send stream:cmd to the Pi.
 * Returns undefined if no client is currently subscribed (Pi offline).
 */
export function getSocketForScoreboard(scoreboardId: number): Socket | undefined {
  if (!ioInstance) return undefined;
  const room = scoreboardRoom(scoreboardId);
  // Get all sockets in the room. Filter to only those that subscribed with
  // role='pi' (the streamer) — without this filter, the function returned
  // whichever socket joined the room last, which is usually the browser
  // that just clicked "Start Stream", and stream:cmd would silently go to
  // the browser instead of the Pi.
  const socketIds = ioInstance.sockets.adapter.rooms.get(room);
  if (!socketIds || socketIds.size === 0) return undefined;
  // Prefer a Pi socket — if multiple Pi sockets are in the room, take the
  // most recently joined one.
  let piSocket: Socket | undefined;
  let fallbackBrowserSocket: Socket | undefined;
  for (const id of socketIds) {
    const meta = socketToScoreboard.get(id);
    const sock = ioInstance.sockets.sockets.get(id);
    if (!sock) continue;
    if (meta?.role === 'pi') {
      piSocket = sock;
    } else if (!fallbackBrowserSocket) {
      fallbackBrowserSocket = sock;
    }
  }
  // Return the Pi socket if found, otherwise fall back to any browser
  // (this lets the stream endpoint at least send the cmd; if it's the
  // browser the cmd will be ignored, but no crash).
  return piSocket || fallbackBrowserSocket;
}

/**
 * Broadcast stream status to all subscribers of this scoreboard.
 * Browser UI uses this to show live stream indicator.
 */
export function emitStreamStatus(scoreboardId: number, payload: StreamStatusPayload): void {
  if (!ioInstance) return;
  ioInstance.to(scoreboardRoom(scoreboardId)).emit('stream:status', payload);
}

/**
 * Broadcast an "LED refresh" command to all subscribers of this scoreboard.
 * The Pi's scoreboard_leds.py listens for this event and re-initializes the
 * MAX7219 8x8 chain (same as a reboot, but without restarting the process).
 *
 * Browser UI also receives this event so it can show a "Refresh sent" toast.
 */
export function emitLedRefresh(
  scoreboardId: number,
  payload: { requestedAt: string; requestedBy?: string }
): void {
  if (!ioInstance) return;
  ioInstance.to(scoreboardRoom(scoreboardId)).emit('led:refresh', payload);
}

/**
 * Initialize Socket.io connection handling.
 */
export function initSocketServer(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    console.log(`[socket] connected: ${socket.id}`);

    socket.on('subscribe', async (payload: unknown) => {
      // Accept either a bare number (legacy browser) or an object with role
      // metadata. Pi streamer sends { scoreboardId, role: 'pi' } so the
      // backend can route stream:cmd events to it specifically (instead of
      // broadcasting to the whole room and hitting whichever browser socket
      // joined most recently).
      let scoreboardId: number;
      let role: 'pi' | 'browser' = 'browser';
      if (typeof payload === 'number' && Number.isFinite(payload)) {
        scoreboardId = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as { scoreboardId?: unknown; role?: unknown };
        if (typeof p.scoreboardId !== 'number' || !Number.isFinite(p.scoreboardId)) return;
        scoreboardId = p.scoreboardId;
        if (p.role === 'pi') role = 'pi';
      } else {
        return;
      }
      const room = scoreboardRoom(scoreboardId);
      socket.join(room);
      // Capture the Pi's remote IP for the operator UI. Only stored for
      // role='pi' so we don't pollute the map with browser clients.
      //
      // When the Pi connects via the Cloudflare Tunnel (production path),
      // socket.handshake.address is the tunnel daemon's localhost — useless
      // for SSH. The tunnel forwards the original peer in X-Forwarded-For,
      // which is what Steve actually wants to see. Fall back to handshake
      // address for direct connections (LAN dev).
      let remoteAddress: string | undefined;
      if (role === 'pi') {
        const xff = socket.handshake.headers['x-forwarded-for'];
        if (typeof xff === 'string') {
          // First entry in the comma-separated chain is the original client.
          remoteAddress = xff.split(',')[0].trim();
        } else if (Array.isArray(xff) && xff.length > 0) {
          remoteAddress = String(xff[0]).trim();
        }
        if (!remoteAddress) {
          remoteAddress = socket.handshake.address;
        }
      }
      socketToScoreboard.set(socket.id, { scoreboardId, role, remoteAddress });
      console.log(`[socket] ${socket.id} joined ${room} (role=${role}${remoteAddress ? ` from ${remoteAddress}` : ''})`);

      // Send current state immediately so newly-connected / reconnected
      // clients don't have to wait for the next push to see the live state.
      try {
        const row = await queryOne<ScoreboardRow>(
          'SELECT * FROM scoreboards WHERE id = $1',
          [scoreboardId]
        );
        if (row) {
          const sb = mapRowToScoreboard(row);
          socket.emit('state:update', buildDisplayPayload(sb));
          // Also send current stream status so the UI knows if a stream is live.
          socket.emit('stream:status', {
            status: sb.streamStatus,
            lastError: sb.streamLastError,
            startedAt: sb.streamStartedAt,
            rtmpUrl: sb.streamRtmpUrl,
            isConnected: true,
            platform: sb.streamPlatform,
            streamKeyMasked: sb.streamKeyMasked,
            streamEnabled: sb.streamEnabled,
          } satisfies StreamStatusPayload);
        }
      } catch (err) {
        console.error(`[socket] failed to send initial state to ${socket.id}:`, err);
      }
    });

    socket.on('unsubscribe', (payload: unknown) => {
      // Accept either bare number (legacy) or { scoreboardId } object
      let scoreboardId: number;
      if (typeof payload === 'number' && Number.isFinite(payload)) {
        scoreboardId = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as { scoreboardId?: unknown };
        if (typeof p.scoreboardId !== 'number') return;
        scoreboardId = p.scoreboardId;
      } else {
        return;
      }
      const room = scoreboardRoom(scoreboardId);
      socket.leave(room);
      console.log(`[socket] ${socket.id} left ${room}`);
      // If this socket's recorded scoreboard matches, clear it
      const meta = socketToScoreboard.get(socket.id);
      if (meta && meta.scoreboardId === scoreboardId) {
        socketToScoreboard.delete(socket.id);
      }
    });

    // ── Operator pushed a state change via socket ──────
    // { scoreboardId, patch } — persist + broadcast to other clients
    socket.on('state:change', async (data: unknown) => {
      const msg = data as { scoreboardId?: unknown; patch?: Record<string, unknown> };
      if (typeof msg?.scoreboardId !== 'number' || !msg?.patch) return;

      const patch = validateStateFields(msg.patch);
      if (!patch) return; // invalid keys — reject

      // Build SET clause from validated fields
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [camelKey, snakeCol] of Object.entries(stateFieldMap)) {
        if (camelKey in patch) {
          params.push(patch[camelKey as keyof typeof patch]);
          sets.push(`${snakeCol} = $${params.length}`);
        }
      }

      if (sets.length === 0) return;

      sets.push('state_version = state_version + 1');
      params.push(msg.scoreboardId);

      const row = await queryOne<ScoreboardRow>(
        `UPDATE scoreboards SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!row) return;

      const sb = mapRowToScoreboard(row);
      const room = scoreboardRoom(msg.scoreboardId);
      // Broadcast to all OTHER clients in the room
      socket.to(room).emit('state:update', buildDisplayPayload(sb));
      console.log(`[socket] state:change → broadcast to ${room} (v=${sb.stateVersion})`);
    });

    // ── Pi → Backend: stream status update ────────────────
    // { status: 'starting' | 'live' | 'idle' | 'error' | 'stopping', error?: string }
    socket.on('stream:status', async (data: unknown) => {
      const meta = socketToScoreboard.get(socket.id);
      if (!meta) {
        console.warn(`[socket] stream:status from ${socket.id} but no subscribed scoreboard`);
        return;
      }
      const scoreboardId = meta.scoreboardId;
      const msg = data as { status?: unknown; error?: unknown };
      if (typeof msg?.status !== 'string') return;

      const result = await applyStreamStatusFromPi(scoreboardId, {
        status: msg.status,
        error: typeof msg.error === 'string' ? msg.error : null,
      });
      if (!result) return;

      console.log(
        `[socket] stream:status from Pi for scoreboard ${scoreboardId}: ${result.status}` +
          (msg.error ? ` (${msg.error})` : '')
      );

      // Broadcast to all browsers in the room (Pi is one of them but won't react).
      emitStreamStatus(scoreboardId, {
        status: result.status,
        lastError: typeof msg.error === 'string' ? msg.error : null,
        startedAt: result.startedAt,
        rtmpUrl: result.rtmpUrl,
        isConnected: true,
        platform: result.platform,
        streamKeyMasked: undefined,
        streamEnabled: true,
      });
    });

    // ── Pi → Backend: camera preview frame ────────────────
    // The Pi emits these while its preview flag is on (see the
    // /stream/camera-tune route): { jpeg: <base64 JPEG> } roughly once
    // per second. We re-emit to the scoreboard room so browsers
    // subscribed to this scoreboard can render the live preview in
    // Settings → Audio & Image. Guards:
    //   - only Pi-role sockets may relay (a browser spoofing frames
    //     would otherwise broadcast to every spectator in the room)
    //   - decoded payload must stay under 200KB
    //   - at most one frame per 500ms per scoreboard (the Pi already
    //     throttles to ~1/s; this protects against a runaway emitter)
    socket.on('stream:preview', (data: unknown) => {
      const meta = socketToScoreboard.get(socket.id);
      if (!meta || meta.role !== 'pi') {
        return;
      }
      const msg = data as { jpeg?: unknown };
      if (typeof msg?.jpeg !== 'string' || msg.jpeg.length === 0) return;

      // Size guard — decode to measure real bytes (base64 inflates ~4/3).
      const jpegBytes = Buffer.from(msg.jpeg, 'base64');
      if (jpegBytes.length === 0 || jpegBytes.length > PREVIEW_MAX_BYTES) {
        console.warn(
          `[socket] stream:preview dropped for scoreboard ${meta.scoreboardId}: ` +
            `${jpegBytes.length} bytes exceeds ${PREVIEW_MAX_BYTES}`
        );
        return;
      }

      // Rate guard per scoreboard.
      const now = Date.now();
      const last = previewLastEmit.get(meta.scoreboardId) ?? 0;
      if (now - last < PREVIEW_MIN_INTERVAL_MS) return;
      previewLastEmit.set(meta.scoreboardId, now);

      if (ioInstance) {
        ioInstance
          .to(scoreboardRoom(meta.scoreboardId))
          .emit('stream:preview', { scoreboardId: meta.scoreboardId, jpeg: msg.jpeg });
      }
    });

    socket.on('disconnect', (reason: string) => {
      const scoreboardId = socketToScoreboard.get(socket.id);
      console.log(`[socket] disconnected: ${socket.id} (${reason})` + (scoreboardId ? ` [scoreboard ${scoreboardId}]` : ''));
      socketToScoreboard.delete(socket.id);
    });
  });
}

// ── Shared helpers ───────────────────────────────────────

/** Build compact display payload from full Scoreboard */
export function buildDisplayPayload(sb: {
  homeScore: number; awayScore: number; inning: number; half: string; balls: number; strikes: number; outs: number;
  runnerOnFirst?: boolean; runnerOnSecond?: boolean; runnerOnThird?: boolean;
  batterName?: string; batterNumber?: string; pitcherName?: string; pitcherNumber?: string;
  stateVersion: number;
  homeTeamName?: string; awayTeamName?: string; gcTeamName?: string | null;
}): {
  h: number; a: number; i: number; hf: 't' | 'b'; b: number; s: number; o: number;
  r1: number; r2: number; r3: number;
  bn: string; bj: string; pn: string; pj: string;
  v: number;
  // Team-identification flags for the viewer overlay. We send both the
  // raw names and a precomputed `isUs` flag — the Pi overlay can pick
  // whichever's simpler to render against. Both can be null when no GC
  // team is configured; in that case the overlay shows neither side as
  // the "home" team.
  htn?: string; atn?: string; gc?: string | null;
} {
  return {
    h: sb.homeScore, a: sb.awayScore, i: sb.inning,
    hf: sb.half === 'bottom' ? 'b' : 't',
    b: sb.balls, s: sb.strikes, o: sb.outs,
    r1: sb.runnerOnFirst ? 1 : 0,
    r2: sb.runnerOnSecond ? 1 : 0,
    r3: sb.runnerOnThird ? 1 : 0,
    bn: sb.batterName || '',
    bj: sb.batterNumber || '',
    pn: sb.pitcherName || '',
    pj: sb.pitcherNumber || '',
    v: sb.stateVersion,
    htn: sb.homeTeamName,
    atn: sb.awayTeamName,
    gc: sb.gcTeamName ?? null,
  };
}

/** Push a state update to all clients subscribed to this scoreboard (from REST routes) */
export function emitStateUpdate(sb: {
  id: number; homeScore: number; awayScore: number; inning: number; half: string; balls: number; strikes: number; outs: number;
  runnerOnFirst?: boolean; runnerOnSecond?: boolean; runnerOnThird?: boolean;
  batterName?: string; batterNumber?: string; pitcherName?: string; pitcherNumber?: string;
  stateVersion: number;
  homeTeamName?: string; awayTeamName?: string; gcTeamName?: string | null;
}): void {
  if (!ioInstance) return;
  ioInstance.to(scoreboardRoom(sb.id)).emit('state:update', buildDisplayPayload(sb));
}
