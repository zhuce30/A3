from __future__ import annotations

from pathlib import Path

from django.http import FileResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods

from backend.apps.accounts.permissions import require_authenticated, require_teacher_role
from backend.apps.knowledge_base.display import format_source_display_location, format_source_type_label, source_origin_label
from backend.apps.knowledge_base.models import (
    IndexJobStatus,
    KnowledgeAsset,
    KnowledgeBlock,
    KnowledgeIndexJob,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.knowledge_base.services import (
    accessible_resources_for_user,
    create_parse_job,
    create_rebuild_job,
    create_upload_index_job,
    delete_resource,
    indexed_resource_scope_by_path,
    knowledge_base_stats,
    retry_index_job,
    resource_scope_label,
    save_upload,
    serialize_index_job,
    serialize_resource_parse_detail,
    serialize_resource,
)
from backend.apps.knowledge_base.graph_builder import serialize_material_graph
from backend.domains.knowledge_base.retriever import search_knowledge_base


@require_http_methods(["GET"])
def resources(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    queryset = accessible_resources_for_user(request.user)
    scope = str(request.GET.get("scope", "")).strip()
    if scope:
        queryset = queryset.filter(resource_scope=scope)
    query = str(request.GET.get("q", "")).strip()
    if query:
        queryset = queryset.filter(original_name__icontains=query)
    return JsonResponse({
        "success": True,
        "resources": [serialize_resource(resource) for resource in queryset],
        "stats": knowledge_base_stats(request.user),
    })


@require_http_methods(["GET"])
def material_graph(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        graph = serialize_material_graph(request.user, request.GET)
        return JsonResponse({"success": True, "graph": graph})
    except Exception:
        return JsonResponse({"success": False, "error": "资料知识图谱读取失败，请稍后重试"}, status=500)


@require_http_methods(["POST"])
def upload(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    files = request.FILES.getlist("files")
    if not files:
        return JsonResponse({"success": False, "error": "请选择需要上传的文件"}, status=400)

    resource_scope = _upload_scope_for_user(request)
    if isinstance(resource_scope, JsonResponse):
        return resource_scope
    uploaded = []
    errors = []
    for file in files:
        try:
            uploaded.append(
                save_upload(
                    request.user,
                    file,
                    resource_scope=resource_scope,
                    course_key=str(request.POST.get("courseKey", "")).strip(),
                    visibility="owner" if resource_scope == ResourceScope.PERSONAL else "shared",
                )
            )
        except ValueError as exc:
            errors.append({"name": file.name, "error": str(exc)})
    job = create_upload_index_job(request.user, uploaded) if uploaded else None
    if uploaded:
        uploaded = list(KnowledgeResource.objects.filter(id__in=[resource.id for resource in uploaded]).order_by("created_at"))
    return JsonResponse({
        "success": bool(uploaded),
        "resources": [serialize_resource(resource) for resource in uploaded],
        "errors": errors,
        "job": serialize_index_job(job) if job else None,
        "stats": knowledge_base_stats(request.user),
    }, status=202 if uploaded else 400)


@require_http_methods(["DELETE"])
def resource_detail(request, resource_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    resource = get_object_or_404(KnowledgeResource, id=resource_id, owner=request.user)
    if resource.status == ResourceStatus.INDEXING or (
        resource.index_job
        and resource.index_job.status in [IndexJobStatus.QUEUED, IndexJobStatus.RUNNING]
    ):
        return JsonResponse({"success": False, "error": "资源正在索引，暂时不能删除"}, status=409)
    delete_resource(resource)
    return JsonResponse({"success": True, "deleted": str(resource_id)})


@require_http_methods(["GET"])
def download(request, resource_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    resource = get_object_or_404(accessible_resources_for_user(request.user), id=resource_id)
    path = Path(resource.stored_path)
    if not path.exists():
        return JsonResponse({"success": False, "error": "文件不存在"}, status=404)
    inline = str(request.GET.get("disposition", "")).strip().lower() == "inline"
    return FileResponse(path.open("rb"), as_attachment=not inline, filename=resource.original_name)


@require_http_methods(["GET"])
def resource_parse_detail(request, resource_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    resource = get_object_or_404(accessible_resources_for_user(request.user), id=resource_id)
    return JsonResponse(serialize_resource_parse_detail(resource))


@require_http_methods(["POST"])
def resource_reparse(request, resource_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    resource = get_object_or_404(_reparseable_resources_for_user(request.user), id=resource_id)
    try:
        job = create_parse_job(request.user, [resource])
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    resource.refresh_from_db()
    return JsonResponse({
        "success": True,
        "job": serialize_index_job(job),
        "resource": serialize_resource(resource),
    }, status=202)


@require_http_methods(["POST"])
def force_reparse_resources(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    resources = list(_reparseable_resources_for_user(request.user).order_by("created_at"))
    try:
        job = create_parse_job(request.user, resources)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    return JsonResponse({
        "success": True,
        "job": serialize_index_job(job),
        "resources": [serialize_resource(resource) for resource in resources],
        "stats": knowledge_base_stats(request.user),
    }, status=202)


@require_http_methods(["GET"])
def asset_preview(request, asset_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    asset_queryset = KnowledgeAsset.objects.select_related("resource")
    asset_queryset = asset_queryset.filter(resource__in=accessible_resources_for_user(request.user))
    asset = get_object_or_404(asset_queryset, id=asset_id)
    path = Path(asset.storage_path)
    if not path.exists() or not path.is_file():
        return JsonResponse({"success": False, "error": "资源预览文件不存在"}, status=404)
    return FileResponse(path.open("rb"), content_type=asset.mime_type or "application/octet-stream")


@require_http_methods(["GET"])
def search(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    query = str(request.GET.get("q", "")).strip()
    if not query:
        return JsonResponse({"success": False, "error": "查询内容不能为空"}, status=400)
    try:
        top_k = max(1, min(int(request.GET.get("top_k", "5")), 20))
        source_scope_by_path = indexed_resource_scope_by_path(request.user)
        allowed_paths = set(source_scope_by_path)
        course = str(request.GET.get("course", "")).strip() or None
        fast = str(request.GET.get("fast", "")).lower() in {"1", "true", "yes", "on"}
        if not allowed_paths:
            return JsonResponse({
                "success": True,
                "query": query,
                "topK": top_k,
                "course": course,
                "results": [],
            })
        results = search_knowledge_base(
            query=query,
            top_k=top_k,
            allowed_source_paths=allowed_paths,
            source_scope_by_path=source_scope_by_path,
            course=course,
            force_lexical=fast,
            visual_use_embedding=not fast,
        )
        include_assets = str(request.GET.get("include_assets", "")).lower() in {"1", "true", "yes", "on"}
        resource_rows = list(
            _searchable_resources_for_user(request.user)
        )
        resources_by_path = {str(Path(resource.stored_path).resolve()): resource for resource in resource_rows if resource.stored_path}
        response_results = []
        for item in results:
            payload = item.model_dump()
            metadata = dict(payload.get("metadata") or {})
            source_path = str(metadata.get("source_path", ""))
            resolved_source_path = str(Path(source_path).resolve()) if source_path else ""
            resource = resources_by_path.get(resolved_source_path)
            if resource:
                metadata["original_name"] = resource.original_name
                metadata["source_scope"] = metadata.get("source_scope") or resource.resource_scope
            metadata["display_location"] = format_source_display_location(metadata)
            metadata["source_type_label"] = format_source_type_label(metadata)
            metadata["source_origin"] = resource_scope_label(metadata["source_scope"]) if metadata.get("source_scope") else source_origin_label(metadata)
            payload["metadata"] = metadata
            if resource:
                _attach_multimodal_evidence(payload, resource, include_assets=include_assets)
            response_results.append(payload)
        return JsonResponse({
            "success": True,
            "query": query,
            "topK": top_k,
            "course": course,
            "results": response_results,
        })
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=500)


def _is_teacher_or_admin(user) -> bool:
    return getattr(user, "role", "") in {"teacher", "admin"}


def _reparseable_resources_for_user(user):
    if _is_teacher_or_admin(user):
        return accessible_resources_for_user(user).exclude(resource_scope=ResourceScope.PERSONAL)
    return KnowledgeResource.objects.filter(owner=user, resource_scope=ResourceScope.PERSONAL)


def _searchable_resources_for_user(user):
    return accessible_resources_for_user(user).filter(status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS])


def _all_indexed_resource_paths() -> set[str]:
    return {
        str(Path(path).resolve())
        for path in KnowledgeResource.objects.filter(
            status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS],
        ).values_list("stored_path", flat=True)
        if path
    }


def _upload_scope_for_user(request):
    if _is_teacher_or_admin(request.user):
        raw_scope = str(request.POST.get("scope", ResourceScope.TEACHER)).strip() or ResourceScope.TEACHER
        if raw_scope not in {ResourceScope.TEACHER, ResourceScope.CLASS, ResourceScope.GLOBAL}:
            return JsonResponse({"success": False, "error": "教师只能上传教师资料、班级资料或全局资料"}, status=400)
        return raw_scope
    raw_scope = str(request.POST.get("scope", ResourceScope.PERSONAL)).strip() or ResourceScope.PERSONAL
    if raw_scope != ResourceScope.PERSONAL:
        return JsonResponse({"success": False, "error": "学生只能上传到我的资料"}, status=403)
    return ResourceScope.PERSONAL


def _attach_multimodal_evidence(payload: dict, resource: KnowledgeResource, *, include_assets: bool) -> None:
    block = _find_result_block(resource, str(payload.get("text") or ""), dict(payload.get("metadata") or {}))
    if not block:
        return
    page = block.page
    asset = block.asset
    if include_assets and not asset and page:
        asset = page.assets.order_by("created_at").first()
    payload["resourceId"] = str(resource.id)
    payload["resourceName"] = resource.original_name
    payload["blockId"] = str(block.id)
    payload["pageId"] = str(page.id) if page else None
    payload["modality"] = block.modality
    payload["location"] = {
        "page": page.page_number if page else None,
        "slide": page.slide_number if page else None,
        "bbox": block.bbox or [],
    }
    payload["confidence"] = block.confidence
    payload["warnings"] = block.warnings
    block_metadata = block.metadata if isinstance(block.metadata, dict) else {}
    payload["markdownSnippet"] = str(block_metadata.get("markdownText") or payload.get("text") or block.text or "")
    payload["contentFormat"] = str(block_metadata.get("contentFormat") or "plain")
    payload["formatFeatures"] = list(block_metadata.get("formatFeatures") or [])
    payload["asset"] = _serialize_search_asset(asset) if include_assets and asset else None
    payload["previewUrl"] = payload["asset"]["previewUrl"] if payload.get("asset") else ""


def _find_result_block(resource: KnowledgeResource, text: str, metadata: dict) -> KnowledgeBlock | None:
    block_id = str(metadata.get("block_id") or metadata.get("blockId") or "").strip()
    blocks = KnowledgeBlock.objects.filter(resource=resource).select_related("page", "asset")
    if block_id:
        block = blocks.filter(id=block_id).first()
        if block:
            return block
    query_text = text.strip()
    ordered_blocks = sorted(
        blocks,
        key=lambda block: 0 if block.modality in {"text", "table", "formula"} else 1,
    )
    if query_text:
        for block in ordered_blocks:
            block_text = (block.text or "").strip()
            if block_text and (block_text in query_text or query_text in block_text):
                return block
    return ordered_blocks[0] if ordered_blocks else None


def _serialize_search_asset(asset: KnowledgeAsset | None) -> dict | None:
    if not asset:
        return None
    return {
        "assetId": str(asset.id),
        "kind": asset.kind,
        "mimeType": asset.mime_type,
        "width": asset.width,
        "height": asset.height,
        "previewUrl": f"/api/kb/assets/{asset.id}/preview/",
    }


@require_http_methods(["GET"])
def jobs(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    queryset = KnowledgeIndexJob.objects.filter(owner=request.user)[:20]
    return JsonResponse({"success": True, "jobs": [serialize_index_job(job) for job in queryset]})


@require_http_methods(["GET"])
def job_detail(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(KnowledgeIndexJob, id=job_id, owner=request.user)
    return JsonResponse({"success": True, "job": serialize_index_job(job)})


@require_http_methods(["POST"])
def retry_job(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(KnowledgeIndexJob, id=job_id, owner=request.user)
    try:
        return JsonResponse({"success": True, "job": serialize_index_job(retry_index_job(job))}, status=202)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=409)


@require_http_methods(["POST"])
def rebuild(request):
    rejected = require_teacher_role(request)
    if rejected:
        return rejected
    try:
        job = create_rebuild_job(request.user)
        return JsonResponse({"success": True, "job": serialize_index_job(job)}, status=202)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=409)
