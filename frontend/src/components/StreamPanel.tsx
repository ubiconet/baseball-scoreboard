/**
 * StreamPanel — Live stream status + Start/Stop controls.
 *
 * Shows the current streaming status (idle, starting, live, stopping, error)
 * with a colored status dot and Start/Stop buttons. Receives real-time updates
 * via the existing socket.io connection (stream:status events). Polls
 * /stream/status every 5s as a fallback.
 *
 * The active platform is shown in the panel header so the operator can see
 * at a glance which destination the next Start will push to. Both YouTube and
 * Twitch share the same Pi pipeline, so the control surface is identical —
 * only the header label changes.
 *
 * Props:
 *   - scoreboardId: number
 *   - initialStatus: StreamStatus from the scoreboard (server-known state at mount)
 *   - initialKeyMasked: string | undefined
 *   - initialRtmpUrl: string | null
 *   - initialPlatform: 'youtube' | 'twitch' | 'gamechanger' (which destination is active)
 *   - onRequestSettings: parent callback to open Settings tab
 */

import { useEffect, useState, useCallback } from 'react';
import {
  streamStart,
  streamStop,
  streamStatus,
  streamReset,
} from '../api.js';
import type { StreamStatusPayload, StreamStatus } from '../types.js';

type Platform = 'youtube' | 'twitch' | 'gamechanger';

interface Props {
  scoreboardId: number;
  initialStatus: StreamStatus;
  initialKeyMasked?: string;
  initialRtmpUrl: string | null;
  initialPlatform?: Platform;
  onRequestSettings?: () => void;
}

const POLL_INTERVAL_MS = 5_000;

const STATUS_DOT: Record<StreamStatus, string> = {
  idle: '#888',
  starting: '#fbbf24',
  live: '#22c55e',
  stopping: '#fbbf24',
  error: '#ef4444',
};

const STATUS_LABEL: Record<StreamStatus, string> = {
  idle: 'Idle',
  starting: 'Starting…',
  live: 'Live',
  stopping: 'Stopping…',
  error: 'Error',
};

const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: 'YouTube Live',
  twitch: 'Twitch',
  gamechanger: 'GameChanger',
};

