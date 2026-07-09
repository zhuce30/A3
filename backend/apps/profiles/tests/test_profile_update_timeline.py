from __future__ import annotations

from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_updates import create_profile_update_candidate, create_profile_update_candidates_from_event


class ProfileUpdateTimelineApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13800003101",
            password="Password123",
            display_name="Profile Timeline Learner",
        )
        self.profile = LearnerProfile.objects.create(
            user=self.user,
            foundation_level="基础一般",
            weak_points=["根轨迹"],
            learning_preferences={"cognitiveStyle": "先看例题再总结"},
            extra_profile={"motivationRisk": "低"},
        )
        self.client.force_login(self.user)

    def test_dynamic_profile_api_returns_timeline_and_confirmation_queue(self):
        candidate = create_profile_update_candidate(
            self.profile,
            dimension="motivationRisk",
            previous_value="低",
            next_value="连续两天任务未完成，需要降低负荷",
            source="learning_event_stream",
            evidence={"eventTypes": ["task_skip", "practice_low_accuracy"], "windowDays": 7},
            confidence=0.72,
            conflict_explanation="用户自报动力稳定，但最近任务完成率下降。",
        )

        response = self.client.get("/api/profiles/dynamic-profile/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("dynamicProfile", payload)
        self.assertIn("profileSnapshot", payload)
        self.assertEqual(payload["schemaVersion"], "a3.dynamic-profile-feed.v1")
        self.assertEqual(payload["confirmationQueue"][0]["id"], candidate["id"])
        self.assertEqual(payload["confirmationQueue"][0]["changedDimensions"], ["motivationRisk"])
        self.assertEqual(payload["confirmationQueue"][0]["previousValue"], "低")
        self.assertEqual(payload["confirmationQueue"][0]["nextValue"], "连续两天任务未完成，需要降低负荷")
        self.assertEqual(payload["confirmationQueue"][0]["source"], "learning_event_stream")
        self.assertEqual(payload["confirmationQueue"][0]["confidence"], 0.72)
        self.assertEqual(payload["confirmationQueue"][0]["conflictType"], "behavior_conflict")
        self.assertEqual(payload["confirmationQueue"][0]["conflictExplanation"], "用户自报动力稳定，但最近任务完成率下降。")
        self.assertEqual(payload["confirmationQueue"][0]["evidenceSummary"], "学习事件：task_skip、practice_low_accuracy；观察窗口 7 天")
        self.assertIn("会影响今日任务、学习计划和推荐排序", payload["confirmationQueue"][0]["impactSummary"])
        self.assertEqual(payload["confirmationQueue"][0]["evidence"]["windowDays"], 7)
        self.assertEqual(payload["timeline"][0]["status"], "pending")

    def test_confirm_profile_update_applies_change_and_records_numbered_version(self):
        candidate = create_profile_update_candidate(
            self.profile,
            dimension="motivationRisk",
            previous_value="低",
            next_value="连续两天任务未完成，需要降低负荷",
            source="learning_event_stream",
            evidence={"eventTypes": ["task_skip"], "windowDays": 7},
            confidence=0.81,
        )

        response = self.client.post(f"/api/profiles/profile-updates/{candidate['id']}/confirm/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["update"]["status"], "confirmed")
        self.assertEqual(payload["update"]["versionNumber"], 1)
        self.assertEqual(payload["dynamicProfile"]["motivationRisk"], "连续两天任务未完成，需要降低负荷")
        self.profile.refresh_from_db()
        self.assertEqual(self.profile.extra_profile["motivationRisk"], "连续两天任务未完成，需要降低负荷")
        self.assertEqual(self.profile.extra_profile["profileVersions"][0]["status"], "confirmed")
        self.assertEqual(self.profile.extra_profile["profileVersions"][0]["changedDimensions"], ["motivationRisk"])
        self.assertEqual(self.profile.extra_profile["profileVersions"][0]["versionNumber"], 1)

    def test_reject_profile_update_keeps_current_value_and_records_reason(self):
        candidate = create_profile_update_candidate(
            self.profile,
            dimension="motivationRisk",
            previous_value="低",
            next_value="连续两天任务未完成，需要降低负荷",
            source="learning_event_stream",
            evidence={"eventTypes": ["task_skip"], "windowDays": 7},
            confidence=0.81,
        )

        response = self.client.post(
            f"/api/profiles/profile-updates/{candidate['id']}/reject/",
            data={"reason": "这周只是临时请假"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["update"]["status"], "rejected")
        self.assertEqual(payload["update"]["versionNumber"], 1)
        self.profile.refresh_from_db()
        self.assertEqual(self.profile.extra_profile["motivationRisk"], "低")
        self.assertEqual(self.profile.extra_profile["profileVersions"][0]["status"], "rejected")
        self.assertEqual(self.profile.extra_profile["profileVersions"][0]["rejectionReason"], "这周只是临时请假")


class ProfileUpdateCandidateEngineTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13800003102",
            password="Password123",
            display_name="Candidate Engine Learner",
        )
        self.profile = LearnerProfile.objects.create(
            user=self.user,
            foundation_level="基础一般",
            weak_points=["根轨迹"],
            expected_resources=["知识卡片"],
            extra_profile={"motivationRisk": "低", "mistakePatterns": ["概念边界不清"]},
        )

    def test_diagnostic_wrong_classroom_and_resource_events_create_profile_update_candidates(self):
        diagnostic = create_profile_update_candidates_from_event(
            self.profile,
            event_type="admission_diagnostic",
            source="admission_diagnostic",
            signals={"foundationLevel": "基础较弱", "weakPoints": ["虚拟内存", "死锁"]},
            evidence={"diagnosticId": "diag-001", "score": 42},
        )
        wrong = create_profile_update_candidates_from_event(
            self.profile,
            event_type="assessment_wrong_answer",
            source="assessment",
            signals={"weakPoints": ["虚拟内存"], "errorCauses": ["公式套用不稳"], "wrongCount": 3},
            evidence={"wrongQuestionId": "wq-001"},
        )
        classroom = create_profile_update_candidates_from_event(
            self.profile,
            event_type="classroom_qa",
            source="classroom",
            signals={"questionCount": 4, "verified": True},
            evidence={"sessionId": "classroom-001"},
            raw_preview="我需要先看图再做例题，死锁这里总是混淆。",
        )
        resource = create_profile_update_candidates_from_event(
            self.profile,
            event_type="resource_feedback",
            source="resource_feedback",
            signals={"resourceType": "mind_map", "action": "completed", "score": 5},
            evidence={"packId": "pack-001"},
        )

        self.profile.refresh_from_db()
        queue = self.profile.extra_profile["profileUpdateCandidates"]
        dimensions = [item["changedDimensions"][0] for item in queue]

        self.assertTrue(diagnostic)
        self.assertTrue(wrong)
        self.assertTrue(classroom)
        self.assertTrue(resource)
        self.assertIn("foundationLevel", dimensions)
        self.assertIn("weakPoints", dimensions)
        self.assertIn("mistakePatterns", dimensions)
        self.assertIn("cognitiveStyle", dimensions)
        self.assertIn("resourcePreferences", dimensions)
        self.assertTrue(all(item["status"] == "pending" for item in queue))
        self.assertEqual(queue[0]["source"], "resource_feedback")
        self.assertTrue(all(item.get("evidenceSummary") for item in queue))
        self.assertTrue(all(item.get("impactSummary") for item in queue))
