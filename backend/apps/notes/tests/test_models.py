from __future__ import annotations

from datetime import timedelta
import uuid

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from backend.apps.notes.models import (
    Note,
    NoteAiMessage,
    NoteAiSession,
    NoteAttachment,
    NoteAuditEvent,
    NoteExportJob,
    NoteMemory,
    NoteMutation,
    Notebook,
    NoteTag,
    NoteWritebackPreview,
)


class NoteModelTests(TestCase):
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(
            phone="13800001001",
            password="test-password",
        )

    def test_new_note_has_expected_defaults(self) -> None:
        note = Note.objects.create(user=self.user, title="First note")

        self.assertEqual(note.version, 1)
        self.assertIsNone(note.notebook)
        self.assertIsNone(note.deleted_at)

    def test_normalized_tag_names_are_unique_per_user(self) -> None:
        NoteTag.objects.create(user=self.user, name="  Study Plan  ")

        with self.assertRaises(ValidationError):
            NoteTag.objects.create(user=self.user, name="study plan")

        other_user = get_user_model().objects.create_user(
            phone="13800001002",
            password="test-password",
        )
        other_tag = NoteTag.objects.create(user=other_user, name="STUDY PLAN")
        self.assertEqual(other_tag.normalized_name, "study plan")

    def test_tag_name_update_refreshes_normalized_fields(self) -> None:
        tag = NoteTag.objects.create(user=self.user, name="Draft")

        tag.name = "  STRASSE  "
        tag.save(update_fields={"name"})
        tag.refresh_from_db()

        self.assertEqual(tag.name, "STRASSE")
        self.assertEqual(tag.normalized_name, "strasse")
        self.assertEqual(len(tag.normalized_key), 64)

    def test_tag_normalization_handles_unicode_casefold_expansion(self) -> None:
        tag = NoteTag.objects.create(user=self.user, name="  Stra\u00dfe  ")

        self.assertEqual(tag.normalized_name, "strasse")

    def test_accent_distinct_tags_do_not_collide(self) -> None:
        plain = NoteTag.objects.create(user=self.user, name="resume")
        accented = NoteTag.objects.create(user=self.user, name="r\u00e9sum\u00e9")

        self.assertNotEqual(plain.normalized_key, accented.normalized_key)


class TenantOwnershipTests(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800001101", password="test-password")
        self.other_user = user_model.objects.create_user(phone="13800001102", password="test-password")
        self.note = Note.objects.create(user=self.user, title="Owned note")
        self.other_note = Note.objects.create(user=self.other_user, title="Other note")

    def test_note_rejects_another_users_notebook_and_accepts_own(self) -> None:
        own_notebook = Notebook.objects.create(user=self.user, name="Mine")
        other_notebook = Notebook.objects.create(user=self.other_user, name="Other")

        saved = Note.objects.create(user=self.user, notebook=own_notebook, title="Valid")
        self.assertEqual(saved.notebook, own_notebook)
        with self.assertRaises(ValidationError):
            Note.objects.create(user=self.user, notebook=other_notebook, title="Invalid")

    def test_note_mutation_rejects_another_users_note_and_accepts_own(self) -> None:
        mutation = NoteMutation.objects.create(user=self.user, note=self.note, resulting_version=2)
        self.assertEqual(mutation.note, self.note)
        with self.assertRaises(ValidationError):
            NoteMutation.objects.create(user=self.user, note=self.other_note, resulting_version=2)

    def test_attachment_rejects_another_users_note_and_accepts_own(self) -> None:
        attachment = NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="notes.txt",
            relative_path="notes/files/notes.txt",
        )
        self.assertEqual(attachment.note, self.note)
        with self.assertRaises(ValidationError):
            NoteAttachment.objects.create(
                user=self.user,
                note=self.other_note,
                kind=NoteAttachment.Kind.FILE,
                display_name="other.txt",
                relative_path="notes/files/other.txt",
            )

    def test_writeback_preview_requires_one_user_across_relations(self) -> None:
        own_session = NoteAiSession.objects.create(
            user=self.user,
            scope_type=NoteAiSession.ScopeType.NOTE,
        )
        other_session = NoteAiSession.objects.create(
            user=self.other_user,
            scope_type=NoteAiSession.ScopeType.NOTE,
        )
        expires_at = timezone.now() + timedelta(minutes=10)

        preview = NoteWritebackPreview.objects.create(
            user=self.user,
            session=own_session,
            target_note=self.note,
            target_version=1,
            proposed_content_json={"type": "doc", "content": []},
            expires_at=expires_at,
        )
        self.assertEqual(preview.user, self.user)
        for session, target_note in ((other_session, self.note), (own_session, self.other_note)):
            with self.subTest(session=session.pk, target_note=target_note.pk), self.assertRaises(ValidationError):
                NoteWritebackPreview.objects.create(
                    user=self.user,
                    session=session,
                    target_note=target_note,
                    target_version=1,
                    proposed_content_json={"type": "doc", "content": []},
                    expires_at=expires_at,
                )

    def test_memory_sources_require_matching_owners_and_session(self) -> None:
        own_session = NoteAiSession.objects.create(user=self.user, scope_type=NoteAiSession.ScopeType.NOTE)
        second_own_session = NoteAiSession.objects.create(user=self.user, scope_type=NoteAiSession.ScopeType.NOTE)
        other_session = NoteAiSession.objects.create(user=self.other_user, scope_type=NoteAiSession.ScopeType.NOTE)
        own_message = NoteAiMessage.objects.create(
            session=own_session,
            role=NoteAiMessage.Role.USER,
        )
        second_own_message = NoteAiMessage.objects.create(
            session=second_own_session,
            role=NoteAiMessage.Role.USER,
        )
        other_message = NoteAiMessage.objects.create(
            session=other_session,
            role=NoteAiMessage.Role.USER,
        )

        memory = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            content="Valid source",
            source_session=own_session,
            source_message=own_message,
        )
        self.assertEqual(memory.source_message, own_message)
        invalid_sources = (
            (other_session, None),
            (None, other_message),
            (own_session, second_own_message),
        )
        for source_session, source_message in invalid_sources:
            with self.subTest(source_session=source_session, source_message=source_message), self.assertRaises(
                ValidationError
            ):
                NoteMemory.objects.create(
                    user=self.user,
                    memory_type=NoteMemory.MemoryType.CORE,
                    content="Invalid source",
                    source_session=source_session,
                    source_message=source_message,
                )

    def test_note_tags_reject_cross_user_add_and_accept_same_user(self) -> None:
        own_tag = NoteTag.objects.create(user=self.user, name="Mine")
        other_tag = NoteTag.objects.create(user=self.other_user, name="Other")

        self.note.tags.add(own_tag)
        self.assertTrue(self.note.tags.filter(pk=own_tag.pk).exists())
        with self.assertRaises(ValidationError), transaction.atomic():
            self.note.tags.add(other_tag)
        self.assertFalse(self.note.tags.filter(pk=other_tag.pk).exists())


