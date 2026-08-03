from __future__ import annotations

import json
import math
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Iterable

import jieba
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from backend.apps.compat.llm import chat_completion
from backend.apps.notes.models import (
    Note,
    NoteAiMessage,
    NoteAiSession,
    NoteAuditEvent,
    NoteDailyDigest,
    NoteMemory,
    NoteRevision,
)


MAX_CANDIDATES_PER_EXTRACTION = 8
MAX_MEMORY_CONTENT_CHARACTERS = 500
MAX_MEMORY_REASON_CHARACTERS = 500
MAX_SOURCE_MESSAGES = 20
MAX_SOURCE_NOTES = 20
MAX_CORE_MEMORIES = 8
MAX_EPISODIC_MEMORIES = 6
MAX_CORE_CHARACTERS = 1_600
MAX_CONTEXT_CHARACTERS = 4_000
EPISODIC_MAX_AGE_DAYS = 180
_ACTIVE_STATUSES = {
    NoteMemory.Status.CANDIDATE,
    NoteMemory.Status.CONFIRMED,
    NoteMemory.Status.PAUSED,
}
_CANDIDATE_KEYS = {
    "memoryType",
    "content",
    "importance",
    "confidence",
    "sourceMessageIds",
    "sourceNoteRefs",
    "reason",
    "validFrom",
    "validUntil",
}
_REQUIRED_CANDIDATE_KEYS = _CANDIDATE_KEYS - {"validFrom", "validUntil"}
_ASCII_TERM_RE = re.compile(r"[A-Za-z0-9_]+")
_VALID_TERM_RE = re.compile(r"(?:[A-Za-z0-9_]+|[\u4e00-\u9fff]+)\Z")


