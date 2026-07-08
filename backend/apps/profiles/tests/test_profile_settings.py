from __future__ import annotations

import json

from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.compat.models import AgentRun
from backend.apps.learning.models import Course, LearningPath
from backend.apps.profiles.models import LearnerProfile


class ProfileSettingsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800002001", password="Password123", display_name="设置同学")
        self.client = Client()
        self.client.force_login(self.user)

    def test_optional_consents_are_saved_to_extra_profile(self):
        response = self.client.patch(
            "/api/profiles/me/",
            data=json.dumps({"consents": {"courseNotifications": False, "learningData": True}}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        profile = LearnerProfile.objects.get(user=self.user)
        self.assertEqual(profile.extra_profile["consents"]["courseNotifications"], False)
        self.assertEqual(profile.extra_profile["consents"]["learningData"], True)

        response = self.client.get("/api/profiles/me/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["profile"]["extraProfile"]["consents"]["courseNotifications"], False)

    def test_profile_payload_includes_profile_snapshot(self):
        profile, _ = LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "grade": "Grade 2",
                "major_direction": "Automation",
                "foundation_level": "Intermediate",
                "daily_study_time": 60,
                "learning_goals": ["Master control theory"],
                "weak_points": ["Root locus"],
                "expected_resources": ["Practice bank"],
                "extra_profile": {"existingKey": "preserved"},
            },
        )

        response = self.client.get("/api/profiles/me/")

        self.assertEqual(response.status_code, 200)
        extra_profile = response.json()["profile"]["extraProfile"]
        snapshot = extra_profile["profileSnapshot"]
        self.assertEqual(snapshot["schemaVersion"], "a3.profile-snapshot.v1")
        self.assertIn("weakPoints", snapshot["dimensions"])
        self.assertIn("dynamicProfileV2", extra_profile)
        self.assertEqual(extra_profile["dynamicProfileV2"], snapshot)
        self.assertEqual(extra_profile["existingKey"], "preserved")
        profile.refresh_from_db()
        self.assertNotIn("profileSnapshot", profile.extra_profile)
        self.assertNotIn("dynamicProfileV2", profile.extra_profile)

    def test_self_service_profile_cannot_escalate_role(self):
        response = self.client.patch(
            "/api/profiles/me/",
            data=json.dumps({"role": "teacher"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.role, "student")

    def test_self_service_same_role_advances_onboarding(self):
        self.user.onboarding_step = "role"
        self.user.phone_bound = True
        self.user.save(update_fields=["onboarding_step", "phone_bound"])

        response = self.client.patch(
            "/api/profiles/me/",
            data=json.dumps({"role": "student"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["user"]["role"], "student")
        self.assertEqual(payload["user"]["onboardingStep"], "welcome")

    def test_profile_options_return_course_knowledge_points(self):
        response = self.client.get("/api/profiles/options/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["course"]["code"], "AUTO-CONTROL-001")
        weak_labels = {item["label"] for item in data["options"]["weakPoints"]}
        self.assertIn("根轨迹基本规则", weak_labels)
        self.assertIn("频率特性与伯德图", weak_labels)

    def test_profile_options_require_login(self):
        self.client.logout()
        response = self.client.get("/api/profiles/options/")
        self.assertEqual(response.status_code, 401)

    def test_profile_options_succeed_without_courses(self):
        Course.objects.all().delete()
        response = self.client.get("/api/profiles/options/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertIsNone(data["course"])
        self.assertEqual(data["options"]["weakPoints"], [])

    def test_binding_phone_used_by_another_account_returns_400(self):
        other = User.objects.create_user(phone="13800002002", password="Password123", display_name="Other")
        response = self.client.patch(
            "/api/profiles/me/",
            data=json.dumps({"phone": other.phone, "code": "123456"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        self.user.refresh_from_db()
        self.assertEqual(self.user.phone, "13800002001")

    def test_learning_profile_rejects_non_list_fields(self):
        response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps({"learningGoals": "not-a-list"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_learning_profile_rejects_unsupported_domain_values(self):
        response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps({"majorDirection": "Computer Science", "dailyStudyTime": "60"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_learning_profile_valid_domain_payload_is_saved(self):
        options = self.client.get("/api/profiles/options/").json()["options"]
        weak_point = options["weakPoints"][0]["value"]
        payload = {
            "displayName": "Control Learner",
            "majorDirection": options["majorDirections"][0],
            "grade": options["grades"][0],
            "foundationLevel": options["foundationLevels"][0],
            "dailyStudyTime": options["dailyStudyTimes"][0],
            "pace": options["paces"][0]["value"],
            "learningGoals": [options["learningGoals"][0]],
            "learningPreferences": [options["learningPreferences"][0]],
            "expectedResources": [options["expectedResources"][0]],
            "weakPoints": [weak_point],
        }

        response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps(payload),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        profile = LearnerProfile.objects.get(user=self.user)
        self.assertEqual(profile.daily_study_time, int(options["dailyStudyTimes"][0]))
        self.assertEqual(profile.weak_points, [weak_point])
        self.user.refresh_from_db()
        self.assertEqual(self.user.display_name, "Control Learner")

    def test_learning_profile_save_returns_readiness_and_refreshes_plan(self):
        self.user.privacy_accepted = True
        self.user.save(update_fields=["privacy_accepted", "updated_at"])
        options = self.client.get("/api/profiles/options/").json()["options"]
        weak_point = options["weakPoints"][0]["value"]
        payload = {
            "displayName": "Control Learner",
            "majorDirection": options["majorDirections"][0],
            "grade": options["grades"][0],
            "foundationLevel": options["foundationLevels"][0],
            "dailyStudyTime": "60",
            "pace": "standard",
            "learningGoals": [options["learningGoals"][0]],
            "learningPreferences": [options["learningPreferences"][0]],
            "expectedResources": [options["expectedResources"][0]],
            "weakPoints": [weak_point],
        }

        response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps(payload),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["profileReadiness"]["status"], "ready")
        self.assertGreaterEqual(data["profileReadiness"]["score"], 90)
        self.assertEqual(data["nextAction"]["href"], "/a3/admission-diagnostic")
        self.assertTrue(data["generated"]["path"])
        self.assertTrue(data["generated"]["studyPlan"])
        self.assertTrue(LearningPath.objects.filter(user=self.user, status="active").exists())
        self.user.learner_profile.refresh_from_db()
        self.assertIn("studyPlan", self.user.learner_profile.extra_profile)

    def test_learning_profile_save_runs_structured_profile_agent_workflow(self):
        self.user.privacy_accepted = True
        self.user.save(update_fields=["privacy_accepted", "updated_at"])
        options = self.client.get("/api/profiles/options/").json()["options"]
        weak_point = options["weakPoints"][0]["value"]
        payload = {
            "displayName": "Agent Profile Learner",
            "majorDirection": options["majorDirections"][0],
            "grade": options["grades"][0],
            "foundationLevel": options["foundationLevels"][0],
            "dailyStudyTime": "60",
            "pace": "standard",
            "learningGoals": [options["learningGoals"][0]],
            "learningPreferences": [options["learningPreferences"][0]],
            "expectedResources": [options["expectedResources"][0]],
            "weakPoints": [weak_point],
        }

        response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps(payload),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertIn("traceId", data)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=data["traceId"])
        self.assertEqual(run.workflow, "profile_setup")
        self.assertEqual(run.status, "completed")
        step_names = list(run.steps.order_by("order").values_list("name", flat=True))
        self.assertEqual(
            step_names,
            ["ProfileNormalizeAgent", "ProfileCommitAgent", "PlannerAgent", "StudyPlanAgent"],
        )
        commit_step = run.steps.get(name="ProfileCommitAgent")
        self.assertEqual(commit_step.metadata["evidence"]["persistTarget"], "LearnerProfile")
        self.assertGreaterEqual(commit_step.metadata["evidence"]["updatedFieldCount"], 8)
        plan_step = run.steps.get(name="StudyPlanAgent")
        self.assertTrue(plan_step.metadata["quality"]["studyPlanGenerated"])
        self.assertTrue(data["generated"]["path"])
        self.assertTrue(data["generated"]["studyPlan"])

    def test_learning_profile_response_explains_personalization_impact(self):
        self.user.privacy_accepted = True
        self.user.save(update_fields=["privacy_accepted", "updated_at"])
        options = self.client.get("/api/profiles/options/").json()["options"]
        weak_points = [item["value"] for item in options["weakPoints"][:2]]

        weak_payload = {
            "displayName": "Weak Learner",
            "majorDirection": options["majorDirections"][0],
            "grade": options["grades"][0],
            "foundationLevel": options["foundationLevels"][0],
            "dailyStudyTime": options["dailyStudyTimes"][0],
            "pace": options["paces"][0]["value"],
            "learningGoals": [options["learningGoals"][0]],
            "learningPreferences": [options["learningPreferences"][0]],
            "expectedResources": [options["expectedResources"][0]],
            "weakPoints": [weak_points[0]],
        }
        strong_payload = {
            **weak_payload,
            "displayName": "Strong Learner",
            "foundationLevel": options["foundationLevels"][-1],
            "dailyStudyTime": options["dailyStudyTimes"][-2],
            "pace": options["paces"][-1]["value"],
            "weakPoints": [weak_points[-1]],
        }

        weak_response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps(weak_payload),
            content_type="application/json",
        )
        refreshed_options = self.client.get("/api/profiles/options/").json()["options"]
        refreshed_weak_points = [item["value"] for item in refreshed_options["weakPoints"][:2]]
        strong_payload.update({
            "majorDirection": refreshed_options["majorDirections"][0],
            "grade": refreshed_options["grades"][0],
            "foundationLevel": refreshed_options["foundationLevels"][-1],
            "dailyStudyTime": refreshed_options["dailyStudyTimes"][-2],
            "learningGoals": [refreshed_options["learningGoals"][0]],
            "learningPreferences": [refreshed_options["learningPreferences"][0]],
            "expectedResources": [refreshed_options["expectedResources"][0]],
            "weakPoints": [refreshed_weak_points[-1]],
        })
        strong_response = self.client.post(
            "/api/profiles/learning-profile/",
            data=json.dumps(strong_payload),
            content_type="application/json",
        )

        self.assertEqual(weak_response.status_code, 200, weak_response.content)
        self.assertEqual(strong_response.status_code, 200, strong_response.content)
        weak_impact = weak_response.json()["personalizationImpact"]
        strong_impact = strong_response.json()["personalizationImpact"]
        self.assertEqual(weak_impact["profileInputs"]["foundationLevel"], options["foundationLevels"][0])
        self.assertEqual(strong_impact["profileInputs"]["foundationLevel"], refreshed_options["foundationLevels"][-1])
        self.assertEqual(weak_impact["profileInputs"]["weakPoints"], [weak_points[0]])
        self.assertEqual(strong_impact["profileInputs"]["weakPoints"], [refreshed_weak_points[-1]])
        self.assertNotEqual(weak_impact["plan"]["dailyMinutes"], strong_impact["plan"]["dailyMinutes"])
        self.assertNotEqual(weak_impact["plan"]["mode"], strong_impact["plan"]["mode"])
        self.assertTrue(weak_impact["pathFocus"])
        self.assertIn("reason", weak_impact["plan"])

    def test_profile_extract_requires_privacy_consent(self):
        self.user.privacy_accepted = False
        self.user.save(update_fields=["privacy_accepted", "updated_at"])

        response = self.client.post(
            "/api/profile/extract/",
            data=json.dumps({"text": "我是大二学生，每天学习60分钟，薄弱点是根轨迹。"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(response.json()["success"])
