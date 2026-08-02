from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from backend.apps.notes.models import Note, NoteMemory, NoteTag


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
        NoteTag.objects.create(user=self.user, name="  Study   Plan  ")

        with self.assertRaises(IntegrityError), transaction.atomic():
            NoteTag.objects.create(user=self.user, name="study plan")

        other_user = get_user_model().objects.create_user(
            phone="13800001002",
            password="test-password",
        )
        other_tag = NoteTag.objects.create(user=other_user, name="STUDY PLAN")
        self.assertEqual(other_tag.normalized_name, "study plan")


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
