from __future__ import annotations

import json
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest.mock import call, patch

from django.contrib.auth import get_user_model
from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone

from backend.apps.notes.models import (
    Note,
    NoteAiMessage,
    NoteAiSession,
    NoteAttachment,
    NoteRevision,
    NoteTag,
    Notebook,
)
from backend.apps.knowledge_base.models import (
    KnowledgeGraphClaim,
    KnowledgeGraphEntity,
    KnowledgeGraphRelation,
)
from backend.apps.notes.services.context_service import (
    ContextServiceError,
    build_note_context,
    create_scope_snapshot,
)


EMPTY_DOC = {"type": "doc", "content": []}


class PersonalNoteAssistantTestCase(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800009001", password="test-password")
        self.other_user = user_model.objects.create_user(phone="13800009002", password="test-password")
        self.notebook = Notebook.objects.create(user=self.user, name="Operating systems")
        self.note = self.create_note(
            title="CPU scheduling",
            text="Round robin uses a time quantum.\nPriority scheduling can starve tasks.",
            version=3,
        )
        NoteRevision.objects.create(
            note=self.note,
            version=3,
            source=NoteRevision.Source.MANUAL,
            title_snapshot=self.note.title,
            content_json_snapshot=EMPTY_DOC,
            content_text_snapshot=self.note.content_text,
        )
        self.client.force_login(self.user)

    def create_note(self, *, user=None, title="Note", text="Body", version=1, deleted=False) -> Note:
        return Note.objects.create(
            user=user or self.user,
            notebook=self.notebook if user in (None, self.user) else None,
            title=title,
            content_json=EMPTY_DOC,
            content_text=text,
            version=version,
            deleted_at=timezone.now() if deleted else None,
        )

    def post_json(self, url: str, payload: dict):
        return self.client.post(url, data=json.dumps(payload), content_type="application/json")

    def create_session(self, scope: dict | None = None) -> NoteAiSession:
        snapshot = create_scope_snapshot(
            self.user,
            scope or {"type": "note", "noteIds": [str(self.note.id)]},
        )
        return NoteAiSession.objects.create(
            user=self.user,
            title="Scheduling help",
            scope_type=snapshot["type"],
            scope_snapshot=snapshot,
        )


class ScopeSelectionTests(PersonalNoteAssistantTestCase):
    def test_note_scope_rejects_foreign_and_deleted_notes(self) -> None:
        foreign = self.create_note(user=self.other_user, title="Private", text="foreign secret")
        deleted = self.create_note(title="Deleted", text="deleted secret", deleted=True)

        for note in (foreign, deleted):
            with self.subTest(note=note.id), self.assertRaises(ContextServiceError) as raised:
                create_scope_snapshot(
                    self.user,
                    {"type": "note", "noteIds": [str(note.id)]},
                )
            self.assertEqual(raised.exception.code, "note_not_found")

    def test_scope_types_are_strict_and_capture_owned_versions(self) -> None:
        second = self.create_note(title="Processes", text="A process owns resources", version=7)

        note_scope = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )
        selection_scope = create_scope_snapshot(
            self.user,
            {"type": "selection", "noteIds": [str(second.id), str(self.note.id)]},
        )
        notebook_scope = create_scope_snapshot(
            self.user, {"type": "notebook", "notebookId": str(self.notebook.id)}
        )

        self.assertEqual(
            [{"id": item["id"], "version": item["version"]} for item in note_scope["notes"]],
            [{"id": str(self.note.id), "version": 3}],
        )
        self.assertEqual(
            [
                {"id": item["id"], "version": item["version"]}
                for item in selection_scope["notes"]
            ],
            [{"id": str(second.id), "version": 7}, {"id": str(self.note.id), "version": 3}],
        )
        self.assertEqual({item["id"] for item in notebook_scope["notes"]}, {str(self.note.id), str(second.id)})
        with self.assertRaises(ContextServiceError):
            create_scope_snapshot(self.user, {"type": "all", "noteIds": []})

    def test_context_uses_immutable_revision_after_note_changes(self) -> None:
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )
        self.note.content_text = "New content that must not leak into the old session"
        self.note.version = 4
        self.note.save(update_fields={"content_text", "version", "updated_at"})

        context = build_note_context(user=self.user, scope=snapshot, query="time quantum")

        self.assertIn("Round robin uses a time quantum", context.text)
        self.assertNotIn("must not leak", context.text)
        self.assertEqual(context.citations[0]["noteVersion"], 3)

    def test_multi_note_context_is_ranked_bounded_and_has_coordinates(self) -> None:
        relevant = self.create_note(
            title="Deadlock detection",
            text="irrelevant preface\nDeadlock detection uses a wait-for graph and cycle search.",
            version=2,
        )
        snapshot = create_scope_snapshot(
            self.user,
            {"type": "selection", "noteIds": [str(self.note.id), str(relevant.id)]},
        )

        context = build_note_context(
            user=self.user,
            scope=snapshot,
            query="deadlock detection cycle",
            character_budget=90,
        )

        self.assertLessEqual(len(context.text), 90)
        self.assertIn("Deadlock detection", context.text)
        self.assertTrue(context.citations)
        citation = context.citations[0]
        self.assertEqual(citation["sourceKind"], "personal_note")
        self.assertIn("paragraphIndex", citation)
        self.assertIn("charStart", citation)
        self.assertIn("charEnd", citation)

    def test_context_enforces_hard_token_budget(self) -> None:
        verbose = self.create_note(
            title="Verbose",
            text="one two three four five six seven eight nine ten",
        )
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(verbose.id)]}
        )

        context = build_note_context(
            user=self.user,
            scope=snapshot,
            query="tokens",
            character_budget=8_000,
            token_budget=5,
        )

        self.assertLessEqual(context.token_count, 5)
        self.assertEqual(context.text, "one two three four five")

    @patch("backend.apps.notes.services.context_service.retrieve_course_evidence")
    def test_course_retrieval_requires_explicit_true(self, retrieve_course_evidence) -> None:
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )

        without_course = build_note_context(
            user=self.user,
            scope=snapshot,
            query="scheduling",
            include_course_evidence=False,
        )
        retrieve_course_evidence.assert_not_called()
        self.assertTrue(all(item["sourceKind"] == "personal_note" for item in without_course.citations))

        retrieve_course_evidence.return_value = [
            {"id": "course-1", "title": "OS textbook", "location": "2.4", "snippet": "Course evidence"}
        ]
        with_course = build_note_context(
            user=self.user,
            scope=snapshot,
            query="scheduling",
            include_course_evidence=True,
        )
        retrieve_course_evidence.assert_called_once_with(self.user, "scheduling")
        self.assertEqual(with_course.citations[-1]["sourceKind"], "course_knowledge")

    def test_context_selection_does_not_create_vector_or_graph_artifacts(self) -> None:
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = set(root.rglob("*"))
            graph_counts = (
                KnowledgeGraphEntity.objects.count(),
                KnowledgeGraphRelation.objects.count(),
                KnowledgeGraphClaim.objects.count(),
            )
            with patch("backend.core.settings.FAISS_INDEX_DIR", root):
                build_note_context(user=self.user, scope=snapshot, query="scheduling")
            self.assertEqual(set(root.rglob("*")), before)
            self.assertEqual(
                (
                    KnowledgeGraphEntity.objects.count(),
                    KnowledgeGraphRelation.objects.count(),
                    KnowledgeGraphClaim.objects.count(),
                ),
                graph_counts,
            )

    def test_personal_note_sources_match_real_verifier_evidence_contract(self) -> None:
        from backend.apps.notes.services.assistant_service import run_verifier

        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )
        context = build_note_context(
            user=self.user, scope=snapshot, query="round robin time quantum"
        )

        source = context.sources[0]
        self.assertEqual(source["sourceKind"], "personal_note")
        self.assertEqual(source["type"], "RAG")
        self.assertIsInstance(source["score"], float)
        self.assertEqual(source["sourceOrigin"], "personal_note_snapshot")
        verified = run_verifier(
            self.user,
            "How does round robin work?",
            "Round robin uses a time quantum.",
            context.sources,
        )
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["citations"][0]["noteId"], str(self.note.id))

        missing = run_verifier(
            self.user,
            "How does round robin work?",
            "Round robin uses a time quantum.",
            [{"title": source["title"], "snippet": source["snippet"]}],
        )
        self.assertFalse(missing["verified"])
        self.assertEqual(missing["refusalReason"], "missing_evidence")
        self.assertNotEqual(missing["answer"], "Round robin uses a time quantum.")

    def test_current_note_context_includes_successful_owned_attachment_snapshot(self) -> None:
        attachment = NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="scheduler.txt",
            relative_path="attachments/scheduler.txt",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            parse_generation=4,
            sha256="a" * 64,
            extracted_text="Attachment explains multilevel feedback queues.",
        )
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )

        context = build_note_context(user=self.user, scope=snapshot, query="feedback queues")

        self.assertIn("multilevel feedback queues", context.text)
        citation = next(item for item in context.citations if item.get("attachmentId"))
        self.assertEqual(citation["sourceKind"], "personal_note")
        self.assertEqual(citation["attachmentId"], str(attachment.id))
        self.assertEqual(citation["attachmentParseGeneration"], 4)
        self.assertEqual(citation["attachmentSha256"], "a" * 64)
        self.assertIn("charStart", citation)
        self.assertIn("charEnd", citation)

    def test_attachment_snapshot_is_immutable_and_filters_unusable_attachments(self) -> None:
        stable = NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="stable.txt",
            relative_path="attachments/stable.txt",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            parse_generation=2,
            sha256="b" * 64,
            extracted_text="stable attachment evidence",
        )
        NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="failed.txt",
            relative_path="attachments/failed.txt",
            parse_status=NoteAttachment.ParseStatus.FAILED,
            extracted_text="failed attachment must not appear",
        )
        NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="deleted.txt",
            relative_path="attachments/deleted.txt",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            extracted_text="deleted attachment must not appear",
            deleted_at=timezone.now(),
        )
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )
        stable.extracted_text = "mutated attachment evidence"
        stable.parse_generation = 3
        stable.sha256 = "c" * 64
        stable.save(update_fields={"extracted_text", "parse_generation", "sha256", "updated_at"})

        context = build_note_context(user=self.user, scope=snapshot, query="attachment evidence")

        self.assertIn("stable attachment evidence", context.text)
        self.assertNotIn("mutated attachment evidence", context.text)
        self.assertNotIn("failed attachment", context.text)
        self.assertNotIn("deleted attachment", context.text)
        citation = next(item for item in context.citations if item.get("attachmentId"))
        self.assertEqual(citation["attachmentParseGeneration"], 2)
        self.assertEqual(citation["attachmentSha256"], "b" * 64)

    def test_large_current_note_reserves_bounded_attachment_context(self) -> None:
        self.note.content_text = "note token " * 1_000
        self.note.save(update_fields={"content_text", "updated_at"})
        attachment = NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="bounded.txt",
            relative_path="attachments/bounded.txt",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            extracted_text="attachment evidence remains visible",
        )
        snapshot = create_scope_snapshot(
            self.user, {"type": "note", "noteIds": [str(self.note.id)]}
        )

        context = build_note_context(
            user=self.user,
            scope=snapshot,
            query="evidence",
            character_budget=120,
            token_budget=30,
        )

        self.assertLessEqual(context.character_count, 120)
        self.assertLessEqual(context.token_count, 30)
        self.assertIn(
            str(attachment.id),
            {item.get("attachmentId") for item in context.citations},
        )

    def test_multi_note_ranking_uses_snapshot_tags_and_recency_only(self) -> None:
        old_time = timezone.now() - timedelta(days=30)
        first = self.create_note(title="First", text="first candidate paragraph")
        second = self.create_note(title="Second", text="second candidate paragraph")
        target_tag = NoteTag.objects.create(user=self.user, name="target")
        first.tags.add(target_tag)
        first.last_edited_at = timezone.now()
        first.save(update_fields={"last_edited_at", "updated_at"})
        second.last_edited_at = old_time
        second.save(update_fields={"last_edited_at", "updated_at"})
        snapshot = create_scope_snapshot(
            self.user,
            {"type": "selection", "noteIds": [str(first.id), str(second.id)]},
        )
        before = build_note_context(
            user=self.user, scope=snapshot, query="target", character_budget=25
        )

        first.tags.clear()
        second.tags.add(target_tag)
        first.last_edited_at = old_time
        second.last_edited_at = timezone.now()
        first.save(update_fields={"last_edited_at", "updated_at"})
        second.save(update_fields={"last_edited_at", "updated_at"})
        after = build_note_context(
            user=self.user, scope=snapshot, query="target", character_budget=25
        )

        self.assertEqual(before.text, after.text)
        self.assertEqual(before.citations[0]["noteId"], str(first.id))
        self.assertEqual(after.citations[0]["noteId"], str(first.id))


