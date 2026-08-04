from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
import threading
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any


MAX_LINK_BYTES = 2 * 1024 * 1024
MAX_LINK_REDIRECTS = 3
TOTAL_TIMEOUT_SECONDS = 5.0
READ_SIZE = 64 * 1024
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
VALID_PERCENT_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")
PATH_SAFE_CHARACTERS = "/:@!$&'()*+,;=-._~"
QUERY_SAFE_CHARACTERS = "/?:@!$&'()*+,;=-._~"


class SafeLinkError(Exception):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SafeLinkResponse:
    final_url: str
    body: bytes
    mime_type: str


@dataclass(frozen=True)
class _ResolvedTarget:
    url: str
    scheme: str
    hostname: str
    port: int
    request_target: str
    approved_ips: tuple[str, ...]


def _timeout_error() -> SafeLinkError:
    return SafeLinkError("链接验证超时，请稍后重试", code="note_link_timeout")


def _normalized_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    address = ipaddress.ip_address(str(value).split("%", 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _timeout_error()
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
        raise _timeout_error()
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("records", [])


def _quote_iri_component(value: str, *, safe: str) -> str:
    encoded: list[str] = []
    offset = 0
    for match in VALID_PERCENT_ESCAPE.finditer(value):
        encoded.append(
            urllib.parse.quote(
                value[offset:match.start()],
                safe=safe,
                encoding="utf-8",
                errors="strict",
            )
        )
        encoded.append(match.group(0))
        offset = match.end()
    encoded.append(
        urllib.parse.quote(
            value[offset:],
            safe=safe,
            encoding="utf-8",
            errors="strict",
        )
    )
    return "".join(encoded)


def _ascii_request_target(parsed: urllib.parse.SplitResult) -> str:
    path = _quote_iri_component(parsed.path or "/", safe=PATH_SAFE_CHARACTERS)
    if not parsed.query:
        return path
    query = _quote_iri_component(parsed.query, safe=QUERY_SAFE_CHARACTERS)
    return f"{path}?{query}"


def _resolve_public_url(url: str, deadline: float) -> _ResolvedTarget:
    if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 32 for char in url):
        raise SafeLinkError("链接格式无效", code="unsafe_note_link")
    try:
        parsed = urllib.parse.urlsplit(url)
    except (UnicodeError, ValueError) as exc:
        raise SafeLinkError("链接地址编码无效", code="unsafe_note_link") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise SafeLinkError("仅支持安全的 HTTP(S) 链接", code="unsafe_note_link")
    try:
        hostname = parsed.hostname.encode("idna").decode("ascii")
        port = parsed.port or (443 if scheme == "https" else 80)
        records = _resolve_addresses(hostname, port, deadline)
        _remaining(deadline)
        addresses = {_normalized_ip(record[4][0]) for record in records}
    except SafeLinkError:
        raise
    except (OSError, ValueError, UnicodeError) as exc:
        raise SafeLinkError("链接地址无法安全解析", code="unsafe_note_link") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise SafeLinkError("链接目标不是公网地址", code="unsafe_note_link")
    if parsed.fragment:
        parsed = parsed._replace(fragment="")
        url = urllib.parse.urlunsplit(parsed)
    try:
        request_target = _ascii_request_target(parsed)
    except (UnicodeError, ValueError) as exc:
        raise SafeLinkError("链接地址编码无效", code="unsafe_note_link") from exc
    return _ResolvedTarget(
        url=url,
        scheme=scheme,
        hostname=hostname,
        port=port,
        request_target=request_target,
        approved_ips=tuple(sorted(str(address) for address in addresses)),
    )


def _verify_connected_peer(peer_socket: socket.socket, selected_ip: str) -> None:
    try:
        peer = _normalized_ip(peer_socket.getpeername()[0])
        selected = _normalized_ip(selected_ip)
    except (OSError, ValueError, AttributeError, TypeError) as exc:
        raise SafeLinkError("链接连接目标无法验证", code="unsafe_note_link") from exc
    if not peer.is_global or peer != selected:
        raise SafeLinkError("链接连接目标无法验证", code="unsafe_note_link")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, target: _ResolvedTarget, selected_ip: str, deadline: float) -> None:
        super().__init__(target.hostname, target.port, timeout=_remaining(deadline))
        self._selected_ip = selected_ip
        self._deadline = deadline

    def connect(self) -> None:
        connected = socket.create_connection(
            (self._selected_ip, self.port),
            timeout=_remaining(self._deadline),
        )
        try:
            _verify_connected_peer(connected, self._selected_ip)
            connected.settimeout(_remaining(self._deadline))
            self.sock = connected
        except BaseException:
            connected.close()
            raise


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, target: _ResolvedTarget, selected_ip: str, deadline: float) -> None:
        super().__init__(
            target.hostname,
            target.port,
            timeout=_remaining(deadline),
            context=ssl.create_default_context(),
        )
        self._selected_ip = selected_ip
        self._deadline = deadline

    def connect(self) -> None:
        connected = socket.create_connection(
            (self._selected_ip, self.port),
            timeout=_remaining(self._deadline),
        )
        try:
            _verify_connected_peer(connected, self._selected_ip)
            connected.settimeout(_remaining(self._deadline))
            self.sock = connected
            wrapped = self._context.wrap_socket(connected, server_hostname=self.host)
            wrapped.settimeout(_remaining(self._deadline))
            _verify_connected_peer(wrapped, self._selected_ip)
            self.sock = wrapped
        except BaseException:
            connected.close()
            self.sock = None
            raise


