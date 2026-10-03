# YouTube Live Streaming Integration — Implementation Spec

## Goal

Add YouTube Live streaming capability to the scoreboard system. The user starts/stops the stream from the scoreboard web UI. Stream runs on a Raspberry Pi that connects to the backend over the existing WebSocket (no new network plumbing).

## Architecture

```
Browser  ─HTTP─>  Backend  ─WebSocket─>  Pi (stream_scoreboard.py)
                (Express)              (Flask + ffmpeg → RTMP)
```

The Pi already runs `scoreboard_leds.py` with an open socket to the backend. We extend that socket to carry stream control commands. The streamer (`stream_scoreboard.py`) is a separate process on the Pi (already exists, has Flask API). It will join the same backend socket using socket.io-client.

## Key Constraints

- **Backend must not connect to Pi directly.** Pi → backend only. (User requirement: no third-party services, must work across networks.)
- **Stream key stored per scoreboard** (user requirement).
- **Pi Camera Module 3 via ribbon cable** (picamera2).
- **No auth for now** (user decision) — Pi just connects; we'll identify it by what it subscribes to.
- **Streamer runs as separate process on Pi** (user decision: `stream_scoreboard.py`, separate from `scoreboard_leds.py`).
- **Code style**: TypeScript strict, clean inline docs, no drive-by refactors.
- **Existing `scoreboard_leds.py` should not be modified** — only `stream_scoreboard.py` on the Pi needs socket changes. (Both will be done via SSH in a later step, not now.)

## Repo Layout

Repo root: `/Users/skuzmak/projects/scoreboard/`
- `backend/` — Express + Socket.io
- `frontend/` — React + Vite (built into `frontend/dist/`, served by Express on port 4020)

## Database Changes

Add to `scoreboards` table (run via psql or migration):

```sql
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_key TEXT;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_status TEXT NOT NULL DEFAULT 'idle';
-- stream_status values: 'idle' | 'starting' | 'live' | 'error' | 'stopping'
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_last_error TEXT;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_started_at TIMESTAMPTZ;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_rtmp_url TEXT;
```

Also update `/Users/skuzmak/projects/scoreboard/schema.sql` to include these columns for new installs.

## Backend Changes

### 1. Backend stream router — `backend/src/routes/stream.ts` (NEW)

Endpoints (all under `/api/scoreboards/:id/stream/...`):

- `POST /:id/stream/start` — sets status to `starting`, emits `stream:cmd` to the Pi socket for that scoreboard. Body: `{ rtmp_url?: string }`. If `rtmp_url` not provided, use the scoreboard's stored `stream_rtmp_url` (default to YouTube live URL if blank).
- `POST /:id/stream/stop` — sets status to `stopping`, emits `stream:cmd` to the Pi socket.
- `GET /:id/stream/status` — returns `{ status, lastError, startedAt, rtmpUrl, isConnected }`.
- `PUT /:id/stream/key` — body: `{ streamKey: string, rtmpUrl?: string }`. Stores the stream key + optional RTMP URL. Masks key in responses (return only last 4 chars).

Pattern: follow `backend/src/routes/gamechanger.ts` for query helpers, error handling shape, and response format.

### 2. Stream key handling

Store as plain text for now (user said no auth yet). Show only last 4 chars in any GET response. When the user updates the key, never echo the full new value back in responses.

### 3. Socket.io wiring — modify `backend/src/socket.ts`

Currently the socket handler:
- Accepts `subscribe` event → joins room `scoreboard:<id>`
- Accepts `state:change` event → broadcasts to others in room

Add:
- Track `socketId → scoreboardId` mapping (Map<socketId, number>).
- A function `getSocketForScoreboard(id: number): Socket | undefined` that returns the most-recent socket subscribed to that board.
- New event handlers (Pi → backend):
  - `stream:status` — payload: `{ scoreboardId, status: 'live' | 'idle' | 'error', error?: string }`. Updates the scoreboard's `stream_status` and `stream_last_error` columns.
  - `stream:ready` — payload: `{ scoreboardId, rtmpUrl, capabilities }`. Indicates Pi is ready to receive commands. Update `stream_status` to `idle`.
- New event emitter (backend → Pi):
  - `stream:cmd` — emit to the socket for scoreboard :id. Payload: `{ action: 'start' | 'stop', streamKey: string, rtmpUrl: string }`. The Pi's `stream_scoreboard.py` will subscribe to this event.

### 4. Wire the new router in `backend/src/index.ts`

Mount the new router: `app.use('/api/scoreboards', streamRouter)`. (Match existing pattern from `gamechangerRouter`.)

### 5. Stream status broadcast on change

After updating `stream_status` in DB from a Pi socket message, also broadcast to the web browser via `state:update` for that room? **No — different shape.** Instead emit a new event `stream:status` to the room, payload: `{ status, lastError, startedAt }`. Browser listens to this.

Add this to `socket.ts` — add an `emitStreamStatus(boardId, payload)` helper similar to `emitStateUpdate`.

### 6. Modify existing routes that return scoreboards

Find the scoreboard fetch endpoint (likely `backend/src/routes/scoreboards.ts`) and ensure the response includes `streamStatus`, `streamStartedAt`, `streamLastError`, `streamKeyMasked`, `rtmpUrl`. **Do NOT** return the raw `streamKey` in list/get responses.

Check if `state-helpers.ts` has a `mapRowToScoreboard` function — update it to include these new fields.

