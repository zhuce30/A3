from __future__ import annotations

import json
from copy import deepcopy
from unittest.mock import patch

from django.core.cache import cache
from django.db import OperationalError
from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.learning.models import (
    CoachingSession,
    CoachingSessionStatus,
    TutorAvatarAsset,
    TutorPersonaConfiguration,
)
from backend.apps.learning.tutor_persona_operations import invalidate_tutor_persona_overlay_cache
from backend.apps.profiles.models import LearnerProfile


class CoachingTutorPersonaTests(TestCase):
    def setUp(self):
        invalidate_tutor_persona_overlay_cache()
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
        self.assertEqual(persona["avatarAssetId"], "teacher-default-v1")
        self.assertEqual(persona["avatarPublicPath"], "/a3/assets/teacher-avatar/teacher.vrm")
        self.assertTrue(persona["voicePreviewEnabled"])
        self.assertNotIn("instruction", persona)
        self.assertNotIn("voice", persona)

        session = CoachingSession.objects.get(user=self.user)
        self.assertEqual(session.metadata["tutorPersona"], persona)

        detail = self.client.get(f"/api/learning/coaching/sessions/{session.id}/").json()["session"]
        row = self.client.get("/api/learning/coaching/sessions/").json()["sessions"][0]
        self.assertEqual(detail["tutorPersona"]["id"], "practice-coach")
        self.assertEqual(row["tutorPersona"]["id"], "practice-coach")
        self.assertFalse(session.metadata["fallbackUsed"])

    def test_historical_snapshot_is_not_re_resolved_after_disable_and_rebind(self):
        historical_snapshot = {
            "id": "practice-coach",
            "name": "Historical practice coach",
            "shortDescription": "Original description",
            "teachingStyle": "practice",
            "avatarAssetId": "teacher-historical-v1",
            "avatarPublicPath": "/a3/assets/teacher-avatar/historical.vrm",
            "voiceProfileId": "voice-historical",
            "voicePreviewEnabled": False,
            "allowedWorkflows": ["coaching"],
            "schemaVersion": "a3.tutor-persona.v1",
        }
        session = CoachingSession.objects.create(
            user=self.user,
            metadata={"tutorPersona": deepcopy(historical_snapshot), "fallbackUsed": False},
        )
        replacement = TutorAvatarAsset.objects.create(
            asset_id="teacher-current-v2",
            display_name="Current tutor",
            public_path="/a3/assets/teacher-avatar/current-v2.vrm",
            sha256="6" * 64,
            file_size_bytes=4096,
            status="enabled",
        )
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(
            enabled=False,
            avatar_asset=replacement,
            voice_preview_enabled=True,
        )

        detail = self.client.get(f"/api/learning/coaching/sessions/{session.id}/").json()["session"]
        row = next(
            item
            for item in self.client.get("/api/learning/coaching/sessions/").json()["sessions"]
            if item["id"] == str(session.id)
        )

        self.assertEqual(detail["tutorPersona"], historical_snapshot)
        self.assertEqual(row["tutorPersona"], historical_snapshot)
        session.refresh_from_db()
        self.assertEqual(session.metadata["tutorPersona"], historical_snapshot)

    def test_new_session_uses_current_public_overlay_snapshot(self):
        asset = TutorAvatarAsset.objects.create(
            asset_id="teacher-practice-v3",
            display_name="Practice tutor v3",
            public_path="/a3/assets/teacher-avatar/practice-v3.vrm",
            sha256="7" * 64,
            file_size_bytes=8192,
            status="enabled",
        )
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(
            avatar_asset=asset,
            voice_preview_enabled=False,
        )

        response = self.post_message("practice-coach")

        self.assertEqual(response.status_code, 201, response.content)
        persona = response.json()["session"]["tutorPersona"]
        self.assertEqual(persona["avatarAssetId"], "teacher-practice-v3")
        self.assertEqual(persona["avatarPublicPath"], "/a3/assets/teacher-avatar/practice-v3.vrm")
        self.assertFalse(persona["voicePreviewEnabled"])
        self.assertNotIn("instruction", persona)
        self.assertNotIn("voice", persona)
        self.assertNotIn("openaiVoice", json.dumps(persona))
        self.assertNotIn("dashscopeVoice", json.dumps(persona))

    def test_unknown_persona_is_rejected(self):
        response = self.post_message("invented-tutor")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"success": False, "error": "不支持该辅导风格"})
        self.assertFalse(CoachingSession.objects.filter(user=self.user).exists())

    def test_disabled_persona_is_rejected(self):
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(enabled=False)

        response = self.post_message("practice-coach")

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

    def test_switching_persona_replaces_message_less_snapshotted_session(self):
        historical_snapshot = {
            "id": "structured-teacher",
            "name": "Historical structured teacher",
            "shortDescription": "Original snapshot",
            "teachingStyle": "structured",
            "avatarAssetId": "teacher-historical-v1",
            "avatarPublicPath": "/a3/assets/teacher-avatar/historical.vrm",
            "voiceProfileId": "voice-historical",
            "voicePreviewEnabled": False,
            "allowedWorkflows": ["coaching"],
            "schemaVersion": "a3.tutor-persona.v1",
        }
        original = CoachingSession.objects.create(
            user=self.user,
            metadata={"tutorPersona": deepcopy(historical_snapshot), "fallbackUsed": False},
        )

        response = self.post_message("practice-coach")

        self.assertEqual(response.status_code, 201, response.content)
        self.assertNotEqual(response.json()["session"]["id"], str(original.id))
        original.refresh_from_db()
        self.assertEqual(original.status, CoachingSessionStatus.ENDED)
        self.assertEqual(original.metadata["tutorPersona"], historical_snapshot)
        replacement = CoachingSession.objects.get(id=response.json()["session"]["id"])
        self.assertEqual(replacement.metadata["tutorPersona"]["id"], "practice-coach")

    def test_same_persona_keeps_message_less_historical_snapshot_after_rebind(self):
        historical_snapshot = {
            "id": "practice-coach",
            "name": "Historical practice coach",
            "shortDescription": "Original snapshot",
            "teachingStyle": "practice",
            "avatarAssetId": "teacher-historical-v1",
            "avatarPublicPath": "/a3/assets/teacher-avatar/historical.vrm",
            "voiceProfileId": "voice-historical",
            "voicePreviewEnabled": False,
            "allowedWorkflows": ["coaching"],
            "schemaVersion": "a3.tutor-persona.v1",
        }
        original = CoachingSession.objects.create(
            user=self.user,
            metadata={"tutorPersona": deepcopy(historical_snapshot), "fallbackUsed": False},
        )

        response = self.post_message("practice-coach")

        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["session"]["id"], str(original.id))
        original.refresh_from_db()
        self.assertEqual(original.status, CoachingSessionStatus.ACTIVE)
        self.assertEqual(original.metadata["tutorPersona"], historical_snapshot)
        self.assertEqual(response.json()["session"]["tutorPersona"], historical_snapshot)
        self.assertEqual(CoachingSession.objects.filter(user=self.user).count(), 1)

    def test_same_persona_keeps_snapshot_when_configuration_fallback_changes(self):
        current_snapshot = {
            "id": "structured-teacher",
            "name": "结构讲解",
            "shortDescription": "先搭框架，再分步骤讲清概念",
            "teachingStyle": "structured",
            "avatarAssetId": "teacher-default-v1",
            "avatarPublicPath": "/a3/assets/teacher-avatar/teacher.vrm",
            "voiceProfileId": "voice-clear-guide",
            "voicePreviewEnabled": True,
            "allowedWorkflows": ["coaching", "classroom", "explain", "review", "plan"],
            "schemaVersion": "a3.tutor-persona.v1",
        }
        original = CoachingSession.objects.create(
            user=self.user,
            metadata={"tutorPersona": deepcopy(current_snapshot), "fallbackUsed": False},
        )
        invalidate_tutor_persona_overlay_cache()

        with patch.object(
            TutorPersonaConfiguration.objects,
            "select_related",
            side_effect=OperationalError("table unavailable"),
        ):
            response = self.post_message("structured-teacher")

        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["session"]["id"], str(original.id))
        original.refresh_from_db()
        self.assertEqual(original.metadata["tutorPersona"], current_snapshot)
        self.assertFalse(original.metadata["fallbackUsed"])
        self.assertEqual(CoachingSession.objects.filter(user=self.user).count(), 1)

    def test_implicit_preference_change_keeps_active_session_identity(self):
        first = self.post_message("structured-teacher", "user-1")
        profile = self.user.learner_profile
        profile.extra_profile = {
            "tutorPreference": {
                "personaId": "practice-coach",
                "schemaVersion": "a3.tutor-preference.v1",
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        second = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"id": "user-2", "role": "user", "content": "Continue."}]}),
            content_type="application/json",
        )

        self.assertEqual(second.status_code, 201, second.content)
        self.assertEqual(second.json()["session"]["id"], first.json()["session"]["id"])
        self.assertEqual(second.json()["session"]["tutorPersona"]["id"], "structured-teacher")

    def test_no_available_persona_returns_503_for_new_coaching_session(self):
        TutorPersonaConfiguration.objects.update(enabled=False)

        response = self.post_message("structured-teacher")

        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(
            response.json(),
            {"success": False, "error": "当前没有可用的辅导风格"},
        )
        self.assertFalse(CoachingSession.objects.filter(user=self.user).exists())

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

    def test_missing_persona_falls_back_from_disabled_saved_preference(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "tutorPreference": {
                "personaId": "practice-coach",
                "schemaVersion": "a3.tutor-preference.v1",
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(enabled=False)

        response = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"id": "user-1", "role": "user", "content": "Explain."}]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201, response.content)
        session = CoachingSession.objects.get(user=self.user)
        self.assertEqual(session.metadata["tutorPersona"]["id"], "structured-teacher")
        self.assertTrue(session.metadata["fallbackUsed"])
        profile.refresh_from_db()
        self.assertEqual(profile.extra_profile["tutorPreference"]["personaId"], "practice-coach")

    def test_default_fallback_is_session_evidence_not_preference_source(self):
        TutorPersonaConfiguration.objects.filter(persona_id="structured-teacher").update(enabled=False)

        response = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"id": "user-1", "role": "user", "content": "Explain."}]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201, response.content)
        session = CoachingSession.objects.get(user=self.user)
        self.assertEqual(session.metadata["tutorPersona"]["id"], "socratic-guide")
        self.assertTrue(session.metadata["fallbackUsed"])
        preference = self.client.get("/api/profiles/tutor-preference/").json()["preference"]
        self.assertEqual(preference["source"], "default")

    def test_unavailable_configuration_table_does_not_break_new_session(self):
        invalidate_tutor_persona_overlay_cache()
        with patch.object(
            TutorPersonaConfiguration.objects,
            "select_related",
            side_effect=OperationalError("table unavailable"),
        ):
            response = self.post_message("structured-teacher")

        self.assertEqual(response.status_code, 201, response.content)
        session = CoachingSession.objects.get(user=self.user)
        self.assertEqual(session.metadata["tutorPersona"]["id"], "structured-teacher")
        self.assertEqual(
            session.metadata["tutorPersona"]["avatarPublicPath"],
            "/a3/assets/teacher-avatar/teacher.vrm",
        )
        self.assertTrue(session.metadata["fallbackUsed"])