def _open_connection(target: _ResolvedTarget, selected_ip: str, deadline: float):
    connection_class = _PinnedHTTPSConnection if target.scheme == "https" else _PinnedHTTPConnection
    return connection_class(target, selected_ip, deadline)


def _set_socket_timeout(connection, deadline: float) -> None:
    if connection.sock is None:
        raise SafeLinkError("链接连接目标无法验证", code="unsafe_note_link")
    connection.sock.settimeout(_remaining(deadline))


def _read_bounded_body(response: http.client.HTTPResponse, connection, deadline: float) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        _set_socket_timeout(connection, deadline)
        maximum = min(READ_SIZE, MAX_LINK_BYTES + 1 - total)
        try:
            chunk = response.read1(maximum)
        except socket.timeout as exc:
            raise _timeout_error() from exc
        _remaining(deadline)
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_LINK_BYTES:
            raise SafeLinkError("链接内容超过大小限制", code="note_link_too_large")
        chunks.append(chunk)


def _fetch_target(target: _ResolvedTarget, deadline: float):
    selected_ip = target.approved_ips[0]
    connection = _open_connection(target, selected_ip, deadline)
    expired = threading.Event()

    def expire_connection() -> None:
        expired.set()
        sock = connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    timer = threading.Timer(_remaining(deadline), expire_connection)
    timer.daemon = True
    timer.start()
    response = None
    try:
        connection.request(
            "GET",
            target.request_target,
            headers={
                "Accept": "text/plain,text/html,application/xhtml+xml",
                "Accept-Encoding": "identity",
                "Connection": "close",
                "User-Agent": "A3-Notes-LinkValidator/1.0",
            },
        )
        _set_socket_timeout(connection, deadline)
        response = connection.getresponse()
        _remaining(deadline)
        return connection, response, expired, timer
    except SafeLinkError:
        timer.cancel()
        connection.close()
        raise
    except (socket.timeout, TimeoutError) as exc:
        timer.cancel()
        connection.close()
        raise _timeout_error() from exc
    except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
        timer.cancel()
        connection.close()
        if expired.is_set() or time.monotonic() >= deadline:
            raise _timeout_error() from exc
        raise SafeLinkError("链接暂时无法访问", code="note_link_unavailable") from exc


def fetch_safe_link(url: str) -> SafeLinkResponse:
    deadline = time.monotonic() + TOTAL_TIMEOUT_SECONDS
    current = url
    for redirect_count in range(MAX_LINK_REDIRECTS + 1):
        target = _resolve_public_url(current, deadline)
        connection = None
        response = None
        timer = None
        try:
            connection, response, _expired, timer = _fetch_target(target, deadline)
            status = response.status
            if status in REDIRECT_STATUSES:
                location = response.getheader("Location", "")
                if redirect_count >= MAX_LINK_REDIRECTS or not location:
                    raise SafeLinkError("链接重定向次数过多", code="unsafe_note_link")
                current = urllib.parse.urljoin(target.url, location)
                continue
            if status < 200 or status >= 300:
                raise SafeLinkError("链接暂时无法访问", code="note_link_unavailable")
            try:
                declared_length = int(response.getheader("Content-Length", "0") or 0)
            except ValueError:
                declared_length = 0
            if declared_length > MAX_LINK_BYTES:
                raise SafeLinkError("链接内容超过大小限制", code="note_link_too_large")
            body = _read_bounded_body(response, connection, deadline)
            mime_type = str(response.getheader("Content-Type", "")).split(";", 1)[0].strip().lower()
            return SafeLinkResponse(final_url=target.url, body=body, mime_type=mime_type)
        except SafeLinkError:
            raise
        except (socket.timeout, TimeoutError) as exc:
            raise _timeout_error() from exc
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            if time.monotonic() >= deadline:
                raise _timeout_error() from exc
            raise SafeLinkError("链接暂时无法访问", code="note_link_unavailable") from exc
        finally:
            if timer is not None:
                timer.cancel()
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
    raise SafeLinkError("链接重定向次数过多", code="unsafe_note_link")
