import { useCallback, useEffect, useRef, useState } from 'react';
import type { Scoreboard, UpdateStatePayload, UpdateScoreboardPayload, DisplayState } from '../types.js';
import {
  getScoreboard,
  updateScoreboard,
  updateScoreboardState,
  watchUrl,
} from '../api.js';
import { useScoreboardSocket } from '../useScoreboardSocket.js';
import { GameChangerPanel } from './GameChangerPanel.js';
import StreamPanel from './StreamPanel.js';
import StreamSettings from './StreamSettings.js';

interface Props {
  scoreboardId: number;
  initialTab?: 'state' | 'settings';
  onBack: () => void;
  onSettings: () => void;
}

interface MetadataForm {
  displayName: string;
  uniqueIdentifier: string;
  homeTeamName: string;
  awayTeamName: string;
  gameId: string;
}

interface StateForm {
  homeScore: number;
  awayScore: number;
  inning: number;
  half: 'top' | 'bottom';
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
}

// ── Baseball State Machine ───────────────────────────────
// Pure functions that advance the count following baseball rules.

interface AdvanceResult {
  state: StateForm;
  patch: UpdateStatePayload;
}

/** Reset balls and strikes to zero (new batter). */
function newBatter(): Partial<StateForm> {
  return { balls: 0, strikes: 0 };
}

/**
 * Shift all baserunners forward by one base. Runners on third score.
 * Used when a batter reaches first on a walk/HBP — every runner ahead
 * of them must advance to keep the bases accurate.
 */
function advanceRunners(s: StateForm): Partial<StateForm> {
  return {
    runnerOnThird: false,                                  // 3rd scores
    runnerOnSecond: s.runnerOnThird || s.runnerOnSecond,   // shift up from 3rd, keep 2nd
    runnerOnFirst: s.runnerOnSecond || s.runnerOnFirst,    // shift up from 2nd, keep 1st
  };
}

/** Advance balls — at 4, walk: batter takes first, runners forced forward. */
function advanceBall(s: StateForm): AdvanceResult {
  if (s.balls >= 3) {
    // Walk. If first is occupied, every runner ahead moves one base.
    // If first is empty, just place batter there — no force.
    if (s.runnerOnFirst) {
      const moved = advanceRunners(s);
      return {
        state: { ...s, balls: 0, strikes: 0, ...moved },
        patch: { balls: 0, strikes: 0, ...moved },
      };
    }
    const patch = { balls: 0, strikes: 0, runnerOnFirst: true };
    return { state: { ...s, ...patch }, patch };
  }
  const patch = { balls: s.balls + 1 };
  return { state: { ...s, ...patch }, patch };
}

/** Advance strikes — at 3, strikeout (out++, reset count). Runners don't move. */
function advanceStrike(s: StateForm): AdvanceResult {
  if (s.strikes >= 2) {
    return advanceOut({ ...s, ...newBatter() });
  }
  const patch = { strikes: s.strikes + 1 };
  return { state: { ...s, ...patch }, patch };
}

/** Advance outs — at 3, side retired (advance half, reset all including bases). */
function advanceOut(s: StateForm): AdvanceResult {
  if (s.outs >= 2) {
    if (s.half === 'top') {
      const patch = {
        half: 'bottom' as const,
        balls: 0, strikes: 0, outs: 0,
        runnerOnFirst: false, runnerOnSecond: false, runnerOnThird: false,
      };
      return { state: { ...s, ...patch }, patch };
    }
    const patch = {
      inning: s.inning + 1, half: 'top' as const,
      balls: 0, strikes: 0, outs: 0,
      runnerOnFirst: false, runnerOnSecond: false, runnerOnThird: false,
    };
    return { state: { ...s, ...patch }, patch };
  }
  const patch = { outs: s.outs + 1, balls: 0, strikes: 0 };
  return { state: { ...s, ...patch }, patch };
}

// ── Component ────────────────────────────────────────────