function formatElapsed(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function StreamPanel({
  scoreboardId,
  initialStatus,
  initialKeyMasked,
  initialRtmpUrl,
  initialPlatform,
  onRequestSettings,
}: Props) {
  const [status, setStatus] = useState<StreamStatusPayload>({
    status: initialStatus,
    lastError: null,
    startedAt: null,
    rtmpUrl: initialRtmpUrl,
    isConnected: false,
    streamKeyMasked: initialKeyMasked,
    streamEnabled: !!initialKeyMasked,
    platform: initialPlatform,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  // Derive the active platform from state — falls back to initial / 'youtube'
  // when the backend hasn't sent one yet (e.g. legacy /status responses).
  const platform: Platform = status.platform ?? initialPlatform ?? 'youtube';

  // ── Listen for stream:status events on the global socket ─────────────
  useEffect(() => {
    // The socket is created by useScoreboardSocket and exposed on window.__io.
    // We attach a listener for stream:status events so the panel stays in
    // sync with backend updates without re-fetching.
    const io = (window as unknown as { __io?: { on: Function; off: Function } }).__io;
    if (!io) return;
    const handler = (p: StreamStatusPayload) => {
      setStatus((s) => ({
        ...s,
        ...p,
        // Preserve key mask on initial load
        streamKeyMasked: s.streamKeyMasked,
      }));
    };
    io.on('stream:status', handler);
    return () => io.off('stream:status', handler);
  }, [scoreboardId]);

  // ── Polling fallback (also catches initial state) ─────────────────────
  const refresh = useCallback(async () => {
    try {
      const s = await streamStatus(scoreboardId);
      setStatus((cur) => ({
        ...cur,
        status: s.status,
        lastError: s.lastError,
        startedAt: s.startedAt,
        rtmpUrl: s.rtmpUrl,
        isConnected: s.isConnected,
        platform: s.platform ?? cur.platform,
        streamKeyMasked: s.streamKeyMasked ?? cur.streamKeyMasked,
        streamEnabled: s.streamEnabled ?? cur.streamEnabled,
        testPattern: s.testPattern ?? cur.testPattern,
      }));
    } catch (err) {
      // Silent — polling is just a fallback
    }
  }, [scoreboardId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // ── Tick every second when live to update elapsed time ───────────────
  useEffect(() => {
    if (status.status !== 'live') return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status.status]);

  // ── Button handlers ────────────────────────────────────────────────────
  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      // Pass the persisted testPattern from server status. The backend
      // also falls back to its DB value when the body omits it, but
      // sending it explicitly makes the data flow easier to trace.
      // The active platform is read from the DB by the backend — no need
      // to pass it here (avoids drift if the operator changes platforms
      // between clicking Start and the request landing).
      const res = await streamStart(scoreboardId, { testPattern: !!status.testPattern });
      setStatus((s) => ({
        ...s,
        status: 'starting' as StreamStatus,
        platform: res.platform ?? s.platform,
        rtmpUrl: res.rtmpUrl ?? s.rtmpUrl,
        isConnected: res.isConnected,
      }));
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to start stream';
      setError(msg);
      // Surface credential-related errors by jumping to Settings.
      const m = msg.toLowerCase();
      if ((m.includes('youtube') || m.includes('twitch') || m.includes('gamechanger')) && onRequestSettings) {
        onRequestSettings();
      }
      // Refresh to get backend's view
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setError(null);
    try {
      await streamStop(scoreboardId);
      setStatus((s) => ({ ...s, status: 'stopping' as StreamStatus }));
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to stop stream';
      setError(msg);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const [confirmReset, setConfirmReset] = useState(false);

  const handleReset = async () => {
    setBusy(true);
    setError(null);
    try {
      await streamReset(scoreboardId);
      setStatus((s) => ({ ...s, status: 'idle' as StreamStatus, lastError: null }));
      setConfirmReset(false);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to reset stream';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  const isLive = status.status === 'live';
  const isTransitioning = status.status === 'starting' || status.status === 'stopping';
  const canStart = !isLive && !isTransitioning && status.streamEnabled !== false;
  const canStop = isLive || status.status === 'starting';
  const canReset = status.status === 'starting' || status.status === 'stopping' || status.status === 'error';

  // Reason Start is disabled — shown in a muted hint to help the operator.
  const disableReason = (() => {
    if (status.streamEnabled === false) {
      if (platform === 'twitch') {
        return 'No Twitch stream key configured. Add one in Settings.';
      }
      if (platform === 'gamechanger') {
        return 'No GameChanger RTMP URL + key configured. Add them in Settings.';
      }
      return 'No YouTube account connected. Connect one in Settings.';
    }
    if (isLive) return 'Stream is live — Stop first.';
    if (status.status === 'starting') return 'Stream is starting…';
    if (status.status === 'stopping') return 'Stream is stopping…';
    return null;
  })();

  return (
    <div className="card section stream-panel" data-testid="stream-panel">
      <h2 className="section-title">
        {PLATFORM_LABEL[platform]} Stream
        <span
          className="status-dot"
          style={{ backgroundColor: STATUS_DOT[status.status] }}
          title={STATUS_LABEL[status.status]}
        />
        <span className="status-label">{STATUS_LABEL[status.status]}</span>
      </h2>

      {error && <div className="error-banner">{error}</div>}

      {disableReason && (
        <p className="muted small" data-testid="stream-disable-reason">
          {disableReason}
        </p>
      )}

      {!status.streamEnabled && (
        <p className="muted small">
          No stream key configured. Go to <strong>⚙ Settings → Live Stream</strong> to set up.
        </p>
      )}

      {status.lastError && (
        <div className="error-banner small">
          <strong>Last error:</strong> {status.lastError}
        </div>
      )}

      {isLive && status.startedAt && (
        <p className="muted small">
          Live for <strong>{formatElapsed(status.startedAt)}</strong>
          {status.rtmpUrl && <> · RTMP: <code>{status.rtmpUrl}</code></>}
        </p>
      )}

      {status.status === 'idle' && status.startedAt === null && status.streamEnabled && (
        <p className="muted small">
          Ready to stream to <strong>{PLATFORM_LABEL[platform]}</strong>. Click Start to begin.
          {status.rtmpUrl && <> · Default RTMP: <code>{status.rtmpUrl}</code></>}
        </p>
      )}

      {canReset && !confirmReset && (
        <p className="muted small" data-testid="stream-reset-hint">
          Stream appears wedged — use <strong>Reset Stream</strong> if Stop won't recover.
        </p>
      )}

      <div className="stream-buttons">
        <button
          className="btn btn-primary"
          disabled={!canStart || busy}
          onClick={handleStart}
          data-testid="stream-start"
        >
          {status.status === 'starting' ? 'Starting…' : 'Start Stream'}
        </button>
        <button
          className="btn btn-danger"
          disabled={!canStop || busy}
          onClick={handleStop}
          data-testid="stream-stop"
        >
          {status.status === 'stopping' ? 'Stopping…' : 'Stop Stream'}
        </button>
        {canReset && (
          <>
            {!confirmReset ? (
              <button
                className="btn btn-warning"
                disabled={busy}
                onClick={() => setConfirmReset(true)}
                data-testid="stream-reset"
                title="Recover from a wedged start/stop state"
              >
                Reset Stream
              </button>
            ) : (
              <div className="reset-confirm" data-testid="stream-reset-confirm">
                <span className="reset-confirm-text">
                  This will kill any active ffmpeg and force idle.
                </span>
                <button
                  className="btn btn-warning"
                  disabled={busy}
                  onClick={handleReset}
                  data-testid="stream-reset-confirm-yes"
                >
                  Yes, reset
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setConfirmReset(false)}
                  data-testid="stream-reset-confirm-no"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Test pattern notice — controlled in Settings → Live Stream.
          Read-only here; the toggle there persists to the scoreboard
          and the next Start picks it up automatically. */}
      {status.testPattern && (
        <div
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem 0.75rem',
            background: 'rgba(240, 192, 64, 0.08)',
            border: '1px solid var(--yellow, #f0c040)',
            borderRadius: 6,
            fontSize: '0.85rem',
            color: 'var(--yellow, #f0c040)',
          }}
        >
          📺 Test pattern mode is on — camera will be bypassed.{' '}
          <button
            type="button"
            className="btn-link"
            onClick={onRequestSettings}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              textDecoration: 'underline',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
            }}
          >
            Turn off in Settings
          </button>
        </div>
      )}

      {status.isConnected === false && status.streamEnabled && (
        <p className="muted small">⚠ Pi is not connected. Start command will fail.</p>
      )}

      {status.isConnected && status.piRemoteAddress && (
        <p className="muted small" data-testid="stream-pi-address">
          📡 Pi connected from <code>{status.piRemoteAddress}</code>
          {status.piRemoteAddress.match(/^(?!192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|127\.)/) && (
            <span> · via Cloudflare Tunnel (LAN IP in your router's DHCP table)</span>
          )}
        </p>
      )}
    </div>
  );
}
