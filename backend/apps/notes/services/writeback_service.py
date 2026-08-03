from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import timedelta
from difflib import SequenceMatcher
from typing import Any

from django.db import transaction
from django.utils import timezone

from backend.apps.notes.models import (
    Note,
    NoteAiMessage,
    NoteAuditEvent,
    NoteRevision,
    NoteWritebackPreview,
)
from backend.apps.notes.prosemirror import DocumentValidationError, extract_note_text, validate_content


PREVIEW_TTL = timedelta(minutes=30)


class WritebackServiceError(ValueError):
    def __init__(self, message: str, *, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class WritebackResult:
    preview: NoteWritebackPreview
    note: Note | None = None
    idempotent: bool = False


def _uuid(value: Any, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise WritebackServiceError(f"{field} 格式不正确", code=f"invalid_{field}") from exc


def _generate_proposed_document(message: NoteAiMessage) -> dict[str, Any]:
    lines = [line.strip() for line in message.content.splitlines() if line.strip()]
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": line}]}
            for line in lines
        ],
    }


def _block_text(block: Any) -> str:
    if not isinstance(block, dict):
        return ""
    return extract_note_text({"type": "doc", "content": [block]})


def _build_structural_diff(current: dict[str, Any], proposed: dict[str, Any]) -> dict[str, Any]:
    before = current.get("content", [])
    after = proposed.get("content", [])
    before_keys = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in before]
    after_keys = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in after]
    additions: list[dict[str, Any]] = []
    removals: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, before_keys, after_keys).get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace":
            paired = min(i2 - i1, j2 - j1)
            changed.extend(
                {
                    "index": i1 + offset,
                    "before": _block_text(before[i1 + offset]),
                    "after": _block_text(after[j1 + offset]),
                }
                for offset in range(paired)
            )
            i1 += paired
            j1 += paired
        removals.extend({"index": index, "text": _block_text(before[index])} for index in range(i1, i2))
        additions.extend({"index": index, "text": _block_text(after[index])} for index in range(j1, j2))
    return {"additions": additions, "removals": removals, "changedBlocks": changed}


def _validate_diff(diff: Any) -> dict[str, Any]:
    if not isinstance(diff, dict) or set(diff) != {"additions", "removals", "changedBlocks"}:
        raise WritebackServiceError("写回差异格式不正确", code="invalid_writeback_diff")
    for key in ("additions", "removals", "changedBlocks"):
        if not isinstance(diff[key], list) or len(diff[key]) > 10_000:
            raise WritebackServiceError("写回差异格式不正确", code="invalid_writeback_diff")
        for item in diff[key]:
            expected = {"index", "before", "after"} if key == "changedBlocks" else {"index", "text"}
            if (
                not isinstance(item, dict)
                or set(item) != expected
                or isinstance(item.get("index"), bool)
                or not isinstance(item.get("index"), int)
                or item["index"] < 0
                or any(not isinstance(item.get(field), str) for field in expected - {"index"})
            ):
                raise WritebackServiceError("写回差异格式不正确", code="invalid_writeback_diff")
    return diff


def _scope_allows_message(message: NoteAiMessage, note: Note) -> bool:
    snapshot = message.session.scope_snapshot
    if not isinstance(snapshot, dict):
        return False
    notes = snapshot.get("notes")
    if not isinstance(notes, list):
        return False
    return any(
        isinstance(item, dict)
        and str(item.get("id")) == str(note.id)
        for item in notes
    )


def create_writeback_preview(user, payload: dict[str, Any]) -> NoteWritebackPreview:
    note_id = _uuid(payload.get("targetNoteId"), "target_note_id")
    message_id = _uuid(payload.get("messageId"), "message_id")
    note = Note.objects.filter(user=user, id=note_id, deleted_at__isnull=True).first()
    message = NoteAiMessage.objects.select_related("session").filter(
        session__user=user, id=message_id
    ).first()
    if note is None or message is None:
        raise WritebackServiceError("笔记或消息不存在", code="not_found", status=404)
    if (
        message.role != NoteAiMessage.Role.ASSISTANT
        or message.status != NoteAiMessage.Status.SUCCEEDED
        or not message.content.strip()
    ):
        raise WritebackServiceError("该消息不能用于写回", code="writeback_message_ineligible", status=403)
    if not _scope_allows_message(message, note):
        raise WritebackServiceError(
            "该消息不属于目标笔记的当前上下文", code="writeback_source_not_permitted", status=403
        )
    proposed = _generate_proposed_document(message)
    try:
        proposed = validate_content(proposed)
    except DocumentValidationError as exc:
        raise WritebackServiceError("生成的笔记正文格式不正确", code="invalid_writeback_document") from exc
    diff = _validate_diff(_build_structural_diff(note.content_json, proposed))
    return NoteWritebackPreview.objects.create(
        user=user,
        session=message.session,
        source_message=message,
        target_note=note,
        target_version=note.version,
        proposed_content_json=proposed,
        diff_summary=diff,
        expires_at=timezone.now() + PREVIEW_TTL,
    )


