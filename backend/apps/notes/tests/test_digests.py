from __future__ import annotations

import json
import threading
import uuid
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from backend.apps.notes.models import (
    Note,
    NoteAttachment,
    NoteAttachmentParseSnapshot,
    NoteDailyState,
    NoteDailyDigest,
    NoteMemory,
    NoteRevision,
)
from backend.apps.notes.services import digest_service
from backend.apps.notes.services.attachment_service import parse_and_persist_attachment
from backend.apps.notes.services.note_service import (
    create_note,
    restore_deleted_note,
    restore_revision,
    save_note,
    soft_delete_note,
)
from backend.apps.notes.tasks import (
    create_previous_day_digests_task,
    generate_daily_digest_task,
    recover_stale_digest_jobs,
    DigestHeartbeat,
    _heartbeat_digest_once,
)


UTC = datetime_timezone.utc


class DigestFixtureMixin:
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(phone="13800003001", password="test-password")
        self.other_user = get_user_model().objects.create_user(phone="13800003002", password="test-password")
        self.target_date = date(2026, 8, 2)

    def note_at(
        self,
        instant: datetime,
        *,
        title: str = "离散数学",
        body: str = "命题逻辑复习",
        version: int = 3,
    ) -> Note:
        note = Note.objects.create(
            user=self.user,
            title=title,
            content_json={"type": "doc", "content": [{"type": "paragraph", "text": body}]},
            content_text=body,
            version=version,
        )
        Note.objects.filter(pk=note.pk).update(last_edited_at=instant)
        note.refresh_from_db()
        self.record_daily_state(note, version, instant, title=title, body=body)
        return note

    def record_daily_state(
        self,
        note: Note,
        version: int,
        instant: datetime,
        *,
        title: str,
        body: str,
    ) -> NoteDailyState:
        local_date = timezone.localtime(instant, digest_service.BEIJING).date()
        state = NoteDailyState.objects.filter(note=note, local_date=local_date).first()
        if state is not None and state.last_event_at > instant:
            return state
        values = {
            "title_snapshot": title,
            "content_json_snapshot": {"type": "doc", "content": []},
            "content_text_snapshot": body,
            "version": version,
            "last_edited_at_snapshot": instant,
            "was_edited": True,
            "deleted_at_day_end": False,
            "last_event_at": instant,
        }
        if state is None:
            return NoteDailyState.objects.create(note=note, local_date=local_date, **values)
        for field, value in values.items():
            setattr(state, field, value)
        state.save()
        return state


