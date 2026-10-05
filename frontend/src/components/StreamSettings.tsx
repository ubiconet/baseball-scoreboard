/**
 * StreamSettings — Streaming platform selector + per-platform credentials.
 *
 * Supports two RTMP destinations:
 *   - YouTube Live — OAuth flow creates per-broadcast stream keys automatically
 *   - Twitch       — operator pastes the stream key from their Twitch dashboard
 *
 * Both can be configured at once; the operator picks which one is the active
 * destination with the platform selector. Switching the active platform does
 * NOT clear the inactive platform's credentials — they're stored in separate
 * DB columns.
 *
 * Test-pattern toggle (Pi pushes testsrc2 instead of camera) is independent
 * of the platform and persists to DB so the backend reads the same value on
 * every Start call.
 *
 * The "Audio & Image" section adds A/V tuning: a volume (gain dB) slider
 * saved with the encoding settings, brightness/contrast sliders that tune
 * the Pi's camera LIVE via /stream/camera-tune, and a live camera preview
 * fed by socket `stream:preview` events (JPEG base64 relayed by the backend).
 *
 * URL params handled:
 *   ?youtube=connected  — shown as a success banner after OAuth callback
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  streamStatus,
  youtubeDisconnect,
  youtubeStatus,
  setStreamTestPattern,
  setStreamPlatform,
  setStreamEncoding,
  cameraTune,
  setStreamPreview,
  updateTwitchStreamKey,
  type StreamStatusPayload,
} from '../api.js';
import type { Scoreboard } from '../types.js';

interface Props {
  scoreboardId: number;
  // Optional pre-loaded scoreboard so we can read streamPlatform on first
  // paint without a polling round-trip.
  scoreboard?: Scoreboard;
}

type Platform = 'youtube' | 'twitch';

interface YouTubeStatus {
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  email: string | null;
  tokenExpiresAt: string | null;
}

// Shared inline style for the encoding dropdowns so they pick up the
// same look as the Twitch inputs elsewhere in the file. Kept here
// (instead of CSS) to avoid a CSS round-trip for a 5-prop style.
const selectStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.5rem',
  background: 'var(--bg-alt, rgba(255,255,255,0.04))',
  border: '1px solid var(--border, #333)',
  borderRadius: 4,
  color: 'inherit',
  font: 'inherit',
};

export default function StreamSettings({ scoreboardId, scoreboard }: Props) {
  const [stream, setStream] = useState<StreamStatusPayload | null>(null);
  // Mirror the backend's streamPlatform so the radio shows the right one
  // selected even before /status polls return. Seeded from props.scoreboard
  // when available to avoid a flash.
  const [platform, setPlatform] = useState<Platform>(scoreboard?.streamPlatform ?? 'youtube');
  const [yt, setYt] = useState<YouTubeStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [savingTwitchKey, setSavingTwitchKey] = useState(false);
  const [savingTwitchLogin, setSavingTwitchLogin] = useState(false);
  const [clearingTwitch, setClearingTwitch] = useState(false);
  const [twitchKey, setTwitchKey] = useState('');
  // What the operator is currently typing for the Twitch login. Kept separate
  // from the stored value so we can show "Save" only when changed.
  const [twitchLoginDraft, setTwitchLoginDraft] = useState('');
  // Video encoding settings (Pi CLI flags). Drafts track what the operator
  // is currently picking in the dropdowns; the Save button sends them to
  // the backend and updates `stream.encoding` to mirror what persisted.
  const [encodingOutputPreset, setEncodingOutputPreset] = useState<string>('480x360');
  const [encodingFpsDraft, setEncodingFpsDraft] = useState<number>(30);
  const [encodingAudioDraft, setEncodingAudioDraft] = useState<string>('64k');
  const [savingEncoding, setSavingEncoding] = useState(false);
  // ── A/V tuning drafts (Audio & Image section) ─────────────────────
  // Volume is ffmpeg-side gain (dB); saved via the encoding PUT and
  // applied on the next Start Stream. Brightness/contrast are UVC
  // percentages (0..200, 100 = neutral) that ALSO tune the camera LIVE
  // (debounced POST /stream/camera-tune) while being drafted.
  const [audioGainDraft, setAudioGainDraft] = useState<number>(10);
  const [cameraBrightnessDraft, setCameraBrightnessDraft] = useState<number>(100);
  const [cameraContrastDraft, setCameraContrastDraft] = useState<number>(100);
  const [savingAV, setSavingAV] = useState(false);
  // Seeded-once guard so the 5s status poll doesn't fight the operator
  // mid-drag (same pattern as twitchLoginDraft).
  const avSeededRef = useRef(false);
  // Last values we pushed to the Pi live — the debounce effect compares
  // against this to avoid re-POSTing on every poll re-render.
  const lastTunedRef = useRef<{ b: number; c: number } | null>(null);
  // ── Live camera preview ───────────────────────────────────────────
  // previewOn toggles the Pi's ~1fps JPEG emitter; frames arrive via the
  // socket `stream:preview` event (JPEG base64) relayed by the backend.
  const [previewOn, setPreviewOn] = useState(false);
  const [previewJpeg, setPreviewJpeg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Detect ?youtube=connected (set by backend redirect after OAuth)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('youtube') === 'connected') {
      setInfo('YouTube account connected successfully!');
      // Strip the query param so a refresh doesn't re-show the message
      const url = new URL(window.location.href);
      url.searchParams.delete('youtube');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
  }, []);

  // Load current status (poll every 5s for connection changes during dev)
  const refresh = useCallback(async () => {
    try {
      const [s, y] = await Promise.all([
        streamStatus(scoreboardId),
        youtubeStatus(scoreboardId),
      ]);
      setStream(s);
      setYt(y);
      // Pull the active platform off the status payload (single source of
      // truth from the backend). Falls back to existing local state on miss.
      if (s.platform) setPlatform(s.platform);
      // Seed the encoding drafts from the persisted settings so the
      // dropdowns reflect what's actually configured. Done inside
      // refresh() (not useState initialiser) so they update after
      // a Save lands and the server's encoding field changes.
      if (s.encoding) {
        const enc = s.encoding;
        // Encode (outputWidth, outputHeight) into the preset key the
        // dropdown uses. null/null → "source", otherwise "WxH".
        const presetKey =
          enc.outputWidth === null || enc.outputHeight === null
            ? 'source'
            : `${enc.outputWidth}x${enc.outputHeight}`;
        setEncodingOutputPreset(presetKey);
        setEncodingFpsDraft(enc.fps);
        setEncodingAudioDraft(enc.audioBitrate);
        // Seed the Audio & Image drafts once (null camera values map to
        // the 100 "neutral" slider position). Guarded so later polls
        // don't clobber in-flight slider drags.
        if (!avSeededRef.current) {
          avSeededRef.current = true;
          const b = enc.cameraBrightness ?? 100;
          const c = enc.cameraContrast ?? 100;
          setAudioGainDraft(enc.audioGainDb ?? 10);
          setCameraBrightnessDraft(b);
          setCameraContrastDraft(c);
          lastTunedRef.current = { b, c };
        }
      }
      // Seed Twitch login input from the DB value (read-only — not
      // the key itself, just the login). The draft is only initialised
      // once when the scoreboard first loads; we don't want to clobber
      // the operator's typing on every poll.
      if (
        scoreboard?.twitchChannelName != null &&
        twitchLoginDraft === ''
      ) {
        setTwitchLoginDraft(scoreboard.twitchChannelName);
      }
    } catch {
      setError('Failed to load stream status');
    }
  }, [scoreboardId, scoreboard?.twitchChannelName, twitchLoginDraft]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  // ── Live camera tuning (debounced) ──────────────────────────────────
  // Brightness/contrast slider drags POST /stream/camera-tune ~400ms after
  // the operator stops moving, so the effect on the camera (and preview)
  // is live without hammering the socket. Skipped until the drafts are
  // seeded and skipped when the values match what we last sent.
  useEffect(() => {
    const last = lastTunedRef.current;
    if (!last) return; // drafts not seeded yet
    if (cameraBrightnessDraft === last.b && cameraContrastDraft === last.c) return;
    const t = setTimeout(() => {
      cameraTune(scoreboardId, {
        brightness: cameraBrightnessDraft,
        contrast: cameraContrastDraft,
      })
        .then(() => {
          lastTunedRef.current = { b: cameraBrightnessDraft, c: cameraContrastDraft };
        })
        .catch(() => {
          // Non-fatal: live tuning is best-effort (Pi may be offline).
          // The values still persist via the Save button.
        });
    }, 400);
    return () => clearTimeout(t);
  }, [cameraBrightnessDraft, cameraContrastDraft, scoreboardId]);

  // ── Camera preview: socket subscription + Pi emitter toggle ─────────
  // While previewOn: tell the Pi to start emitting frames and listen for
  // the backend-relayed stream:preview events. On off/unmount: stop the
  // emitter and unsubscribe. The socket instance is the app-wide one
  // created by useScoreboardSocket and exposed on window.__io (same
  // pattern as StreamPanel's stream:status listener).
  useEffect(() => {
    if (!previewOn) return;
    cameraTune(scoreboardId, { preview: true }).catch(() => {
      // Pi may be offline — the "waiting for frames…" state covers it.
    });
    const io = (window as unknown as { __io?: { on: Function; off: Function } }).__io;
    const handler = (p: { scoreboardId?: number; jpeg?: string }) => {
      if (!p || typeof p.jpeg !== 'string' || p.jpeg.length === 0) return;
      if (typeof p.scoreboardId === 'number' && p.scoreboardId !== scoreboardId) return;
      setPreviewJpeg(p.jpeg);
    };
    if (io) io.on('stream:preview', handler);
    return () => {
      if (io) io.off('stream:preview', handler);
      setStreamPreview(scoreboardId, false).catch(() => {
        // Best-effort — the Pi also stops if the socket drops.
      });
    };
  }, [previewOn, scoreboardId]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleConnect = () => {
    // Backend handles redirect to Google; the cookie carries our scoreboardId.
    window.location.href = `/api/auth/youtube/start?scoreboardId=${scoreboardId}`;
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect YouTube account? You will not be able to stream until reconnected.')) {
      return;
    }
    setDisconnecting(true);
    setError(null);
    try {
      await youtubeDisconnect(scoreboardId);
      setInfo('YouTube account disconnected.');
      const y = await youtubeStatus(scoreboardId);
      setYt(y);
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  // Test-pattern toggle — persists to DB, independent of platform.
  const handleTestPatternToggle = async (enabled: boolean) => {
    setError(null);
    setInfo(null);
    // Optimistic local update so the checkbox feels instant
    setStream((s: StreamStatusPayload | null) => (s ? { ...s, testPattern: enabled } : s));
    try {
      const updated = await setStreamTestPattern(scoreboardId, enabled);
      setStream(updated);
      setInfo(
        enabled
          ? 'Test pattern enabled — next Start Stream will push the ffmpeg test pattern.'
          : 'Test pattern disabled — next Start Stream will use the camera.'
      );
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to update test pattern');
      setStream((s: StreamStatusPayload | null) => (s ? { ...s, testPattern: !enabled } : s));
    }
  };

  // Switch which platform is the active streaming destination. Backend
  // refuses mid-stream and when the requested platform has no credentials.
  const handlePlatformSwitch = async (next: Platform) => {
    if (next === platform) return;
    setError(null);
    setInfo(null);
    setSwitching(true);
    // Optimistic flip so the radio updates immediately
    const prev = platform;
    setPlatform(next);
    try {
      const updated = await setStreamPlatform(scoreboardId, next);
      setStream(updated);
      setInfo(`Streaming destination switched to ${next === 'youtube' ? 'YouTube' : 'Twitch'}.`);
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to switch streaming destination');
      setPlatform(prev); // revert
    } finally {
      setSwitching(false);
    }
  };

  // Save the Twitch stream key. We never keep the typed key around in
  // component state beyond this submit — the backend responds with a
  // masked version and we drop the raw value. If the operator needs to
  // change the key, they re-type it.
  const handleSaveTwitchKey = async () => {
    if (!twitchKey.trim()) {
      setError('Twitch stream key cannot be empty.');
      return;
    }
    setError(null);
    setInfo(null);
    setSavingTwitchKey(true);
    try {
      const updated = await updateTwitchStreamKey(scoreboardId, {
        streamKey: twitchKey.trim(),
      });
      setStream(updated);
      setTwitchKey(''); // drop from local state immediately
      setInfo('Twitch stream key saved.');
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to save Twitch stream key');
    } finally {
      setSavingTwitchKey(false);
    }
  };

  // Save the Twitch channel login (separate from the key so the operator
  // can update one without touching the other). We lowercase + validate
  // client-side as a first line of defence; the backend re-validates.
  const handleSaveTwitchLogin = async () => {
    const loginTrimmed = twitchLoginDraft.trim();
    if (!loginTrimmed) {
      setError('Twitch channel login cannot be empty.');
      return;
    }
    if (/\s/.test(loginTrimmed)) {
      setError('Twitch channel login cannot contain spaces.');
      return;
    }
    if (!/^[a-z0-9_]+$/i.test(loginTrimmed)) {
      setError('Twitch channel login can only contain letters, numbers, and underscores.');
      return;
    }
    setError(null);
    setInfo(null);
    setSavingTwitchLogin(true);
    try {
      // The PUT /twitch/key endpoint takes both fields; to update the login
      // alone we pass an empty streamKey (which the backend treats as
      // "don't change"). The backend normalises to lowercase server-side
      // so the saved value matches what Twitch actually expects.
      const updated = await updateTwitchStreamKey(scoreboardId, {
        streamKey: '',
        channelName: loginTrimmed.toLowerCase(),
      });
      setStream(updated);
      setInfo(`Twitch channel login set to ${loginTrimmed.toLowerCase()}.`);
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to save Twitch channel login');
    } finally {
      setSavingTwitchLogin(false);
    }
  };

  // Clear the stored Twitch key entirely. Leaves the channel login alone —
  // the operator may want to keep the channel but rotate the key.
  const handleClearTwitch = async () => {
    if (!confirm('Clear the stored Twitch stream key? You will need to paste a new one before streaming to Twitch.')) {
      return;
    }
    setError(null);
    setInfo(null);
    setClearingTwitch(true);
    try {
      const updated = await updateTwitchStreamKey(scoreboardId, { streamKey: '' });
      setStream(updated);
      setInfo('Twitch stream key cleared.');
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to clear Twitch stream key');
    } finally {
      setClearingTwitch(false);
    }
  };

  // Persist the encoding dropdown values. Backend accepts partial
  // updates — we send only the fields that differ from the currently
  // persisted values so a Save click without changes is a cheap no-op
  // round-trip (the backend handles the empty-SET case too but we
  // trim further to keep the payload clear).
  const handleSaveEncoding = async () => {
    setError(null);
    setInfo(null);
    setSavingEncoding(true);
    // Decode the preset dropdown value into (width, height | null).
    let outW: number | null = null;
    let outH: number | null = null;
    if (encodingOutputPreset === 'source') {
      outW = null;
      outH = null;
    } else {
      const m = encodingOutputPreset.match(/^(\d+)x(\d+)$/);
      if (m) {
        outW = parseInt(m[1], 10);
        outH = parseInt(m[2], 10);
      } else {
        setError(`Unknown output preset: ${encodingOutputPreset}`);
        setSavingEncoding(false);
        return;
      }
    }
    try {
      const updated = await setStreamEncoding(scoreboardId, {
        outputWidth: outW,
        outputHeight: outH,
        fps: encodingFpsDraft,
        audioBitrate: encodingAudioDraft,
      });
      setStream(updated);
      setInfo('Video encoding settings saved. Stop and Start the stream to apply.');
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to save encoding settings');
    } finally {
      setSavingEncoding(false);
    }
  };

  // Persist the Audio & Image drafts (volume + camera knobs) via the
  // encoding PUT. Volume only takes effect on the next Start Stream —
  // helper text in the section says so. Brightness/contrast were already
  // applied live by the debounced camera-tune POST; saving persists them
  // so future streams re-apply them.
  const handleSaveAV = async () => {
    setError(null);
    setInfo(null);
    setSavingAV(true);
    try {
      const updated = await setStreamEncoding(scoreboardId, {
        audioGainDb: audioGainDraft,
        cameraBrightness: cameraBrightnessDraft,
        cameraContrast: cameraContrastDraft,
      });
      setStream(updated);
      setInfo('Audio & image settings saved. Volume applies on the next Start Stream.');
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || 'Failed to save audio & image settings');
    } finally {
      setSavingAV(false);
    }
  };

  // Toggle the live camera preview. The emitter on/off POST and the
  // socket (un)subscription live in the previewOn effect above; here we
  // just flip state and clear any stale frame.
  const handlePreviewToggle = () => {
    setPreviewOn((on) => !on);
    setPreviewJpeg(null);
  };

  if (!stream || !yt) {
    return (
      <section className="card section stream-settings">
        <h2 className="section-title">Live Stream</h2>
        <p className="muted small">Loading…</p>
      </section>
    );
  }

  // Is the active platform ready (so Start can be enabled)? The StreamPanel
  // is the authoritative source for that, but we mirror the state here so
  // the Settings UI can show a helpful "go set up <platform>" hint when the
  // active platform isn't ready.
  const twitchConfigured = !!scoreboard?.twitchStreamKeyMasked;
  const youtubeConfigured = yt.connected;
  const activeReady = platform === 'youtube' ? youtubeConfigured : twitchConfigured;

  return (
    <section className="card section stream-settings">
      <h2 className="section-title">Live Stream</h2>
      <p className="muted small">
        Configure YouTube and/or Twitch, then choose which one is the active
        streaming destination. Both share the same Pi camera pipeline — only
        the RTMP destination changes.
      </p>

      {/* ── Pi connection diagnostics ─────────────────────────────────────
          The streaming Pi's IP can change between sessions (DHCP re-lease
          or hardware swap). Rather than asking the operator to scan the LAN
          when they need to SSH in, we surface the IP that the backend sees
          on the Pi's socket.io subscribe event. Updated live — no refresh. */}
      <div
        className="pi-connection-info"
        style={{
          margin: '0.75rem 0',
          padding: '0.5rem 0.75rem',
          background: stream?.isConnected
            ? 'rgba(34, 197, 94, 0.06)'
            : 'rgba(239, 68, 68, 0.06)',
          border: `1px solid ${stream?.isConnected ? '#22c55e' : '#ef4444'}`,
          borderRadius: 6,
          fontSize: '0.85rem',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
        data-testid="pi-connection-info"
      >
        <strong style={{ color: stream?.isConnected ? '#22c55e' : '#ef4444' }}>
          {stream?.isConnected ? '🟢 Pi connected' : '🔴 Pi offline'}
        </strong>
        {stream?.piRemoteAddress && (
          <>
            {' · '}
            <code>{stream.piRemoteAddress}</code>
            {/* If the address is the Cloudflare Tunnel peer (home public IP,
                not the Pi's LAN IP), the operator can't SSH into it directly.
                Hint them to find the LAN IP in the router's DHCP table.
                LAN-direct connections show e.g. "192.168.1.xxx". */}
            {stream.piRemoteAddress.match(/^(?!192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|127\.)/) && (
              <span className="muted small" style={{ marginLeft: 8, fontFamily: 'inherit' }}>
                (via Cloudflare Tunnel — check your router's DHCP leases for the LAN IP)
              </span>
            )}
          </>
        )}
        {!stream?.piRemoteAddress && (
          <span className="muted small" style={{ marginLeft: 8, fontFamily: 'inherit' }}>
            (no IP recorded — Pi hasn't subscribed yet)
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      {/* ── Platform selector ─────────────────────────────────────────── */}
      <div
        className="platform-selector"
        style={{
          margin: '1rem 0',
          padding: '0.75rem',
          background: 'var(--bg-alt, rgba(255,255,255,0.03))',
          borderRadius: 8,
        }}
        data-testid="stream-platform-selector"
      >
        <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Active streaming destination</div>
        <div role="radiogroup" aria-label="Streaming destination" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <PlatformRadio
            value="youtube"
            label="YouTube Live"
            description="OAuth + per-broadcast keys. Best for public broadcasts."
            checked={platform === 'youtube'}
            disabled={switching}
            onChange={() => handlePlatformSwitch('youtube')}
          />
          <PlatformRadio
            value="twitch"
            label="Twitch"
            description="Manual stream key from your Twitch dashboard."
            checked={platform === 'twitch'}
            disabled={switching}
            onChange={() => handlePlatformSwitch('twitch')}
          />
        </div>
        {switching && <div className="muted small" style={{ marginTop: '0.5rem' }}>Switching…</div>}
      </div>

      {/* ── Per-platform configuration panels ─────────────────────────── */}
      {platform === 'youtube' && (
        <YouTubePanel
          yt={yt}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          disconnecting={disconnecting}
        />
      )}

      {platform === 'twitch' && (
        <TwitchPanel
          keyMasked={scoreboard?.twitchStreamKeyMasked}
          channelLogin={scoreboard?.twitchChannelName ?? null}
          typedKey={twitchKey}
          onTypedKeyChange={setTwitchKey}
          typedLogin={twitchLoginDraft}
          onTypedLoginChange={setTwitchLoginDraft}
          onSaveKey={handleSaveTwitchKey}
          savingKey={savingTwitchKey}
          onSaveLogin={handleSaveTwitchLogin}
          savingLogin={savingTwitchLogin}
          onClear={handleClearTwitch}
          clearing={clearingTwitch}
        />
      )}

      {/* ── Video Encoding (platform-agnostic) ───────────────────────── */}
      <div
        className="encoding-section"
        style={{
          margin: '1rem 0',
          padding: '0.75rem',
          background: 'var(--bg-alt, rgba(255,255,255,0.03))',
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
        }}
        data-testid="encoding-section"
      >
        <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Video Encoding</div>
        <p className="muted small" style={{ marginBottom: '0.75rem' }}>
          Tuned for the Pi's hardware encoder. Lower output resolution +
          lower fps means more bits per frame → cleaner motion at the
          same network bandwidth. Changes apply to the <em>next</em>{' '}
          Start Stream — current stream is unaffected.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
          }}
        >
          <label style={{ display: 'block' }}>
            <div className="muted small" style={{ marginBottom: '0.25rem' }}>
              Output resolution
            </div>
            <select
              value={encodingOutputPreset}
              onChange={(e) => setEncodingOutputPreset(e.target.value)}
              disabled={savingEncoding}
              data-testid="encoding-output-select"
              style={selectStyle}
            >
              <option value="source">Source (no scaling — 640×480)</option>
              <option value="480x360">480×360 (recommended)</option>
              <option value="320x240">320×240 (max quality)</option>
            </select>
          </label>

          <label style={{ display: 'block' }}>
            <div className="muted small" style={{ marginBottom: '0.25rem' }}>
              Frame rate
            </div>
            <select
              value={encodingFpsDraft}
              onChange={(e) => setEncodingFpsDraft(parseInt(e.target.value, 10))}
              disabled={savingEncoding}
              data-testid="encoding-fps-select"
              style={selectStyle}
            >
              <option value={15}>15 fps (smoothest motion at low bitrate)</option>
              <option value={24}>24 fps (cinema cadence)</option>
              <option value={30}>30 fps (default)</option>
            </select>
          </label>

          <label style={{ display: 'block' }}>
            <div className="muted small" style={{ marginBottom: '0.25rem' }}>
              Audio bitrate
            </div>
            <select
              value={encodingAudioDraft}
              onChange={(e) => setEncodingAudioDraft(e.target.value)}
              disabled={savingEncoding}
              data-testid="encoding-audio-select"
              style={selectStyle}
            >
              <option value="64k">64 kbps (default — voice)</option>
              <option value="96k">96 kbps (cleaner voice)</option>
              <option value="128k">128 kbps (music)</option>
            </select>
          </label>
        </div>

        <div className="stream-buttons" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveEncoding}
            disabled={savingEncoding}
            data-testid="encoding-save"
          >
            {savingEncoding ? 'Saving…' : 'Save Encoding Settings'}
          </button>
        </div>
      </div>

      {/* ── Audio & Image (platform-agnostic, live tuning) ──────────── */}
      <div
        className="av-tuning-section"
        style={{
          margin: '1rem 0',
          padding: '0.75rem',
          background: 'var(--bg-alt, rgba(255,255,255,0.03))',
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
        }}
        data-testid="av-tuning-section"
      >
        <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Audio &amp; Image</div>
        <p className="muted small" style={{ marginBottom: '0.75rem' }}>
          Volume is applied by the Pi's audio encoder; brightness and contrast
          are applied directly on the camera. Image adjustments (and the
          preview) work <em>live</em> — while streaming or idle — no restart
          needed. Volume applies to the <em>next</em> Start Stream.
          {!stream.isConnected && (
            <> The Pi is currently offline — sliders will save but won't take effect until it reconnects.</>
          )}
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '0.75rem',
          }}
        >
          <label style={{ display: 'block' }}>
            <div className="muted small" style={{ marginBottom: '0.25rem' }}>
              Volume (audio gain): <strong>{audioGainDraft > 0 ? `+${audioGainDraft}` : audioGainDraft} dB</strong>
            </div>
            <input
              type="range"
              min={-10}
              max={30}
              step={1}
              value={audioGainDraft}
              onChange={(e) => setAudioGainDraft(parseInt(e.target.value, 10))}
              disabled={savingAV}
              data-testid="av-gain-slider"
              style={{ width: '100%' }}
            />
            <div className="muted small" style={{ marginTop: '0.25rem' }}>
              Digital gain for the stream's mic. 0 dB = source level. Saved on
              Save — applies to the next Start Stream (a running stream keeps
              its current volume).
            </div>
          </label>

          <label style={{ display: 'block' }}>
            <div className="muted small" style={{ marginBottom: '0.25rem' }}>
              Brightness: <strong>{cameraBrightnessDraft}</strong>
              {cameraBrightnessDraft !== 100 && <span className="muted"> ({cameraBrightnessDraft > 100 ? '+' : ''}{cameraBrightnessDraft - 100})</span>}
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={cameraBrightnessDraft}
              onChange={(e) => setCameraBrightnessDraft(parseInt(e.target.value, 10))}
              disabled={savingAV}
              data-testid="av-brightness-slider"
              style={{ width: '100%' }}
            />
          </label>

          <label style={{ display: 'block' }}>
            <div className="muted small" style={{ marginBottom: '0.25rem' }}>
              Contrast: <strong>{cameraContrastDraft}</strong>
              {cameraContrastDraft !== 100 && <span className="muted"> ({cameraContrastDraft > 100 ? '+' : ''}{cameraContrastDraft - 100})</span>}
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={cameraContrastDraft}
              onChange={(e) => setCameraContrastDraft(parseInt(e.target.value, 10))}
              disabled={savingAV}
              data-testid="av-contrast-slider"
              style={{ width: '100%' }}
            />
          </label>
        </div>

        <div className="muted small" style={{ marginTop: '0.5rem' }}>
          100 = neutral for the image sliders. Changes are pushed to the camera
          live (about half a second after you stop dragging) and also saved
          when you click Save below.
        </div>

        {/* ── Live preview pane ───────────────────────────────────────── */}
        <div
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem',
            border: `1px solid ${previewOn ? 'var(--accent, #6366f1)' : 'var(--border, #333)'}`,
            borderRadius: 6,
          }}
          data-testid="av-preview-pane"
        >
          <div className="stream-buttons" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className={previewOn ? 'btn btn-ghost' : 'btn btn-primary'}
              onClick={handlePreviewToggle}
              data-testid="av-preview-toggle"
            >
              {previewOn ? 'Hide camera preview' : 'Show camera preview'}
            </button>
            {previewOn && (
              <span className="muted small">
                {previewJpeg ? 'live · ~1 fps' : 'waiting for frames…'}
              </span>
            )}
          </div>
          {previewOn && (
            <div style={{ marginTop: '0.5rem' }}>
              {previewJpeg ? (
                <img
                  src={`data:image/jpeg;base64,${previewJpeg}`}
                  alt="Live camera preview"
                  data-testid="av-preview-img"
                  style={{
                    display: 'block',
                    width: '100%',
                    maxWidth: 480,
                    borderRadius: 4,
                    border: '1px solid var(--border, #333)',
                  }}
                />
              ) : (
                <p className="muted small" style={{ margin: 0 }}>
                  waiting for frames… (the Pi sends one frame per second; if
                  this never resolves, check that the Pi is online)
                </p>
              )}
            </div>
          )}
        </div>

        <div className="stream-buttons" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveAV}
            disabled={savingAV}
            data-testid="av-save"
          >
            {savingAV ? 'Saving…' : 'Save Audio & Image'}
          </button>
        </div>
      </div>

      {/* ── Test pattern toggle (platform-agnostic) ───────────────────── */}
      <div
        className="test-pattern-section"
        style={{
          margin: '1rem 0',
          padding: '0.75rem',
          background: stream.testPattern ? 'rgba(240, 192, 64, 0.08)' : 'transparent',
          border: `1px solid ${stream.testPattern ? 'var(--yellow, #f0c040)' : 'var(--border, #333)'}`,
          borderRadius: 8,
        }}
      >
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!stream.testPattern}
            onChange={(e) => handleTestPatternToggle(e.target.checked)}
            data-testid="settings-test-pattern-toggle"
            style={{ marginTop: 3 }}
          />
          <div>
            <strong>Test pattern (no camera)</strong>
            <div className="muted small" style={{ marginTop: 2 }}>
              When on, the Pi pushes a synthetic SMPTE test pattern to the RTMP endpoint
              instead of camera frames. Useful for setup or when the camera is missing.
              Applies to the <em>next</em> Start Stream — current stream is unaffected.
            </div>
            {stream.testPattern && (
              <div className="muted small" style={{ marginTop: 4, color: 'var(--yellow, #f0c040)' }}>
                ⚠ Test pattern is ON. Camera will be bypassed on next start.
              </div>
            )}
          </div>
        </label>
      </div>

      {/* ── Active-platform readiness hint ────────────────────────────── */}
      {!activeReady && (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          {platform === 'youtube'
            ? 'No YouTube account connected — Start Stream will fail until you connect one below.'
            : 'No Twitch stream key configured — Start Stream will fail until you paste one below.'}
        </p>
      )}
    </section>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

