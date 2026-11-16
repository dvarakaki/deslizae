"""Servidor HTTP + WebSocket + WebRTC do agente.

* ``/``            página do touchpad (aberta no celular)
* ``/ws?t=TOKEN``  WebSocket: controle, sinalização WebRTC e caminho reserva
* ``/pair``        página de pareamento com QR code — só acessível do próprio PC
* ``/api/*``       dados da página de pareamento — só do próprio PC

O caminho principal dos movimentos é um canal de dados WebRTC sem reenvio
(UDP). A negociação acontece pelo próprio WebSocket, já autenticado.
"""

from __future__ import annotations

import asyncio
import hmac
import io
import json
import logging
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from aiohttp import WSCloseCode, WSMsgType, web

from .config import Config
from .netinfo import all_ipv4, primary_ipv4
from .session import Session
from .smoother import Smoother

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
LOCAL_ADDRS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

try:  # WebRTC é opcional: sem ele, tudo segue pelo WebSocket.
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

    HAS_RTC = True
except ImportError:  # pragma: no cover
    HAS_RTC = False


class MouseLike(Protocol):
    def move(self, dx: float, dy: float) -> None: ...
    def scroll(self, dx: float, dy: float) -> None: ...
    def zoom(self, units: float) -> None: ...
    def button(self, button: int, down: bool) -> None: ...
    def click(self, button: int) -> None: ...


class DryRunMouse:
    """Não mexe no cursor; só registra. Útil para testar sem o Windows."""

    def __init__(self) -> None:
        self.events: list[tuple] = []

    def move(self, dx: float, dy: float) -> None:
        self.events.append(("move", dx, dy))
        log.debug("move %.2f %.2f", dx, dy)

    def scroll(self, dx: float, dy: float) -> None:
        self.events.append(("scroll", dx, dy))
        log.debug("scroll %.2f %.2f", dx, dy)

    def zoom(self, units: float) -> None:
        self.events.append(("zoom", units))
        log.info("zoom %.1f", units)

    def button(self, button: int, down: bool) -> None:
        self.events.append(("button", button, down))
        log.info("button %s %s", button, "down" if down else "up")

    def click(self, button: int) -> None:
        self.events.append(("click", button))
        log.info("click %s", button)


@dataclass
class Client:
    id: int
    addr: str
    user_agent: str
    session: Session
    since: float = field(default_factory=time.time)
    pc: Any = None          # RTCPeerConnection
    udp: bool = False       # canal UDP aberto
    ws: Any = None          # WebSocketResponse


