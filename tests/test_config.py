import json

from deslizae.config import DEFAULT_PORT, Config


def test_creates_and_persists(tmp_path):
    path = tmp_path / "cfg" / "config.json"
    first = Config.load(path)
    assert len(first.token) >= 8
    assert first.port == DEFAULT_PORT
    assert Config.load(path).token == first.token  # o celular continua pareado


def test_recovers_from_corrupt_file(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{não é json", encoding="utf-8")
    cfg = Config.load(path)
    assert json.loads(path.read_text(encoding="utf-8"))["token"] == cfg.token