interface PlatformRadioProps {
  value: Platform;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}

function PlatformRadio({ value, label, description, checked, disabled, onChange }: PlatformRadioProps) {
  return (
    <label
      style={{
        flex: '1 1 200px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.6rem',
        padding: '0.6rem 0.75rem',
        background: checked ? 'rgba(99, 102, 241, 0.12)' : 'transparent',
        border: `1px solid ${checked ? 'var(--accent, #6366f1)' : 'var(--border, #333)'}`,
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
      data-testid={`platform-radio-${value}`}
    >
      <input
        type="radio"
        name="stream-platform"
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ marginTop: 3 }}
      />
      <div>
        <strong>{label}</strong>
        <div className="muted small" style={{ marginTop: 2 }}>{description}</div>
      </div>
    </label>
  );
}

interface YouTubePanelProps {
  yt: YouTubeStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
}

function YouTubePanel({ yt, onConnect, onDisconnect, disconnecting }: YouTubePanelProps) {
  return (
    <div className="youtube-config-panel" data-testid="youtube-config-panel">
      {yt.connected ? (
        <>
          <div className="stream-status-grid">
            <div className="metric">
              <span>Channel</span>
              <b>{yt.channelTitle || '(unknown)'}</b>
            </div>
            <div className="metric">
              <span>Account</span>
              <b>{yt.email || '(unknown)'}</b>
            </div>
            <div className="metric">
              <span>Channel ID</span>
              <b><code>{yt.channelId}</code></b>
            </div>
            <div className="metric">
              <span>Token Expires</span>
              <b>
                {yt.tokenExpiresAt
                  ? new Date(yt.tokenExpiresAt).toLocaleString()
                  : '—'}
              </b>
            </div>
          </div>

          <div className="stream-buttons">
            <a
              className="btn btn-ghost"
              href={`https://www.youtube.com/channel/${yt.channelId}/live`}
              target="_blank"
              rel="noreferrer"
            >
              View Channel Live Tab ↗
            </a>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onDisconnect}
              disabled={disconnecting}
              data-testid="youtube-disconnect"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect Account'}
            </button>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            <strong>How it works:</strong> When you click Start Stream, the backend
            creates a fresh liveBroadcast on <em>{yt.channelTitle}</em> using the
            YouTube Data API, generates a one-time RTMP key, and tells the Pi to
            begin streaming. When you Stop, the broadcast is marked complete.
          </p>
        </>
      ) : (
        <>
          <div className="stream-status-grid">
            <div className="metric">
              <span>YouTube Account</span>
              <b className="error-text">Not connected</b>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConnect}
            data-testid="youtube-connect"
          >
            Connect YouTube Account
          </button>
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            You'll be redirected to Google to authorize streaming to your channel.
            The backend stores a refresh token — you only need to do this once per
            scoreboard.
          </p>
        </>
      )}
    </div>
  );
}

