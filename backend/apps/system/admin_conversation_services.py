from __future__ import annotations

import json
import re
from typing import Any

from django.db.models import Count, Q

from backend.apps.accounts.client_ip import get_client_ip
from backend.apps.learning.models import CoachingMessage, CoachingSession, CoachingSessionStatus
from backend.apps.system.admin_audit import record_admin_audit


PAGE_SIZES = {20, 50, 100}
_SAFE_SESSION_METADATA = {"traceId", "learningGoal", "goal", "workflow", "source"}
_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_WINDOWS_PATH_RE = re.compile(r"(?i)\b[a-z]:\\[^\s]+")
_UNIX_PATH_RE = re.compile(r"(?<!\w)/(?:srv|var|home|tmp|opt|etc)/[^\s]+")
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie|secret)\s*[:=]\s*\S+"
)
_SENSITIVE_KEY_MARKERS = (
    "password",
    "passwd",
    "token",
    "cookie",
    "secret",
    "authorization",
    "apikey",
    "accesskey",
    "privatekey",
    "credential",
)
_HEADER_SECRET_RE = re.compile(
    r"(?im)^(?P<header>(?:proxy-)?authorization|cookie|set-cookie|(?:x-)?api[_-]?key)\s*:\s*[^\r\n]*"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
_JSON_SECRET_VALUE_RE = re.compile(
    r"(?i)(?P<prefix>[\"'](?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|"
    r"api[_-]?key|x[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)"
    r"[\"']\s*:\s*)(?P<quote>[\"'])(?P<value>.*?)(?P=quote)"
)


def parse_pagination(params) -> tuple[int, int]:
    try:
        page = int(params.get("page", 1))
        page_size = int(params.get("pageSize", 20))
    except (TypeError, ValueError) as exc:
        raise ValueError("分页参数必须是整数") from exc
    if page < 1:
        raise ValueError("页码必须大于等于 1")
    if page_size not in PAGE_SIZES:
        raise ValueError("每页条数仅支持 20、50 或 100")
    return page, page_size


def _redact_unstructured_text(value: Any, *, limit: int) -> str:
    text = str(value or "")[:limit]
    text = _HEADER_SECRET_RE.sub(lambda match: f'{match.group("header")}: [敏感信息已隐藏]', text)
    text = _BEARER_RE.sub("Bearer [敏感信息已隐藏]", text)
    text = _JSON_SECRET_VALUE_RE.sub(
        lambda match: f'{match.group("prefix")}{match.group("quote")}[敏感信息已隐藏]{match.group("quote")}',
        text,
    )
    text = _URL_RE.sub("[链接已隐藏]", text)
    text = _WINDOWS_PATH_RE.sub("[路径已隐藏]", text)
    text = _UNIX_PATH_RE.sub("[路径已隐藏]", text)
    return _SECRET_ASSIGNMENT_RE.sub("[敏感信息已隐藏]", text)


def _redact_structured_content(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _redact_structured_content(item)
            for key, item in value.items()
            if not _is_sensitive_content_key(key)
        }
    if isinstance(value, list):
        return [_redact_structured_content(item) for item in value]
    if isinstance(value, str):
        return _redact_unstructured_text(value, limit=20000)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)


def _is_sensitive_content_key(key: Any) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
    return any(marker in normalized for marker in _SENSITIVE_KEY_MARKERS)


def _safe_text(value: Any, *, limit: int = 500, parse_json: bool = False) -> str:
    text = str(value or "")[:limit]
    if parse_json:
        try:
            structured = json.loads(text)
        except (TypeError, ValueError):
            pass
        else:
            return json.dumps(_redact_structured_content(structured), ensure_ascii=False, separators=(",", ":"))
    return _redact_unstructured_text(text, limit=limit)


def _safe_session_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    result = {}
    for key in _SAFE_SESSION_METADATA:
        value = metadata.get(key)
        if isinstance(value, (str, int, float, bool)) and value not in (None, ""):
            result[key] = _safe_text(value, limit=255) if isinstance(value, str) else value
    return result


def conversation_queryset():
    return (
        CoachingSession.objects.select_related("user", "course", "knowledge_point")
        .annotate(
            message_count=Count("messages"),
            verified_message_count=Count("messages", filter=Q(messages__verified=True)),
            degraded_message_count=Count("messages", filter=Q(messages__degraded=True)),
            safety_blocked_count=Count("messages", filter=Q(messages__safety__blocked=True)),
        )
        .order_by("-updated_at", "-created_at")
    )