class TouchpadServer:
    def __init__(self, config: Config, mouse: MouseLike, stats: bool = False) -> None:
        self.config = config
        self.mouse = mouse
        self.stats = stats
        # Toda injeção passa pelo suavizador (dono exclusivo do mouse).
        self.smoother = Smoother(mouse)
        self.clients: dict[int, Client] = {}
        self._next_id = 1
        self.app = self._build_app()
        self.app.on_shutdown.append(self._on_shutdown)
        self.app.on_cleanup.append(self._on_cleanup)

    async def _on_shutdown(self, _app: web.Application) -> None:
        """Ctrl+C: fecha as conexões ativas na hora.

        Sem isso, o aiohttp espera os WebSockets abertos (até 60 s) antes de sair.
        """
        for client in list(self.clients.values()):
            await self._close_pc(client)
            if client.ws is not None and not client.ws.closed:
                await client.ws.close(code=WSCloseCode.GOING_AWAY, message=b"agente encerrado")

    async def _on_cleanup(self, _app: web.Application) -> None:
        self.smoother.close()

    # -- app ----------------------------------------------------------------
    def _build_app(self) -> web.Application:
        app = web.Application(middlewares=[self._no_cache])
        app.add_routes(
            [
                web.get("/", self._page("index.html")),
                web.get("/pair", self._local_only(self._page("pair.html"))),
                web.get("/api/pair-info", self._local_only(self._pair_info)),
                web.get("/api/status", self._local_only(self._status)),
                web.get("/api/auth", self._auth),
                web.get("/ws", self._ws),
                web.static("/static", STATIC_DIR),
            ]
        )
        return app

    @web.middleware
    async def _no_cache(self, request: web.Request, handler):
        resp = await handler(request)
        # Sempre servir a versão mais nova da página ao celular.
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @staticmethod
    def _page(name: str):
        path = STATIC_DIR / name

        async def handler(_request: web.Request) -> web.FileResponse:
            return web.FileResponse(path)

        return handler

    @staticmethod
    def _local_only(handler):
        async def wrapped(request: web.Request):
            if request.remote not in LOCAL_ADDRS:
                raise web.HTTPForbidden(text="Disponível apenas no próprio computador.")
            return await handler(request)

        return wrapped

    # -- pareamento ---------------------------------------------------------
    def phone_url(self, ip: str | None = None) -> str:
        ip = ip or primary_ipv4() or "127.0.0.1"
        return f"http://{ip}:{self.config.port}/?t={self.config.token}"

    async def _pair_info(self, _request: web.Request) -> web.Response:
        ips = all_ipv4()
        urls = [self.phone_url(ip) for ip in ips]
        return web.json_response(
            {
                "host": socket.gethostname(),
                "url": urls[0] if urls else None,
                "urls": urls,
                "qr_svg": qr_svg(urls[0]) if urls else None,
            }
        )

    async def _status(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                "clients": [
                    {
                        "id": c.id,
                        "addr": c.addr,
                        "user_agent": c.user_agent,
                        "since": c.since,
                        "transport": "udp" if c.udp else "tcp",
                    }
                    for c in self.clients.values()
                ]
            }
        )

    def _token_ok(self, request: web.Request) -> bool:
        token = request.query.get("t", "")
        return hmac.compare_digest(token.encode(), self.config.token.encode())

    async def _auth(self, request: web.Request) -> web.Response:
        """Permite ao celular distinguir "PC fora do ar" de "token inválido"."""
        if not self._token_ok(request):
            raise web.HTTPUnauthorized()
        return web.json_response({"ok": True, "host": socket.gethostname()})

    # -- websocket ----------------------------------------------------------
    async def _ws(self, request: web.Request) -> web.WebSocketResponse:
        if not self._token_ok(request):
            log.warning("Conexão recusada de %s: token inválido", request.remote)
            raise web.HTTPUnauthorized(text="Token inválido. Escaneie o QR code novamente.")

        # compress=False: compressão por mensagem só adicionaria latência.
        ws = web.WebSocketResponse(compress=False, max_msg_size=64 * 1024, heartbeat=15)
        await ws.prepare(request)
        _set_nodelay(request)

        cid = self._next_id
        self._next_id += 1
        addr = request.remote or "?"
        client = Client(
            id=cid,
            addr=addr,
            user_agent=request.headers.get("User-Agent", ""),
            session=Session(cid, addr, self.smoother, stats=self.stats),
            ws=ws,
        )
        self.clients[cid] = client
        log.info("Celular conectado: %s", addr)
        await ws.send_json({"type": "hello", "host": socket.gethostname(), "rtc": HAS_RTC})

        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    reply = client.session.handle(msg.data, "tcp")
                    if reply:
                        await ws.send_bytes(reply)
                elif msg.type == WSMsgType.TEXT:
                    await self._control(client, ws, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    log.debug("Erro no WebSocket: %s", ws.exception())
        finally:
            # Primeiro o que é síncrono e não pode ser perdido (soltar botões,
            # tirar da lista): no encerramento esta tarefa é cancelada e o
            # await abaixo é interrompido.
            client.session.close()
            self.clients.pop(cid, None)
            log.info("Celular desconectado: %s", addr)
            await self._close_pc(client)
        return ws

    async def _control(self, client: Client, ws: web.WebSocketResponse, text: str) -> None:
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if msg.get("type") == "offer" and isinstance(msg.get("sdp"), str):
            if not HAS_RTC:
                await ws.send_json({"type": "rtc-unavailable"})
                return
            try:
                answer = await self._rtc_answer(client, msg["sdp"])
            except Exception as exc:  # noqa: BLE001 — qualquer falha cai no WebSocket
                log.warning("WebRTC falhou (%s); seguindo pelo WebSocket.", exc)
                await ws.send_json({"type": "rtc-unavailable"})
                return
            await ws.send_json({"type": "answer", "sdp": answer})

    # -- WebRTC -------------------------------------------------------------
    @staticmethod
    async def _close_pc(client: Client) -> None:
        """Fecha a conexão WebRTC uma única vez, sem deixar erro escapar.

        O encerramento (Ctrl+C) e a desconexão do celular podem fechar a mesma
        conexão ao mesmo tempo; o aiortc então cancela um futuro interno e um
        CancelledError vaza para quem chamou. Tirar a referência antes de
        aguardar garante um único fechamento; o CancelledError só é repassado
        se for a própria tarefa que está sendo cancelada.
        """
        pc, client.pc = client.pc, None
        client.udp = False
        if pc is None:
            return
        try:
            await asyncio.wait_for(pc.close(), 2)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise

    async def _rtc_answer(self, client: Client, offer_sdp: str) -> str:
        await self._close_pc(client)

        # Sem servidores STUN: tudo acontece na rede local.
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        client.pc = pc
        session = client.session

        @pc.on("datachannel")
        def on_datachannel(channel) -> None:
            @channel.on("open")
            def on_open() -> None:
                client.udp = True

            @channel.on("close")
            def on_close() -> None:
                if client.pc is pc:
                    client.udp = False
                    log.info("Canal UDP fechado: %s (usando WebSocket)", client.addr)

            @channel.on("message")
            def on_message(data) -> None:
                if not client.udp:
                    client.udp = True
                    log.info("Canal UDP ativo: %s", client.addr)
                if isinstance(data, (bytes, bytearray)):
                    reply = session.handle(bytes(data), "udp")
                    if reply and channel.readyState == "open":
                        channel.send(reply)

        @pc.on("connectionstatechange")
        async def on_state() -> None:
            log.debug("WebRTC %s: %s", client.addr, pc.connectionState)
            if pc.connectionState in ("failed", "closed") and client.pc is pc:
                client.udp = False

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
        await pc.setLocalDescription(await pc.createAnswer())
        return pc.localDescription.sdp


def _set_nodelay(request: web.Request) -> None:
    """Desliga o algoritmo de Nagle: cada pacote sai na hora, sem esperar juntar."""
    transport = request.transport
    sock = transport.get_extra_info("socket") if transport else None
    if sock is not None:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass


def qr_svg(data: str) -> str:
    import qrcode
    import qrcode.image.svg

    img = qrcode.make(
        data,
        image_factory=qrcode.image.svg.SvgPathFillImage,
        border=2,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")


def qr_terminal(data: str) -> str:
    import qrcode

    qr = qrcode.QRCode(border=1, error_correction=qrcode.constants.ERROR_CORRECT_L)
    qr.add_data(data)
    qr.make(fit=True)
    buf = io.StringIO()
    qr.print_ascii(out=buf, invert=True)
    return buf.getvalue()
