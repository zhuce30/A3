from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment, NoteDailyDigest, NoteMemory
from backend.apps.notes.services import digest_service
from backend.apps.notes.tasks import (
    create_previous_day_digests_task,
    generate_daily_digest_task,
    recover_stale_digest_jobs,
)


UTC = datetime_timezone.utc


class DigestFixtureMixin:
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(phone="13800003001", password="test-password")
        self.other_user = get_user_model().objects.create_user(phone="13800003002", password="test-password")
        self.target_date = date(2026, 8, 2)

    def note_at(self, instant: datetime, *, title: str = "离散数学", body: str = "命题逻辑复习") -> Note:
        note = Note.objects.create(
            user=self.user,
            title=title,
            content_json={"type": "doc", "content": [{"type": "paragraph", "text": body}]},
            content_text=body,
            version=3,
        )
        Note.objects.filter(pk=note.pk).update(last_edited_at=instant)
        note.refresh_from_db()
        return note


class DigestSnapshotTests(DigestFixtureMixin, TestCase):
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

    @patch("backend.apps.notes.services.digest_service.generate_digest_markdown", return_value="# 8 月 2 日笔记总结\n\n- 命题逻辑")
    def test_generation_is_fenced_and_never_overwrites_a_newer_lease(self, generate) -> None:
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

    def test_settings_preserve_existing_beat_entries_and_add_digest_at_0210(self) -> None:
        from django.conf import settings

        self.assertIn("a3-evaluate-optimization-policy-outcomes-daily", settings.CELERY_BEAT_SCHEDULE)
        entry = settings.CELERY_BEAT_SCHEDULE["a3-notes-create-previous-day-digests"]
        self.assertEqual(entry["task"], "notes.create_previous_day_digests")
        self.assertEqual(str(entry["schedule"]), "<crontab: 10 2 * * * (m/h/dM/MY/d)>")