### 7. Update `schema.sql` for fresh installs

Add the new columns to the table definition.

## Frontend Changes

### 1. Update types — `frontend/src/types.ts`

Add to `Scoreboard` interface:
```ts
streamKeyMasked?: string;  // e.g. "****abcd"
streamStatus: 'idle' | 'starting' | 'live' | 'error' | 'stopping';
streamStartedAt?: string | null;
streamLastError?: string | null;
rtmpUrl?: string | null;
```

### 2. Add API functions — `frontend/src/api.ts`

```ts
streamStart(id: number, rtmpUrl?: string): Promise<{ success: boolean; status: string }>;
streamStop(id: number): Promise<{ success: boolean; status: string }>;
streamStatus(id: number): Promise<{ status, lastError, startedAt, rtmpUrl, isConnected }>;
updateStreamKey(id: number, streamKey: string, rtmpUrl?: string): Promise<{ success: boolean }>;
```

### 3. New component — `frontend/src/components/StreamPanel.tsx`

Props: `{ scoreboardId: number, initialStreamStatus, initialStreamKeyMasked, initialRtmpUrl }`.

Layout:
- Header: "YouTube Live Stream" with a colored status dot (gray=idle, yellow=starting/stopping, green=live, red=error).
- Status line: current state and time-since-started if live.
- Buttons:
  - Big primary "Start Stream" (disabled when starting/stopping/live)
  - "Stop Stream" (visible only when starting/live)
- Error display when status==='error'
- "Last started: X ago" when idle

Behavior:
- Optimistic UI: clicking Start immediately sets local status to 'starting', calls API, updates from response.
- Also listens to socket `stream:status` events for the scoreboardId to keep in sync (use the existing `useScoreboardSocket` hook if convenient, OR add a new event listener on the same socket connection).
- Polls `streamStatus(id)` every 5s as fallback (matches the GC polling pattern).

### 4. Settings UI — extend `frontend/src/components/GameChangerPanel.tsx` OR create new `StreamSettings.tsx`

Add a new section in Settings tab (or wherever Settings is rendered — find it):
- Input field for "YouTube Stream Key" (type=password, show/hide toggle, masked by default showing only last 4)
- Input field for "RTMP URL" (default: "rtmp://a.rtmp.youtube.com/live2")
- "Save" button → calls `updateStreamKey`
- "Test Connection" button — could just trigger a stream:status check and show result

Find where Settings tab is rendered and add the stream section. Match the existing form styling.

### 5. Show stream panel on editor — `frontend/src/components/ScoreboardEditor.tsx`

Add the `StreamPanel` to the editor view (not just settings) so start/stop is one click away during a game. Place it below the scoreboard controls, above or below the existing tab content.

### 6. Socket stream status subscription

Inside the existing `useScoreboardSocket` hook (or a new effect), listen for `stream:status` events for the current scoreboard. Expose `streamStatus` state to consumers. (Or create a separate hook `useStreamStatus` if cleaner.)

## Verification Steps

1. Backend compiles (`cd backend && npx tsc --noEmit` — ignore pre-existing tsconfig-driven lint noise; the actual `npx tsx` runtime is what matters).
2. Backend starts: `cd backend && npx tsx src/index.ts` — no crashes.
3. Frontend builds: `cd frontend && npm run build` — clean build.
4. Test new endpoints with curl after backend restart:
   - `curl -X PUT http://localhost:4020/api/scoreboards/6/stream/key -H "Content-Type: application/json" -d '{"streamKey":"test-key-1234"}'`
   - `curl http://localhost:4020/api/scoreboards/6/stream/status`
   - `curl -X POST http://localhost:4020/api/scoreboards/6/stream/start -H "Content-Type: application/json" -d '{}'`
   - These should not crash. Without a Pi connected, `start` will log "no Pi socket available" but still succeed at the API level.

## What NOT to do

- Do NOT modify the existing `scoreboard_leds.py` on the Pi — that's out of scope for this prompt.
- Do NOT modify `stream_scoreboard.py` on the Pi — that's a later step.
- Do NOT add authentication, rate limiting, or other security features (user said no auth for now).
- Do NOT change the Cloudflare tunnel configuration.
- Do NOT change the existing `state:update` event shape or any GC integration.
- Do NOT add tests (none exist in this project; stay consistent).

## File List (Expected Changes)

```
backend/src/routes/stream.ts                          (NEW)
backend/src/socket.ts                                (MODIFY — add stream events + emitStreamStatus)
backend/src/index.ts                                 (MODIFY — mount streamRouter)
backend/src/state-helpers.ts                         (MODIFY — add stream fields to ScoreboardRow mapping)
backend/src/routes/scoreboards.ts                    (MODIFY — possibly; check how scoreboards are returned)
backend/src/types.ts                                 (MODIFY — add StreamStatus type)
frontend/src/types.ts                                (MODIFY — add stream fields)
frontend/src/api.ts                                  (MODIFY — add stream API functions)
frontend/src/components/StreamPanel.tsx              (NEW)
frontend/src/components/StreamSettings.tsx           (NEW) — or extend existing settings component
frontend/src/components/ScoreboardEditor.tsx         (MODIFY — add StreamPanel to editor view)
frontend/src/useScoreboardSocket.ts                  (MODIFY — expose stream:status listener)
schema.sql                                           (MODIFY — add columns)
```

Read the existing files first to match style and patterns before writing new code.
