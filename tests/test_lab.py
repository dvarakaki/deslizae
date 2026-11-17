import asyncio
import ipaddress

import aiohttp
from aiohttp import web
from cryptography import x509

from deslizae.config import Config
from deslizae.server import DryRunMouse, TouchpadServer
from deslizae.tls import ensure_certificate, server_context


def san_of(cert_path):
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return set(san.get_values_for_type(x509.DNSName)), set(san.get_values_for_type(x509.IPAddress))


def test_certificate_covers_local_ips_and_is_reused(tmp_path):
    cert, key = ensure_certificate(tmp_path, ["192.168.0.10"])
    dns, ips = san_of(cert)
    assert "localhost" in dns
    assert ipaddress.ip_address("192.168.0.10") in ips
    assert ipaddress.ip_address("127.0.0.1") in ips

    before = cert.read_bytes()
    ensure_certificate(tmp_path, ["192.168.0.10"])
    assert cert.read_bytes() == before  # mesmo IP: reaproveita

    ensure_certificate(tmp_path, ["10.0.0.5"])  # PC mudou de rede: refaz
    _, ips = san_of(cert)
    assert ipaddress.ip_address("10.0.0.5") in ips


def test_https_serves_lab_page(tmp_path):
    async def main():
        cert, key = ensure_certificate(tmp_path, [])
        server = TouchpadServer(Config(token="token-de-teste-123", port=0), DryRunMouse())
        runner = web.AppRunner(server.app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=server_context(cert, key))
        await site.start()
        port = runner.addresses[0][1]
        try:
            async with aiohttp.ClientSession() as http:
                base = f"https://127.0.0.1:{port}"
                page = await http.get(base + "/lab", ssl=False)
                assert page.status == 200
                assert "Deslizae · Mouse" in await page.text()
                for asset in ("flow.js", "flow-worker.js", "motion.js", "lab.js", "lab.css"):
                    assert (await http.get(f"{base}/static/{asset}", ssl=False)).status == 200
        finally:
            await runner.cleanup()

    asyncio.run(main())
