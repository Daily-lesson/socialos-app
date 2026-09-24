#!/usr/bin/env python3
"""Rasterize the SocialOS app icons from the SVG masters in this folder.

Run:  python3 icons/_src/build-icons.py   (from the repo root)

All app-icon PNGs are written OPAQUE (RGB, no alpha): iOS renders any
transparency in an apple-touch-icon as black, and a full square is what every
launcher/mask expects. The maskable variants come from icon-maskable.svg, whose
mark is inset into the safe zone. Keep the masters in sync with icons/logo.svg.

Two copies of the 180px apple-touch-icon are ALSO written to the REPO ROOT
(apple-touch-icon.png + apple-touch-icon-precomposed.png): the paths iOS
Safari probes at the site root when a page declares no apple-touch-icon
link. Both 404'd while an iPhone showed the generic Safari tile for SocialOS
(v2), even though the declared link served fine — so they are hardening,
not a confirmed root cause. They are runtime files: allowlisted in
.vercelignore and mirrored by scripts/deploy-pages.sh (RUNTIME_FILES); on
the mirror they are inert (iOS probes the domain root, not
/socialos-app/). Never hand-edit them either.
"""
import os
import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.dirname(HERE)          # icons/
ROOT = os.path.dirname(ICONS)          # repo root (the iOS fallback probes)
SQUARE = os.path.join(HERE, "icon-square.svg")
MASKABLE = os.path.join(HERE, "icon-maskable.svg")
OG = os.path.join(HERE, "og-image.svg")
LOGO = os.path.join(ICONS, "logo.svg")  # the in-app rounded-tile mark

# (source svg, output path, pixel width, pixel height, keep_alpha)
# keep_alpha=True only for the rounded-tile logo raster (in-app/readme use,
# never an OS home-screen icon) — everything else is flattened opaque.
# A bare filename lands in icons/; the two root fallbacks name ROOT explicitly.
TARGETS = [
    (SQUARE,   "favicon-32.png",          32,   32, False),
    (SQUARE,   "favicon-48.png",          48,   48, False),
    (SQUARE,   "icon-120.png",           120,  120, False),
    (SQUARE,   "apple-touch-icon.png",   180,  180, False),
    (SQUARE,   os.path.join(ROOT, "apple-touch-icon.png"),             180, 180, False),
    (SQUARE,   os.path.join(ROOT, "apple-touch-icon-precomposed.png"), 180, 180, False),
    (SQUARE,   "icon-192.png",           192,  192, False),
    (SQUARE,   "icon-512.png",           512,  512, False),
    (MASKABLE, "icon-192-maskable.png",  192,  192, False),
    (MASKABLE, "icon-512-maskable.png",  512,  512, False),
    (OG,       "og-image.png",          1200,  630, False),
    (LOGO,     "logo-300.png",           300,  300, True),
]


def render(src, out, w, h, keep_alpha=False):
    dest = out if os.path.isabs(out) else os.path.join(ICONS, out)
    png_bytes = cairosvg.svg2png(url=src, output_width=w, output_height=h)
    tmp = os.path.join(HERE, "_tmp.png")
    with open(tmp, "wb") as f:
        f.write(png_bytes)
    im = Image.open(tmp).convert("RGBA")
    if keep_alpha:
        im.save(dest, format="PNG", optimize=True)
    else:
        # Flatten onto the sky's top colour so there is never an alpha channel
        # (iOS turns alpha into black; a solid square avoids any surprise edge).
        flat = Image.new("RGB", im.size, (7, 10, 31))  # #070A1F
        flat.paste(im, mask=im.split()[3])
        flat.save(dest, format="PNG", optimize=True)
    os.remove(tmp)
    print(f"  wrote {os.path.relpath(dest, ROOT)} ({w}x{h})")


if __name__ == "__main__":
    print("Rendering app icons from SVG masters:")
    for src, out, w, h, keep_alpha in TARGETS:
        render(src, out, w, h, keep_alpha)
    print("Done.")
