import asyncio

import aiohttp
import pytest
from aiohttp.test_utils import TestClient, TestServer

from deslizae import protocol as p
from deslizae.config import Config
from deslizae.server import HAS_RTC, DryRunMouse, TouchpadServer

TOKEN = "token-de-teste-123"


def run(coro_fn):
    async def main():
        mouse = DryRunMouse()
        server = TouchpadServer(Config(token=TOKEN, port=0), mouse)
        async with TestClient(TestServer(server.app)) as client:
            await coro_fn(client, mouse, server)

    asyncio.run(main())


async def wait_for(predicate, timeout=5.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not predicate():
        if loop.time() > end:
            raise AssertionError("tempo esgotado")
        await asyncio.sleep(0.01)


def moved(mouse):
    return sum(e[1] for e in mouse.events if e[0] == "move")


def test_rejects_wrong_token():
    async def body(client, mouse, server):
        r = await client.get("/api/auth", params={"t": "errado"})
        assert r.status == 401
        with pytest.raises(aiohttp.WSServerHandshakeError) as exc:
            await client.ws_connect("/ws", params={"t": "errado"})
        assert exc.value.status == 401

    run(body)


def test_auth_ok_and_pages():
    async def body(client, mouse, server):
        assert (await client.get("/api/auth", params={"t": TOKEN})).status == 200
        assert (await client.get("/")).status == 200
        assert (await client.get("/pair")).status == 200
        info = await (await client.get("/api/pair-info")).json()
        assert "host" in info

    run(body)


def test_websocket_path_and_release_on_disconnect():
    async def body(client, mouse, server):
        ws = await client.ws_connect("/ws", params={"t": TOKEN})
        hello = await ws.receive_json()
        assert hello["type"] == "hello"

        await ws.send_bytes(p.encode_move(1, 3.5, -1))
        await ws.send_bytes(p.encode_click(1, 1, 1, 3.5, -1))
        await ws.send_bytes(p.encode_button(2, 0, True, 1, 3.5, -1))  # começa um arraste
        await ws.send_bytes(b"\xff lixo")  # deve ser ignorado
        await ws.send_bytes(p.encode_ping(7.0))

        assert await ws.receive_bytes() == p.encode_pong(7.0)
        assert mouse.events == [("move", 3.5, -1.0), ("click", 1), ("button", 0, True)]

        # Conexão cai no meio do arraste: o botão precisa ser solto.
        await ws.close()
        await wait_for(lambda: not server.clients)
        assert mouse.events[-1] == ("button", 0, False)

    run(body)


def test_close_pc_is_single_and_swallows_internal_cancel():
    """Encerramento e desconexão fechando a mesma conexão ao mesmo tempo."""
    from deslizae.server import Client
    from deslizae.session import Session
    from deslizae.smoother import Smoother

    class LeakyPeer:
        closes = 0

        async def close(self):
            LeakyPeer.closes += 1
            await asyncio.sleep(0)
            raise asyncio.CancelledError  # como o aiortc faz sob corrida

    async def main():
        sm = Smoother(DryRunMouse())
        try:
            client = Client(id=1, addr="x", user_agent="", session=Session(1, "x", sm), pc=LeakyPeer())
            await asyncio.gather(TouchpadServer._close_pc(client), TouchpadServer._close_pc(client))
            assert client.pc is None and LeakyPeer.closes == 1
        finally:
            sm.close()

    asyncio.run(main())


@pytest.mark.skipif(not HAS_RTC, reason="aiortc não instalado")
def test_shutdown_with_phone_still_connected_over_webrtc():
    """Ctrl+C com o celular conectado por UDP: o agente encerra sem erro."""
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

    async def main():
        server = TouchpadServer(Config(token=TOKEN, port=0), DryRunMouse())
        phone = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        try:
            async with TestClient(TestServer(server.app)) as client:
                ws = await client.ws_connect("/ws", params={"t": TOKEN})
                await ws.receive_json()
                dc = phone.createDataChannel("input", ordered=False, maxRetransmits=0)
                opened = asyncio.Event()
                dc.on("open", opened.set)
                await phone.setLocalDescription(await phone.createOffer())
                await ws.send_json({"type": "offer", "sdp": phone.localDescription.sdp})
                answer = await ws.receive_json()
                await phone.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
                await asyncio.wait_for(opened.wait(), 10)
                # Sai do contexto sem fechar nada: o servidor encerra com tudo aberto.
            assert not server.clients
        finally:
            # O celular é fechado no mesmo loop em que foi criado.
            await phone.close()

    asyncio.run(main())


@pytest.mark.skipif(not HAS_RTC, reason="aiortc não instalado")
def test_webrtc_udp_path_end_to_end():
    """Um "celular" em Python negocia WebRTC pelo WebSocket e manda pelo UDP."""
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

    async def body(client, mouse, server):
        ws = await client.ws_connect("/ws", params={"t": TOKEN})
        assert (await ws.receive_json())["rtc"] is True

        phone = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        dc = phone.createDataChannel("input", ordered=False, maxRetransmits=0)
        opened = asyncio.Event()
        pongs = asyncio.Queue()
        dc.on("open", opened.set)
        dc.on("message", lambda m: pongs.put_nowait(m))

        await phone.setLocalDescription(await phone.createOffer())
        await ws.send_json({"type": "offer", "sdp": phone.localDescription.sdp})
        answer = await ws.receive_json()
        assert answer["type"] == "answer"
        await phone.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
        await asyncio.wait_for(opened.wait(), 10)

        for i in range(1, 6):
            dc.send(p.encode_move(i, i * 2.0, 0))
        dc.send(p.encode_ping(99.0))
        assert await asyncio.wait_for(pongs.get(), 5) == p.encode_pong(99.0)
        await wait_for(lambda: moved(mouse) >= 10.0)
        assert moved(mouse) == pytest.approx(10.0)

        status = await (await client.get("/api/status")).json()
        assert status["clients"][0]["transport"] == "udp"

        await phone.close()
        await ws.close()

    run(body)
