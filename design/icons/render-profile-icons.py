#!/usr/bin/env python3
# Render design/icons/profile-icons/<color>.svg -> build/profile-icons/<color>.png
# at 1024x1024 with transparent corners, using cairosvg (no browser needed).
import os, sys
import cairosvg

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SVG_DIR = os.path.join(ROOT, "design", "icons", "profile-icons")
OUT_DIR = os.path.join(ROOT, "build", "profile-icons")
COLORS = ["blue", "red", "green", "purple", "orange", "graphite"]

os.makedirs(OUT_DIR, exist_ok=True)
for c in COLORS:
    svg = os.path.join(SVG_DIR, f"{c}.svg")
    png = os.path.join(OUT_DIR, f"{c}.png")
    if not os.path.isfile(svg):
        sys.exit(f"FAIL: missing {svg}")
    cairosvg.svg2png(url=svg, write_to=png,
                     output_width=1024, output_height=1024, background_color="transparent")
    print(f"rendered {c} -> build/profile-icons/{c}.png")
print(f"OK: {len(COLORS)} profile icons in {OUT_DIR}")
