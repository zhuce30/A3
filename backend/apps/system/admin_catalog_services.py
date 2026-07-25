from __future__ import annotations

import re
from typing import Any

from django.db import transaction
from django.db.models import Count, Q

from backend.apps.knowledge_base.models import (
    IndexJobStatus,
    KnowledgeIndexJob,
    KnowledgeResource,
    PUBLISHED_RESOURCE_VISIBILITIES,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.knowledge_base.services import create_parse_job, dispatch_index_job
from backend.apps.learning.models import Course
from backend.apps.system.admin_audit import record_admin_audit
from backend.apps.system.admin_conversation_services import parse_pagination


_PATH_OR_URL_RE = re.compile(
    r"(?i)(?:[a-z][a-z0-9+.-]*://|\\\\[^\\\s]+\\|"
    r"(?<!\w)[a-z]:[\\/]|(?<![\w:])/(?!/)[^\s]+)"
)
_TRACEBACK_RE = re.compile(
    r"(?im)(?:traceback\s*\(most recent call last\):|"
    r"^\s*file\s+[\"'][^\"']+[\"'],\s*line\s+\d+|"
    r"^\s*at\s+(?:[\w.$<>]+\s+\()?[^\r\n]*:\d+(?::\d+)?\)?)"
)


class AdminActionError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400, error_code: str = "invalid_request"):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


_REINDEXABLE_RESOURCE_STATUSES = {
    ResourceStatus.FAILED,
    ResourceStatus.INDEXED,
    ResourceStatus.INDEXED_WITH_WARNINGS,
}
_PUBLISHED_VISIBILITY = {
    ResourceScope.PERSONAL: "owner",
    ResourceScope.TEACHER: "shared",
    ResourceScope.CLASS: "class",
    ResourceScope.GLOBAL: "global",
    "course": "course",
}


def _publication_status(visibility: str) -> str:
    if visibility == "offline":
        return "offline"
    if visibility in PUBLISHED_RESOURCE_VISIBILITIES:
        return "published"
    return "owner_only"


def _dispatch_index_job_after_commit(job_id) -> None:
    job = KnowledgeIndexJob.objects.filter(pk=job_id).first()
    if job is not None:
        dispatch_index_job(job)


def _error_summary(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if (
        _PATH_OR_URL_RE.search(text)
        or _TRACEBACK_RE.search(text)
        or re.search(r"(?i)\b(?:token|cookie|secret|api[_-]?key)\b", text)
    ):
        return "处理失败，详细错误已隐藏"
    return text[:200]


def _search_value(params) -> str:
    search = str(params.get("search", "")).strip()
    if len(search) > 100:
        raise ValueError("搜索内容不能超过 100 个字符")
    return search


def list_courses(params) -> dict[str, Any]:
    page, page_size = parse_pagination(params)
    queryset = Course.objects.annotate(
        chapter_count=Count("chapters", distinct=True),
        knowledge_point_count=Count("chapters__knowledge_points", distinct=True),
        teacher_count=Count("teaching_assignments", distinct=True),
        student_count=Count("enrollments", distinct=True),
    ).order_by("code")
    active = str(params.get("active", "")).strip().lower()
    if active:
        if active not in {"true", "false"}:
            raise ValueError("课程启用状态无效")
        queryset = queryset.filter(is_active=active == "true")
    search = _search_value(params)
    if search:
        queryset = queryset.filter(Q(code__icontains=search) | Q(title__icontains=search))
    total = queryset.count()
    start = (page - 1) * page_size
    items = [
        {
            "id": str(course.pk),
            "code": course.code,
            "title": course.title,
            "edition": course.edition,
            "isActive": course.is_active,
            "chapterCount": course.chapter_count,
            "knowledgePointCount": course.knowledge_point_count,
            "teacherCount": course.teacher_count,
            "studentCount": course.student_count,
            "createdAt": course.created_at.isoformat(),
            "updatedAt": course.updated_at.isoformat(),
        }
        for course in queryset[start : start + page_size]
    ]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}


