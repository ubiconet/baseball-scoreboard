#!/usr/bin/env python3
"""
stream_scoreboard.py — Live-stream a Raspberry Pi camera feed to YouTube
with a scoreboard overlay (white text on a blue strip) along the bottom.

The script:
  * Captures from a Pi Camera (libcamera / Picamera2) or any V4L2 device.
  * Overlays the home/away scores and inning half on every frame.
  * Re-encodes the resulting stream with FFmpeg and pushes it to a
    configurable RTMP URL (default: YouTube Live).
  * Listens on a small Flask HTTP API so the scoreboard web app can
    start/stop streaming and update the overlay values without restarting
    the process.

Dependencies (system):
  * ffmpeg in PATH
  * libcamera / v4l2-ctl (Pi camera or USB webcam)

Dependencies (python):
  * flask, requests, pillow
  * picamera2  (Pi Camera Module 3 / libcamera on Bookworm)

Examples:
  # Stream to the default YouTube Live URL with a placeholder key:
  python3 stream_scoreboard.py --rtmp-url "rtmp://a.rtmp.youtube.com/live2"

  # Use a custom camera device and bind the control API on :8080:
  python3 stream_scoreboard.py --camera /dev/video0 --api-port 8080

  # Dry-run (skip FFmpeg, just render frames locally):
  python3 stream_scoreboard.py --dry-run

Scoreboard state is fetched from the remote API; pass --identifier to match
the same value used by scoreboard_leds.py. The overlay updates whenever a
new state:update event arrives OR the cached poll refreshes.
"""

import argparse
import io
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Optional

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]

try:
    from command_listener import StreamCommandListener
except ImportError:
    StreamCommandListener = None  # type: ignore[assignment]

try:
    from flask import Flask, jsonify, request
except ImportError:
    Flask = None  # type: ignore[assignment]

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None  # type: ignore[assignment]

try:
    from picamera2 import Picamera2
except ImportError:
    Picamera2 = None  # type: ignore[assignment]


BASE_URL = "https://scoreboard.ubiconet.com"
DEFAULT_YT_RTMP = "rtmp://a.rtmp.youtube.com/live2"
DEFAULT_API_PORT = 8080

log = logging.getLogger("stream_scoreboard")


# ---------------------------------------------------------------------------
# Overlay rendering
# ---------------------------------------------------------------------------

@dataclass
class OverlayState:
    """Snapshot of values drawn on the bottom strip."""
    home: int = 0
    away: int = 0
    inning: int = 1
    half: str = "top"
    team_home: str = "HOME"
    team_away: str = "AWAY"
    balls: int = 0
    strikes: int = 0
    outs: int = 0
    # Name of the GameChanger-auth team — the "us" team. The overlay
    # highlights whichever side (home/away label) currently matches this
    # name, so the local audience can spot their team at a glance. None
    # when no GC integration is configured.
    gc_team_name: Optional[str] = None


