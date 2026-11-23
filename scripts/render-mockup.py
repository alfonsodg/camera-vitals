#!/usr/bin/env python3
"""Render a mockup of the med365x Monitor screen with the camera channel added.

Colours, layout and labels come from the real screen
(mobile-app/src/screens/monitor.tsx): #f8fafc background, white cards with
#64748b labels, #3b82f6 primary button, PA/FC/SpO2/Temp grid. The camera card is
the proposed addition, so the mockup shows what changes rather than inventing a
new app.

Usage: python3 scripts/render-mockup.py <out.png>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 420, 860
BG = (248, 250, 252)
CARD = (255, 255, 255)
TITLE = (30, 41, 59)
LABEL = (100, 116, 139)
UNIT = (148, 163, 184)
PRIMARY = (59, 130, 246)
GREEN = (34, 197, 94)
BORDER = (241, 245, 249)
CAM = (16, 185, 129)

FONT_REG = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
if not Path(FONT_REG).exists():
    import subprocess
    FONT_REG = subprocess.run(["fc-match", "-f", "%{file}", "sans"],
                              capture_output=True, text=True).stdout.strip()
    FONT_BOLD = FONT_REG


def f(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def card(d, x, y, w, h, r=12, fill=CARD, outline=None):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline)


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Status bar
    d.rectangle([0, 0, W, 44], fill=CARD)
    d.text((22, 14), "9:41", font=f(14, True), fill=TITLE)
    d.text((W - 62, 14), "▮▮▮", font=f(11), fill=LABEL)

    # Header
    y = 66
    d.text((22, y), "Monitoreo", font=f(26, True), fill=TITLE)
    d.ellipse([W - 40, y + 8, W - 24, y + 24], fill=GREEN)
    y += 46

    # Vitals grid — the four existing cards
    half = (W - 22 * 2 - 12) // 2
    cards = [
        ("PA", "118/76", "mmHg"),
        ("FC", "90", "bpm"),
        ("SpO2", "97", "%"),
        ("Temp", "36.4", "°C"),
    ]
    for i, (label, value, unit) in enumerate(cards):
        cx = 22 + (i % 2) * (half + 12)
        cy = y + (i // 2) * 104
        card(d, cx, cy, half, 92)
        d.text((cx + half // 2 - 10, cy + 14), label, font=f(12), fill=LABEL, anchor="ma")
        d.text((cx + half // 2, cy + 32), value, font=f(28, True), fill=TITLE, anchor="ma")
        d.text((cx + half // 2, cy + 68), unit, font=f(12), fill=UNIT, anchor="ma")
    y += 220

    # New: camera channel card
    card(d, 22, y, W - 44, 128, fill=CARD, outline=CAM)
    d.text((40, y + 14), "CÁMARA · rPPG", font=f(11, True), fill=CAM)
    d.text((40, y + 32), "90.4", font=f(30, True), fill=TITLE)
    d.text((112, y + 44), "bpm", font=f(12), fill=UNIT)
    d.text((W - 120, y + 36), "conf 96%", font=f(12), fill=GREEN)
    d.text((40, y + 74), "Segunda opinión: concordante", font=f(12), fill=LABEL)
    d.text((40, y + 92), "vs. oxímetro BLE · 92 bpm", font=f(11), fill=UNIT)
    d.text((40, y + 108), "LOINC 8867-4 · FHIR R4", font=f(10), fill=UNIT)
    y += 144

    # Primary button — camera capture
    card(d, 22, y, W - 44, 48, r=8, fill=PRIMARY)
    d.text((W // 2, y + 24), "Medir con cámara", font=f(16, True), fill=(255, 255, 255), anchor="mm")
    y += 60

    # Secondary — device
    card(d, 22, y, W - 44, 44, r=8, fill=CARD, outline=BORDER)
    d.text((W // 2, y + 22), "Conectar dispositivo BLE", font=f(14), fill=LABEL, anchor="mm")
    y += 60

    # History
    d.text((22, y), "Lecturas recientes", font=f(13, True), fill=TITLE)
    y += 26
    rows = [
        ("heart_rate", "90.4 bpm", "cámara"),
        ("breathing_rate", "20.5 rpm", "cámara"),
        ("spo2", "97 %", "BLE"),
        ("systolic_bp", "118 mmHg", "BLE"),
    ]
    for name, value, src in rows:
        d.text((22, y), name, font=f(13), fill=(71, 85, 105))
        d.text((W - 22, y), value, font=f(13, True), fill=TITLE, anchor="ra")
        d.text((W - 22, y + 16), src, font=f(10), fill=UNIT, anchor="ra")
        d.line([22, y + 34, W - 22, y + 34], fill=BORDER)
        y += 40

    # Tab bar
    d.rectangle([0, H - 62, W, H], fill=CARD)
    d.line([0, H - 62, W, H - 62], fill=BORDER)
    tabs = ["Monitor", "Dispositivos", "OCR", "Perfil"]
    for i, t in enumerate(tabs):
        cx = (W // 4) * i + W // 8
        colour = PRIMARY if i == 0 else UNIT
        d.text((cx, H - 40), t, font=f(11, i == 0), fill=colour, anchor="mm")

    out = sys.argv[1]
    img.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