def list_resources(params) -> dict[str, Any]:
    page, page_size = parse_pagination(params)
    queryset = KnowledgeResource.objects.select_related("owner", "index_job").order_by("-created_at", "-id")
    status = str(params.get("status", "")).strip()
    known_statuses = {choice for choice, _ in ResourceStatus.choices} | {"ready", "published", "offline"}
    if status:
        if status not in known_statuses:
            raise ValueError("资料状态无效")
        if status == "ready":
            queryset = queryset.filter(status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS])
        elif status == "published":
            queryset = queryset.filter(visibility__in=PUBLISHED_RESOURCE_VISIBILITIES)
        elif status == "offline":
            queryset = queryset.filter(visibility="offline")
        else:
            queryset = queryset.filter(status=status)
    scope = str(params.get("scope", "")).strip()
    known_scopes = {choice for choice, _ in ResourceScope.choices} | {"course"}
    if scope:
        if scope not in known_scopes:
            raise ValueError("资料范围无效")
        queryset = queryset.filter(resource_scope=scope)
    owner_id = str(params.get("ownerId", "")).strip()
    if owner_id:
        if not owner_id.isdigit():
            raise ValueError("资料所有者编号无效")
        queryset = queryset.filter(owner_id=int(owner_id))
    search = _search_value(params)
    if search:
        queryset = queryset.filter(Q(original_name__icontains=search) | Q(course_key__icontains=search))
    total = queryset.count()
    start = (page - 1) * page_size
    items = []
    for resource in queryset[start : start + page_size]:
        index_job = resource.index_job
        items.append(
            {
                "id": str(resource.pk),
                "name": resource.original_name,
                "fileType": resource.file_type,
                "fileSize": resource.file_size,
                "scope": resource.resource_scope,
                "courseKey": resource.course_key,
                "visibility": resource.visibility,
                "publicationStatus": _publication_status(resource.visibility),
                "status": resource.status,
                "documentCount": resource.document_count,
                "chunkCount": resource.chunk_count,
                "errorSummary": _error_summary(resource.error_message),
                "owner": {"id": str(resource.owner_id), "displayName": resource.owner.display_name},
                "indexJob": (
                    {
                        "id": str(index_job.pk),
                        "type": index_job.job_type,
                        "status": index_job.status,
                        "progress": index_job.progress,
                        "processedFiles": index_job.processed_files,
                        "totalFiles": index_job.total_files,
                        "errorSummary": _error_summary(index_job.error_message),
                        "updatedAt": index_job.updated_at.isoformat(),
                    }
                    if index_job
                    else None
                ),
                "createdAt": resource.created_at.isoformat(),
                "updatedAt": resource.updated_at.isoformat(),
            }
        )
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}


def _catalog_failure_audit(
    *,
    actor,
    action: str,
    target_type: str,
    target_id: Any,
    reason: str,
    error: AdminActionError,
    actor_ip: str | None,
) -> None:
    record_admin_audit(
        actor=actor,
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        summary=str(error),
        reason=reason,
        metadata={"errorCode": error.error_code},
        metadata_allowlist=("errorCode",),
        actor_ip=actor_ip,
        success=False,
    )


def _require_reason(reason: Any) -> str:
    if not isinstance(reason, str) or not reason.strip():
        raise AdminActionError("请填写操作原因", error_code="reason_required")
    normalized = reason.strip()
    if len(normalized) > 255:
        raise AdminActionError("操作原因不能超过 255 个字符", error_code="reason_too_long")
    if _error_summary(normalized) != normalized[:200]:
        raise AdminActionError(
            "操作原因不能包含密钥、链接或本地路径",
            error_code="sensitive_reason",
        )
    return normalized


def _safe_audit_reason(reason: Any) -> str:
    normalized = str(reason or "").strip()[:255]
    if not normalized:
        return ""
    return normalized if _error_summary(normalized) == normalized[:200] else "敏感内容已隐藏"


