"""Configuração persistente (token de pareamento e porta).

O token fica salvo para que o celular, depois de escanear o QR uma vez,
continue conectando sozinho nas próximas vezes que o agente for aberto.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_PORT = 8765


def _appdata() -> Path:
    return Path(os.environ.get("APPDATA") or str(Path.home()))


def config_dir() -> Path:
    return _appdata() / "Deslizae"


def _migrate_legacy(path: Path) -> None:
    """Traz a configuração do nome antigo do projeto, mantendo o celular pareado."""
    legacy = _appdata() / "ProjetoMouse" / "config.json"
    if path == config_dir() / "config.json" and not path.exists() and legacy.exists():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(legacy.read_bytes())
        except OSError:
            pass


def new_token() -> str:
    return secrets.token_urlsafe(12)


@dataclass
class Config:
    token: str
    port: int = DEFAULT_PORT

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        path = path or config_dir() / "config.json"
        _migrate_legacy(path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            token = str(data["token"])
            port = int(data.get("port", DEFAULT_PORT))
            if len(token) >= 8 and 1 <= port <= 65535:
                return cls(token=token, port=port)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        cfg = cls(token=new_token())
        cfg.save(path)
        return cfg

    def save(self, path: Path | None = None) -> None:
        path = path or config_dir() / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
