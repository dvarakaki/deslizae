"""Injeção de mouse no Windows via SendInput (ctypes, sem dependências).

Decisões de projeto:

* O cursor é posicionado com coordenadas ABSOLUTAS no desktop virtual.
  Movimentos relativos injetados passam pela aceleração do Windows
  ("Aumentar precisão do ponteiro"), o que somaria uma segunda curva à
  curva que o celular já aplica. Com absoluto, o deslocamento enviado é
  exatamente o que acontece na tela.
* A posição é guardada em float para acumular frações de pixel: um dedo
  lento gera deltas de 0.3 px que, somados, viram movimento suave.
* Se o usuário mexer no mouse físico, a posição interna é ressincronizada
  pelo GetCursorPos antes do próximo movimento.
* O processo é marcado como "per-monitor DPI aware" para que todas as
  coordenadas sejam pixels físicos, mesmo com escala de 125%/150%.
"""

from __future__ import annotations

import ctypes
import logging
import math
from ctypes import wintypes

log = logging.getLogger(__name__)

user32 = ctypes.WinDLL("user32", use_last_error=True)

# --- Constantes Win32 -------------------------------------------------------
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
VK_CONTROL = 0x11
WHEEL_DELTA = 120

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)

BUTTON_LEFT = 0
BUTTON_RIGHT = 1
BUTTON_MIDDLE = 2

