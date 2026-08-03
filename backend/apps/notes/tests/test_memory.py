from __future__ import annotations

import json
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from backend.apps.notes.models import (
    Note,
    NoteAiMessage,
    NoteAiSession,
    NoteAuditEvent,
    NoteMemory,
    NoteRevision,
)
from backend.apps.notes.services.context_service import build_note_context, create_scope_snapshot
from backend.apps.notes.services.memory_service import (
    MemoryServiceError,
    confirm_memory,
    create_candidates_from_model_payload,
    delete_memory,
    extract_candidates_for_assistant_message,
    pause_memory,
    resume_memory,
    select_memories,
    supersede_memory,
)


EMPTY_DOC = {"type": "doc", "content": []}


class PersonalNoteMemoryTestCase(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800008001", password="test-password")
        self.other = user_model.objects.create_user(phone="13800008002", password="test-password")
        self.note = Note.objects.create(
            user=self.user,
            title="进程调度",
            content_json=EMPTY_DOC,
            content_text="时间片轮转适合交互式任务。",
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
        snapshot = create_scope_snapshot(
            self.user,
            {"type": "note", "noteIds": [str(self.note.id)]},
        )
        self.session = NoteAiSession.objects.create(
            user=self.user,
            title="调度答疑",
            scope_type=NoteAiSession.ScopeType.NOTE,
            scope_snapshot=snapshot,
        )
        self.user_message = NoteAiMessage.objects.create(
            session=self.session,
            role=NoteAiMessage.Role.USER,
            status=NoteAiMessage.Status.SUCCEEDED,
            content="请结合我的偏好讲解",
        )
        self.assistant_message = NoteAiMessage.objects.create(
            session=self.session,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.SUCCEEDED,
            content="可以先画图再解释。",
        )
        self.client.force_login(self.user)

    def memory(self, content: str, *, status=NoteMemory.Status.CONFIRMED, **kwargs) -> NoteMemory:
        confirmed_at = kwargs.pop("confirmed_at", timezone.now() if status == NoteMemory.Status.CONFIRMED else None)
        return NoteMemory.objects.create(
            user=self.user,
            memory_type=kwargs.pop("memory_type", NoteMemory.MemoryType.CORE),
            content=content,
            status=status,
            confirmed_at=confirmed_at,
            importance=kwargs.pop("importance", 3),
            confidence=kwargs.pop("confidence", 0.9),
            **kwargs,
        )

    def post_json(self, url: str, payload: dict | None = None):
        return self.client.post(
            url,
            data=json.dumps(payload or {}),
            content_type="application/json",
        )


class MemorySelectionTests(PersonalNoteMemoryTestCase):
    def test_candidate_never_enters_context(self) -> None:
        candidate = self.memory("偏好图示", status=NoteMemory.Status.CANDIDATE)

        selected = select_memories(
            user=self.user,
            query="怎么讲解",
            scope_note_ids=[self.note.id],
        )

        self.assertNotIn(candidate.id, [item.id for item in selected])

    def test_only_confirmed_effective_current_user_memories_are_selected(self) -> None:
        active = self.memory("偏好用流程图讲解调度")
        paused = self.memory("暂停记忆", status=NoteMemory.Status.PAUSED)
        deleted = self.memory(
            "删除记忆",
            status=NoteMemory.Status.DELETED,
            deleted_at=timezone.now(),
        )
        expired = self.memory(
            "过期记忆",
            valid_from=timezone.now() - timedelta(days=2),
            valid_until=timezone.now() - timedelta(days=1),
        )
        replacement = self.memory("新的目标")
        superseded = self.memory(
            "旧的目标",
            status=NoteMemory.Status.SUPERSEDED,
            superseded_by=replacement,
        )
        NoteMemory.objects.create(
            user=self.other,
            memory_type=NoteMemory.MemoryType.CORE,
            content="PRIVATE_OTHER_USER_MARKER",
            status=NoteMemory.Status.CONFIRMED,
            confirmed_at=timezone.now(),
        )

        selected = select_memories(
            user=self.user,
            query="流程图目标",
            scope_note_ids=[self.note.id],
        )
        selected_ids = {item.id for item in selected}

        self.assertIn(active.id, selected_ids)
        self.assertIn(replacement.id, selected_ids)
        self.assertNotIn(paused.id, selected_ids)
        self.assertNotIn(deleted.id, selected_ids)
        self.assertNotIn(expired.id, selected_ids)
        self.assertNotIn(superseded.id, selected_ids)
        self.assertFalse(any(item.user_id == self.other.id for item in selected))

    def test_episodic_memory_requires_scope_overlap_and_recent_source(self) -> None:
        matching = self.memory(
            "这次调度实验容易把周转时间算错",
            memory_type=NoteMemory.MemoryType.EPISODIC,
            source_note_refs=[{"id": str(self.note.id), "version": 3}],
        )
        other_note = Note.objects.create(user=self.user, title="其他", content_json=EMPTY_DOC)
        wrong_scope = self.memory(
            "其他实验经历",
            memory_type=NoteMemory.MemoryType.EPISODIC,
            source_note_refs=[{"id": str(other_note.id), "version": 1}],
        )
        old = self.memory(
            "很久以前的调度经历",
            memory_type=NoteMemory.MemoryType.EPISODIC,
            source_note_refs=[{"id": str(self.note.id), "version": 3}],
        )
        NoteMemory.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=181))

        selected_ids = {
            item.id
            for item in select_memories(
                user=self.user,
                query="调度实验",
                scope_note_ids=[self.note.id],
            )
        }

        self.assertIn(matching.id, selected_ids)
        self.assertNotIn(wrong_scope.id, selected_ids)
        self.assertNotIn(old.id, selected_ids)

    def test_selection_respects_count_and_character_budgets(self) -> None:
        for index in range(12):
            self.memory(f"核心偏好 {index} " + "图" * 260, importance=5 - index / 10)
        for index in range(10):
            self.memory(
                f"调度经历 {index} " + "例" * 500,
                memory_type=NoteMemory.MemoryType.EPISODIC,
                source_note_refs=[{"id": str(self.note.id), "version": 3}],
            )

        selected = select_memories(
            user=self.user,
            query="调度图示",
            scope_note_ids=[self.note.id],
        )
        core = [item for item in selected if item.memory_type == NoteMemory.MemoryType.CORE]
        episodic = [item for item in selected if item.memory_type == NoteMemory.MemoryType.EPISODIC]

        self.assertLessEqual(len(core), 8)
        self.assertLessEqual(sum(len(item.content) for item in core), 1_600)
        self.assertLessEqual(len(episodic), 6)
        self.assertLessEqual(sum(len(item.content) for item in selected), 4_000)

    def test_context_contains_only_confirmed_memory_and_auditable_ids(self) -> None:
        confirmed = self.memory("用户偏好先看流程图再看公式")
        self.memory("候选不能进入上下文", status=NoteMemory.Status.CANDIDATE)

        context = build_note_context(
            user=self.user,
            scope=self.session.scope_snapshot,
            query="按我的偏好讲解调度",
        )

        self.assertIn("用户偏好先看流程图再看公式", context.text)
        self.assertNotIn("候选不能进入上下文", context.text)
        self.assertEqual(context.memory_ids, [str(confirmed.id)])
        self.assertTrue(all(item.get("status") == "confirmed" for item in context.memory_sources))


