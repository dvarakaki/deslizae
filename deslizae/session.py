"""Estado de um celular conectado: aplica as mensagens de forma idempotente.

As mensagens podem chegar duplicadas (botões vão por UDP e TCP), fora de
ordem ou faltando (UDP). A sessão garante que:

* movimento e rolagem só andam para a frente (sequência crescente) e,
  como os valores são acumulados, nada se perde quando um pacote some;
* cada clique/botão é aplicado exatamente uma vez;
* antes de um clique, o cursor é levado à posição que o celular tinha
  naquele instante, mesmo que o último movimento ainda não tenha chegado.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from typing import Hashable

from . import protocol
from .smoother import Smoother

log = logging.getLogger(__name__)


class _Axis2:
    """Posição acumulada aceita de um canal (movimento ou rolagem)."""

    __slots__ = ("seq", "x", "y")

    def __init__(self) -> None:
        self.seq = -1
        self.x = 0.0
        self.y = 0.0

    def advance(self, seq: int, x: float, y: float) -> tuple[float, float, int] | None:
        """Aceita (seq, x, y) se for mais novo. Retorna (dx, dy, perdidos)."""
        if seq <= self.seq:
            return None
        lost = seq - self.seq - 1 if self.seq >= 0 else 0
        dx, dy = x - self.x, y - self.y
        self.seq, self.x, self.y = seq, x, y
        return dx, dy, lost


class Stats:
    """Diagnóstico de ritmo e perdas (``--stats``)."""

    REPORT_EVERY = 2.0
    GESTURE_GAP = 0.25

    def __init__(self, addr: str) -> None:
        self.addr = addr
        self._last: float | None = None
        self._intervals: list[float] = []
        self._start = time.perf_counter()
        self.by_transport: dict[str, int] = {}
        self.lost = 0
        self.old = 0

    def record(self, transport: str, buffer_ms: float | None) -> None:
        now = time.perf_counter()
        self.by_transport[transport] = self.by_transport.get(transport, 0) + 1
        if self._last is not None and now - self._last < self.GESTURE_GAP:
            self._intervals.append((now - self._last) * 1000)
        self._last = now
        if now - self._start >= self.REPORT_EVERY:
            self._report(now, buffer_ms)

    def _report(self, now: float, buffer_ms: float | None) -> None:
        iv = sorted(self._intervals)
        via = " ".join(f"{k}:{v}" for k, v in sorted(self.by_transport.items()))
        lost, old = self.lost, self.old
        self._intervals, self._start = [], now
        self.by_transport, self.lost, self.old = {}, 0, 0
        if len(iv) < 20:
            return
        n = len(iv)
        pct = lambda p: iv[min(n - 1, int(p * n))]
        burst = sum(1 for x in iv if x < 3) / n * 100
        holes = sum(1 for x in iv if x > 40)
        smooth = f"suavização {buffer_ms:.0f} ms" if buffer_ms is not None else "sem suavização"
        log.info(
            "ritmo %s [%s]: mediana %.1f ms · p90 %.1f ms · máx %.0f ms · rajadas %.0f%% · "
            "buracos(>40ms) %d · perdidos %d · fora de ordem %d · %s",
            self.addr, via, pct(0.5), pct(0.9), iv[-1], burst, holes, lost, old, smooth,
        )


class Session:
    SEEN_MAX = 256

    def __init__(self, sid: Hashable, addr: str, smoother: Smoother, stats: bool = False) -> None:
        self.sid = sid
        self.addr = addr
        self.smoother = smoother
        self.mouse = smoother.mouse
        self.move = _Axis2()
        self.scroll = _Axis2()
        self.zoom = _Axis2()
        self.pressed: set[int] = set()
        self._seen: set[int] = set()
        self._seen_order: deque[int] = deque()
        self.stats = Stats(addr) if stats else None

    def handle(self, data: bytes, transport: str = "tcp") -> bytes | None:
        """Processa uma mensagem binária; retorna a resposta, se houver."""
        try:
            msg = protocol.decode(data)
        except protocol.ProtocolError as exc:
            log.debug("Mensagem ignorada: %s", exc)
            return None

        sm, mouse = self.smoother, self.mouse
        match msg:
            case protocol.Move(seq, x, y, t):
                r = self.move.advance(seq, x, y)
                if r is None:
                    if self.stats:
                        self.stats.old += 1
                    return None
                dx, dy, lost = r
                if t < 0:
                    sm.immediate(lambda: mouse.move(dx, dy))
                else:
                    sm.push_move(self.sid, dx, dy, t)
                if self.stats:
                    self.stats.lost += lost
                    self.stats.record(transport, sm.buffer_ms(self.sid) if t >= 0 else None)
            case protocol.Scroll(seq, x, y, t):
                r = self.scroll.advance(seq, x, y)
                if r is None:
                    return None
                dx, dy, _ = r
                if t < 0:
                    sm.immediate(lambda: mouse.scroll(dx, dy))
                else:
                    sm.push_scroll(self.sid, dx, dy, t)
            case protocol.Zoom(seq, z, _t):
                r = self.zoom.advance(seq, z, 0.0)
                if r is None:
                    return None
                dz = r[0]
                # Zoom anda em passos inteiros; não precisa de suavização.
                sm.immediate(lambda: mouse.zoom(dz))
            case protocol.Button(eid, button, down, mseq, mx, my):
                if not self._first_time(eid):
                    return None
                catch_up = self.move.advance(mseq, mx, my)
                if down:
                    self.pressed.add(button)
                else:
                    self.pressed.discard(button)

                def apply() -> None:
                    if catch_up and (catch_up[0] or catch_up[1]):
                        mouse.move(catch_up[0], catch_up[1])
                    mouse.button(button, down)

                sm.immediate(apply)
            case protocol.Click(eid, button, mseq, mx, my):
                if not self._first_time(eid):
                    return None
                catch_up = self.move.advance(mseq, mx, my)

                def apply() -> None:
                    if catch_up and (catch_up[0] or catch_up[1]):
                        mouse.move(catch_up[0], catch_up[1])
                    mouse.click(button)

                sm.immediate(apply)
            case protocol.Ping(t):
                return protocol.encode_pong(t)
        return None

    def _first_time(self, eid: int) -> bool:
        if eid in self._seen:
            return False
        self._seen.add(eid)
        self._seen_order.append(eid)
        if len(self._seen_order) > self.SEEN_MAX:
            self._seen.discard(self._seen_order.popleft())
        return True

    def close(self) -> None:
        """Conexão caiu: nunca deixar um botão preso no meio de um arraste."""
        for button in list(self.pressed):
            self.smoother.immediate(lambda b=button: self.mouse.button(b, False))
        self.pressed.clear()
        self.smoother.forget(self.sid)
