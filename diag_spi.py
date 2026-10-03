"""Direct SPI diagnostic — shows '1' '2' '3' across the 3 MAX7219 panels.

Stops the LED service first (open /dev/spidev0.0 exclusively), runs the
diagnostic, then restarts the service.
"""
import time
from luma.core.interface.serial import noop, spi
from luma.core.legacy import text
from luma.core.legacy.font import TINY_FONT
from luma.core.render import canvas
from luma.led_matrix.device import max7219
from PIL import Image, ImageDraw

print("=== Diagnostic: MAX7219 3-chip cascade ===", flush=True)

serial = spi(port=0, device=0, gpio=noop(), bus_speed_hz=500000)
device = max7219(serial, cascaded=3, block_orientation=0, rotate=0)
print(f"Opened device: cascaded={device.cascaded}", flush=True)

print("\nBuilding test image: '1' on panel 1, '2' on panel 2, '3' on panel 3", flush=True)
img = Image.new("1", (24, 8), 0)
draw = ImageDraw.Draw(img)
text(draw, (2, 1),  "1", fill="white", font=TINY_FONT)
text(draw, (10, 1), "2", fill="white", font=TINY_FONT)
text(draw, (18, 1), "3", fill="white", font=TINY_FONT)

print("Displaying... look at the panels now.", flush=True)
with canvas(device) as draw2:
    draw2.bitmap((0, 0), img, fill="white")

print("\n=== You should see '1' '2' '3' across the three panels. ===", flush=True)
print("If panel 2 or 3 stays blank or fully-lit, that chip is bad/wired wrong.", flush=True)

time.sleep(8)
print("\nClearing...", flush=True)
device.clear()
print("Done.", flush=True)
