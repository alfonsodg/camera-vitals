#!/usr/bin/env python3
"""Render a terminal-styled demo video from real command output.

The desktop session is Wayland with a locked X root, so x11grab captures black
and PipeWire needs a portal dialog nobody is there to approve. This renders the
actual command output as frames instead: same evidence, deterministic, and it
can be regenerated after any change.

Usage:
    python3 scripts/render-demo.py <transcript.json> <out.mp4>
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 900
BG = (18, 18, 22)
FG = (216, 216, 220)
DIM = (120, 120, 130)
GREEN = (126, 214, 130)
CYAN = (120, 200, 230)
YELLOW = (230, 200, 120)
RED = (230, 130, 130)
PROMPT = (150, 190, 150)

FONT_SIZE = 21
LINE_H = 33
MARGIN = 40

FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf"
if not Path(FONT_PATH).exists():
    out = subprocess.run(["fc-match", "-f", "%{file}", "monospace"],
                         capture_output=True, text=True).stdout.strip()
    FONT_PATH = out or FONT_PATH

FONT = ImageFont.truetype(FONT_PATH, FONT_SIZE)
TITLE = ImageFont.truetype(FONT_PATH, FONT_SIZE + 4)

COLORS = {
    "prompt": PROMPT,
    "out": FG,
    "dim": DIM,
    "ok": GREEN,
    "key": CYAN,
    "warn": YELLOW,
    "err": RED,
}


def draw_frame(lines, caption, max_lines=22):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 44], fill=(30, 30, 36))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([18 + i * 26, 15, 34 + i * 26, 31], fill=c)
    d.text((W // 2 - 190, 12), "camera-vitals — demo", font=TITLE, fill=DIM)

    y = 70
    visible = lines[-max_lines:] if len(lines) > max_lines else lines
    for text, kind in visible:
        d.text((MARGIN, y), text, font=FONT, fill=COLORS.get(kind, FG))
        y += LINE_H

    if caption:
        d.rectangle([0, H - 56, W, H], fill=(28, 28, 34))
        d.text((MARGIN, H - 44), caption, font=FONT, fill=CYAN)
    return img


def main():
    transcript = json.loads(Path(sys.argv[1]).read_text())
    out = sys.argv[2]
    frames_per_step = int(transcript.get("frames_per_step", 22))

    shown = []
    tmp = Path(tempfile.mkdtemp())
    images = []

    for i, step in enumerate(transcript["steps"]):
        if i:
            shown = shown + [("", "out")]
        shown = shown + step["lines"]
        caption = step.get("caption", "")
        img = draw_frame(shown, caption)
        p = tmp / f"f{len(images):04d}.png"
        img.save(p)
        images.append(p)

    # Hold the final state a moment longer so the result is readable.
    last = tmp / "final.png"
    draw_frame(shown, transcript.get("final_caption", "")).save(last)

    listfile = tmp / "list.txt"
    with listfile.open("w") as fh:
        for p in images:
            fh.write(f"file '{p}'\nduration {frames_per_step / 25:.3f}\n")
        fh.write(f"file '{last}'\nduration 3.0\n")

    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "concat", "-safe", "0", "-i", str(listfile),
        "-vf", f"fps=25,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-movflags", "+faststart", out,
    ], check=True)

    print(f"wrote {out}")


if __name__ == "__main__":
    main()