class MemoryServiceError(ValueError):
    def __init__(self, message: str, *, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class MemoryContext:
    text: str
    memories: list[NoteMemory]
    sources: list[dict[str, Any]]

    @property
    def memory_ids(self) -> list[str]:
        return [str(item.id) for item in self.memories]


def _normalize_content(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().casefold().split())


def _parse_uuid(value: Any, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise MemoryServiceError(f"{field} 包含无效编号", code="invalid_memory_candidate") from exc


def _parse_bounded_text(value: Any, *, field: str, maximum: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise MemoryServiceError(f"{field} 必须是文本", code="invalid_memory_candidate")
    normalized = unicodedata.normalize("NFKC", value).strip()
    if (not normalized and not allow_empty) or len(normalized) > maximum:
        raise MemoryServiceError(f"{field} 长度不正确", code="invalid_memory_candidate")
    return normalized


def _parse_score(value: Any, *, field: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool):
        raise MemoryServiceError(f"{field} 必须是数字", code="invalid_memory_candidate")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise MemoryServiceError(f"{field} 必须是数字", code="invalid_memory_candidate") from exc
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise MemoryServiceError(f"{field} 超出允许范围", code="invalid_memory_candidate")
    return number


def _parse_optional_datetime(value: Any, *, field: str):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise MemoryServiceError(f"{field} 必须是 ISO 时间", code="invalid_memory_candidate")
    parsed = parse_datetime(value)
    if parsed is None:
        raise MemoryServiceError(f"{field} 必须是 ISO 时间", code="invalid_memory_candidate")
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _validate_note_refs(user, raw_refs: Any, allowed_note_refs: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(raw_refs, list) or len(raw_refs) > MAX_SOURCE_NOTES:
        raise MemoryServiceError("sourceNoteRefs 必须是有界数组", code="invalid_memory_candidate")
    allowed = {
        (str(item.get("id")), int(item.get("version")))
        for item in allowed_note_refs
        if isinstance(item, dict) and item.get("id") and item.get("version")
    }
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for item in raw_refs:
        if not isinstance(item, dict) or set(item) != {"id", "version"}:
            raise MemoryServiceError("sourceNoteRefs 格式无效", code="invalid_memory_candidate")
        note_id = _parse_uuid(item.get("id"), field="sourceNoteRefs.id")
        try:
            version = int(item.get("version"))
        except (TypeError, ValueError) as exc:
            raise MemoryServiceError("sourceNoteRefs.version 无效", code="invalid_memory_candidate") from exc
        pair = (str(note_id), version)
        if version < 1 or pair not in allowed or pair in seen:
            raise MemoryServiceError("sourceNoteRefs 不属于当前来源快照", code="invalid_memory_candidate")
        note = Note.objects.filter(user=user, id=note_id).first()
        if note is None or (
            note.version != version
            and not NoteRevision.objects.filter(note=note, version=version).exists()
        ):
            raise MemoryServiceError("sourceNoteRefs 引用的版本不可用", code="invalid_memory_candidate")
        seen.add(pair)
        normalized.append({"id": pair[0], "version": version})
    return normalized


def _validate_message_ids(
    user,
    raw_ids: Any,
    source_session: NoteAiSession | None,
    allowed_message_ids: Iterable[Any] | None,
) -> list[str]:
    if not isinstance(raw_ids, list) or len(raw_ids) > MAX_SOURCE_MESSAGES:
        raise MemoryServiceError("sourceMessageIds 必须是有界数组", code="invalid_memory_candidate")
    ids = [_parse_uuid(item, field="sourceMessageIds") for item in raw_ids]
    if len(ids) != len(set(ids)):
        raise MemoryServiceError("sourceMessageIds 不能重复", code="invalid_memory_candidate")
    if not ids:
        return []
    if source_session is None:
        raise MemoryServiceError("当前来源不允许消息引用", code="invalid_memory_candidate")
    owned = set(
        NoteAiMessage.objects.filter(
            id__in=ids,
            session=source_session,
            session__user=user,
        ).values_list("id", flat=True)
    )
    if owned != set(ids):
        raise MemoryServiceError("sourceMessageIds 不属于当前用户会话", code="invalid_memory_candidate")
    if allowed_message_ids is not None:
        allowed = {str(item) for item in allowed_message_ids}
        if any(str(item) not in allowed for item in ids):
            raise MemoryServiceError("sourceMessageIds 不属于当前来源快照", code="invalid_memory_candidate")
    return [str(item) for item in ids]


def _validate_candidate(
    *,
    user,
    raw: Any,
    source_session: NoteAiSession | None,
    allowed_note_refs: Iterable[dict[str, Any]],
    allowed_message_ids: Iterable[Any] | None,
) -> dict[str, Any]:
    if not isinstance(raw, dict) or not _REQUIRED_CANDIDATE_KEYS.issubset(raw) or set(raw) - _CANDIDATE_KEYS:
        raise MemoryServiceError("记忆候选字段不符合约定", code="invalid_memory_candidate")
    memory_type = str(raw.get("memoryType") or "")
    if memory_type not in {NoteMemory.MemoryType.CORE, NoteMemory.MemoryType.EPISODIC}:
        raise MemoryServiceError("memoryType 不受支持", code="invalid_memory_candidate")
    valid_from = _parse_optional_datetime(raw.get("validFrom"), field="validFrom") or timezone.now()
    valid_until = _parse_optional_datetime(raw.get("validUntil"), field="validUntil")
    if valid_until is not None and valid_until <= valid_from:
        raise MemoryServiceError("记忆有效期不正确", code="invalid_memory_candidate")
    return {
        "memory_type": memory_type,
        "content": _parse_bounded_text(
            raw.get("content"), field="content", maximum=MAX_MEMORY_CONTENT_CHARACTERS
        ),
        "importance": _parse_score(raw.get("importance"), field="importance", minimum=0, maximum=5),
        "confidence": _parse_score(raw.get("confidence"), field="confidence", minimum=0, maximum=1),
        "source_message_ids": _validate_message_ids(
            user,
            raw.get("sourceMessageIds"),
            source_session,
            allowed_message_ids,
        ),
        "source_note_refs": _validate_note_refs(user, raw.get("sourceNoteRefs"), allowed_note_refs),
        "reason": _parse_bounded_text(
            raw.get("reason"), field="reason", maximum=MAX_MEMORY_REASON_CHARACTERS
        ),
        "valid_from": valid_from,
        "valid_until": valid_until,
    }


def create_candidates_from_model_payload(
    *,
    user,
    payload: Any,
    source_session: NoteAiSession | None = None,
    source_message: NoteAiMessage | None = None,
    allowed_note_refs: Iterable[dict[str, Any]] = (),
    allowed_message_ids: Iterable[Any] | None = None,
) -> list[NoteMemory]:
    if not isinstance(payload, dict) or set(payload) != {"candidates"}:
        raise MemoryServiceError("记忆候选响应格式无效", code="invalid_memory_candidate")
    raw_candidates = payload.get("candidates")
    if not isinstance(raw_candidates, list) or len(raw_candidates) > MAX_CANDIDATES_PER_EXTRACTION:
        raise MemoryServiceError("记忆候选数量超出限制", code="invalid_memory_candidate")
    if source_session is not None and source_session.user_id != user.id:
        raise MemoryServiceError("来源会话不属于当前用户", code="memory_source_forbidden", status=403)
    if source_message is not None and (
        source_message.session.user_id != user.id
        or (source_session is not None and source_message.session_id != source_session.id)
    ):
        raise MemoryServiceError("来源消息不属于当前用户", code="memory_source_forbidden", status=403)
    validated = [
        _validate_candidate(
            user=user,
            raw=item,
            source_session=source_session,
            allowed_note_refs=allowed_note_refs,
            allowed_message_ids=allowed_message_ids,
        )
        for item in raw_candidates
    ]
    created: list[NoteMemory] = []
    with transaction.atomic():
        type(user).objects.select_for_update().get(pk=user.pk)
        active = list(NoteMemory.objects.filter(user=user, status__in=_ACTIVE_STATUSES))
        by_content = {_normalize_content(item.content): item for item in active}
        for candidate in validated:
            key = _normalize_content(candidate["content"])
            existing = by_content.get(key)
            if existing is not None:
                created.append(existing)
                continue
            memory = NoteMemory.objects.create(
                user=user,
                status=NoteMemory.Status.CANDIDATE,
                source_session=source_session,
                source_message=source_message,
                **candidate,
            )
            NoteAuditEvent.objects.create(
                user=user,
                action="note.memory_candidate_created",
                object_type="note_memory",
                object_id=memory.id,
                metadata={
                    "actorId": str(user.id),
                    "memoryId": str(memory.id),
                    "nextStatus": NoteMemory.Status.CANDIDATE,
                    "noteIds": [item["id"] for item in memory.source_note_refs],
                },
            )
            by_content[key] = memory
            created.append(memory)
    return created


def _safe_json_content(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise MemoryServiceError("记忆候选模型返回了无效 JSON", code="invalid_memory_candidate") from exc
    if not isinstance(value, dict):
        raise MemoryServiceError("记忆候选模型返回格式无效", code="invalid_memory_candidate")
    return value


def extract_candidates_for_assistant_message(message_id) -> list[NoteMemory]:
    message = NoteAiMessage.objects.select_related("session", "session__user").filter(
        id=message_id,
        role=NoteAiMessage.Role.ASSISTANT,
        status=NoteAiMessage.Status.SUCCEEDED,
    ).first()
    if message is None:
        return []
    messages = list(
        NoteAiMessage.objects.filter(session=message.session, created_at__lte=message.created_at)
        .order_by("created_at")
        .values("id", "role", "content")
    )[-12:]
    allowed_note_refs = message.session.scope_snapshot.get("notes", [])
    try:
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "你是个人笔记记忆候选抽取器。只提取用户明确表达、跨会话仍有帮助的偏好、长期目标或重要经历。"
                        "不得推断，不得自动确认，不得读取课堂或画像。仅输出 JSON 对象 {\"candidates\": [...]}。"
                        "每项只能包含 memoryType、content、importance、confidence、sourceMessageIds、sourceNoteRefs、reason，"
                        "以及可选 validFrom、validUntil。没有可靠候选时返回空数组。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "messages": [
                                {"id": str(item["id"]), "role": item["role"], "content": item["content"]}
                                for item in messages
                            ],
                            "allowedNoteRefs": allowed_note_refs,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0,
            max_tokens=900,
            response_format={"type": "json_object"},
        )
        return create_candidates_from_model_payload(
            user=message.session.user,
            payload=_safe_json_content(result.get("content") or ""),
            source_session=message.session,
            source_message=message,
            allowed_note_refs=allowed_note_refs,
            allowed_message_ids=[item["id"] for item in messages],
        )
    except Exception:
        return []


def extract_candidates_for_digest(digest_id) -> list[NoteMemory]:
    digest = NoteDailyDigest.objects.select_related("user").filter(
        id=digest_id,
        status=NoteDailyDigest.Status.SUCCEEDED,
    ).first()
    if digest is None:
        return []
    allowed_note_refs = [
        {"id": item.get("id"), "version": item.get("version")}
        for item in digest.source_snapshot.get("notes", [])
        if isinstance(item, dict)
    ]
    try:
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "你是个人笔记每日总结的记忆候选抽取器。只提取用户笔记中明确、长期有用的信息，绝不自动确认。"
                        "仅输出 JSON 对象 {\"candidates\": [...]}，字段约定与个人笔记记忆候选一致；"
                        "sourceMessageIds 必须为空，没有可靠候选时返回空数组。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "digest": digest.content_md,
                            "allowedNoteRefs": allowed_note_refs,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0,
            max_tokens=900,
            response_format={"type": "json_object"},
        )
        return create_candidates_from_model_payload(
            user=digest.user,
            payload=_safe_json_content(result.get("content") or ""),
            allowed_note_refs=allowed_note_refs,
        )
    except Exception:
        return []


def _tokens(value: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", value or "").strip().casefold()
    tokens = {
        item.strip()
        for item in jieba.lcut(normalized)
        if item.strip() and _VALID_TERM_RE.fullmatch(item.strip())
    }
    tokens.update(_ASCII_TERM_RE.findall(normalized))
    return tokens


def _score(memory: NoteMemory, query_terms: set[str], now) -> float:
    memory_terms = _tokens(memory.content)
    union = query_terms | memory_terms
    relevance = len(query_terms & memory_terms) / len(union) if union else 0.0
    age_days = max(0.0, (now - memory.updated_at).total_seconds() / 86_400)
    recency = math.exp(-age_days / 30)
    importance = min(5.0, max(0.0, float(memory.importance))) / 5
    return 0.45 * relevance + 0.30 * recency + 0.25 * importance


def select_memories(*, user, query: str, scope_note_ids: Iterable[Any], now=None) -> list[NoteMemory]:
    current = now or timezone.now()
    scope_ids = {str(item) for item in scope_note_ids}
    queryset = NoteMemory.objects.filter(
        user=user,
        status=NoteMemory.Status.CONFIRMED,
        confirmed_at__isnull=False,
        deleted_at__isnull=True,
        valid_from__lte=current,
    ).filter(Q(valid_until__isnull=True) | Q(valid_until__gt=current))
    recent_cutoff = current - timedelta(days=EPISODIC_MAX_AGE_DAYS)
    core: list[NoteMemory] = []
    episodic: list[NoteMemory] = []
    for memory in queryset:
        if memory.memory_type == NoteMemory.MemoryType.CORE:
            core.append(memory)
            continue
        source_ids = {
            str(item.get("id"))
            for item in memory.source_note_refs
            if isinstance(item, dict) and item.get("id")
        }
        if memory.created_at >= recent_cutoff and scope_ids and source_ids & scope_ids:
            episodic.append(memory)
    query_terms = _tokens(query)
    ordering = lambda item: (_score(item, query_terms, current), item.updated_at, str(item.id))
    core.sort(key=ordering, reverse=True)
    episodic.sort(key=ordering, reverse=True)

    selected: list[NoteMemory] = []
    core_characters = 0
    total_characters = 0
    for memory in core:
        if len(selected) >= MAX_CORE_MEMORIES:
            break
        size = len(memory.content)
        if core_characters + size > MAX_CORE_CHARACTERS or total_characters + size > MAX_CONTEXT_CHARACTERS:
            continue
        selected.append(memory)
        core_characters += size
        total_characters += size
    episodic_count = 0
    for memory in episodic:
        if episodic_count >= MAX_EPISODIC_MEMORIES:
            break
        size = len(memory.content)
        if total_characters + size > MAX_CONTEXT_CHARACTERS:
            continue
        selected.append(memory)
        episodic_count += 1
        total_characters += size
    return selected


def build_memory_context(*, user, query: str, scope_note_ids: Iterable[Any]) -> MemoryContext:
    ranked = select_memories(user=user, query=query, scope_note_ids=scope_note_ids)
    memories: list[NoteMemory] = []
    lines: list[str] = []
    used = 0
    for memory in ranked:
        line = f"[已确认记忆 {len(memories) + 1}] {memory.content}"
        separator = 1 if lines else 0
        if used + separator + len(line) > MAX_CONTEXT_CHARACTERS:
            continue
        memories.append(memory)
        lines.append(line)
        used += separator + len(line)
    sources = [
        {
            "sourceKind": "personal_memory",
            "memoryId": str(memory.id),
            "title": "已确认个人记忆",
            "location": "个人笔记记忆",
            "snippet": memory.content,
            "status": memory.status,
            "memoryType": memory.memory_type,
            "sourceNoteRefs": memory.source_note_refs,
        }
        for memory in memories
    ]
    text = "\n".join(lines)
    return MemoryContext(text=text, memories=memories, sources=sources)


def _owned_for_update(user, memory_id) -> NoteMemory:
    memory = NoteMemory.objects.select_for_update().filter(user=user, id=memory_id).first()
    if memory is None:
        raise MemoryServiceError("记忆不存在", code="memory_not_found", status=404)
    return memory


def _active_duplicate(user, content: str, *, exclude_ids: Iterable[Any] = ()) -> NoteMemory | None:
    excluded = {str(item) for item in exclude_ids}
    key = _normalize_content(content)
    return next(
        (
            item
            for item in NoteMemory.objects.filter(user=user, status__in=_ACTIVE_STATUSES)
            if str(item.id) not in excluded and _normalize_content(item.content) == key
        ),
        None,
    )


def _audit_transition(user, memory: NoteMemory, action: str, previous: str, next_status: str) -> None:
    NoteAuditEvent.objects.create(
        user=user,
        action=action,
        object_type="note_memory",
        object_id=memory.id,
        metadata={
            "actorId": str(user.id),
            "memoryId": str(memory.id),
            "previousStatus": previous,
            "nextStatus": next_status,
            "noteIds": [
                str(item.get("id"))
                for item in memory.source_note_refs
                if isinstance(item, dict) and item.get("id")
            ],
        },
    )


def _ensure_status(memory: NoteMemory, allowed: set[str]) -> None:
    if memory.status not in allowed:
        raise MemoryServiceError("当前记忆状态不允许此操作", code="memory_transition_not_allowed", status=409)


def _apply_confirmation_edits(memory: NoteMemory, payload: dict[str, Any]) -> None:
    allowed = {"content", "memoryType", "importance", "confidence", "validFrom", "validUntil"}
    if set(payload) - allowed:
        raise MemoryServiceError("确认字段不受支持", code="invalid_memory_update")
    if "content" in payload:
        memory.content = _parse_bounded_text(
            payload["content"], field="content", maximum=MAX_MEMORY_CONTENT_CHARACTERS
        )
    if "memoryType" in payload:
        memory_type = str(payload["memoryType"])
        if memory_type not in {NoteMemory.MemoryType.CORE, NoteMemory.MemoryType.EPISODIC}:
            raise MemoryServiceError("memoryType 不受支持", code="invalid_memory_update")
        memory.memory_type = memory_type
    if "importance" in payload:
        memory.importance = _parse_score(payload["importance"], field="importance", minimum=0, maximum=5)
    if "confidence" in payload:
        memory.confidence = _parse_score(payload["confidence"], field="confidence", minimum=0, maximum=1)
    if "validFrom" in payload:
        memory.valid_from = _parse_optional_datetime(payload["validFrom"], field="validFrom") or timezone.now()
    if "validUntil" in payload:
        memory.valid_until = _parse_optional_datetime(payload["validUntil"], field="validUntil")
    if memory.valid_until is not None and memory.valid_until <= memory.valid_from:
        raise MemoryServiceError("记忆有效期不正确", code="invalid_memory_update")


def confirm_memory(user, memory_id, payload: dict[str, Any]) -> NoteMemory:
    with transaction.atomic():
        memory = _owned_for_update(user, memory_id)
        _ensure_status(memory, {NoteMemory.Status.CANDIDATE})
        previous = memory.status
        _apply_confirmation_edits(memory, payload)
        duplicate = _active_duplicate(user, memory.content, exclude_ids=[memory.id])
        if duplicate is not None:
            raise MemoryServiceError("相同记忆已经存在", code="memory_duplicate", status=409)
        memory.status = NoteMemory.Status.CONFIRMED
        memory.confirmed_at = timezone.now()
        memory.deleted_at = None
        memory.save()
        _audit_transition(user, memory, "note.memory_confirmed", previous, memory.status)
    return memory


def _transition(user, memory_id, *, allowed: set[str], next_status: str, action: str) -> NoteMemory:
    with transaction.atomic():
        memory = _owned_for_update(user, memory_id)
        _ensure_status(memory, allowed)
        previous = memory.status
        memory.status = next_status
        if next_status == NoteMemory.Status.CONFIRMED:
            memory.confirmed_at = memory.confirmed_at or timezone.now()
        if next_status == NoteMemory.Status.DELETED:
            memory.deleted_at = timezone.now()
        memory.save()
        _audit_transition(user, memory, action, previous, next_status)
    return memory


def pause_memory(user, memory_id) -> NoteMemory:
    return _transition(
        user,
        memory_id,
        allowed={NoteMemory.Status.CONFIRMED},
        next_status=NoteMemory.Status.PAUSED,
        action="note.memory_paused",
    )


def resume_memory(user, memory_id) -> NoteMemory:
    return _transition(
        user,
        memory_id,
        allowed={NoteMemory.Status.PAUSED},
        next_status=NoteMemory.Status.CONFIRMED,
        action="note.memory_resumed",
    )


def delete_memory(user, memory_id) -> NoteMemory:
    return _transition(
        user,
        memory_id,
        allowed={
            NoteMemory.Status.CANDIDATE,
            NoteMemory.Status.CONFIRMED,
            NoteMemory.Status.PAUSED,
            NoteMemory.Status.SUPERSEDED,
        },
        next_status=NoteMemory.Status.DELETED,
        action="note.memory_deleted",
    )


def supersede_memory(user, memory_id, payload: dict[str, Any]) -> tuple[NoteMemory, NoteMemory]:
    if set(payload) - {"replacementId", "content", "memoryType", "importance", "confidence", "validFrom", "validUntil"}:
        raise MemoryServiceError("替换字段不受支持", code="invalid_memory_update")
    with transaction.atomic():
        old = _owned_for_update(user, memory_id)
        _ensure_status(old, {NoteMemory.Status.CONFIRMED, NoteMemory.Status.PAUSED})
        replacement_id = payload.get("replacementId")
        if replacement_id:
            replacement = _owned_for_update(user, replacement_id)
            if replacement.id == old.id:
                raise MemoryServiceError("记忆不能替换自身", code="memory_transition_not_allowed", status=409)
            _ensure_status(replacement, {NoteMemory.Status.CANDIDATE})
            _apply_confirmation_edits(
                replacement,
                {key: value for key, value in payload.items() if key != "replacementId"},
            )
        else:
            content = _parse_bounded_text(
                payload.get("content"), field="content", maximum=MAX_MEMORY_CONTENT_CHARACTERS
            )
            replacement = NoteMemory(
                user=user,
                memory_type=str(payload.get("memoryType") or old.memory_type),
                content=content,
                status=NoteMemory.Status.CANDIDATE,
                importance=payload.get("importance", old.importance),
                confidence=payload.get("confidence", old.confidence),
                source_session=old.source_session,
                source_message=old.source_message,
                source_message_ids=old.source_message_ids,
                source_note_refs=old.source_note_refs,
                reason="用户更正已确认记忆",
            )
            _apply_confirmation_edits(replacement, {key: value for key, value in payload.items() if key != "content"})
        replacement.status = NoteMemory.Status.CONFIRMED
        replacement.confirmed_at = timezone.now()
        replacement.deleted_at = None
        if _active_duplicate(user, replacement.content, exclude_ids=[old.id, replacement.id]) is not None:
            raise MemoryServiceError("相同记忆已经存在", code="memory_duplicate", status=409)
        replacement.save()
        previous = old.status
        old.status = NoteMemory.Status.SUPERSEDED
        old.superseded_by = replacement
        old.save()
        _audit_transition(user, replacement, "note.memory_confirmed", NoteMemory.Status.CANDIDATE, replacement.status)
        _audit_transition(user, old, "note.memory_superseded", previous, old.status)
    return old, replacement


def list_memories(user, *, status: str = ""):
    queryset = NoteMemory.objects.filter(user=user).select_related("superseded_by")
    if status:
        if status not in NoteMemory.Status.values:
            raise MemoryServiceError("记忆状态筛选无效", code="invalid_memory_status")
        queryset = queryset.filter(status=status)
    return queryset.order_by("-updated_at", "-created_at")


def serialize_memory(memory: NoteMemory) -> dict[str, Any]:
    return {
        "id": str(memory.id),
        "memoryType": memory.memory_type,
        "content": memory.content,
        "status": memory.status,
        "importance": memory.importance,
        "confidence": memory.confidence,
        "sourceSessionId": str(memory.source_session_id) if memory.source_session_id else None,
        "sourceMessageIds": memory.source_message_ids,
        "sourceNoteRefs": memory.source_note_refs,
        "reason": memory.reason,
        "validFrom": memory.valid_from.isoformat(),
        "validUntil": memory.valid_until.isoformat() if memory.valid_until else None,
        "supersededById": str(memory.superseded_by_id) if memory.superseded_by_id else None,
        "confirmedAt": memory.confirmed_at.isoformat() if memory.confirmed_at else None,
        "deletedAt": memory.deleted_at.isoformat() if memory.deleted_at else None,
        "createdAt": memory.created_at.isoformat(),
        "updatedAt": memory.updated_at.isoformat(),
    }
