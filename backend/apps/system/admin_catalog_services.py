from __future__ import annotations

import re
from typing import Any

from django.db.models import Count, Q

from backend.apps.knowledge_base.models import KnowledgeResource, ResourceScope, ResourceStatus
from backend.apps.learning.models import Course
from backend.apps.system.admin_conversation_services import parse_pagination


_PATH_OR_URL_RE = re.compile(r"(?i)(?:https?://|\b[a-z]:\\|/(?:srv|var|home|tmp|opt|etc)/)")


def _error_summary(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if _PATH_OR_URL_RE.search(text) or re.search(r"(?i)\b(?:token|cookie|secret|api[_-]?key)\b", text):
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
    known_statuses = {choice for choice, _ in ResourceStatus.choices} | {"ready", "offline"}
    if status:
        if status not in known_statuses:
            raise ValueError("资料状态无效")
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