def _owned_locked_preview(user, preview_id) -> NoteWritebackPreview:
    preview = NoteWritebackPreview.objects.select_for_update().select_related("target_note").filter(
        user=user, id=preview_id
    ).first()
    if preview is None:
        raise WritebackServiceError("写回建议不存在", code="not_found", status=404)
    return preview


def confirm_writeback_preview(user, preview_id) -> WritebackResult:
    expired = False
    with transaction.atomic():
        preview = _owned_locked_preview(user, preview_id)
        if preview.status == NoteWritebackPreview.Status.APPLIED:
            return WritebackResult(preview=preview, note=preview.target_note, idempotent=True)
        if preview.status != NoteWritebackPreview.Status.PENDING:
            raise WritebackServiceError("该写回建议已结束", code="writeback_preview_not_pending", status=409)
        if preview.expires_at <= timezone.now():
            preview.status = NoteWritebackPreview.Status.EXPIRED
            preview.save(update_fields={"status", "updated_at"})
            expired = True
        else:
            note = Note.objects.select_for_update().filter(
                user=user, id=preview.target_note_id, deleted_at__isnull=True
            ).first()
            if note is None:
                raise WritebackServiceError("目标笔记不存在", code="not_found", status=404)
            if note.version != preview.target_version:
                raise WritebackServiceError(
                    "正文已更新，请重新生成建议", code="writeback_version_conflict", status=409
                )
            try:
                proposed = validate_content(preview.proposed_content_json)
                _validate_diff(preview.diff_summary)
            except DocumentValidationError as exc:
                raise WritebackServiceError(
                    "写回建议内容已损坏", code="invalid_writeback_document", status=409
                ) from exc
            previous_version = note.version
            note.content_json = proposed
            note.content_text = extract_note_text(proposed)
            note.version += 1
            note.last_edited_at = timezone.now()
            note.save()
            NoteRevision.objects.create(
                note=note,
                version=note.version,
                source=NoteRevision.Source.AI_WRITEBACK,
                title_snapshot=note.title,
                content_json_snapshot=note.content_json,
                content_text_snapshot=note.content_text,
                actor_metadata={
                    "actorId": str(user.pk),
                    "source": "ai_writeback",
                    "previewId": str(preview.id),
                    "fromVersion": previous_version,
                    "toVersion": note.version,
                },
            )
            NoteAuditEvent.objects.create(
                user=user,
                action="note.ai_writeback_applied",
                object_type="note",
                object_id=note.id,
                metadata={
                    "actorId": str(user.pk),
                    "source": "ai_writeback",
                    "previewId": str(preview.id),
                    "fromVersion": previous_version,
                    "toVersion": note.version,
                },
            )
            preview.status = NoteWritebackPreview.Status.APPLIED
            preview.save(update_fields={"status", "updated_at"})
            return WritebackResult(preview=preview, note=note)
    if expired:
        raise WritebackServiceError("写回建议已过期，请重新生成", code="writeback_preview_expired", status=409)
    raise AssertionError("unreachable")


def abandon_writeback_preview(user, preview_id) -> WritebackResult:
    with transaction.atomic():
        preview = _owned_locked_preview(user, preview_id)
        if preview.status == NoteWritebackPreview.Status.ABANDONED:
            return WritebackResult(preview=preview, idempotent=True)
        if preview.status != NoteWritebackPreview.Status.PENDING:
            raise WritebackServiceError("该写回建议已结束", code="writeback_preview_not_pending", status=409)
        preview.status = NoteWritebackPreview.Status.ABANDONED
        preview.save(update_fields={"status", "updated_at"})
        return WritebackResult(preview=preview)


def serialize_preview(preview: NoteWritebackPreview) -> dict[str, Any]:
    return {
        "id": str(preview.id),
        "sourceMessageId": str(preview.source_message_id),
        "targetNote": {"id": str(preview.target_note_id), "title": preview.target_note.title},
        "targetVersion": preview.target_version,
        "proposedContent": preview.proposed_content_json,
        "diff": preview.diff_summary,
        "status": preview.status,
        "expiresAt": preview.expires_at.isoformat(),
        "createdAt": preview.created_at.isoformat(),
    }