class DigestSnapshotTests(DigestFixtureMixin, TestCase):
    def revision_at(self, note: Note, version: int, instant: datetime, *, title: str, body: str) -> NoteRevision:
        revision = NoteRevision.objects.create(
            note=note,
            version=version,
            source=NoteRevision.Source.MANUAL,
            title_snapshot=title,
            content_json_snapshot={"type": "doc", "content": []},
            content_text_snapshot=body,
        )
        NoteRevision.objects.filter(pk=revision.pk).update(created_at=instant)
        revision.refresh_from_db()
        self.record_daily_state(note, version, instant, title=title, body=body)
        return revision

    def parse_snapshot_at(
        self,
        attachment: NoteAttachment,
        generation: int,
        instant: datetime,
        *,
        text: str,
    ) -> NoteAttachmentParseSnapshot:
        if attachment.created_at >= instant:
            NoteAttachment.objects.filter(pk=attachment.pk).update(created_at=instant - timedelta(seconds=1))
            attachment.refresh_from_db()
        parsed = NoteAttachmentParseSnapshot.objects.create(
            attachment=attachment,
            parse_generation=generation,
            display_name_snapshot=attachment.display_name,
            extracted_text_snapshot=text,
            succeeded_at=instant,
        )
        return parsed

    def test_snapshot_uses_only_target_date_notes_and_successful_direct_attachments(self) -> None:
        included = self.note_at(datetime(2026, 8, 2, 3, 30, tzinfo=UTC))
        outside = self.note_at(datetime(2026, 8, 3, 3, 30, tzinfo=UTC), title="次日笔记")
        other = Note.objects.create(user=self.other_user, title="他人笔记", content_text="不可见", version=8)
        succeeded = NoteAttachment.objects.create(
            user=self.user,
            note=included,
            kind=NoteAttachment.Kind.LINK,
            display_name="证明补充",
            source_url="https://example.com/proof",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            parse_generation=4,
            extracted_text="反证法附件证据",
        )
        self.parse_snapshot_at(
            succeeded,
            4,
            datetime(2026, 8, 2, 4, 0, tzinfo=UTC),
            text="反证法附件证据",
        )
        NoteAttachment.objects.create(
            user=self.user,
            note=included,
            kind=NoteAttachment.Kind.LINK,
            display_name="解析失败",
            source_url="https://example.com/failed",
            parse_status=NoteAttachment.ParseStatus.FAILED,
            extracted_text="不能进入摘要",
        )
        NoteAttachment.objects.create(
            user=self.user,
            note=outside,
            kind=NoteAttachment.Kind.LINK,
            display_name="次日附件",
            source_url="https://example.com/tomorrow",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            extracted_text="不能跨日期进入摘要",
        )
        NoteAttachment.objects.create(
            user=self.other_user,
            note=other,
            kind=NoteAttachment.Kind.LINK,
            display_name="他人附件",
            source_url="https://example.com/other",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            extracted_text="不可见附件",
        )

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["date"], "2026-08-02")
        self.assertEqual(snapshot["timezone"], "Asia/Shanghai")
        self.assertEqual([item["id"] for item in snapshot["notes"]], [str(included.id)])
        self.assertEqual(snapshot["notes"][0]["version"], 3)
        self.assertEqual(snapshot["notes"][0]["contentText"], "命题逻辑复习")
        self.assertEqual(snapshot["notes"][0]["attachments"], [{
            "id": str(succeeded.id),
            "parseVersion": 4,
            "displayName": "证明补充",
            "extractedText": "反证法附件证据",
        }])

    def test_cross_midnight_reedit_uses_the_last_revision_from_target_day(self) -> None:
        note = self.note_at(
            datetime(2026, 8, 2, 18, 0, tzinfo=UTC),
            title="次日标题",
            body="次日内容",
        )
        Note.objects.filter(pk=note.pk).update(version=3)
        self.revision_at(
            note,
            2,
            datetime(2026, 8, 2, 14, 0, tzinfo=UTC),
            title="目标日标题",
            body="目标日最终内容",
        )

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"], [self._expected_note(note, 2, "目标日标题", "目标日最终内容")])

    def test_after_midnight_delete_does_not_remove_target_day_revision(self) -> None:
        note = self.note_at(datetime(2026, 8, 2, 14, 0, tzinfo=UTC), title="删除前", body="仍应总结")
        self.revision_at(note, 1, datetime(2026, 8, 2, 14, 0, tzinfo=UTC), title="删除前", body="仍应总结")
        Note.objects.filter(pk=note.pk).update(deleted_at=datetime(2026, 8, 2, 18, 0, tzinfo=UTC))

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"][0]["id"], str(note.id))
        self.assertEqual(snapshot["notes"][0]["contentText"], "仍应总结")

    def test_same_day_multiple_revisions_select_the_latest_persisted_version(self) -> None:
        note = self.note_at(datetime(2026, 8, 3, 3, 0, tzinfo=UTC), title="次日", body="次日", version=4)
        self.revision_at(note, 2, datetime(2026, 8, 2, 2, 0, tzinfo=UTC), title="上午", body="上午版本")
        self.revision_at(note, 3, datetime(2026, 8, 2, 13, 0, tzinfo=UTC), title="晚上", body="最终版本")

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"][0]["version"], 3)
        self.assertEqual(snapshot["notes"][0]["title"], "晚上")
        self.assertEqual(snapshot["notes"][0]["contentText"], "最终版本")

    def test_later_attachment_parse_does_not_leak_into_historical_digest(self) -> None:
        note = self.note_at(datetime(2026, 8, 3, 2, 0, tzinfo=UTC), title="次日", body="次日", version=2)
        self.revision_at(note, 1, datetime(2026, 8, 2, 8, 0, tzinfo=UTC), title="目标日", body="目标日内容")
        attachment = NoteAttachment.objects.create(
            user=self.user,
            note=note,
            kind=NoteAttachment.Kind.LINK,
            display_name="演算过程",
            source_url="https://example.com/calculation",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            parse_generation=2,
            extracted_text="次日重解析内容",
            deleted_at=datetime(2026, 8, 3, 3, 0, tzinfo=UTC),
        )
        NoteAttachment.objects.filter(pk=attachment.pk).update(created_at=datetime(2026, 8, 2, 7, 0, tzinfo=UTC))
        self.parse_snapshot_at(attachment, 1, datetime(2026, 8, 2, 9, 0, tzinfo=UTC), text="目标日解析内容")
        self.parse_snapshot_at(attachment, 2, datetime(2026, 8, 3, 3, 0, tzinfo=UTC), text="次日重解析内容")

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"][0]["attachments"][0]["parseVersion"], 1)
        self.assertEqual(snapshot["notes"][0]["attachments"][0]["extractedText"], "目标日解析内容")
        self.assertNotIn("次日重解析内容", json.dumps(snapshot, ensure_ascii=False))

    def test_current_note_is_used_when_it_is_the_target_day_latest_version(self) -> None:
        note = self.note_at(
            datetime(2026, 8, 2, 15, 0, tzinfo=UTC),
            title="当前最终标题",
            body="当前最终内容",
            version=4,
        )
        self.revision_at(note, 3, datetime(2026, 8, 2, 10, 0, tzinfo=UTC), title="较早版本", body="较早内容")

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"][0]["version"], 4)
        self.assertEqual(snapshot["notes"][0]["contentText"], "当前最终内容")

    @staticmethod
    def _expected_note(note: Note, version: int, title: str, body: str) -> dict:
        return {
            "id": str(note.id),
            "version": version,
            "title": title,
            "contentText": body,
            "lastEditedAt": datetime(2026, 8, 2, 14, 0, tzinfo=UTC).isoformat(),
            "attachments": [],
        }

    def test_beijing_day_boundaries_are_converted_to_utc_without_dst(self) -> None:
        before = self.note_at(datetime(2026, 8, 1, 15, 59, 59, tzinfo=UTC), title="前一秒")
        start = self.note_at(datetime(2026, 8, 1, 16, 0, tzinfo=UTC), title="零点")
        end = self.note_at(datetime(2026, 8, 2, 15, 59, 59, tzinfo=UTC), title="最后一秒")
        after = self.note_at(datetime(2026, 8, 2, 16, 0, tzinfo=UTC), title="次日零点")

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual({item["id"] for item in snapshot["notes"]}, {str(start.id), str(end.id)})
        self.assertNotIn(str(before.id), json.dumps(snapshot, ensure_ascii=False))
        self.assertNotIn(str(after.id), json.dumps(snapshot, ensure_ascii=False))

    def test_snapshot_excludes_all_memory_and_non_note_context(self) -> None:
        self.note_at(datetime(2026, 8, 2, 8, 0, tzinfo=UTC), body="唯一允许的内容")
        NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            status=NoteMemory.Status.CONFIRMED,
            content="确认记忆也必须排除",
            confirmed_at=timezone.now(),
        )

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)
        encoded = json.dumps(snapshot, ensure_ascii=False)

        self.assertEqual(set(snapshot), {"schemaVersion", "date", "timezone", "notes"})
        for forbidden in ("确认记忆", "classroom", "task", "profile", "course", "favorite", "memory"):
            self.assertNotIn(forbidden, encoded.lower())