def _resolve_font(size: int):
    """Best-effort TrueType font lookup; falls back to PIL default."""
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_overlay(frame: "Image.Image", state: OverlayState) -> "Image.Image":
    """Draw a blue strip along the bottom with HOME / AWAY scores.

    Always renders the labels HOME / AWAY (not the user-configured team
    names) so the stripped-down overlay reads cleanly even for short
    attention spans on a mobile stream. The GameChanger-auth team
    ("ours") label is underlined in white so home viewers can spot
    which team is theirs at a glance — the underline swaps sides
    automatically as the GC team moves between home and away across
    different games.
    """
    if Image is None:
        raise RuntimeError("Pillow is required to overlay rendering")

    width, height = frame.size
    strip_height = max(40, height // 6)
    strip_y0 = height - strip_height

    base = frame.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    blue = (15, 70, 160, 255)
    draw.rectangle((0, strip_y0, width, height), fill=blue)

    is_top = str(state.half).lower().startswith("t")
    half_marker = "▲" if is_top else "▼"

    font_size = max(14, strip_height // 2)
    font = _resolve_font(font_size)

    # Decide which side is "us" (the team we're streaming for). Compare
    # the GC team name against the current home/away labels — whichever
    # it matches gets the yellow text. Case-insensitive because GC
    # sometimes shifts letter case.
    gc_name = (state.gc_team_name or "").strip()
    home_is_us = bool(gc_name) and gc_name.lower() == (state.team_home or "").strip().lower()
    away_is_us = bool(gc_name) and gc_name.lower() == (state.team_away or "").strip().lower()

    # Compose three separate fragments so each can use a different colour.
    # Drawing HOME/AWAY as separate `draw.text` calls (instead of embedded
    # in the full score line and then overdrawing the "us" one in yellow)
    # avoids the white-shadow ghost effect — there's no second render
    # behind the yellow text.
    home_label = "HOME"
    away_label = "AWAY"
    home_score_part = f"{home_label}  {state.home:>2}"
    away_score_part = f"{state.away:>2}  {away_label}"
    middle_part = f"   {half_marker} {state.inning}   "

    white = (255, 255, 255, 255)
    yellow = (240, 192, 64, 255)

    def measure(text):
        try:
            bb = draw.textbbox((0, 0), text, font=font)
            return bb[2] - bb[0], bb[3] - bb[1], -bb[1]
        except AttributeError:
            w, h = draw.textsize(text, font=font)
            return w, h, 0

    home_w, home_h, home_y_off = measure(home_score_part)
    away_w, away_h, away_y_off = measure(away_score_part)
    mid_w, mid_h, mid_y_off = measure(middle_part)

    # Center the whole composition horizontally. We pre-measure because
    # textbbox depends on the renderer, which only works after draw is
    # attached (which it is by this point).
    try:
        full_bbox = draw.textbbox(
            (0, 0),
            f"{home_score_part}{middle_part}{away_score_part}",
            font=font,
        )
        total_w = full_bbox[2] - full_bbox[0]
        total_h = full_bbox[3] - full_bbox[1]
        y_off = -full_bbox[1]
    except AttributeError:
        total_w = home_w + mid_w + away_w
        total_h = max(home_h, mid_h, away_h)
        y_off = 0

    x_start = max(0, (width - total_w) // 2)
    y = strip_y0 + (strip_height - total_h) // 2 + y_off

    # Draw each fragment in order: home (white or yellow), middle (white),
    # away (white or yellow). Each fragment is positioned by its measured
    # width so no ghosting can occur.
    cur_x = x_start
    home_color = yellow if home_is_us else white
    draw.text((cur_x, y), home_score_part, fill=home_color, font=font)
    cur_x += home_w
    draw.text((cur_x, y), middle_part, fill=white, font=font)
    cur_x += mid_w
    away_color = yellow if away_is_us else white
    draw.text((cur_x, y), away_score_part, fill=away_color, font=font)

    return Image.alpha_composite(base, overlay).convert("RGB")


def generate_test_frame(width: int, height: int, state: OverlayState) -> "Image.Image":
    """Render a synthetic frame for test-pattern mode.

    Draws a dark background with a 'TEST PATTERN' watermark and the
    scoreboard overlay strip along the bottom — same overlay used in
    camera mode, so test streams look like the real thing (just with a
    coloured backdrop instead of camera pixels). Spectators see the live
    scoreboard state even when there's no camera attached.
    """
    if Image is None:
        raise RuntimeError("Pillow is required to render test frames")
    if ImageDraw is None:
        raise RuntimeError("Pillow is required to render test frames")
    # Dark background — clearly not a real scene, but a tasteful navy
    # that matches the overlay palette rather than the default ffmpeg
    # SMPTE bars. Easier on the eyes for a long live stream.
    frame = Image.new("RGB", (width, height), (20, 30, 50))
    draw = ImageDraw.Draw(frame)

    # Big 'TEST PATTERN' watermark in the upper third. Sits in the dark
    # area above the overlay strip so it doesn't fight the score text.
    watermark = "TEST PATTERN  (no camera)"
    try:
        wm_font = _resolve_font(max(20, height // 14))
    except Exception:
        wm_font = ImageFont.load_default()
    try:
        wm_bbox = draw.textbbox((0, 0), watermark, font=wm_font)
        wm_w = wm_bbox[2] - wm_bbox[0]
        wm_h = wm_bbox[3] - wm_bbox[1]
    except AttributeError:
        wm_w, wm_h = draw.textsize(watermark, font=wm_font)
    wm_x = (width - wm_w) // 2
    wm_y = (height // 3) - (wm_h // 2)
    draw.text((wm_x, wm_y), watermark, fill=(180, 200, 220), font=wm_font)

    # Smaller sub-line so spectators know the live data is real
    subtitle = "Live scoreboard state — same overlay as the camera"
    try:
        sub_font = _resolve_font(max(12, height // 32))
    except Exception:
        sub_font = ImageFont.load_default()
    try:
        sub_bbox = draw.textbbox((0, 0), subtitle, font=sub_font)
        sub_w = sub_bbox[2] - sub_bbox[0]
    except AttributeError:
        sub_w, sub_h = draw.textsize(subtitle, font=sub_font)
    sub_x = (width - sub_w) // 2
    sub_y = wm_y + wm_h + 10
    draw.text((sub_x, sub_y), subtitle, fill=(140, 160, 180), font=sub_font)

    return render_overlay(frame, state)


# ---------------------------------------------------------------------------
# Camera capture
# ---------------------------------------------------------------------------

class CameraSource:
    """Yields RGB frames from a Pi Camera (Picamera2) or a V4L2 device."""

    def __init__(self, device: Optional[str], width: int, height: int, fps: int) -> None:
        self._device = device
        self._width = width
        self._height = height
        self._fps = fps
        self._picam = None
        self._use_picam = False
        # Set True when Picamera2 was initialised with format="RGB888" (the
        # libcamera quirk where the returned array is actually in BGR byte
        # order). When True, read() reverses the last axis to convert
        # BGR→RGB. Ignored when format="BGR888" is supported, in which case
        # the explicit cv2-style conversion in read() already handles it.
        self._picam_bgr_fallback = False
        # Serializes frame access (read / apply_controls / preview_jpeg)
        # between the streaming render loop, the camera-tune command path,
        # and the preview emitter thread. Without it, a V4L2 control write
        # racing a read() can corrupt the capture state.
        self._lock = threading.Lock()
        self._cv2 = None
        self._cap = None

        if Picamera2 is not None and device is None:
            try:
                self._picam = Picamera2()
                # IMPORTANT: request "BGR888" not "RGB888". Despite the name,
                # libcamera's "RGB888" format returns bytes in BGR order on
                # current Pi firmware — a documented libcamera quirk that
                # causes streamed scenes to render with red and blue swapped
                # (blue objects appear red, people look blue). Requesting
                # "BGR888" makes the pipeline produce what cv2-style code
                # already expects from the V4L2 path, so we can convert
                # BGR→RGB the same way for both camera backends.
                # See https://github.com/raspberrypi/picamera2/issues/729
                config = self._picam.create_video_configuration(
                    main={"size": (width, height), "format": "BGR888"}
                )
                self._picam.configure(config)
                self._picam.start()
                self._use_picam = True
                log.info("Pi Camera initialized at %dx%d @ %dfps", width, height, fps)
                return
            except Exception as exc:
                self._picam = None
                self._use_picam = False
                # If BGR888 is rejected (older libcamera builds), fall back
                # to RGB888 + an explicit slice-reversal below. This keeps the
                # streamer working on Pi OS images that don't have the fix.
                try:
                    self._picam = Picamera2()
                    config = self._picam.create_video_configuration(
                        main={"size": (width, height), "format": "RGB888"}
                    )
                    self._picam.configure(config)
                    self._picam.start()
                    self._use_picam = True
                    self._picam_bgr_fallback = True  # RGB888 mode returns BGR; reverse in read()
                    log.warning("Pi Camera BGR888 unsupported, using RGB888 + post-reversal fallback")
                    return
                except Exception as exc2:
                    log.warning("Picamera2 init failed (%s) — falling back to V4L2", exc2)
                    self._picam = None
                    self._use_picam = False

        if Image is None:
            raise RuntimeError("Pillow is required to read V4L2 frames")

        try:
            import cv2  # type: ignore[import-untyped]
            self._cv2 = cv2
            idx = int(device.replace("/dev/video", "")) if device else 0
            self._cap = cv2.VideoCapture(idx)
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            self._cap.set(cv2.CAP_PROP_FPS, fps)
            log.info("V4L2 camera initialized at /dev/video%d", idx)
        except Exception as exc:
            raise RuntimeError(f"Could not open camera {device}: {exc}") from exc

    def read(self) -> Optional["Image.Image"]:
        with self._lock:
            return self._read_locked()

    def _read_locked(self) -> Optional["Image.Image"]:
        if self._use_picam:
            try:
                array = self._picam.capture_array()
                # Libcamera's "RGB888" format string is a misnomer on current
                # Pi firmware — the returned numpy array is actually in BGR
                # byte order, not RGB. We explicitly normalise to RGB here so
                # downstream Pillow ops + the ffmpeg rgb24 stdin pipe both
                # see correct colors. When format="BGR888" was requested
                # successfully, the array is also BGR-ordered (matches
                # cv2's default), so the same conversion applies.
                # No-op cost on the fallback: numpy slice-reversal is ~5ms
                # at 720p, dominated by encode cost anyway.
                rgb = array[:, :, ::-1] if array.ndim == 3 else array
                return Image.fromarray(rgb)
            except Exception as exc:
                log.warning("Picamera2 frame failed: %s", exc)
                return None

        ok, frame = self._cap.read()
        if not ok:
            return None
        rgb = self._cv2.cvtColor(frame, self._cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb)

    def apply_controls(self, brightness: Optional[int], contrast: Optional[int]) -> None:
        """Apply brightness/contrast to the capture device (live).

        Scale is UVC-style percentage: 0..200 with 100 = neutral. Values
        are clamped to that range. Called by the camera_tune command path
        (backend slider) and right after camera open on stream start, so
        the operator's persisted image settings survive a restart.

        2026-10-05: the Centerm camera's V4L2 driver uses NON-UVC ranges
        (brightness -255..255 default 0, contrast 0..30 default 16). cv2's
        CAP_PROP setters pass the value straight through, so sending 0..200
        was a no-op for contrast (clamped to 30) and a nudge for brightness.
        Fix: query each control's actual min/max/default from the driver on
        first use and linearly map the 0..200 slider scale onto it
        (0 → driver min, 100 → driver default, 200 → driver max).
        """
        def clamp(v: int) -> int:
            return max(0, min(200, int(v)))

        def map_to_driver(slider_val: float, dmin: float, dmax: float, ddef: float) -> float:
            # Piecewise-linear: 0..100 maps min→default, 100..200 maps
            # default→max. Keeps 100 exactly at the driver default.
            if slider_val <= 100.0:
                if dmin == ddef:
                    return ddef
                return dmin + (slider_val / 100.0) * (ddef - dmin)
            if ddef == dmax:
                return dmax
            return ddef + ((slider_val - 100.0) / 100.0) * (dmax - ddef)

        with self._lock:
            if self._use_picam and self._picam is not None:
                controls = {}
                if brightness is not None:
                    controls["Brightness"] = (clamp(brightness) - 100) / 100.0
                if contrast is not None:
                    controls["Contrast"] = clamp(contrast) / 100.0
                if not controls:
                    return
                try:
                    self._picam.set_controls(controls)
                    log.info("picamera controls applied: %s", controls)
                except Exception as exc:
                    log.warning("failed to apply picamera controls: %s", exc)
                return
            cap = self._cap
            cv2 = self._cv2
            if cap is None or cv2 is None:
                log.warning("apply_controls: no V4L2 capture open — nothing to tune")
                return

            # V4L2 path: probe real driver ranges once, cache on the instance.
            # OpenCV has no portable range query for CAP_PROP_*; the reliable
            # source is `v4l2-ctl -l`. If that's unavailable, fall back to
            # the known Centerm ranges (still far better than raw passthrough).
            if getattr(self, "_ctrl_ranges", None) is None:
                self._ctrl_ranges = self._probe_v4l2_ranges() or {}
                # If the probe failed, assume UVC 0..200 (harmless no-op scale).
                self._ctrl_ranges.setdefault(
                    int(cv2.CAP_PROP_BRIGHTNESS), (-255.0, 255.0, 0.0))
                self._ctrl_ranges.setdefault(
                    int(cv2.CAP_PROP_CONTRAST), (0.0, 30.0, 16.0))
            ranges = self._ctrl_ranges

            try:
                if brightness is not None:
                    bmin, bmax, bdef = ranges[int(cv2.CAP_PROP_BRIGHTNESS)]
                    mapped = map_to_driver(clamp(brightness), bmin, bmax, bdef)
                    cap.set(cv2.CAP_PROP_BRIGHTNESS, mapped)
                if contrast is not None:
                    cmin, cmax, cdef = ranges[int(cv2.CAP_PROP_CONTRAST)]
                    mapped = map_to_driver(clamp(contrast), cmin, cmax, cdef)
                    cap.set(cv2.CAP_PROP_CONTRAST, mapped)
                log.info(
                    "v4l2 controls applied: brightness=%r contrast=%r (driver ranges %s)",
                    brightness, contrast, ranges,
                )
            except Exception as exc:
                log.warning("failed to apply v4l2 controls: %s", exc)

    def _probe_v4l2_ranges(self) -> Optional[dict[int, tuple[float, float, float]]]:
        """Parse `v4l2-ctl -l` for brightness/contrast min/max/default.

        Returns {cv2_prop_id: (min, max, default)} or None if v4l2-ctl is
        unavailable. Keys use cv2.CAP_PROP_* numeric ids so the caller can
        index with the same constants used for cap.set().
        """
        import re
        import subprocess

        if self._cv2 is None or not getattr(self, "_device", None):
            return None
        dev = self._device
        try:
            out = subprocess.run(
                ["v4l2-ctl", "-d", dev, "-l"],
                capture_output=True, text=True, timeout=5,
            ).stdout
        except Exception as exc:
            log.warning("v4l2-ctl probe failed: %s", exc)
            return None

        cv2 = self._cv2
        result: dict[int, tuple[float, float, float]] = {}
        # e.g. "brightness 0x00980900 (int) : min=-255 max=255 step=1 default=0 value=0"
        pat = re.compile(
            r"(brightness|contrast)\s+0x[0-9a-f]+\s+\(int\)\s*:\s*"
            r"min=(-?\d+)\s+max=(-?\d+)\s+step=\d+\s+default=(-?\d+)"
        )
        for m in pat.finditer(out):
            name, dmin, dmax, ddef = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
            prop = cv2.CAP_PROP_BRIGHTNESS if name == "brightness" else cv2.CAP_PROP_CONTRAST
            result[int(prop)] = (float(dmin), float(dmax), float(ddef))
        return result or None

    def preview_jpeg(self, max_width: int = 480) -> Optional[bytes]:
        """Grab one frame and return it as scaled-down JPEG bytes.

        Safe to call concurrently with the render loop — the lock
        serializes the grab with read()/apply_controls(). Returns None
        when no frame could be captured (camera missing, etc.).
        """
        if Image is None:
            return None
        try:
            with self._lock:
                frame = self._read_locked()
                if frame is None:
                    return None
                if frame.width > max_width:
                    scale = max_width / frame.width
                    frame = frame.resize((max_width, max(1, round(frame.height * scale))))
                buf = io.BytesIO()
                frame.save(buf, format="JPEG", quality=70)
                return buf.getvalue()
        except Exception as exc:
            log.warning("preview_jpeg failed: %s", exc)
            return None

    def close(self) -> None:
        if self._picam is not None:
            try:
                self._picam.stop()
                self._picam.close()
            except Exception:
                pass
        cap = getattr(self, "_cap", None)
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Audio device auto-detection
# ---------------------------------------------------------------------------

def _detect_usb_audio_device() -> Optional[str]:
    """Return an ALSA capture device string for the first USB audio device,
    or None if no USB audio hardware is present.

    We avoid spawning `arecord -l` (slow, parses text) and instead read
    /proc/asound/cards which is a tiny, stable kernel interface. The card
    id (e.g. 2) is what we want, returned as "plughw:N,0" so FFmpeg does
    sample-rate conversion automatically.

    Cards with USB-related identifiers in their names take priority so
    that the on-board bcm2835 HDMI/headphone jack isn't accidentally
    picked over a real USB microphone.
    """
    try:
        with open("/proc/asound/cards") as f:
            text = f.read()
    except OSError:
        return None
    cards = _parse_asound_cards(text)
    # Preference order (2026-10-04 user directive):
    #   1. STANDALONE USB audio device (kernel-safe — preferred).
    #   2. USB camera mic — kernel-hanging, last resort.
    #   3. Onboard bcm2835 (HDMI/headphone jack — usually nothing).
    usb_keywords = ("usb", "pnp", "c-media", "headset", "audio")
    for card in cards:
        if card["is_usb"] and any(kw in card["short_name"].lower() or kw in card["rest"].lower() for kw in usb_keywords):
            return f"plughw:{card['id']},0"
    camera_keywords = ("camera", "webcam", "uvc")
    for card in cards:
        if card["is_usb"] and any(kw in card["short_name"].lower() or kw in card["rest"].lower() for kw in camera_keywords):
            return f"plughw:{card['id']},0"
    for card in cards:
        return f"plughw:{card['id']},0"
    return None

def _parse_asound_cards(text: str) -> list:
    """Parse /proc/asound/cards into a list of dicts.

    Format example:
        0 [ALSA           ]: bcm2835 - bcm2835 ALSA
                              (bcm2835 ALSA is the on-board audio)
        2 [Device         ]: USB-Audio - USB PnP Sound Device
                              USB PnP Sound Device at usb-0000:01:00.0-1.2
    """
    import re
    cards = []
    current = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^(\d+)\s+\[([^\]]+)\]\s*:\s*(.*)$", line)
        if m:
            if current is not None:
                cards.append(current)
            current = {
                "id": int(m.group(1)),
                "short_name": m.group(2).strip(),
                "rest": m.group(3).strip(),
            }
        elif current is not None:
            current["rest"] += " " + line
    if current is not None:
        cards.append(current)
    for c in cards:
        c["is_usb"] = "usb" in c["rest"].lower() or "usb" in c["short_name"].lower()
    return cards


# ---------------------------------------------------------------------------
# FFmpeg streamer
# ---------------------------------------------------------------------------

class FFmpegStreamer:
    """Pushes raw RGB frames from stdin to an RTMP endpoint via FFmpeg.

    The streamer always pipes width × height frames and produces
    width × height output. ffmpeg scaling via `-vf scale=` would let
    the camera capture at a lower resolution and the viewer see a 720p
    stream — but that path is INCOMPATIBLE with the V4L2 M2M H.264
    encoder (deadlocks the codec when rawvideo-pipe frames pass
    through a software scale filter before the encoder). Stay at
    720p capture / 720p output.
    """

    def __init__(
        self,
        rtmp_url: str,
        stream_key: str,
        width: int,
        height: int,
        fps: int,
        output_width: Optional[int] = None,
        output_height: Optional[int] = None,
        audio_device: Optional[str] = None,
        audio_bitrate: str = "128k",
        audio_gain_db: Optional[int] = None,  # None → 10 dB (historic default)
        audio_sample_rate: int = 44100,
        audio_channels: int = 2,
        test_pattern: bool = False,  # noqa: ARG002 — kept for caller compat
    ) -> None:
        log.info("FFmpegStreamer.__init__ start (audio=%r, width=%d)", audio_device, width)
        # If output resolution not specified, capture == output (no scaling).
        if output_width is None:
            output_width = width
        if output_height is None:
            output_height = height
        if not stream_key:
            log.warning("No YouTube stream key provided — FFmpeg will still start but stream will be rejected.")

        # Stash the constructor args so start_streaming() can compare against
        # the running pipeline's current target — when the operator switches
        # platforms (Twitch → YouTube) or refreshes a YouTube key, the new
        # Start must tear down the old pipeline before spawning a new one.
        # Otherwise the old pipeline keeps pushing to the old RTMP URL while
        # the DB has the new broadcast id, and /display/TEST1 returns a
        # YouTube embed URL that never goes live (spectators see a frozen
        # player pointed at an empty YouTube broadcast).
        self.rtmp_url = rtmp_url
        self.stream_key = stream_key
        target = f"{rtmp_url.rstrip('/')}/{stream_key}" if stream_key else rtmp_url

        # ── FOUR-FFMPEG FIFO + FILE PIPELINE (workaround for h264_v4l2m2m deadlock) ──
        # The Pi's V4L2 M2M H.264 encoder (h264_v4l2m2m) deadlocks when given
        # BOTH a rawvideo input AND an infinite ALSA audio input, with a
        # streaming output muxer (FLV/mpegts). The encoder opens, reads ~1
        # frame from the pipe, then waits indefinitely for the muxer to
        # flush — which it never does with infinite audio. Symptom: rchar
        # grows, wchar stuck at exactly 67 (FLV header only), ffmpeg has
        # 1 thread in poll_schedule_timeout, no error in stderr.
        #
        # WORKAROUND: split the pipeline into FOUR small ffmpegs connected
        # by FIFOs + a growing FLV file. Each ffmpeg has at most ONE
        # input + ONE output, so the deadlock can't form:
        #
        #   ffmpeg_video: raw RGB24 stdin → h264_v4l2m2m encode → H.264 NAL → FIFO
        #   ffmpeg_audio: alsa capture → AAC encode → ADTS → FIFO
        #   ffmpeg_merge: read H.264 FIFO + AAC FIFO → -c copy → FLV FILE
        #   ffmpeg_push:  -stream_loop -1 -i FLV FILE → -c copy → RTMP target
        #
        # Why the pusher is a separate ffmpeg: the FLV muxer produces
        # valid FLV to a regular file (verified 22-25 fps in diff_test59),
        # but writing the same FLV directly to RTMP fails after ~2323
        # bytes — the FLV muxer needs to seek to update the header with
        # duration/filesize, which RTMP doesn't support. The pusher
        # reads the growing FLV file in a loop and re-emits it to RTMP,
        # a well-known re-stream operation that ffmpeg handles reliably
        # because the source file is properly formatted FLV.
        #
        # Verified 2026-07-27:
        #   - Merge → file: 22-25 fps sustained (diff_test59)
        #   - Pusher → RTMP: well-tested ffmpeg operation
        #   - Single-ffmpeg → RTMP: fails at 2323 bytes (root cause)
        # Video FIFO: mpegts format (has PTS — critical for the merge's
        # interleaver, see video_cmd note). Named .vts to distinguish it
        # from the merge→pusher TS FIFO below (both are mpegts now).
        self._h264_fifo = f"/tmp/scoreboard-stream-{os.getpid()}.vts"
        self._aac_fifo = f"/tmp/scoreboard-stream-{os.getpid()}.aac"
        # Merge→pusher transport: mpegts FIFO. Final design (2026-10-02):
        # the merge writes a self-describing mpegts byte stream (codec
        # params in the first TS packet) to the FIFO; the pusher reads
        # it via -f mpegts. On EOF the pusher exits, the watchdog
        # restarts it, the pusher re-opens the FIFO from its current
        # tail — no replay of stale data. No FLV file, no -stream_loop
        # -1, no TCP-fragile design.
        #
        # Migration history:
        #   - mpegts FIFO (first) → YouTube noData because the pusher's
        #     mpegts demuxer probed before audio buffered → "0 channels".
        #     FIX: explicit per-input options on the pusher (see
        #     push_cmd below).
        #   - FLV file + -stream_loop -1 (second) → worked but produced a
        #     visible 10s loop on every pusher restart. FIX: drop
        #     -stream_loop, exit on EOF, restart from FIFO live tail.
        #   - TCP socket (third) → too fragile (spawn-order races,
        #     reconnect timing). ABANDONED.
        self._merge_to_pusher_fifo = f"/tmp/scoreboard-stream-{os.getpid()}.ts"
        # ── Inter-process transport: TCP socket (was: FLV file + -stream_loop) ──
        # The old design had the merge ffmpeg write to a growing FLV
        # file on disk, and the pusher read it with `-stream_loop -1`.
        # That caused "looping" on Twitch: every time the RTMP
        # connection hiccupped, the watchdog restarted the pusher,
        # which re-read the FLV file from byte 0 and pushed the same
        # 38s of content again. The watchdog budget I added (5-in-30s)
        # didn't catch real-world failures because they occur every
        # ~12s — under the budget threshold. (See SKILL note in
        # pi-v4l2m2m-live-streaming-pipeline for why this design
        # existed originally.)
        #
        # New design: merge writes MPEG-TS to a local TCP socket
        # (127.0.0.1:<random port>); pusher reads MPEG-TS from that
        # socket and remuxes to FLV for RTMP. TCP is a byte stream —
        # no seek required, no file header rewrites, no loop on
        # restart. The pusher dies naturally when merge closes its TCP
        # write end (merge EOF → pusher sees EOF → pusher exits).
        # When the pusher restarts after an RTMP hiccup, it reconnects
        # to the still-listening socket and resumes from the live TCP
        # tail. No replay of stale data.
        #
        # MPEG-TS over TCP is the key choice: TS is stream-only by
        # design (no seekable container headers), so it works over any
        # stream transport. We pick TS over FLV here because FLV
        # muxer requires seek to update duration/filesize (per the
        # original skill note — FLV→RTMP dies at 2323 bytes). The
        # pusher then remuxes TS→FLV for RTMP via -c copy, which is
        # a pure container rewrite with no re-encode.
        #
        # ── THREE-FIFO PIPELINE (no TCP, no FLV file) ─────────────────────
        # Original design used an FLV file for the merge→pusher link.
        # That had two problems:
        #   1. FLV muxer requires seek to update headers mid-stream —
        #      writing to a FIFO breaks this (FIFOs are not seekable).
        #   2. The fix at the time was `-stream_loop -1` on the pusher,
        #      which re-reads the file from byte 0 on every pusher
        #      restart — a 10s loop bug.
        #
        # A later attempt used TCP with a Python accept() loop instead.
        # That had its own bug: the merge process's MPEG-TS output
        # actually went to /dev/null (stdout=DEVNULL), so the pusher
        # read a TCP socket that never got data. Verified 2026-09-23
        # during the "no live Twitch stream despite UI saying live"
        # debugging session.
        #
        # The correct fix: MPEG-TS over a FIFO. TS is stream-only
        # (no seekable container headers), so a FIFO works natively.
        # No file, no TCP accept logic, no loop bug.
        #
        # Layout:
        #   video ffmpeg  → writes H.264 NAL →  self._h264_fifo  → merge ffmpeg
        #   audio ffmpeg  → writes AAC ADTS →  self._aac_fifo   → merge ffmpeg
        #   merge ffmpeg  → muxes to MPEG-TS → self._merge_to_pusher_fifo    → pusher ffmpeg
        #   pusher ffmpeg → remuxes TS → FLV → RTMP target
        #
        # Pusher restart semantics: when the pusher dies (RTMP hiccup)
        # and the watchdog restarts it, it re-opens self._merge_to_pusher_fifo for
        # reading and resumes from the live tail. FIFOs naturally drop
        # bytes once read (no re-read on re-open), so there's no
        # possibility of a stale-data loop.
        #
        # Clean up any leftover FIFOs from a previous run.
        for f in (self._h264_fifo, self._aac_fifo, self._merge_to_pusher_fifo):
            try:
                os.unlink(f)
            except FileNotFoundError:
                pass
        os.mkfifo(self._h264_fifo)
        if audio_device:
            os.mkfifo(self._aac_fifo)
        os.mkfifo(self._merge_to_pusher_fifo)

        # ── Video ffmpeg: raw RGB24 stdin → h264_v4l2m2m → H.264 NAL FIFO ──
        # The streamer always captures and pipes at exactly this resolution
        # (`width`), so no scale filter is needed (and a software scale filter
        # before h264_v4l2m2m would deadlock the codec — see pi-v4l2-m2m-
        # encoder-pitfalls.md). capture == output, both at 720p.
        #
        # The output format `-f h264` is a raw H.264 bytestream — it preserves
        # the encoder's exact output including SPS/PPS (the merge ffmpeg
        # accepts this as input via `-f h264`).
        video_cmd = [
            "ffmpeg", "-y", "-loglevel", "warning",
            "-f", "rawvideo",
            "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}",
            "-framerate", str(fps),
            "-i", "-",
            # ── Hardware H.264 via the Pi 4's VPU ──
            # h264_v4l2m2m uses the Pi's dedicated H.264 hardware encoder
            # via the V4L2 mem2mem interface. This offloads the entire
            # encode workload from the CPU. Backed by /dev/video10 (encode)
            # and /dev/video11 (capture).
            #
            # KNOWN LIMITATION (verified 2026-09-23): the bcm2835-codec
            # driver exposes no bitrate control — v4l2-ctl --list-ctrls
            # shows only h264_level/h264_profile. ffmpeg's `-b:v NNN` is
            # SILENTLY DROPPED and the encoder emits ~120-400 kbps actual
            # regardless of request. On sports motion this looks blocky.
            # DO NOT switch to libx264 here without first verifying with
            # `top` that the CPU budget holds — at 480p30 with the LED
            # matrix SPI + backend poller running, libx264 -preset
            # veryfast pushed the system over the cliff and wedged the
            # Pi. Fix for motion quality must be done by lowering output
            # resolution (more bits per pixel on the hw encoder) or by
            # using -preset ultrafast under measurement, not by blindly
            # swapping to software encoding.
            "-vcodec", "h264_v4l2m2m",
            "-num_capture_buffers", "60",
            "-b:v", "4M",
            "-g", str(fps * 2),
            # CRITICAL: force the very first frame to be a keyframe
            # (IDR). Without this, the V4L2 M2M encoder's first IDR
            # appears at frame `-g` (~2s at 30fps), and the merge ffmpeg
            # (the 3rd process that muxes the H.264 FIFO into FLV) sits
            # idle in poll() until it sees a keyframe to anchor the
            # stream. Verified 2026-07-27: with this arg the merge
            # ffmpeg starts muxing immediately, 25.4 fps sustained
            # throughput. Without it, the merge ffmpeg produces 0 bytes
            # for the first ~2s and the video pipe backs up.
            "-force_key_frames", "expr:eq(t,0)",
            "-pix_fmt", "yuv420p",
            "-r", str(fps),
            # Encoder output size. Defaults to capture size (no scaling);
            # pass --output-width / --output-height at launch to enable
            # the V4L2 M2M encoder's built-in hardware scaler and
            # output a smaller stream. This packs more bits per pixel
            # into the hw encoder's actual ~200 kbps rate, cleaning up
            # motion artifacts with no CPU cost (vs. libx264, which
            # pushed the Pi over its CPU cliff at 480p30 — see the
            # encoder pitfall block above). The `-s` BEFORE `-vcodec`
            # (line ~561) is the capture size — must stay at
            # width×height; this `-s` AFTER the encoder is the output
            # size and is the one that triggers the hw scaler.
            "-s", f"{output_width}x{output_height}",
            # MPEGTS, not raw h264: raw H.264 has NOPTS timestamps,
            # which starves the merge's interleaver (video always wins
            # next-packet scheduling → AAC FIFO fills → audio producer
            # blocks → the entire audio chain freezes — the bug we
            # chased for days as an "ALSA problem"). mpegts carries
            # real PTS AND accepts Annex-B H.264 natively (unlike
            # matroska, which rejected the v4l2m2m stream's raw NAL
            # format — "Invalid data found when processing input").
            # Verified 2026-10-03 (exp5): ts fifo → merge → video+audio.
            "-f", "mpegts",
            self._h264_fifo,
        ]
        # ── Audio: arecord → pipe → ffmpeg (s16le) → AAC ADTS → FIFO ──
        # Only spawned when an audio device is configured. Writes ADTS
        # (Audio Data Transport Stream) frames, which the merge ffmpeg
        # can read via `-f aac` (auto-detects ADTS sync words).
        #
        # 2026-10-03: FFmpeg's ALSA demuxer (`-f alsa`) has a fatal bug
        # on this Pi: its capture thread stops reading from ALSA after
        # an xrun (rchar freezes at ~190KB) — verified on BOTH the
        # Centerm camera mic (plughw:2,0) and the standalone USB PnP
        # mic (plughw:1,0). Holding that stuck state open even crashed
        # the kernel when the mic shared a USB bus with the camera
        # (see scoreboard-streamer-debugging-history). arecord
        # (alsa-utils) reads the same devices flawlessly — verified
        # 5+ minutes of continuous capture with zero stalls. So we
        # pipe arecord raw PCM into ffmpeg stdin and never touch
        # ffmpeg's ALSA demuxer at all.
        audio_cmd = None
        arecord_cmd = None
        if audio_device:
            # Producer: arecord captures raw mono 16-bit PCM from the
            # ALSA device. --buffer-size=16384 (~170ms of mono audio)
            # absorbs USB bus contention bursts (camera + mic often
            # share an internal hub). -q keeps stderr clean.
            arecord_cmd = [
                "arecord",
                "-D", audio_device,
                "-f", "S16_LE",
                "-r", str(audio_sample_rate),
                "-c", str(audio_channels),
                "-t", "raw",
                "--buffer-size=16384",
                "-q",
            ]
            # Consumer: ffmpeg reads the raw PCM on stdin and encodes
            # AAC ADTS into the FIFO. Format pins must match arecord's
            # output exactly (-f s16le, same rate/channels).
            #
            # Digital gain (volume filter): the camera mic (plughw:2,0)
            # captures room tone at ~-37 dBFS RMS, which is audible but
            # quiet for field use. The mic itself has no ALSA gain
            # control, so we boost in the encode chain. Peaks were
            # ~-26 dBFS pre-boost, so the default +10dB keeps ~4dB of
            # headroom before clipping. The value is operator-tunable
            # from Settings → Audio & Image (-10..30 dB, default 10)
            # and applied on each stream start.
            gain_db = 10 if audio_gain_db is None else int(audio_gain_db)
            audio_cmd = [
                "ffmpeg", "-y", "-loglevel", "warning",
                "-f", "s16le",
                "-ar", str(audio_sample_rate),
                "-ac", str(audio_channels),
                "-i", "-",
                "-af", f"volume={gain_db}dB",
                "-c:a", "aac",
                "-b:a", audio_bitrate,
                "-ar", str(audio_sample_rate),
                "-ac", str(audio_channels),
                "-f", "adts",
                self._aac_fifo,
            ]
        # ── Merge ffmpeg: read H.264 + AAC FIFOs → FLV file ─────────────────
        # Writes a seekable FLV file on disk (NOT a FIFO, NOT TCP) because
        # the FLV muxer needs seek to update its header duration/filesize.
        # The pusher then reads the growing file with `-stream_loop -1`
        # and pushes to RTMP. This is the verified pi-v4l2m2m-live-
        # streaming-pipeline design that reliably produces valid FLV the
        # pusher can hand to YouTube without a probe step.
        #
        # -c copy = pure container rewrite, no re-encode. The H.264
        # and AAC packets are passed through unchanged into FLV.
        #
        # -flush_packets 1 is critical for live: it makes ffmpeg
        # flush after every packet so the file grows in real-time.
        # Without it, the FLV file stays at 0 bytes (all writes are
        # buffered until close). With it, the pusher can read fresh
        # bytes as soon as they're written.
        merge_cmd = [
            "ffmpeg", "-y", "-loglevel", "warning",
            # The merge step has the hardest job in the pipeline — both
            # input FIFOs are live, byte-streamed transports with no in-band
            # PTS. We force ffmpeg to synthesize stable timestamps so the
            # mpegts muxer (and downstream YouTube/Twitch audio/video
            # decoders) can pair A/V frames correctly. Specifically:
            #
            #   -fflags +genpts (global): regenerate PTS from packet
            #     arrival order when in-band PTS is missing.
            #
            # IMPORTANT: do NOT add `-use_wallclock_as_timestamps 1`
            # anywhere in this merge command. We tried:
            #
            #   1. global (both inputs) — broke video: mpegts muxer
            #      dropped H.264 frames whose wallclock PTS appeared
            #      "in the past" relative to the higher-rate audio
            #      stream. YouTube showed audio + scoreboard overlay
            #      but the rest of the screen was black. Verified
            #      2026-10-02.
            #
            #   2. AAC input only — fixed audio PTS but produced
            #      wallclock-scale audio timestamps (~1.79e9 seconds
            #      since epoch) that the mpegts muxer interpreted as
            #      a discontinuity from the millisecond-scale video
            #      PTS. The muxer errored out and the pusher wrote
            #      almost no bytes (336 bytes = FLV header only).
            #      Verified 2026-10-02 on Twitch.
            #
            # The current design (both inputs default packet-arrival
            # timing) is what works. The AAC demuxer's internal frame
            # counter assigns 23.2ms ticks to each ADTS frame, and
            # both inputs share the same stream-start origin so video
            # and audio interleave without discontinuity. This
            # recovers the original "audio clicks" symptom (all
            # audio at pts=0) but the pusher's `-c:a aac -ar 44100
            # -ac 1 -b:a 64k` re-encode normalizes the audio PTS to
            # match its own timing base.
            #
            # Output-side: -ar 44100 is the AAC sample rate. We pass
            # it as an OUTPUT option only because the AAC demuxer
            # can't parse the ADTS' sample_rate_index field as an
            # INPUT option in ffmpeg 7.x. The merge's mpegts muxer
            # writes the explicit sample rate into the TS PMT so
            # YouTube decodes at 44.1kHz.
            "-fflags", "+genpts",
            # The h264 demuxer (generic raw video) has no
            # `-video_size` option in ffmpeg 7.x — it infers the
            # size from the SPS NAL unit the encoder wrote. Just
            # pin the framerate so PTS regenerates at a known rate.
            # Video input is mpegts now (carries PTS — see producer
            # note). No -framerate needed; ts demuxer reads timestamps.
            "-f", "mpegts", "-i", self._h264_fifo,
        ]
        if audio_device:
            merge_cmd += [
                # Per-input options for the raw AAC ADTS demuxer.
                # Pinning channels means the demuxer doesn't have
                # to probe the FIFO for channel count — the FIFO
                # may be empty at probe time (audio ffmpeg hasn't
                # started writing yet), and an empty probe returns
                # "0 channels", which then propagates into the TS
                # PMT and confuses downstream consumers.
                # -ar (sample_rate) is NOT a valid input option for
                # the aac demuxer in ffmpeg 7.x — only -ac works as
                # an input pin here.
                #
                # NOTE: do NOT use `-use_wallclock_as_timestamps 1`
                # on the AAC demuxer. We tried that earlier for an
                # audio-PTS bug ("audio clicks" — all audio frames
                # landing at pts=0). It fixed the audio PTS, but
                # produced wallclock-scale timestamps (1790954975
                # seconds since epoch) that the mpegts muxer
                # interprets as a discontinuity from video PTS
                # (packet-arrival-order, ~milliseconds since stream
                # start). The muxer then errors out and the pusher
                # writes almost no bytes. Verified 2026-10-02 on
                # Twitch: pusher wchar stuck at 336 bytes (FLV
                # header) indefinitely, status stays "live" but
                # nothing reaches the RTMP ingest.
                #
                # The correct fix: BOTH inputs use the default
                # packet-arrival-order timing (from -fflags +genpts
                # applied globally above). The AAC demuxer
                # additionally uses its own internal frame counter
                # to assign 23.2ms ticks to each ADTS frame (1024
                # samples / 44100 Hz). Both inputs share the same
                # stream-start origin so audio and video interleave
                # correctly without a discontinuity.
                "-ac", str(audio_channels),
                "-f", "aac",
                "-i", self._aac_fifo,
            ]
        merge_cmd += [
            "-flush_packets", "1",
            "-c", "copy",
            # Output-side pin for sample rate. The -ac input pin
            # above set the channel count, but the sample rate is
            # only settable on the output side for the aac codec
            # (there's no -ar input option). This makes the merge
            # write 44100 Hz into the FLV header.
            # Output container is mpegts — byte-stream only, no seekable
            # container headers, perfect for FIFO transport.
            "-f", "mpegts",
            # Write to a local mpegts FIFO.
            # Output to a loopback TCP socket. The FLV muxer writes
            # the FLV header (9 bytes) + prev_tag_size (4 bytes) +
            # metadata + tags into the socket as bytes are flushed.
            # The pusher reads from this same socket and remuxes to
            # RTMP via -c copy. No file on disk, no FLV-file looping,
            # no -stream_loop -1 trick that seeks to byte 0 on EOF.
            #
            # Write to a local mpegts FIFO. The mpegts muxer is
            # byte-stream only (no seekable container headers), so a
            # FIFO works natively. The pusher reads from this same
            # FIFO via -f mpegts. When the merge closes the FIFO
            # (pipeline stop), the pusher's read sees EOF, exits
            # cleanly. When the pusher restarts after an RTMP hiccup,
            # it re-opens from current tail — fresh bytes only, no
            # replay of stale data, no -stream_loop -1.
            self._merge_to_pusher_fifo,
        ]
        # ── Pusher ffmpeg: read MPEG-TS from FIFO → -c copy → RTMP target ──
        # Reads the live MPEG-TS stream from the local TCP socket and
        # remuxes to FLV for RTMP. -c copy is a pure container
        # rewrite (TS packets → FLV tags), no re-encode.
        #
        # When the migrate fires: the merge ffmpeg closes its TCP
        # write end → pusher's TCP read sees EOF → pusher exits
        # cleanly (no `-stream_loop`, no infinite re-push of stale
        # data). When the pusher exits due to an RTMP hiccup, the
        # watchdog restarts it: it reconnects to the same TCP socket
        # and resumes from the live TCP tail — fresh bytes, no
        # replay.
        #
        # -fflags +genpts: regenerate PTS from packet arrival order
        # on the TCP source (more reliable than in-band timing after
        # a reconnect mid-stream).
        #
        # -re is NOT used here: it would throttle input to native
        # frame rate, but our source is a live MPEG-TS feed — no
        # throttling needed, the FIFO's natural backpressure handles
        # flow control.
        # Explicit audio input options: the merge writes a known-format
        # mpegts (AAC mono at 44.1kHz when audio is configured), yet
        # the pusher's mpegts demuxer probes the FIFO to confirm. The FIFO
        # is frequently short on data at startup (the audio ffmpeg just
        # spawned, hasn't buffered ADTS frames yet), so the probe falls
        # back to "0 channels" and aborts codec detection. YouTube's
        # RTMP ingest silently rejects the stream as noData because the
        # resulting FLV header is incomplete. Pinning the audio
        # parameters bypasses the probe, so the pusher trusts the format the
        # merge is configured to write. Verified 2026-10-02: this was the
        # ONLY remaining blocker once video timing was correct.
# Pusher ffmpeg: read mpegts from FIFO → -c copy → FLV → RTMP.
        #
        # The mpegts FIFO is byte-stream only (no seekable headers,
        # no -stream_loop -1 replay). When the merge closes the
        # FIFO (pipeline stop), the pusher's read sees EOF, exits
        # cleanly. When the pusher exits due to an RTMP hiccup, the
        # watchdog restarts it: it re-opens the FIFO from current
        # tail — fresh bytes, no replay of stale data, no FLV-file
        # seek-to-zero loop.
        #
        # Critical: pin BOTH the audio AND video input options on the
        # pusher so the mpegts demuxer does NOT probe the FIFO (it
        # would probe before audio had buffered and fail with "0
        # channels" / no codec parameters, causing Twitch/YouTube
        # noData). The merge writes a known-format mpegts (H.264 video
        # 480x360@24fps + AAC audio mono 44.1kHz); we tell the pusher
        # that's what we're feeding it.
        #
        # Without these pins the pusher prints:
        #   "Could not find codec parameters for stream 1 (Audio: aac,
        #    0 channels): unspecified sample format"
        # and the pusher's muxer writes an FLV with no audio codec
        # params — the RTMP ingest rejects it silently. Verified
        # 2026-10-02 (Twitch start). status never transitions to 'live'
        # because the pusher can't initialize.
        push_cmd = [
            "ffmpeg", "-y", "-loglevel", "warning",
            "-fflags", "+genpts+nobuffer",
            # analyzeduration/probesize: by default ffmpeg scans the first
            # 5MB of the input to detect codec parameters. For a live
            # FIFO this probe often runs BEFORE the merge has written
            # audio data (it can see just PAT/PMT, no PES), and the
            # demuxer reports "Audio: aac, 0 channels" — which then
            # gets locked in for the rest of the stream. The FLV muxer
            # can't write a valid audio header and silently emits no
            # audio track → RTMP goes through but spectators hear
            # silence. Verified 2026-10-02 on Twitch.
            #
            # 2026-10-03: with the video FIFO now mpegts (real PTS),
            # the merge interleaves audio properly from byte one, so
            # the TS stream is self-describing early. Old fix (probe
            # disabled: analyzeduration=0 + probesize=32) caused the
            # OPPOSITE failure: demuxer saw PAT/PMT only, declared
            # "0 channels", and the FLV muxer then refused to write
            # anything (pusher wchar stuck at 336 = header only).
            # New fix: a healthy 1s / 1MB probe budget. The pusher
            # spends ~2-5s of stream time probing, then pushes both
            # streams. Verified via exp6 (file-based): attempt 2
            # (1s/1MB) detects audio correctly.
            "-analyzeduration", "1000000",
            "-probesize", "1000000",
            "-f", "mpegts",
            "-i", self._merge_to_pusher_fifo,
            # Explicit stream selection: video track 0 and audio track
            # 0 (the `?` makes audio optional — no error if the merge
            # produces a video-only TS, though ours always has both).
            # Without -map, ffmpeg auto-selects all streams based on
            # probe results, which is unreliable for live FIFOs.
            "-map", "0:v:0",
            "-map", "0:a:0?",
            # ── Stream copy for BOTH tracks. ──
            # The old audio re-encode existed to compensate for a broken
            # probe on a garbage TS (ADTS missing at probe time). With
            # the video FIFO now mpegts (real PTS + interleaved audio
            # from the merge), the TS the pusher reads is self-describing:
            # PAT/PMT + AAC params are all present at probe time.
            # Re-encoding was OBSOLETE and actively harmful: the pusher's
            # aac decoder thread initialized but never emitted a frame,
            # so the FLV muxer never wrote anything (wchar stuck at 0,
            # verified 2026-10-03). -c copy for both streams fixes it.
            "-c", "copy",
            "-f", "flv",
            target,
        ]
        log.info(
            "Starting 4-ffmpeg pipeline → %s (video: %dx%d @ %dfps, audio: %s, merge-fifo: %s)",
            target, width, height, fps, audio_device or "disabled", self._merge_to_pusher_fifo,
        )
        # Write ffmpeg stderr to rotating logs for debugging. Each ffmpeg
        # gets its own log so we can tell which one errored.
        def _open_stderr_log(path: str):
            try:
                return open(path, "wb")
            except OSError:
                return subprocess.PIPE
        video_stderr = _open_stderr_log("/tmp/ffmpeg_video_stderr.log")
        audio_stderr = _open_stderr_log("/tmp/ffmpeg_audio_stderr.log") if audio_device else None
        merge_stderr = _open_stderr_log("/tmp/ffmpeg_merge_stderr.log")
        push_stderr = _open_stderr_log("/tmp/ffmpeg_push_stderr.log")
        # The video ffmpeg reads raw RGB24 frames on stdin. The streamer
        # writes 2.7MB blobs (width*height*3) per frame at frame_interval
        # cadence. No flush() — Python's buffered I/O + the kernel pipe's
        # natural backpressure handle flow control.
        # ── Spawn order: MERGE first, then PUSHER, then VIDEO, then AUDIO ──
        # Inter-process transport is FIFO. ffmpeg opening the write end
        # of a FIFO blocks until a reader opens the read end (and vice
        # versa). So:
        #
        #   1. Spawn MERGE first — it opens self._merge_to_pusher_fifo for writing
        #      and blocks inside Popen until the pusher opens it for
        #      reading.
        #   2. Spawn PUSHER — it opens self._merge_to_pusher_fifo for reading, which
        #      unblocks the merge. Both proceed.
        #
        # Without this ordering, the pusher would block on its FIFO
        # open and the merge would block on its FIFO open, and neither
        # would progress. (Same spawn-order rule as the original
        # design's h264 FIFO between video and merge ffmpegs.)
        self._audio_proc = None
        self._arecord_proc = None  # arecord producer feeding _audio_proc stdin
        self._merge_proc = None
        self._push_proc = None
        self._video_proc = None
        self._proc = None  # set after video_proc spawns
        log.info("about to spawn merge")
        try:
            self._merge_proc = subprocess.Popen(
                merge_cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=merge_stderr,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg not found in PATH") from exc
        except Exception as exc:
            log.error("merge Popen failed: %s: %s", type(exc).__name__, exc)
            raise
        try:
            self._push_proc = subprocess.Popen(
                push_cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=push_stderr,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg not found in PATH") from exc
        except Exception as exc:
            log.error("push Popen failed: %s: %s", type(exc).__name__, exc)
            raise
        try:
            self._video_proc = subprocess.Popen(
                video_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=video_stderr,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg not found in PATH") from exc
        except Exception as exc:
            log.error("video Popen failed: %s: %s", type(exc).__name__, exc)
            raise
        self._proc = self._video_proc  # back-compat: write() targets _proc.stdin
        if audio_device and audio_cmd and arecord_cmd:
            try:
                # Spawn ffmpeg first so the pipe target exists, then
                # arecord with its stdout wired to ffmpeg's stdin.
                self._audio_proc = subprocess.Popen(
                    audio_cmd,
                    stdin=subprocess.PIPE,  # arecord feeds raw PCM here
                    stdout=subprocess.DEVNULL,
                    stderr=audio_stderr,
                )
                # Producer: arecord writes raw PCM into ffmpeg stdin.
                # ffmpeg is a child of arecord's parent (us), so stop()
                # can terminate them independently.
                self._arecord_proc = subprocess.Popen(
                    arecord_cmd,
                    stdout=self._audio_proc.stdin,
                    stderr=audio_stderr,
                )
                # Parent holds a dup of the write end; close it so EOF
                # propagates correctly when arecord dies.
                self._audio_proc.stdin.close()
            except FileNotFoundError as exc:
                raise RuntimeError(f"audio process missing in PATH: {exc}") from exc
        # ── Audio watchdog: restart if rchar stops growing ──
        # The audio ffmpeg can silently get into a stuck state after an
        # ALSA buffer xrun: the capture thread stops reading from ALSA
        # (rchar stops growing) but the process stays alive. Without a
        # watchdog this manifests as "stream has video + score overlay
        # but no audio" — exactly the symptom that recurred in the
        # 2026-10-02 Twitch session.
        #
        # Detection: poll /proc/$PID/io every AUDIO_WATCHDOG_INTERVAL
        # seconds. If rchar hasn't changed for AUDIO_STUCK_SECS, kill
        # the audio process; the watchdog thread respawns it. The merge
        # keeps running (it reads from the AAC FIFO; the kill closes
        # the FIFO write end, the merge sees EOF on that input, and
        # the new audio ffmpeg opens a fresh FIFO write end which the
        # merge re-opens via the kernel pipe reopen mechanism).
        #
        # Why we don't restart the merge: the merge's job is to mux
        # the AAC FIFO into the TS FIFO. If audio is dead for a few
        # seconds, the merge continues muxing video-only TS. When audio
        # comes back, both streams pick up. A merge restart would lose
        # the FLV header state and break the pusher for ~5 seconds.
        self._audio_stop_flag = threading.Event()
        self._audio_watchdog_thread = None
        # 2026-10-04: audio watchdog DISABLED per user directive.
        # See scoreboard-streamer-debugging-history skill.
        # if audio_device and self._audio_proc is not None:
        #     self._audio_watchdog_thread = threading.Thread(
        #         target=self._audio_watchdog,
        #         args=(audio_cmd, audio_stderr),
        #         daemon=True,
        #     )
        #     self._audio_watchdog_thread.start()
        # ── Pusher watchdog: restart if it dies ──
        # The pusher can die if:
        #   1. The RTMP connection drops (network blip / Twitch side)
        #   2. ffmpeg crashes for any reason
        # We monitor it with a background thread that restarts it
        # with a backoff. The watchdog stops when stop() is called.
        #
        # DIFFERENCE FROM FLV-FILE DESIGN: when the pusher restarts
        # after an RTMP hiccup, it re-opens self._merge_to_pusher_fifo for reading
        # and resumes from the live FIFO tail. FIFOs naturally drop
        # bytes once read (a re-open reads only new bytes the writer
        # produces after the open), so there's NO replay of stale data
        # and NO need for `-stream_loop -1`. This is what eliminates
        # the 10-second loop bug.
        self._push_stop_flag = threading.Event()
        self._push_watchdog_thread = threading.Thread(
            target=self._push_watchdog,
            args=(push_cmd, push_stderr),
            daemon=True,
        )
        self._push_watchdog_thread.start()

    def write(self, frame_bytes: bytes) -> None:
        # _proc is set in __init__ only after Popen. If __init__ raised
        # mid-way (eg Popen for the merge couldn't open), _proc is None and
        # the camera thread's call to write() shouldn't crash — just
        # drop the frame. The streamer will then exit when the watchdog
        # notices the merge is dead.
        proc = self._proc
        if proc is not None and proc.stdin and not proc.stdin.closed:
            try:
                # No flush() — letting Python buffer frames lets the
                # kernel pipe absorb multiple frames in flight. flush()
                # would force a syscall per frame, which on a 2.7 MB
                # raw RGB frame is expensive. The pipe's natural flow
                # control (write blocks when full) handles backpressure.
                proc.stdin.write(frame_bytes)
            except (BrokenPipeError, OSError) as exc:
                log.error("FFmpeg pipe closed: %s", exc)

    def _audio_watchdog(self, audio_cmd: list, audio_stderr) -> None:
        """Background thread that restarts the audio ffmpeg if it's stuck.

        Symptom: after an ALSA buffer xrun, the audio ffmpeg's capture
        thread stops reading from the kernel (rchar frozen) but the
        process is alive. Detected by polling /proc/$PID/io.

        Restart budget: don't restart more than MAX_RESTARTS in WINDOW
        seconds — if we hit the budget, log fatal and stop the streamer
        (the supervisor can restart fresh). Matches the pusher watchdog's
        pattern.
        """
        AUDIO_WATCHDOG_INTERVAL = 2.0  # seconds between polls
        AUDIO_STUCK_THRESHOLD = 5.0    # rchar frozen this long → kill
        MAX_RESTARTS = 10
        WINDOW = 600.0
        restart_times = []
        last_rchar = 0
        stuck_since = None

        while not self._audio_stop_flag.is_set():
            proc = self._audio_proc
            if proc is None:
                # Already stopped or never started
                if self._audio_stop_flag.wait(timeout=AUDIO_WATCHDOG_INTERVAL):
                    return
                continue
            rc_pid = proc.poll()
            if rc_pid is not None:
                # Process exited — it might be normal (we asked it to stop)
                # or it crashed. If we asked it to stop, _audio_stop_flag
                # is set and we exit. Otherwise the next start_streaming
                # call will spawn a fresh audio ffmpeg.
                if self._audio_stop_flag.is_set():
                    return
                # Treat the exit as "needs restart"
                stuck_since = None
                last_rchar = 0
                if self._audio_stop_flag.wait(timeout=AUDIO_WATCHDOG_INTERVAL):
                    return
                continue

            # Process is alive. Read its rchar to detect stuck capture.
            try:
                with open(f"/proc/{proc.pid}/io", "r") as iof:
                    rchar = 0
                    for line in iof:
                        if line.startswith("rchar:"):
                            rchar = int(line.split()[1])
                            break
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                # Process disappeared between poll() and /proc read
                if self._audio_stop_flag.wait(timeout=AUDIO_WATCHDOG_INTERVAL):
                    return
                continue

            if rchar != last_rchar:
                # Audio is flowing
                last_rchar = rchar
                stuck_since = None
            else:
                # rchar frozen
                if stuck_since is None:
                    stuck_since = time.monotonic()
                elif (time.monotonic() - stuck_since) >= AUDIO_STUCK_THRESHOLD:
                    # Stuck for too long — nuke the proc and respawn.
                    log.warning(
                        "audio ffmpeg stuck (rchar=%d frozen for %.1fs), killing pid=%d",
                        last_rchar, AUDIO_STUCK_THRESHOLD, proc.pid,
                    )
                    try:
                        proc.kill()
                        proc.wait(timeout=3)
                    except (ProcessLookupError, subprocess.TimeoutExpired):
                        pass
                    # Respawn fresh
                    now = time.monotonic()
                    restart_times = [t for t in restart_times if now - t < WINDOW]
                    restart_times.append(now)
                    if len(restart_times) > MAX_RESTARTS:
                        log.fatal(
                            "audio watchdog: %d restarts in %.0fs — giving up",
                            MAX_RESTARTS, WINDOW,
                        )
                        # Don't tear down the streamer ourselves; let
                        # stop() be called from outside. Just exit the
                        # watchdog thread.
                        self._audio_stop_flag.set()
                        return
                    backoff = min(2.0 ** len(restart_times), 30.0)
                    if self._audio_stop_flag.wait(timeout=backoff):
                        return
                    try:
                        self._audio_proc = subprocess.Popen(
                            audio_cmd,
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            stderr=audio_stderr,
                        )
                        log.info(
                            "audio ffmpeg restarted (pid=%d)",
                            self._audio_proc.pid,
                        )
                    except FileNotFoundError:
                        log.error("audio ffmpeg restart: ffmpeg not found in PATH")
                        return
                    except Exception as exc:
                        log.error(
                            "audio ffmpeg restart failed: %s: %s",
                            type(exc).__name__, exc,
                        )
                        return
                    stuck_since = None
                    last_rchar = 0

            if self._audio_stop_flag.wait(timeout=AUDIO_WATCHDOG_INTERVAL):
                return

    def _push_watchdog(self, push_cmd: list, push_stderr) -> None:
        """Background thread that restarts the pusher if it dies.

        The pusher can die for several reasons:
          - RTMP connection dropped (network blip / Twitch side)
          - ffmpeg crashed
          - TCP source closed unexpectedly

        We poll the pusher every 2s and restart it with a backoff if
        it's dead.

        FAILURE BUDGET (added 2026-09-23, retuned 2026-09-23): if
        MAX_RESTARTS restarts happen within WINDOW seconds, the
        streamer is clearly stuck in a persistent failure loop
        (Twitch throttling, bad key, network outage). Log a FATAL,
        shut down cleanly (stop() — kills ffmpeg children + TCP
        listener), then exit. The supervisor / operator can restart
        the streamer for a fresh attempt.

        Budget rationale: real Twitch-side RTMP failures on this Pi
        have been observed to recur every ~12s. The original
        5-in-30s budget (6s avg between restarts) was too tight to
        catch them. 10-in-180s (18s avg) catches a sustained failure
        pattern within ~2 minutes while still tolerating real Twitch
        reconnect storms (which typically resolve in 30-60s).
        """
        # Failure budget: 30 restarts in 600 seconds → give up.
        # Tuned 2026-10-02: YouTube's RTMP server disconnects idle clients
        # after ~10s of no incoming bytes, and our encoder produces variable
        # bitrate (sometimes 0 bytes/sec when no motion in camera frame).
        # The pusher restarts every ~10-15s in normal operation without
        # anything actually being wrong. 30-in-600s (20s avg) catches a
        # sustained failure pattern (eg total network outage) within ~5
        # minutes while tolerating routine YouTube-side reconnects.
        MAX_RESTARTS = 30
        WINDOW = 600.0
        restart_timestamps = []  # monotonic times of recent restarts

        backoff = 1.0  # seconds between restart attempts
        while not self._push_stop_flag.is_set():
            # Check if pusher is still alive
            if self._push_proc is not None and self._push_proc.poll() is not None:
                log.warning(
                    "pusher ffmpeg exited (code=%s), restarting in %.1fs",
                    self._push_proc.returncode, backoff,
                )
                self._push_proc = None
                # Brief settle before reconnecting
                if self._push_stop_flag.wait(timeout=backoff):
                    return
                # Restart the pusher. It will re-open self._merge_to_pusher_fifo
                # for reading and resume from the live FIFO tail —
                # fresh bytes only, no replay (FIFOs drop bytes
                # already consumed by the previous pusher instance).
                try:
                    self._push_proc = subprocess.Popen(
                        push_cmd,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=push_stderr,
                    )
                    log.info("pusher ffmpeg restarted (pid=%d)", self._push_proc.pid)
                    backoff = 1.0  # reset backoff after successful restart
                except FileNotFoundError:
                    log.error("ffmpeg not found in PATH, pusher watchdog giving up")
                    return
                except Exception as exc:
                    log.error("failed to restart pusher: %s", exc)
                # Track restart time and check the failure budget.
                now = time.monotonic()
                restart_timestamps.append(now)
                # Drop timestamps outside the window
                restart_timestamps = [t for t in restart_timestamps if now - t <= WINDOW]
                if len(restart_timestamps) >= MAX_RESTARTS:
                    log.fatal(
                        "pusher failed %d times in %.0fs — likely persistent "
                        "RTMP issue (Twitch throttling, bad key, network). "
                        "Shutting down cleanly so operator can restart.",
                        len(restart_timestamps), WINDOW,
                    )
                    # Clean shutdown: stop() kills ffmpeg children +
                    # closes TCP listener + unlinks FIFOs. This fixes
                    # the orphan-ffmpeg-children bug that
                    # os._exit(1) caused.
                    try:
                        self._push_stop_flag.set()
                        self.stop()
                    except Exception as exc:
                        log.error("stop() failed during shutdown: %s", exc)
                    # Belt-and-suspenders: in the watchdog emergency-
                    # exit path, ffmpeg children sometimes survive
                    # stop() (e.g. video encoder stuck on a phantom
                    # FIFO write that lost its reader). Scan and kill
                    # any remaining ffmpegs we spawned, by PID prefix
                    # / cmdline match. This is a hard backstop.
                    try:
                        import subprocess as _sp
                        my_pid = os.getpid()
                        survivors = _sp.check_output(
                            ["pgrep", "-f", f"scoreboard-stream-{my_pid}"],
                            text=True,
                        ).split()
                        for sp in survivors:
                            try:
                                os.kill(int(sp), 9)
                            except ProcessLookupError:
                                pass
                    except Exception as exc:
                        log.error("orphan-scan failed: %s", exc)
                    logging.shutdown()
                    os._exit(1)
            # Sleep before next check
            self._push_stop_flag.wait(timeout=2.0)

    def stop(self) -> None:
        # Stop order matters:
        #   1. Close the writer (video stdin) → video ffmpeg sees EOF → exits
        #   2. Wait for video → its FIFO closes → merge sees EOF → exits
        #   3. Wait for merge → its FLV file is complete → pusher finishes
        #      the current loop iteration → exits (or we kill it)
        #   4. Stop audio (it captures from ALSA so it won't exit on its own)
        #   5. Kill pusher (it's reading the now-stale FLV file)
        #   6. Signal pusher watchdog to stop
        #   7. Clean up FIFOs and FLV file
        # Signal the watchdogs first so they don't try to restart
        # while we're tearing down
        if hasattr(self, '_push_stop_flag'):
            self._push_stop_flag.set()
        if hasattr(self, '_audio_stop_flag'):
            self._audio_stop_flag.set()
        # _proc is None when __init__ raised before any Popen ran.
        # In that case none of the children exist and there's nothing
        # to stop — just bail out cleanly. (Without this guard, calling
        # stop() on a half-constructed streamer crashes with
        # AttributeError on _proc / _video_proc / etc.)
        if not hasattr(self, '_video_proc') or self._video_proc is None:
            return
        if self._proc is not None and self._proc.stdin and not self._proc.stdin.closed:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
        # Wait for video ffmpeg
        try:
            self._video_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._video_proc.terminate()
            try:
                self._video_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._video_proc.kill()
        # Stop audio chain. arecord is the ALSA producer — kill it first
        # so it stops feeding the pipe; the ffmpeg encoder sees EOF and
        # exits cleanly after flushing the AAC FIFO.
        if getattr(self, "_arecord_proc", None) is not None:
            try:
                self._arecord_proc.terminate()
                self._arecord_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._arecord_proc.kill()
            except Exception:
                pass
            self._arecord_proc = None
        if self._audio_proc is not None:
            try:
                self._audio_proc.terminate()
                self._audio_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._audio_proc.kill()
        # Wait for merge ffmpeg (it should exit when the H.264 FIFO closes,
        # after the video ffmpeg exits and closes its write end)
        if self._merge_proc is not None:
            try:
                self._merge_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._merge_proc.terminate()
                try:
                    self._merge_proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._merge_proc.kill()
        # Stop pusher ffmpeg. With the TCP transport, when the merge ffmpeg
        # dies, the pusher's TCP read sees EOF and exits naturally.
        # But we still call terminate() as a hard backstop in case
        # it's blocked on RTMP write.
        if self._push_proc is not None:
            try:
                self._push_proc.terminate()
                self._push_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._push_proc.kill()
        # Clean up the video, audio, and merge-to-pusher FIFOs.
        for f in (self._h264_fifo, self._aac_fifo, self._merge_to_pusher_fifo):
            try:
                os.unlink(f)
            except FileNotFoundError:
                pass


# ---------------------------------------------------------------------------
# Scoreboard poller (lightweight, no socket.io dep here)
# ---------------------------------------------------------------------------

class ScoreboardPoller:
    """HTTP polling fallback for the scoreboard overlay.

    With socket.io state:update events driving the overlay in real time,
    this poller only exists as a safety net:
      1. Initial fetch on startup (so overlay isn't blank waiting for first push)
      2. Periodic reconciliation every RECONCILE_INTERVAL_SEC — catches any
         state:update pushes we missed (eg during brief Cloudflare disconnects)
      3. Triggers a fast poll if a socket reconnect is detected

    The poller is intentionally slow when idle. During active scoring the
    socket delivers updates in <100ms, so polling is just insurance.
    """

    RECONCILE_INTERVAL = 30.0  # seconds between safety-net polls when socket is healthy
    RECONCILE_AFTER_DROP = 5.0 # seconds to wait before polling after a socket drop
    LIVE_RECONCILE = 2.0       # seconds between polls when state has changed recently

    def __init__(self, base_url: str, identifier: str, overlay_state: OverlayState) -> None:
        self._url = f"{base_url.rstrip('/')}/display/{identifier}"
        self._overlay = overlay_state
        self._stop = threading.Event()
        self._etag: Optional[str] = None
        self._last_version: Optional[int] = None
        self._last_change_ts: float = 0.0
        self._last_apply_ts: float = 0.0
        self._last_push_ts: float = 0.0
        self._socket_connected: bool = False
        self._thread: Optional[threading.Thread] = None
        # Polling mode: 'live' (active scoring, push frequently),
        # 'idle' (no recent changes, push every 30s for safety net),
        # 'reconnect' (socket just dropped, push fast until reconnect).
        # Default 'idle' — the scoreboard overlay only needs fresh
        # data when something actually changed, and state:update pushes
        # deliver that in <100ms when the socket is healthy.
        self._mode: str = "idle"

    def set_socket_state(self, connected: bool) -> None:
        """Called by the socket listener when its connection state changes."""
        self._socket_connected = connected
        if not connected:
            log.info("scoreboard-poller: socket disconnected — switching to polling fallback")
        else:
            log.info("scoreboard-poller: socket reconnected — slowing polling")

    def note_push(self, version: int) -> None:
        """Called when we receive a state:update via socket — we trust the push
        and don't need to poll, but we record it for diagnostic purposes.
        """
        self._last_push_ts = time.monotonic()
        self._last_version = version
        self._last_change_ts = time.monotonic()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="scoreboard-poller")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def fetch_once(self) -> None:
        """Synchronous one-shot fetch. Called once at startup."""
        if requests is None:
            return
        try:
            resp = requests.get(self._url, timeout=10)
            if resp.status_code == 200:
                self._etag = resp.headers.get("ETag")
                self._apply(resp.json())
        except Exception as exc:
            log.warning("Initial poll failed: %s", exc)

    def _current_interval(self) -> float:
        """Pick the next poll interval based on the situation."""
        if not self._socket_connected:
            # Socket is down — poll at fallback rate until reconnect.
            return self.RECONCILE_AFTER_DROP
        # Socket is connected. If we've been getting live pushes recently,
        # poll more often as insurance; otherwise back off.
        if self._last_change_ts > 0 and (time.monotonic() - self._last_change_ts) < 600:
            return self.LIVE_RECONCILE
        return self.RECONCILE_INTERVAL

    def _loop(self) -> None:
        while not self._stop.wait(0):
            if requests is None:
                return
            try:
                headers = {"If-None-Match": self._etag} if self._etag else {}
                resp = requests.get(self._url, headers=headers, timeout=10)
                if resp.status_code == 200:
                    self._etag = resp.headers.get("ETag")
                    self._apply(resp.json())
            except Exception as exc:
                log.debug("Reconcile poll failed (ok if socket is healthy): %s", exc)
            wait_for = self._current_interval()
            self._stop.wait(wait_for)

    def _apply(self, payload: dict) -> None:
        apply_state(self._overlay, payload)
        # Track scoreboard version — used to detect stale pushes (eg after
        # a WebSocket reconnect) so we can re-poll instead of trusting an old value.
        version = payload.get("v")
        if version is not None:
            try:
                version = int(version)
            except (TypeError, ValueError):
                version = None
            if version is not None and version != self._last_version:
                self._last_version = version
                self._last_change_ts = time.monotonic()
                if self._mode == "idle":
                    log.info(f"scoreboard-poller: state changed (v={version}) — switching back to LIVE mode")


def apply_state(overlay: "OverlayState", payload: dict) -> None:
    """Apply a compact scoreboard payload {h,a,i,hf,b,s,o,v} to an overlay.

    Used by both the HTTP poller fallback AND the socket.io state:update
    callback so they share a single source of truth.
    """
    if "h" in payload:
        overlay.home = int(payload["h"])
    if "a" in payload:
        overlay.away = int(payload["a"])
    if "i" in payload:
        overlay.inning = int(payload["i"])
    if "hf" in payload:
        overlay.half = "bottom" if payload["hf"] == "b" else "top"
    elif "half" in payload:
        overlay.half = payload["half"]
    if "b" in payload:
        overlay.balls = int(payload["b"])
    if "s" in payload:
        overlay.strikes = int(payload["s"])
    if "o" in payload:
        overlay.outs = int(payload["o"])
    if "home_team" in payload:
        overlay.team_home = payload["home_team"]
    if "away_team" in payload:
        overlay.team_away = payload["away_team"]
    if "htn" in payload:
        overlay.team_home = payload["htn"] or "HOME"
    if "atn" in payload:
        overlay.team_away = payload["atn"] or "AWAY"
    # `gc` is the GameChanger-auth team name. Sent in the compact
    # socket payload but NOT used by this overlay except to decide which
    # side (HOME/AWAY label) to highlight for the local audience.
    if "gc" in payload:
        gc_raw = payload["gc"]
        overlay.gc_team_name = gc_raw if isinstance(gc_raw, str) and gc_raw else None


# ---------------------------------------------------------------------------
# Streaming loop + control API
# ---------------------------------------------------------------------------

class StreamingService:
    """Owns the capture + FFmpeg pipeline and exposes start/stop hooks."""

    def __init__(self, args: argparse.Namespace) -> None:
        self._args = args
        self._overlay = OverlayState(
            home=args.overlay_home,
            away=args.overlay_away,
            inning=args.overlay_inning,
            half=args.overlay_half,
        )
        self._camera: Optional[CameraSource] = None
        self._streamer: Optional[FFmpegStreamer] = None
        self._thread: Optional[threading.Thread] = None
        self._streaming = False
        self._test_pattern = False
        self._lock = threading.Lock()
        # ── Live camera tuning + preview state (A/V tuning feature) ──
        # Last-applied image knobs (UVC 0..200, None = camera default).
        # Stashed so a camera_tune arriving before the camera opens (or
        # between streams) is remembered and re-applied on next start.
        self._camera_brightness: Optional[int] = None
        self._camera_contrast: Optional[int] = None
        # Preview emitter: while _preview_enabled, a background thread
        # grabs ~1fps JPEGs and hands them to the _on_preview callback
        # (wired to command_listener in main()). _last_preview_jpeg
        # feeds the Flask GET /camera/preview.jpg debugging route.
        self._preview_enabled = False
        self._preview_thread: Optional[threading.Thread] = None
        self._on_preview = None  # Callable[[bytes], None]
        self._last_preview_jpeg: Optional[bytes] = None

    def set_overlay(self, **kwargs) -> OverlayState:
        for key, value in kwargs.items():
            if hasattr(self._overlay, key):
                setattr(self._overlay, key, value)
        return self._overlay

    def start_streaming(
        self,
        stream_key: Optional[str] = None,
        test_pattern: bool = False,
        output_width: Optional[int] = None,
        output_height: Optional[int] = None,
        fps: Optional[int] = None,
        audio_bitrate: Optional[str] = None,
        audio_gain_db: Optional[int] = None,
        camera_brightness: Optional[int] = None,
        camera_contrast: Optional[int] = None,
    ) -> dict:
        """
        Optional encoding overrides come from the backend's stream:cmd
        payload (added 2026-09-23 for the Settings UI). Each call to
        start_streaming reads fresh values — operator must Stop + Start
        to apply new settings to a running stream.

          output_width / output_height: None = use CLI-arg defaults
            (the --output-width/--output-height flags launched with).
            The V4L2 M2M encoder's hw scaler downsamples the capture
            to this resolution. Must be a supported preset
            (source / 480×360 / 320×240) — backend enforces.
          fps: None = use --fps CLI arg.
          audio_bitrate: None = use --audio-bitrate CLI arg.
          audio_gain_db: None = use --audio-gain-db CLI arg (default
            +10 dB). Feeds ffmpeg's -af volume= filter.
          camera_brightness / camera_contrast: UVC percentage 0..200
            (100 = neutral), None = leave the camera at its default.
            Applied right after the camera opens so the operator's
            persisted image settings carry into every stream.
        """
        with self._lock:
            # If we're already streaming and the operator clicked Start again
            # (e.g. switched platforms from Twitch → YouTube, or a fresh key
            # from a new YouTube broadcast), the existing 4-ffmpeg pipeline is
            # pointed at the OLD RTMP URL + key and will keep pushing there
            # silently — the backend already wrote the new broadcast id to
            # the DB, so /display/TEST1 returns a YouTube embed URL while the
            # Pi is still streaming to Twitch. Spectators see an embed that
            # never goes live. The fix: if the requested (rtmp_url, key)
            # differs from what's currently running, tear down the existing
            # pipeline first and start fresh. If they're identical (operator
# re-tapped Start without changing anything), early-return.
            new_rtmp = self._args.rtmp_url
            new_key = stream_key or self._args.stream_key
            if self._streaming:
                # Snapshot the live target without holding the lock. _run reads
                # it via streamer.rtmp_url; compare against what we were last
                # given via start_streaming.
                current_target = self._streamer.rtmp_url if self._streamer else None
                current_key = self._streamer.stream_key if self._streamer else None
                if current_target == new_rtmp and current_key == new_key:
                    log.info(
                        "start_streaming: pipeline already running with same target — early-return"
                    )
                    return {"streaming": True, "rtmp": new_rtmp}
                # Different target (platform switch, fresh key, etc.) — stop
                # the existing pipeline so the new Start can spawn a fresh one.
                log.info(
                    "start_streaming: target changed (%s → %s), stopping existing pipeline first",
                    current_target, new_rtmp,
                )
                self._streaming = False
            if self._streamer is not None:
                # stop_streaming requires release the lock to avoid re-entrancy
                # (FFmpegStreamer.stop joins child ffmpeg processes via
                # subprocess.wait which can block briefly). We snapshot and
                # clear, then stop outside the lock.
                old_streamer = self._streamer
                self._streamer = None
                old_camera = self._camera
                self._camera = None
            else:
                old_streamer = None
                old_camera = None
            # Outside the lock block: actually tear down the old pipeline.
            # (The above releases the lock on the next block exit; the with
            # statement at the top acquires it again for the new pipeline.
            # Simpler: do the stop work after this lock block in the existing
            # release point — see the cleanup path below.)
            key = stream_key or self._args.stream_key
            self._test_pattern = test_pattern
            if not test_pattern:
                # Only init the camera when we're going to feed it real frames.
                # Test-pattern mode synthesizes frames in _run from
                # generate_test_frame() and the overlay.
                self._camera = CameraSource(
                    device=self._args.camera,
                    width=self._args.width,
                    height=self._args.height,
                    fps=self._args.fps,
                )
                # Apply the operator's image settings to the freshly opened
                # camera. Runtime kwargs (from the backend's Start cmd) win
                # over the CLI-arg defaults; the resolved values are stashed
                # so a later camera_tune that only sends one knob can reapply
                # the other without a round-trip.
                resolved_brightness = camera_brightness if camera_brightness is not None else getattr(self._args, "camera_brightness", None)
                resolved_contrast = camera_contrast if camera_contrast is not None else getattr(self._args, "camera_contrast", None)
                self._camera_brightness = resolved_brightness
                self._camera_contrast = resolved_contrast
                if resolved_brightness is not None or resolved_contrast is not None:
                    self._camera.apply_controls(resolved_brightness, resolved_contrast)
            # Resolve audio device: explicit --no-audio wins, then
            # --audio-device, then auto-detect (first USB audio device).
            audio_device = self._resolve_audio_device()
            if not self._args.dry_run:
                self._streamer = FFmpegStreamer(
                    rtmp_url=self._args.rtmp_url,
                    stream_key=key,
                    # Capture resolution drives the camera; output
                    # resolution drives the encoded stream. With no
                    # --output-* args, capture==output (no scaling).
                    # Pass --output-width/--output-height to downscale
                    # via the V4L2 M2M encoder's hw scaler (more bits
                    # per pixel → cleaner motion at the encoder's
                    # actual ~200 kbps rate).
                    #
                    # Runtime overrides from the Settings UI win over
                    # CLI defaults: each Start applies whatever the
                    # operator last picked in the dropdowns.
                    width=self._args.width,
                    height=self._args.height,
                    output_width=output_width if output_width is not None else self._args.output_width,
                    output_height=output_height if output_height is not None else self._args.output_height,
                    fps=fps if fps is not None else self._args.fps,
                    audio_device=audio_device,
                    audio_bitrate=audio_bitrate if audio_bitrate is not None else self._args.audio_bitrate,
                    # Digital gain for ffmpeg's -af volume= filter.
                    # Runtime kwarg (Settings → Audio & Image) wins over
                    # the --audio-gain-db CLI default.
                    audio_gain_db=audio_gain_db if audio_gain_db is not None else getattr(self._args, "audio_gain_db", None),
                    audio_sample_rate=self._args.audio_sample_rate,
                    audio_channels=self._args.audio_channels,
                    test_pattern=test_pattern,
                )
            self._streaming = True
            self._thread = threading.Thread(target=self._run, daemon=True, name="streamer")
            self._thread.start()
        # Lock released. Now tear down the previous pipeline. The previous
        # ffmpeg subprocesses are still running (the new pipeline's encoder
        # uses a different FIFO name, so the OS file table hasn't recycled
        # them yet). Stopping them here is safe — the previous thread's
        # _run loop checks _streaming and will exit promptly when stop()
        # signals its child ffmpegs.
        if old_streamer is not None:
            try:
                old_streamer.stop()
            except Exception as exc:
                log.warning("failed to stop old streamer during target switch: %s", exc)
        if old_camera is not None:
            try:
                old_camera.close()
            except Exception as exc:
                log.warning("failed to close old camera during target switch: %s", exc)
        return {
            "streaming": True,
            "rtmp": self._args.rtmp_url,
            "stream_key_set": bool(key),
            "test_pattern": test_pattern,
        }

    def stop_streaming(self) -> dict:
        with self._lock:
            if not self._streaming:
                return {"streaming": False}
            self._streaming = False
        if self._streamer is not None:
            self._streamer.stop()
            self._streamer = None
        if self._camera is not None:
            self._camera.close()
            self._camera = None
        return {"streaming": False}

    # ── Live camera tuning + preview (A/V tuning feature) ──────────────

    def set_preview_callback(self, callback) -> None:
        """Register the sink for preview frames.

        Wired in main() to command_listener.emit_preview, which relays
        the JPEG to the backend as a stream:preview socket event.
        """
        self._on_preview = callback

    def camera_tune(
        self,
        brightness: Optional[int] = None,
        contrast: Optional[int] = None,
        preview: Optional[bool] = None,
    ) -> dict:
        """Apply camera image controls and/or toggle the preview emitter.

        Called by the camera_tune stream:cmd (backend's /stream/camera-tune
        route) — works LIVE while streaming (the CameraSource lock keeps
        the control write safe against the render loop) and while idle
        (values are stashed and re-applied on the next stream start).
        """
        if brightness is not None:
            self._camera_brightness = brightness
        if contrast is not None:
            self._camera_contrast = contrast

        if brightness is not None or contrast is not None:
            with self._lock:
                camera = self._camera
            if camera is not None:
                camera.apply_controls(self._camera_brightness, self._camera_contrast)
            else:
                # Idle (not streaming): V4L2 controls are device-global and
                # persist in the driver, so applying them through a short-lived
                # capture works AND sticks — the next stream (or idle preview)
                # then renders with the operator's values already in effect.
                temp: Optional[CameraSource] = None
                try:
                    temp = CameraSource(
                        device=self._args.camera, width=640, height=480, fps=15
                    )
                    temp.apply_controls(self._camera_brightness, self._camera_contrast)
                    log.info(
                        "camera_tune: applied while idle via temp capture "
                        "(brightness=%r contrast=%r)",
                        self._camera_brightness, self._camera_contrast,
                    )
                except Exception as exc:
                    log.warning("camera_tune: idle apply failed: %s", exc)
                finally:
                    if temp is not None:
                        try:
                            temp.close()
                        except Exception:
                            pass

        if preview is not None:
            self._set_preview_enabled(preview)

        return {
            "brightness": self._camera_brightness,
            "contrast": self._camera_contrast,
            "preview": self._preview_enabled,
        }

    def last_preview_jpeg(self) -> Optional[bytes]:
        """Most recent preview frame (for the Flask /camera/preview.jpg route)."""
        return self._last_preview_jpeg

    def _set_preview_enabled(self, enabled: bool) -> None:
        self._preview_enabled = enabled
        if enabled and (self._preview_thread is None or not self._preview_thread.is_alive()):
            self._preview_thread = threading.Thread(
                target=self._preview_loop, daemon=True, name="camera-preview"
            )
            self._preview_thread.start()
            log.info("camera preview emitter started")
        elif not enabled:
            log.info("camera preview emitter disabled (loop will exit)")

    def _preview_loop(self) -> None:
        """Emit a preview JPEG roughly once per second while enabled."""
        while self._preview_enabled:
            jpeg = self._preview_frame()
            if jpeg is not None:
                self._last_preview_jpeg = jpeg
                callback = self._on_preview
                if callback is not None:
                    try:
                        callback(jpeg)
                    except Exception as exc:
                        log.warning("preview callback failed: %s", exc)
            time.sleep(1.0)
        log.info("camera preview emitter loop exited")

    def _preview_frame(self) -> Optional[bytes]:
        """Grab a preview JPEG from the live camera, or a temp capture when idle."""
        with self._lock:
            camera = self._camera
        if camera is not None:
            return camera.preview_jpeg()
        # Idle (not streaming): open a temporary 640x480 capture just long
        # enough to grab one frame, then close it. This is what makes the
        # preview work while no stream is running. CameraSource picks the
        # same backend (Picamera2 or V4L2) the streamer itself would use.
        temp: Optional[CameraSource] = None
        try:
            temp = CameraSource(
                device=self._args.camera,
                width=640,
                height=480,
                fps=15,
            )
            # Re-apply the operator's persisted image settings so the idle
            # preview shows the same look the stream will have (V4L2 controls
            # live in the driver, but another process could have reset them).
            temp.apply_controls(self._camera_brightness, self._camera_contrast)
            return temp.preview_jpeg()
        except Exception as exc:
            log.debug("idle preview capture failed: %s", exc)
            return None
        finally:
            if temp is not None:
                try:
                    temp.close()
                except Exception:
                    pass

    def _resolve_audio_device(self) -> Optional[str]:
        """Determine which ALSA device (if any) to capture audio from.

        Priority:
          1. --no-audio flag → returns None (video-only stream)
          2. --audio-device "..." → returns the literal string (even "")
          3. Auto-detect first USB audio device via /proc/asound
          4. Falls back to None (video-only) if no audio found
        """
        if self._args.no_audio:
            log.info("audio disabled via --no-audio")
            return None
        if self._args.audio_device is not None:
            # User passed an explicit device (including '' to force-disable
            # without using --no-audio)
            if self._args.audio_device == "":
                log.info("audio disabled via empty --audio-device")
                return None
            log.info("audio device from --audio-device: %s", self._args.audio_device)
            return self._args.audio_device
        # Auto-detect: look for USB audio cards in /proc/asound
        auto = _detect_usb_audio_device()
        if auto:
            log.info("audio device auto-detected: %s", auto)
        else:
            log.info("no USB audio device found — streaming video-only")
        return auto

    def status(self) -> dict:
        return {
            "streaming": self._streaming,
            "rtmp": self._args.rtmp_url,
            "overlay": self._overlay.__dict__,
            "width": self._args.width,
            "height": self._args.height,
            "fps": self._args.fps,
        }

    def _run(self) -> None:
        frame_interval = 1.0 / max(1, self._args.fps)
        while self._streaming:
            start = time.monotonic()
            if self._streamer is None:
                break
            if self._test_pattern:
                # Synthesize a frame at the output resolution. The pipe
                # traffic always matches the ffmpeg `-s` argument.
                # The overlay is read live from self._overlay so state
                # updates from the backend are reflected on the next
                # frame without restarting the stream.
                frame = generate_test_frame(
                    self._args.width,
                    self._args.height,
                    self._overlay,
                )
            else:
                if self._camera is None:
                    break
                frame = self._camera.read()
                if frame is None:
                    time.sleep(frame_interval)
                    continue
                frame = render_overlay(frame, self._overlay)
            if self._args.dry_run:
                frame.save("/tmp/scoreboard_preview.jpg")
            else:
                # Raw RGB24 bytes — width*height*3 contiguous. ffmpeg
                # reads this with -f rawvideo -pix_fmt rgb24. Pillow's
                # JPEG encoder was the bottleneck; writing the frame
                # buffer directly is essentially a memcpy (~3ms at 720p)
                # and lets ffmpeg's libx264 handle H.264 encoding.
                self._streamer.write(frame.tobytes())
            elapsed = time.monotonic() - start
            sleep_for = frame_interval - elapsed
            if sleep_for > 0:
                time.sleep(sleep_for)


# ---------------------------------------------------------------------------
# Flask control API
# ---------------------------------------------------------------------------

def build_control_app(service: StreamingService) -> "Flask":
    if Flask is None:
        raise RuntimeError("Flask is required for the control API; install flask or pass --no-api.")

    app = Flask("stream_scoreboard")

    @app.get("/status")
    def status():
        return jsonify(service.status())

    @app.post("/overlay")
    def set_overlay():
        payload = request.get_json(silent=True) or {}
        overlay = service.set_overlay(**{k: v for k, v in payload.items() if v is not None})
        return jsonify({"overlay": overlay.__dict__})

    @app.post("/stream/start")
    def start_stream():
        payload = request.get_json(silent=True) or {}
        return jsonify(service.start_streaming(
            stream_key=payload.get("stream_key"),
            test_pattern=bool(payload.get("test_pattern", False)),
        ))

    @app.post("/stream/stop")
    def stop_stream():
        return jsonify(service.stop_streaming())

    @app.post("/rtmp")
    def set_rtmp():
        payload = request.get_json(silent=True) or {}
        url = payload.get("rtmp_url")
        if url:
            service._args.rtmp_url = url
        return jsonify({"rtmp_url": service._args.rtmp_url})

    @app.post("/camera/tune")
    def camera_tune():
        payload = request.get_json(silent=True) or {}
        return jsonify(service.camera_tune(
            brightness=payload.get("brightness"),
            contrast=payload.get("contrast"),
            preview=payload.get("preview"),
        ))

    @app.get("/camera/preview.jpg")
    def camera_preview():
        """Latest preview frame — local debugging convenience.

        The operator-facing preview flows through the socket relay
        (stream:preview events); this endpoint is for curl / browser
        checks directly against the Pi's control API.
        """
        jpeg = service.last_preview_jpeg()
        if jpeg is None:
            return jsonify({"error": "no preview frame yet"}), 503
        return app.response_class(jpeg, mimetype="image/jpeg")

    return app


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Stream a Pi camera to YouTube with a scoreboard overlay.")
    p.add_argument("--identifier", type=str, default="TEST1", help="Scoreboard identifier slug.")
    p.add_argument("--url", type=str, default=BASE_URL, help="Scoreboard API base URL.")
    p.add_argument("--poll-interval", type=float, default=5.0, help="Seconds between scoreboard HTTP polls.")

    p.add_argument("--rtmp-url", type=str, default=DEFAULT_YT_RTMP,
                   help=f"RTMP base URL (default: {DEFAULT_YT_RTMP})")
    p.add_argument("--stream-key", type=str, default="",
                   help="YouTube stream key. Can also be set via the /stream/start API.")

    p.add_argument("--camera", type=str, default=None,
                   help="V4L2 device path (e.g. /dev/video0). Defaults to Pi Camera via Picamera2.")
    p.add_argument("--test-pattern", action="store_true",
                   help="Push ffmpeg's testsrc2 filter to the RTMP endpoint "
                        "instead of camera frames. Skips camera init entirely — "
                        "useful when the camera is missing or you want to verify "
                        "the YouTube pipeline end-to-end without hardware. The "
                        "start cmd from the backend can also flip this per-stream "
                        "via its testPattern field.")
    p.add_argument("--width", type=int, default=1280,
                   help="Video width (capture). Use --output-width to downscale the stream.")
    p.add_argument("--height", type=int, default=720,
                   help="Video height (capture). Use --output-height to downscale the stream.")
    p.add_argument("--output-width", type=int, default=None,
                   help="Encoder output width. When set (and != --width), the V4L2 M2M "
                        "encoder's built-in hardware scaler downsamples from --width. "
                        "Useful when the hw encoder's actual bitrate (~200 kbps, ignoring "
                        "-b:v) makes motion blocky: lower output packs more bits per pixel. "
                        "Default: same as --width (no scaling).")
    p.add_argument("--output-height", type=int, default=None,
                   help="Encoder output height. See --output-width.")
    p.add_argument("--fps", type=int, default=30)

    p.add_argument("--overlay-home", type=int, default=0)
    p.add_argument("--overlay-away", type=int, default=0)
    p.add_argument("--overlay-inning", type=int, default=1)
    p.add_argument("--overlay-half", type=str, default="top", choices=("top", "bottom"))

    # ── Audio capture ──
    p.add_argument(
        "--audio-device",
        type=str,
        default=None,
        help="ALSA device for audio capture (e.g. 'plughw:2,0'). Default: auto-detect first USB audio device; pass '' to disable.",
    )
    p.add_argument(
        "--no-audio",
        action="store_true",
        help="Disable audio capture entirely (video-only stream).",
    )
    p.add_argument(
        "--audio-bitrate",
        type=str,
        default="128k",
        help="AAC audio bitrate (e.g. 96k, 128k, 192k). Default: 128k.",
    )
    p.add_argument(
        "--audio-sample-rate",
        type=int,
        default=44100,
        help="Audio sample rate in Hz. Default: 44100.",
    )
    p.add_argument(
        "--audio-channels",
        type=int,
        default=2,
        choices=(1, 2),
        help="Audio channels: 1=mono, 2=stereo. Default: 2.",
    )
    p.add_argument(
        "--audio-gain-db",
        type=int,
        default=10,
        help="Digital audio gain in dB for ffmpeg's volume filter (-10..30). "
             "Default: 10 (matches the historic hardcoded +10dB boost). "
             "Overridable per-start from Settings → Audio & Image.",
    )
    p.add_argument(
        "--camera-brightness",
        type=int,
        default=None,
        help="UVC camera brightness, 0..200 with 100 = neutral. "
             "Default: camera default (no override).",
    )
    p.add_argument(
        "--camera-contrast",
        type=int,
        default=None,
        help="UVC camera contrast, 0..200 with 100 = neutral. "
             "Default: camera default (no override).",
    )

    p.add_argument("--api-port", type=int, default=DEFAULT_API_PORT,
                   help=f"Port for the control HTTP API (default: {DEFAULT_API_PORT})")
    p.add_argument("--no-api", action="store_true", help="Disable the HTTP control API.")
    p.add_argument("--auto-start", action="store_true", help="Start streaming immediately on launch.")
    p.add_argument("--dry-run", action="store_true", help="Render overlay frames to /tmp instead of streaming.")
    p.add_argument("--verbose", "-v", action="store_true", help="Verbose logging.")
    return p


def main() -> None:
    args = build_parser().parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s  %(message)s",
        datefmt="%H:%M:%S",
    )

    service = StreamingService(args)

    # ── Socket.io command listener (backend → Pi) ────────────
    # When the operator clicks Start/Stop in the web UI, the backend emits
    # stream:cmd events to our socket room. The listener translates those
    # into start_streaming/stop_streaming calls on the service, then reports
    # status back as stream:status events.
    # Build poller BEFORE the listener so we can hand it the poller reference
    # for socket-state updates (sets polling rate based on socket health).
    poller = ScoreboardPoller(args.url, args.identifier, service._overlay)

    command_listener = None
    if StreamCommandListener is not None:
        def _on_stream_start(
            stream_key: str,
            rtmp_url: str,
            test_pattern: bool = False,
            **encoding_kwargs,
        ) -> None:
            """Start streaming on the Pi.

            `encoding_kwargs` is forwarded from the backend's stream:cmd
            payload (added 2026-09-23 for the Settings UI). It can include
            any of:
              output_width (int | None)
              output_height (int | None)
              fps (int)
              audio_bitrate (str, e.g. "64k")
              audio_gain_db (int, -10..30)          — A/V tuning (2026)
              camera_brightness (int | None, 0..200)
              camera_contrast (int | None, 0..200)

            The service.start_streaming method applies these to the
            FFmpegStreamer it spawns for this stream. Each new Start
            command gets fresh values — operator must Stop + Start to
            change settings on a running stream (ffmpeg can't change
            resolution mid-stream).
            """
            # Override the default RTMP URL with the one YouTube returned
            service._args.rtmp_url = rtmp_url
            service.start_streaming(
                stream_key=stream_key,
                test_pattern=test_pattern,
                **encoding_kwargs,
            )

        def _on_stream_stop() -> None:
            service.stop_streaming()

        def _on_camera_tune(
            brightness: Optional[int] = None,
            contrast: Optional[int] = None,
            preview: Optional[bool] = None,
        ) -> None:
            """Live camera tuning from the backend's camera_tune cmd.

            Applies image controls to the open camera (or stashes them
            for the next start when idle) and toggles the preview
            emitter — no stream restart needed.
            """
            service.camera_tune(brightness=brightness, contrast=contrast, preview=preview)

        def _on_state(payload: dict) -> None:
            """Receive state:update events from the backend in real time.

            This is now the PRIMARY source of scoreboard state — we apply
            the compact payload directly to the overlay without waiting
            for a poll. The poller remains as a safety net for missed
            pushes (eg during brief Cloudflare disconnects).
            """
            try:
                apply_state(service._overlay, payload)
                version = payload.get("v")
                if version is not None:
                    poller.note_push(int(version))
            except Exception as exc:
                log.warning("failed to apply state:update payload: %s", exc)

        command_listener = StreamCommandListener(
            backend_url=args.url,
            identifier=args.identifier,
            on_start=_on_stream_start,
            on_stop=_on_stream_stop,
            on_state=_on_state,
            on_camera_tune=_on_camera_tune,
        )

        # Preview frames: the service's preview emitter hands JPEG bytes
        # back through this callback, and the listener relays them to the
        # backend as stream:preview socket events (throttled to ≥1s).
        def _on_preview(jpeg_bytes: bytes) -> None:
            if command_listener is not None:
                command_listener.emit_preview(jpeg_bytes)

        service.set_preview_callback(_on_preview)
        # Hook the poller to socket connection state changes — when the
        # socket drops we poll fast as a fallback; when it reconnects we
        # slow polling back down.
        original_connect = command_listener._sio.on  # type: ignore[attr-defined]

        @command_listener._sio.on("connect")  # type: ignore[attr-defined]
        def _on_socket_connect():
            log.info("socket.io command listener connected to backend")
            poller.set_socket_state(True)
            threading.Thread(target=command_listener._lookup_and_subscribe, daemon=True).start()

        @command_listener._sio.on("disconnect")  # type: ignore[attr-defined]
        def _on_socket_disconnect():
            log.warning("command_listener disconnected from backend")
            poller.set_socket_state(False)

        # Wrap service methods so we can report status transitions
        _orig_start = service.start_streaming
        _orig_stop = service.stop_streaming

        def _start_with_status(*a, **kw):
            result = _orig_start(*a, **kw)
            if command_listener:
                if result.get("streaming"):
                    command_listener.emit_status("starting")
                else:
                    command_listener.emit_status("error", "start returned no stream")
            return result

        def _stop_with_status(*a, **kw):
            result = _orig_stop(*a, **kw)
            if command_listener:
                command_listener.emit_status("idle")
            return result

        service.start_streaming = _start_with_status  # type: ignore[assignment]
        service.stop_streaming = _stop_with_status    # type: ignore[assignment]

        # Watch the streaming flag in a background thread so we can flip
        # the Pi-reported status to 'live' once ffmpeg actually starts pushing.
        def _status_watchdog():
            last_streaming = False
            while True:
                time.sleep(2)
                if service._streaming and not last_streaming:
                    if command_listener:
                        command_listener.emit_status("live")
                last_streaming = service._streaming

        threading.Thread(target=_status_watchdog, daemon=True, name="status-watchdog").start()

        command_listener.start()
        log.info("socket.io command listener started")

    poller.start()
    poller.fetch_once()

    if args.auto_start:
        service.start_streaming()

    def _shutdown(sig, frame) -> None:
        log.info("Signal %d received — shutting down.", sig)
        service.stop_streaming()
        if command_listener is not None:
            command_listener.stop()
        poller.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    if not args.no_api:
        app = build_control_app(service)
        log.info("Control API listening on :%d", args.api_port)
        try:
            app.run(host="0.0.0.0", port=args.api_port, debug=False, use_reloader=False, threaded=True)
        except Exception as exc:
            log.error("Control API failed: %s", exc)
    else:
        # Keep main thread alive while streaming thread runs.
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            _shutdown(signal.SIGINT, None)


if __name__ == "__main__":
    main()