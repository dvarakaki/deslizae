"""Descobre os endereços IPv4 locais pelos quais o celular alcança o PC."""

from __future__ import annotations

import ipaddress
import socket


def primary_ipv4() -> str | None:
    """IP da interface usada para a rota padrão (normalmente o Wi-Fi/cabo).

    O ``connect`` em UDP não envia pacote nenhum; só faz o sistema escolher
    a interface de saída.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        except OSError:
            return None
    return ip if _usable(ip) else None


def all_ipv4() -> list[str]:
    ips: list[str] = []
    primary = primary_ipv4()
    if primary:
        ips.append(primary)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if _usable(ip) and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return ips


def _usable(ip: str) -> bool:
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return False
    return not (addr.is_loopback or addr.is_link_local or addr.is_unspecified)
