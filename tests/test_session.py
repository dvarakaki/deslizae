import pytest

from deslizae import protocol as p
from deslizae.server import DryRunMouse
from deslizae.session import Session
from deslizae.smoother import Smoother


@pytest.fixture
def env():
    mouse = DryRunMouse()
    sm = Smoother(mouse)
    yield Session("c", "teste", sm), mouse
    sm.close()


def total(mouse, kind="move"):
    ev = [e for e in mouse.events if e[0] == kind]
    return sum(e[1] for e in ev), sum(e[2] for e in ev)


def test_lost_packet_movement_is_not_lost(env):
    s, mouse = env
    s.handle(p.encode_move(1, 10, 0))
    # pacote 2 (x=20) se perdeu no Wi-Fi
    s.handle(p.encode_move(3, 30, 5))
    assert total(mouse) == pytest.approx((30, 5))


def test_late_packet_is_discarded(env):
    s, mouse = env
    s.handle(p.encode_move(1, 10, 0))
    s.handle(p.encode_move(3, 30, 0))
    s.handle(p.encode_move(2, 20, 0))  # chegou atrasado: não pode voltar o cursor
    assert total(mouse) == pytest.approx((30, 0))


def test_duplicate_click_applies_once(env):
    s, mouse = env
    click = p.encode_click(5, 0, 0, 0, 0)
    s.handle(click, "udp")
    s.handle(click, "tcp")  # mesma mensagem pelo outro caminho
    assert [e for e in mouse.events if e[0] == "click"] == [("click", 0)]


def test_click_catches_up_to_its_position(env):
    s, mouse = env
    s.handle(p.encode_move(1, 10, 0))
    # O movimento seq 2 (x=25) se perdeu, mas o clique sabe onde o cursor estava.
    s.handle(p.encode_click(1, 0, 2, 25, 4))
    assert total(mouse) == pytest.approx((25, 4))
    assert mouse.events[-1] == ("click", 0)
    # E quando o movimento perdido chegar depois, é ignorado.
    s.handle(p.encode_move(2, 25, 4))
    assert total(mouse) == pytest.approx((25, 4))


def test_drag_released_when_connection_drops(env):
    s, mouse = env
    s.handle(p.encode_button(1, 0, True, 0, 0, 0))
    s.close()
    assert mouse.events[-1] == ("button", 0, False)


def test_ping_replies(env):
    s, _ = env
    assert s.handle(p.encode_ping(7.0)) == p.encode_pong(7.0)


def test_zoom_sends_deltas_and_survives_loss(env):
    s, mouse = env
    s.handle(p.encode_zoom(1, 100))
    s.handle(p.encode_zoom(3, 400))   # seq 2 se perdeu
    s.handle(p.encode_zoom(2, 250))   # chegou atrasado: ignorado
    s.handle(p.encode_zoom(4, 160))   # pinça fechando
    zooms = [e[1] for e in mouse.events if e[0] == "zoom"]
    assert zooms == pytest.approx([100, 300, -240])


def test_scroll_accumulates(env):
    s, mouse = env
    s.handle(p.encode_scroll(1, 0, 60))
    s.handle(p.encode_scroll(2, 0, 150))
    assert total(mouse, "scroll") == pytest.approx((0, 150))
