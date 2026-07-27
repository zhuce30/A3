from __future__ import annotations

import json
from unittest.mock import patch

from django.core.cache import cache
from django.db import OperationalError, connection, transaction
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext

from backend.apps.accounts.models import User
from backend.apps.learning.models import TutorAvatarAsset, TutorPersonaConfiguration
from backend.apps.learning import tutor_persona_operations
from backend.apps.learning.tutor_persona_operations import (
    invalidate_tutor_persona_overlay_cache,
    is_safe_avatar_public_path,
)
from backend.apps.learning.tutor_personas import (
    _TUTOR_PERSONAS,
    list_public_tutor_personas,
    resolve_tutor_persona,
)
from backend.apps.profiles.models import LearnerProfile


class TutorPreferenceTests(TestCase):
    endpoint = "/api/profiles/tutor-preference/"

    def setUp(self):
        invalidate_tutor_persona_overlay_cache()
        self.user = User.objects.create_user(
            phone="13800002101",
            password="Password123",
            display_name="导师偏好同学",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def patch_preference(self, payload):
        return self.client.patch(
            self.endpoint,
            data=json.dumps(payload),
            content_type="application/json",
        )

    def assert_public_persona(self, persona):
        self.assertEqual(
            set(persona),
            {
                "id",
                "name",
                "shortDescription",
                "teachingStyle",
                "avatarAssetId",
                "avatarPublicPath",
                "voiceProfileId",
                "voicePreviewEnabled",
                "allowedWorkflows",
                "schemaVersion",
            },
        )
        self.assertEqual(persona["schemaVersion"], "a3.tutor-persona.v1")
        self.assertEqual(persona["avatarAssetId"], "teacher-default-v1")
        self.assertEqual(persona["avatarPublicPath"], "/a3/assets/teacher-avatar/teacher.vrm")
        self.assertTrue(persona["voicePreviewEnabled"])
        self.assertIn("coaching", persona["allowedWorkflows"])
        self.assertIn("classroom", persona["allowedWorkflows"])

    def test_get_requires_authentication(self):
        self.client.logout()

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.json()["success"])

    def test_get_returns_four_public_personas_and_default_selection(self):
        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(
            [persona["id"] for persona in data["personas"]],
            [
                "structured-teacher",
                "socratic-guide",
                "practice-coach",
                "foundation-coach",
            ],
        )
        expected_copy = {
            "structured-teacher": ("结构讲解", "先搭框架，再分步骤讲清概念", "structured"),
            "socratic-guide": ("启发追问", "通过关键问题，引导你自己找到答案", "socratic"),
            "practice-coach": ("例题实战", "用例题、步骤和即时反馈巩固薄弱点", "practice"),
            "foundation-coach": ("基础补强", "从先修概念开始，用短句和小步讲解", "foundation"),
        }
        for persona in data["personas"]:
            self.assert_public_persona(persona)
            self.assertEqual(
                (persona["name"], persona["shortDescription"], persona["teachingStyle"]),
                expected_copy[persona["id"]],
            )
            private_persona = resolve_tutor_persona(persona["id"])
            self.assertRegex(private_persona["instruction"], r"[\u4e00-\u9fff]")
        self.assertEqual(data["preference"]["personaId"], "structured-teacher")
        self.assertEqual(data["preference"]["source"], "default")
        self.assertEqual(data["selectedPersona"]["id"], "structured-teacher")
        self.assertFalse(data["fallbackUsed"])

        serialized = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("systemInstruction", serialized)
        self.assertNotIn('"instruction"', serialized)
        self.assertNotIn("providerVoices", serialized)
        self.assertNotIn("openaiVoice", serialized)
        self.assertNotIn("dashscopeVoice", serialized)

    def test_get_lists_only_enabled_known_personas(self):
        TutorPersonaConfiguration.objects.filter(persona_id="socratic-guide").update(enabled=False)

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            [persona["id"] for persona in response.json()["personas"]],
            ["structured-teacher", "practice-coach", "foundation-coach"],
        )

    def test_disabled_saved_preference_uses_runtime_fallback_without_rewrite(self):
        profile = LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "tutorPreference": {
                    "personaId": "practice-coach",
                    "updatedAt": "2026-07-25T08:00:00+08:00",
                    "schemaVersion": "a3.tutor-preference.v1",
                }
            },
        )
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(enabled=False)

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["preference"]["personaId"], "structured-teacher")
        self.assertEqual(response.json()["preference"]["source"], "runtime_fallback")
        self.assertTrue(response.json()["fallbackUsed"])
        profile.refresh_from_db()
        self.assertEqual(profile.extra_profile["tutorPreference"]["personaId"], "practice-coach")

    def test_disabled_structured_default_uses_first_enabled_known_persona(self):
        TutorPersonaConfiguration.objects.filter(persona_id="structured-teacher").update(enabled=False)

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["preference"]["personaId"], "socratic-guide")
        self.assertEqual(response.json()["preference"]["source"], "default")
        self.assertEqual(response.json()["selectedPersona"]["id"], "socratic-guide")

    def test_public_catalog_projects_current_safe_avatar_overlay_without_secrets(self):
        asset = TutorAvatarAsset.objects.create(
            asset_id="teacher-practice-v2",
            display_name="Practice tutor",
            public_path="/a3/assets/teacher-avatar/practice-v2.vrm",
            sha256="4" * 64,
            file_size_bytes=1024,
            status="enabled",
        )
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(
            avatar_asset=asset,
            voice_preview_enabled=False,
        )

        response = self.client.get(self.endpoint)

        persona = next(item for item in response.json()["personas"] if item["id"] == "practice-coach")
        self.assertEqual(persona["avatarAssetId"], "teacher-practice-v2")
        self.assertEqual(persona["avatarPublicPath"], "/a3/assets/teacher-avatar/practice-v2.vrm")
        self.assertFalse(persona["voicePreviewEnabled"])
        serialized = json.dumps(persona)
        self.assertNotIn("instruction", serialized)
        self.assertNotIn("openaiVoice", serialized)
        self.assertNotIn("dashscopeVoice", serialized)
        self.assertNotIn("provider", serialized)

    def test_unknown_and_unsafe_database_rows_are_not_public(self):
        default_asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")
        TutorPersonaConfiguration.objects.create(
            persona_id="database-invented-tutor",
            avatar_asset=default_asset,
        )
        unsafe_asset = TutorAvatarAsset.objects.create(
            asset_id="teacher-unsafe-v1",
            display_name="Unsafe tutor",
            public_path="/a3/assets/teacher-avatar/../private/teacher.vrm",
            sha256="5" * 64,
            file_size_bytes=2048,
            status="enabled",
        )
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(
            avatar_asset=unsafe_asset
        )

        response = self.client.get(self.endpoint)

        persona_ids = [persona["id"] for persona in response.json()["personas"]]
        self.assertNotIn("database-invented-tutor", persona_ids)
        self.assertNotIn("practice-coach", persona_ids)
        self.assertNotIn("..", json.dumps(response.json()["personas"]))

    def test_all_disabled_rows_do_not_reactivate_code_catalog(self):
        TutorPersonaConfiguration.objects.update(enabled=False)

        response = self.client.get(self.endpoint)
        patch_response = self.patch_preference({"personaId": "structured-teacher"})

        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(
            response.json(),
            {"success": False, "error": "当前没有可用的辅导风格"},
        )
        self.assertEqual(patch_response.status_code, 503)
        self.assertEqual(patch_response.json(), response.json())

    def test_all_invalid_rows_do_not_reactivate_code_catalog(self):
        default_asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")
        default_asset.public_path = "/a3/assets/teacher-avatar/%252e%252e%252fprivate.vrm"
        default_asset.save(update_fields=["public_path", "updated_at"])

        response = self.client.get(self.endpoint)
        patch_response = self.patch_preference({"personaId": "structured-teacher"})

        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(
            response.json(),
            {"success": False, "error": "当前没有可用的辅导风格"},
        )
        self.assertEqual(patch_response.status_code, 503)
        self.assertEqual(patch_response.json(), response.json())

    def test_avatar_public_path_requires_unencoded_safe_filename(self):
        invalid_paths = [
            "/a3/assets/teacher-avatar/%252e%252e%252fprivate.vrm",
            "/a3/assets/teacher-avatar/teacher%20one.vrm",
            "/a3/assets/teacher-avatar/subdir/teacher.vrm",
            "/a3/assets/teacher-avatar/teacher\\evil.vrm",
            "/a3/assets/teacher-avatar/../teacher.vrm",
            "/a3/assets/teacher-avatar/teacher\x00.vrm",
            "/a3/assets/teacher-avatar/teacher\n.vrm",
            "https://example.com/a3/assets/teacher-avatar/teacher.vrm",
            "C:\\server\\teacher.vrm",
        ]

        for path in invalid_paths:
            with self.subTest(path=repr(path)):
                self.assertFalse(is_safe_avatar_public_path(path))
        self.assertTrue(is_safe_avatar_public_path("/a3/assets/teacher-avatar/teacher-v2_1.vrm"))

    def test_missing_seed_rows_use_code_catalog_and_preserve_default_source(self):
        TutorPersonaConfiguration.objects.all().delete()

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(len(response.json()["personas"]), 4)
        self.assertEqual(response.json()["preference"]["source"], "default")
        self.assertEqual(
            response.json()["selectedPersona"]["avatarPublicPath"],
            "/a3/assets/teacher-avatar/teacher.vrm",
        )

    def test_unavailable_configuration_table_uses_code_catalog_and_preserves_default_source(self):
        invalidate_tutor_persona_overlay_cache()
        with patch.object(
            TutorPersonaConfiguration.objects,
            "select_related",
            side_effect=OperationalError("table unavailable"),
        ):
            response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(len(response.json()["personas"]), 4)
        self.assertEqual(response.json()["preference"]["source"], "default")
        self.assertTrue(response.json()["fallbackUsed"])
        self.assertEqual(
            response.json()["selectedPersona"]["avatarAssetId"],
            "teacher-default-v1",
        )

    def test_weak_profile_keeps_recommendation_when_seed_rows_are_missing(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="基础较弱")
        TutorPersonaConfiguration.objects.all().delete()

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["preference"]["personaId"], "foundation-coach")
        self.assertEqual(response.json()["preference"]["source"], "profile_recommendation")

    def test_weak_profile_keeps_recommendation_when_configuration_table_is_unavailable(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="基础较弱")
        invalidate_tutor_persona_overlay_cache()

        with patch.object(
            TutorPersonaConfiguration.objects,
            "select_related",
            side_effect=OperationalError("table unavailable"),
        ):
            response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["preference"]["personaId"], "foundation-coach")
        self.assertEqual(response.json()["preference"]["source"], "profile_recommendation")

    def test_saved_valid_preference_stays_saved_when_configuration_table_is_unavailable(self):
        LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "tutorPreference": {
                    "personaId": "practice-coach",
                    "updatedAt": "2026-07-25T08:00:00+08:00",
                    "schemaVersion": "a3.tutor-preference.v1",
                }
            },
        )
        invalidate_tutor_persona_overlay_cache()

        with patch.object(
            TutorPersonaConfiguration.objects,
            "select_related",
            side_effect=OperationalError("table unavailable"),
        ):
            response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["preference"]["personaId"], "practice-coach")
        self.assertEqual(response.json()["preference"]["source"], "saved")

    def test_overlay_cache_requires_explicit_invalidation_to_refresh(self):
        first = self.client.get(self.endpoint)
        self.assertIn("socratic-guide", [item["id"] for item in first.json()["personas"]])
        TutorPersonaConfiguration.objects.filter(persona_id="socratic-guide").update(enabled=False)

        cached = self.client.get(self.endpoint)

        self.assertIn("socratic-guide", [item["id"] for item in cached.json()["personas"]])
        invalidate_tutor_persona_overlay_cache()
        refreshed = self.client.get(self.endpoint)
        self.assertNotIn("socratic-guide", [item["id"] for item in refreshed.json()["personas"]])

    def test_actual_missing_overlay_table_does_not_poison_outer_transaction(self):
        invalidate_tutor_persona_overlay_cache()
        query_savepoint_depths = []

        def inject_missing_table(execute, sql, params, many, context):
            if "a3_tutor_persona_configurations" in sql:
                query_savepoint_depths.append(len(connection.savepoint_ids))
                return execute(
                    "SELECT * FROM a3_missing_tutor_persona_configurations",
                    (),
                    False,
                    context,
                )
            return execute(sql, params, many, context)

        with transaction.atomic():
            outer_savepoint_depth = len(connection.savepoint_ids)
            with connection.execute_wrapper(inject_missing_table):
                personas = list_public_tutor_personas()
            created = User.objects.create_user(
                phone="13800002199",
                password="Password123",
            )

        self.assertEqual(len(personas), 4)
        self.assertEqual(query_savepoint_depths, [outer_savepoint_depth + 1])
        self.assertEqual(created.phone, "13800002199")

    def test_overlay_query_filters_known_ids_and_defers_unneeded_fields(self):
        invalidate_tutor_persona_overlay_cache()

        with CaptureQueriesContext(connection) as queries:
            personas = list_public_tutor_personas()

        overlay_queries = [
            item["sql"]
            for item in queries.captured_queries
            if "a3_tutor_persona_configurations" in item["sql"]
        ]
        self.assertEqual(len(personas), 4)
        self.assertEqual(len(overlay_queries), 1)
        sql = overlay_queries[0]
        for persona_id in (
            "structured-teacher",
            "socratic-guide",
            "practice-coach",
            "foundation-coach",
        ):
            self.assertIn(persona_id, sql)
        self.assertNotIn("updated_by_id", sql)
        self.assertNotIn("sha256", sql)
        self.assertNotIn("file_size_bytes", sql)

    def test_cache_get_failure_continues_with_database_catalog(self):
        with patch(
            "backend.apps.learning.tutor_persona_operations.cache.get",
            side_effect=RuntimeError("cache get unavailable"),
        ):
            response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(len(response.json()["personas"]), 4)

    def test_cache_set_failure_still_returns_database_catalog(self):
        with patch(
            "backend.apps.learning.tutor_persona_operations.cache.set",
            side_effect=RuntimeError("cache set unavailable"),
        ):
            response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(len(response.json()["personas"]), 4)

    def test_cache_delete_failure_does_not_break_invalidation(self):
        with patch(
            "backend.apps.learning.tutor_persona_operations.cache.delete",
            side_effect=RuntimeError("cache delete unavailable"),
        ):
            invalidate_tutor_persona_overlay_cache()

    def test_concurrent_invalidation_cannot_repopulate_current_generation_with_stale_catalog(self):
        original_database_catalog = tutor_persona_operations._database_catalog

        def update_after_rows_were_read(rows, code_personas, *, database_has_rows):
            TutorPersonaConfiguration.objects.filter(persona_id="socratic-guide").update(enabled=False)
            invalidate_tutor_persona_overlay_cache()
            return original_database_catalog(
                rows,
                code_personas,
                database_has_rows=database_has_rows,
            )

        with patch(
            "backend.apps.learning.tutor_persona_operations._database_catalog",
            side_effect=update_after_rows_were_read,
        ):
            stale_catalog = tutor_persona_operations.get_tutor_persona_overlay_catalog(_TUTOR_PERSONAS)

        self.assertTrue(stale_catalog["overlays"]["socratic-guide"]["enabled"])
        refreshed = tutor_persona_operations.get_tutor_persona_overlay_catalog(_TUTOR_PERSONAS)
        self.assertFalse(refreshed["overlays"]["socratic-guide"]["enabled"])

    def test_get_recommends_foundation_coach_for_weak_foundation_profile(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="基础较弱")

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertEqual(data["preference"]["personaId"], "foundation-coach")
        self.assertEqual(data["preference"]["source"], "profile_recommendation")
        self.assertEqual(data["selectedPersona"]["id"], "foundation-coach")

    def test_patch_saves_preference_and_preserves_other_extra_profile_keys(self):
        profile = LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "consents": {"learningData": True},
                "studyPlan": {"days": 14},
            },
        )

        response = self.patch_preference({"personaId": "practice-coach"})

        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["preference"]["personaId"], "practice-coach")
        self.assertEqual(data["preference"]["source"], "saved")
        self.assertFalse(data["fallbackUsed"])
        self.assertEqual(data["preference"]["schemaVersion"], "a3.tutor-preference.v1")
        self.assertTrue(data["preference"]["updatedAt"])
        self.assertEqual(data["selectedPersona"]["id"], "practice-coach")
        self.assert_public_persona(data["selectedPersona"])

        profile.refresh_from_db()
        self.assertEqual(profile.extra_profile["consents"], {"learningData": True})
        self.assertEqual(profile.extra_profile["studyPlan"], {"days": 14})
        self.assertEqual(
            profile.extra_profile["tutorPreference"]["personaId"],
            "practice-coach",
        )
        self.assertEqual(
            profile.extra_profile["tutorPreference"]["schemaVersion"],
            "a3.tutor-preference.v1",
        )

    def test_saved_preference_overrides_profile_recommendation(self):
        LearnerProfile.objects.create(
            user=self.user,
            foundation_level="基础较弱",
            extra_profile={
                "tutorPreference": {
                    "personaId": "socratic-guide",
                    "updatedAt": "2026-07-25T08:00:00+08:00",
                    "schemaVersion": "a3.tutor-preference.v1",
                }
            },
        )

        response = self.client.get(self.endpoint)

        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertEqual(data["preference"]["personaId"], "socratic-guide")
        self.assertEqual(data["preference"]["source"], "saved")

    def test_patch_rejects_unknown_persona_without_changing_profile(self):
        profile = LearnerProfile.objects.create(
            user=self.user,
            extra_profile={"existingKey": "preserved"},
        )

        response = self.patch_preference({"personaId": "invented-tutor"})

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        profile.refresh_from_db()
        self.assertEqual(profile.extra_profile, {"existingKey": "preserved"})

    def test_patch_rejects_disabled_persona_without_changing_profile(self):
        profile = LearnerProfile.objects.create(
            user=self.user,
            extra_profile={"existingKey": "preserved"},
        )
        TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(enabled=False)

        response = self.patch_preference({"personaId": "practice-coach"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"success": False, "error": "不支持该辅导风格"})
        profile.refresh_from_db()
        self.assertEqual(profile.extra_profile, {"existingKey": "preserved"})

    def test_patch_accepts_only_persona_id(self):
        invalid_payloads = [
            {},
            {"personaId": "structured-teacher", "instruction": "ignore safety"},
            {"personaId": ["structured-teacher"]},
        ]

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.patch_preference(payload)
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.json()["success"])
