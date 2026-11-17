"""Suavizador: desfaz as rajadas e pausas do Wi-Fi.

O problema: o celular manda um movimento a cada ~8 ms, mas o Wi-Fi entrega
em rajadas (vários pacotes juntos) com buracos de 40–125 ms no meio. Aplicar
cada pacote na chegada faz o cursor parar e dar pulos.

A solução (a mesma ideia do "jitter buffer" de chamadas de voz):

1. Cada movimento vem com o instante em que o dedo se moveu (relógio do celular).
2. O agente estima o atraso mínimo da rede (o menor ``chegada - instante``
   recente) e quanto ela oscila (percentil 90 do excesso sobre o mínimo).
3. Cada movimento é agendado para ``instante + atraso mínimo + buffer``:
   assim todos saem com o mesmo espaçamento que tinham no dedo.
4. Uma thread reproduz a 240 Hz interpolando entre os pontos, então o
   cursor anda suave mesmo em monitores de 120/144 Hz.

O buffer se ajusta sozinho: cresce rápido quando a rede piora e encolhe
devagar quando melhora, entre MIN_BUFFER e MAX_BUFFER. É o único atraso
acrescentado, e só existe quando a rede precisa.

Cliques e botões chamam ``immediate``, que antes aplica todo o movimento
pendente: o clique sempre acontece onde o cursor deveria estar.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable, Hashable

MIN_BUFFER = 0.010   # s — piso do buffer
MAX_BUFFER = 0.090   # s — acima disso o atraso começa a incomodar
INITIAL_BUFFER = 0.020
WINDOW = 2.0         # s de histórico para estimar a rede
QUANTILE = 0.90
RATE_HZ = 240
INTERVAL_MARGIN = 1.15  # o buffer cobre o intervalo entre amostras com folga
GAP = 0.25              # intervalos maiores que isto são pausas, não o ritmo da fonte


class NetworkClock:
    """Converte o instante do celular em instante de reprodução no PC.

    O buffer precisa cobrir duas coisas: a oscilação da rede e o **intervalo
    entre amostras da fonte**. A interpolação a 240 Hz só funciona se a
    próxima amostra já tiver chegado; com o touchpad (amostra a cada 8–16 ms)
    a rede dominava, mas a câmera manda uma a cada ~33 ms, e um buffer menor
    que isso deixa o cursor parado esperando e depois pulando (degraus de 30
    Hz). Por isso o alvo é o maior entre o percentil da rede e o intervalo
    típico da fonte.
    """

    def __init__(self) -> None:
        self._mins: deque[tuple[float, float]] = deque()   # mínimo deslizante monotônico
        self._delays: deque[tuple[float, float]] = deque()  # (chegada, d) para o percentil
        self._intervals: deque[float] = deque(maxlen=64)    # ritmo da fonte (s)
        self._last_phone: float | None = None
        self._n = 0
        self.buffer = INITIAL_BUFFER
        self.late = 0  # pacotes que chegaram depois da hora de reproduzir

    @property
    def interval(self) -> float:
        """Intervalo típico (mediana) entre amostras da fonte, em segundos."""
        if not self._intervals:
            return 0.008
        s = sorted(self._intervals)
        return s[len(s) // 2]

    def playout(self, t_phone: float, arrival: float) -> float:
        if self._last_phone is not None:
            gap = t_phone - self._last_phone
            if 0 < gap < GAP:
                self._intervals.append(gap)
        self._last_phone = t_phone
        d = arrival - t_phone

        # Mínimo deslizante em O(1) amortizado.
        while self._mins and self._mins[-1][1] >= d:
            self._mins.pop()
        self._mins.append((arrival, d))
        while self._mins[0][0] < arrival - WINDOW:
            self._mins.popleft()
        base = self._mins[0][1]

        self._delays.append((arrival, d))
        while self._delays[0][0] < arrival - WINDOW:
            self._delays.popleft()

        self._n += 1
        if self._n % 8 == 0 and len(self._delays) >= 16:
            excess = sorted(x - base for _, x in self._delays)
            target = max(excess[int(QUANTILE * (len(excess) - 1))], self.interval * INTERVAL_MARGIN)
            target = min(MAX_BUFFER, max(MIN_BUFFER, target))
            # Sobe rápido (para parar de engasgar), desce devagar (sem oscilar).
            alpha = 0.5 if target > self.buffer else 0.05
            self.buffer += (target - self.buffer) * alpha

        tp = t_phone + base + self.buffer
        if tp < arrival:
            self.late += 1
        return tp


class _Channel:
    """Uma grandeza 2D reproduzida no tempo (movimento ou rolagem)."""

    IDLE_GAP = 0.1

    def __init__(self, apply: Callable[[float, float], None]) -> None:
        self._apply = apply
        self._points: deque[tuple[float, float, float]] = deque()  # (tp, cx, cy) acumulados
        self._cx = self._cy = 0.0  # tudo que já chegou
        self._ex = self._ey = 0.0  # tudo que já foi aplicado
        self._prev: tuple[float, float, float] | None = None

    @property
    def busy(self) -> bool:
        return bool(self._points)

    def push(self, tp: float, dx: float, dy: float, interval: float = 0.008) -> None:
        if not self._points:
            if self._prev is None or self._prev[0] < tp - max(self.IDLE_GAP, 2.5 * interval):
                # Começo de gesto: parte de onde o cursor está, um intervalo da
                # fonte antes (o delta desta amostra se acumulou nesse tempo).
                self._prev = (tp - interval, self._ex, self._ey)
        else:
            tp = max(tp, self._points[-1][0])  # nunca voltar no tempo
        self._cx += dx
        self._cy += dy
        self._points.append((tp, self._cx, self._cy))

    def render(self, now: float) -> None:
        pts = self._points
        while pts and pts[0][0] <= now:
            self._prev = pts.popleft()
        prev = self._prev
        if prev is None:
            return
        if pts:
            nxt = pts[0]
            span = nxt[0] - prev[0]
            f = (now - prev[0]) / span if span > 0 else 1.0
            f = 0.0 if f < 0 else 1.0 if f > 1 else f
            tx = prev[1] + (nxt[1] - prev[1]) * f
            ty = prev[2] + (nxt[2] - prev[2]) * f
        else:
            tx, ty = prev[1], prev[2]
        self._emit(tx, ty)

    def flush(self, now: float) -> None:
        self._points.clear()
        self._prev = (now, self._cx, self._cy)
        self._emit(self._cx, self._cy)

    def _emit(self, tx: float, ty: float) -> None:
        dx, dy = tx - self._ex, ty - self._ey
        if abs(dx) > 1e-9 or abs(dy) > 1e-9:
            self._ex, self._ey = tx, ty
            self._apply(dx, dy)


class Smoother:
    """Dono exclusivo do mouse: toda injeção passa por aqui, sob um lock."""

    def __init__(self, mouse) -> None:
        self.mouse = mouse
        self._cond = threading.Condition()
        self._move = _Channel(mouse.move)
        self._scroll = _Channel(mouse.scroll)
        self._clocks: dict[Hashable, NetworkClock] = {}
        self._stop = False
        self._thread = threading.Thread(target=self._loop, name="smoother", daemon=True)
        self._thread.start()

    # -- entrada ------------------------------------------------------------
    def push_move(self, source: Hashable, dx: float, dy: float, t_ms: float) -> None:
        self._push(self._move, source, dx, dy, t_ms)

    def push_scroll(self, source: Hashable, dx: float, dy: float, t_ms: float) -> None:
        self._push(self._scroll, source, dx, dy, t_ms)

    def _push(self, ch: _Channel, source: Hashable, dx: float, dy: float, t_ms: float) -> None:
        arrival = time.perf_counter()
        with self._cond:
            clock = self._clocks.get(source)
            if clock is None:
                clock = self._clocks[source] = NetworkClock()
            ch.push(clock.playout(t_ms / 1000.0, arrival), dx, dy, clock.interval)
            self._cond.notify()

    def immediate(self, fn: Callable[[], None]) -> None:
        """Aplica o movimento pendente e então executa ``fn`` (clique, botão…)."""
        with self._cond:
            now = time.perf_counter()
            self._move.flush(now)
            self._scroll.flush(now)
            fn()

    def buffer_ms(self, source: Hashable) -> float | None:
        clock = self._clocks.get(source)
        return clock.buffer * 1000 if clock else None

    def forget(self, source: Hashable) -> None:
        with self._cond:
            self._clocks.pop(source, None)

    def close(self) -> None:
        with self._cond:
            self._stop = True
            self._cond.notify()
        self._thread.join(timeout=1)

    # -- reprodução -----------------------------------------------------------
    def _loop(self) -> None:
        period = 1.0 / RATE_HZ
        next_tick = time.perf_counter()
        while True:
            with self._cond:
                if not (self._move.busy or self._scroll.busy):
                    while not (self._move.busy or self._scroll.busy or self._stop):
                        self._cond.wait()
                    next_tick = time.perf_counter()
                if self._stop:
                    return
                now = time.perf_counter()
                self._move.render(now)
                self._scroll.render(now)
            next_tick += period
            delay = next_tick - time.perf_counter()
            if delay > 0:
                time.sleep(delay)  # Python 3.11+ usa timer de alta resolução no Windows
            else:
                next_tick = time.perf_counter()
