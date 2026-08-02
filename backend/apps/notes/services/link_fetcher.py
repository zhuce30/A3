from __future__ import annotations

import ipaddress
import socket
import threading
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any

import requests


MAX_LINK_BYTES = 2 * 1024 * 1024
MAX_LINK_REDIRECTS = 3
TOTAL_TIMEOUT_SECONDS = 5.0
CONNECT_TIMEOUT_SECONDS = 2.0
READ_TIMEOUT_SECONDS = 2.0


class SafeLinkError(Exception):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SafeLinkResponse:
    final_url: str
    body: bytes
    mime_type: str


def _normalized_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    address = ipaddress.ip_address(str(value).split("%", 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SafeLinkError("链接验证超时，请稍后重试", code="note_link_timeout")
    return remaining


def _resolve_addresses(hostname: str, port: int, deadline: float) -> list[tuple]:
    outcome: dict[str, Any] = {}

    def resolve() -> None:
        try:
            outcome["records"] = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except BaseException as exc:
            outcome["error"] = exc

    resolver = threading.Thread(target=resolve, name="a3-note-link-dns", daemon=True)
    resolver.start()
    resolver.join(_remaining(deadline))
    if resolver.is_alive():
        raise SafeLinkError("链接验证超时，请稍后重试", code="note_link_timeout")
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("records", [])


def _resolve_public_url(url: str, deadline: float) -> tuple[str, set[str]]:
    if not isinstance(url, str) or len(url) > 2048:
        raise SafeLinkError("链接格式无效", code="unsafe_note_link")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise SafeLinkError("仅支持安全的 HTTP(S) 链接", code="unsafe_note_link")
    if parsed.fragment:
        parsed = parsed._replace(fragment="")
        url = urllib.parse.urlunsplit(parsed)
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        records = _resolve_addresses(parsed.hostname, port, deadline)
        _remaining(deadline)
        addresses = {_normalized_ip(record[4][0]) for record in records}
    except SafeLinkError:
        raise
    except (OSError, ValueError, UnicodeError) as exc:
        raise SafeLinkError("链接地址无法安全解析", code="unsafe_note_link") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise SafeLinkError("链接目标不是公网地址", code="unsafe_note_link")
    return url, {str(address) for address in addresses}


def _nested_attr(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for name in path:
        current = getattr(current, name, None)
        if current is None:
            return None
    return current


def _response_peer_ip(response) -> str | None:
    raw = getattr(response, "raw", None)
    socket_paths = (
        ("_connection", "sock"),
        ("connection", "sock"),
        ("_fp", "fp", "raw", "_sock"),
        ("_fp", "fp", "raw", "sock"),
        ("_original_response", "fp", "raw", "_sock"),
        ("_original_response", "fp", "raw", "sock"),
    )
    for path in socket_paths:
        peer_socket = _nested_attr(raw, path)
        if peer_socket is None:
            continue
        try:
            return str(_normalized_ip(peer_socket.getpeername()[0]))
        except (OSError, ValueError, AttributeError, TypeError):
            continue
    return None


def _new_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    session.auth = None
    session.cookies.clear()
    session.proxies.clear()
    return session


def fetch_safe_link(url: str) -> SafeLinkResponse:
    deadline = time.monotonic() + TOTAL_TIMEOUT_SECONDS
    current = url
    session = _new_session()
    try:
        for redirect_count in range(MAX_LINK_REDIRECTS + 1):
            _remaining(deadline)
            current, approved_addresses = _resolve_public_url(current, deadline)
            remaining = _remaining(deadline)
            timeout = (
                min(CONNECT_TIMEOUT_SECONDS, remaining),
                min(READ_TIMEOUT_SECONDS, remaining),
            )
            try:
                response = session.get(
                    current,
                    allow_redirects=False,
                    stream=True,
                    timeout=timeout,
                    headers={
                        "User-Agent": "A3-Notes-LinkValidator/1.0",
                        "Accept": "text/plain,text/html,application/xhtml+xml",
                    },
                )
            except requests.RequestException as exc:
                raise SafeLinkError("链接暂时无法访问", code="note_link_unavailable") from exc
            try:
                _remaining(deadline)
                peer_ip = _response_peer_ip(response)
                if peer_ip is None or peer_ip not in approved_addresses or not _normalized_ip(peer_ip).is_global:
                    raise SafeLinkError("链接连接目标无法验证", code="unsafe_note_link")
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location", "")
                    if redirect_count >= MAX_LINK_REDIRECTS or not location:
                        raise SafeLinkError("链接重定向次数过多", code="unsafe_note_link")
                    current = urllib.parse.urljoin(current, location)
                    continue
                if response.status_code < 200 or response.status_code >= 300:
                    raise SafeLinkError("链接暂时无法访问", code="note_link_unavailable")
                try:
                    declared_length = int(response.headers.get("Content-Length", "0") or 0)
                except ValueError:
                    declared_length = 0
                if declared_length > MAX_LINK_BYTES:
                    raise SafeLinkError("链接内容超过大小限制", code="note_link_too_large")
                chunks: list[bytes] = []
                total = 0
                try:
                    iterator = iter(response.iter_content(chunk_size=64 * 1024))
                    while True:
                        _remaining(deadline)
                        try:
                            chunk = next(iterator)
                        except StopIteration:
                            break
                        _remaining(deadline)
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > MAX_LINK_BYTES:
                            raise SafeLinkError("链接内容超过大小限制", code="note_link_too_large")
                        chunks.append(chunk)
                except requests.RequestException as exc:
                    raise SafeLinkError("链接暂时无法访问", code="note_link_unavailable") from exc
                mime_type = str(response.headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
                return SafeLinkResponse(final_url=current, body=b"".join(chunks), mime_type=mime_type)
            finally:
                response.close()
    finally:
        session.close()
    raise SafeLinkError("链接重定向次数过多", code="unsafe_note_link")
