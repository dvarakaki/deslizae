"""Gera deslizae/static/icon-180.png (ícone da tela inicial do iPhone).

Rasterizador mínimo, sem dependências, com supersampling 4x. Reproduz o
desenho de icon.svg (viewBox 64x64).
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

SIZE = 180
SS = 4
SCALE = SIZE / 64

BG = (0x0B, 0x0D, 0x12)
PANEL = (0x17, 0x1B, 0x24)
ACCENT = (0x5B, 0x8C, 0xFF)


def in_rrect(x, y, x0, y0, w, h, r):
    if x < x0 or y < y0 or x > x0 + w or y > y0 + h:
        return False
    cx = min(max(x, x0 + r), x0 + w - r)
    cy = min(max(y, y0 + r), y0 + h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(x, y):
    """Cor no espaço 64x64, ou None se transparente."""
    if not in_rrect(x, y, 0, 0, 64, 64, 14):
        return None
    c = BG
    sw = 1.25
    if in_rrect(x, y, 12 - sw, 10 - sw, 40 + 2 * sw, 44 + 2 * sw, 8 + sw):
        c = ACCENT
        if in_rrect(x, y, 12 + sw, 10 + sw, 40 - 2 * sw, 44 - 2 * sw, 8 - sw):
            c = PANEL
            if abs(y - 42) <= 1 or (abs(x - 32) <= 1 and y >= 42):
                c = ACCENT
            elif (x - 30) ** 2 + (y - 25) ** 2 <= 25:
                c = tuple(int(a * 0.85 + b * 0.15) for a, b in zip(ACCENT, PANEL))
    return c


def render() -> bytes:
    rows = bytearray()
    for py in range(SIZE):
        rows.append(0)
        for px in range(SIZE):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / SCALE
                    y = (py + (sy + 0.5) / SS) / SCALE
                    c = color_at(x, y)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = SS * SS
            if a:
                rows += bytes((r // a, g // a, b // a, 255 * a // n))
            else:
                rows += b"\0\0\0\0"
    return bytes(rows)


def png(width: int, height: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "deslizae" / "static" / "icon-180.png"
    out.write_bytes(png(SIZE, SIZE, render()))
    print(f"gerado {out} ({out.stat().st_size} bytes)")