class DigestDailyStateTests(DigestFixtureMixin, TestCase):
    @staticmethod
    def content(body: str) -> dict:
        return {
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": body}]}],
        }

    def create_at(self, instant: datetime, *, title: str = "日终标题", body: str = "初始内容") -> Note:
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=instant):
            return create_note(self.user, {"title": title, "content": self.content(body)})

    def save_at(self, note: Note, instant: datetime, body: str) -> Note:
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=instant):
            result = save_note(self.user, note.id, {
                "baseVersion": note.version,
                "clientMutationId": str(uuid.uuid4()),
                "source": "autosave",
                "content": self.content(body),
            })
        result.note.refresh_from_db()
        return result.note

    def test_sparse_autosave_daily_state_preserves_prior_day_final_version(self) -> None:
        note = self.create_at(datetime(2026, 8, 2, 2, 0, tzinfo=UTC))
        note = self.save_at(note, datetime(2026, 8, 2, 2, 1, tzinfo=UTC), "第一次自动保存")
        note = self.save_at(note, datetime(2026, 8, 2, 2, 2, tzinfo=UTC), "目标日最终内容")
        self.assertFalse(NoteRevision.objects.filter(note=note, version=3).exists())
        state = NoteDailyState.objects.get(note=note, local_date=self.target_date)
        self.assertEqual(state.title_snapshot, "日终标题")
        self.assertEqual(state.content_json_snapshot, self.content("目标日最终内容"))
        self.assertEqual(state.content_text_snapshot, "目标日最终内容")
        self.assertEqual(state.version, 3)
        self.save_at(note, datetime(2026, 8, 3, 2, 0, tzinfo=UTC), "次日内容")

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"][0]["version"], 3)
        self.assertEqual(snapshot["notes"][0]["title"], "日终标题")
        self.assertEqual(snapshot["notes"][0]["contentText"], "目标日最终内容")
        self.assertNotIn("次日内容", json.dumps(snapshot, ensure_ascii=False))

    def test_next_day_delete_and_restore_do_not_change_prior_day_state(self) -> None:
        note = self.create_at(datetime(2026, 8, 2, 3, 0, tzinfo=UTC), body="应保留的内容")
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 3, 3, 0, tzinfo=UTC)):
            soft_delete_note(self.user, note.id)
        deleted_snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 3, 4, 0, tzinfo=UTC)):
            restore_deleted_note(self.user, note.id)
        restored_snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(deleted_snapshot["notes"][0]["contentText"], "应保留的内容")
        self.assertEqual(restored_snapshot, deleted_snapshot)

    def test_next_day_edit_and_delete_do_not_remove_prior_day_edit(self) -> None:
        note = self.create_at(datetime(2026, 8, 1, 3, 0, tzinfo=UTC), body="创建日内容")
        note = self.save_at(note, datetime(2026, 8, 2, 3, 0, tzinfo=UTC), "八月二日内容")
        note = self.save_at(note, datetime(2026, 8, 3, 3, 0, tzinfo=UTC), "八月三日内容")
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 3, 4, 0, tzinfo=UTC)):
            soft_delete_note(self.user, note.id)

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)

        self.assertEqual(snapshot["notes"][0]["contentText"], "八月二日内容")

    def test_delete_on_target_day_then_next_day_restore_stays_excluded(self) -> None:
        note = self.create_at(datetime(2026, 8, 1, 4, 0, tzinfo=UTC), body="创建日内容")
        note = self.save_at(note, datetime(2026, 8, 2, 4, 0, tzinfo=UTC), "删除前内容")
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 2, 5, 0, tzinfo=UTC)):
            soft_delete_note(self.user, note.id)
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 3, 5, 0, tzinfo=UTC)):
            restore_deleted_note(self.user, note.id)

        target_state = NoteDailyState.objects.get(note=note, local_date=self.target_date)
        restore_state = NoteDailyState.objects.get(note=note, local_date=date(2026, 8, 3))
        self.assertTrue(target_state.was_edited)
        self.assertTrue(target_state.deleted_at_day_end)
        self.assertFalse(restore_state.was_edited)
        self.assertFalse(restore_state.deleted_at_day_end)
        self.assertEqual(digest_service.build_digest_snapshot(self.user, self.target_date)["notes"], [])
        self.assertEqual(digest_service.build_digest_snapshot(self.user, date(2026, 8, 3))["notes"], [])

    def test_same_day_delete_and_restore_control_day_end_inclusion(self) -> None:
        note = self.create_at(datetime(2026, 8, 2, 4, 0, tzinfo=UTC), body="恢复后可见")
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 2, 5, 0, tzinfo=UTC)):
            soft_delete_note(self.user, note.id)
        self.assertEqual(digest_service.build_digest_snapshot(self.user, self.target_date)["notes"], [])

        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 2, 6, 0, tzinfo=UTC)):
            restore_deleted_note(self.user, note.id)

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)
        state = NoteDailyState.objects.get(note=note, local_date=self.target_date)
        self.assertEqual(snapshot["notes"][0]["contentText"], "恢复后可见")
        self.assertTrue(state.was_edited)
        self.assertFalse(state.deleted_at_day_end)

    def test_revision_restore_updates_the_daily_final_snapshot(self) -> None:
        note = self.create_at(datetime(2026, 8, 2, 7, 0, tzinfo=UTC), body="原始版本")
        original = NoteRevision.objects.get(note=note, version=1)
        note = self.save_at(note, datetime(2026, 8, 2, 7, 1, tzinfo=UTC), "修改版本")
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 2, 7, 2, tzinfo=UTC)):
            restore_revision(self.user, note.id, original.id, {
                "baseVersion": note.version,
                "clientMutationId": str(uuid.uuid4()),
            })

        snapshot = digest_service.build_digest_snapshot(self.user, self.target_date)
        self.assertEqual(snapshot["notes"][0]["version"], 3)
        self.assertEqual(snapshot["notes"][0]["contentText"], "原始版本")

    def test_daily_state_is_unique_per_note_and_beijing_date(self) -> None:
        note = self.create_at(datetime(2026, 8, 2, 8, 0, tzinfo=UTC))
        state = NoteDailyState.objects.get(note=note, local_date=self.target_date)

        with self.assertRaises(IntegrityError), transaction.atomic():
            NoteDailyState.objects.create(
                note=note,
                local_date=self.target_date,
                title_snapshot=state.title_snapshot,
                content_json_snapshot=state.content_json_snapshot,
                content_text_snapshot=state.content_text_snapshot,
                version=state.version,
                last_edited_at_snapshot=state.last_edited_at_snapshot,
                was_edited=True,
            )


