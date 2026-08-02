from __future__ import annotations

import json
from typing import Any

from backend.apps.notes.models import Note, Notebook, NoteRevision, NoteTag


class JsonBodyError(ValueError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def parse_json_body(request) -> dict[str, Any]:
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JsonBodyError("请求 JSON 格式不正确", "invalid_json") from exc
    if not isinstance(value, dict):
        raise JsonBodyError("请求内容必须是 JSON 对象", "json_object_required")
    return value


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def serialize_notebook(notebook: Notebook) -> dict[str, Any]:
    payload = {
        "id": str(notebook.id),
        "name": notebook.name,
        "sortOrder": notebook.sort_order,
        "isArchived": notebook.is_archived,
        "createdAt": _iso(notebook.created_at),
        "updatedAt": _iso(notebook.updated_at),
    }
    if hasattr(notebook, "note_count"):
        payload["noteCount"] = notebook.note_count
    return payload


def serialize_tag(tag: NoteTag) -> dict[str, Any]:
    return {
        "id": str(tag.id),
        "name": tag.name,
        "color": tag.color,
        "createdAt": _iso(tag.created_at),
        "updatedAt": _iso(tag.updated_at),
    }


def _related_notebook(note: Note) -> dict[str, Any] | None:
    return serialize_notebook(note.notebook) if note.notebook_id else None


def _related_tags(note: Note) -> list[dict[str, Any]]:
    prefetched = getattr(note, "_prefetched_objects_cache", {}).get("tags")
    tags = prefetched if prefetched is not None else note.tags.all()
    return [serialize_tag(tag) for tag in tags]


def serialize_note_summary(note: Note) -> dict[str, Any]:
    return {
        "id": str(note.id),
        "title": note.title,
        "contentText": note.content_text,
        "version": note.version,
        "notebook": _related_notebook(note),
        "tags": _related_tags(note),
        "isPinned": note.is_pinned,
        "lastEditedAt": _iso(note.last_edited_at),
        "deletedAt": _iso(note.deleted_at),
        "createdAt": _iso(note.created_at),
        "updatedAt": _iso(note.updated_at),
    }


def serialize_note_detail(note: Note) -> dict[str, Any]:
    return {**serialize_note_summary(note), "content": note.content_json}


def serialize_revision(revision: NoteRevision) -> dict[str, Any]:
    return {
        "id": str(revision.id),
        "noteId": str(revision.note_id),
        "version": revision.version,
        "source": revision.source,
        "title": revision.title_snapshot,
        "content": revision.content_json_snapshot,
        "contentText": revision.content_text_snapshot,
        "createdAt": _iso(revision.created_at),
    }
