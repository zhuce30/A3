from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.apps import apps
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment, NoteExportJob
from backend.apps.notes.services.export_service import build_note_export, create_export_job


EMPTY_DOC = {"type": "doc", "content": []}


def text_doc(value: str) -> dict:
    return {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": value}]}],
    }


class ExportTestCase(TestCase):
    def setUp(self) -> None:
        temp_parent = Path(__file__).resolve().parents[3] / "tmp" / "note-export-tests"
        temp_parent.mkdir(parents=True, exist_ok=True)
        self.storage = tempfile.TemporaryDirectory(dir=temp_parent)
        self.addCleanup(self.storage.cleanup)
        self.settings_override = override_settings(
            A3_NOTES_STORAGE_ROOT=Path(self.storage.name),
            A3_NOTES_EXPORT_MAX_BYTES=2 * 1024 * 1024,
            A3_NOTES_EXPORT_MAX_FILES=20,
            A3_NOTES_CLEANUP_BATCH_SIZE=20,
        )
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        users = get_user_model()
        self.user = users.objects.create_user(phone="13800004001", password="test-password")
        self.other_user = users.objects.create_user(phone="13800004002", password="test-password")
        self.note = Note.objects.create(
            user=self.user,
            title="进程调度",
            content_json=text_doc("snapshot body"),
            content_text="snapshot body",
        )
        self.foreign_note = Note.objects.create(
            user=self.other_user,
            title="他人笔记",
            content_json=text_doc("foreign secret"),
            content_text="foreign secret",
        )
        self.client.force_login(self.user)

    def create_attachment(
        self,
        *,
        note: Note | None = None,
        user=None,
        display_name: str = "讲义.txt",
        content: bytes = b"attachment body",
        deleted_at=None,
    ) -> NoteAttachment:
        note = note or self.note
        user = user or note.user
        attachment_id = uuid.uuid4()
        user_storage_id = uuid.uuid5(
            uuid.NAMESPACE_URL, f"urn:a3:personal-notes:user:{user.pk}"
        )
        relative_path = f"{user_storage_id}/{note.id}/{attachment_id}/payload.txt"
        path = Path(self.storage.name) / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return NoteAttachment.objects.create(
            id=attachment_id,
            user=user,
            note=note,
            kind=NoteAttachment.Kind.FILE,
            display_name=display_name,
            relative_path=relative_path,
            mime_type="text/plain",
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            deleted_at=deleted_at,
        )

    def open_job(self, job: NoteExportJob) -> zipfile.ZipFile:
        job.refresh_from_db()
        return zipfile.ZipFile(Path(self.storage.name) / job.relative_path)