def _apply_conversation_filters(queryset, params):
    status = str(params.get("status", "")).strip()
    allowed_statuses = {choice for choice, _ in CoachingSessionStatus.choices}
    if status:
        if status not in allowed_statuses:
            raise ValueError("会话状态无效")
        queryset = queryset.filter(status=status)
    user_id = str(params.get("userId", "")).strip()
    if user_id:
        if not user_id.isdigit():
            raise ValueError("用户编号无效")
        queryset = queryset.filter(user_id=int(user_id))
    search = str(params.get("search", "")).strip()
    if len(search) > 100:
        raise ValueError("搜索内容不能超过 100 个字符")
    if search:
        queryset = queryset.filter(
            Q(topic_title__icontains=search)
            | Q(user__display_name__icontains=search)
            | Q(course__title__icontains=search)
        )
    return queryset


def serialize_conversation(session: CoachingSession) -> dict[str, Any]:
    metadata = _safe_session_metadata(session.metadata)
    return {
        "id": str(session.pk),
        "user": {"id": str(session.user_id), "displayName": session.user.display_name},
        "status": session.status,
        "topicTitle": session.topic_title,
        "course": (
            {"id": str(session.course_id), "code": session.course.code, "title": session.course.title}
            if session.course_id
            else None
        ),
        "knowledgePoint": (
            {"id": str(session.knowledge_point_id), "title": session.knowledge_point.title}
            if session.knowledge_point_id
            else None
        ),
        "traceId": metadata.get("traceId", ""),
        "learningGoal": metadata.get("learningGoal") or metadata.get("goal", ""),
        "workflow": metadata.get("workflow", ""),
        "source": metadata.get("source", ""),
        "messageCount": session.message_count,
        "verifiedMessageCount": session.verified_message_count,
        "degradedMessageCount": session.degraded_message_count,
        "safetyBlockedCount": session.safety_blocked_count,
        "startedAt": session.started_at.isoformat(),
        "endedAt": session.ended_at.isoformat() if session.ended_at else None,
        "updatedAt": session.updated_at.isoformat(),
        "createdAt": session.created_at.isoformat(),
        "bodyAvailable": session.message_count > 0,
    }


def list_conversations(params) -> dict[str, Any]:
    page, page_size = parse_pagination(params)
    queryset = _apply_conversation_filters(conversation_queryset(), params)
    total = queryset.count()
    start = (page - 1) * page_size
    items = [serialize_conversation(session) for session in queryset[start : start + page_size]]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}


def get_conversation(session_id) -> dict[str, Any] | None:
    session = conversation_queryset().filter(pk=session_id).first()
    return serialize_conversation(session) if session else None


def reveal_conversation_messages(*, request, session_id, reason: str, params) -> dict[str, Any] | None:
    page, page_size = parse_pagination(params)
    session = CoachingSession.objects.select_related("user").filter(pk=session_id).first()
    if not session:
        return None
    reason = str(reason or "").strip()
    if not reason:
        raise ValueError("请填写查看会话正文的原因")
    if len(reason) > 255:
        raise ValueError("查看原因不能超过 255 个字符")

    messages = CoachingMessage.objects.filter(session=session).order_by("created_at", "id")
    total = messages.count()
    start = (page - 1) * page_size
    items = [
        {
            "id": str(message.pk),
            "role": message.role,
            "content": _safe_text(message.content, limit=20000, parse_json=True),
            "verified": message.verified,
            "degraded": message.degraded,
            "safetyBlocked": bool(message.safety.get("blocked")) if isinstance(message.safety, dict) else False,
            "createdAt": message.created_at.isoformat(),
        }
        for message in messages[start : start + page_size]
    ]
    record_admin_audit(
        actor=request.user,
        action="conversation.reveal",
        target_user=session.user,
        target_type="coaching_session",
        target_id=str(session.pk),
        summary="管理员查看辅导会话正文",
        reason=reason,
        before={},
        after={"revealed": True},
        metadata={"page": page, "pageSize": page_size, "messageCount": len(items)},
        before_allowlist=(),
        after_allowlist=("revealed",),
        metadata_allowlist=("page", "pageSize", "messageCount"),
        actor_ip=get_client_ip(request) or None,
    )
    return {
        "conversationId": str(session.pk),
        "messages": items,
        "pagination": {"page": page, "pageSize": page_size, "total": total},
    }