class NoteMemoryModelTests(TestCase):
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(
            phone="13800001003",
            password="test-password",
        )

    def test_candidate_memory_is_not_usable(self) -> None:
        memory = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            content="Prefers concise explanations.",
            status=NoteMemory.Status.CANDIDATE,
        )

        self.assertFalse(memory.is_usable)

    def test_confirmed_effective_memory_is_usable(self) -> None:
        now = timezone.now()
        memory = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.EPISODIC,
            content="Review calculus next week.",
            status=NoteMemory.Status.CONFIRMED,
            valid_from=now - timedelta(minutes=1),
            valid_until=now + timedelta(minutes=1),
            confirmed_at=now,
        )

        self.assertTrue(memory.is_usable)

    def test_expired_or_deleted_memory_is_not_usable(self) -> None:
        now = timezone.now()
        expired = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.EPISODIC,
            content="An expired event.",
            status=NoteMemory.Status.CONFIRMED,
            valid_from=now - timedelta(days=2),
            valid_until=now - timedelta(days=1),
            confirmed_at=now - timedelta(days=2),
        )
        deleted = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            content="A deleted preference.",
            status=NoteMemory.Status.CONFIRMED,
            valid_from=now - timedelta(days=1),
            valid_until=now + timedelta(days=1),
            confirmed_at=now - timedelta(days=1),
            deleted_at=now,
        )

        self.assertFalse(expired.is_usable)
        self.assertFalse(deleted.is_usable)

    def test_memory_scores_reject_values_outside_allowed_ranges(self) -> None:
        invalid_scores = (
            {"importance": -0.01},
            {"importance": 5.01},
            {"confidence": -0.01},
            {"confidence": 1.01},
        )
        for values in invalid_scores:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                NoteMemory.objects.create(
                    user=self.user,
                    memory_type=NoteMemory.MemoryType.CORE,
                    content="Invalid score",
                    **values,
                )

    def test_memory_score_database_constraints_reject_invalid_updates(self) -> None:
        memory = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            content="Valid score",
        )
        for field, value in (("importance", 6), ("confidence", -1)):
            with self.subTest(field=field), self.assertRaises(IntegrityError), transaction.atomic():
                NoteMemory.objects.filter(pk=memory.pk).update(**{field: value})

    def test_memory_rejects_invalid_validity_window(self) -> None:
        now = timezone.now()
        with self.assertRaises(ValidationError):
            NoteMemory.objects.create(
                user=self.user,
                memory_type=NoteMemory.MemoryType.EPISODIC,
                content="Invalid window",
                valid_from=now,
                valid_until=now,
            )

    def test_confirmed_memory_requires_confirmation_timestamp(self) -> None:
        with self.assertRaises(ValidationError):
            NoteMemory.objects.create(
                user=self.user,
                memory_type=NoteMemory.MemoryType.CORE,
                content="Missing confirmation",
                status=NoteMemory.Status.CONFIRMED,
            )
        unsaved = NoteMemory(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            content="Not usable",
            status=NoteMemory.Status.CONFIRMED,
        )
        self.assertFalse(unsaved.is_usable)

    def test_memory_rejects_self_supersession(self) -> None:
        memory = NoteMemory.objects.create(
            user=self.user,
            memory_type=NoteMemory.MemoryType.CORE,
            content="Original",
        )
        memory.superseded_by = memory

        with self.assertRaises(ValidationError):
            memory.save()

    def test_memory_rejects_supersession_cycles(self) -> None:
        first = NoteMemory.objects.create(user=self.user, memory_type="core", content="First")
        second = NoteMemory.objects.create(user=self.user, memory_type="core", content="Second")
        third = NoteMemory.objects.create(user=self.user, memory_type="core", content="Third")
        first.superseded_by = second
        first.save()
        second.superseded_by = third
        second.save()
        third.superseded_by = first

        with self.assertRaises(ValidationError):
            third.save()


