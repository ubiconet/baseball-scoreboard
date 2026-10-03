import { useEffect, useRef, useState } from 'react';
import {
  fetchDisplayState,
  lookupScoreboardIdByIdentifier,
} from '../api.js';
import { io, type Socket } from 'socket.io-client';
import Hls from 'hls.js';
import type { DisplayState, StreamInfo } from '../types.js';

// When the watch page is served from Netlify (a static CDN), the
// `/stream-hls/*` proxy rewrite can be unreliable for live streams —
// Netlify's edge applies HTTP/2 flow-control on long-lived streaming
// connections, which can stall hls.js mid-playback. To get reliable
// live playback, point the HLS player directly at the backend when
// the page is loaded from Netlify. The backend is reachable directly
// via the cloudflare tunnel at https://scoreboard.ubiconet.com —
// and the HLS playlist/segments are CORS-accessible from any origin.
const HLS_DIRECT_BASE = 'https://scoreboard.ubiconet.com';

/**
 * Public, read-only scoreboard viewer.
 *
 * Mounted at /watch/:identifier — meant to be shared with spectators.
 * No auth, no edit controls. Live state updates come through the same
 * socket.io room the editor uses; if the socket drops, the HTTP polling
 * fallback keeps the page current.
 *
 * Layout:
 *   - Top: game status (inning / half / live indicator) and team names
 *   - Middle: YouTube embed (when streaming) or "Stream offline" panel
 *   - Bottom: the scoreboard itself — home/away stacks with count indicators
 */
