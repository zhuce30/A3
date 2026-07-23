from __future__ import annotations

import ipaddress

from django.conf import settings


DEFAULT_TRUSTED_PROXY_CIDRS = ["127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]


def _parse_ip(value: object) -> str:
    try:
        return str(ipaddress.ip_address(str(value).strip()))
    except ValueError:
        return ""


def _is_trusted_proxy(value: object) -> bool:
    parsed = _parse_ip(value)
    if not parsed:
        return False
    address = ipaddress.ip_address(parsed)
    cidrs = getattr(settings, "A3_TRUSTED_PROXY_CIDRS", DEFAULT_TRUSTED_PROXY_CIDRS)
    for cidr in cidrs:
        try:
            if address in ipaddress.ip_network(str(cidr), strict=False):
                return True
        except ValueError:
            continue
    return False


def get_client_ip(request) -> str:
    remote = _parse_ip(request.META.get("REMOTE_ADDR", ""))
    if not _is_trusted_proxy(remote):
        return remote

    cloudflare = _parse_ip(request.META.get("HTTP_CF_CONNECTING_IP", ""))
    if cloudflare:
        return cloudflare
    forwarded = str(request.META.get("HTTP_X_FORWARDED_FOR", ""))
    for item in forwarded.split(","):
        parsed = _parse_ip(item)
        if parsed:
            return parsed
    return remote


def get_trusted_country(request) -> str:
    if not _is_trusted_proxy(request.META.get("REMOTE_ADDR", "")):
        return ""
    country = str(request.META.get("HTTP_CF_IPCOUNTRY", "")).strip().upper()
    return country if len(country) == 2 and country.isalpha() else ""


def mask_ip(value: str | None) -> str:
    parsed = _parse_ip(value or "")
    if not parsed:
        return ""
    address = ipaddress.ip_address(parsed)
    if address.version == 4:
        parts = parsed.split(".")
        return ".".join([*parts[:3], "*"])
    compressed = address.compressed.split(":")
    return f"{':'.join(compressed[:2])}::*"