interface TwitchPanelProps {
  keyMasked?: string;
  /** Stored Twitch login (lowercase, no spaces). Null when not configured. */
  channelLogin: string | null;
  typedKey: string;
  onTypedKeyChange: (v: string) => void;
  /** What the operator is currently typing in the channel-login field. */
  typedLogin: string;
  onTypedLoginChange: (v: string) => void;
  onSaveKey: () => void;
  savingKey: boolean;
  onSaveLogin: () => void;
  savingLogin: boolean;
  onClear: () => void;
  clearing: boolean;
}

function TwitchPanel({
  keyMasked,
  channelLogin,
  typedKey,
  onTypedKeyChange,
  typedLogin,
  onTypedLoginChange,
  onSaveKey,
  savingKey,
  onSaveLogin,
  savingLogin,
  onClear,
  clearing,
}: TwitchPanelProps) {
  const hasStoredKey = !!keyMasked;
  const hasStoredLogin = !!channelLogin;

  // Live client-side validation so the operator sees a problem before Save.
  // Twitch logins are lowercase alphanumerics + underscores, no spaces.
  const loginTrimmed = typedLogin.trim();
  const loginHasSpaces = /\s/.test(loginTrimmed);
  const loginLooksOk =
    loginTrimmed.length > 0 &&
    !loginHasSpaces &&
    /^[a-z0-9_]+$/i.test(loginTrimmed);
  const loginChanged =
    loginTrimmed !== (channelLogin ?? '');

  return (
    <div className="twitch-config-panel" data-testid="twitch-config-panel">
      <div className="stream-status-grid">
        <div className="metric">
          <span>Twitch Stream Key</span>
          <b>
            {hasStoredKey ? (
              <code data-testid="twitch-key-masked">{keyMasked}</code>
            ) : (
              <span className="error-text">Not configured</span>
            )}
          </b>
        </div>
        <div className="metric">
          <span>Twitch Channel Login</span>
          <b>
            {hasStoredLogin ? (
              <code data-testid="twitch-channel-masked">{channelLogin}</code>
            ) : (
              <span className="error-text">Not configured</span>
            )}
          </b>
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        {/* ── Twitch channel login (separate save) ─────────────────────── */}
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <strong>Twitch channel login</strong>
          <input
            type="text"
            value={typedLogin}
            onChange={(e) => onTypedLoginChange(e.target.value)}
            placeholder="e.g. pickeringredsox"
            disabled={savingLogin}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            data-testid="twitch-channel-input"
            style={{
              display: 'block',
              width: '100%',
              marginTop: '0.25rem',
              padding: '0.5rem',
              background: 'var(--bg-alt, rgba(255,255,255,0.04))',
              border: `1px solid ${loginTrimmed && !loginLooksOk ? 'var(--error, #ef4444)' : 'var(--border, #333)'}`,
              borderRadius: 4,
              color: 'inherit',
              font: 'inherit',
              fontFamily: 'monospace',
            }}
          />
        </label>
        <div className="muted small" style={{ marginBottom: '0.5rem' }}>
          The <strong>actual Twitch login</strong> for your channel — the
          lowercase username that appears after <code>twitch.tv/</code> in
          your channel URL. <em>Not</em> your display name. Example: if your
          channel URL is <code>twitch.tv/pickeringredsox</code>, the login is{' '}
          <code>pickeringredsox</code>.
        </div>
        {loginTrimmed && loginHasSpaces && (
          <div className="error-text small" style={{ marginBottom: '0.5rem' }}>
            Twitch logins can't contain spaces. Paste the username from your
            channel URL.
          </div>
        )}
        {loginTrimmed && !loginHasSpaces && !loginLooksOk && (
          <div className="error-text small" style={{ marginBottom: '0.5rem' }}>
            Twitch logins contain only letters, numbers, and underscores.
          </div>
        )}

        <div className="stream-buttons" style={{ marginBottom: '1rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSaveLogin}
            disabled={savingLogin || !loginLooksOk || !loginChanged}
            data-testid="twitch-save-login"
          >
            {savingLogin ? 'Saving…' : hasStoredLogin ? 'Update Channel Login' : 'Save Channel Login'}
          </button>
          {hasStoredLogin && (
            <a
              className="btn btn-ghost"
              href={`https://www.twitch.tv/${channelLogin}/live`}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="twitch-watch-link"
            >
              Open on Twitch ↗
            </a>
          )}
        </div>

        {/* ── Stream key (separate save) ────────────────────────────────── */}
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <strong>Stream key</strong>
          <input
            type="password"
            value={typedKey}
            onChange={(e) => onTypedKeyChange(e.target.value)}
            placeholder={hasStoredKey ? 'Paste a new key to replace the stored one' : 'Paste your Twitch stream key'}
            disabled={savingKey}
            autoComplete="off"
            data-testid="twitch-key-input"
            style={{
              display: 'block',
              width: '100%',
              marginTop: '0.25rem',
              padding: '0.5rem',
              background: 'var(--bg-alt, rgba(255,255,255,0.04))',
              border: '1px solid var(--border, #333)',
              borderRadius: 4,
              color: 'inherit',
              font: 'inherit',
              fontFamily: 'monospace',
            }}
          />
        </label>

        <div className="muted small" style={{ marginBottom: '0.75rem' }}>
          Get this from{' '}
          <a
            href="https://dashboard.twitch.tv/settings/stream"
            target="_blank"
            rel="noreferrer"
          >
            Twitch Dashboard → Settings → Stream
          </a>
          . The key is sent to the backend over HTTPS and stored in the database
          — only a masked version (<code>{keyMasked ?? '****XXXX'}</code>) is ever shown in the UI.
        </div>

        <div className="stream-buttons">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSaveKey}
            disabled={savingKey || !typedKey.trim()}
            data-testid="twitch-save"
          >
            {savingKey ? 'Saving…' : hasStoredKey ? 'Replace Stream Key' : 'Save Stream Key'}
          </button>
          {hasStoredKey && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={onClear}
              disabled={clearing || savingKey}
              data-testid="twitch-clear"
            >
              {clearing ? 'Clearing…' : 'Clear Stream Key'}
            </button>
          )}
        </div>
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        <strong>How it works:</strong> When you click Start Stream (with Twitch
        selected as the active destination), the backend sends the Pi a
        <code> stream:cmd </code> with the Twitch ingest URL and your stored key.
        The Pi pushes ffmpeg to Twitch — no broadcast lifecycle to manage, no
        API quota burned. Stop just tells the Pi to shut down ffmpeg.
      </p>
    </div>
  );
}