class MemoryStateMachineTests(PersonalNoteMemoryTestCase):
    def test_confirm_pause_resume_delete_transitions_are_audited(self) -> None:
        candidate = self.memory("偏好图示", status=NoteMemory.Status.CANDIDATE)

        confirmed = confirm_memory(self.user, candidate.id, {"content": "偏好流程图"})
        paused = pause_memory(self.user, candidate.id)
        resumed = resume_memory(self.user, candidate.id)
        deleted = delete_memory(self.user, candidate.id)

        self.assertEqual(confirmed.status, NoteMemory.Status.CONFIRMED)
        self.assertEqual(paused.status, NoteMemory.Status.PAUSED)
        self.assertEqual(resumed.status, NoteMemory.Status.CONFIRMED)
        self.assertEqual(deleted.status, NoteMemory.Status.DELETED)
        self.assertIsNotNone(deleted.deleted_at)
        self.assertEqual(
            list(NoteAuditEvent.objects.filter(object_id=candidate.id).order_by("created_at").values_list("action", flat=True)),
            ["note.memory_confirmed", "note.memory_paused", "note.memory_resumed", "note.memory_deleted"],
        )

    def test_illegal_transition_and_foreign_access_are_rejected(self) -> None:
        candidate = self.memory("待确认", status=NoteMemory.Status.CANDIDATE)

        with self.assertRaises(MemoryServiceError) as paused:
            pause_memory(self.user, candidate.id)
        with self.assertRaises(MemoryServiceError) as foreign:
            confirm_memory(self.other, candidate.id, {})

        self.assertEqual(paused.exception.status, 409)
        self.assertEqual(foreign.exception.status, 404)

    def test_supersede_confirms_candidate_replacement_atomically(self) -> None:
        old = self.memory("目标是通过期末考试")
        replacement = self.memory("目标是掌握调度算法", status=NoteMemory.Status.CANDIDATE)

        old, replacement = supersede_memory(
            self.user,
            old.id,
            {"replacementId": str(replacement.id)},
        )

        self.assertEqual(old.status, NoteMemory.Status.SUPERSEDED)
        self.assertEqual(old.superseded_by_id, replacement.id)
        self.assertEqual(replacement.status, NoteMemory.Status.CONFIRMED)
        self.assertIsNotNone(replacement.confirmed_at)
        self.assertTrue(NoteAuditEvent.objects.filter(action="note.memory_superseded", object_id=old.id).exists())


