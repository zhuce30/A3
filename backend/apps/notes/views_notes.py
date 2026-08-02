from __future__ import annotations

from functools import wraps

from django.http import FileResponse, JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.notes.serializers import (
    JsonBodyError,
    parse_json_body,
    serialize_note_detail,
    serialize_note_summary,
    serialize_notebook,
    serialize_revision,
    serialize_tag,
)
from backend.apps.notes.services import export_service, note_service


def authenticated(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse(
                {"success": False, "code": "authentication_required", "error": "请先登录"},
                status=401,
            )
        return view(request, *args, **kwargs)

    return wrapped


def _error_response(exc: Exception) -> JsonResponse:
    if isinstance(exc, JsonBodyError):
        return JsonResponse({"success": False, "code": exc.code, "error": str(exc)}, status=400)
    if isinstance(exc, note_service.NoteServiceError):
        payload = {"success": False, "code": exc.code, "error": str(exc)}
        if "server_version" in exc.details:
            payload["serverVersion"] = exc.details["server_version"]
        if "server_note" in exc.details:
            payload["serverNote"] = serialize_note_detail(exc.details["server_note"])
        return JsonResponse(payload, status=exc.status)
    raise exc


@authenticated
@require_http_methods(["GET", "POST"])
def notebooks(request):
    try:
        if request.method == "GET":
            items = note_service.list_notebooks(request.user)
            return JsonResponse({"success": True, "notebooks": [serialize_notebook(item) for item in items]})
        notebook = note_service.create_notebook(request.user, parse_json_body(request))
        return JsonResponse({"success": True, "notebook": serialize_notebook(notebook)}, status=201)
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["PATCH"])
def notebook_detail(request, notebook_id):
    try:
        notebook = note_service.update_notebook(request.user, notebook_id, parse_json_body(request))
        return JsonResponse({"success": True, "notebook": serialize_notebook(notebook)})
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["GET", "POST"])
def tags(request):
    try:
        if request.method == "GET":
            items = note_service.list_tags(request.user)
            return JsonResponse({"success": True, "tags": [serialize_tag(item) for item in items]})
        tag = note_service.create_tag(request.user, parse_json_body(request))
        return JsonResponse({"success": True, "tag": serialize_tag(tag)}, status=201)
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["DELETE"])
def tag_detail(request, tag_id):
    try:
        note_service.delete_tag(request.user, tag_id)
        return JsonResponse({"success": True, "deleted": True})
    except note_service.NoteServiceError as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["GET", "POST"])
def notes(request):
    try:
        if request.method == "GET":
            items = note_service.list_notes(request.user)
            return JsonResponse({"success": True, "notes": [serialize_note_summary(item) for item in items]})
        note = note_service.create_note(request.user, parse_json_body(request))
        return JsonResponse({"success": True, "note": serialize_note_detail(note)}, status=201)
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["GET", "PATCH", "DELETE"])
def note_detail(request, note_id):
    try:
        if request.method == "GET":
            note = note_service.get_note(request.user, note_id)
            return JsonResponse({"success": True, "note": serialize_note_detail(note)})
        if request.method == "DELETE":
            note = note_service.soft_delete_note(request.user, note_id)
            return JsonResponse({"success": True, "note": serialize_note_detail(note)})
        result = note_service.save_note(request.user, note_id, parse_json_body(request))
        return JsonResponse(
            {
                "success": True,
                "note": serialize_note_detail(result.note),
                "resultingVersion": result.resulting_version,
                "idempotent": result.idempotent,
            }
        )
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["POST"])
def note_restore(request, note_id):
    try:
        parse_json_body(request)
        note = note_service.restore_deleted_note(request.user, note_id)
        return JsonResponse({"success": True, "note": serialize_note_detail(note)})
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["DELETE"])
def note_purge(request, note_id):
    try:
        data = parse_json_body(request)
        if data.get("confirm") is not True:
            raise note_service.NoteServiceError(
                "永久删除前必须明确确认", code="purge_confirmation_required"
            )
        note_service.purge_note(request.user, note_id)
        return JsonResponse({"success": True, "purged": True})
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["GET"])
def revisions(request, note_id):
    try:
        items = note_service.list_revisions(request.user, note_id)
        return JsonResponse({"success": True, "revisions": [serialize_revision(item) for item in items]})
    except note_service.NoteServiceError as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["POST"])
def revision_restore(request, note_id, revision_id):
    try:
        result = note_service.restore_revision(
            request.user, note_id, revision_id, parse_json_body(request)
        )
        return JsonResponse(
            {
                "success": True,
                "note": serialize_note_detail(result.note),
                "resultingVersion": result.resulting_version,
                "idempotent": result.idempotent,
            }
        )
    except (JsonBodyError, note_service.NoteServiceError) as exc:
        return _error_response(exc)


@authenticated
@require_http_methods(["GET"])
def search(request):
    try:
        items = note_service.search_notes(request.user, request.GET)
        return JsonResponse({"success": True, "notes": [serialize_note_summary(item) for item in items]})
    except note_service.NoteServiceError as exc:
        return _error_response(exc)


def _export_error_response(exc: export_service.ExportServiceError) -> JsonResponse:
    return JsonResponse(
        {"success": False, "code": exc.code, "error": str(exc)}, status=exc.status
    )


@authenticated
@require_http_methods(["POST"])
def exports(request):
    try:
        data = parse_json_body(request)
        job = export_service.create_export_job(
            user=request.user, note_ids=data.get("noteIds"), format=data.get("format")
        )
        from backend.apps.notes.tasks import enqueue_export

        job = enqueue_export(job)
        return JsonResponse(
            {"success": True, "export": export_service.serialize_export(job)}, status=202
        )
    except JsonBodyError as exc:
        return _error_response(exc)
    except export_service.ExportServiceError as exc:
        return _export_error_response(exc)


@authenticated
@require_http_methods(["GET"])
def export_detail(request, export_id):
    try:
        job = export_service.get_owned_export(request.user, export_id)
        return JsonResponse({"success": True, "export": export_service.serialize_export(job)})
    except export_service.ExportServiceError as exc:
        return _export_error_response(exc)


@authenticated
@require_http_methods(["GET"])
def export_download(request, export_id):
    try:
        job = export_service.get_owned_export(request.user, export_id)
        path = export_service.resolve_export_download(job)
        return FileResponse(
            path.open("rb"),
            as_attachment=True,
            filename=f"personal-notes-{job.id}.zip",
            content_type="application/zip",
        )
    except export_service.ExportServiceError as exc:
        return _export_error_response(exc)
