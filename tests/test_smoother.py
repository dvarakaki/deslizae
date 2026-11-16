import random
import time

import pytest

from deslizae.server import DryRunMouse
from deslizae.smoother import MAX_BUFFER, MIN_BUFFER, NetworkClock, Smoother, _Channel


def bursty_arrivals(n, interval=0.008, base_delay=0.005, seed=1):
    """Toques regulares que chegam em rajadas, como no Wi-Fi medido:
    a cada 6 pacotes, a rede segura e entrega tudo junto."""
    rnd = random.Random(seed)
    out = []
    held_until = 0.0
    for i in range(n):
        t = 1000.0 + i * interval  # relógio do celular (s)
        arrival = t + base_delay + rnd.uniform(0, 0.002)
        if i % 6 == 0:
            held_until = arrival + 0.035  # buraco de ~35 ms
        arrival = max(arrival, held_until)
        out.append((t, arrival + 50.0))  # relógio do PC tem outra origem
    return out


def test_clock_restores_original_spacing():
    clock = NetworkClock()
    plays = [clock.playout(t, a) for t, a in bursty_arrivals(600)]
    arrivals = [a for _, a in bursty_arrivals(600)]

    # Na chegada, há rajadas (intervalos ~0) e buracos.
    arr_gaps = [b - a for a, b in zip(arrivals[300:], arrivals[301:])]
    assert min(arr_gaps) < 0.001 and max(arr_gaps) > 0.025

    # Na reprodução (depois de o buffer se adaptar), o espaçamento é o do dedo.
    play_gaps = [b - a for a, b in zip(plays[300:], plays[301:])]
    assert all(0.006 < g < 0.010 for g in play_gaps), (min(play_gaps), max(play_gaps))
    assert MIN_BUFFER <= clock.buffer <= MAX_BUFFER


def test_clock_shrinks_buffer_on_clean_network():
    clock = NetworkClock()
    for i in range(1000):
        t = i * 0.008
        clock.playout(t, t + 0.004)
    assert clock.buffer == pytest.approx(MIN_BUFFER, abs=0.002)


def test_channel_interpolates_and_conserves_total():
    got = []
    ch = _Channel(lambda dx, dy: got.append((dx, dy)))
    ch.push(1.000, 8.0, 0.0)
    ch.push(1.008, 8.0, 4.0)
    ch.push(1.016, 8.0, 0.0)

    ch.render(1.004)  # metade do caminho até o 2º ponto
    assert sum(g[0] for g in got) == pytest.approx(12.0)
    ch.render(1.012)
    assert sum(g[0] for g in got) == pytest.approx(20.0)
    assert sum(g[1] for g in got) == pytest.approx(4.0)
    ch.render(2.0)
    assert sum(g[0] for g in got) == pytest.approx(24.0)
    assert not ch.busy


def test_click_waits_for_pending_movement():
    mouse = DryRunMouse()
    sm = Smoother(mouse)
    try:
        t_ms = time.perf_counter() * 1000
        # Primeiro pacote fixa o relógio; o 2º fica agendado no futuro.
        sm.push_move("c", 1.0, 0.0, t_ms)
        sm.push_move("c", 5.0, 0.0, t_ms + 500)
        sm.immediate(lambda: mouse.click(0))
        moved = sum(e[1] for e in mouse.events if e[0] == "move")
        assert moved == pytest.approx(6.0)
        assert mouse.events[-1] == ("click", 0)
    finally:
        sm.close()


def test_thread_plays_back_over_time():
    mouse = DryRunMouse()
    sm = Smoother(mouse)
    try:
        # Chegam em tempo real, como do celular (8 ms entre toques).
        for _ in range(10):
            sm.push_move("c", 2.0, 1.0, time.perf_counter() * 1000)
            time.sleep(0.008)
        deadline = time.perf_counter() + 1.0
        while time.perf_counter() < deadline:
            if sum(e[1] for e in mouse.events if e[0] == "move") >= 20.0 - 1e-6:
                break
            time.sleep(0.01)
        moves = [e for e in mouse.events if e[0] == "move"]
        assert sum(e[1] for e in moves) == pytest.approx(20.0)
        assert sum(e[2] for e in moves) == pytest.approx(10.0)
        assert len(moves) > 5  # foi distribuído em vários quadros, não de uma vez
    finally:
        sm.close()
