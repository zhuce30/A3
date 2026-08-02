from __future__ import annotations

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.notes.serializers import JsonBodyError, parse_json_body
from backend.apps.notes.services import assistant_service
from backend.apps.notes.views_notes import authenticated


def _error(exc: Exception) -> JsonResponse:
    if isinstance(exc, JsonBodyError):
        return JsonResponse({"success": False, "code": exc.code, "error": str(exc)}, status=400)
    if isinstance(exc, assistant_service.AssistantServiceError):
        return JsonResponse(
            {"success": False, "code": exc.code, "error": str(exc)}, status=exc.status
        )
    raise exc


@authenticated
@require_http_methods(["GET", "POST"])
def sessions(request):
    try:
        if request.method == "GET":
            items = assistant_service.list_sessions(request.user)
            return JsonResponse(
                {"success": True, "sessions": [assistant_service.serialize_session(item) for item in items]}
            )
        session = assistant_service.create_session(request.user, parse_json_body(request))
        return JsonResponse(
            {"success": True, "session": assistant_service.serialize_session(session)}, status=201
        )
    except (JsonBodyError, assistant_service.AssistantServiceError) as exc:
        return _error(exc)


@authenticated
@require_http_methods(["GET"])
def session_messages(request, session_id):
    try:
        items = assistant_service.list_messages(request.user, session_id)
        return JsonResponse(
            {"success": True, "messages": [assistant_service.serialize_message(item) for item in items]}
        )
    except assistant_service.AssistantServiceError as exc:
        return _error(exc)


@authenticated
@require_http_methods(["POST"])
def chat(request):
    try:
        submission = assistant_service.submit_chat(request.user, parse_json_body(request))
        from backend.apps.notes.tasks import enqueue_assistant_message

        should_dispatch = submission.created or (
            submission.assistant_message.status == "queued"
            and (
                submission.assistant_message.error_code == "assistant_enqueue_failed"
                or submission.assistant_message.dispatch_confirmed_at is None
            )
        )
        if should_dispatch:
            enqueue_assistant_message(submission.assistant_message)
        submission.assistant_message.refresh_from_db()
        return JsonResponse(
            {
                "success": True,
                "message": assistant_service.serialize_message(submission.assistant_message),
                "idempotent": not submission.created,
            },
            status=202,
        )
    except (JsonBodyError, assistant_service.AssistantServiceError) as exc:
        return _error(exc)


@authenticated
@require_http_methods(["GET"])
def message_detail(request, message_id):
    try:
        message = assistant_service.get_owned_message(request.user, message_id)
        return JsonResponse({"success": True, "message": assistant_service.serialize_message(message)})
    except assistant_service.AssistantServiceError as exc:
        return _error(exc)