export default function ScoreboardEditor({ scoreboardId, initialTab = 'state', onBack, onSettings }: Props) {
  const [scoreboard, setScoreboard] = useState<Scoreboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [meta, setMeta] = useState<MetadataForm | null>(null);
  const [state, setState] = useState<StateForm | null>(null);
  // Tracks when the most recent manual edit was made. Used to surface a
  // "Manual Override Active" banner when the user is editing while a live
  // GameChanger game is being tracked — the next GC sync tick will overwrite
  // the value, so we make the temporary nature obvious.
  const [lastManualEditAt, setLastManualEditAt] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<'state' | 'settings'>(initialTab);
  const [gameLogicMode, setGameLogicMode] = useState(() => {
    try {
      return localStorage.getItem('scoreboard_gameLogicMode') !== 'false';
    } catch {
      return true;
    }
  });

  function toggleGameLogicMode(enabled: boolean) {
    setGameLogicMode(enabled);
    try {
      localStorage.setItem('scoreboard_gameLogicMode', String(enabled));
    } catch {
      // localStorage unavailable — state is session-only
    }
  }

  const pendingStateRef = useRef<UpdateStatePayload | null>(null);
  const pendingMetaRef = useRef<UpdateScoreboardPayload | null>(null);
  const stateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // WebSocket push — sync when other operators change state, and push our changes instantly
  const { connected: socketConnected, pushState } = useScoreboardSocket(
    scoreboard ? scoreboard.id : null,
    (payload: DisplayState) => {
      setState((s) => s ? {
        ...s,
        homeScore: payload.h,
        awayScore: payload.a,
        inning: payload.i,
        half: payload.hf === 'b' ? 'bottom' : 'top',
        balls: payload.b,
        strikes: payload.s,
        outs: payload.o,
        runnerOnFirst: !!payload.r1,
        runnerOnSecond: !!payload.r2,
        runnerOnThird: !!payload.r3,
        batterName: payload.bn ?? '',
        batterNumber: payload.bj ?? '',
        pitcherName: payload.pn ?? '',
        pitcherNumber: payload.pj ?? '',
      } : s);
      setScoreboard((sb) => sb ? { ...sb, stateVersion: payload.v } : sb);
    },
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getScoreboard(scoreboardId)
      .then((sb) => {
        if (cancelled) return;
        setScoreboard(sb);
        setMeta(toMetaForm(sb));
        setState(toStateForm(sb));
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load scoreboard');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scoreboardId]);

  const flushState = useCallback(async () => {
    const payload = pendingStateRef.current;
    if (!payload || Object.keys(payload).length === 0) return;
    pendingStateRef.current = null;
    setSaveStatus('saving');
    try {
      const updated = await updateScoreboardState(scoreboardId, payload);
      setScoreboard(updated);
      setState(toStateForm(updated));
      setSaveStatus('saved');
      window.setTimeout(() => setSaveStatus('idle'), 800);
    } catch (err) {
      setSaveStatus('error');
      setError(err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed to save state'
        : 'Failed to save state');
    }
  }, [scoreboardId]);

  const flushMeta = useCallback(async () => {
    const payload = pendingMetaRef.current;
    if (!payload || Object.keys(payload).length === 0) return;
    pendingMetaRef.current = null;
    setSaveStatus('saving');
    try {
      const updated = await updateScoreboard(scoreboardId, payload);
      setScoreboard(updated);
      setMeta(toMetaForm(updated));
      setSaveStatus('saved');
      window.setTimeout(() => setSaveStatus('idle'), 800);
    } catch (err) {
      setSaveStatus('error');
      setError(err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed to save metadata'
        : 'Failed to save metadata');
    }
  }, [scoreboardId]);

  useEffect(() => {
    return () => {
      if (stateTimerRef.current) clearTimeout(stateTimerRef.current);
      if (metaTimerRef.current) clearTimeout(metaTimerRef.current);
    };
  }, []);

  function scheduleState(patch: UpdateStatePayload) {
    // Mark this as a manual edit so the UI can show a "Manual Override
    // Active" banner when a live GC game is being tracked. The banner
    // clears either when GC overwrites the value or after 8 seconds.
    setLastManualEditAt(Date.now());

    // When socket is connected, push instantly through it — the backend
    // persists + broadcasts to display boards in one hop. No REST round trip.
    if (socketConnected) {
      pushState(patch as Record<string, number | string | null>);
      return;
    }
    // Fallback: REST PUT with debounce (socket not connected yet)
    pendingStateRef.current = { ...pendingStateRef.current, ...patch };
    if (stateTimerRef.current) clearTimeout(stateTimerRef.current);
    stateTimerRef.current = setTimeout(() => { void flushState(); }, 500);
  }

  function scheduleMeta(patch: UpdateScoreboardPayload) {
    pendingMetaRef.current = { ...pendingMetaRef.current, ...patch };
    if (metaTimerRef.current) clearTimeout(metaTimerRef.current);
    metaTimerRef.current = setTimeout(() => { void flushMeta(); }, 500);
  }

  /** Inning/half change — resets count in game logic mode only. */
  function inningChange(patch: UpdateStatePayload) {
    if (gameLogicMode) {
      patch = { ...patch, balls: 0, strikes: 0, outs: 0 };
    }
    setState((s) => s ? { ...s, ...patch } as StateForm : s);
    scheduleState(patch);
  }

  if (loading) return <div className="muted">Loading...</div>;
  if (error && !scoreboard) return <div className="error-banner">{error}</div>;
  if (!scoreboard || !meta || !state) return <div className="muted">No data</div>;

  const watchLink = watchUrl(scoreboard.uniqueIdentifier);

  // Helper: compute next state for a count tap
  const handleCountTap = (type: 'ball' | 'strike' | 'out') => {
    const s = state; // non-null, narrowed by guard above
    let next: AdvanceResult;
    if (!gameLogicMode) {
      const wrap = (val: number, max: number) => (val + 1) % (max + 1);
      if (type === 'ball') {
        const balls = wrap(s.balls, 3);
        next = { state: { ...s, balls }, patch: { balls } };
      } else if (type === 'strike') {
        const strikes = wrap(s.strikes, 2);
        next = { state: { ...s, strikes }, patch: { strikes } };
      } else {
        const outs = wrap(s.outs, 2);
        next = { state: { ...s, outs }, patch: { outs } };
      }
    } else {
      next = type === 'ball' ? advanceBall(s) : type === 'strike' ? advanceStrike(s) : advanceOut(s);
    }
    setState(next.state);
    scheduleState(next.patch);
  };

  return (
    <div className="editor-view">
      <header className="app-header">
        <button onClick={onBack} className="btn btn-ghost">&larr; Back</button>
        <h1>{scoreboard.displayName || scoreboard.uniqueIdentifier}</h1>
        <span className={`save-status save-status-${saveStatus}`}>
          {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Error' : ''}
        </span>
        <span className={`socket-indicator ${socketConnected ? 'connected' : ''}`}
          title={socketConnected ? 'Real-time connected' : 'Connecting...'} />
      </header>

      <div className="tab-bar">
        <button className={`tab-btn ${activeTab === 'state' ? 'active' : ''}`} onClick={() => setActiveTab('state')}>
          Scoreboard
        </button>
        <button className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
          <span className="tab-icon">⚙</span> Settings
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* ── Settings Tab ── */}
      {activeTab === 'settings' && (
        <div className="settings-view">
          <section className="card section">
            <h2 className="section-title">Metadata</h2>
            <label className="field">
              <span>Display Name</span>
              <input type="text" className="input" value={meta.displayName}
                onChange={(e) => { const v = e.target.value; setMeta((m) => m ? { ...m, displayName: v } : m); scheduleMeta({ displayName: v }); }} />
            </label>
            <label className="field">
              <span>Unique Identifier</span>
              <input type="text" className="input" value={meta.uniqueIdentifier}
                onChange={(e) => { const v = e.target.value; setMeta((m) => m ? { ...m, uniqueIdentifier: v } : m); scheduleMeta({ uniqueIdentifier: v }); }} />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Home Team</span>
                <input type="text" className="input" value={meta.homeTeamName}
                  onChange={(e) => { const v = e.target.value; setMeta((m) => m ? { ...m, homeTeamName: v } : m); scheduleMeta({ homeTeamName: v }); }} />
              </label>
              <label className="field">
                <span>Away Team</span>
                <input type="text" className="input" value={meta.awayTeamName}
                  onChange={(e) => { const v = e.target.value; setMeta((m) => m ? { ...m, awayTeamName: v } : m); scheduleMeta({ awayTeamName: v }); }} />
              </label>
            </div>
            <label className="field">
              <span>Game ID</span>
              <input type="text" className="input" value={meta.gameId} placeholder="(optional, for GameChanger)"
                onChange={(e) => { const v = e.target.value; setMeta((m) => m ? { ...m, gameId: v } : m); scheduleMeta({ gameId: v || null }); }} />
            </label>
          </section>

          <section className="card section">
            <h2 className="section-title">Controls</h2>
            <label className="game-logic-toggle">
              <input type="checkbox" checked={gameLogicMode} onChange={(e) => toggleGameLogicMode(e.target.checked)} />
              <span>Game Logic Mode</span>
              <span className="muted small">
                {gameLogicMode
                  ? '— balls/strikes/outs follow baseball rules (walks, strikeouts, side retired)'
                  : '— manual mode, each counter wraps independently'}
              </span>
            </label>
          </section>

          <GameChangerPanel scoreboardId={scoreboardId} />

          <StreamSettings scoreboardId={scoreboardId} scoreboard={scoreboard} />
        </div>
      )}

      {/* ── Scoreboard Tab ── */}
      {activeTab === 'state' && (
        <div className="settings-view">
          {/* Manual override banner — shown when the user has just edited
              state while a live GameChanger game is being tracked. Makes it
              obvious that the visible value will be overwritten by the
              next GC sync tick (~1s when live). No conflict tracking —
              last writer wins. */}
          {scoreboard?.gameId && lastManualEditAt > 0 && Date.now() - lastManualEditAt < 8000 && (
            <div className="manual-override-banner">
              <strong>⚡ Manual Override Active</strong>
              <span className="muted small">
                Your change is live. GameChanger sync will overwrite this on its next update (≤1s).
              </span>
            </div>
          )}
          <section className="card section">
            <h2 className="section-title">Score</h2>
            <div className="score-controls">
              <ScoreStepper label={scoreboard.homeTeamName} value={state.homeScore}
                onChange={(v) => { setState((s) => s ? { ...s, homeScore: v } : s); scheduleState({ homeScore: v }); }} />
              <ScoreStepper label={scoreboard.awayTeamName} value={state.awayScore}
                onChange={(v) => { setState((s) => s ? { ...s, awayScore: v } : s); scheduleState({ awayScore: v }); }} />
            </div>
          </section>

          <section className="card section">
            <h2 className="section-title">Inning</h2>
            <div className="inning-controls">
              <div className="stepper">
                <button className="btn btn-step" onClick={() => inningChange({ inning: Math.max(1, state.inning - 1) })}>&minus;</button>
                <span className="inning-value">{state.inning}</span>
                <button className="btn btn-step" onClick={() => inningChange({ inning: state.inning + 1 })}>+</button>
              </div>
              <div className="half-toggle">
                <button className={`btn btn-half ${state.half === 'top' ? 'active' : ''}`} onClick={() => inningChange({ half: 'top' })}>Top</button>
                <button className={`btn btn-half ${state.half === 'bottom' ? 'active' : ''}`} onClick={() => inningChange({ half: 'bottom' })}>Bottom</button>
              </div>
            </div>
          </section>

          <section className="card section">
            <h2 className="section-title">Count</h2>
            <div className="count-controls">
              <CountDots label="Balls" value={state.balls} max={3} colorClass="dot-ball" onTap={() => handleCountTap('ball')} />
              <CountDots label="Strikes" value={state.strikes} max={2} colorClass="dot-strike" onTap={() => handleCountTap('strike')} />
              <CountDots label="Outs" value={state.outs} max={2} colorClass="dot-out" onTap={() => handleCountTap('out')} />
            </div>
            <div className="reset-buttons">
              <button className="btn btn-secondary"
                onClick={() => { setState((s) => s ? { ...s, balls: 0, strikes: 0 } : s); scheduleState({ balls: 0, strikes: 0 }); }}>
                Reset Count
              </button>
              <button className="btn btn-secondary"
                onClick={() => {
                  const zero = {
                    homeScore: 0, awayScore: 0, inning: 1, half: 'top' as const,
                    balls: 0, strikes: 0, outs: 0,
                    runnerOnFirst: false, runnerOnSecond: false, runnerOnThird: false,
                    batterName: '', batterNumber: '', pitcherName: '', pitcherNumber: '',
                  };
                  setState(zero);
                  scheduleState(zero);
                }}>
                Reset All
              </button>
            </div>
          </section>

          <section className="card section watch-share-card">
            <h2 className="section-title">Share Watch Link</h2>
            <p className="muted small">Send this to anyone who wants to follow the game live:</p>
            <div className="url-row">
              <code className="display-url">{watchLink}</code>
              <CopyButton value={watchLink} label="Watch link" />
            </div>
          </section>

          <StreamPanel
            scoreboardId={scoreboardId}
            initialStatus={scoreboard.streamStatus}
            initialKeyMasked={scoreboard.streamKeyMasked}
            initialRtmpUrl={scoreboard.streamRtmpUrl}
            initialPlatform={scoreboard.streamPlatform}
            onRequestSettings={onSettings}
          />
        </div>
      )}
    </div>
  );
}


/**
 * Small "Copy" button used next to shareable URLs in the editor.
 * Falls back to a hidden textarea + document.execCommand for
 * non-secure-context browsers where navigator.clipboard is unavailable
 * (e.g. http://192.168.x.x without TLS).
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error(`[editor] failed to copy ${label}:`, err);
      window.prompt(`Copy ${label}:`, value);
    }
  };
  return (
    <button
      type="button"
      className="btn btn-secondary copy-btn"
      onClick={onClick}
      title={`Copy ${label}`}
    >
      {copied ? '\u2713 Copied' : 'Copy'}
    </button>
  );
}
// ── Sub-components ───────────────────────────────────────

function ScoreStepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void; }) {
  return (
    <div className="score-stepper">
      <div className="score-stepper-label">{label}</div>
      <div className="stepper">
        <button className="btn btn-step" onClick={() => onChange(Math.max(0, value - 1))}>&minus;</button>
        <span className="score-value">{value}</span>
        <button className="btn btn-step" onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

function CountDots({ label, value, max, colorClass, onTap }: {
  label: string; value: number; max: number; colorClass: string; onTap: () => void;
}) {
  return (
    <div className="count-group" onClick={onTap} style={{ cursor: 'pointer' }}>
      <div className="count-label">{label}</div>
      <div className="dots-row">
        {Array.from({ length: max }).map((_, i) => (
          <span key={i} className={`dot ${colorClass} ${i < value ? 'on' : ''}`} />
        ))}
      </div>
    </div>
  );
}

function toMetaForm(sb: Scoreboard): MetadataForm {
  return {
    displayName: sb.displayName,
    uniqueIdentifier: sb.uniqueIdentifier,
    homeTeamName: sb.homeTeamName,
    awayTeamName: sb.awayTeamName,
    gameId: sb.gameId ?? '',
  };
}

function toStateForm(sb: Scoreboard): StateForm {
  return {
    homeScore: sb.homeScore,
    awayScore: sb.awayScore,
    inning: sb.inning,
    half: sb.half,
    balls: sb.balls,
    strikes: sb.strikes,
    outs: sb.outs,
    runnerOnFirst: sb.runnerOnFirst,
    runnerOnSecond: sb.runnerOnSecond,
    runnerOnThird: sb.runnerOnThird,
    batterName: sb.batterName,
    batterNumber: sb.batterNumber,
    pitcherName: sb.pitcherName,
    pitcherNumber: sb.pitcherNumber,
  };
}