class DigestRevisionAndTaskTests(DigestFixtureMixin, TestCase):
    def setUp(self) -> None:
        super().setUp()
        self.note_at(datetime(2026, 8, 2, 5, 0, tzinfo=UTC))

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_manual_refresh_creates_revisions_one_and_two_without_overwrite(self, enqueue) -> None:
        first = digest_service.create_manual_digest(self.user, self.target_date)
        NoteDailyDigest.objects.filter(pk=first.pk).update(status="succeeded", content_md="# 第一版")
        second = digest_service.create_manual_digest(self.user, self.target_date)

        first.refresh_from_db()
        self.assertEqual((first.revision, first.content_md), (1, "# 第一版"))
        self.assertEqual(second.revision, 2)
        self.assertNotEqual(first.id, second.id)
        self.assertEqual(enqueue.call_count, 2)

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_automatic_key_is_idempotent_and_allows_at_most_one_success(self, enqueue) -> None:
        expected_key = f"auto:{self.user.pk}:2026-08-02"
        first = digest_service.create_automatic_digest(self.user, self.target_date)
        second = digest_service.create_automatic_digest(self.user, self.target_date)

        self.assertEqual(first.id, second.id)
        self.assertEqual(first.idempotency_key, expected_key)
        self.assertEqual(NoteDailyDigest.objects.filter(user=self.user, generated_by="automatic").count(), 1)
        self.assertEqual(enqueue.call_count, 1)

    def test_database_unique_key_is_the_concurrency_backstop_for_automatic_success(self) -> None:
        key = f"auto:{self.user.pk}:2026-08-02"
        NoteDailyDigest.objects.create(
            user=self.user,
            digest_date=self.target_date,
            revision=1,
            generated_by=NoteDailyDigest.GeneratedBy.AUTOMATIC,
            idempotency_key=key,
            status=NoteDailyDigest.Status.SUCCEEDED,
            content_md="# 唯一自动版本",
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            NoteDailyDigest.objects.create(
                user=self.user,
                digest_date=self.target_date,
                revision=2,
                generated_by=NoteDailyDigest.GeneratedBy.AUTOMATIC,
                idempotency_key=key,
                status=NoteDailyDigest.Status.SUCCEEDED,
                content_md="# 并发重复版本",
            )

        self.assertEqual(
            NoteDailyDigest.objects.filter(user=self.user, idempotency_key=key, status="succeeded").count(),
            1,
        )

    @patch("backend.apps.notes.tasks.enqueue_memory_candidate_extraction")
    @patch("backend.apps.notes.services.digest_service.generate_digest_markdown", return_value="# 8 月 2 日笔记总结\n\n- 命题逻辑")
    def test_generation_is_fenced_and_never_overwrites_a_newer_lease(self, generate, enqueue_memory) -> None:
        with patch("backend.apps.notes.services.digest_service.enqueue_digest"):
            digest = digest_service.create_manual_digest(self.user, self.target_date)
        digest = digest_service.prepare_digest_dispatch(digest)
        old_generation = digest.run_generation
        old_token = digest.run_lease_token
        digest = digest_service.prepare_digest_dispatch(digest, force=True)

        stale = generate_daily_digest_task(str(digest.id), old_generation, str(old_token))
        fresh = generate_daily_digest_task(str(digest.id), digest.run_generation, str(digest.run_lease_token))

        digest.refresh_from_db()
        self.assertEqual(stale, {"skipped": True})
        self.assertEqual(fresh["status"], "succeeded")
        self.assertEqual(digest.content_md, "# 8 月 2 日笔记总结\n\n- 命题逻辑")
        enqueue_memory.assert_called_once_with("daily_digest", digest.id)

    @patch("backend.apps.notes.services.digest_service.generate_digest_markdown", return_value="")
    def test_empty_generation_becomes_readable_failure_not_blank_success(self, generate) -> None:
        with patch("backend.apps.notes.services.digest_service.enqueue_digest"):
            digest = digest_service.create_manual_digest(self.user, self.target_date)
        digest = digest_service.prepare_digest_dispatch(digest)

        result = generate_daily_digest_task(str(digest.id), digest.run_generation, str(digest.run_lease_token))

        digest.refresh_from_db()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(digest.status, NoteDailyDigest.Status.FAILED)
        self.assertEqual(digest.content_md, "")
        self.assertTrue(digest.error_message)

    def test_empty_snapshot_failure_keeps_the_specific_readable_error(self) -> None:
        empty_date = date(2026, 8, 1)
        with patch("backend.apps.notes.services.digest_service.enqueue_digest"):
            digest = digest_service.create_manual_digest(self.user, empty_date)
        digest = digest_service.prepare_digest_dispatch(digest)

        result = generate_daily_digest_task(str(digest.id), digest.run_generation, str(digest.run_lease_token))

        digest.refresh_from_db()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(digest.error_code, "digest_sources_empty")
        self.assertEqual(digest.error_message, "目标日期没有可用于总结的笔记")

    def test_force_dispatch_cannot_reopen_a_successful_read_only_artifact(self) -> None:
        digest = NoteDailyDigest.objects.create(
            user=self.user,
            digest_date=self.target_date,
            revision=1,
            generated_by=NoteDailyDigest.GeneratedBy.MANUAL,
            idempotency_key=f"manual:{uuid.uuid4()}",
            status=NoteDailyDigest.Status.SUCCEEDED,
            content_md="# 已完成",
        )

        result = digest_service.prepare_digest_dispatch(digest, force=True)

        self.assertEqual(result.status, NoteDailyDigest.Status.SUCCEEDED)
        self.assertEqual(result.content_md, "# 已完成")
        self.assertEqual(result.run_generation, 0)

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_losing_concurrent_retry_does_not_rotate_the_winning_lease(self, enqueue) -> None:
        digest = NoteDailyDigest.objects.create(
            user=self.user,
            digest_date=self.target_date,
            revision=1,
            generated_by=NoteDailyDigest.GeneratedBy.MANUAL,
            idempotency_key=f"manual:{uuid.uuid4()}",
            status=NoteDailyDigest.Status.FAILED,
            error_message="首次失败",
        )
        stale_failed_instance = digest
        winning_lease = uuid.uuid4()
        NoteDailyDigest.objects.filter(pk=digest.pk).update(
            status=NoteDailyDigest.Status.QUEUED,
            run_generation=5,
            run_lease_token=winning_lease,
        )

        with patch("backend.apps.notes.services.digest_service.get_owned_digest", return_value=stale_failed_instance):
            result = digest_service.retry_digest(self.user, digest.id)

        self.assertEqual(result.status, NoteDailyDigest.Status.QUEUED)
        self.assertEqual(result.run_generation, 5)
        self.assertEqual(result.run_lease_token, winning_lease)
        enqueue.assert_not_called()

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_stale_queued_and_processing_jobs_are_recovered(self, enqueue) -> None:
        queued = digest_service.create_manual_digest(self.user, self.target_date)
        processing = digest_service.create_manual_digest(self.user, self.target_date)
        stale_at = timezone.now() - timedelta(minutes=31)
        NoteDailyDigest.objects.filter(pk=queued.pk).update(updated_at=stale_at)
        NoteDailyDigest.objects.filter(pk=processing.pk).update(
            status=NoteDailyDigest.Status.PROCESSING,
            run_started_at=stale_at,
            run_heartbeat_at=stale_at,
            run_lease_token=uuid.uuid4(),
        )
        enqueue.reset_mock()

        result = recover_stale_digest_jobs(now=timezone.now(), stale_minutes=30)

        self.assertEqual(result, {"recovered": 2, "failed": 0})
        self.assertEqual(enqueue.call_count, 2)

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_recovery_does_not_requeue_a_live_heartbeating_digest(self, enqueue) -> None:
        digest = digest_service.create_manual_digest(self.user, self.target_date)
        now = timezone.now()
        NoteDailyDigest.objects.filter(pk=digest.pk).update(
            status=NoteDailyDigest.Status.PROCESSING,
            run_started_at=now - timedelta(minutes=60),
            run_heartbeat_at=now,
            run_lease_token=uuid.uuid4(),
        )
        enqueue.reset_mock()

        result = recover_stale_digest_jobs(now=now, stale_minutes=30)

        self.assertEqual(result, {"recovered": 0, "failed": 0})
        enqueue.assert_not_called()

    def test_old_lease_heartbeat_cannot_touch_a_newer_generation(self) -> None:
        digest = NoteDailyDigest.objects.create(
            user=self.user,
            digest_date=self.target_date,
            revision=1,
            idempotency_key=f"manual:{uuid.uuid4()}",
            status=NoteDailyDigest.Status.PROCESSING,
            run_generation=2,
            run_lease_token=uuid.uuid4(),
            run_heartbeat_at=timezone.now(),
        )
        newer_heartbeat = digest.run_heartbeat_at

        updated = _heartbeat_digest_once(digest.id, 1, uuid.uuid4())

        digest.refresh_from_db()
        self.assertFalse(updated)
        self.assertEqual(digest.run_generation, 2)
        self.assertEqual(digest.run_heartbeat_at, newer_heartbeat)

    @override_settings(A3_NOTES_DIGEST_HEARTBEAT_SECONDS=0.01)
    def test_generation_heartbeats_while_the_model_call_is_blocked(self) -> None:
        with patch("backend.apps.notes.services.digest_service.enqueue_digest"):
            digest = digest_service.create_manual_digest(self.user, self.target_date)
        digest = digest_service.prepare_digest_dispatch(digest)
        ticked = threading.Event()

        def heartbeat(*args):
            ticked.set()
            return _heartbeat_digest_once(*args)

        def generate(_snapshot):
            self.assertTrue(ticked.wait(timeout=1))
            return "# 已生成"

        with patch("backend.apps.notes.tasks._heartbeat_digest_once", side_effect=heartbeat), patch(
            "backend.apps.notes.services.digest_service.generate_digest_markdown",
            side_effect=generate,
        ):
            result = generate_daily_digest_task(
                str(digest.id), digest.run_generation, str(digest.run_lease_token)
            )

        self.assertEqual(result["status"], "succeeded")
        self.assertTrue(ticked.is_set())

    @patch("backend.apps.notes.services.attachment_service.extract_attachment_text")
    def test_successful_attachment_parse_persists_an_immutable_parse_snapshot(self, extract) -> None:
        extract.return_value = ("解析正文", {"parser": "test"})
        note = Note.objects.filter(user=self.user).first()
        lease = uuid.uuid4()
        attachment = NoteAttachment.objects.create(
            user=self.user,
            note=note,
            kind=NoteAttachment.Kind.LINK,
            display_name="证明材料",
            source_url="https://example.com/evidence",
            parse_status=NoteAttachment.ParseStatus.PROCESSING,
            parse_generation=3,
            parse_lease_token=lease,
        )

        result = parse_and_persist_attachment(attachment, 3, lease)

        parsed = NoteAttachmentParseSnapshot.objects.get(attachment=attachment, parse_generation=3)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(parsed.display_name_snapshot, "证明材料")
        self.assertEqual(parsed.extracted_text_snapshot, "解析正文")


class DigestHeartbeatThreadTests(TransactionTestCase):
    reset_sequences = True

    def test_heartbeat_thread_is_bounded_and_stops_on_success_and_failure(self) -> None:
        ticked = threading.Event()

        def heartbeat(*_args):
            ticked.set()
            return True

        with patch("backend.apps.notes.tasks._heartbeat_digest_once", side_effect=heartbeat):
            monitor = DigestHeartbeat(uuid.uuid4(), 1, uuid.uuid4(), interval_seconds=0.01)
            with monitor:
                self.assertTrue(ticked.wait(timeout=1))
            self.assertFalse(monitor.is_alive)

            ticked.clear()
            monitor = DigestHeartbeat(uuid.uuid4(), 1, uuid.uuid4(), interval_seconds=0.01)
            with self.assertRaises(RuntimeError):
                with monitor:
                    self.assertTrue(ticked.wait(timeout=1))
                    raise RuntimeError("model failed")
            self.assertFalse(monitor.is_alive)


class DigestApiTests(DigestFixtureMixin, TestCase):
    def setUp(self) -> None:
        super().setUp()
        self.note_at(datetime(2026, 8, 2, 5, 0, tzinfo=UTC))
        self.client.force_login(self.user)

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_owned_list_detail_manual_create_and_failed_retry(self, enqueue) -> None:
        created = self.client.post(
            "/api/notes/digests/manual/",
            data=json.dumps({"date": "2026-08-02"}),
            content_type="application/json",
        )
        self.assertEqual(created.status_code, 201)
        digest_id = created.json()["digest"]["id"]
        NoteDailyDigest.objects.filter(pk=digest_id).update(
            status=NoteDailyDigest.Status.FAILED,
            error_code="digest_model_unavailable",
            error_message="摘要模型暂时不可用",
        )

        listing = self.client.get("/api/notes/digests/?date=2026-08-02")
        detail = self.client.get(f"/api/notes/digests/{digest_id}/")
        retry = self.client.post(f"/api/notes/digests/{digest_id}/retry/")

        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.json()["digests"]), 1)
        self.assertEqual(detail.json()["digest"]["sourceSnapshot"]["notes"][0]["version"], 3)
        self.assertEqual(retry.status_code, 202)
        self.assertEqual(retry.json()["digest"]["status"], "queued")

    def test_authentication_and_ownership_are_enforced(self) -> None:
        foreign = NoteDailyDigest.objects.create(
            user=self.other_user,
            digest_date=self.target_date,
            revision=1,
            idempotency_key=f"manual:{uuid.uuid4()}",
        )
        self.client.logout()
        self.assertEqual(self.client.get("/api/notes/digests/").status_code, 401)
        self.client.force_login(self.user)
        self.assertEqual(self.client.get(f"/api/notes/digests/{foreign.id}/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/notes/digests/{foreign.id}/retry/").status_code, 404)


