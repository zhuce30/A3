from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any

from django.utils import timezone

from backend.apps.compat.agent_kernel import AgentContext, RetrieverAgent
from backend.apps.notes.models import Note, NoteRevision, Notebook


DEFAULT_CONTEXT_CHARACTER_BUDGET = 8_000
DEFAULT_CONTEXT_TOKEN_BUDGET = 2_000
MAX_SCOPE_NOTES = 100
MAX_COURSE_SOURCES = 5
_TERM_RE = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]")


class ContextServiceError(ValueError):
    def __init__(self, message: str, *, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class NoteContext:
    text: str
    citations: list[dict[str, Any]]
    sources: list[dict[str, Any]]
    character_count: int
    token_count: int


@dataclass(frozen=True)
class _SnapshotNote:
    note: Note
    version: int
    title: str
    text: str


@dataclass(frozen=True)
class _Paragraph:
    snapshot: _SnapshotNote
    index: int
    start: int
    end: int
    text: str
    score: float


def _parse_uuid(value: Any, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ContextServiceError(
            f"{field} 包含无效 UUID", code="invalid_scope"
        ) from exc


def _parse_note_ids(value: Any, *, exactly_one: bool = False) -> list[uuid.UUID]:
    if not isinstance(value, list) or not value or len(value) > MAX_SCOPE_NOTES:
        raise ContextServiceError(
            f"noteIds 必须是 1 至 {MAX_SCOPE_NOTES} 项的数组", code="invalid_scope"
        )
    ids = [_parse_uuid(item, "noteIds") for item in value]
    if len(set(ids)) != len(ids) or (exactly_one and len(ids) != 1):
        raise ContextServiceError("笔记范围不正确", code="invalid_scope")
    return ids


def _owned_notes_in_order(user, note_ids: list[uuid.UUID]) -> list[Note]:
    notes = Note.objects.filter(
        user=user, id__in=note_ids, deleted_at__isnull=True
    ).prefetch_related("tags")
    by_id = {note.id: note for note in notes}
    if len(by_id) != len(note_ids):
        raise ContextServiceError("笔记不存在", code="note_not_found", status=404)
    return [by_id[note_id] for note_id in note_ids]


def create_scope_snapshot(user, scope: Any) -> dict[str, Any]:
    if not isinstance(scope, dict):
        raise ContextServiceError("作用范围必须是对象", code="invalid_scope")
    scope_type = str(scope.get("type") or "").strip()
    if scope_type == "note":
        notes = _owned_notes_in_order(user, _parse_note_ids(scope.get("noteIds"), exactly_one=True))
        extra: dict[str, Any] = {}
    elif scope_type == "selection":
        notes = _owned_notes_in_order(user, _parse_note_ids(scope.get("noteIds")))
        extra = {}
    elif scope_type == "notebook":
        notebook_id = _parse_uuid(scope.get("notebookId"), "notebookId")
        notebook = Notebook.objects.filter(user=user, id=notebook_id).first()
        if notebook is None:
            raise ContextServiceError("笔记本不存在", code="notebook_not_found", status=404)
        notes = list(
            Note.objects.filter(user=user, notebook=notebook, deleted_at__isnull=True)
            .prefetch_related("tags")[:MAX_SCOPE_NOTES]
        )
        if not notes:
            raise ContextServiceError("笔记本中没有可用笔记", code="empty_scope")
        extra = {"notebookId": str(notebook.id)}
    else:
        raise ContextServiceError("不支持的作用范围", code="invalid_scope")
    return {
        "type": scope_type,
        **extra,
        "notes": [{"id": str(note.id), "version": int(note.version)} for note in notes],
    }


def _validate_snapshot(user, scope: Any) -> tuple[str, list[_SnapshotNote]]:
    if not isinstance(scope, dict) or scope.get("type") not in {"note", "notebook", "selection"}:
        raise ContextServiceError("会话作用范围无效", code="invalid_scope")
    raw_notes = scope.get("notes")
    if raw_notes is None:
        scope = create_scope_snapshot(user, scope)
        raw_notes = scope["notes"]
    if not isinstance(raw_notes, list) or not raw_notes or len(raw_notes) > MAX_SCOPE_NOTES:
        raise ContextServiceError("会话作用范围无效", code="invalid_scope")
    note_ids = [_parse_uuid(item.get("id"), "scope.notes.id") for item in raw_notes if isinstance(item, dict)]
    if len(note_ids) != len(raw_notes) or len(set(note_ids)) != len(note_ids):
        raise ContextServiceError("会话作用范围无效", code="invalid_scope")
    notes = _owned_notes_in_order(user, note_ids)
    snapshots: list[_SnapshotNote] = []
    for note, raw in zip(notes, raw_notes, strict=True):
        try:
            version = int(raw.get("version"))
        except (TypeError, ValueError, AttributeError) as exc:
            raise ContextServiceError("笔记版本无效", code="invalid_scope") from exc
        if version < 1:
            raise ContextServiceError("笔记版本无效", code="invalid_scope")
        if note.version == version:
            title, text = note.title, note.content_text
        else:
            revision = NoteRevision.objects.filter(note=note, version=version).first()
            if revision is None:
                raise ContextServiceError(
                    "会话引用的笔记版本已不可用",
                    code="note_version_unavailable",
                    status=409,
                )
            title, text = revision.title_snapshot, revision.content_text_snapshot
        snapshots.append(_SnapshotNote(note=note, version=version, title=title, text=text))
    return str(scope["type"]), snapshots


def _terms(value: str) -> set[str]:
    return {item.casefold() for item in _TERM_RE.findall(value or "") if item.strip()}


def _token_count(value: str) -> int:
    return len(_TERM_RE.findall(value or ""))


def _truncate_to_budget(value: str, character_budget: int, token_budget: int) -> tuple[str, int]:
    if character_budget <= 0 or token_budget <= 0:
        return "", 0
    clipped = value[:character_budget]
    matches = list(_TERM_RE.finditer(clipped))
    if len(matches) <= token_budget:
        return clipped, len(matches)
    return clipped[: matches[token_budget - 1].end()].rstrip(), token_budget


def _paragraphs(snapshot: _SnapshotNote) -> list[tuple[int, int, int, str]]:
    text = snapshot.text or ""
    result = []
    cursor = 0
    for index, raw in enumerate(text.splitlines() or [text]):
        stripped = raw.strip()
        start = text.find(stripped, cursor) if stripped else cursor
        start = max(cursor, start)
        end = start + len(stripped)
        cursor = max(end + 1, cursor)
        if stripped:
            result.append((index, start, end, stripped))
    return result


def _citation(paragraph: _Paragraph, snippet: str) -> dict[str, Any]:
    return {
        "sourceKind": "personal_note",
        "noteId": str(paragraph.snapshot.note.id),
        "noteVersion": paragraph.snapshot.version,
        "title": paragraph.snapshot.title,
        "location": f"第 {paragraph.index + 1} 段",
        "paragraphIndex": paragraph.index,
        "charStart": paragraph.start,
        "charEnd": min(paragraph.end, paragraph.start + len(snippet)),
        "snippet": snippet,
    }


def retrieve_course_evidence(user, query: str) -> list[dict[str, Any]]:
    result = RetrieverAgent().run(
        AgentContext(
            user=user,
            workflow="qa_interact",
            goal=query,
            payload={"question": query, "mode": "fast"},
        )
    )
    sources = result.output.get("sources") if isinstance(result.output, dict) else []
    return sources if isinstance(sources, list) else []


def normalize_course_citations(
    sources: list[dict[str, Any]],
    character_budget: int,
    token_budget: int = DEFAULT_CONTEXT_TOKEN_BUDGET,
) -> tuple[str, list[dict[str, Any]]]:
    parts: list[str] = []
    citations: list[dict[str, Any]] = []
    remaining_characters = max(0, int(character_budget))
    remaining_tokens = max(0, int(token_budget))
    for index, source in enumerate(sources[:MAX_COURSE_SOURCES]):
        separator_size = 2 if parts else 0
        if (
            not isinstance(source, dict)
            or remaining_characters <= separator_size
            or remaining_tokens <= 0
        ):
            continue
        snippet, used_tokens = _truncate_to_budget(
            str(source.get("snippet") or source.get("text") or "").strip(),
            remaining_characters - separator_size,
            remaining_tokens,
        )
        if not snippet:
            continue
        parts.append(snippet)
        remaining_characters -= len(snippet) + separator_size
        remaining_tokens -= used_tokens
        citations.append(
            {
                "sourceKind": "course_knowledge",
                "sourceId": str(source.get("id") or f"course-{index + 1}"),
                "title": str(source.get("title") or "课程资料"),
                "location": str(source.get("location") or ""),
                "snippet": snippet,
                "score": source.get("score"),
            }
        )
    return "\n\n".join(parts), citations


def build_note_context(
    *,
    user,
    scope: dict[str, Any],
    query: str,
    include_course_evidence: bool = False,
    character_budget: int = DEFAULT_CONTEXT_CHARACTER_BUDGET,
    token_budget: int = DEFAULT_CONTEXT_TOKEN_BUDGET,
) -> NoteContext:
    budget = max(1, min(int(character_budget), DEFAULT_CONTEXT_CHARACTER_BUDGET))
    tokens = max(1, min(int(token_budget), DEFAULT_CONTEXT_TOKEN_BUDGET))
    personal_budget = budget if not include_course_evidence else max(1, budget * 3 // 4)
    personal_token_budget = tokens if not include_course_evidence else max(1, tokens * 3 // 4)
    scope_type, snapshots = _validate_snapshot(user, scope)
    query_terms = _terms(query)
    candidates: list[_Paragraph] = []
    now = timezone.now()
    for snapshot in snapshots:
        title_terms = _terms(snapshot.title)
        tag_terms = _terms(" ".join(tag.name for tag in snapshot.note.tags.all()))
        age_days = max(0.0, (now - snapshot.note.last_edited_at).total_seconds() / 86_400)
        recency = 1.0 / (1.0 + age_days)
        for index, start, end, paragraph_text in _paragraphs(snapshot):
            paragraph_terms = _terms(paragraph_text)
            score = (
                8.0 * len(query_terms & title_terms)
                + 5.0 * len(query_terms & tag_terms)
                + 2.0 * len(query_terms & paragraph_terms)
                + recency
            )
            candidates.append(
                _Paragraph(snapshot, index, start, end, paragraph_text, score)
            )
    if scope_type != "note":
        candidates.sort(
            key=lambda item: (item.score, item.snapshot.note.last_edited_at, -item.index),
            reverse=True,
        )

    parts: list[str] = []
    citations: list[dict[str, Any]] = []
    remaining = personal_budget
    remaining_tokens = personal_token_budget
    for candidate in candidates:
        separator_size = 2 if parts else 0
        available = remaining - separator_size
        if available <= 0 or remaining_tokens <= 0:
            break
        snippet, used_tokens = _truncate_to_budget(
            candidate.text, available, remaining_tokens
        )
        if not snippet:
            continue
        parts.append(snippet)
        remaining -= len(snippet) + separator_size
        remaining_tokens -= used_tokens
        citations.append(_citation(candidate, snippet))

    text = "\n\n".join(parts)
    if include_course_evidence:
        course_text, course_citations = normalize_course_citations(
            retrieve_course_evidence(user, query),
            budget - len(text) - (2 if text else 0),
            tokens - _token_count(text),
        )
        if course_text:
            text = f"{text}\n\n{course_text}" if text else course_text
            citations.extend(course_citations)
    return NoteContext(
        text=text[:budget],
        citations=citations,
        sources=citations,
        character_count=min(len(text), budget),
        token_count=min(_token_count(text), tokens),
    )
