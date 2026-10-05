#!/usr/bin/env python3
"""
command_listener.py — Socket.io client that listens for stream:cmd events
from the scoreboard backend and translates them into start/stop calls on
the StreamingService.

The backend emits 'stream:cmd' to the scoreboard's socket.io room whenever
an operator clicks Start/Stop in the web UI. Payload shape:

  Start: { action: 'start', streamKey: '<rtmp-key>', rtmpUrl: '<ingestion-address>', broadcastId: '...' }
  Stop:  { action: 'stop' }

This module connects to the backend's socket.io endpoint with the same
identifier used by scoreboard_leds.py so we land in the same room.

Auth: deferred — same as scoreboard_leds.py, the Pi doesn't currently
authenticate the socket connection. The backend tracks our socket via the
'subscribe' emit and routes our stream:status acks back to the operator.

Pi-side error reporting: we emit 'stream:status' events back to the backend
so the operator UI reflects what's actually happening on the Pi (e.g.
ffmpeg crashed, camera missing, etc.).
"""

import base64
import logging
import threading
import time
from typing import Callable, Optional

import socketio  # python-socketio[client]

log = logging.getLogger("stream.command_listener")


def _to_snake(name: str) -> str:
    """camelCase → snake_case for translating JS-side field names to Python kwargs."""
    out = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