_BUTTON_FLAGS = {
    BUTTON_LEFT: (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    BUTTON_RIGHT: (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    BUTTON_MIDDLE: (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

ULONG_PTR = ctypes.c_size_t


# --- Estruturas -------------------------------------------------------------
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    # A união precisa conter todos os tipos para ter o tamanho correto
    # (40 bytes em 64 bits); caso contrário o SendInput rejeita a chamada.
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
user32.GetCursorPos.restype = wintypes.BOOL
user32.GetSystemMetrics.argtypes = (ctypes.c_int,)
user32.GetSystemMetrics.restype = ctypes.c_int


def enable_dpi_awareness() -> None:
    """Faz o processo enxergar pixels físicos (necessário com escala de tela)."""
    try:
        user32.SetProcessDpiAwarenessContext.argtypes = (ctypes.c_void_p,)
        user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
        if user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2):
            return
    except AttributeError:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        user32.SetProcessDPIAware()


def to_absolute(value: int, origin: int, size: int) -> int:
    """Converte pixel do desktop virtual para a escala 0..65535 do SendInput.

    O Windows mapeia de volta com ``pixel = norm * size / 65536`` (truncado),
    então o arredondamento para cima garante que o pixel resultante é
    exatamente o pedido.
    """
    if size <= 0:
        return 0
    return min(65535, max(0, -((-(value - origin) * 65536) // size)))


class VirtualScreen:
    __slots__ = ("left", "top", "width", "height")

    def __init__(self) -> None:
        self.refresh()

    def refresh(self) -> None:
        self.left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        self.top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        self.width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        self.height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)

    @property
    def right(self) -> int:
        return self.left + self.width - 1

    @property
    def bottom(self) -> int:
        return self.top + self.height - 1


class Mouse:
    """Mouse virtual com movimento subpixel e rolagem de alta resolução."""

    def __init__(self) -> None:
        enable_dpi_awareness()
        self._screen = VirtualScreen()
        self._x = 0.0
        self._y = 0.0
        self._last_set: tuple[int, int] | None = None
        self._wheel_acc = 0.0
        self._hwheel_acc = 0.0
        self._zoom_acc = 0.0
        self._warned_blocked = False
        self._input = INPUT(type=INPUT_MOUSE)
        self._input_ptr = ctypes.pointer(self._input)

    # -- baixo nível --------------------------------------------------------
    def _send(self, flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> None:
        mi = self._input.mi
        mi.dx = dx
        mi.dy = dy
        mi.mouseData = data & 0xFFFFFFFF
        mi.dwFlags = flags
        mi.time = 0
        mi.dwExtraInfo = 0
        if user32.SendInput(1, self._input_ptr, ctypes.sizeof(INPUT)) != 1:
            if not self._warned_blocked:
                self._warned_blocked = True
                log.warning(
                    "O Windows bloqueou a entrada (erro %s). Isso acontece sobre "
                    "janelas de administrador ou na tela do UAC; rode o agente "
                    "como administrador para controlá-las.",
                    ctypes.get_last_error(),
                )
        else:
            self._warned_blocked = False

    @staticmethod
    def cursor_pos() -> tuple[int, int]:
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        return pt.x, pt.y

    # -- API ----------------------------------------------------------------
    def move(self, dx: float, dy: float) -> None:
        if not (math.isfinite(dx) and math.isfinite(dy)):
            return
        cx, cy = self.cursor_pos()
        last = self._last_set
        if last is None or abs(cx - last[0]) > 1 or abs(cy - last[1]) > 1:
            # Primeira vez, ou o mouse físico/outro programa moveu o cursor.
            self._screen.refresh()
            self._x, self._y = float(cx), float(cy)

        s = self._screen
        self._x = min(max(self._x + dx, s.left), s.right)
        self._y = min(max(self._y + dy, s.top), s.bottom)
        tx, ty = int(math.floor(self._x)), int(math.floor(self._y))
        if last is not None and (tx, ty) == last:
            return  # só fração acumulada; nada muda na tela

        self._send(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            to_absolute(tx, s.left, s.width),
            to_absolute(ty, s.top, s.height),
        )
        self._last_set = (tx, ty)

    def scroll(self, dx: float, dy: float) -> None:
        """Rola em unidades de roda do Windows (120 = um "clique" da rodinha).

        ``dy`` positivo rola para cima; ``dx`` positivo rola para a direita.
        Valores menores que 120 geram rolagem suave em apps modernos.
        """
        if math.isfinite(dy) and dy:
            self._wheel_acc += dy
            step = int(self._wheel_acc)
            if step:
                self._wheel_acc -= step
                self._send(MOUSEEVENTF_WHEEL, data=step)
        if math.isfinite(dx) and dx:
            self._hwheel_acc += dx
            step = int(self._hwheel_acc)
            if step:
                self._hwheel_acc -= step
                self._send(MOUSEEVENTF_HWHEEL, data=step)

    def zoom(self, units: float) -> None:
        """Zoom de pinça: Ctrl + rodinha, o mesmo que os touchpads do Windows enviam.

        Só sai em "cliques" inteiros (120): muitos apps (navegadores, Office)
        dão um passo de zoom por evento, independentemente do tamanho.
        Ctrl e rodinha vão num único SendInput, sem chance de outro evento
        entrar no meio e o Ctrl "vazar" para outra tecla.
        """
        if not math.isfinite(units) or not units:
            return
        self._zoom_acc += units
        while abs(self._zoom_acc) >= WHEEL_DELTA:
            step = WHEEL_DELTA if self._zoom_acc > 0 else -WHEEL_DELTA
            self._zoom_acc -= step
            batch = (INPUT * 3)()
            batch[0].type = batch[2].type = INPUT_KEYBOARD
            batch[0].ki.wVk = batch[2].ki.wVk = VK_CONTROL
            batch[2].ki.dwFlags = KEYEVENTF_KEYUP
            batch[1].type = INPUT_MOUSE
            batch[1].mi.dwFlags = MOUSEEVENTF_WHEEL
            batch[1].mi.mouseData = step & 0xFFFFFFFF
            user32.SendInput(3, batch, ctypes.sizeof(INPUT))

    def button(self, button: int, down: bool) -> None:
        flags = _BUTTON_FLAGS.get(button)
        if flags is None:
            return
        self._send(flags[0] if down else flags[1])

    def click(self, button: int) -> None:
        self.button(button, True)
        self.button(button, False)
