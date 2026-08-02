from __future__ import annotations

from django.http import FileResponse, JsonResponse
from django.views.decorators.http import require_http_methods
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response

from backend.apps.notes.serializers import JsonBodyError, parse_json_body
from backend.apps.notes.services import attachment_service
from backend.apps.notes.tasks import enqueue_attachment_parse
from backend.apps.notes.views_notes import authenticated


def _payload_error(exc: Exception) -> tuple[dict, int]:
    if isinstance(exc, JsonBodyError):
        return {"success": False, "code": exc.code, "error": str(exc)}, 400
    if isinstance(exc, attachment_service.AttachmentServiceError):
        return {"success": False, "code": exc.code, "error": str(exc)}, exc.status
    raise exc


@api_view(["POST"])
@parser_classes([MultiPartParser])
def attachment_upload(request, note_id):
    if not request.user.is_authenticated:
        return Response({"success": False, "code": "authentication_required", "error": "请先登录"}, status=401)
    upload = request.FILES.get("file")
    if upload is None:
        return Response({"success": False, "code": "attachment_file_required", "error": "请选择附件"}, status=400)
    try:
        attachment = attachment_service.create_file_attachment(request.user, note_id, upload)
        attachment = enqueue_attachment_parse(attachment)
        return Response(
            {"success": True, "attachment": attachment_service.serialize_attachment(attachment)},
            status=201,
        )
    except attachment_service.AttachmentServiceError as exc:
        payload, status = _payload_error(exc)
        return Response(payload, status=status)


@authenticated
@require_http_methods(["POST"])
def attachment_link(request, note_id):
    try:
        attachment = attachment_service.create_link_attachment(request.user, note_id, parse_json_body(request))
        return JsonResponse(
            {"success": True, "attachment": attachment_service.serialize_attachment(attachment)}, status=201
        )
    except (JsonBodyError, attachment_service.AttachmentServiceError) as exc:
        payload, status = _payload_error(exc)
        return JsonResponse(payload, status=status)


@authenticated
@require_http_methods(["GET"])
def attachment_download(request, attachment_id):
    try:
        attachment = attachment_service.get_owned_attachment(request.user, attachment_id)
        if attachment.kind == attachment.Kind.LINK:
            raise attachment_service.AttachmentNotFound()
        path = attachment_service.resolve_relative_path(attachment.relative_path, require_file=True)
        return FileResponse(path.open("rb"), as_attachment=True, filename=attachment.display_name, content_type=attachment.mime_type)
    except attachment_service.AttachmentServiceError as exc:
        payload, status = _payload_error(exc)
        return JsonResponse(payload, status=status)


@authenticated
@require_http_methods(["POST"])
def attachment_reparse(request, attachment_id):
    try:
        attachment = attachment_service.reset_attachment_for_reparse(request.user, attachment_id)
        attachment = enqueue_attachment_parse(attachment)
        return JsonResponse(
            {"success": True, "attachment": attachment_service.serialize_attachment(attachment)}, status=202
        )
    except attachment_service.AttachmentServiceError as exc:
        payload, status = _payload_error(exc)
        return JsonResponse(payload, status=status)


@authenticated
@require_http_methods(["DELETE"])
def attachment_detail(request, attachment_id):
    try:
        attachment_service.soft_delete_attachment(request.user, attachment_id)
        return JsonResponse({"success": True, "deleted": True})
    except attachment_service.AttachmentServiceError as exc:
        payload, status = _payload_error(exc)
        return JsonResponse(payload, status=status)
