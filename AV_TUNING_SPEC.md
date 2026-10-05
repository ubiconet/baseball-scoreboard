# Feature: Stream A/V tuning — volume slider + image adjustments + live camera preview

## Goal
In the scoreboard web app's stream settings, let the operator:
1. Adjust audio volume (gain in dB) with a slider
2. Adjust camera brightness and contrast with sliders
3. See a live camera preview image while adjusting image settings

All persisted per-scoreboard, forwarded to the Pi on stream start; image adjustments + preview also work LIVE while streaming and while idle.

## Project layout (all paths relative to repo root /Users/skuzmak/projects/scoreboard)
- `frontend/` React+TS+Vite. Settings UI: `frontend/src/components/StreamSettings.tsx` (has existing encoding drafts pattern — follow it). Socket client already exists (find it, likely `frontend/src/lib/` or hooks).
- `backend/` Express + TS. Routes: `backend/src/routes/stream.ts` (encoding PUT at line ~455, start at ~585 emits `stream:cmd` with outputWidth/Height/fps/audioBitrate). Socket: `backend/src/socket.ts`. Types: `backend/src/types.ts` (mapRowToScoreboard ~line 251), `backend/src/state-helpers.ts` (ScoreboardRow ~line 55). Migrations: `backend/migrations/*.sql` (applied manually; create 004, do NOT run psql).
- `pi/stream_scoreboard.py` — Flask control API (`build_control_app` ~line 1928, routes at 1937-1963), `StreamingService.start_streaming` (~1697, kwargs output_width/output_height/fps...), audio ffmpeg cmd (~752, already has `-af volume=10dB` — make the 10dB dynamic), video render loop (~1890, reads camera via `CameraSource.read()`, cv2 VideoCapture in `CameraSource` ~277-377).
- `pi/command_listener.py` — socket.io client to backend; handles `stream:cmd` action start/stop (~line 195-226, forwards encoding kwargs via `_to_snake`).

## Existing command flow (do not break)
Browser → `PUT /api/scoreboards/:id/stream/encoding` (persists) → on Start: `POST /stream/start` → backend emits `stream:cmd {action:start, streamKey, rtmpUrl, testPattern, outputWidth, outputHeight, fps, audioBitrate}` → command_listener forwards kwargs → `service.start_streaming(**kwargs)` → FFmpegStreamer spawns pipeline.

## Design

### 1. DB (migration 004 + schema.sql)
`backend/migrations/004_av_tuning.sql`:
```sql
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_audio_gain_db INTEGER NOT NULL DEFAULT 10;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_camera_brightness INTEGER;  -- NULL = camera default
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS stream_camera_contrast INTEGER;    -- NULL = camera default
```
Also add the three columns to `schema.sql` CREATE TABLE. Ranges: gain −10..30 dB; brightness/contrast 0..200 (100 = neutral, UVC-style percentage).

### 2. Backend
- `PUT /:id/stream/encoding`: accept `audioGainDb` (int −10..30), `cameraBrightness` (int 0..200 or null), `cameraContrast` (int 0..200 or null). Partial updates, same validation style as existing.
- `/stream/start`: include `audioGainDb`, `cameraBrightness`, `cameraContrast` in the `stream:cmd` payload.
- New route `POST /:id/stream/camera-tune` body `{brightness?, contrast?, preview?: boolean}` → emits `stream:cmd {action:'camera_tune', brightness, contrast, preview}` to the Pi socket (use `getSocketForScoreboard`, same as start). This drives LIVE adjustment + preview without restarting a stream. Also persist brightness/contrast if provided.
- New route `POST /:id/stream/preview` body `{enabled: boolean}` → same emit with only preview flag (can merge into camera-tune; your call, keep it simple).
- `socket.ts`: Pi→browser relay: on `stream:preview` (JPEG base64 payload from a Pi socket) re-emit to the scoreboard room so browsers receive it. Guard payload size (<200KB) and rate.
- types.ts/state-helpers.ts: add the three columns to row type + mapping (`streamAudioGainDb`, `cameraBrightness`, `cameraContrast`).

### 3. Pi — stream_scoreboard.py
- `start_streaming(..., audio_gain_db: Optional[int] = None, camera_brightness=None, camera_contrast=None)`: default gain 10. Audio ffmpeg cmd uses `-af volume={gain}dB` (replace hardcoded 10dB).
- `CameraSource`: add `apply_controls(brightness, contrast)` — `self._cap.set(cv2.CAP_PROP_BRIGHTNESS, b)` etc. UVC range is 0..200 with 100 neutral typically; clamp. Add a `threading.Lock` around `read()` + `apply_controls` so the preview thread and render loop don't collide.
- `CameraSource.preview_jpeg(max_width=480)`: grab one frame under the lock, downscale, return JPEG bytes. If camera not open, open a temp capture at 640x480 (and close it) — for idle preview.
- `StreamingService`: new method `camera_tune(brightness=None, contrast=None, preview=None)` — applies to live camera; toggles a preview flag. Preview emitter: background thread while flag set — every 1s, get `preview_jpeg()`, POST... no: hand bytes back to command_listener via a callback `self._on_preview(jpeg_bytes)` (service gets an optional callback like `_on_start`). When streaming, render loop also fine to reuse preview_jpeg (lock protects).
- Flask API: `POST /camera/tune` `{brightness, contrast, preview}` → `service.camera_tune(...)`; `GET /camera/preview.jpg` → latest JPEG bytes (local debugging convenience).
- CLI args: `--audio-gain-db` (default 10), `--camera-brightness`, `--camera-contrast` (ints, optional).

### 4. Pi — command_listener.py
- Handle `stream:cmd` action `camera_tune`: forward `brightness/contrast/preview` to a new `_on_camera_tune` callback (wire it in main() where `_on_start/_on_stop` are wired).
- New `_on_preview(jpeg_bytes)` callback wired to the service: emits socket event `stream:preview` `{jpeg: base64}` throttled to ≥1s between emits. Only when connected.

### 5. Frontend — StreamSettings.tsx
New "Audio & Image" section (below existing encoding section, same visual style):
- **Volume slider**: −10..+30 dB, default 10, step 1, live label ("+10 dB"). Saved via encoding PUT (applies on next stream start — note this in helper text).
- **Brightness / Contrast sliders**: 0..200, 100 neutral. On change (debounced ~400ms) → `POST /stream/camera-tune` with values → live effect on camera + preview. Also persisted via encoding PUT.
- **Preview pane**: toggle button "Show camera preview". When on: subscribe to socket `stream:preview` events for this scoreboard, render `<img src={data:image/jpeg;base64,...}>`, show "waiting for frames…" until first arrives. Button also triggers `POST /stream/camera-tune {preview:true}`; off → `{preview:false}` and unsubscribe.
- Keep drafts pattern: local draft state, Save button commits via the existing save flow (extend its PUT body with the three new fields).
- Find how StreamSettings loads/saves (it seeds drafts from `stream.encoding`) — extend that source object end-to-end (backend /status mapping → frontend prop).

## Constraints
- TypeScript strict — no `any` in new code.
- Python: stdlib + existing deps only (cv2, Pillow, Flask already used). ast.parse must pass.
- Do NOT touch the mpegts FIFO pipeline, pusher flags, arecord chain structure — only the `-af volume=` value and camera controls.
- Frontend builds with existing vite config — run `npm run build` in frontend/ at the end; run `cd backend && npx tsc --noEmit` to typecheck. Both must pass.
- Don't run git commit; leave the tree dirty for review.

## Deliverables
1. All file edits above
2. `frontend` build passes, `backend` tsc passes
3. A short summary of files changed and any deviations from this spec