class MemoryCandidateExtractionTests(PersonalNoteMemoryTestCase):
    def valid_payload(self) -> dict:
        return {
            "candidates": [
                {
                    "memoryType": "core",
                    "content": "偏好先看流程图再看公式",
                    "importance": 4,
                    "confidence": 0.92,
                    "sourceMessageIds": [str(self.user_message.id), str(self.assistant_message.id)],
                    "sourceNoteRefs": [{"id": str(self.note.id), "version": 3}],
                    "reason": "用户在本次对话中明确表达了长期讲解偏好",
                }
            ]
        }

    def test_strict_payload_creates_owned_candidate_and_deduplicates(self) -> None:
        first = create_candidates_from_model_payload(
            user=self.user,
            payload=self.valid_payload(),
            source_session=self.session,
            source_message=self.assistant_message,
            allowed_note_refs=self.session.scope_snapshot["notes"],
        )
        second = create_candidates_from_model_payload(
            user=self.user,
            payload=self.valid_payload(),
            source_session=self.session,
            source_message=self.assistant_message,
            allowed_note_refs=self.session.scope_snapshot["notes"],
        )

        self.assertEqual(len(first), 1)
        self.assertEqual(second, first)
        self.assertEqual(NoteMemory.objects.filter(user=self.user).count(), 1)
        self.assertEqual(first[0].status, NoteMemory.Status.CANDIDATE)
        self.assertEqual(first[0].source_message_ids, [str(self.user_message.id), str(self.assistant_message.id)])

    def test_unknown_fields_foreign_sources_and_invalid_scores_are_rejected(self) -> None:
        payloads = []
        unknown = self.valid_payload()
        unknown["candidates"][0]["automaticConfirm"] = True
        payloads.append(unknown)
        invalid_score = self.valid_payload()
        invalid_score["candidates"][0]["confidence"] = 2
        payloads.append(invalid_score)
        foreign_message = NoteAiMessage.objects.create(
            session=NoteAiSession.objects.create(
                user=self.other,
                scope_type=NoteAiSession.ScopeType.SELECTION,
                scope_snapshot={"type": "selection", "notes": []},
            ),
            role=NoteAiMessage.Role.USER,
            content="foreign",
        )
        foreign = self.valid_payload()
        foreign["candidates"][0]["sourceMessageIds"] = [str(foreign_message.id)]
        payloads.append(foreign)

        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(MemoryServiceError):
                create_candidates_from_model_payload(
                    user=self.user,
                    payload=payload,
                    source_session=self.session,
                    source_message=self.assistant_message,
                    allowed_note_refs=self.session.scope_snapshot["notes"],
                )
        self.assertFalse(NoteMemory.objects.exists())

    @patch("backend.apps.notes.services.memory_service.chat_completion", side_effect=RuntimeError("provider down"))
    def test_provider_failure_creates_no_candidate_and_preserves_source(self, _chat) -> None:
        before = self.assistant_message.content

        result = extract_candidates_for_assistant_message(self.assistant_message.id)

        self.assertEqual(result, [])
        self.assertFalse(NoteMemory.objects.exists())
        self.assistant_message.refresh_from_db()
        self.assertEqual(self.assistant_message.status, NoteAiMessage.Status.SUCCEEDED)
        self.assertEqual(self.assistant_message.content, before)