def set_course_status(
    *,
    actor,
    course_id,
    is_active: Any,
    reason: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    normalized_reason = str(reason or "").strip()[:255]
    try:
        normalized_reason = _require_reason(reason)
        if not isinstance(is_active, bool):
            raise AdminActionError("课程状态必须是布尔值", error_code="invalid_status")
        with transaction.atomic():
            course = Course.objects.select_for_update().filter(pk=course_id).first()
            if course is None:
                raise AdminActionError("课程不存在", status_code=404, error_code="not_found")
            if course.is_active == is_active:
                raise AdminActionError("课程已处于目标状态", status_code=409, error_code="invalid_transition")
            before = {"isActive": course.is_active}
            course.is_active = is_active
            course.save(update_fields=["is_active", "updated_at"])
            record_admin_audit(
                actor=actor,
                action="course.activate" if is_active else "course.deactivate",
                target_type="course",
                target_id=course.pk,
                summary="启用课程" if is_active else "下线课程",
                reason=normalized_reason,
                before=before,
                after={"isActive": is_active},
                before_allowlist=("isActive",),
                after_allowlist=("isActive",),
                actor_ip=actor_ip,
            )
        return {"course": {"id": str(course.pk), "isActive": course.is_active}}
    except AdminActionError as exc:
        _catalog_failure_audit(
            actor=actor,
            action="course.status",
            target_type="course",
            target_id=course_id,
            reason=_safe_audit_reason(normalized_reason),
            error=exc,
            actor_ip=actor_ip,
        )
        raise
    except Exception as exc:
        error = AdminActionError("课程状态更新失败，请稍后重试", status_code=500, error_code="operation_failed")
        _catalog_failure_audit(
            actor=actor,
            action="course.status",
            target_type="course",
            target_id=course_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error from exc


def set_resource_status(
    *,
    actor,
    resource_id,
    status: Any,
    reason: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    normalized_reason = str(reason or "").strip()[:255]
    try:
        normalized_reason = _require_reason(reason)
        if status not in {"published", "offline"}:
            raise AdminActionError("资料状态仅支持 published 或 offline", error_code="invalid_status")
        with transaction.atomic():
            resource = KnowledgeResource.objects.select_for_update().filter(pk=resource_id).first()
            if resource is None:
                raise AdminActionError("资料不存在", status_code=404, error_code="not_found")
            if status == "published" and resource.status not in {
                ResourceStatus.INDEXED,
                ResourceStatus.INDEXED_WITH_WARNINGS,
            }:
                raise AdminActionError("只有已完成索引的资料可以发布", status_code=409, error_code="invalid_transition")
            visibility = (
                _PUBLISHED_VISIBILITY.get(resource.resource_scope, "shared")
                if status == "published"
                else "offline"
            )
            if resource.visibility == visibility:
                raise AdminActionError("资料已处于目标状态", status_code=409, error_code="invalid_transition")
            before = {
                "visibility": resource.visibility,
                "publicationStatus": _publication_status(resource.visibility),
            }
            resource.visibility = visibility
            resource.save(update_fields=["visibility", "updated_at"])
            record_admin_audit(
                actor=actor,
                action="resource.publish" if status == "published" else "resource.offline",
                target_type="knowledge_resource",
                target_id=resource.pk,
                summary="发布知识资料" if status == "published" else "下线知识资料",
                reason=normalized_reason,
                before=before,
                after={"visibility": visibility, "publicationStatus": _publication_status(visibility)},
                before_allowlist=("visibility", "publicationStatus"),
                after_allowlist=("visibility", "publicationStatus"),
                actor_ip=actor_ip,
            )
        return {
            "resource": {
                "id": str(resource.pk),
                "visibility": resource.visibility,
                "publicationStatus": _publication_status(resource.visibility),
                "status": resource.status,
            }
        }
    except AdminActionError as exc:
        _catalog_failure_audit(
            actor=actor,
            action="resource.status",
            target_type="knowledge_resource",
            target_id=resource_id,
            reason=_safe_audit_reason(normalized_reason),
            error=exc,
            actor_ip=actor_ip,
        )
        raise
    except Exception as exc:
        error = AdminActionError("资料状态更新失败，请稍后重试", status_code=500, error_code="operation_failed")
        _catalog_failure_audit(
            actor=actor,
            action="resource.status",
            target_type="knowledge_resource",
            target_id=resource_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error from exc


def reindex_resource(
    *,
    actor,
    resource_id,
    reason: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    normalized_reason = str(reason or "").strip()[:255]
    try:
        normalized_reason = _require_reason(reason)
        with transaction.atomic():
            resource = KnowledgeResource.objects.select_for_update().filter(pk=resource_id).first()
            if resource is None:
                raise AdminActionError("资料不存在", status_code=404, error_code="not_found")
            if resource.status not in _REINDEXABLE_RESOURCE_STATUSES:
                raise AdminActionError("只有失败或已完成的资料可以重建索引", status_code=409, error_code="invalid_transition")
            before = {"status": resource.status, "indexJobId": str(resource.index_job_id or "")}
            try:
                job = create_parse_job(resource.owner, [resource], dispatch=False)
            except ValueError as exc:
                raise AdminActionError(str(exc), status_code=409, error_code="dispatch_rejected") from exc
            if job.status == IndexJobStatus.FAILED:
                raise AdminActionError("索引任务调度失败，请稍后重试", status_code=503, error_code="dispatch_failed")
            record_admin_audit(
                actor=actor,
                action="resource.reindex",
                target_type="knowledge_resource",
                target_id=resource.pk,
                summary="重建知识资料索引",
                reason=normalized_reason,
                before=before,
                after={"status": ResourceStatus.INDEXING, "indexJobId": str(job.pk)},
                before_allowlist=("status", "indexJobId"),
                after_allowlist=("status", "indexJobId"),
                actor_ip=actor_ip,
            )
            transaction.on_commit(lambda job_id=job.pk: _dispatch_index_job_after_commit(job_id))
        return {
            "resource": {"id": str(resource.pk), "status": ResourceStatus.INDEXING},
            "job": {"id": str(job.pk), "kind": "knowledge_index", "status": job.status},
        }
    except AdminActionError as exc:
        _catalog_failure_audit(
            actor=actor,
            action="resource.reindex",
            target_type="knowledge_resource",
            target_id=resource_id,
            reason=_safe_audit_reason(normalized_reason),
            error=exc,
            actor_ip=actor_ip,
        )
        raise
    except Exception as exc:
        error = AdminActionError("索引任务创建失败，请稍后重试", status_code=500, error_code="operation_failed")
        _catalog_failure_audit(
            actor=actor,
            action="resource.reindex",
            target_type="knowledge_resource",
            target_id=resource_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error from exc
