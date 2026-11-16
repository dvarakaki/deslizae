"""Monta as notas da release a partir da seção da versão no CHANGELOG.md.

    python scripts/release_notes.py v0.1.1 > notas.md
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "https://github.com/dvarakaki/deslizae"


def section(version: str) -> str:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|^\[)", text, re.S | re.M)
    if not match:
        raise SystemExit(f"versão {version} não encontrada no CHANGELOG.md")
    return match.group(1).strip()


def main() -> None:
    tag = sys.argv[1]
    version = tag.removeprefix("v")
    print(f"""## Como usar

1. Baixe o **Deslizae.exe** abaixo, em *Assets*.
2. Dê dois cliques. Se o Windows mostrar "O Windows protegeu o computador",
   clique em **Mais informações → Executar assim mesmo**.
3. Quando o Firewall perguntar, marque **Redes privadas** e clique em **Permitir acesso**.
4. Escaneie o QR code com a câmera do celular, conectado no mesmo Wi-Fi.

Guia completo e solução de problemas no [README]({REPO}#readme).

## Novidades

{section(version)}

---
Verifique a integridade comparando o SHA-256 do arquivo com `Deslizae.exe.sha256`.
""")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
