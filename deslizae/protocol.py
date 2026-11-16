"""Protocolo binário entre o celular e o agente (v2, tolerante a perda).

As mensagens podem chegar por dois caminhos:

* **UDP (canal de dados WebRTC, sem reenvio e fora de ordem)**: caminho
  principal. Um pacote perdido não trava os seguintes, como acontece no TCP.
* **WebSocket (TCP)**: reserva quando o WebRTC não conecta, e caminho
  extra para cliques e botões, que vão pelos dois.

Para isso funcionar com perdas e reordenação:

* Movimento e rolagem carregam a **posição acumulada** desde o início da
  conexão, com um número de sequência. O agente aplica a diferença em
  relação ao último pacote aceito e descarta pacotes velhos. Se um pacote
  se perde, o próximo já contém o movimento dele.
* Cliques e botões têm um **id único** (duplicatas são ignoradas) e levam a
  posição acumulada do cursor naquele instante, para o clique cair no lugar
  certo mesmo que o último movimento ainda não tenha chegado.

Formato (little-endian):

    0x05 PING    f64 t                                o agente devolve PONG
    0x10 MOVE    u32 seq, f64 x, f64 y, f64 t         x/y em pixels, acumulados
    0x11 SCROLL  u32 seq, f64 x, f64 y, f64 t         unidades de roda (120 = 1 clique)
    0x12 BUTTON  u32 id, u8 botão, u8 estado, u32 mseq, f64 mx, f64 my
    0x13 CLICK   u32 id, u8 botão, u32 mseq, f64 mx, f64 my
    0x14 ZOOM    u32 seq, f64 z, f64 0, f64 t         zoom acumulado (120 = 1 passo de Ctrl+roda)
    0x85 PONG    f64 t                                (agente -> celular)

``t`` é o instante do toque em ms no relógio do celular (usado pelo
suavizador); negativo significa "aplicar na hora, sem suavizar".
Botões: 0 = esquerdo, 1 = direito, 2 = meio.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Union

OP_PING = 0x05
OP_MOVE = 0x10
OP_SCROLL = 0x11
OP_BUTTON = 0x12
OP_CLICK = 0x13
OP_ZOOM = 0x14
OP_PONG = 0x85

_F64 = struct.Struct("<d")
_POS = struct.Struct("<Iddd")        # seq, x, y, t
_BUTTON = struct.Struct("<IBBIdd")   # id, botão, estado, mseq, mx, my
_CLICK = struct.Struct("<IBIdd")     # id, botão, mseq, mx, my

MAX_ABS = 1e12  # proteção contra valores absurdos


@dataclass(frozen=True, slots=True)
class Move:
    seq: int
    x: float
    y: float
    t: float


@dataclass(frozen=True, slots=True)
class Scroll:
    seq: int
    x: float
    y: float
    t: float


@dataclass(frozen=True, slots=True)
class Zoom:
    seq: int
    z: float
    t: float


@dataclass(frozen=True, slots=True)
class Button:
    id: int
    button: int
    down: bool
    mseq: int
    mx: float
    my: float


@dataclass(frozen=True, slots=True)
class Click:
    id: int
    button: int
    mseq: int
    mx: float
    my: float


@dataclass(frozen=True, slots=True)
class Ping:
    t: float


Message = Union[Move, Scroll, Zoom, Button, Click, Ping]


class ProtocolError(ValueError):
    pass


def _check(*values: float) -> None:
    for v in values:
        if not math.isfinite(v) or abs(v) > MAX_ABS:
            raise ProtocolError("valor numérico inválido")


def decode(data: bytes) -> Message:
    if not data:
        raise ProtocolError("mensagem vazia")
    op = data[0]
    body = memoryview(data)[1:]
    try:
        if op == OP_MOVE or op == OP_SCROLL:
            seq, x, y, t = _POS.unpack(body)
            _check(x, y, t)
            return (Move if op == OP_MOVE else Scroll)(seq, x, y, t)
        if op == OP_ZOOM:
            seq, z, _, t = _POS.unpack(body)
            _check(z, t)
            return Zoom(seq, z, t)
        if op == OP_BUTTON:
            eid, button, down, mseq, mx, my = _BUTTON.unpack(body)
            _check(mx, my)
            return Button(eid, button, bool(down), mseq, mx, my)
        if op == OP_CLICK:
            eid, button, mseq, mx, my = _CLICK.unpack(body)
            _check(mx, my)
            return Click(eid, button, mseq, mx, my)
        if op == OP_PING:
            (t,) = _F64.unpack(body)
            return Ping(t)
    except struct.error as exc:
        raise ProtocolError(f"tamanho inválido para op 0x{op:02x}") from exc
    raise ProtocolError(f"op desconhecido 0x{op:02x}")


# -- codificação (usada pelos testes e por clientes Python) ------------------
def encode_move(seq: int, x: float, y: float, t: float = -1.0) -> bytes:
    return bytes((OP_MOVE,)) + _POS.pack(seq, x, y, t)


def encode_scroll(seq: int, x: float, y: float, t: float = -1.0) -> bytes:
    return bytes((OP_SCROLL,)) + _POS.pack(seq, x, y, t)


def encode_zoom(seq: int, z: float, t: float = -1.0) -> bytes:
    return bytes((OP_ZOOM,)) + _POS.pack(seq, z, 0.0, t)


def encode_button(eid: int, button: int, down: bool, mseq: int, mx: float, my: float) -> bytes:
    return bytes((OP_BUTTON,)) + _BUTTON.pack(eid, button, int(down), mseq, mx, my)


def encode_click(eid: int, button: int, mseq: int, mx: float, my: float) -> bytes:
    return bytes((OP_CLICK,)) + _CLICK.pack(eid, button, mseq, mx, my)


def encode_ping(t: float) -> bytes:
    return bytes((OP_PING,)) + _F64.pack(t)


def encode_pong(t: float) -> bytes:
    return bytes((OP_PONG,)) + _F64.pack(t)
