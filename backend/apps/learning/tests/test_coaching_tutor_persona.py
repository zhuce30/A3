from __future__ import annotations

import json

from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.learning.models import CoachingSession, CoachingSessionStatus
from backend.apps.profiles.models import LearnerProfile


class CoachingTutorPersonaTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007701", password="TestPassword123")
        LearnerProfile.objects.create(user=self.user)
        self.client = Client()
        self.client.force_login(self.user)

    def post_message(self, persona_id: str, message_id: str = "user-1"):
        return self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps(
                {
                    "tutorPersonaId": persona_id,
                    "messages": [
                        {"id": message_id, "role": "user", "content": "请讲解进程调度。"},
                    ],
                }
            ),
            content_type="application/json",
        )

    def test_persona_snapshot_is_persisted_and_serialized_without_private_fields(self):
        response = self.post_message("practice-coach")

        self.assertEqual(response.status_code, 201)
        persona = response.json()["session"]["tutorPersona"]
        self.assertEqual(persona["id"], "practice-coach")
        self.assertNotIn("instruction", persona)
        self.assertNotIn("voice", persona)

        session = CoachingSession.objects.get(user=self.user)
        self.assertEqual(session.metadata["tutorPersona"], persona)

        detail = self.client.get(f"/api/learning/coaching/sessions/{session.id}/").json()["session"]
        row = self.client.get("/api/learning/coaching/sessions/").json()["sessions"][0]
        self.assertEqual(detail["tutorPersona"]["id"], "practice-coach")
        self.assertEqual(row["tutorPersona"]["id"], "practice-coach")

    def test_unknown_persona_is_rejected(self):
        response = self.post_message("invented-tutor")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"success": False, "error": "不支持该辅导风格"})
        self.assertFalse(CoachingSession.objects.filter(user=self.user).exists())

    def test_reusing_same_persona_keeps_active_session(self):
        first = self.post_message("structured-teacher", "user-1")
        second = self.post_message("structured-teacher", "user-2")

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json()["session"]["id"], second.json()["session"]["id"])
        self.assertEqual(CoachingSession.objects.filter(user=self.user).count(), 1)

    def test_switching_persona_after_user_message_starts_new_session(self):
        first = self.post_message("structured-teacher", "user-1")
        second = self.post_message("socratic-guide", "user-2")

        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(first.json()["session"]["id"], second.json()["session"]["id"])
        ended = CoachingSession.objects.get(id=first.json()["session"]["id"])
        active = CoachingSession.objects.get(id=second.json()["session"]["id"])
        self.assertEqual(ended.status, CoachingSessionStatus.ENDED)
        self.assertIsNotNone(ended.ended_at)
        self.assertEqual(active.status, CoachingSessionStatus.ACTIVE)
        self.assertEqual(active.metadata["tutorPersona"]["id"], "socratic-guide")

    def test_missing_persona_uses_saved_preference(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "tutorPreference": {
                "personaId": "foundation-coach",
                "schemaVersion": "a3.tutor-preference.v1",
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"id": "user-1", "role": "user", "content": "从基础讲。"}]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["session"]["tutorPersona"]["id"], "foundation-coach")