class ExportBuildTests(ExportTestCase):
    def test_export_contains_only_requested_owned_notes(self) -> None:
        job = create_export_job(
            user=self.user,
            note_ids=[self.note.id, self.foreign_note.id, uuid.uuid4()],
            format=NoteExportJob.Format.MARKDOWN_ZIP,
        )

        result = build_note_export(str(job.id))

        self.assertEqual(result["status"], NoteExportJob.Status.SUCCEEDED)
        self.assertEqual(job.selection_snapshot["notes"], [{
            "id": str(self.note.id),
            "version": 1,
            "title": "进程调度",
            "content": text_doc("snapshot body"),
            "contentText": "snapshot body",
            "attachments": [],
        }])
        with self.open_job(job) as archive:
            self.assertIn("notes/进程调度.md", archive.namelist())
            self.assertNotIn("notes/他人笔记.md", archive.namelist())
            self.assertNotIn(b"foreign secret", b"".join(archive.read(name) for name in archive.namelist()))

    def test_export_uses_creation_snapshot_after_note_changes(self) -> None:
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="json_zip")
        self.note.title = "new title"
        self.note.content_json = text_doc("new body")
        self.note.content_text = "new body"
        self.note.version = 2
        self.note.save()

        build_note_export(str(job.id))

        with self.open_job(job) as archive:
            note_name = next(name for name in archive.namelist() if name.startswith("notes/") and name.endswith(".json"))
            payload = json.loads(archive.read(note_name))
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(payload["title"], "进程调度")
        self.assertEqual(payload["contentText"], "snapshot body")
        self.assertEqual(payload["version"], 1)
        self.assertEqual(manifest["schemaVersion"], "a3.personal-notes-export.v1")
        self.assertEqual(manifest["notes"][0]["version"], 1)

    def test_note_deleted_after_request_fails_without_archive(self) -> None:
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        self.note.deleted_at = timezone.now()
        self.note.save(update_fields={"deleted_at", "updated_at"})

        result = build_note_export(str(job.id))

        job.refresh_from_db()
        self.assertEqual(result["status"], NoteExportJob.Status.FAILED)
        self.assertEqual(job.error_code, "export_snapshot_unavailable")
        self.assertEqual(job.relative_path, "")

    def test_attachment_is_streamed_into_archive_and_deleted_attachment_is_excluded(self) -> None:
        included = self.create_attachment()
        self.create_attachment(display_name="deleted.txt", content=b"deleted", deleted_at=timezone.now())
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")

        build_note_export(str(job.id))

        with self.open_job(job) as archive:
            attachment_names = [name for name in archive.namelist() if name.startswith("attachments/")]
            self.assertEqual(len(attachment_names), 1)
            self.assertEqual(archive.read(attachment_names[0]), b"attachment body")
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["notes"][0]["attachments"][0]["id"], str(included.id))
        self.assertNotIn(str(Path(self.storage.name).resolve()), json.dumps(manifest, ensure_ascii=False))

    def test_traversal_and_symlink_attachment_paths_fail_closed(self) -> None:
        attachment = self.create_attachment()
        NoteAttachment.objects.filter(pk=attachment.pk).update(relative_path="../outside.txt")
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        result = build_note_export(str(job.id))
        self.assertEqual(result["status"], NoteExportJob.Status.FAILED)

        attachment.refresh_from_db()
        outside = Path(self.storage.name).parent / f"outside-{uuid.uuid4()}.txt"
        outside.write_bytes(b"outside")
        self.addCleanup(outside.unlink, missing_ok=True)
        link = Path(self.storage.name) / "link.txt"
        try:
            os.symlink(outside, link)
        except OSError:
            return
        NoteAttachment.objects.filter(pk=attachment.pk).update(relative_path="link.txt")
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        result = build_note_export(str(job.id))
        self.assertEqual(result["status"], NoteExportJob.Status.FAILED)

    def test_symlinked_export_directory_cannot_redirect_output_outside_root(self) -> None:
        outside = Path(self.storage.name).parent / f"export-escape-{uuid.uuid4()}"
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside, True)
        try:
            os.symlink(outside, Path(self.storage.name) / "exports", target_is_directory=True)
        except OSError:
            return
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")

        result = build_note_export(str(job.id))

        self.assertEqual(result["status"], NoteExportJob.Status.FAILED)
        self.assertEqual(list(outside.rglob("*.zip")), [])

    def test_internal_target_attachment_symlinks_are_rejected_at_final_and_intermediate_components(self) -> None:
        attachment = self.create_attachment()
        original = Path(self.storage.name) / attachment.relative_path
        internal_target = Path(self.storage.name) / "internal-attachment-target.txt"
        original.replace(internal_target)
        try:
            os.symlink(internal_target, original)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        final_job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")

        final_result = build_note_export(str(final_job.id))

        self.assertEqual(final_result["status"], NoteExportJob.Status.FAILED)

        original.unlink()
        original.parent.rmdir()
        internal_directory = Path(self.storage.name) / "internal-attachment-directory"
        internal_directory.mkdir()
        (internal_directory / original.name).write_bytes(b"attachment body")
        os.symlink(internal_directory, original.parent, target_is_directory=True)
        intermediate_job = create_export_job(
            user=self.user, note_ids=[self.note.id], format="markdown_zip"
        )

        intermediate_result = build_note_export(str(intermediate_job.id))

        self.assertEqual(intermediate_result["status"], NoteExportJob.Status.FAILED)

    def test_internal_target_output_symlinks_are_rejected_at_intermediate_and_final_components(self) -> None:
        internal_exports = Path(self.storage.name) / "internal-exports"
        internal_exports.mkdir()
        try:
            os.symlink(internal_exports, Path(self.storage.name) / "exports", target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        intermediate_job = create_export_job(
            user=self.user, note_ids=[self.note.id], format="markdown_zip"
        )
        self.assertEqual(
            build_note_export(str(intermediate_job.id))["status"], NoteExportJob.Status.FAILED
        )

        (Path(self.storage.name) / "exports").unlink()
        final_job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        final_parent = (
            Path(self.storage.name) / "exports" / str(self.user.id) / str(final_job.id)
        )
        final_parent.mkdir(parents=True)
        internal_target = Path(self.storage.name) / "internal-output.zip"
        internal_target.write_bytes(b"keep")
        os.symlink(internal_target, final_parent / f"notes-{final_job.id}.zip")

        final_result = build_note_export(str(final_job.id))

        self.assertEqual(final_result["status"], NoteExportJob.Status.FAILED)
        self.assertEqual(internal_target.read_bytes(), b"keep")

    def test_duplicate_unicode_names_are_normalized_and_deduped(self) -> None:
        second = Note.objects.create(
            user=self.user, title="Ａ", content_json=EMPTY_DOC, content_text="second"
        )
        self.note.title = "A"
        self.note.save(update_fields={"title", "updated_at"})
        job = create_export_job(user=self.user, note_ids=[self.note.id, second.id], format="markdown_zip")

        build_note_export(str(job.id))

        with self.open_job(job) as archive:
            notes = sorted(name for name in archive.namelist() if name.startswith("notes/"))
        self.assertEqual(notes, ["notes/A (2).md", "notes/A.md"])

    def test_build_is_idempotent_and_persists_digest_and_size(self) -> None:
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        first = build_note_export(str(job.id))
        job.refresh_from_db()
        first_path = job.relative_path
        first_digest = job.output_sha256

        second = build_note_export(str(job.id))

        job.refresh_from_db()
        self.assertEqual(first, second)
        self.assertEqual(job.relative_path, first_path)
        self.assertEqual(len(first_digest), 64)
        self.assertEqual(job.output_sha256, first_digest)
        self.assertEqual(job.output_size_bytes, (Path(self.storage.name) / first_path).stat().st_size)

    def test_export_does_not_create_knowledge_base_rows(self) -> None:
        kb_models = list(apps.get_app_config("knowledge_base").get_models())
        before = {model: model.objects.count() for model in kb_models}
        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")

        build_note_export(str(job.id))

        self.assertEqual({model: model.objects.count() for model in kb_models}, before)


class ExportApiTests(ExportTestCase):
    @patch("backend.apps.notes.tasks.build_export_task.delay")
    def test_create_status_and_download_endpoints_are_authenticated(self, delay) -> None:
        response = self.client.post(
            reverse("notes:export-list"),
            data=json.dumps({"noteIds": [str(self.note.id), str(self.foreign_note.id)], "format": "markdown_zip"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 202)
        job = NoteExportJob.objects.get()
        delay.assert_called_once_with(str(job.id))
        self.assertEqual(response.json()["export"]["selection"]["noteCount"], 1)

        build_note_export(str(job.id))
        detail = self.client.get(reverse("notes:export-detail", args=[job.id]))
        self.assertEqual(detail.status_code, 200)
        download = self.client.get(reverse("notes:export-download", args=[job.id]))
        self.assertEqual(download.status_code, 200)
        self.assertTrue(download.streaming)
        download.close()

        self.client.logout()
        self.assertEqual(self.client.get(reverse("notes:export-detail", args=[job.id])).status_code, 401)

    @patch("backend.apps.notes.tasks.build_export_task.delay", side_effect=RuntimeError("broker secret"))
    def test_broker_failure_is_visible_after_durable_creation(self, _delay) -> None:
        response = self.client.post(
            reverse("notes:export-list"),
            data=json.dumps({"noteIds": [str(self.note.id)], "format": "json_zip"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 202)
        job = NoteExportJob.objects.get()
        self.assertEqual(job.status, NoteExportJob.Status.FAILED)
        self.assertEqual(job.error_code, "export_enqueue_failed")
        self.assertNotIn("broker", response.content.decode("utf-8"))

    def test_expired_foreign_missing_and_incomplete_download_responses(self) -> None:
        queued = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        not_ready = self.client.get(reverse("notes:export-download", args=[queued.id]))
        self.assertEqual(not_ready.status_code, 409)
        self.assertEqual(not_ready.json()["code"], "export_not_ready")

        expired = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        expired.expires_at = timezone.now() - timedelta(seconds=1)
        expired.save(update_fields={"expires_at", "updated_at"})
        self.assertEqual(self.client.get(reverse("notes:export-download", args=[expired.id])).status_code, 410)

        foreign = NoteExportJob.objects.create(
            user=self.other_user, format="markdown_zip", selection_snapshot={"notes": []}
        )
        self.assertEqual(self.client.get(reverse("notes:export-detail", args=[foreign.id])).status_code, 404)
        self.assertEqual(self.client.get(reverse("notes:export-download", args=[uuid.uuid4()])).status_code, 404)

    def test_download_rejects_internal_target_final_and_intermediate_symlinks(self) -> None:
        final_job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        build_note_export(str(final_job.id))
        final_job.refresh_from_db()
        final_path = Path(self.storage.name) / final_job.relative_path
        internal_target = Path(self.storage.name) / "internal-download.zip"
        final_path.replace(internal_target)
        try:
            os.symlink(internal_target, final_path)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        final_response = self.client.get(reverse("notes:export-download", args=[final_job.id]))
        final_status = final_response.status_code
        final_response.close()
        self.assertEqual(final_status, 404)

        final_path.unlink()
        intermediate_job = create_export_job(
            user=self.user, note_ids=[self.note.id], format="markdown_zip"
        )
        build_note_export(str(intermediate_job.id))
        intermediate_job.refresh_from_db()
        job_directory = (Path(self.storage.name) / intermediate_job.relative_path).parent
        real_directory = Path(self.storage.name) / "internal-download-directory"
        job_directory.replace(real_directory)
        os.symlink(real_directory, job_directory, target_is_directory=True)
        intermediate_response = self.client.get(
            reverse("notes:export-download", args=[intermediate_job.id])
        )
        intermediate_status = intermediate_response.status_code
        intermediate_response.close()
        self.assertEqual(intermediate_status, 404)


class ExportCleanupAndScheduleTests(ExportTestCase):
    def test_completed_expired_rows_do_not_starve_newer_cleanup_batches(self) -> None:
        from backend.apps.notes.services.cleanup_service import cleanup_expired_exports

        old_time = timezone.now() - timedelta(days=2)
        for _ in range(3):
            NoteExportJob.objects.create(
                user=self.user,
                format="markdown_zip",
                status=NoteExportJob.Status.EXPIRED,
                selection_snapshot={"notes": []},
                expires_at=old_time,
                error_code="export_expired",
            )
        eligible: list[NoteExportJob] = []
        for _ in range(2):
            job = create_export_job(
                user=self.user, note_ids=[self.note.id], format="markdown_zip"
            )
            build_note_export(str(job.id))
            NoteExportJob.objects.filter(pk=job.pk).update(expires_at=timezone.now() - timedelta(hours=1))
            eligible.append(job)

        with self.captureOnCommitCallbacks(execute=True):
            first = cleanup_expired_exports(limit=2)
        with self.captureOnCommitCallbacks(execute=True):
            second = cleanup_expired_exports(limit=2)

        self.assertEqual(first["exportsCleaned"], 2)
        self.assertEqual(second["exportsCleaned"], 0)
        for job in eligible:
            job.refresh_from_db()
            self.assertEqual(job.status, NoteExportJob.Status.EXPIRED)
            self.assertEqual(job.relative_path, "")

    def test_failed_export_unlink_keeps_state_and_retries_next_cleanup(self) -> None:
        from backend.apps.notes.services.cleanup_service import cleanup_expired_exports

        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        build_note_export(str(job.id))
        job.refresh_from_db()
        path = Path(self.storage.name) / job.relative_path
        original_relative = job.relative_path
        original_size = job.output_size_bytes
        original_sha = job.output_sha256
        NoteExportJob.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )

        with patch.object(Path, "unlink", side_effect=OSError("locked")):
            with self.captureOnCommitCallbacks(execute=True):
                cleanup_expired_exports(limit=1)

        job.refresh_from_db()
        self.assertTrue(path.exists())
        self.assertEqual(job.status, NoteExportJob.Status.SUCCEEDED)
        self.assertEqual(job.relative_path, original_relative)
        self.assertEqual(job.output_size_bytes, original_size)
        self.assertEqual(job.output_sha256, original_sha)
        self.assertEqual(
            self.client.get(reverse("notes:export-download", args=[job.id])).status_code,
            410,
        )

        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_exports(limit=1)

        job.refresh_from_db()
        self.assertFalse(path.exists())
        self.assertEqual(job.status, NoteExportJob.Status.EXPIRED)
        self.assertEqual(job.relative_path, "")
        self.assertEqual(job.output_size_bytes, 0)
        self.assertEqual(job.output_sha256, "")

    def test_cleanup_rejects_internal_target_final_and_intermediate_symlinks(self) -> None:
        from backend.apps.notes.services.cleanup_service import cleanup_expired_exports

        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        build_note_export(str(job.id))
        job.refresh_from_db()
        path = Path(self.storage.name) / job.relative_path
        internal_target = Path(self.storage.name) / "internal-cleanup.zip"
        path.replace(internal_target)
        try:
            os.symlink(internal_target, path)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        NoteExportJob.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )

        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_exports(limit=1)

        job.refresh_from_db()
        self.assertTrue(internal_target.exists())
        self.assertEqual(job.status, NoteExportJob.Status.SUCCEEDED)
        self.assertNotEqual(job.relative_path, "")

        path.unlink()
        real_directory = Path(self.storage.name) / "internal-cleanup-directory"
        path.parent.replace(real_directory)
        os.symlink(real_directory, path.parent, target_is_directory=True)
        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_exports(limit=1)

        job.refresh_from_db()
        self.assertTrue(internal_target.exists())
        self.assertEqual(job.status, NoteExportJob.Status.SUCCEEDED)
        self.assertNotEqual(job.relative_path, "")

    def test_stale_queued_export_is_reenqueued_once_not_every_schedule_tick(self) -> None:
        from backend.apps.notes.tasks import cleanup_stale_jobs_task

        job = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        NoteExportJob.objects.filter(pk=job.pk).update(
            updated_at=timezone.now() - timedelta(hours=2)
        )

        with patch("backend.apps.notes.tasks.build_export_task.delay") as delay:
            cleanup_stale_jobs_task()
            cleanup_stale_jobs_task()

        self.assertEqual(delay.call_count, 1)

    def test_stale_export_fails_and_stale_parse_recovers_without_touching_fresh_work(self) -> None:
        from backend.apps.notes.tasks import cleanup_stale_jobs_task

        stale_export = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        NoteExportJob.objects.filter(pk=stale_export.pk).update(
            status=NoteExportJob.Status.PROCESSING,
            updated_at=timezone.now() - timedelta(hours=2),
        )
        stale_parse = self.create_attachment()
        fresh_parse = self.create_attachment(display_name="fresh.txt")
        NoteAttachment.objects.filter(pk=stale_parse.pk).update(
            parse_status=NoteAttachment.ParseStatus.PROCESSING,
            parse_started_at=timezone.now() - timedelta(hours=2),
            parse_attempts=1,
            parse_lease_token=uuid.uuid4(),
        )
        NoteAttachment.objects.filter(pk=fresh_parse.pk).update(
            parse_status=NoteAttachment.ParseStatus.PROCESSING,
            parse_started_at=timezone.now(),
            parse_attempts=1,
            parse_lease_token=uuid.uuid4(),
        )

        with patch("backend.apps.notes.tasks.parse_attachment_task.delay") as delay:
            result = cleanup_stale_jobs_task()

        stale_export.refresh_from_db()
        stale_parse.refresh_from_db()
        fresh_parse.refresh_from_db()
        self.assertEqual(stale_export.status, NoteExportJob.Status.FAILED)
        self.assertEqual(stale_export.error_code, "export_stale")
        self.assertEqual(stale_parse.parse_status, NoteAttachment.ParseStatus.PENDING)
        self.assertEqual(fresh_parse.parse_status, NoteAttachment.ParseStatus.PROCESSING)
        self.assertEqual(delay.call_count, 1)
        self.assertEqual(result["parseRecovered"], 1)

    def test_expired_cleanup_is_contained_and_does_not_delete_other_user_export(self) -> None:
        from backend.apps.notes.tasks import cleanup_expired_exports_task

        expired = create_export_job(user=self.user, note_ids=[self.note.id], format="markdown_zip")
        build_note_export(str(expired.id))
        expired.refresh_from_db()
        own_path = Path(self.storage.name) / expired.relative_path
        NoteExportJob.objects.filter(pk=expired.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        other = NoteExportJob.objects.create(
            user=self.other_user,
            format="json_zip",
            status=NoteExportJob.Status.SUCCEEDED,
            selection_snapshot={"notes": []},
            relative_path="exports/other/keep.zip",
            expires_at=timezone.now() + timedelta(hours=1),
        )
        other_path = Path(self.storage.name) / other.relative_path
        other_path.parent.mkdir(parents=True, exist_ok=True)
        other_path.write_bytes(b"keep")
        outside = Path(self.storage.name).parent / f"keep-{uuid.uuid4()}.zip"
        outside.write_bytes(b"outside")
        self.addCleanup(outside.unlink, missing_ok=True)
        malicious = NoteExportJob.objects.create(
            user=self.user,
            format="json_zip",
            status=NoteExportJob.Status.SUCCEEDED,
            selection_snapshot={"notes": []},
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        NoteExportJob.objects.filter(pk=malicious.pk).update(relative_path="../" + outside.name)

        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_exports_task()

        expired.refresh_from_db()
        malicious.refresh_from_db()
        self.assertEqual(expired.status, NoteExportJob.Status.EXPIRED)
        self.assertEqual(expired.relative_path, "")
        self.assertFalse(own_path.exists())
        self.assertTrue(other_path.exists())
        self.assertTrue(outside.exists())
        self.assertEqual(malicious.status, NoteExportJob.Status.SUCCEEDED)
        self.assertEqual(malicious.relative_path, "../" + outside.name)

    def test_trash_cleanup_purges_rows_and_physical_files_without_cross_user_deletion(self) -> None:
        from backend.apps.notes.tasks import cleanup_trashed_notes_task

        own_attachment = self.create_attachment()
        own_path = Path(self.storage.name) / own_attachment.relative_path
        Note.objects.filter(pk=self.note.pk).update(deleted_at=timezone.now() - timedelta(days=31))
        other_attachment = self.create_attachment(
            note=self.foreign_note, user=self.other_user, display_name="other.txt", content=b"other"
        )
        other_path = Path(self.storage.name) / other_attachment.relative_path

        with self.captureOnCommitCallbacks(execute=True):
            cleanup_trashed_notes_task()

        self.assertFalse(Note.objects.filter(pk=self.note.pk).exists())
        self.assertFalse(own_path.exists())
        self.assertTrue(Note.objects.filter(pk=self.foreign_note.pk).exists())
        self.assertTrue(other_path.exists())

    def test_soft_deleted_attachment_cleanup_remains_quota_accounted_until_bounded_purge(self) -> None:
        from backend.apps.notes.tasks import cleanup_trashed_notes_task

        attachment = self.create_attachment(deleted_at=timezone.now() - timedelta(days=2))
        path = Path(self.storage.name) / attachment.relative_path
        with self.captureOnCommitCallbacks(execute=True):
            result = cleanup_trashed_notes_task()
        self.assertFalse(NoteAttachment.objects.filter(pk=attachment.pk).exists())
        self.assertFalse(path.exists())
        self.assertEqual(result["attachmentsPurged"], 1)

    def test_beat_schedule_preserves_policy_and_uses_explicit_local_crontabs(self) -> None:
        from django.conf import settings

        schedule = settings.CELERY_BEAT_SCHEDULE
        self.assertIn("a3-evaluate-optimization-policy-outcomes-daily", schedule)
        self.assertEqual(schedule["a3-notes-cleanup-expired-exports-daily"]["task"], "notes.cleanup_expired_exports")
        self.assertEqual(schedule["a3-notes-cleanup-trash-daily"]["task"], "notes.cleanup_trashed_notes")
        self.assertEqual(schedule["a3-notes-cleanup-stale-jobs-quarter-hour"]["task"], "notes.cleanup_stale_jobs")
        self.assertEqual(str(schedule["a3-notes-cleanup-stale-jobs-quarter-hour"]["schedule"]), "<crontab: */15 * * * * (m/h/dM/MY/d)>")
        self.assertEqual(settings.TIME_ZONE, "Asia/Shanghai")
        self.assertTrue(settings.CELERY_ENABLE_UTC)
        self.assertEqual(settings.CELERY_TIMEZONE, "Asia/Shanghai")
