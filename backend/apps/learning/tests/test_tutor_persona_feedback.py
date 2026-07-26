import json
from unittest.mock import patch

from django.test import Client, TestCase, TransactionTestCase

from backend.apps.learning import services as learning_services
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserNotification
from backend.apps.learning.models import (
    CoachingMessage,
    CoachingMessageRole,
    CoachingSession,
    CoachingSessionStatus,
    TutorPersonaFeedback,
)
from backend.apps.learning.services import append_coaching_messages, summarize_coaching_session


class TutorPersonaFeedbackApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007101", password="TestPassword123")
        self.other_user = User.objects.create_user(phone="13800007102", password="TestPassword123")
        self.session = CoachingSession.objects.create(
            user=self.user,
            status=CoachingSessionStatus.ENDED,
            metadata={
                "tutorPersona": {
                    "id": "socratic-guide",
                    "name": "启发追问",
                    "strategyInstruction": "private instruction",
                },
                "providerSecret": "must-not-leak",
            },
        )
        self.url = f"/api/learning/coaching/sessions/{self.session.id}/tutor-feedback/"
        self.client = Client()

    def post_feedback(self, payload):
        return self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_anonymous_user_cannot_read_or_write_feedback(self):
        get_response = self.client.get(self.url)
        post_response = self.post_feedback({"rating": 5, "tags": ["讲解清楚"]})

        self.assertEqual(get_response.status_code, 401)
        self.assertEqual(post_response.status_code, 401)
        self.assertEqual(get_response.json(), {"success": False, "error": "请先登录"})

    def test_owner_can_create_feedback_with_canonical_deduplicated_tags(self):
        self.client.force_login(self.user)

        response = self.post_feedback(
            {
                "rating": 4,
                "tags": ["仍然困惑", "讲解清楚", "帮助理解", "讲解清楚"],
            }
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(
            payload["feedback"],
            {
                "rating": 4,
                "tags": ["讲解清楚", "帮助理解", "仍然困惑"],
                "personaId": "socratic-guide",
                "createdAt": payload["feedback"]["createdAt"],
                "updatedAt": payload["feedback"]["updatedAt"],
            },
        )
        self.assertTrue(payload["feedback"]["createdAt"])
        self.assertTrue(payload["feedback"]["updatedAt"])

    def test_non_owner_cannot_read_or_write_feedback(self):
        self.client.force_login(self.other_user)

        get_response = self.client.get(self.url)
        post_response = self.post_feedback({"rating": 5, "tags": []})

        self.assertEqual(get_response.status_code, 403)
        self.assertEqual(post_response.status_code, 403)
        self.assertFalse(get_response.json()["success"])
        self.assertEqual(TutorPersonaFeedback.objects.count(), 0)

    def test_active_session_rejects_feedback(self):
        self.session.status = CoachingSessionStatus.ACTIVE
        self.session.save(update_fields=["status", "updated_at"])
        self.client.force_login(self.user)

        get_response = self.client.get(self.url)
        post_response = self.post_feedback({"rating": 5, "tags": []})

        self.assertEqual(get_response.status_code, 400)
        self.assertEqual(post_response.status_code, 400)
        self.assertIn("结束", get_response.json()["error"])

    def test_archived_session_rejects_feedback(self):
        self.session.status = CoachingSessionStatus.ARCHIVED
        self.session.save(update_fields=["status", "updated_at"])
        self.client.force_login(self.user)

        response = self.post_feedback({"rating": 5, "tags": []})

        self.assertEqual(response.status_code, 400)
        self.assertIn("结束", response.json()["error"])

    def test_invalid_json_and_non_object_body_are_rejected(self):
        self.client.force_login(self.user)

        invalid_json = self.client.post(self.url, data="{", content_type="application/json")
        non_object = self.client.post(self.url, data="[]", content_type="application/json")

        self.assertEqual(invalid_json.status_code, 400)
        self.assertEqual(non_object.status_code, 400)
        self.assertIn("JSON", invalid_json.json()["error"])
        self.assertFalse(non_object.json()["success"])

    def test_rating_must_be_an_integer_between_one_and_five(self):
        self.client.force_login(self.user)

        for rating in (None, True, 0, 6, 2.5, "5"):
            with self.subTest(rating=rating):
                response = self.post_feedback({"rating": rating, "tags": []})
                self.assertEqual(response.status_code, 400)
                self.assertIn("评分", response.json()["error"])

    def test_tags_must_be_an_array_of_fixed_values(self):
        self.client.force_login(self.user)

        invalid_tags = (
            "讲解清楚",
            ["讲解清楚", "自由文本"],
            ["讲解清楚", 1],
        )
        for tags in invalid_tags:
            with self.subTest(tags=tags):
                response = self.post_feedback({"rating": 3, "tags": tags})
                self.assertEqual(response.status_code, 400)
                self.assertIn("标签", response.json()["error"])

    def test_persona_id_comes_from_session_snapshot_and_ignores_client_value(self):
        self.client.force_login(self.user)

        response = self.post_feedback(
            {
                "rating": 5,
                "tags": ["节奏合适"],
                "personaId": "practice-coach",
            }
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["feedback"]["personaId"], "socratic-guide")
        self.assertEqual(TutorPersonaFeedback.objects.get().persona_id, "socratic-guide")

    def test_missing_persona_snapshot_is_a_readable_bad_request(self):
        self.session.metadata = {"summary": {"questionCount": 1}}
        self.session.save(update_fields=["metadata", "updated_at"])
        self.client.force_login(self.user)

        response = self.post_feedback({"rating": 4, "tags": []})

        self.assertEqual(response.status_code, 400)
        self.assertIn("辅导人格", response.json()["error"])

    def test_post_updates_existing_feedback_without_creating_duplicates(self):
        self.client.force_login(self.user)
        created = self.post_feedback({"rating": 2, "tags": ["仍然困惑"]})
        created_payload = created.json()["feedback"]

        updated = self.post_feedback({"rating": 5, "tags": ["帮助理解", "讲解清楚"]})

        self.assertEqual(updated.status_code, 200)
        updated_payload = updated.json()["feedback"]
        self.assertEqual(TutorPersonaFeedback.objects.count(), 1)
        self.assertEqual(updated_payload["rating"], 5)
        self.assertEqual(updated_payload["tags"], ["讲解清楚", "帮助理解"])
        self.assertEqual(updated_payload["createdAt"], created_payload["createdAt"])

    def test_get_returns_empty_then_existing_feedback(self):
        self.client.force_login(self.user)

        empty_response = self.client.get(self.url)
        self.post_feedback({"rating": 3, "tags": ["节奏合适"]})
        existing_response = self.client.get(self.url)

        self.assertEqual(empty_response.status_code, 200)
        self.assertEqual(empty_response.json(), {"success": True, "feedback": None})
        self.assertEqual(existing_response.status_code, 200)
        self.assertEqual(existing_response.json()["feedback"]["rating"], 3)
        self.assertEqual(existing_response.json()["feedback"]["tags"], ["节奏合适"])

    def test_public_response_never_exposes_session_or_private_metadata(self):
        self.client.force_login(self.user)

        response = self.post_feedback({"rating": 5, "tags": ["讲解清楚"]})

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            set(response.json()["feedback"]),
            {"rating", "tags", "personaId", "createdAt", "updatedAt"},
        )
        serialized = json.dumps(response.json(), ensure_ascii=False)
        self.assertNotIn("strategyInstruction", serialized)
        self.assertNotIn("providerSecret", serialized)
        self.assertNotIn(str(self.session.id), serialized)

    def test_summary_completion_persists_ended_session_state(self):
        self.session.status = CoachingSessionStatus.ACTIVE
        self.session.save(update_fields=["status", "updated_at"])
        self.client.force_login(self.user)

        response = self.client.post(f"/api/learning/coaching/sessions/{self.session.id}/summary/")

        self.assertEqual(response.status_code, 201)
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, CoachingSessionStatus.ENDED)
        self.assertIsNotNone(self.session.ended_at)


class CoachingSessionLifecycleTransactionTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.user = User.objects.create_user(phone="13800007111", password="TestPassword123")
        self.session = CoachingSession.objects.create(
            user=self.user,
            status=CoachingSessionStatus.ACTIVE,
            topic_title="反馈控制",
            metadata={"tutorPersona": {"id": "socratic-guide", "name": "启发追问"}},
        )
        CoachingMessage.objects.create(
            session=self.session,
            role=CoachingMessageRole.USER,
            content="负反馈为什么能减小稳态误差？",
        )

    def test_summary_completion_is_locked_atomic_and_idempotent(self):
        select_for_update = CoachingSession.objects.select_for_update
        with patch.object(
            CoachingSession.objects,
            "select_for_update",
            wraps=select_for_update,
        ) as lock_session:
            first = summarize_coaching_session(self.user, self.session.id)

        self.session.refresh_from_db()
        first_ended_at = self.session.ended_at
        first_summary = self.session.metadata["summary"]
        second = summarize_coaching_session(self.user, self.session.id)
        self.session.refresh_from_db()

        self.assertTrue(lock_session.called)
        self.assertEqual(self.session.status, CoachingSessionStatus.ENDED)
        self.assertIsNotNone(first_ended_at)
        self.assertEqual(self.session.ended_at, first_ended_at)
        self.assertEqual(self.session.metadata["summary"], first_summary)
        self.assertEqual(first["summary"], second["summary"])
        self.assertEqual(first["session"]["status"], CoachingSessionStatus.ENDED)
        self.assertEqual(second["session"]["status"], CoachingSessionStatus.ENDED)
        self.assertEqual(
            UserNotification.objects.filter(user=self.user, title="面对面辅导总结已生成").count(),
            1,
        )

    def test_append_locks_active_session_and_never_writes_after_completion(self):
        summarize_coaching_session(self.user, self.session.id)
        ended_message_count = self.session.messages.count()
        select_for_update = CoachingSession.objects.select_for_update

        with patch.object(
            CoachingSession.objects,
            "select_for_update",
            wraps=select_for_update,
        ) as lock_session:
            result = append_coaching_messages(
                self.user,
                [{"id": "after-end", "role": "user", "content": "继续下一场辅导"}],
                tutor_persona_id="socratic-guide",
            )

        self.session.refresh_from_db()
        new_session = CoachingSession.objects.get(id=result["session"]["id"])
        self.assertTrue(lock_session.called)
        self.assertEqual(self.session.status, CoachingSessionStatus.ENDED)
        self.assertEqual(self.session.messages.count(), ended_message_count)
        self.assertNotEqual(new_session.id, self.session.id)
        self.assertEqual(new_session.status, CoachingSessionStatus.ACTIVE)
        self.assertTrue(new_session.messages.filter(metadata__clientId="after-end").exists())

    def test_first_session_creation_locks_user_before_lookup_and_reuses_active_session(self):
        user = User.objects.create_user(phone="13800007112", password="TestPassword123")
        events = []
        select_for_update = User.objects.select_for_update
        latest_active = learning_services._latest_active_coaching_session
        create_session = learning_services._create_coaching_session

        def lock_user(*args, **kwargs):
            events.append("user_lock")
            return select_for_update(*args, **kwargs)

        def lookup_active(*args, **kwargs):
            events.append("active_lookup")
            return latest_active(*args, **kwargs)

        def create_active(*args, **kwargs):
            events.append("session_create")
            return create_session(*args, **kwargs)

        with (
            patch.object(User.objects, "select_for_update", side_effect=lock_user),
            patch.object(learning_services, "_latest_active_coaching_session", side_effect=lookup_active),
            patch.object(learning_services, "_create_coaching_session", side_effect=create_active),
        ):
            first = append_coaching_messages(
                user,
                [{"id": "first-path", "role": "user", "content": "首次创建会话"}],
                tutor_persona_id="socratic-guide",
            )
            second = append_coaching_messages(
                user,
                [{"id": "second-path", "role": "user", "content": "复用活动会话"}],
                tutor_persona_id="socratic-guide",
            )

        self.assertEqual(events[:3], ["user_lock", "active_lookup", "session_create"])
        self.assertGreater(events.index("active_lookup"), events.index("user_lock"))
        self.assertEqual(events.count("session_create"), 1)
        self.assertEqual(first["session"]["id"], second["session"]["id"])
        self.assertEqual(CoachingSession.objects.filter(user=user, status=CoachingSessionStatus.ACTIVE).count(), 1)