class PathAndKindValidationTests(TestCase):
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(phone="13800001201", password="test-password")
        self.note = Note.objects.create(user=self.user, title="Paths")

    def test_attachment_accepts_safe_relative_path(self) -> None:
        attachment = NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.IMAGE,
            display_name="figure.png",
            relative_path="notes/images/figure.png",
        )
        self.assertEqual(attachment.relative_path, "notes/images/figure.png")

    def test_attachment_rejects_absolute_and_traversal_paths(self) -> None:
        for path in ("/tmp/file.txt", "C:\\temp\\file.txt", "notes/../secret.txt", "notes\\file.txt", "notes//file.txt"):
            with self.subTest(path=path), self.assertRaises(ValidationError):
                NoteAttachment.objects.create(
                    user=self.user,
                    note=self.note,
                    kind=NoteAttachment.Kind.FILE,
                    display_name="file.txt",
                    relative_path=path,
                )

    def test_attachment_kind_requires_exactly_one_matching_location(self) -> None:
        invalid = (
            {"kind": NoteAttachment.Kind.LINK},
            {"kind": NoteAttachment.Kind.LINK, "source_url": "https://example.com", "relative_path": "file.txt"},
            {"kind": NoteAttachment.Kind.FILE},
            {"kind": NoteAttachment.Kind.IMAGE, "relative_path": "image.png", "source_url": "https://example.com"},
        )
        for fields in invalid:
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                NoteAttachment.objects.create(
                    user=self.user,
                    note=self.note,
                    display_name="resource",
                    **fields,
                )

        link = NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.LINK,
            display_name="Reference",
            source_url="https://example.com/reference",
        )
        self.assertEqual(link.source_url, "https://example.com/reference")

    def test_export_job_validates_relative_paths(self) -> None:
        job = NoteExportJob.objects.create(
            user=self.user,
            format=NoteExportJob.Format.JSON_ZIP,
            relative_path="notes/exports/archive.zip",
        )
        self.assertEqual(job.relative_path, "notes/exports/archive.zip")
        for path in ("D:/exports/archive.zip", "../archive.zip", "notes\\exports\\archive.zip"):
            with self.subTest(path=path), self.assertRaises(ValidationError):
                NoteExportJob.objects.create(
                    user=self.user,
                    format=NoteExportJob.Format.MARKDOWN_ZIP,
                    relative_path=path,
                )


class AuditMetadataValidationTests(TestCase):
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(phone="13800001301", password="test-password")

    def test_audit_event_rejects_body_and_nested_secret_metadata(self) -> None:
        for metadata in (
            {"body": "full note"},
            {"change": {"details": [{"api_key": "secret"}]}},
            {"change": ({"signed_url": "https://example.com/private"},)},
        ):
            with self.subTest(metadata=metadata), self.assertRaises(ValidationError):
                NoteAuditEvent.objects.create(
                    user=self.user,
                    action="note.changed",
                    object_type="note",
                    object_id=uuid.uuid4(),
                    metadata=metadata,
                )

    def test_audit_event_rejects_unreasonably_large_metadata(self) -> None:
        with self.assertRaises(ValidationError):
            NoteAuditEvent.objects.create(
                user=self.user,
                action="note.changed",
                object_type="note",
                object_id=uuid.uuid4(),
                metadata={"reason": "x" * 20_000},
            )

    def test_audit_event_accepts_minimal_metadata(self) -> None:
        event = NoteAuditEvent.objects.create(
            user=self.user,
            action="memory.confirmed",
            object_type="note_memory",
            object_id=uuid.uuid4(),
            metadata={"from_status": "candidate", "to_status": "confirmed"},
        )

        self.assertIsNotNone(event.pk)
