from __future__ import annotations

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.notes.serializers import JsonBodyError, parse_json_body
from backend.apps.notes.services import memory_service
from backend.apps.notes.views_notes import authenticated


def _error(exc: Exception) -> JsonResponse:
    if isinstance(exc, JsonBodyError):
        return JsonResponse({"success": False, "code": exc.code, "error": str(exc)}, status=400)
    if isinstance(exc, memory_service.MemoryServiceError):
        return JsonResponse(
            {"success": False, "code": exc.code, "error": str(exc)},
            status=exc.status,
        )
    raise exc


@authenticated
@require_http_methods(["GET"])
def memories(request):
    try:
        items = memory_service.list_memories(
            request.user,
            status=str(request.GET.get("status") or "").strip(),
        )
        return JsonResponse(
            {
                "success": True,
                "memories": [memory_service.serialize_memory(item) for item in items],
            }
        )
    except memory_service.MemoryServiceError as exc:
        return _error(exc)


@authenticated
@require_http_methods(["POST"])
def memory_confirm(request, memory_id):
    try:
        memory = memory_service.confirm_memory(request.user, memory_id, parse_json_body(request))
        return JsonResponse({"success": True, "memory": memory_service.serialize_memory(memory)})
    except (JsonBodyError, memory_service.MemoryServiceError) as exc:
        return _error(exc)


def _empty_action(request, memory_id, action):
    try:
        body = parse_json_body(request)
        if body:
            raise memory_service.MemoryServiceError(
                "该操作不接受额外字段",
                code="invalid_memory_update",
            )
        memory = action(request.user, memory_id)
        return JsonResponse({"success": True, "memory": memory_service.serialize_memory(memory)})
    except (JsonBodyError, memory_service.MemoryServiceError) as exc:
        return _error(exc)


@authenticated
@require_http_methods(["POST"])
def memory_pause(request, memory_id):
    return _empty_action(request, memory_id, memory_service.pause_memory)


@authenticated
@require_http_methods(["POST"])
def memory_resume(request, memory_id):
    return _empty_action(request, memory_id, memory_service.resume_memory)


@authenticated
@require_http_methods(["POST"])
def memory_delete(request, memory_id):
    return _empty_action(request, memory_id, memory_service.delete_memory)


@authenticated
@require_http_methods(["POST"])
def memory_supersede(request, memory_id):
    try:
        memory, replacement = memory_service.supersede_memory(
            request.user,
            memory_id,
            parse_json_body(request),
        )
        return JsonResponse(
            {
                "success": True,
                "memory": memory_service.serialize_memory(memory),
                "replacement": memory_service.serialize_memory(replacement),
            }
        )
    except (JsonBodyError, memory_service.MemoryServiceError) as exc:
        return _error(exc)