class MemoryEndpointTests(PersonalNoteMemoryTestCase):
    def test_list_confirm_pause_resume_supersede_delete_endpoints(self) -> None:
        candidate = self.memory("候选偏好", status=NoteMemory.Status.CANDIDATE)
        response = self.client.get(reverse("notes:memory-list"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["memories"][0]["status"], "candidate")

        response = self.post_json(
            reverse("notes:memory-confirm", args=[candidate.id]),
            {"content": "确认后的偏好"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["memory"]["content"], "确认后的偏好")
        self.assertEqual(self.post_json(reverse("notes:memory-pause", args=[candidate.id])).status_code, 200)
        self.assertEqual(self.post_json(reverse("notes:memory-resume", args=[candidate.id])).status_code, 200)

        replacement = self.memory("更正后的偏好", status=NoteMemory.Status.CANDIDATE)
        response = self.post_json(
            reverse("notes:memory-supersede", args=[candidate.id]),
            {"replacementId": str(replacement.id)},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["memory"]["status"], "superseded")
        self.assertEqual(response.json()["replacement"]["status"], "confirmed")
        self.assertEqual(self.post_json(reverse("notes:memory-delete", args=[replacement.id])).status_code, 200)

    def test_memory_endpoints_require_authentication_and_ownership(self) -> None:
        memory = self.memory("私有偏好", status=NoteMemory.Status.CANDIDATE)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(reverse("notes:memory-list")).json()["memories"], [])
        self.assertEqual(
            self.post_json(reverse("notes:memory-confirm", args=[memory.id])).status_code,
            404,
        )
        self.client.logout()
        self.assertEqual(self.client.get(reverse("notes:memory-list")).status_code, 401)


class MemoryEvaluationCommandTests(TestCase):
    def test_offline_evaluation_is_deterministic_private_and_has_at_least_fifty_cases(self) -> None:
        with TemporaryDirectory() as directory:
            first_path = Path(directory) / "first.json"
            second_path = Path(directory) / "second.json"

            call_command("evaluate_notes_memory", "--offline", "--output", str(first_path), stdout=StringIO())
            call_command("evaluate_notes_memory", "--offline", "--output", str(second_path), stdout=StringIO())

            first = json.loads(first_path.read_text(encoding="utf-8"))
            second = json.loads(second_path.read_text(encoding="utf-8"))
            self.assertEqual(first, second)
            self.assertEqual(first["schemaVersion"], 1)
            self.assertEqual(first["mode"], "offline")
            self.assertGreaterEqual(first["dataset"]["caseCount"], 50)
            self.assertEqual(first["metrics"]["crossUserLeakage"], 0)
            self.assertEqual(first["metrics"]["deletionConsistency"], 1.0)
            self.assertTrue(first["passed"])
            artifact = first_path.read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE_NOTE_CONTENT", artifact)
            self.assertNotIn("query", artifact)
            self.assertNotIn("content", artifact)

    def test_strict_mode_writes_metrics_then_fails_when_a_required_threshold_misses(self) -> None:
        failing_case = {
            "id": "strict-failure",
            "category": "deletion",
            "query": "PRIVATE_NOTE_CONTENT",
            "scopeNoteIds": ["note-1"],
            "memories": [],
            "expectedSelectedIds": ["missing-memory"],
            "expectedAbstention": False,
        }
        with TemporaryDirectory() as directory:
            dataset_path = Path(directory) / "cases.jsonl"
            output_path = Path(directory) / "metrics.json"
            dataset_path.write_text(json.dumps(failing_case, ensure_ascii=False) + "\n", encoding="utf-8")

            with self.assertRaises(CommandError):
                call_command(
                    "evaluate_notes_memory",
                    "--offline",
                    "--strict",
                    "--dataset",
                    str(dataset_path),
                    "--output",
                    str(output_path),
                    stdout=StringIO(),
                )

            result = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertFalse(result["passed"])
            self.assertEqual(result["metrics"]["deletionConsistency"], 0.0)
            self.assertNotIn("PRIVATE_NOTE_CONTENT", output_path.read_text(encoding="utf-8"))


class MemoryAssistantIntegrationTests(PersonalNoteMemoryTestCase):
    @patch("backend.apps.notes.tasks.enqueue_memory_candidate_extraction")
    @patch("backend.apps.notes.services.assistant_service.run_verifier")
    @patch("backend.apps.notes.services.assistant_service.generate_note_answer")
    def test_successful_answer_records_only_selected_confirmed_memory_ids(
        self,
        generate,
        verifier,
        enqueue_extraction,
    ) -> None:
        from backend.apps.notes.tasks import generate_assistant_message_task

        confirmed = self.memory("偏好先看流程图再看公式")
        self.memory("未确认候选", status=NoteMemory.Status.CANDIDATE)
        queued_user = NoteAiMessage.objects.create(
            session=self.session,
            role=NoteAiMessage.Role.USER,
            content="按我的偏好讲解调度",
            status=NoteAiMessage.Status.QUEUED,
        )
        lease = uuid.uuid4()
        assistant = NoteAiMessage.objects.create(
            session=self.session,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.QUEUED,
            metadata={"userMessageId": str(queued_user.id)},
            run_generation=1,
            run_lease_token=lease,
        )
        generate.return_value = {"answer": "先画调度流程图。", "provider": "test", "model": "test"}
        verifier.return_value = {"verified": False, "claims": [], "citations": []}

        result = generate_assistant_message_task.run(str(assistant.id), 1, str(lease))

        assistant.refresh_from_db()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(assistant.metadata["memoryIds"], [str(confirmed.id)])
        from backend.apps.notes.services.assistant_service import serialize_message

        self.assertEqual(serialize_message(assistant)["metadata"]["memoryIds"], [str(confirmed.id)])
        enqueue_extraction.assert_called_once_with("assistant_message", assistant.id)
