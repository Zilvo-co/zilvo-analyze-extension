#!/usr/bin/env python3
"""
generate-icons.py
Creates simple solid-colour PNG icons for the extension.

Usage:
    python3 scripts/generate-icons.py

Output: icons/icon{16,32,48,128}.png
"""

import struct
import zlib
import os
import math

# Brand accent colour  #6c63ff
R, G, B = 0x6c, 0x63, 0xff

ICON_SIZES = [16, 32, 48, 128]
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')


def png_chunk(name: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(name + data) & 0xFFFFFFFF
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', crc)


def make_png(size: int, r: int, g: int, b: int) -> bytes:
    """Creates an RGB PNG of `size`x`size` filled with the given colour."""
    # IHDR: width, height, bit-depth=8, colour-type=2 (RGB), compression=0, filter=0, interlace=0
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)

    # Image data: one filter byte (0 = None) per row, then RGB triples
    row = bytes([r, g, b]) * size
    raw = b''.join(b'\x00' + row for _ in range(size))
    idat_data = zlib.compress(raw, level=9)

    png = b'\x89PNG\r\n\x1a\n'
    png += png_chunk(b'IHDR', ihdr_data)
    png += png_chunk(b'IDAT', idat_data)
    png += png_chunk(b'IEND', b'')
    return png


def make_logo_png(size: int) -> bytes:
    """
    Creates a slightly more interesting icon: purple background with a
    white 'Z' glyph, scaled to the given size.
    """
    # Build a pixel grid
    pixels = [[(R, G, B)] * size for _ in range(size)]

    pad = max(1, size // 8)
    stroke = max(1, size // 8)

    # Draw a simple 'Z' shape (top bar, diagonal, bottom bar)
    x0, x1 = pad, size - pad - 1
    y0, y1 = pad, size - pad - 1

    def fill_rect(x_start, y_start, x_end, y_end, colour=(255, 255, 255)):
        for y in range(y_start, min(y_end + 1, size)):
            for x in range(x_start, min(x_end + 1, size)):
                if 0 <= y < size and 0 <= x < size:
                    pixels[y][x] = colour

    # Top bar
    fill_rect(x0, y0, x1, y0 + stroke - 1)
    # Bottom bar
    fill_rect(x0, y1 - stroke + 1, x1, y1)
    # Diagonal (approximate with filled rects along the line)
    steps = max(size - 2 * pad, 1)
    for i in range(steps + 1):
        t = i / steps
        cx = int(x1 - t * (x1 - x0))
        cy = int(y0 + t * (y1 - y0))
        for dy in range(stroke):
            for dx in range(stroke):
                nx, ny = cx + dx - stroke // 2, cy + dy
                if 0 <= nx < size and 0 <= ny < size:
                    pixels[ny][nx] = (255, 255, 255)

    # Encode as PNG
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    raw = b''
    for row in pixels:
        raw += b'\x00'
        for (pr, pg, pb) in row:
            raw += bytes([pr, pg, pb])
    idat_data = zlib.compress(raw, level=9)

    png = b'\x89PNG\r\n\x1a\n'
    png += png_chunk(b'IHDR', ihdr_data)
    png += png_chunk(b'IDAT', idat_data)
    png += png_chunk(b'IEND', b'')
    return png


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for size in ICON_SIZES:
        path = os.path.join(OUTPUT_DIR, f'icon{size}.png')
        data = make_logo_png(size)
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  Created {path}  ({len(data)} bytes)')
    print('Done.')


if __name__ == '__main__':
    main()