class StreamCommandListener:
    """Subscribes to stream:cmd AND state:update events from the backend.

    Public API:
        start() / stop()
        emit_status(status, error=None)  # forward to backend as stream:status
        set_socket_id_provider(fn)        # allow other modules to grab our socket id

    Events handled:
        - stream:cmd   → forwarded to on_start / on_stop callbacks
        - state:update → forwarded to on_state callback with compact payload
                         {h, a, i, hf, b, s, o, v}  (same shape as /api/display/IDENTIFIER)
    """

    def __init__(
        self,
        backend_url: str,
        identifier: str,
        on_start: Callable[..., None],
        on_stop: Callable[[], None],
        on_state: Optional[Callable[[dict], None]] = None,
        on_camera_tune: Optional[Callable[..., None]] = None,
    ) -> None:
        """
        Args:
            backend_url: e.g. "https://scoreboard.ubiconet.com"
            identifier: scoreboard unique identifier (same as scoreboard_leds.py)
            on_start: callback(stream_key, rtmp_url, test_pattern, **kwargs)
                      Optional kwargs (added 2026-09-23 for the encoding UI):
                        - output_width (int | None): encoder output width; None = no scaling
                        - output_height (int | None): encoder output height; None = no scaling
                        - fps (int): capture + encode frame rate (15/24/30)
                        - audio_bitrate (str): AAC bitrate like "64k", "96k", "128k"
                        - audio_gain_db (int): ffmpeg volume-filter gain, -10..30 dB
                        - camera_brightness (int | None): UVC 0..200, 100 neutral
                        - camera_contrast (int | None): UVC 0..200, 100 neutral
                      The Pi applies them on each new stream start — operator has
                      to Stop + Start to apply mid-session changes (ffmpeg can't
                      change resolution mid-stream).
                      test_pattern=True → push ffmpeg's testsrc2 filter (no camera)
            on_stop: callback() — called when we get a stop cmd
            on_state: callback(payload_dict) — called when we get a state:update
            on_camera_tune: callback(brightness=None, contrast=None, preview=None)
                      — called on stream:cmd {action:'camera_tune'} so the
                      operator can adjust the camera image + preview LIVE
                      (no stream restart needed).
        """
        self._backend_url = backend_url.rstrip("/")
        self._identifier = identifier
        self._on_start = on_start
        self._on_stop = on_stop
        self._on_state = on_state
        self._on_camera_tune = on_camera_tune

        # python-socketio client uses long-polling + websocket fallback, just
        # like the browser. Default reconnect logic is fine.
        self._sio = socketio.Client(
            reconnection=True,
            reconnection_delay=2.0,
            reconnection_delay_max=10.0,
            reconnection_attempts=0,  # infinite
            logger=False,
            engineio_logger=False,
        )

        self._scoreboard_id: Optional[int] = None
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._running = False
        # stream:preview emit throttle — at most one frame per second.
        # The service's preview loop already runs at ~1 fps; this stops
        # a runaway emitter from flooding the socket.
        self._last_preview_emit = 0.0

        self._register_handlers()

    def _register_handlers(self) -> None:
        @self._sio.on("connect")
        def on_connect():
            log.info("command_listener connected to backend")
            # We need the numeric scoreboard id, not the identifier string.
            # Ask the backend to look it up via /api/scoreboards?identifier=...
            # (synchronous — runs in a separate thread since socketio callbacks
            # can be async)
            threading.Thread(target=self._lookup_and_subscribe, daemon=True).start()

        @self._sio.on("disconnect")
        def on_disconnect():
            log.warning("command_listener disconnected from backend")

        @self._sio.on("stream:cmd")
        def on_stream_cmd(data):
            self._handle_command(data)

        @self._sio.on("state:update")
        def on_state_update(data):
            self._handle_state_update(data)

    def _lookup_and_subscribe(self) -> None:
        """Resolve identifier → numeric id and emit subscribe."""
        try:
            import requests

            # /api/scoreboards returns a list — find by uniqueIdentifier
            resp = requests.get(
                f"{self._backend_url}/api/scoreboards",
                timeout=10,
            )
            resp.raise_for_status()
            payload = resp.json()
            items = payload.get("scoreboards", [])
            scoreboard_id = None
            for item in items:
                if item.get("uniqueIdentifier") == self._identifier:
                    scoreboard_id = item["id"]
                    break

            if scoreboard_id is None:
                log.error(
                    "identifier %r not found in /api/scoreboards — cannot subscribe",
                    self._identifier,
                )
                return

            with self._lock:
                self._scoreboard_id = scoreboard_id

            log.info(
                "subscribing to scoreboard:%d (identifier=%s, role=pi)",
                scoreboard_id,
                self._identifier,
            )
            # Send role metadata so the backend can route stream:cmd events
            # to this socket specifically. Without role='pi', the backend's
            # getSocketForScoreboard would return whichever browser socket
            # joined last, and our stream:cmd would silently go to the wrong
            # client.
            self._sio.emit("subscribe", {"scoreboardId": scoreboard_id, "role": "pi"})
        except Exception as exc:
            log.error("failed to look up scoreboard id: %s", exc)

    def _handle_state_update(self, data) -> None:
        """Apply a state:update payload to the local overlay.

        The payload shape mirrors the /api/display/IDENTIFIER response —
        compact keys {h, a, i, hf, b, s, o, v} to minimize bandwidth.
        """
        if not isinstance(data, dict):
            return
        if self._on_state is None:
            return
        try:
            self._on_state(data)
        except Exception:
            log.exception("on_state callback raised")

    def _handle_command(self, data) -> None:
        try:
            action = (data or {}).get("action")
            if action == "start":
                stream_key = data.get("streamKey")
                rtmp_url = data.get("rtmpUrl")
                test_pattern = bool(data.get("testPattern", False))
                if not stream_key or not rtmp_url:
                    log.error("start cmd missing streamKey or rtmpUrl: %r", data)
                    self.emit_status("error", "start cmd missing streamKey or rtmpUrl")
                    return
                # Encoding settings (added 2026-09-23 for the Settings UI).
                # Forward as kwargs — the streamer's start_streaming()
                # accepts these and uses them when it spawns ffmpeg. Any
                # field that comes through as None/0 is ignored (the
                # streamer falls back to its CLI-arg defaults).
                # A/V tuning fields (audioGainDb / cameraBrightness /
                # cameraContrast) ride the same path (2026).
                encoding_kwargs = {}
                for kw in (
                    "outputWidth", "outputHeight", "fps", "audioBitrate",
                    "audioGainDb", "cameraBrightness", "cameraContrast",
                ):
                    if kw in data:
                        encoding_kwargs[_to_snake(kw)] = data[kw]
                log.info(
                    "received start cmd — rtmp=%s key=%s... testPattern=%s encoding=%s",
                    rtmp_url, stream_key[:8], test_pattern, encoding_kwargs,
                )
                try:
                    self._on_start(stream_key, rtmp_url, test_pattern, **encoding_kwargs)
                    # The actual stream start is async; final status will be
                    # reported by StreamingService via emit_status('live')
                except Exception as exc:
                    log.exception("on_start callback failed")
                    self.emit_status("error", f"start failed: {exc}")
            elif action == "stop":
                log.info("received stop cmd")
                try:
                    self._on_stop()
                    self.emit_status("idle")
                except Exception as exc:
                    log.exception("on_stop callback failed")
                    self.emit_status("error", f"stop failed: {exc}")
            elif action == "camera_tune":
                # Live camera tuning (A/V tuning feature): brightness /
                # contrast apply to the open camera immediately (works
                # while streaming AND while idle); preview toggles the
                # ~1fps JPEG emitter. No stream restart needed.
                brightness = data.get("brightness")
                contrast = data.get("contrast")
                preview = data.get("preview")
                log.info(
                    "received camera_tune cmd — brightness=%r contrast=%r preview=%r",
                    brightness, contrast, preview,
                )
                if self._on_camera_tune is None:
                    log.warning("camera_tune cmd received but no callback wired")
                    return
                try:
                    self._on_camera_tune(
                        brightness=brightness,
                        contrast=contrast,
                        preview=preview,
                    )
                except Exception as exc:
                    log.exception("on_camera_tune callback failed")
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
            else:
                log.warning("unknown stream:cmd action: %r", action)
        except Exception:
            log.exception("error handling stream:cmd")

    def emit_status(self, status: str, error: Optional[str] = None) -> None:
        """Forward our local status to the backend so the operator UI updates.

        Status values: 'starting' | 'live' | 'stopping' | 'idle' | 'error'
        """
        if not self._sio.connected:
            log.warning("cannot emit stream:status — not connected")
            return
        payload = {"status": status}
        if error:
            payload["error"] = error
        try:
            self._sio.emit("stream:status", payload)
        except Exception as exc:
            log.warning("failed to emit stream:status: %s", exc)

    def emit_preview(self, jpeg_bytes: bytes) -> None:
        """Forward a camera preview frame to the backend as stream:preview.

        Payload: { jpeg: <base64 JPEG> }. The backend relays it to the
        scoreboard's socket room so the Settings preview pane can render
        it. Throttled to at most one emit per second and dropped entirely
        when the socket is disconnected.
        """
        if not self._sio.connected:
            return
        now = time.monotonic()
        if now - self._last_preview_emit < 1.0:
            return
        self._last_preview_emit = now
        try:
            self._sio.emit(
                "stream:preview",
                {"jpeg": base64.b64encode(jpeg_bytes).decode("ascii")},
            )
        except Exception as exc:
            log.warning("failed to emit stream:preview: %s", exc)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._connect_loop, name="command-listener", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        try:
            if self._sio.connected:
                self._sio.disconnect()
        except Exception:
            pass

    def _connect_loop(self) -> None:
        """Connect with reconnect. Runs in background thread."""
        # Small initial delay so other things (logging, etc.) settle first
        time.sleep(0.5)
        while self._running:
            try:
                log.info("connecting to backend %s", self._backend_url)
                self._sio.connect(
                    self._backend_url,
                    transports=["websocket", "polling"],
                    wait_timeout=10,
                )
                # Block until disconnect
                self._sio.wait()
            except Exception as exc:
                log.warning("connection error: %s (will retry)", exc)
            if not self._running:
                break
            time.sleep(3)
        log.info("command_listener thread exiting")