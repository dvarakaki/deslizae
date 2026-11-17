"""Ponto de entrada: ``python -m deslizae``."""

from __future__ import annotations

import argparse
import asyncio
import errno
import logging
import sys
import webbrowser

from aiohttp import web

from . import __version__
from .config import Config, new_token
from .server import DryRunMouse, TouchpadServer, qr_terminal


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="deslizae",
        description="Usa o celular como touchpad do PC pela rede local.",
    )
    p.add_argument("--port", type=int, help="porta do servidor (padrão: a salva, ou 8765)")
    p.add_argument("--no-browser", action="store_true", help="não abrir a página de pareamento")
    p.add_argument(
        "--new-token",
        action="store_true",
        help="gera um novo código de pareamento (desconecta celulares já pareados)",
    )
    p.add_argument("--dry-run", action="store_true", help="não mexe no cursor; só registra")
    p.add_argument("--stats", action="store_true", help="mostra o ritmo de chegada dos movimentos")
    p.add_argument(
        "--lab",
        action="store_true",
        help="experimental: sobe HTTPS na porta seguinte com o modo mouse pela câmera (/lab)",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="log detalhado")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    cfg = Config.load()
    changed = False
    if args.new_token:
        cfg.token = new_token()
        changed = True
    if args.port and args.port != cfg.port:
        cfg.port = args.port
        changed = True
    if changed:
        cfg.save()

    if args.dry_run:
        mouse = DryRunMouse()
    else:
        if sys.platform != "win32":
            print("Este agente só funciona no Windows (use --dry-run para testar).")
            return 2
        from .win_input import Mouse

        mouse = Mouse()

    server = TouchpadServer(cfg, mouse, stats=args.stats)
    # shutdown_timeout curto: o Ctrl+C não deve esperar conexões penduradas.
    runner = web.AppRunner(server.app, access_log=None, handle_signals=False, shutdown_timeout=2.0)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=cfg.port, reuse_address=False)
    try:
        await site.start()
    except OSError as exc:
        await runner.cleanup()
        if exc.errno in (errno.EADDRINUSE, 10048):
            print(
                f"A porta {cfg.port} já está em uso (o agente já está aberto?). "
                f"Feche a outra instância ou use --port OUTRA_PORTA."
            )
            return 1
        raise

    lab_url = None
    if args.lab:
        lab_url = await _start_lab_site(runner, server, cfg)
        if lab_url is None:
            await runner.cleanup()
            return 1

    url = server.phone_url()
    pair_url = f"http://localhost:{cfg.port}/pair"
    print()
    print(f"  Deslizae {__version__}" + ("  [dry-run]" if args.dry_run else ""))
    if lab_url:
        print("  MODO LABORATÓRIO: mouse pela câmera olhando para o teto (experimental).")
        print("  Escaneie com o celular. Na primeira vez, aceite o aviso de certificado")
        print('  ("Avançado → Continuar"): o certificado foi gerado neste PC.')
        print()
        print(qr_terminal(lab_url))
        print(f"  Laboratório: {lab_url}")
        print(f"  Touchpad:    {url}")
    else:
        print("  Escaneie com a câmera do celular (mesmo Wi-Fi do PC):")
        print()
        print(qr_terminal(url))
        print(f"  Endereço:   {url}")
    print(f"  Pareamento: {pair_url}")
    print()
    print("  Ctrl+C para encerrar.")
    print()

    if not args.no_browser:
        webbrowser.open(pair_url)

    try:
        # Acordar periodicamente garante que o Ctrl+C seja atendido no Windows,
        # onde um loop totalmente ocioso pode não perceber o sinal.
        while True:
            await asyncio.sleep(0.25)
    finally:
        await runner.cleanup()
    return 0


async def _start_lab_site(runner: web.AppRunner, server: TouchpadServer, cfg: Config) -> str | None:
    """HTTPS na porta seguinte: o navegador só libera câmera e giroscópio assim."""
    from .config import config_dir
    from .netinfo import all_ipv4, primary_ipv4
    from .tls import ensure_certificate, server_context

    cert, key = ensure_certificate(config_dir() / "tls", all_ipv4())
    port = cfg.port + 1
    site = web.TCPSite(runner, host="0.0.0.0", port=port, ssl_context=server_context(cert, key))
    try:
        await site.start()
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, 10048):
            print(f"A porta {port} (laboratório) já está em uso.")
            return None
        raise
    ip = primary_ipv4() or "127.0.0.1"
    return f"https://{ip}:{port}/lab?t={cfg.token}"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    # O QR do terminal usa caracteres Unicode de meio-bloco.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="  %(asctime)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    # As bibliotecas de rede são muito verbosas em DEBUG; o -v é para o agente.
    for name in ("aiohttp", "aiortc", "aioice"):
        logging.getLogger(name).setLevel(logging.WARNING)
    # Erros esperados de interfaces sem rota (ex.: VPN IPv6) não interessam.
    logging.getLogger("aioice.ice").setLevel(logging.ERROR)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\n  Encerrado.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