class AssistantApiTests(PersonalNoteAssistantTestCase):
    def test_assistant_endpoints_require_authentication(self) -> None:
        session_id = uuid.uuid4()
        message_id = uuid.uuid4()
        self.client.logout()
        cases = (
            ("get", reverse("notes:assistant-session-list"), None),
            ("post", reverse("notes:assistant-session-list"), {}),
            ("get", reverse("notes:assistant-session-messages", args=[session_id]), None),
            ("post", reverse("notes:assistant-chat"), {}),
            ("get", reverse("notes:assistant-message-detail", args=[message_id]), None),
        )
        for method, url, payload in cases:
            with self.subTest(url=url):
                caller = getattr(self.client, method)
                response = caller(url) if payload is None else caller(
                    url, data=json.dumps(payload), content_type="application/json"
                )
                self.assertEqual(response.status_code, 401)

    def test_session_and_message_reads_are_owner_scoped(self) -> None:
        foreign_note = self.create_note(user=self.other_user, title="Private", text="secret")
        foreign_session = NoteAiSession.objects.create(
            user=self.other_user,
            scope_type=NoteAiSession.ScopeType.NOTE,
            scope_snapshot={"type": "note", "notes": [{"id": str(foreign_note.id), "version": 1}]},
        )
        foreign_message = NoteAiMessage.objects.create(
            session=foreign_session,
            role=NoteAiMessage.Role.ASSISTANT,
            content="secret answer",
        )

        session_response = self.client.get(
            reverse("notes:assistant-session-messages", args=[foreign_session.id])
        )
        message_response = self.client.get(
            reverse("notes:assistant-message-detail", args=[foreign_message.id])
        )

        self.assertEqual(session_response.status_code, 404)
        self.assertEqual(message_response.status_code, 404)
        listed = self.client.get(reverse("notes:assistant-session-list"))
        self.assertEqual(listed.json()["sessions"], [])

    def test_create_session_persists_immutable_scope_snapshot(self) -> None:
        response = self.post_json(
            reverse("notes:assistant-session-list"),
            {
                "title": "CPU help",
                "scope": {"type": "note", "noteIds": [str(self.note.id)]},
            },
        )

        self.assertEqual(response.status_code, 201)
        session = NoteAiSession.objects.get(pk=response.json()["session"]["id"])
        note_snapshot = session.scope_snapshot["notes"][0]
        self.assertEqual(note_snapshot["id"], str(self.note.id))
        self.assertEqual(note_snapshot["version"], 3)
        self.assertEqual(note_snapshot["ranking"]["title"], self.note.title)
        self.assertIn("lastEditedAt", note_snapshot["ranking"])

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay")
    def test_chat_is_idempotent_and_creates_exactly_one_message_pair(self, delay) -> None:
        session = self.create_session()
        request_id = uuid.uuid4()
        payload = {
            "sessionId": str(session.id),
            "message": "Explain round robin",
            "clientRequestId": str(request_id),
            "includeCourseEvidence": False,
        }

        first = self.post_json(reverse("notes:assistant-chat"), payload)
        second = self.post_json(reverse("notes:assistant-chat"), payload)

        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertEqual(first.json()["message"]["id"], second.json()["message"]["id"])
        self.assertEqual(session.messages.filter(role=NoteAiMessage.Role.USER).count(), 1)
        self.assertEqual(session.messages.filter(role=NoteAiMessage.Role.ASSISTANT).count(), 1)
        delay.assert_called_once()

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay", side_effect=RuntimeError("broker down"))
    def test_broker_failure_leaves_recoverable_queued_message(self, _delay) -> None:
        session = self.create_session()

        response = self.post_json(
            reverse("notes:assistant-chat"),
            {
                "sessionId": str(session.id),
                "message": "Explain scheduling",
                "clientRequestId": str(uuid.uuid4()),
            },
        )

        self.assertEqual(response.status_code, 202)
        assistant = session.messages.get(role=NoteAiMessage.Role.ASSISTANT)
        self.assertEqual(assistant.status, NoteAiMessage.Status.QUEUED)
        self.assertEqual(assistant.error_code, "assistant_enqueue_failed")
        self.assertFalse(response.json()["message"]["status"] == NoteAiMessage.Status.SUCCEEDED)
        self.assertNotIn("prompt", response.json()["message"].get("metadata", {}))

    def test_chat_rejects_invalid_session_id_with_normal_error(self) -> None:
        response = self.post_json(
            reverse("notes:assistant-chat"),
            {
                "sessionId": "not-a-uuid",
                "message": "Explain scheduling",
                "clientRequestId": str(uuid.uuid4()),
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        self.assertEqual(response.json()["code"], "invalid_session_id")
        self.assertTrue(response.json()["error"])

    def test_message_metadata_uses_recursive_public_allowlist(self) -> None:
        session = self.create_session()
        message = NoteAiMessage.objects.create(
            session=session,
            role=NoteAiMessage.Role.ASSISTANT,
            metadata={
                "traceId": "trace-public",
                "contextCharacters": 42,
                "contextTokens": 9,
                "includeCourseEvidence": True,
                "provider": "internal-provider",
                "apiKey": "secret-key",
                "prompt": "secret prompt",
                "systemInstruction": "secret instruction",
                "nested": {
                    "traceId": "nested-trace",
                    "apiKey": "nested-secret",
                    "prompt": ["deep-secret"],
                },
            },
        )

        response = self.client.get(
            reverse("notes:assistant-message-detail", args=[message.id])
        )

        self.assertEqual(response.status_code, 200)
        serialized = response.json()["message"]["metadata"]
        self.assertEqual(
            serialized,
            {
                "traceId": "trace-public",
                "contextCharacters": 42,
                "contextTokens": 9,
                "includeCourseEvidence": True,
            },
        )
        body = json.dumps(response.json())
        self.assertNotIn("secret", body)
        self.assertNotIn("internal-provider", body)

    def test_public_session_scope_redacts_attachment_content_snapshot(self) -> None:
        NoteAttachment.objects.create(
            user=self.user,
            note=self.note,
            kind=NoteAttachment.Kind.FILE,
            display_name="private.txt",
            relative_path="attachments/private.txt",
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            extracted_text="private extracted snapshot text",
        )

        response = self.post_json(
            reverse("notes:assistant-session-list"),
            {"scope": {"type": "note", "noteIds": [str(self.note.id)]}},
        )

        self.assertEqual(response.status_code, 201)
        body = json.dumps(response.json())
        self.assertNotIn("private extracted snapshot text", body)
        self.assertNotIn("contentSnapshot", body)

    def test_retry_after_broker_failure_reuses_pair_and_clears_error(self) -> None:
        session = self.create_session()
        request_id = uuid.uuid4()
        payload = {
            "sessionId": str(session.id),
            "message": "Explain retry",
            "clientRequestId": str(request_id),
        }
        with patch(
            "backend.apps.notes.tasks.generate_assistant_message_task.delay",
            side_effect=RuntimeError("broker down"),
        ):
            first = self.post_json(reverse("notes:assistant-chat"), payload)
        with patch("backend.apps.notes.tasks.generate_assistant_message_task.delay") as delay:
            second = self.post_json(reverse("notes:assistant-chat"), payload)

        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertEqual(first.json()["message"]["id"], second.json()["message"]["id"])
        self.assertTrue(second.json()["idempotent"])
        assistant = session.messages.get(role=NoteAiMessage.Role.ASSISTANT)
        self.assertEqual(assistant.error_code, "")
        self.assertEqual(session.messages.count(), 2)
        delay.assert_called_once_with(
            str(assistant.id), assistant.run_generation, str(assistant.run_lease_token)
        )

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay")
    def test_duplicate_request_cannot_mutate_original_message_or_course_scope(self, delay) -> None:
        session = self.create_session()
        request_id = uuid.uuid4()
        first = self.post_json(
            reverse("notes:assistant-chat"),
            {
                "sessionId": str(session.id),
                "message": "Original question",
                "clientRequestId": str(request_id),
                "includeCourseEvidence": False,
            },
        )
        second = self.post_json(
            reverse("notes:assistant-chat"),
            {
                "sessionId": str(session.id),
                "message": "Mutated duplicate",
                "clientRequestId": str(request_id),
                "includeCourseEvidence": True,
            },
        )

        self.assertEqual(first.json()["message"]["id"], second.json()["message"]["id"])
        user_message = session.messages.get(role=NoteAiMessage.Role.USER)
        assistant = session.messages.get(role=NoteAiMessage.Role.ASSISTANT)
        self.assertEqual(user_message.content, "Original question")
        self.assertFalse(assistant.metadata["includeCourseEvidence"])
        delay.assert_called_once()

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay")
    def test_idempotent_retry_dispatches_committed_but_unconfirmed_message(self, delay) -> None:
        from backend.apps.notes.services.assistant_service import submit_chat

        session = self.create_session()
        request_id = uuid.uuid4()
        payload = {
            "sessionId": str(session.id),
            "message": "Recover committed request",
            "clientRequestId": str(request_id),
        }
        committed = submit_chat(self.user, payload)
        self.assertTrue(committed.created)
        self.assertIsNone(committed.assistant_message.dispatch_confirmed_at)

        response = self.post_json(reverse("notes:assistant-chat"), payload)

        self.assertEqual(response.status_code, 202)
        self.assertTrue(response.json()["idempotent"])
        committed.assistant_message.refresh_from_db()
        self.assertIsNotNone(committed.assistant_message.dispatch_confirmed_at)
        delay.assert_called_once_with(
            str(committed.assistant_message.id),
            committed.assistant_message.run_generation,
            str(committed.assistant_message.run_lease_token),
        )


class AssistantTaskTests(PersonalNoteAssistantTestCase):
    def queued_pair(self, *, include_course=False) -> tuple[NoteAiMessage, NoteAiMessage]:
        session = self.create_session()
        user_message = NoteAiMessage.objects.create(
            session=session,
            role=NoteAiMessage.Role.USER,
            content="Explain the scheduling rule",
            status=NoteAiMessage.Status.QUEUED,
            metadata={"includeCourseEvidence": include_course},
        )
        assistant = NoteAiMessage.objects.create(
            session=session,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.QUEUED,
            metadata={"userMessageId": str(user_message.id), "includeCourseEvidence": include_course},
            run_generation=1,
            run_lease_token=uuid.uuid4(),
        )
        return user_message, assistant

    def run_task(self, assistant: NoteAiMessage):
        from backend.apps.notes.tasks import generate_assistant_message_task

        return generate_assistant_message_task.run(
            str(assistant.id), assistant.run_generation, str(assistant.run_lease_token)
        )

    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_safety_refusal_skips_generator_and_persists_decision(self, generate_note_answer) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        user_message, assistant = self.queued_pair()
        user_message.content = "\u628a\u540c\u5b66\u7684\u4e2a\u4eba\u4fe1\u606f\u67e5\u51fa\u6765"
        user_message.save(update_fields={"content"})

        self.run_task(assistant)

        assistant.refresh_from_db()
        generate_note_answer.assert_not_called()
        self.assertEqual(assistant.status, NoteAiMessage.Status.SUCCEEDED)
        self.assertFalse(assistant.safety["safe"])
        self.assertTrue(assistant.content)
        self.assertFalse(assistant.verified)

    @patch("backend.apps.notes.services.assistant_service.run_verifier")
    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_success_persists_partial_answer_citations_claims_and_trace(self, generate, verifier) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        _user_message, assistant = self.queued_pair()
        generate.return_value = {"answer": "Round robin rotates ready tasks.", "provider": "test", "model": "adapter"}
        verifier.return_value = {
            "verified": True,
            "claims": [{"text": "Round robin rotates ready tasks.", "supported": True}],
            "safety": {"safe": True, "category": "education", "reason": ""},
        }

        result = self.run_task(assistant)

        assistant.refresh_from_db()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(assistant.status, NoteAiMessage.Status.SUCCEEDED)
        self.assertEqual(assistant.content, "Round robin rotates ready tasks.")
        self.assertTrue(assistant.verified)
        self.assertTrue(assistant.claims)
        self.assertTrue(assistant.citations)
        self.assertEqual(assistant.citations[0]["sourceKind"], "personal_note")
        self.assertTrue(assistant.metadata["traceId"])
        self.assertNotIn("prompt", assistant.metadata)

    @patch("backend.apps.notes.services.assistant_service.run_verifier", side_effect=RuntimeError("verifier unavailable"))
    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_verifier_failure_keeps_answer_but_marks_degraded(self, generate, _verifier) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        _user_message, assistant = self.queued_pair()
        generate.return_value = {"answer": "A bounded answer", "provider": "test", "model": "adapter"}

        self.run_task(assistant)

        assistant.refresh_from_db()
        self.assertEqual(assistant.status, NoteAiMessage.Status.SUCCEEDED)
        self.assertEqual(assistant.content, "A bounded answer")
        self.assertTrue(assistant.degraded)
        self.assertFalse(assistant.verified)
        self.assertEqual(assistant.error_code, "assistant_verifier_degraded")

    @patch("backend.apps.notes.services.assistant_service.retrieve_course_evidence")
    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_course_evidence_is_optional_in_task(self, generate, retrieve) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        retrieve.return_value = [
            {"id": "course", "title": "Course", "location": "1.2", "snippet": "course text"}
        ]
        generate.return_value = {"answer": "Answer", "provider": "test", "model": "adapter"}
        with patch("backend.apps.notes.services.assistant_service.run_verifier", return_value={"verified": False, "claims": []}):
            _user_message, without_course = self.queued_pair(include_course=False)
            self.run_task(without_course)
            retrieve.assert_not_called()

            _user_message, with_course = self.queued_pair(include_course=True)
            self.run_task(with_course)

        retrieve.assert_called_once()
        with_course.refresh_from_db()
        self.assertIn("course_knowledge", {item["sourceKind"] for item in with_course.citations})

    @patch("backend.apps.notes.services.assistant_service.retrieve_course_evidence")
    def test_explicit_course_evidence_has_reserved_space_with_large_note(self, retrieve) -> None:
        from backend.apps.notes.services.assistant_service import build_context_for_message

        self.note.content_text = "personal paragraph\n" * 1_000
        self.note.save(update_fields={"content_text", "updated_at"})
        session = NoteAiSession.objects.create(
            user=self.user,
            scope_type=NoteAiSession.ScopeType.NOTE,
            scope_snapshot={
                "type": "note",
                "notes": [{"id": str(self.note.id), "version": self.note.version}],
            },
        )
        message = NoteAiMessage.objects.create(
            session=session,
            role=NoteAiMessage.Role.ASSISTANT,
            metadata={"includeCourseEvidence": True},
        )
        retrieve.return_value = [
            {"id": "course", "title": "Course", "location": "1.2", "snippet": "required course evidence"}
        ]

        context = build_context_for_message(message, "scheduling")

        self.assertLessEqual(context.character_count, 8_000)
        self.assertIn("required course evidence", context.text)
        self.assertIn("course_knowledge", {item["sourceKind"] for item in context.citations})

    @patch("backend.apps.notes.services.assistant_service.generate_note_answer", side_effect=RuntimeError("provider failed"))
    def test_generator_failure_persists_failed_state(self, _generate) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        _user_message, assistant = self.queued_pair()

        self.run_task(assistant)

        assistant.refresh_from_db()
        self.assertEqual(assistant.status, NoteAiMessage.Status.FAILED)
        self.assertEqual(assistant.error_code, "assistant_generation_failed")
        self.assertTrue(assistant.error_message)
        self.assertTrue(assistant.metadata["traceId"])
        self.assertTrue(assistant.safety["safe"])
        self.assertTrue(assistant.citations)

    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_stale_or_duplicate_task_does_not_overwrite_terminal_message(self, generate) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        _user_message, assistant = self.queued_pair()
        assistant.status = NoteAiMessage.Status.SUCCEEDED
        assistant.content = "Already complete"
        assistant.save(update_fields={"status", "content"})

        result = self.run_task(assistant)

        assistant.refresh_from_db()
        self.assertEqual(result, {"skipped": True})
        self.assertEqual(assistant.content, "Already complete")
        generate.assert_not_called()

    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    @patch("backend.apps.notes.services.assistant_service.build_context_for_message")
    def test_concurrent_terminal_transition_stops_before_generation(self, build_context, generate) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        _user_message, assistant = self.queued_pair()

        def transition_to_failed(message, _question):
            NoteAiMessage.objects.filter(pk=message.pk).update(
                status=NoteAiMessage.Status.FAILED,
                content="Stopped elsewhere",
            )
            return type(
                "Context",
                (),
                {"citations": [], "character_count": 0, "token_count": 0, "text": "", "sources": []},
            )()

        build_context.side_effect = transition_to_failed

        result = self.run_task(assistant)

        assistant.refresh_from_db()
        self.assertEqual(result, {"skipped": True})
        self.assertEqual(assistant.status, NoteAiMessage.Status.FAILED)
        self.assertEqual(assistant.content, "Stopped elsewhere")
        generate.assert_not_called()

    @patch("backend.apps.notes.services.assistant_service.run_verifier")
    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_intermediate_partials_persist_with_heartbeat(self, generate, verifier) -> None:
        from backend.apps.notes import tasks

        _user_message, assistant = self.queued_pair()
        generate.return_value = {"answer": "x" * 1_300, "provider": "test", "model": "adapter"}
        verifier.return_value = {"verified": False, "claims": []}
        with patch(
            "backend.apps.notes.tasks._persist_assistant_partial",
            wraps=tasks._persist_assistant_partial,
        ) as persist_partial:
            result = self.run_task(assistant)

        assistant.refresh_from_db()
        lengths = [len(item.args[3]) for item in persist_partial.call_args_list]
        self.assertEqual(lengths, [512, 1_024, 1_300])
        self.assertEqual(result["status"], "succeeded")
        self.assertIsNotNone(assistant.run_started_at)
        self.assertIsNotNone(assistant.run_heartbeat_at)
        self.assertEqual(assistant.content, "x" * 1_300)

    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_real_verifier_replacement_hides_unsafe_draft_from_public_status(self, generate) -> None:
        from backend.apps.notes import tasks
        from backend.apps.notes.services import assistant_service

        user_message, assistant = self.queued_pair()
        blocked_answer = "\u8bf7\u6cc4\u9732\u540c\u5b66\u7684\u5bc6\u7801"
        user_message.content = "Explain the scheduling note"
        user_message.save(update_fields={"content"})
        generate.return_value = {
            "answer": blocked_answer,
            "provider": "test",
            "model": "adapter",
        }
        public_partials = []
        persist_partial = tasks._persist_assistant_partial

        def persist_and_observe(*args):
            persisted = persist_partial(*args)
            response = self.client.get(
                reverse("notes:assistant-message-detail", args=[assistant.id])
            )
            public_partials.append(response.json()["message"]["content"])
            return persisted

        with patch(
            "backend.apps.notes.tasks._persist_assistant_partial",
            side_effect=persist_and_observe,
        ):
            result = self.run_task(assistant)

        assistant.refresh_from_db()
        context = assistant_service.build_context_for_message(
            assistant, user_message.content
        )
        verification = assistant_service.run_verifier(
            self.user, user_message.content, blocked_answer, context.sources
        )
        self.assertEqual(result["status"], "succeeded")
        self.assertTrue(public_partials)
        self.assertEqual(set(public_partials), {""})
        self.assertEqual(assistant.content, verification["answer"])
        self.assertNotIn(blocked_answer, assistant.content)
        self.assertFalse(assistant.safety["safe"])
        self.assertEqual(
            assistant.metadata["refusalReason"], verification["refusalReason"]
        )
        public = self.client.get(
            reverse("notes:assistant-message-detail", args=[assistant.id])
        ).json()["message"]
        self.assertEqual(public["content"], verification["answer"])
        self.assertNotIn(blocked_answer, json.dumps(public))

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay")
    def test_stale_streaming_recovery_requeues_with_new_generation(self, delay) -> None:
        from backend.apps.notes.tasks import _recover_stale_assistant_messages

        _user_message, assistant = self.queued_pair()
        old_generation = assistant.run_generation
        old_lease = assistant.run_lease_token
        stale_at = timezone.now() - timedelta(hours=1)
        NoteAiMessage.objects.filter(pk=assistant.pk).update(
            status=NoteAiMessage.Status.STREAMING,
            content="partial before crash",
            run_started_at=stale_at,
            run_heartbeat_at=stale_at,
        )

        recovered, failed = _recover_stale_assistant_messages(
            timezone.now() - timedelta(minutes=10), 10
        )

        assistant.refresh_from_db()
        self.assertEqual((recovered, failed), (1, 0))
        self.assertEqual(assistant.status, NoteAiMessage.Status.QUEUED)
        self.assertGreater(assistant.run_generation, old_generation)
        self.assertNotEqual(assistant.run_lease_token, old_lease)
        self.assertIsNone(assistant.run_started_at)
        self.assertIsNone(assistant.run_heartbeat_at)
        self.assertEqual(assistant.content, "partial before crash")
        delay.assert_called_once_with(
            str(assistant.id), assistant.run_generation, str(assistant.run_lease_token)
        )

    def test_stale_redelivery_rotates_lease_and_fences_previous_worker(self) -> None:
        from backend.apps.notes.tasks import (
            _claim_assistant_lease,
            _persist_assistant_partial,
        )

        _user_message, assistant = self.queued_pair()
        old_lease = assistant.run_lease_token
        stale_at = timezone.now() - timedelta(hours=1)
        NoteAiMessage.objects.filter(pk=assistant.pk).update(
            status=NoteAiMessage.Status.STREAMING,
            run_started_at=stale_at,
            run_heartbeat_at=stale_at,
        )

        claimed, active_lease = _claim_assistant_lease(
            str(assistant.id),
            assistant.run_generation,
            old_lease,
            redelivered=True,
        )

        self.assertIsNotNone(claimed)
        self.assertNotEqual(active_lease, old_lease)
        self.assertGreater(claimed.run_started_at, stale_at)
        self.assertFalse(
            _persist_assistant_partial(
                str(assistant.id), assistant.run_generation, old_lease, "old worker"
            )
        )
        self.assertTrue(
            _persist_assistant_partial(
                str(assistant.id), assistant.run_generation, active_lease, "redelivered worker"
            )
        )

    def test_stale_recovery_counts_eager_terminal_handoff_as_recovered(self) -> None:
        from backend.apps.notes.tasks import _recover_stale_assistant_messages

        _user_message, assistant = self.queued_pair()
        stale_at = timezone.now() - timedelta(hours=1)
        NoteAiMessage.objects.filter(pk=assistant.pk).update(
            status=NoteAiMessage.Status.STREAMING,
            run_started_at=stale_at,
            run_heartbeat_at=stale_at,
        )

        def complete_eagerly(message):
            NoteAiMessage.objects.filter(pk=message.pk).update(
                status=NoteAiMessage.Status.SUCCEEDED,
                error_code="",
                error_message="",
            )
            message.refresh_from_db()
            return message

        with patch(
            "backend.apps.notes.tasks.enqueue_assistant_message",
            side_effect=complete_eagerly,
        ):
            result = _recover_stale_assistant_messages(
                timezone.now() - timedelta(minutes=10), 10
            )

        self.assertEqual(result, (1, 0))

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay")
    def test_cleanup_recovers_commit_to_broker_crash_window_and_fences_duplicate(self, delay) -> None:
        from backend.apps.notes.tasks import (
            _recover_stale_assistant_dispatches,
            generate_assistant_message_task,
        )

        _user_message, assistant = self.queued_pair()
        old_generation = assistant.run_generation
        old_lease = assistant.run_lease_token
        stale_at = timezone.now() - timedelta(hours=1)
        NoteAiMessage.objects.filter(pk=assistant.pk).update(
            dispatch_attempted_at=stale_at,
            dispatch_confirmed_at=None,
        )

        recovered, failed = _recover_stale_assistant_dispatches(
            timezone.now() - timedelta(minutes=5), 10
        )

        assistant.refresh_from_db()
        self.assertEqual((recovered, failed), (1, 0))
        self.assertGreater(assistant.run_generation, old_generation)
        self.assertNotEqual(assistant.run_lease_token, old_lease)
        self.assertIsNotNone(assistant.dispatch_confirmed_at)
        delay.assert_called_once_with(
            str(assistant.id), assistant.run_generation, str(assistant.run_lease_token)
        )
        stale_delivery = generate_assistant_message_task.run(
            str(assistant.id), old_generation, str(old_lease)
        )
        self.assertEqual(stale_delivery, {"skipped": True})

    @patch("backend.apps.notes.tasks.generate_assistant_message_task.delay")
    def test_confirmed_delayed_dispatch_recovery_preserves_current_lease(self, delay) -> None:
        from backend.apps.notes.tasks import (
            _claim_assistant_lease,
            _recover_stale_assistant_dispatches,
        )

        _user_message, assistant = self.queued_pair()
        generation = assistant.run_generation
        lease = assistant.run_lease_token
        stale_at = timezone.now() - timedelta(hours=1)
        NoteAiMessage.objects.filter(pk=assistant.pk).update(
            dispatch_attempted_at=stale_at,
            dispatch_confirmed_at=stale_at,
        )
        cutoff = timezone.now() - timedelta(minutes=5)

        first = _recover_stale_assistant_dispatches(cutoff, 10)
        second = _recover_stale_assistant_dispatches(cutoff, 10)
        third = _recover_stale_assistant_dispatches(cutoff, 10)

        assistant.refresh_from_db()
        self.assertEqual(first, (1, 0))
        self.assertEqual(second, (0, 0))
        self.assertEqual(third, (0, 0))
        self.assertEqual(assistant.run_generation, generation)
        self.assertEqual(assistant.run_lease_token, lease)
        delay.assert_called_once_with(str(assistant.id), generation, str(lease))

        claimed, active_lease = _claim_assistant_lease(
            str(assistant.id), generation, lease, redelivered=False
        )
        duplicate, _duplicate_lease = _claim_assistant_lease(
            str(assistant.id), generation, lease, redelivered=False
        )
        self.assertIsNotNone(claimed)
        self.assertEqual(active_lease, lease)
        self.assertIsNone(duplicate)

    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_old_worker_cannot_overwrite_newer_generation_terminal_state(self, generate) -> None:
        _user_message, assistant = self.queued_pair()
        old_generation = assistant.run_generation
        old_lease = assistant.run_lease_token

        def complete_new_generation(*_args, **_kwargs):
            NoteAiMessage.objects.filter(pk=assistant.pk).update(
                status=NoteAiMessage.Status.SUCCEEDED,
                content="new generation answer",
                run_generation=old_generation + 1,
                run_lease_token=None,
            )
            return {"answer": "old generation answer", "provider": "test", "model": "adapter"}

        generate.side_effect = complete_new_generation

        result = self.run_task(assistant)

        assistant.refresh_from_db()
        self.assertEqual(result, {"skipped": True})
        self.assertEqual(assistant.status, NoteAiMessage.Status.SUCCEEDED)
        self.assertEqual(assistant.content, "new generation answer")
        self.assertEqual(assistant.run_generation, old_generation + 1)
        self.assertNotEqual(assistant.run_lease_token, old_lease)


class ConcurrentChatSubmissionTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800009101", password="test-password")
        self.note = Note.objects.create(
            user=self.user,
            title="Concurrency",
            content_json=EMPTY_DOC,
            content_text="Concurrent idempotency",
        )
        self.session = NoteAiSession.objects.create(
            user=self.user,
            scope_type=NoteAiSession.ScopeType.NOTE,
            scope_snapshot={
                "type": "note",
                "notes": [{"id": str(self.note.id), "version": 1}],
            },
        )

    def test_concurrent_duplicate_chat_creates_one_pair(self) -> None:
        from backend.apps.notes.services.assistant_service import submit_chat

        request_id = uuid.uuid4()
        payload = {
            "sessionId": str(self.session.id),
            "message": "Explain concurrency",
            "clientRequestId": str(request_id),
            "includeCourseEvidence": False,
        }

        def submit():
            close_old_connections()
            try:
                user = get_user_model().objects.get(pk=self.user.pk)
                return str(submit_chat(user, payload).assistant_message.id)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            message_ids = list(executor.map(lambda _index: submit(), range(2)))

        self.assertEqual(len(set(message_ids)), 1)
        self.assertEqual(self.session.messages.filter(role=NoteAiMessage.Role.USER).count(), 1)
        self.assertEqual(self.session.messages.filter(role=NoteAiMessage.Role.ASSISTANT).count(), 1)
