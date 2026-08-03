from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone as datetime_timezone
from time import sleep
from typing import Any
from zoneinfo import ZoneInfo

from django.db import IntegrityError, OperationalError, transaction
from django.db.models import Max, Q
from django.utils import timezone

from backend.apps.compat.llm import chat_completion
from backend.apps.notes.models import (
    Note,
    NoteAttachmentParseSnapshot,
    NoteDailyDigest,
    NoteRevision,
)


BEIJING = ZoneInfo("Asia/Shanghai")
UTC = datetime_timezone.utc
MAX_CREATE_ATTEMPTS = 3
MAX_DIGEST_SOURCE_CHARACTERS = 120_000


class DigestServiceError(ValueError):
    def __init__(self, message: str, *, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class DigestNotFound(DigestServiceError):
    def __init__(self) -> None:
        super().__init__("每日总结不存在", code="digest_not_found", status=404)


def beijing_day_bounds(target_date: date) -> tuple[datetime, datetime]:
    start = datetime.combine(target_date, time.min, tzinfo=BEIJING)
    end = start + timedelta(days=1)
    return start.astimezone(UTC), end.astimezone(UTC)


def build_digest_snapshot(user, target_date: date) -> dict[str, Any]:
    start, end = beijing_day_bounds(target_date)
    with transaction.atomic():
        available_at_day_end = Q(deleted_at__isnull=True) | Q(deleted_at__gte=end)
        revisions = list(
            NoteRevision.objects.select_for_update()
            .filter(
                note__user=user,
                created_at__gte=start,
                created_at__lt=end,
            )
            .filter(Q(note__deleted_at__isnull=True) | Q(note__deleted_at__gte=end))
            .order_by("note_id", "created_at", "version", "id")
            .values(
                "note_id", "version", "title_snapshot", "content_text_snapshot", "created_at"
            )
        )
        current_notes = list(
            Note.objects.select_for_update()
            .filter(
                user=user,
                last_edited_at__gte=start,
                last_edited_at__lt=end,
            )
            .filter(available_at_day_end)
            .order_by("last_edited_at", "id")
            .values("id", "version", "title", "content_text", "last_edited_at")
        )
        selected: dict[Any, dict[str, Any]] = {}
        for revision in revisions:
            selected[revision["note_id"]] = {
                "id": revision["note_id"],
                "version": revision["version"],
                "title": revision["title_snapshot"],
                "contentText": revision["content_text_snapshot"],
                "lastEditedAt": revision["created_at"],
            }
        for note in current_notes:
            candidate = selected.get(note["id"])
            if candidate is None or (note["last_edited_at"], note["version"]) >= (
                candidate["lastEditedAt"], candidate["version"]
            ):
                selected[note["id"]] = {
                    "id": note["id"],
                    "version": note["version"],
                    "title": note["title"],
                    "contentText": note["content_text"],
                    "lastEditedAt": note["last_edited_at"],
                }
        note_ids = list(selected)
        parse_snapshots = list(
            NoteAttachmentParseSnapshot.objects.select_for_update()
            .filter(
                attachment__user=user,
                attachment__note_id__in=note_ids,
                attachment__created_at__lt=end,
                succeeded_at__lt=end,
            )
            .filter(Q(attachment__deleted_at__isnull=True) | Q(attachment__deleted_at__gte=end))
            .order_by("attachment_id", "succeeded_at", "parse_generation", "id")
            .values(
                "attachment_id", "attachment__note_id", "parse_generation",
                "display_name_snapshot", "extracted_text_snapshot", "succeeded_at",
            )
        )

    attachments_by_note: dict[Any, list[dict[str, Any]]] = {note_id: [] for note_id in note_ids}
    latest_parse_by_attachment: dict[Any, dict[str, Any]] = {}
    for parsed in parse_snapshots:
        latest_parse_by_attachment[parsed["attachment_id"]] = parsed
    for parsed in latest_parse_by_attachment.values():
        attachments_by_note[parsed["attachment__note_id"]].append(
            {
                "id": str(parsed["attachment_id"]),
                "parseVersion": parsed["parse_generation"],
                "displayName": parsed["display_name_snapshot"],
                "extractedText": parsed["extracted_text_snapshot"],
            }
        )
    notes = sorted(selected.values(), key=lambda item: (item["lastEditedAt"], item["id"]))
    return {
        "schemaVersion": 1,
        "date": target_date.isoformat(),
        "timezone": "Asia/Shanghai",
        "notes": [
            {
                "id": str(item["id"]),
                "version": item["version"],
                "title": item["title"],
                "contentText": item["contentText"],
                "lastEditedAt": item["lastEditedAt"].isoformat(),
                "attachments": attachments_by_note[item["id"]],
            }
            for item in notes
        ],
    }


def _next_revision(user, target_date: date) -> int:
    latest = (
        NoteDailyDigest.objects.select_for_update()
        .filter(user=user, digest_date=target_date)
        .aggregate(value=Max("revision"))["value"]
    )
    return int(latest or 0) + 1


def _create_digest(user, target_date: date, *, generated_by: str, idempotency_key: str | None = None):
    key = idempotency_key or f"manual:{uuid.uuid4()}"
    if generated_by == NoteDailyDigest.GeneratedBy.AUTOMATIC:
        existing = NoteDailyDigest.objects.filter(user=user, idempotency_key=key).first()
        if existing is not None:
            return existing, False
    for attempt in range(MAX_CREATE_ATTEMPTS):
        try:
            with transaction.atomic():
                if generated_by == NoteDailyDigest.GeneratedBy.AUTOMATIC:
                    existing = NoteDailyDigest.objects.select_for_update().filter(
                        user=user, idempotency_key=key
                    ).first()
                    if existing is not None:
                        return existing, False
                digest = NoteDailyDigest.objects.create(
                    user=user,
                    digest_date=target_date,
                    revision=_next_revision(user, target_date),
                    source_snapshot=build_digest_snapshot(user, target_date),
                    generated_by=generated_by,
                    idempotency_key=key,
                )
            return digest, True
        except (IntegrityError, OperationalError):
            if generated_by == NoteDailyDigest.GeneratedBy.AUTOMATIC:
                existing = NoteDailyDigest.objects.filter(user=user, idempotency_key=key).first()
                if existing is not None:
                    return existing, False
            if attempt + 1 >= MAX_CREATE_ATTEMPTS:
                raise DigestServiceError(
                    "每日总结创建繁忙，请重试",
                    code="digest_create_busy",
                    status=503,
                )
            sleep(0.01 * (attempt + 1))
    raise AssertionError("unreachable")


def create_manual_digest(user, target_date: date) -> NoteDailyDigest:
    digest, _ = _create_digest(
        user,
        target_date,
        generated_by=NoteDailyDigest.GeneratedBy.MANUAL,
    )
    enqueue_digest(digest)
    digest.refresh_from_db()
    return digest


def create_automatic_digest(user, target_date: date) -> NoteDailyDigest:
    key = f"auto:{user.pk}:{target_date.isoformat()}"
    digest, created = _create_digest(
        user,
        target_date,
        generated_by=NoteDailyDigest.GeneratedBy.AUTOMATIC,
        idempotency_key=key,
    )
    if created:
        enqueue_digest(digest)
        digest.refresh_from_db()
    return digest


def prepare_digest_dispatch(digest: NoteDailyDigest, *, force: bool = False) -> NoteDailyDigest:
    with transaction.atomic():
        queued = NoteDailyDigest.objects.select_for_update().filter(pk=digest.pk).first()
        if queued is None:
            raise DigestNotFound()
        if queued.status != NoteDailyDigest.Status.QUEUED:
            return queued
        queued.status = NoteDailyDigest.Status.QUEUED
        queued.run_generation += 1
        queued.run_lease_token = uuid.uuid4()
        queued.run_started_at = None
        queued.run_heartbeat_at = None
        queued.error_code = ""
        queued.error_message = ""
        queued.save(update_fields={
            "status", "run_generation", "run_lease_token", "run_started_at",
            "run_heartbeat_at", "error_code", "error_message", "updated_at",
        })
    return queued


def enqueue_digest(digest: NoteDailyDigest, *, force: bool = False) -> NoteDailyDigest:
    from backend.apps.notes.tasks import generate_daily_digest_task

    queued = prepare_digest_dispatch(digest, force=force)
    if queued.status != NoteDailyDigest.Status.QUEUED or queued.run_lease_token is None:
        return queued
    try:
        generate_daily_digest_task.delay(
            str(queued.id), queued.run_generation, str(queued.run_lease_token)
        )
    except Exception:
        NoteDailyDigest.objects.filter(
            pk=queued.pk,
            status=NoteDailyDigest.Status.QUEUED,
            run_generation=queued.run_generation,
            run_lease_token=queued.run_lease_token,
        ).update(
            status=NoteDailyDigest.Status.FAILED,
            run_lease_token=None,
            error_code="digest_enqueue_failed",
            error_message="每日总结任务暂时无法提交，请重试",
        )
    queued.refresh_from_db()
    return queued


def retry_digest(user, digest_id) -> NoteDailyDigest:
    digest = get_owned_digest(user, digest_id)
    if digest.status != NoteDailyDigest.Status.FAILED:
        raise DigestServiceError("只有失败的每日总结可以重试", code="digest_retry_not_allowed", status=409)
    changed = NoteDailyDigest.objects.filter(pk=digest.pk, status=NoteDailyDigest.Status.FAILED).update(
        status=NoteDailyDigest.Status.QUEUED,
        error_code="",
        error_message="",
        run_lease_token=None,
        run_started_at=None,
        run_heartbeat_at=None,
    )
    digest.refresh_from_db()
    if not changed:
        return digest
    enqueue_digest(digest, force=True)
    digest.refresh_from_db()
    return digest


def get_owned_digest(user, digest_id) -> NoteDailyDigest:
    digest = NoteDailyDigest.objects.filter(user=user, pk=digest_id).first()
    if digest is None:
        raise DigestNotFound()
    return digest


def list_owned_digests(user, target_date: date | None = None):
    query = NoteDailyDigest.objects.filter(user=user)
    if target_date is not None:
        query = query.filter(digest_date=target_date)
    return query.order_by("-digest_date", "-revision")


def serialize_digest(digest: NoteDailyDigest) -> dict[str, Any]:
    return {
        "id": str(digest.id),
        "digestDate": digest.digest_date.isoformat(),
        "revision": digest.revision,
        "status": digest.status,
        "title": digest.title,
        "contentMd": digest.content_md,
        "sourceSnapshot": digest.source_snapshot,
        "generatedBy": digest.generated_by,
        "idempotencyKey": digest.idempotency_key,
        "errorCode": digest.error_code,
        "errorMessage": digest.error_message,
        "createdAt": digest.created_at.isoformat(),
        "updatedAt": digest.updated_at.isoformat(),
    }


def generate_digest_markdown(snapshot: dict[str, Any]) -> str:
    notes = snapshot.get("notes")
    if not isinstance(notes, list) or not notes:
        raise DigestServiceError("目标日期没有可用于总结的笔记", code="digest_sources_empty", status=422)
    source_sections: list[str] = []
    used = 0
    for index, note in enumerate(notes, start=1):
        if not isinstance(note, dict):
            continue
        section = [
            f"[笔记 {index}] {note.get('title') or '未命名笔记'}",
            f"笔记 ID: {note.get('id')}",
            f"版本: {note.get('version')}",
            str(note.get("contentText") or ""),
        ]
        attachments = note.get("attachments") if isinstance(note.get("attachments"), list) else []
        for attachment in attachments:
            if isinstance(attachment, dict):
                section.extend([
                    f"[直属附件] {attachment.get('displayName') or '附件'}",
                    f"附件 ID: {attachment.get('id')}，解析版本: {attachment.get('parseVersion')}",
                    str(attachment.get("extractedText") or ""),
                ])
        text = "\n".join(section)
        remaining = MAX_DIGEST_SOURCE_CHARACTERS - used
        if remaining <= 0:
            break
        source_sections.append(text[:remaining])
        used += min(len(text), remaining)
    result = chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "你是个人笔记每日总结助手。只能依据用户在目标日期编辑的笔记快照和这些笔记直属的已成功解析附件。"
                    "不得引入课堂、任务、画像、课程知识、收藏或任何记忆数据。用中文 Markdown 提炼今日重点、知识联系和后续复习提示；"
                    "不能编造来源，资料不足时明确说明。"
                ),
            },
            {
                "role": "user",
                "content": f"目标日期：{snapshot.get('date')}\n\n不可变证据快照：\n" + "\n\n".join(source_sections),
            },
        ],
        temperature=0.1,
        max_tokens=1200,
    )
    return str(result.get("content") or "").strip()
