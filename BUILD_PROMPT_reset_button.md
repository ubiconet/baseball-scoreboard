# Add Stream Reset — Recover Wedged Start/Stop State

## Context

The scoreboard app can get stuck in `starting` or `stopping` state when:
- The direct HLS listener ffmpeg dies mid-cycle (port collision, SIGTERM during stop) before writing its first segment, so the DB row stays at `stream_status='starting'` and re-entry is blocked with "Stream already starting. Stop it first." even though nothing is on port 1935.
- The Pi streamer wedges in `anon_pipe_write` when the merge ffmpeg stops reading from the H.264 FIFO (Symptom F).
- The operator click-stops mid-stream and the watch page caches the gap while the backend log shows `[direct-stream] stopping stream`.
- The YouTube broadcast lifecycle gets wedged on `starting` because the OAuth createBroadcast call hung.

The user wants a **Reset** button beside Start/Stop in `StreamPanel.tsx` that forces a clean state — kills the wedged ffmpeg listener (if direct mode), emits a `stream:cmd { action: 'reset' }` to the Pi, forces the DB back to `idle`, and emits a fresh `stream:status` event so the watch page resets too.

Reset is **destructive** (kills any in-progress RTMP push + active broadcast). It must:
- Show only when status is `starting`, `stopping`, or `error` (the wedged states) — NOT when `idle` or `live`.
- Two-step confirm like the existing LED refresh button does (see `ScoreboardEditor.tsx` LED refresh UI).
- Use an amber/warning visual style.

## Files to Change

### 1. `backend/src/direct-stream.ts`

Add a new exported function:

```typescript
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
```

### 2. `backend/src/routes/direct-stream.ts`

Add a `POST /:id/stream/direct/reset` route (just below the existing stop route):

```typescript
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
```

And add `resetDirectStream` to the import line at the top.

### 3. `backend/src/routes/stream.ts`

Add a cross-mode `POST /:id/stream/reset` route (after the existing `/:id/stream/stop` route, before `applyStreamStatusFromPi`):

```typescript
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
```

Add `resetDirectStream` to the import from `../direct-stream.js`. Note: cross-router imports are already done in this codebase (e.g. `stream.ts` imports from `youtube-stream.ts`), so this is consistent.

### 4. `pi/command_listener.py`

In `_handle_command`, add a `reset` branch (before the `else: log.warning("unknown...")`):

```python
elif action == "reset":
    log.warning("received reset cmd — hard-stopping stream pipeline")
    try:
        self._on_stop()
    except Exception as exc:
        log.exception("on_stop callback failed during reset")
    # Don't emit 'idle' here — the backend has already forced DB to idle
    # and emitted its own stream:status event. If we emit too, the Pi's
    # socket round-trip can race with the backend's emit and leave the
    # UI flickering. The backend's emit is authoritative.
```

### 5. `frontend/src/api.ts`

Add a new helper (after `streamStop`):

```typescript
/**
 * Hard-reset the stream state for a scoreboard. Cross-mode — works for
 * youtube, twitch, and direct. Recovers from wedged 'starting' /
 * 'stopping' / 'error' states by killing the Mac-side listener (if direct),
 * telling the Pi to reset, and forcing the DB row to idle.
 *
 * The operator should click Reset when /stream/start refuses with
 * "Stream already starting" or "Stream already stopping" but nothing is
 * actually running. Refuses to be called when a fresh Start would
 * already succeed (i.e. status === 'idle').
 */
export async function streamReset(
  id: number
): Promise<{
  success: boolean;
  status: string;
  previousStatus: string;
  platform: string;
  mode: string;
}> {
  const res = await client.post(`/scoreboards/${id}/stream/reset`);
  return res.data;
}
```

### 6. `frontend/src/components/StreamPanel.tsx`

Add the Reset button to the existing button row. The button:
- Visible only when `status.status` is `'starting'`, `'stopping'`, or `'error'` (the wedged states)
- Uses an amber warning color (distinct from primary green Start and danger red Stop)
- Two-step confirm: first click shows a warning, second click fires
- Disabled while `busy`
- Sits to the RIGHT of the Stop button (visual separation from the primary flow)

Add to the imports:
```typescript
import { streamStart, streamStop, streamStatus, streamReset } from '../api.js';
```

Add the state and handler after the existing `handleStop`:
```typescript
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
```

Update the render logic:
```typescript
const canReset = status.status === 'starting' || status.status === 'stopping' || status.status === 'error';
```

Replace the existing `<div className="stream-buttons">` block with:
```typescript
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
```

Add a brief explanation hint above the buttons when canReset:
```typescript
{canReset && !confirmReset && (
  <p className="muted small" data-testid="stream-reset-hint">
    Stream appears wedged — use <strong>Reset Stream</strong> if Stop won't recover.
  </p>
)}
```

### 7. `frontend/src/styles.css` (or wherever `.stream-buttons`, `.btn-warning`, `.btn-secondary` are defined)

If `.btn-warning` doesn't already exist, add:
```css
.btn-warning {
  background: var(--amber, #f59e0b);
  color: #1a1a1a;
  border: 1px solid var(--amber-dark, #b45309);
}
.btn-warning:hover:not(:disabled) {
  background: var(--amber-dark, #b45309);
  color: #fff;
}
.btn-secondary {
  background: transparent;
  color: var(--text, #e5e7eb);
  border: 1px solid var(--border, #4b5563);
}
.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
.reset-confirm {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: 0.5rem;
  padding: 0.25rem 0.5rem;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid var(--amber, #f59e0b);
  border-radius: 6px;
}
.reset-confirm-text {
  font-size: 0.85rem;
  color: var(--amber, #f59e0b);
}
```

Look at the existing `.stream-buttons` rule and add `flex-wrap: wrap; gap: 0.5rem;` if not present, so the confirm row wraps cleanly.

## Verification

After implementing, smoke-test:

```bash
# Build frontend (will catch TS errors)
cd /Users/skuzmak/projects/scoreboard/frontend && npm run build

# Restart backend
pkill -9 -f 'tsx.*scoreboard.*src/index' 2>/dev/null; sleep 1
cd /Users/skuzmak/projects/scoreboard/backend && npx tsx src/index.ts &
sleep 3

# Status check
curl -s http://localhost:4020/health

# Manually wedge a scoreboard in 'starting' state
psql ... -c "UPDATE scoreboards SET stream_status='starting' WHERE id=6"

# Call reset
curl -X POST http://localhost:4020/api/scoreboards/6/stream/reset | jq

# Verify status came back to idle
curl -s http://localhost:4020/api/scoreboards/6/stream/status | jq .status
```

## Don't Do

- Don't auto-call reset from the watch page or any auto-recovery code — this is operator-initiated only.
- Don't change the existing Start/Stop handlers.
- Don't add Reset to `StreamSettings.tsx` — it belongs in the StreamPanel where Start/Stop are.
- Don't reset if `status === 'live'` without operator confirmation — Reset is for wedged states, not for stopping a working stream.
- Don't import `resetDirectStream` directly into `routes/stream.ts` without checking the cross-router import pattern in the codebase — `routes/direct-stream.ts` already imports from `direct-stream.js`, so doing the same in `stream.ts` is fine.