@override_settings(CELERY_TASK_ALWAYS_EAGER=False)
class DigestBeatTests(DigestFixtureMixin, TestCase):
    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_beat_targets_only_users_with_previous_local_day_edits(self, enqueue) -> None:
        target_user_note = self.note_at(datetime(2026, 8, 2, 3, 0, tzinfo=UTC))
        other_day_user = get_user_model().objects.create_user(phone="13800003003", password="test-password")
        other_day_note = Note.objects.create(user=other_day_user, title="今天之外")
        Note.objects.filter(pk=other_day_note.pk).update(last_edited_at=datetime(2026, 8, 2, 16, 0, tzinfo=UTC))

        result = create_previous_day_digests_task(now_iso="2026-08-03T02:10:00+08:00")

        self.assertEqual(result, {"date": "2026-08-02", "created": 1})
        digest = NoteDailyDigest.objects.get()
        self.assertEqual(digest.user_id, target_user_note.user_id)
        self.assertEqual(digest.idempotency_key, f"auto:{self.user.pk}:2026-08-02")

    @patch("backend.apps.notes.services.digest_service.enqueue_digest")
    def test_beat_excludes_target_day_delete_even_after_next_day_restore(self, enqueue) -> None:
        note = self.note_at(datetime(2026, 8, 1, 3, 0, tzinfo=UTC))
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 2, 3, 0, tzinfo=UTC)):
            note = save_note(self.user, note.id, {
                "baseVersion": note.version,
                "clientMutationId": str(uuid.uuid4()),
                "source": "autosave",
                "content": {"type": "doc", "content": []},
            }).note
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 2, 4, 0, tzinfo=UTC)):
            soft_delete_note(self.user, note.id)
        with patch("backend.apps.notes.services.note_service.timezone.now", return_value=datetime(2026, 8, 3, 3, 0, tzinfo=UTC)):
            restore_deleted_note(self.user, note.id)

        result = create_previous_day_digests_task(now_iso="2026-08-03T10:10:00+08:00")

        self.assertEqual(result, {"date": "2026-08-02", "created": 0})
        self.assertFalse(NoteDailyDigest.objects.exists())
        enqueue.assert_not_called()

    def test_settings_preserve_existing_beat_entries_and_add_digest_at_0210(self) -> None:
        from django.conf import settings

        self.assertIn("a3-evaluate-optimization-policy-outcomes-daily", settings.CELERY_BEAT_SCHEDULE)
        entry = settings.CELERY_BEAT_SCHEDULE["a3-notes-create-previous-day-digests"]
        self.assertEqual(entry["task"], "notes.create_previous_day_digests")
        self.assertEqual(str(entry["schedule"]), "<crontab: 10 2 * * * (m/h/dM/MY/d)>")
