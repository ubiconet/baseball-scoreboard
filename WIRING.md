# Scoreboard Wiring Diagram

Reference for Steve's portable Pi 4 + MAX7219 scoreboard build.

## Bill of Materials

| Component | Qty | Purpose |
|---|---|---|
| Raspberry Pi 4 | 1 | Controller, runs scoreboard software |
| MAX7219 8x8 LED module | 3 | Big dot-matrix display |
| 1S LiPo battery | 4 | Power (1S4P = 3.7V nominal, ~4× mAh) |
| TP5100 charge/discharge module | 1 | USB-C charging for 1S pack |
| 4-channel logic level converter | 1 | 3.3V (Pi SPI) → 5V (MAX7219) |
| SPST switch | 1 | Master power cutoff |
| 5V 3A DC-DC boost converter | 1 | Lift 3.7V LiPo → 5V rail |

## Power path

```
USB-C 5V charger
       │
       ▼
   TP5100 ◀──B+/B─── 4× 1S LiPo in PARALLEL (1S4P)
       │
       B+ (3.7V)
       │
       ▼
   SWITCH  (SPST, high-side, on the + line)
       │
       ▼
   DC-DC BOOST  3.7V → 5V  (3A)
       │
       └───┬──────────┬──────────────┐
           ▼          ▼              ▼
   MAX7219 VCC    LLC HV ref    Pi 4 pin 2/4 (5V)
   (all 3)        (5V)             
           │          │              │
           └──────────┴────── GND ───┘
                  (single shared ground)
```

**Critical rules:**
- Batteries are **PARALLEL only** (1S4P). Series = 14.8V = fried everything.
- TP5100 is single-cell only — that's fine since 1S4P is still electrically one cell.
- **Add a 1S BMS** (~$1, 4-pin module) between pack and switch. TP5100 alone doesn't balance cells. Risk: cell reversal on the weakest cell.
- Switch on the high side so OFF = total disconnect, no parasitic drain.
- Common ground is mandatory across Pi, boost, MAX7219s, and LLC.

## Data path (SPI through 3.3V → 5V LLC)

```
Pi 4 GPIO              4-ch LLC              3× MAX7219 cascade
(3.3V)                 3.3V ↔ 5V             (5V logic)

GPIO 10 MOSI ─▶ LV1 ▶ HV1 ──────────────▶ DIN ─┐
                                                │ DOUT
GPIO 11 SCLK ─▶ LV2 ▶ HV2 ─┬──────────────────▶ CLK ─┐
                          ├──────────────────▶ CLK ─┤
                          └──────────────────▶ CLK ─┘
GPIO  8 CE0  ─▶ LV3 ▶ HV3 ─┘                  CS ───┐ shared
                                                      │ to
Pi pin 1  3.3V ──────────▶ LV ref                   │ all
Boost  +5V  ─────────────▶ HV ref                   │ 3
Common  GND ─────────────▶ GND                      ▼

MAX7219 cascade (DIN → DOUT chain, CLK and CS bus-shared):
┌──────────┐    ┌──────────┐    ┌──────────┐
│  MAX #1  │───▶│  MAX #2  │───▶│  MAX #3  │
│ DOUT ▶ DIN│   │ DOUT ▶ DIN│   │  (end)   │
└──────────┘    └──────────┘    └──────────┘
```

**Critical rules:**
- Pi's **3.3V** (pin 1) → LLC `LV` reference.
- Boost **5V** → LLC `HV` reference.
- Forgetting either reference = no level shifting = garbage on the line.
- **MAX7219 cascade**: only `DIN → DOUT` chains. `CLK` and `CS` are parallel to all 3.
- Same `CS` (chip select) to all 3 MAX7219s — the chip counts frames by the number of bytes clocked in one CS window.

## Pi SPI enable

```bash
sudo raspi-config       # → Interface → SPI → Enable
# OR
echo "dtparam=spi=on" | sudo tee -a /boot/firmware/config.txt
sudo reboot
```

Verify after reboot:
```bash
ls /dev/spi*   # should show /dev/spidev0.0 and /dev/spidev0.1
```

## Pi 4 header pin map (for wiring)

| Pin | Function | Use |
|---|---|---|
| Pin 1 | 3.3V | LLC LV ref |
| Pin 2 | 5V | Boost 5V in (after switch) |
| Pin 6 | GND | Common ground |
| Pin 11 | GPIO 17 | Optional: status LED / spare |
| Pin 19 | GPIO 10 (MOSI) | → LLC LV1 → MAX DIN |
| Pin 23 | GPIO 11 (SCLK) | → LLC LV2 → MAX CLK |
| Pin 24 | GPIO 8 (CE0) | → LLC LV3 → MAX CS |
| Pin 25 | GND | Common ground |

## Power budget warning

Pi 4 + 3 MAX7219s at full white can hit ~4A peak on the 5V rail. A 5V/3A boost will brown out under worst case.

**Symptoms of undervoltage:**
- Pi rebooting under heavy LED load
- Random brownouts when LEDs sweep to full bright

**Fixes (in order of preference):**
1. Cap MAX7219 intensity register low (e.g., 4–8 of 15) — usually enough.
2. Drop to 2× MAX7219 if budget allows.
3. Swap to a 5V/5A boost (e.g., MT3608-based, larger module).

## Build sequence (recommended)

1. **Bench-test SPI first** — Pi + 1 MAX7219 + LLC + Pi's own 5V from USB. No batteries. Confirm `diag_spi.py` shows pixels.
2. **Add the 2nd and 3rd MAX7219** to the cascade. Re-run `diag_spi.py` to confirm all three light.
3. **Wire the power path** — LiPo pack → switch → boost → verify 5V out with multimeter before connecting to Pi.
4. **Add the BMS** between pack and switch.
5. **Full integration** — connect power to Pi, run the scoreboard app, smoke test.
6. **Run on battery** — measure idle current and peak current with a multimeter in series.
7. **Field test** — full battery cycle, record actual runtime at typical brightness.

## Files in this repo

- `diag_spi.py` — basic SPI pixel-coordinate test for MAX7219
- `pi/command_listener.py` — main scoreboard LED driver, deploys to Pi as flat root file
- `BUILD_PROMPT.md` — build-context for OpenCode sessions
- `schema.sql` — scoreboard app database schema
- `backend/`, `frontend/` — scoreboard web app
