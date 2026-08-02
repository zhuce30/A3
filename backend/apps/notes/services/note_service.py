from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone

from backend.apps.notes.models import Note, NoteMutation, Notebook, NoteRevision, NoteTag, normalize_tag_name
from backend.apps.notes.prosemirror import (
    DocumentValidationError,
    extract_note_text,
    validate_content as validate_prosemirror_content,
)


class NoteServiceError(Exception):
    status = 400
    code = "invalid_request"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        if "code" in details:
            self.code = details.pop("code")
        if "status" in details:
            self.status = details.pop("status")
        self.details = details


class NoteNotFound(NoteServiceError):
    status = 404
    code = "not_found"


class NoteConflict(NoteServiceError):
    status = 409
    code = "note_version_conflict"


class MutationReuseConflict(NoteServiceError):
    status = 409
    code = "mutation_id_reused"


@dataclass(frozen=True)
class SaveResult:
    note: Note
    resulting_version: int
    idempotent: bool = False


def _validate_name(value: Any, *, label: str, max_length: int, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise NoteServiceError(f"{label}不能为空", code=code)
    normalized = value.strip()
    if len(normalized) > max_length:
        raise NoteServiceError(f"{label}不能超过 {max_length} 个字符", code=code)
    return normalized


def list_notebooks(user):
    return Notebook.objects.filter(user=user).annotate(
        note_count=Count("notes", filter=Q(notes__deleted_at__isnull=True))
    )[:100]


def create_notebook(user, data: dict[str, Any]) -> Notebook:
    name = _validate_name(data.get("name"), label="笔记本名称", max_length=160, code="invalid_notebook_name")
    sort_order = data.get("sortOrder", 0)
    if isinstance(sort_order, bool) or not isinstance(sort_order, int) or sort_order < 0:
        raise NoteServiceError("sortOrder 必须是非负整数", code="invalid_sort_order")
    return Notebook.objects.create(user=user, name=name, sort_order=sort_order)


def update_notebook(user, notebook_id, data: dict[str, Any]) -> Notebook:
    try:
        notebook = Notebook.objects.get(user=user, pk=notebook_id)
    except (Notebook.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("笔记本不存在") from exc
    if "name" in data:
        notebook.name = _validate_name(
            data["name"], label="笔记本名称", max_length=160, code="invalid_notebook_name"
        )
    if "sortOrder" in data:
        sort_order = data["sortOrder"]
        if isinstance(sort_order, bool) or not isinstance(sort_order, int) or sort_order < 0:
            raise NoteServiceError("sortOrder 必须是非负整数", code="invalid_sort_order")
        notebook.sort_order = sort_order
    if "isArchived" in data:
        if not isinstance(data["isArchived"], bool):
            raise NoteServiceError("isArchived 必须是布尔值", code="invalid_archive_state")
        notebook.is_archived = data["isArchived"]
    notebook.save()
    return notebook


def list_tags(user):
    return NoteTag.objects.filter(user=user)[:100]


def create_tag(user, data: dict[str, Any]) -> NoteTag:
    name = _validate_name(data.get("name"), label="标签名称", max_length=64, code="invalid_tag_name")
    color = data.get("color", "")
    if not isinstance(color, str) or len(color) > 32:
        raise NoteServiceError("标签颜色格式不正确", code="invalid_tag_color")
    if NoteTag.objects.filter(user=user, normalized_name=normalize_tag_name(name)).exists():
        raise NoteServiceError("该标签已存在", code="tag_already_exists", status=409)
    try:
        return NoteTag.objects.create(user=user, name=name, color=color)
    except (IntegrityError, ValueError) as exc:
        raise NoteServiceError("该标签已存在", code="tag_already_exists", status=409) from exc


def delete_tag(user, tag_id) -> None:
    try:
        tag = NoteTag.objects.get(user=user, pk=tag_id)
    except (NoteTag.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("标签不存在") from exc
    tag.delete()


def note_queryset(user, *, deleted: bool = False):
    return (
        Note.objects.filter(user=user, deleted_at__isnull=not deleted)
        .select_related("notebook")
        .prefetch_related("tags")
    )


def list_notes(user):
    return note_queryset(user)[:100]


def get_note(user, note_id, *, deleted: bool = False) -> Note:
    try:
        return note_queryset(user, deleted=deleted).get(pk=note_id)
    except (Note.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("笔记不存在") from exc


def list_revisions(user, note_id):
    note = get_note(user, note_id)
    return note.revisions.all()[:100]


def search_notes(user, params) -> list[Note]:
    supported_views = {"", "recent", "today", "unorganized", "attachments", "trash"}
    view = params.get("view", "")
    if view not in supported_views:
        raise NoteServiceError("不支持的智能视图", code="invalid_view")
    try:
        limit = min(max(int(params.get("limit", 100)), 1), 100)
    except (TypeError, ValueError) as exc:
        raise NoteServiceError("limit 必须是整数", code="invalid_limit") from exc

    queryset = note_queryset(user, deleted=view == "trash")
    notebook_id = params.get("notebookId")
    if notebook_id:
        notebook = resolve_notebook(user, notebook_id)
        queryset = queryset.filter(notebook=notebook)
    tag_value = params.get("tag")
    if tag_value:
        try:
            tag_uuid = uuid.UUID(tag_value)
        except (ValueError, TypeError):
            tag = NoteTag.objects.filter(user=user, normalized_name=normalize_tag_name(tag_value)).first()
        else:
            tag = NoteTag.objects.filter(user=user, pk=tag_uuid).first()
        if tag is None:
            raise NoteNotFound("标签不存在")
        queryset = queryset.filter(tags=tag)
    query = params.get("q", "").strip()
    if len(query) > 200:
        raise NoteServiceError("搜索关键词不能超过 200 个字符", code="invalid_search_query")
    if query:
        queryset = queryset.filter(
            Q(title__icontains=query)
            | Q(content_text__icontains=query)
            | Q(tags__name__icontains=query)
            | Q(notebook__name__icontains=query)
        )
    if view == "today":
        queryset = queryset.filter(last_edited_at__date=timezone.localdate())
    elif view == "unorganized":
        queryset = queryset.filter(notebook__isnull=True)
    elif view == "attachments":
        queryset = queryset.filter(attachments__deleted_at__isnull=True, attachments__isnull=False)
    if view == "recent":
        queryset = queryset.order_by("-last_edited_at", "-updated_at", "-created_at")
    return list(queryset.distinct()[:limit])


def validate_content(value: Any) -> dict[str, Any]:
    try:
        return validate_prosemirror_content(value)
    except DocumentValidationError as exc:
        raise NoteServiceError(str(exc), code=exc.code) from exc


def validate_title(value: Any) -> str:
    if not isinstance(value, str):
        raise NoteServiceError("标题必须是字符串", code="invalid_title")
    if len(value) > 200:
        raise NoteServiceError("标题不能超过 200 个字符", code="title_too_long")
    return value


def parse_mutation_id(value: Any) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise NoteServiceError("clientMutationId 必须是有效 UUID", code="invalid_mutation_id") from exc


def parse_base_version(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise NoteServiceError("baseVersion 必须是非负整数", code="invalid_note_mutation")
    return value


def resolve_notebook(user, notebook_id: Any) -> Notebook | None:
    if notebook_id is None:
        return None
    try:
        parsed = uuid.UUID(str(notebook_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise NoteServiceError("notebookId 格式不正确", code="invalid_notebook_id") from exc
    try:
        return Notebook.objects.get(user=user, pk=parsed)
    except Notebook.DoesNotExist as exc:
        raise NoteNotFound("笔记本不存在") from exc


def resolve_tags(user, tag_ids: Any) -> list[NoteTag]:
    if tag_ids is None:
        return []
    if not isinstance(tag_ids, list) or len(tag_ids) > 100:
        raise NoteServiceError("tagIds 必须是最多 100 项的数组", code="invalid_tag_ids")
    parsed_ids = []
    try:
        parsed_ids = [uuid.UUID(str(item)) for item in tag_ids]
    except (ValueError, TypeError, AttributeError) as exc:
        raise NoteServiceError("tagIds 包含无效 UUID", code="invalid_tag_ids") from exc
    tags_by_id = {tag.id: tag for tag in NoteTag.objects.filter(user=user, id__in=parsed_ids)}
    if len(tags_by_id) != len(set(parsed_ids)):
        raise NoteNotFound("标签不存在")
    return [tags_by_id[tag_id] for tag_id in parsed_ids]


def _revision_metadata(user, source: str, from_version: int, to_version: int) -> dict[str, Any]:
    return {
        "actorId": str(user.pk),
        "source": source,
        "fromVersion": from_version,
        "toVersion": to_version,
    }


def _create_revision(note: Note, source: str, user, from_version: int) -> NoteRevision:
    return NoteRevision.objects.create(
        note=note,
        version=note.version,
        source=source,
        title_snapshot=note.title,
        content_json_snapshot=note.content_json,
        content_text_snapshot=note.content_text,
        actor_metadata=_revision_metadata(user, source, from_version, note.version),
    )


def _document_structure(content: dict[str, Any]) -> tuple[str, ...]:
    nodes = content.get("content", []) if isinstance(content, dict) else []
    return tuple(node.get("type", "") for node in nodes if isinstance(node, dict))


def _checkpoint_due(note: Note, source: str, now, *, meaningful_boundary: bool = False) -> str | None:
    if source in {NoteRevision.Source.MANUAL, NoteRevision.Source.AI_WRITEBACK, NoteRevision.Source.RESTORE}:
        return source
    if meaningful_boundary:
        return NoteRevision.Source.CHECKPOINT
    latest = note.revisions.filter(source=NoteRevision.Source.CHECKPOINT).order_by("-created_at").first()
    if latest is None or latest.created_at <= now - timedelta(minutes=15):
        return NoteRevision.Source.CHECKPOINT
    return None


def _prune_checkpoints(note: Note, now) -> None:
    checkpoints = note.revisions.filter(source=NoteRevision.Source.CHECKPOINT)
    newest_ids = list(checkpoints.order_by("-created_at", "-version").values_list("id", flat=True)[:100])
    checkpoints.filter(Q(created_at__lt=now - timedelta(days=90)) | ~Q(id__in=newest_ids)).delete()


def _mutation_receipt(user, note: Note, mutation_id: uuid.UUID) -> NoteMutation | None:
    receipt = NoteMutation.objects.filter(user=user, mutation_id=mutation_id).first()
    if receipt and receipt.note_id != note.id:
        raise MutationReuseConflict("clientMutationId 已用于另一条笔记")
    return receipt


def _create_receipt(user, note: Note, mutation_id: uuid.UUID) -> tuple[NoteMutation, bool]:
    try:
        with transaction.atomic():
            return (
                NoteMutation.objects.create(
                    user=user,
                    note=note,
                    mutation_id=mutation_id,
                    resulting_version=note.version,
                ),
                True,
            )
    except IntegrityError:
        receipt = NoteMutation.objects.get(user=user, mutation_id=mutation_id)
        if receipt.note_id != note.id:
            raise MutationReuseConflict("clientMutationId 已用于另一条笔记")
        return receipt, False


@transaction.atomic
def create_note(user, data: dict[str, Any]) -> Note:
    title = validate_title(data.get("title", ""))
    content = validate_content(data.get("content", {"type": "doc", "content": []}))
    notebook = resolve_notebook(user, data.get("notebookId")) if "notebookId" in data else None
    tags = resolve_tags(user, data.get("tagIds", []))
    is_pinned = data.get("isPinned", False)
    if not isinstance(is_pinned, bool):
        raise NoteServiceError("isPinned 必须是布尔值", code="invalid_is_pinned")
    note = Note.objects.create(
        user=user,
        notebook=notebook,
        title=title,
        content_json=content,
        content_text=extract_note_text(content),
        is_pinned=is_pinned,
    )
    note.tags.set(tags)
    _create_revision(note, NoteRevision.Source.MANUAL, user, 0)
    return note


@transaction.atomic
def save_note(user, note_id, data: dict[str, Any]) -> SaveResult:
    if "baseVersion" not in data or "clientMutationId" not in data:
        raise NoteServiceError("PATCH 必须提供 baseVersion 和 clientMutationId", code="invalid_note_mutation")
    base_version = parse_base_version(data["baseVersion"])
    mutation_id = parse_mutation_id(data["clientMutationId"])
    source = data.get("source", "autosave")
    if source not in {"autosave", NoteRevision.Source.MANUAL, NoteRevision.Source.AI_WRITEBACK}:
        raise NoteServiceError("source 仅支持 autosave、manual 或 ai_writeback", code="unsupported_source")
    get_user_model().objects.select_for_update().get(pk=user.pk)
    try:
        note = Note.objects.select_for_update().select_related("notebook").get(
            user=user, pk=note_id, deleted_at__isnull=True
        )
    except (Note.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("笔记不存在") from exc
    receipt = _mutation_receipt(user, note, mutation_id)
    if receipt:
        return SaveResult(note=note, resulting_version=receipt.resulting_version, idempotent=True)
    if note.version != base_version:
        raise NoteConflict("笔记已在其他位置更新", server_version=note.version, server_note=note)

    notebook = resolve_notebook(user, data["notebookId"]) if "notebookId" in data else note.notebook
    tags = resolve_tags(user, data["tagIds"]) if "tagIds" in data else None
    title = validate_title(data["title"]) if "title" in data else note.title
    content = validate_content(data["content"]) if "content" in data else note.content_json
    is_pinned = data.get("isPinned", note.is_pinned)
    if not isinstance(is_pinned, bool):
        raise NoteServiceError("isPinned 必须是布尔值", code="invalid_is_pinned")

    now = timezone.now()
    previous_version = note.version
    meaningful_boundary = title != note.title or _document_structure(content) != _document_structure(note.content_json)
    note.notebook = notebook
    note.title = title
    note.content_json = content
    note.content_text = extract_note_text(content)
    note.is_pinned = is_pinned
    note.version += 1
    note.last_edited_at = now
    note.save()
    if tags is not None:
        note.tags.set(tags)
    revision_source = _checkpoint_due(note, source, now, meaningful_boundary=meaningful_boundary)
    if revision_source:
        _create_revision(note, revision_source, user, previous_version)
    _prune_checkpoints(note, now)
    receipt, created = _create_receipt(user, note, mutation_id)
    if not created:
        note.refresh_from_db()
        return SaveResult(note=note, resulting_version=receipt.resulting_version, idempotent=True)
    return SaveResult(note=note, resulting_version=note.version)


@transaction.atomic
def restore_revision(user, note_id, revision_id, data: dict[str, Any]) -> SaveResult:
    if "baseVersion" not in data or "clientMutationId" not in data:
        raise NoteServiceError("恢复修订必须提供 baseVersion 和 clientMutationId", code="invalid_note_mutation")
    base_version = parse_base_version(data["baseVersion"])
    mutation_id = parse_mutation_id(data["clientMutationId"])
    get_user_model().objects.select_for_update().get(pk=user.pk)
    try:
        note = Note.objects.select_for_update().get(user=user, pk=note_id, deleted_at__isnull=True)
        revision = NoteRevision.objects.get(note=note, pk=revision_id)
    except (Note.DoesNotExist, NoteRevision.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("笔记或修订不存在") from exc
    receipt = _mutation_receipt(user, note, mutation_id)
    if receipt:
        return SaveResult(note=note, resulting_version=receipt.resulting_version, idempotent=True)
    if note.version != base_version:
        raise NoteConflict("笔记已在其他位置更新", server_version=note.version, server_note=note)
    previous_version = note.version
    note.title = revision.title_snapshot
    note.content_json = revision.content_json_snapshot
    note.content_text = extract_note_text(note.content_json)
    note.version += 1
    note.last_edited_at = timezone.now()
    note.save()
    _create_revision(note, NoteRevision.Source.RESTORE, user, previous_version)
    _prune_checkpoints(note, timezone.now())
    receipt, created = _create_receipt(user, note, mutation_id)
    return SaveResult(note=note, resulting_version=receipt.resulting_version, idempotent=not created)


@transaction.atomic
def soft_delete_note(user, note_id) -> Note:
    try:
        note = Note.objects.select_for_update().get(user=user, pk=note_id, deleted_at__isnull=True)
    except (Note.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("笔记不存在") from exc
    note.deleted_at = timezone.now()
    note.save(update_fields={"deleted_at", "updated_at"})
    return note


@transaction.atomic
def restore_deleted_note(user, note_id) -> Note:
    try:
        note = Note.objects.select_for_update().get(user=user, pk=note_id, deleted_at__isnull=False)
    except (Note.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("回收站中没有该笔记") from exc
    note.deleted_at = None
    note.save(update_fields={"deleted_at", "updated_at"})
    return note


@transaction.atomic
def purge_note(user, note_id) -> None:
    try:
        note = Note.objects.select_for_update().get(user=user, pk=note_id, deleted_at__isnull=False)
    except (Note.DoesNotExist, ValueError) as exc:
        raise NoteNotFound("回收站中没有该笔记") from exc
    from backend.apps.notes.services.cleanup_service import register_attachment_cleanup

    register_attachment_cleanup(list(note.attachments.all()))
    note.delete()
