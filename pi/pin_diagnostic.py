#!/usr/bin/env python3
"""
Pin diagnostic — drives every scoreboard GPIO pin HIGH/LOW in sequence
with 2-second windows so the operator can walk the wiring and confirm
each LED responds to its expected pin.

Stops the LED service first (it holds GPIOs exclusively), runs the
sequence, then restarts the service.

Pin map (from scoreboard_leds.py:54-58):
  BALL_PINS   = [17, 27, 22]   # BALL_1, BALL_2, BALL_3
  STRIKE_PINS = [23, 24]       # STRIKE_1, STRIKE_2
  OUT_PINS    = [25, 18]       # OUT_1, OUT_2

Usage:
  python3 pin_diagnostic.py            # 2-second windows, 0.3s between
  python3 pin_diagnostic.py --hold 5   # 5-second windows
  python3 pin_diagnostic.py --keep-on  # leave all LEDs ON at end (no restart)
"""
import argparse
import subprocess
import sys
import time

try:
    from gpiozero import LED
except ImportError:
    print("gpiozero not installed. Run: pip install gpiozero", file=sys.stderr)
    sys.exit(1)

# BCM pin → human label. Order matters: this is the test sequence.
PIN_MAP = [
    (17, "BALL_1"),
    (27, "BALL_2"),
    (22, "BALL_3"),
    (23, "STRIKE_1"),
    (24, "STRIKE_2"),
    (25, "OUT_1"),
    (18, "OUT_2"),
]

SERVICE = "scoreboard-leds.service"


def stop_service() -> None:
    """Stop the LED service so we have exclusive GPIO access."""
    print(f"Stopping {SERVICE}...", flush=True)
    subprocess.run(
        ["systemctl", "--user", "--no-ask-password", "stop", SERVICE],
        check=False,
    )
    time.sleep(0.5)


def start_service() -> None:
    """Restart the LED service."""
    print(f"Starting {SERVICE}...", flush=True)
    subprocess.run(
        ["systemctl", "--user", "--no-ask-password", "start", SERVICE],
        check=False,
    )


def run_diagnostic(hold_seconds: float, keep_on: bool) -> None:
    """Drive each pin HIGH for `hold_seconds`, then LOW."""
    leds = [(label, LED(pin)) for pin, label in PIN_MAP]

    print(
        f"\n=== Pin Diagnostic — {len(leds)} pins, {hold_seconds}s each ===",
        flush=True,
    )
    print("Watch the physical indicator LEDs. For each label below,")
    print("the corresponding LED should turn ON, then OFF.\n", flush=True)

    try:
        for label, led in leds:
            print(f"  {label:9s} (pin {led.pin.number:2d}) ON ", end="", flush=True)
            led.on()
            time.sleep(hold_seconds)
            led.off()
            print("→ OFF")
            time.sleep(0.3)

        if keep_on:
            print("\nLeaving all pins ON (--keep-on mode).", flush=True)
            for label, led in leds:
                led.on()
            print("Press Ctrl-C to exit and turn everything off.", flush=True)
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                print("\nCleaning up...", flush=True)
                for _, led in leds:
                    try:
                        led.off()
                    except Exception:
                        pass
    finally:
        # CRITICAL: gpiozero's LED.close() releases the pin back to input
        # mode (floating) WITHOUT driving it LOW first. On Pi 4 with
        # latched driver boards downstream, the pin can stay HIGH after
        # close() because the driver has latched the previous state.
        # Explicitly drive LOW before close.
        for _, led in leds:
            try:
                led.off()
            except Exception:
                pass
            try:
                led.close()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--hold",
        type=float,
        default=2.0,
        help="Seconds to hold each pin HIGH (default: 2.0)",
    )
    parser.add_argument(
        "--keep-on",
        action="store_true",
        help="After sequence, leave all pins ON until Ctrl-C (useful for multimeter probing)",
    )
    parser.add_argument(
        "--no-restart",
        action="store_true",
        help="Don't restart the service at the end (use if you're going to do more wiring work)",
    )
    args = parser.parse_args()

    stop_service()
    try:
        run_diagnostic(args.hold, args.keep_on)
    except KeyboardInterrupt:
        print("\nInterrupted.", flush=True)
    finally:
        if not args.no_restart:
            start_service()

    return 0


if __name__ == "__main__":
    sys.exit(main())
