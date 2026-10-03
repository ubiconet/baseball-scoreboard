# Electronics Baseball Scoreboard

AI-scoreboard for baseball streams: web app (React frontend + Node backend) that overlays live GameChanger game data onto a camera feed, plus the Raspberry Pi streaming stack that captures and pushes video+audio to Twitch/YouTube.

## Components

- `frontend/` — React + TypeScript control panel + overlay UI
- `backend/` — Node/Express API, GameChanger integration (auth, polling, state derivation), scoreboard state, stream control
- `pi/` — Raspberry Pi side: `stream_scoreboard.py` (4-stage ffmpeg pipeline: camera → mpegts FIFO → merge → RTMP pusher, arecord audio), `command_listener.py` (backend command channel), systemd unit
- `schema.sql` — database schema
- `docs/` — GameChanger integration documentation

## Docs

- `API_DOCS.md` — backend API reference
- `WIRING.md` — Pi wiring / hardware notes
- `docs/GAMECHANGER_INTEGRATION.md` — reverse-engineered GameChanger API

## Runtime

Backend serves the frontend; Pi runs `stream_scoreboard.py` with a local control API on :8080 and receives overlay data from the backend (see `command_listener.py`).
