/**
 * Socket.io client hook for real-time scoreboard state updates.
 *
 * - Connects to backend Socket.io, subscribes to a scoreboard room
 * - Receives 'state:update' broadcasts from other operators / REST saves
 * - Exposes pushState() so the editor can push changes directly through
 *   the socket — backend persists + broadcasts to display boards in one
 *   hop, no REST round trip
 *
 * IMPORTANT: Cloudflare Tunnel aggressively closes WebSocket connections,
 * causing the socket to disconnect every ~30-60s and miss pushes. As a
 * safety net, we also poll the scoreboard state every 2s. When both are
 * active, the socket wins (faster). When the socket drops, polling keeps
 * the display live without the user noticing.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { DisplayState } from './types.js';
import { getScoreboard } from './api.js';

const POLL_FALLBACK_MS = 2_000;

/** Convert a full Scoreboard into the compact DisplayState shape. */
function toDisplayState(s: {
  homeScore: number;
  awayScore: number;
  inning: number;
  half: string;
  balls: number;
  strikes: number;
  outs: number;
  runnerOnFirst: boolean;
  runnerOnSecond: boolean;
  runnerOnThird: boolean;
  batterName: string;
  batterNumber: string;
  pitcherName: string;
  pitcherNumber: string;
  stateVersion: number;
}): DisplayState {
  return {
    h: s.homeScore,
    a: s.awayScore,
    i: s.inning,
    hf: s.half === 'bottom' ? 'b' : 't',
    b: s.balls,
    s: s.strikes,
    o: s.outs,
    r1: s.runnerOnFirst ? 1 : 0,
    r2: s.runnerOnSecond ? 1 : 0,
    r3: s.runnerOnThird ? 1 : 0,
    bn: s.batterName || '',
    bj: s.batterNumber || '',
    pn: s.pitcherName || '',
    pj: s.pitcherNumber || '',
    v: s.stateVersion,
  };
}

export function useScoreboardSocket(
  scoreboardId: number | null,
  onUpdate: (state: DisplayState) => void,
): {
  connected: boolean;
  pushState: (patch: Record<string, number | string | null>) => void;
} {
  const socketRef = useRef<Socket | null>(null);
  const callbackRef = useRef(onUpdate);
  const idRef = useRef(scoreboardId);
  const [connected, setConnected] = useState(false);

  callbackRef.current = onUpdate;
  idRef.current = scoreboardId;

  useEffect(() => {
    if (scoreboardId === null) return;

    const socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,      // wait 500ms before first reconnect (was 1000 default)
      reconnectionDelayMax: 3000,  // cap at 3s (was 5000 default)
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;
    // Expose on window so other components (e.g. StreamPanel) can attach
    // additional event listeners without spinning up a second socket.
    (window as unknown as { __io?: typeof socket }).__io = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe', scoreboardId);
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('state:update', (payload: DisplayState) => {
      callbackRef.current(payload);
    });

    socket.on('connect_error', (err: Error) => {
      console.warn('[socket] connect error:', err.message);
      setConnected(false);
    });

    // ── Polling fallback ───────────────────────────────────────────────
    // Cloudflare Tunnel drops WebSockets every ~30-60s. While the socket
    // is the primary path (instant pushes), this poll ensures the display
    // stays current even during disconnect gaps. Runs every 2s regardless
    // of socket state — cheap insurance.
    const pollInterval = setInterval(async () => {
      if (scoreboardId === null) return;
      try {
        const sb = await getScoreboard(scoreboardId);
        callbackRef.current(toDisplayState(sb));
      } catch (err) {
        // Silent — the socket may still be working
      }
    }, POLL_FALLBACK_MS);

    return () => {
      clearInterval(pollInterval);
      socket.emit('unsubscribe', scoreboardId);
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [scoreboardId]);

  /** Push a state patch directly through the socket (no REST round trip). */
  const pushState = useCallback((patch: Record<string, number | string | null>) => {
    const socket = socketRef.current;
    const id = idRef.current;
    if (!socket || !socket.connected || id === null) return;
    socket.emit('state:change', { scoreboardId: id, patch });
  }, []);

  return { connected, pushState };
}
