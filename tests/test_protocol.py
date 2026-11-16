import struct

import pytest

from deslizae import protocol as p


def test_move_scroll_roundtrip():
    assert p.decode(p.encode_move(7, 12.5, -3.25, 1000.5)) == p.Move(7, 12.5, -3.25, 1000.5)
    assert p.decode(p.encode_scroll(2, 0, 240, -1)) == p.Scroll(2, 0, 240, -1)


def test_zoom_roundtrip():
    assert p.decode(p.encode_zoom(3, 240.5, 10.0)) == p.Zoom(3, 240.5, 10.0)
    assert len(p.encode_zoom(1, 0)) == 29


def test_button_click_roundtrip():
    assert p.decode(p.encode_button(9, 0, True, 4, 10.0, 20.0)) == p.Button(9, 0, True, 4, 10.0, 20.0)
    assert p.decode(p.encode_click(10, 1, 4, 10.0, 20.0)) == p.Click(10, 1, 4, 10.0, 20.0)


def test_ping_pong():
    assert p.decode(p.encode_ping(123.5)) == p.Ping(123.5)
    pong = p.encode_pong(42.25)
    assert pong[0] == p.OP_PONG and struct.unpack("<d", pong[1:])[0] == 42.25


def test_sizes_match_phone():
    # app.js monta estes tamanhos à mão; precisam bater com o agente.
    assert len(p.encode_move(1, 0, 0, 0)) == 29
    assert len(p.encode_button(1, 0, True, 0, 0, 0)) == 27
    assert len(p.encode_click(1, 0, 0, 0, 0)) == 26
    assert len(p.encode_ping(0)) == 9


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), 1e300])
def test_rejects_bad_numbers(bad):
    with pytest.raises(p.ProtocolError):
        p.decode(p.encode_move(1, bad, 0, 0))


@pytest.mark.parametrize(
    "data",
    [b"", b"\x10", p.encode_move(1, 0, 0, 0)[:-1], p.encode_click(1, 0, 0, 0, 0) + b"x", b"\x7f"],
)
def test_rejects_malformed(data):
    with pytest.raises(p.ProtocolError):
        p.decode(data)
