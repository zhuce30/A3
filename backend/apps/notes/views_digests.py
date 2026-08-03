from __future__ import annotations

from datetime import date

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.notes.serializers import JsonBodyError, parse_json_body
from backend.apps.notes.services import digest_service
from backend.apps.notes.views_notes import authenticated


def _parse_date(value, *, required: bool) -> date | None:
    if value in (None, "") and not required:
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise DigestRequestError("日期格式必须是 YYYY-MM-DD", "digest_date_invalid")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise DigestRequestError("日期格式必须是 YYYY-MM-DD", "digest_date_invalid") from exc


class DigestRequestError(ValueError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def _error(exc: Exception) -> JsonResponse:
    if isinstance(exc, JsonBodyError):
        return JsonResponse({"success": False, "code": exc.code, "error": str(exc)}, status=400)
    if isinstance(exc, DigestRequestError):
        return JsonResponse({"success": False, "code": exc.code, "error": str(exc)}, status=400)
    if isinstance(exc, digest_service.DigestServiceError):
        return JsonResponse({"success": False, "code": exc.code, "error": str(exc)}, status=exc.status)
    raise exc


@authenticated
@require_http_methods(["GET"])
def digests(request):
    try:
        target_date = _parse_date(request.GET.get("date"), required=False)
        items = digest_service.list_owned_digests(request.user, target_date)
        return JsonResponse({
            "success": True,
            "digests": [digest_service.serialize_digest(item) for item in items],
        })
    except (DigestRequestError, digest_service.DigestServiceError) as exc:
        return _error(exc)


@authenticated
@require_http_methods(["GET"])
def digest_detail(request, digest_id):
    try:
        digest = digest_service.get_owned_digest(request.user, digest_id)
        return JsonResponse({"success": True, "digest": digest_service.serialize_digest(digest)})
    except digest_service.DigestServiceError as exc:
        return _error(exc)


@authenticated
@require_http_methods(["POST"])
def digest_manual(request):
    try:
        payload = parse_json_body(request)
        target_date = _parse_date(payload.get("date"), required=True)
        digest = digest_service.create_manual_digest(request.user, target_date)
        return JsonResponse({"success": True, "digest": digest_service.serialize_digest(digest)}, status=201)
    except (JsonBodyError, DigestRequestError, digest_service.DigestServiceError) as exc:
        return _error(exc)


@authenticated
@require_http_methods(["POST"])
def digest_retry(request, digest_id):
    try:
        digest = digest_service.retry_digest(request.user, digest_id)
        return JsonResponse({"success": True, "digest": digest_service.serialize_digest(digest)}, status=202)
    except digest_service.DigestServiceError as exc:
        return _error(exc)