export default function PublicScoreboard({
  identifier,
}: {
  identifier: string;
}) {
  const [state, setState] = useState<DisplayState | null>(null);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: Socket | null = null;
    let pollTimer: number | null = null;

    async function start() {
      // Initial fetch — gives us the full payload (stream URL, team names, etc.)
      try {
        const initial = await fetchDisplayState(identifier);
        if (cancelled) return;
        setState(initial);
        setStream(initial.stream ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'Unable to load scoreboard'
        );
        return;
      }

      // Look up the numeric id so we can subscribe to the right socket room
      const id = await lookupScoreboardIdByIdentifier(identifier);
      if (cancelled) return;
      if (id === null) {
        // Scoreboard id not available — fall back to HTTP polling only
        startPolling();
        return;
      }

      // Subscribe to live updates
      socket = io({ transports: ['websocket', 'polling'] });
      socket.on('connect', () => socket?.emit('subscribe', id));
      socket.on('state:update', (payload: DisplayState) => {
        setState((prev) => ({ ...(prev ?? ({} as DisplayState)), ...payload }));
      });
      socket.on('stream:status', (payload: { status: StreamInfo['status'] }) => {
        // Stream status changed — re-fetch to get the latest URLs (broadcast
        // id only appears in the HTTP payload, not the compact socket push).
        fetchDisplayState(identifier)
          .then((fresh) => {
            setStream(fresh.stream ?? null);
            setState((prev) => ({ ...(prev ?? ({} as DisplayState)), ...fresh }));
          })
          .catch(() => {
            setStream((prev) => (prev ? { ...prev, status: payload.status } : prev));
          });
      });
      socket.on('disconnect', () => startPolling());
      socket.on('connect', () => {
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      });
      // Belt-and-suspenders: poll every 30s in case we miss a socket event
      startPolling(30_000);
    }

    function startPolling(intervalMs = 5_000) {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(async () => {
        try {
          const fresh = await fetchDisplayState(identifier);
          if (cancelled) return;
          setState((prev) => ({ ...(prev ?? ({} as DisplayState)), ...fresh }));
          setStream(fresh.stream ?? null);
        } catch {
          // Silent — socket may still be working
        }
      }, intervalMs);
    }

    start();

    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      // Tear down HLS instance on unmount
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [identifier]);

  // ── HLS playback wiring ────────────────────────────────────────────
  // The watch page may receive a directHlsUrl (m3u8 playlist) instead of
  // a YouTube embed. hls.js is required for Chrome/Firefox/Edge; Safari
  // supports HLS natively, so we use the native video.src on those.
  useEffect(() => {
    if (!stream?.directHlsUrl) return;
    if (stream.status !== 'live' && stream.status !== 'starting') return;
    const video = videoRef.current;
    if (!video) return;

    const url = stream.directHlsUrl;
    // Bypass the Netlify proxy for HLS when the page is hosted on Netlify.
    // The backend returns CORS-permissive headers, so the video can fetch
    // directly from scoreboard.ubiconet.com — sidestepping any HTTP/2
    // buffering issues Netlify's edge might apply to the proxied stream.
    const isOnNetlify = window.location.hostname.endsWith('.netlify.app');
    const hlsUrl = isOnNetlify
      ? url.replace(/^\/stream-hls/, `${HLS_DIRECT_BASE}/stream-hls`)
      : url;
    // Clean up any prior instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      // Chrome / Firefox / Edge path
      const hls = new Hls({
        // Live stream — keep the buffer small to avoid latency buildup
        liveDurationInfinity: true,
        backBufferLength: 30,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Mute by default — autoplay policies on mobile require this
        video.muted = true;
        video.play().catch(() => {
          // Autoplay can be blocked; user can click to play
        });
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        // Live streams are volatile — log only fatal errors
        if (data.fatal) {
          console.warn('[hls] fatal error', data.type, data.details);
        }
      });
      hlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari path — native HLS
      video.src = hlsUrl;
      video.muted = true;
      video.play().catch(() => {});
    }
  }, [stream?.directHlsUrl, stream?.status]);

  if (error) {
    return (
      <div className="public-scoreboard error">
        <h1>Scoreboard unavailable</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="public-scoreboard loading">
        <p>Loading…</p>
      </div>
    );
  }

  const isTop = state.hf === 't';
  const isLive = stream?.status === 'live' || stream?.status === 'starting';
  const homeName = state.home_team ?? 'HOME';
  const awayName = state.away_team ?? 'AWAY';

  return (
    <div className="public-scoreboard">
      <header className="psb-header">
        {/* Inning indicator removed — already shown in the center of the
            scoreboard via psb-inning-divider. The live badge stays here. */}
        {isLive && <span className="psb-live-badge">● LIVE</span>}
      </header>

      <section className="psb-board">
        <div className={`psb-team ${!isTop ? 'psb-team-at-bat' : ''}`}>
          <div className="psb-team-name">{homeName}</div>
          <div className="psb-team-score">{state.h}</div>
        </div>

        <div className="psb-inning-divider">
          <span>{isTop ? 'TOP' : 'BOT'}</span>
          <span className="psb-inning-number">{state.i}</span>
        </div>

        <div className={`psb-team ${isTop ? 'psb-team-at-bat' : ''}`}>
          <div className="psb-team-name">{awayName}</div>
          <div className="psb-team-score">{state.a}</div>
        </div>
      </section>

      {/* Baserunners hidden — GC doesn't expose per-play runner state
          reliably, so the diamond would just be empty/wrong. Remove this
          comment + restore the <Bases ... /> line if/when a reliable
          source becomes available.

          Batter + pitcher line also hidden — too much detail for the
          remote viewer. The on-screen overlay already shows the score;
          remove this comment + restore the <PlayerLine ... /> block
          if/when a use case calls for it again. */}

      <section className="psb-counts">
        <CountDots label="BALLS" filled={state.b} max={4} />
        <CountDots label="STRIKES" filled={state.s} max={3} />
        <CountOuts filled={state.o} max={3} />
      </section>

      <section className="psb-stream-wrap">
        {isLive && stream?.directHlsUrl ? (
          // Direct HLS mode: hls.js plays the local m3u8 stream.
          <div className="psb-stream">
            <div className="psb-stream-frame">
              <video
                ref={videoRef}
                controls
                autoPlay
                muted
                playsInline
              />
            </div>
            <span className="psb-watch-link muted">Direct HLS stream</span>
          </div>
        ) : isLive && stream?.platform === 'twitch' && stream?.twitchEmbedUrl ? (
          // Twitch Live: official player.twitch.tv iframe. Twitch requires
          // the parent= query param to match the embedding page's hostname
          // (their CSP rejects mismatches). We append it from the page's
          // current hostname — works for localhost dev, Netlify, and the
          // Cloudflare tunnel without configuration. For dev with arbitrary
          // hostnames, the operator can add the host as a Twitch-app domain.
          <div className="psb-stream">
            <div className="psb-stream-frame">
              <iframe
                src={`${stream.twitchEmbedUrl}&parent=${encodeURIComponent(window.location.hostname)}`}
                title={`Twitch stream — ${stream.twitchChannelName ?? ''}`}
                frameBorder={0}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            {stream.twitchWatchUrl && (
              <a
                className="psb-watch-link"
                href={stream.twitchWatchUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Twitch ↗
              </a>
            )}
          </div>
        ) : isLive && stream?.platform === 'twitch' ? (
          // Twitch is the active platform but the operator hasn't filled
          // in the channel name yet (the stream is live to Twitch, but we
          // can't build an embed URL without the channel name). Show a
          // targeted message so spectators aren't confused.
          <div className="psb-stream psb-stream-offline">
            <span className="psb-stream-icon">📺</span>
            <p>Twitch channel not configured — add one in Settings → Live Stream.</p>
          </div>
        ) : isLive && stream?.youtubeEmbedUrl ? (
          <div className="psb-stream">
            <div className="psb-stream-frame">
              <iframe
                src={stream.youtubeEmbedUrl}
                title="Live stream"
                frameBorder={0}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            {stream.youtubeWatchUrl && (
              <a
                className="psb-watch-link"
                href={stream.youtubeWatchUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                YouTube ↗
              </a>
            )}
          </div>
        ) : (
          <div className="psb-stream psb-stream-offline">
            <span className="psb-stream-icon">📺</span>
            <p>Stream offline</p>
          </div>
        )}
      </section>
    </div>
  );
}

/** Render 4 ball dots (or strike dots) — empty when count not yet set. */
function CountDots({
  label,
  filled,
  max,
}: {
  label: string;
  filled: number;
  max: number;
}) {
  return (
    <div className="psb-count">
      <div className="psb-count-label">{label}</div>
      <div className="psb-count-dots">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`psb-dot ${i < filled ? 'psb-dot-on' : ''}`} />
        ))}
      </div>
    </div>
  );
}

/** Outs use filled circles that turn red once all 3 are recorded. */
function CountOuts({ filled, max }: { filled: number; max: number }) {
  const allOut = filled >= max;
  return (
    <div className="psb-count">
      <div className="psb-count-label">OUTS</div>
      <div className="psb-count-dots">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={`psb-dot ${i < filled ? 'psb-dot-on' : ''} ${
              allOut ? 'psb-dot-out' : ''
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Baserunners (Bases component) hidden ────────────────────────
 * The diamond was wired to runner_on_first/second/third which the
 * GC poller no longer touches (PBP data is too inconsistent to
 * derive reliably, per user direction). Without a data source
 * the diamond would always be empty — better to hide it entirely.
 * Restore by removing this comment block + uncommenting <Bases ... />
 * in the render above.

 * Batter + pitcher line also hidden for the public viewer — too much
 * detail for a remote spectator. The editor still captures them via
 * UpdateStatePayload.batterName/.pitcherName (stored in DB and pushed
 * to the Pi overlay state for any future use). To restore the
 * viewer UI, uncomment the <PlayerLine ... /> block above and
 * re-add the PlayerLine component below. */
