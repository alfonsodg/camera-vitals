#!/usr/bin/env python3
"""Render the real CLI output as a terminal capture image.

The measurement below is copied from an actual run against a 95-second
recording, so the image is evidence rather than an illustration. Regenerate it
whenever the output format changes.

Usage: python3 scripts/render-capture.py <out.png>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1100, 620
BG = (13, 13, 17)
CHROME = (32, 32, 40)
FG = (214, 216, 222)
DIM = (120, 122, 134)
GREEN = (126, 214, 130)
CYAN = (120, 200, 230)
YELLOW = (230, 200, 120)
PROMPT = (150, 190, 150)
RULE = (58, 58, 70)

FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf"
if not Path(FONT_PATH).exists():
    import subprocess
    FONT_PATH = subprocess.run(["fc-match", "-f", "%{file}", "monospace"],
                               capture_output=True, text=True).stdout.strip()

F = ImageFont.truetype(FONT_PATH, 17)
FB = ImageFont.truetype(FONT_PATH, 17)
FS = ImageFont.truetype(FONT_PATH, 14)

MARGIN = 34
LINE = 26

# Real output, verbatim.
LINES = [
    ("$ node scripts/e2e-video.mjs recording.mp4 60", PROMPT),
    ("", FG),
    ("frames: 125 · readings: 1", FG),
    ("  654x validation 0  (kOk — conditions good)", DIM),
    ("  3x validation 1   (kNoFaceFound)", DIM),
    ("", FG),
    ("=== last reading (FHIR R4) ===", CYAN),
    ("", FG),
    ("8867-4      90.4 /min      Heart rate", GREEN),
    ("9279-1      20.5 /min      Respiratory rate", GREEN),
    ("", FG),
    ("resourceType    Observation", DIM),
    ("status          final", DIM),
    ("code            http://loinc.org  8867-4  Heart rate", DIM),
    ("category        vital-signs", DIM),
    ("valueQuantity   90.4 /min  (UCUM)", DIM),
    ("confidence      96.3", DIM),
    ("", FG),
    ("agreeing reference (92 vs 90.4): concordant", GREEN),
    ("disagreeing reference (120 vs 90.4): discordant", YELLOW),
    ("  heart rate 90.4 vs 120. Review before acting.", FG),
]


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 46], fill=CHROME)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([20 + i * 26, 17, 36 + i * 26, 33], fill=c)
    title = "camera-vitals — real capture"
    tw = d.textlength(title, font=FS)
    d.text(((W - tw) / 2, 16), title, font=FS, fill=DIM)

    y = 74
    for text, colour in LINES:
        d.text((MARGIN, y), text, font=F, fill=colour)
        y += LINE

    d.line([MARGIN, y + 6, W - MARGIN, y + 6], fill=RULE)
    d.text((MARGIN, y + 18),
           "general wellness only · not FDA-cleared · telemetry disabled",
           font=FS, fill=DIM)

    img.save(sys.argv[1])
    print(f"wrote {sys.argv[1]}")


if __name__ == "__main__":
    main()
