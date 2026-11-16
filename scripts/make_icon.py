"""Gera os ícones do Deslizae a partir do mesmo desenho de icon.svg.

* deslizae/static/icon-180.png   ícone da tela inicial do iPhone
* packaging/deslizae.ico         ícone do executável (16, 24, 32, 48, 64 e 256 px)

Rasterizador mínimo, sem dependências, com supersampling 4x. Reproduz o
desenho de icon.svg (viewBox 64x64).
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SS = 4

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


def render(size: int) -> bytes:
    """Pixels RGBA em linhas prefixadas pelo filtro PNG 0."""
    scale = size / 64
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / scale
                    y = (py + (sy + 0.5) / SS) / scale
                    c = color_at(x, y)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = SS * SS
            if a:
                rows += bytes((r // a, g // a, b // a, 255 * a // n))
            else:
                rows += b"\0\0\0\0"
    return bytes(rows)


def png(size: int) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(render(size), 9)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def ico(sizes: list[int]) -> bytes:
    """ICO com imagens PNG embutidas (aceito pelo Windows desde o Vista)."""
    images = [png(s) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for size, data in zip(sizes, images):
        dim = 0 if size >= 256 else size  # 0 significa 256 no formato ICO
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return header + entries + b"".join(images)


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"gerado {path.relative_to(ROOT)} ({len(data)} bytes)")


if __name__ == "__main__":
    write(ROOT / "deslizae" / "static" / "icon-180.png", png(180))
    write(ROOT / "packaging" / "deslizae.ico", ico([16, 24, 32, 48, 64, 256]))
