from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from backend.apps.notes.models import (
    Note,
    NoteAiMessage,
    NoteAiSession,
    NoteAuditEvent,
    NoteRevision,
    NoteWritebackPreview,
)


class WritebackApiTests(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800001011", password="test-pass")
        self.other_user = user_model.objects.create_user(phone="13800001012", password="test-pass")
        self.note = Note.objects.create(
            user=self.user,
            title="进程复习",
            content_json=self.document("原始正文"),
            content_text="原始正文",
            version=3,
        )
        self.session = NoteAiSession.objects.create(
            user=self.user,
            title="写回建议",
            scope_type=NoteAiSession.ScopeType.NOTE,
            scope_snapshot={
                "type": "note",
                "notes": [{"id": str(self.note.id), "version": self.note.version}],
            },
        )
        self.message = NoteAiMessage.objects.create(
            session=self.session,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.SUCCEEDED,
            content="补充：进程是资源分配的基本单位。\n线程是调度的基本单位。",
            verified=True,
        )
        self.client.force_login(self.user)

    @staticmethod
    def document(text: str) -> dict:
        return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}

    def post_json(self, path: str, payload: dict | None = None):
        return self.client.post(path, data=json.dumps(payload or {}), content_type="application/json")

    def create_preview(self):
        return self.post_json(
            "/api/notes/assistant/writeback-previews/",
            {"targetNoteId": str(self.note.id), "messageId": str(self.message.id)},
        )

    def test_create_preview_persists_pending_without_changing_note_or_revision(self):
        original_content = self.note.content_json
        revision_count = NoteRevision.objects.filter(note=self.note).count()

        response = self.create_preview()

        self.assertEqual(response.status_code, 201)
        payload = response.json()["preview"]
        self.note.refresh_from_db()
        self.assertEqual(self.note.content_json, original_content)
        self.assertEqual(self.note.version, 3)
        self.assertEqual(NoteRevision.objects.filter(note=self.note).count(), revision_count)
        preview = NoteWritebackPreview.objects.get(pk=payload["id"])
        self.assertEqual(preview.status, NoteWritebackPreview.Status.PENDING)
        self.assertEqual(preview.target_version, 3)
        self.assertEqual(preview.source_message_id, self.message.id)
        self.assertGreaterEqual(preview.expires_at, timezone.now() + timedelta(minutes=29))
        self.assertEqual(payload["targetNote"]["title"], "进程复习")
        self.assertEqual(payload["targetVersion"], 3)
        self.assertTrue(payload["diff"]["changedBlocks"])

    def test_create_requires_authentication_and_hides_foreign_objects(self):
        self.client.logout()
        unauthenticated = self.create_preview()
        self.assertEqual(unauthenticated.status_code, 401)

        self.client.force_login(self.other_user)
        foreign = self.create_preview()
        self.assertEqual(foreign.status_code, 404)
        self.assertFalse(foreign.json()["success"])
        self.assertFalse(NoteWritebackPreview.objects.exists())

    def test_create_rejects_ineligible_or_out_of_scope_message(self):
        self.message.status = NoteAiMessage.Status.STREAMING
        self.message.save(update_fields={"status"})
        ineligible = self.create_preview()
        self.assertEqual(ineligible.status_code, 403)

        self.message.status = NoteAiMessage.Status.SUCCEEDED
        self.message.save(update_fields={"status"})
        self.session.scope_snapshot = {"type": "note", "notes": [{"id": str(uuid.uuid4()), "version": 3}]}
        self.session.save(update_fields={"scope_snapshot"})
        out_of_scope = self.create_preview()
        self.assertEqual(out_of_scope.status_code, 403)
        self.assertEqual(out_of_scope.json()["code"], "writeback_source_not_permitted")
        self.assertFalse(NoteWritebackPreview.objects.exists())

    def test_create_rejects_older_snapshot_version_without_any_mutation(self):
        Note.objects.filter(pk=self.note.id).update(
            content_json=self.document("用户更新后的正文"), content_text="用户更新后的正文", version=4
        )
        original_revision_count = NoteRevision.objects.filter(note=self.note).count()

        with patch("backend.apps.notes.services.writeback_service._generate_proposed_document") as generate:
            response = self.create_preview()

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "writeback_source_stale")
        self.assertIn("正文已更新，请重新提问并生成建议", response.json()["error"])
        generate.assert_not_called()
        self.note.refresh_from_db()
        self.assertEqual(self.note.version, 4)
        self.assertEqual(self.note.content_text, "用户更新后的正文")
        self.assertFalse(NoteWritebackPreview.objects.exists())
        self.assertEqual(NoteRevision.objects.filter(note=self.note).count(), original_revision_count)
        self.assertFalse(NoteAuditEvent.objects.exists())

    def test_create_rejects_missing_or_malformed_snapshot_version_before_proposal(self):
        invalid_versions = (None, "3", True, 0)
        original_content = self.note.content_json
        original_revision_count = NoteRevision.objects.filter(note=self.note).count()
        for invalid_version in invalid_versions:
            with self.subTest(version=invalid_version):
                item = {"id": str(self.note.id)}
                if invalid_version is not None:
                    item["version"] = invalid_version
                self.session.scope_snapshot = {"type": "note", "notes": [item]}
                self.session.save(update_fields={"scope_snapshot"})
                with patch("backend.apps.notes.services.writeback_service._generate_proposed_document") as generate:
                    response = self.create_preview()
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["code"], "writeback_source_stale")
                generate.assert_not_called()
                self.note.refresh_from_db()
                self.assertEqual(self.note.version, 3)
                self.assertEqual(self.note.content_json, original_content)
                self.assertFalse(NoteWritebackPreview.objects.exists())
                self.assertEqual(NoteRevision.objects.filter(note=self.note).count(), original_revision_count)
                self.assertFalse(NoteAuditEvent.objects.exists())

    def test_multi_note_and_notebook_scopes_use_the_exact_target_entry(self):
        for scope_type in ("selection", "notebook"):
            with self.subTest(scope_type=scope_type):
                self.session.scope_type = scope_type
                self.session.scope_snapshot = {
                    "type": scope_type,
                    "notes": [
                        {"id": str(uuid.uuid4()), "version": 99},
                        {"id": str(self.note.id), "version": 3},
                    ],
                }
                self.session.save(update_fields={"scope_type", "scope_snapshot"})
                response = self.create_preview()
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.json()["preview"]["targetVersion"], 3)
                NoteWritebackPreview.objects.all().delete()

    def test_create_rejects_malformed_generated_document_and_diff_without_writing(self):
        with patch(
            "backend.apps.notes.services.writeback_service._generate_proposed_document",
            return_value={"type": "not-a-doc"},
        ):
            malformed_document = self.create_preview()
        self.assertEqual(malformed_document.status_code, 400)
        self.assertEqual(malformed_document.json()["code"], "invalid_writeback_document")

        with patch(
            "backend.apps.notes.services.writeback_service._build_structural_diff",
            return_value={"additions": "not-a-list", "removals": [], "changedBlocks": []},
        ):
            malformed_diff = self.create_preview()
        self.assertEqual(malformed_diff.status_code, 400)
        self.assertEqual(malformed_diff.json()["code"], "invalid_writeback_diff")
        self.note.refresh_from_db()
        self.assertEqual(self.note.content_text, "原始正文")
        self.assertFalse(NoteWritebackPreview.objects.exists())

    def test_confirm_applies_atomically_and_repeat_confirm_is_idempotent(self):
        preview_id = self.create_preview().json()["preview"]["id"]
        confirm_path = f"/api/notes/assistant/writeback-previews/{preview_id}/confirm/"

        first = self.post_json(confirm_path)
        second = self.post_json(confirm_path)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertFalse(first.json()["idempotent"])
        self.assertTrue(second.json()["idempotent"])
        self.note.refresh_from_db()
        self.assertEqual(self.note.version, 4)
        self.assertIn("线程是调度的基本单位", self.note.content_text)
        self.assertEqual(NoteRevision.objects.filter(note=self.note, source="ai_writeback").count(), 1)
        self.assertEqual(NoteAuditEvent.objects.filter(action="note.ai_writeback_applied").count(), 1)
        preview = NoteWritebackPreview.objects.get(pk=preview_id)
        self.assertEqual(preview.status, NoteWritebackPreview.Status.APPLIED)

    def test_confirm_rejects_stale_target_version_without_silent_write(self):
        preview_id = self.create_preview().json()["preview"]["id"]
        Note.objects.filter(pk=self.note.id).update(
            content_json=self.document("用户的新正文"), content_text="用户的新正文", version=4
        )

        response = self.post_json(f"/api/notes/assistant/writeback-previews/{preview_id}/confirm/")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "writeback_version_conflict")
        self.assertIn("正文已更新", response.json()["error"])
        self.note.refresh_from_db()
        self.assertEqual(self.note.content_text, "用户的新正文")
        self.assertFalse(NoteRevision.objects.filter(note=self.note, source="ai_writeback").exists())

    def test_expired_preview_cannot_apply(self):
        preview_id = self.create_preview().json()["preview"]["id"]
        NoteWritebackPreview.objects.filter(pk=preview_id).update(expires_at=timezone.now() - timedelta(seconds=1))

        response = self.post_json(f"/api/notes/assistant/writeback-previews/{preview_id}/confirm/")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "writeback_preview_expired")
        self.assertEqual(NoteWritebackPreview.objects.get(pk=preview_id).status, NoteWritebackPreview.Status.EXPIRED)
        self.note.refresh_from_db()
        self.assertEqual(self.note.version, 3)

    def test_abandon_is_idempotent_and_never_changes_note(self):
        preview_id = self.create_preview().json()["preview"]["id"]
        path = f"/api/notes/assistant/writeback-previews/{preview_id}/abandon/"

        first = self.post_json(path)
        second = self.post_json(path)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertFalse(first.json()["idempotent"])
        self.assertTrue(second.json()["idempotent"])
        self.assertEqual(NoteWritebackPreview.objects.get(pk=preview_id).status, NoteWritebackPreview.Status.ABANDONED)
        self.note.refresh_from_db()
        self.assertEqual(self.note.version, 3)
        self.assertFalse(NoteRevision.objects.filter(note=self.note, source="ai_writeback").exists())

    def test_foreign_confirm_and_abandon_are_not_found(self):
        preview_id = self.create_preview().json()["preview"]["id"]
        self.client.force_login(self.other_user)
        for action in ("confirm", "abandon"):
            response = self.post_json(f"/api/notes/assistant/writeback-previews/{preview_id}/{action}/")
            self.assertEqual(response.status_code, 404)
