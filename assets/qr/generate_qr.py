#!/usr/bin/env python3
"""
Generate the giveaway QR code for The Spotted James.

Encodes the giveaway sign-up URL and outputs a print-ready PNG plus a
scalable SVG. High error correction (H) so the code survives smudges,
folds, and being printed small on a table tent.

Usage:
    python3 generate_qr.py                      # uses default URL
    python3 generate_qr.py https://your.url/    # override the URL

Outputs (next to this script, in assets/qr/):
    giveaway-qr.png   -> for printing (high-res)
    giveaway-qr.svg   -> for scaling / design tools
"""
import sys
import os
import qrcode
import qrcode.image.svg
from qrcode.constants import ERROR_CORRECT_H

# The URL the QR points to — the dedicated giveaway sign-up page.
DEFAULT_URL = "https://thespottedjames.com/giveaway.html"

# Brand colors — keep the modules dark on a light background for reliable
# scanning under bar lighting. (Neon-blue-on-black QRs scan poorly.)
FILL = "#050505"   # near-black, matches the site background
BACK = "#ffffff"   # white quiet zone for contrast


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    here = os.path.dirname(os.path.abspath(__file__))

    # --- PNG (print) ---
    qr = qrcode.QRCode(
        version=None,                 # auto-size to fit the data
        error_correction=ERROR_CORRECT_H,  # ~30% recoverable -> robust
        box_size=20,                  # large modules -> crisp when printed big
        border=4,                     # standard quiet zone (min 4 modules)
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color=FILL, back_color=BACK)
    png_path = os.path.join(here, "giveaway-qr.png")
    img.save(png_path)

    # --- SVG (scalable) ---
    svg_factory = qrcode.image.svg.SvgPathImage
    svg_img = qrcode.make(
        url,
        image_factory=svg_factory,
        error_correction=ERROR_CORRECT_H,
        box_size=20,
        border=4,
    )
    svg_path = os.path.join(here, "giveaway-qr.svg")
    svg_img.save(svg_path)

    print(f"URL encoded : {url}")
    print(f"PNG written : {png_path}")
    print(f"SVG written : {svg_path}")
    print("Print the PNG. To change the URL, re-run: "
          "python3 generate_qr.py <new-url>")


if __name__ == "__main__":
    main()
