/**
 * GameChanger Integration Panel
 *
 * Shown in the scoreboard Settings tab. Lets the user:
 *   1. Configure GC credentials (email, password, team name)
 *   2. Log in (handles 2FA flow)
 *   3. Search/link a specific team if auto-match is ambiguous
 *   4. View connection status
 *   5. Disable integration
 */

import { useCallback, useEffect, useState } from 'react';
import {
  gcConfigure,
  gcLogin,
  gcVerify,
  gcStatus,
  gcLinkTeam,
  gcLinkTeamByName,
  gcRefreshGame,
  gcTogglePolling,
  gcDisable,
  type GCStatus,
} from '../api.js';

interface Props {
  scoreboardId: number;
}

type Phase =
  | 'loading'
  | 'unconfigured'
  | 'configured'
  | 'awaiting-2fa'
  | 'connected'
  | 'error';

export function GameChangerPanel({ scoreboardId }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<GCStatus | null>(null);

  // Form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [teamName, setTeamName] = useState('');
  const [verificationCode, setVerificationCode] = useState('');

  // Team search results (when ambiguous) — richer metadata now
  const [teamResults, setTeamResults] = useState<
    Array<{ id: string; name: string; season: string | null; location: string | null; players: number | null }>
  >([]);
  const [showTeamPicker, setShowTeamPicker] = useState(false);
  const [changingTeam, setChangingTeam] = useState(false);  // when true, the team-search form is visible
  const [searchingTeam, setSearchingTeam] = useState(false); // in-flight search
  const [linkingTeamId, setLinkingTeamId] = useState<string | null>(null); // in-flight pick

  const [busy, setBusy] = useState(false);
  const [togglingPolling, setTogglingPolling] = useState(false);
  const [refreshingGame, setRefreshingGame] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // ── Load initial status ────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const s = await gcStatus(scoreboardId);
      setStatus(s);
      if (!s.enabled) {
        setPhase('unconfigured');
      } else if (s.connected) {
        setPhase('connected');
        if (s.teamName) setTeamName(s.teamName);
        if (s.email) setEmail(s.email);
      } else if (s.status === 'pending_login') {
        setPhase('configured');
        if (s.email) setEmail(s.email);
        if (s.teamName) setTeamName(s.teamName);
      } else {
        setPhase('error');
        if (s.email) setEmail(s.email);
        if (s.teamName) setTeamName(s.teamName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
      setPhase('unconfigured');
    }
  }, [scoreboardId]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Auto-refresh status every 15s when connected (to show live sync updates)
  useEffect(() => {
    if (phase !== 'connected') return;
    const t = setInterval(refreshStatus, 15000);
    return () => clearInterval(t);
  }, [phase, refreshStatus]);

  // ── Actions ────────────────────────────────────────────────────────

  async function handleConfigure(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password || !teamName) {
      setError('Email, password, and team name are required');
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await gcConfigure(scoreboardId, { email, password, teamName });
      setInfo('Saved. Click "Log In" to authenticate.');
      setPhase('configured');
      setPassword(''); // Don't keep password in memory longer than needed
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Configuration failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await gcLogin(scoreboardId);
      if (result.requiresVerificationCode) {
        setInfo('A verification code was sent to your email. Enter it below.');
        setPhase('awaiting-2fa');
      } else if (result.connected) {
        setInfo('Login successful — searching for team...');
        await refreshStatus();
        await tryAutoLinkTeam();
      } else {
        setError(result.message || 'Login failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify2FA(e: React.FormEvent) {
    e.preventDefault();
    if (!verificationCode.trim()) {
      setError('Verification code is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await gcVerify(scoreboardId, verificationCode.trim());
      if (result.connected) {
        setInfo('Login successful — searching for team...');
        setVerificationCode('');
        await refreshStatus();
        await tryAutoLinkTeam();
      } else {
        setError(result.message || 'Verification failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Search GameChanger for a team by name and link it.
   *
   * Flow:
   *   - Backend calls searchTeams with the typed query
   *   - One match  → backend auto-links, returns {matched: true, teamId, ...}
   *   - Multiple   → backend returns {matched: 'multiple', teams: [...]}, frontend shows picker
   *   - Zero       → backend returns {matched: false, query}, frontend shows "no results" error
   *
   * Used both during initial login (tryAutoLinkTeam) and when the user wants to
   * change teams later (handleChangeTeam).
   */
  async function searchAndMaybeLinkTeam(query: string): Promise<{ autoLinked: boolean }> {
    const result = await gcLinkTeamByName(scoreboardId, query);
    if (result.matched === true) {
      setInfo(
        `Linked team: ${result.teamName}` +
          (result.season || result.location ? ` (${[result.season, result.location].filter(Boolean).join(' • ')})` : '')
      );
      setShowTeamPicker(false);
      setChangingTeam(false);
      setTeamResults([]);
      await refreshStatus();
      return { autoLinked: true };
    }
    if (result.matched === 'multiple') {
      setTeamResults(result.teams);
      setShowTeamPicker(true);
      setInfo(`${result.teams.length} teams found — pick the correct one.`);
      return { autoLinked: false };
    }
    setError(`No teams found matching "${result.query}". Try a different name.`);
    return { autoLinked: false };
  }

  /** Auto-link flow used during initial login. Best-effort — don't error if it fails. */
  async function tryAutoLinkTeam() {
    try {
      await searchAndMaybeLinkTeam(teamName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Team search failed');
    }
  }

  /** Manual "Change Team" flow opened from the configured view. */
  async function handleChangeTeamSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = teamName.trim();
    if (!query) {
      setError('Enter a team name to search.');
      return;
    }
    setSearchingTeam(true);
    setError(null);
    try {
      await searchAndMaybeLinkTeam(query);
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || (err instanceof Error ? err.message : 'Team search failed'));
    } finally {
      setSearchingTeam(false);
    }
  }

  async function handlePickTeam(teamId: string, name: string) {
    setLinkingTeamId(teamId);
    setError(null);
    try {
      await gcLinkTeam(scoreboardId, teamId, name);
      setInfo(`Linked team: ${name}`);
      setShowTeamPicker(false);
      setChangingTeam(false);
      setTeamResults([]);
      await refreshStatus();
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string } } };
      setError(ax?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to link team'));
    } finally {
      setLinkingTeamId(null);
    }
  }

  function cancelTeamChange() {
    setChangingTeam(false);
    setShowTeamPicker(false);
    setTeamResults([]);
    setError(null);
  }

  async function handleDisable() {
    if (!confirm('Disable GameChanger integration? Manual control will be restored.')) return;
    setBusy(true);
    setError(null);
    try {
      await gcDisable(scoreboardId);
      setStatus(null);
      setPhase('unconfigured');
      setInfo('GameChanger integration disabled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  const statusDot = (p: Phase) => {
    switch (p) {
      case 'connected': return '🟢';
      case 'awaiting-2fa': return '🟡';
      case 'error': return '🔴';
      case 'configured': return '🟡';
      default: return '⚪';
    }
  };

  return (
    <section className="card section gc-panel">
      <h2 className="section-title">
        GameChanger Integration {statusDot(phase)}
      </h2>
      <p className="muted small">
        Automatically sync this scoreboard with a live GameChanger game.
        Updates every 30 seconds while connected.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      {/* Status summary when enabled */}
      {status?.enabled && (
        <div className="gc-status-grid">
          <div className="metric">
            <span>Status</span>
            <b>{status.connected ? 'Connected' : status.status}</b>
          </div>
          {status.email && (
            <div className="metric">
              <span>Email</span>
              <b>{status.email}</b>
            </div>
          )}
          {status.teamName && (
            <div className="metric">
              <span>Team</span>
              <b>{status.teamName}</b>
            </div>
          )}
          {status.lastSync && (
            <div className="metric">
              <span>Last Sync</span>
              <b>{new Date(status.lastSync).toLocaleTimeString()}</b>
            </div>
          )}
        </div>
      )}

      {/* Polling toggle — pause/resume without disconnecting */}
      {status?.enabled && status?.connected && (
        <div className="gc-polling-toggle">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={status.pollingEnabled !== false}
              disabled={togglingPolling}
              onChange={async (e) => {
                const enabled = e.target.checked;
                setTogglingPolling(true);
                try {
                  await gcTogglePolling(scoreboardId, enabled);
                  await refreshStatus();
                  setInfo(enabled ? 'Live polling resumed' : 'Live polling paused');
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to toggle polling');
                } finally {
                  setTogglingPolling(false);
                }
              }}
            />
            <span className="toggle-slider"></span>
          </label>
          <div className="toggle-label">
            <strong>Live polling</strong>
            <span className="muted small">
              {status.pollingEnabled !== false
                ? 'Auto-syncing game state. Turn off to pause API calls.'
                : 'Paused. Toggle on to resume syncing.'}
            </span>
          </div>
        </div>
      )}

      {/* Change team + Refresh game — connected scoreboards can switch teams
          or force an immediate games-list refresh to pick up a newly-live
          or newly-completed game without waiting for the poller's cadence */}
      {status?.enabled && status?.connected && !changingTeam && (
        <div className="gc-actions" style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            disabled={refreshingGame}
            onClick={async () => {
              setRefreshingGame(true);
              setError(null);
              try {
                const result = await gcRefreshGame(scoreboardId);
                if (result.picked) {
                  const startStr = result.picked.startTs
                    ? new Date(result.picked.startTs).toLocaleString()
                    : 'unknown start';
                  setInfo(
                    `Picked ${result.picked.reason} game ` +
                    `(${result.picked.status ?? 'unknown status'}, starts ${startStr}) ` +
                    `from ${result.totalGames} total. State will sync on next poll tick.`
                  );
                } else {
                  setInfo(result.message || 'No games found');
                }
                await refreshStatus();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to refresh game');
              } finally {
                setRefreshingGame(false);
              }
            }}
            title="Re-fetch the GameChanger games list and pick the live or most recent game. Useful when a new game has just gone live."
          >
            {refreshingGame ? '↻ Checking…' : '↻ Find Live / Latest Game'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setChangingTeam(true);
              setShowTeamPicker(false);
              setTeamResults([]);
              setError(null);
            }}
          >
            Change Team…
          </button>
        </div>
      )}

      {/* Change team search form */}
      {changingTeam && (
        <div className="gc-team-search">
          <p className="muted small">
            Search GameChanger for the team you want to track. Type the team
            name (e.g. "Tigers 14U"); if it's a unique name we'll link it
            automatically. Otherwise you'll get a picker to choose.
          </p>
          <form onSubmit={handleChangeTeamSearch} className="gc-inline-form">
            <input
              type="text"
              className="input"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="Team name to search"
              disabled={searchingTeam || linkingTeamId !== null}
              autoFocus
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={searchingTeam || linkingTeamId !== null || !teamName.trim()}
            >
              {searchingTeam ? 'Searching…' : 'Search & Link'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={cancelTeamChange}
              disabled={searchingTeam || linkingTeamId !== null}
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {status?.enabled && status.lastError && (
        <div className="metric gc-error-metric">
          <span>Last Error</span>
          <b className="error-text">{status.lastError}</b>
        </div>
      )}
      {(phase === 'unconfigured' || phase === 'configured' || phase === 'error') && (
        <form onSubmit={handleConfigure} className="gc-form">
          <label className="field">
            <span>GameChanger Email</span>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={phase === 'configured' ? '(stored — re-enter to change)' : ''}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Team Name</span>
            <input
              type="text"
              className="input"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. Tigers 14U"
              disabled={busy}
            />
          </label>
          <div className="gc-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving...' : 'Save Configuration'}
            </button>
            {(phase === 'configured' || phase === 'error') && (
              <button type="button" className="btn btn-primary" onClick={handleLogin} disabled={busy}>
                {busy ? 'Logging in...' : 'Log In to GameChanger'}
              </button>
            )}
          </div>
        </form>
      )}

      {/* 2FA verification */}
      {phase === 'awaiting-2fa' && (
        <form onSubmit={handleVerify2FA} className="gc-form">
          <p className="muted small">
            A verification code was sent to <strong>{email}</strong>. Enter it below.
          </p>
          <label className="field">
            <span>Verification Code</span>
            <input
              type="text"
              className="input"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              placeholder="6-digit code"
              disabled={busy}
              autoFocus
            />
          </label>
          <div className="gc-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Verifying...' : 'Verify & Complete Login'}
            </button>
          </div>
        </form>
      )}

      {/* Team picker (when multiple matches) */}
      {showTeamPicker && teamResults.length > 0 && (
        <div className="gc-team-picker">
          <p className="muted small">
            {teamResults.length} teams matched — pick the one you want to track:
          </p>
          <ul className="gc-team-list">
            {teamResults.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="gc-team-row"
                  onClick={() => handlePickTeam(t.id, t.name)}
                  disabled={linkingTeamId !== null}
                >
                  <span className="gc-team-name">{t.name}</span>
                  <span className="gc-team-meta">
                    {t.season && <span>{t.season}</span>}
                    {t.location && <span> · {t.location}</span>}
                    {t.players !== null && t.players !== undefined && (
                      <span> · {t.players} players</span>
                    )}
                  </span>
                  {linkingTeamId === t.id && <span className="muted small">Linking…</span>}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={cancelTeamChange}
            disabled={linkingTeamId !== null}
            style={{ marginTop: '0.5rem' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Connected — disable option */}
      {phase === 'connected' && (
        <div className="gc-actions">
          <button type="button" className="btn btn-danger" onClick={handleDisable} disabled={busy}>
            Disable Integration
          </button>
        </div>
      )}
    </section>
  );
}
