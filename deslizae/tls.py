"""Certificado HTTPS autoassinado para a rede local.

O navegador só libera câmera e giroscópio em contexto seguro (HTTPS). Como o
agente roda na rede local, sem domínio público, ele gera o próprio
certificado — o celular mostra um aviso na primeira vez, que o usuário aceita.

O certificado é refeito quando os IPs do PC mudam ou quando está perto de
vencer, e fica guardado junto da configuração.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

VALIDITY_DAYS = 365
RENEW_BEFORE_DAYS = 30


def _wanted_names(ips: list[str]) -> set[str]:
    return {"localhost", "127.0.0.1", *ips}


def _current_names(cert: x509.Certificate) -> set[str]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return set()
    names = {str(n) for n in san.get_values_for_type(x509.DNSName)}
    names |= {str(n) for n in san.get_values_for_type(x509.IPAddress)}
    return names


def _still_valid(cert_path: Path, ips: list[str]) -> bool:
    try:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    except (OSError, ValueError):
        return False
    remaining = cert.not_valid_after_utc - dt.datetime.now(dt.timezone.utc)
    return remaining > dt.timedelta(days=RENEW_BEFORE_DAYS) and _wanted_names(ips) <= _current_names(cert)


def ensure_certificate(directory: Path, ips: list[str]) -> tuple[Path, Path]:
    """Garante cert.pem/key.pem válidos para os IPs informados."""
    cert_path = directory / "cert.pem"
    key_path = directory / "key.pem"
    if key_path.exists() and _still_valid(cert_path, ips):
        return cert_path, key_path

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Deslizae (rede local)")])
    alt = [x509.DNSName("localhost")]
    alt += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in sorted(set(ips) | {"127.0.0.1"})]
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=VALIDITY_DAYS))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )

    directory.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def server_context(cert_path: Path, key_path: Path) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert_path, key_path)
    return ctx
