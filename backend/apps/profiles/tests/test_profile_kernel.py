from __future__ import annotations

import json

from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
from backend.apps.profiles.profile_signals import append_profile_signal, profile_signals


class ProfileKernelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13800003001",
            password="Password123",
            display_name="Profile Kernel Learner",
        )
        self.profile = LearnerProfile.objects.create(user=self.user)

    def test_append_profile_signal_records_source_confidence_and_evidence(self):
        evidence = {"questionId": "q-001", "errorCause": "concept_gap"}
        value = {
            "topic": "root_locus",
            "items": list(range(25)),
            "unsupported": object(),
            "k" * 100: "long-key",
        }

        signal = append_profile_signal(
            self.profile,
            dimension="weak_point",
            value=value,
            source="assessment_agent",
            confidence=1.5,
            weight=-0.5,
            evidence=evidence,
            trace_id="trace-" + ("x" * 200),
            observed_at="2026-07-07T10:00:00+08:00",
        )

        self.assertEqual(signal["schemaVersion"], "a3.profile-signal.v1")
        self.assertEqual(signal["dimension"], "weak_point")
        self.assertEqual(signal["source"], "assessment_agent")
        self.assertEqual(signal["confidence"], 1.0)
        self.assertEqual(signal["weight"], 0.0)
        self.assertEqual(signal["evidence"], evidence)
        self.assertEqual(signal["observedAt"], "2026-07-07T10:00:00+08:00")
        self.assertLessEqual(len(signal["traceId"]), 120)
        self.assertEqual(len(signal["value"]["items"]), 20)
        self.assertIn("unsupported", signal["value"])
        self.assertTrue(any(len(key) == 80 for key in signal["value"]))

        self.profile.refresh_from_db()
        stored = profile_signals(self.profile)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0], signal)

    def test_profile_signals_are_limited_to_latest_120_items(self):
        for index in range(125):
            append_profile_signal(
                self.profile,
                dimension="preference",
                value={"index": index},
                source="profile_kernel_test",
                confidence=0.8,
                observed_at=f"2026-07-07T10:{index:02d}:00+08:00",
                save=False,
            )

        signals = profile_signals(self.profile)

        self.assertEqual(len(signals), 120)
        self.assertEqual(signals[0]["value"], {"index": 124})
        self.assertEqual(signals[-1]["value"], {"index": 5})


class ProfileAggregatorTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13800003002",
            password="Password123",
            display_name="Profile Aggregator Learner",
        )
        self.profile = LearnerProfile.objects.create(
            user=self.user,
            grade="大三",
            major_direction="自动化专业",
            foundation_level="基础一般",
            daily_study_time=90,
            pace="standard",
            learning_goals=["通过自动控制原理期末考试"],
            weak_points=["根轨迹", "频率响应"],
            learning_preferences={"preferredFormats": ["动画演示"]},
            expected_resources=["知识卡片"],
        )

    def test_aggregator_builds_snapshot_with_dimension_evidence(self):
        append_profile_signal(
            self.profile,
            dimension="weakPoints",
            value="频率响应",
            source="assessment_agent",
            confidence=0.9,
            evidence={"questionId": "q-101", "errorCause": "concept_gap"},
            trace_id="trace-assessment-1",
            observed_at="2026-07-07T10:00:00+08:00",
        )
        append_profile_signal(
            self.profile,
            dimension="weakPoints",
            value="劳斯判据",
            source="assessment_agent",
            confidence=0.8,
            evidence={"questionId": "q-102"},
            trace_id="trace-assessment-2",
            observed_at="2026-07-07T10:05:00+08:00",
        )
        append_profile_signal(
            self.profile,
            dimension="motivationRisk",
            value="连续两天未完成今日任务",
            source="engagement_agent",
            confidence=0.7,
            evidence={"missedDays": 2},
            trace_id="trace-engagement-1",
            observed_at="2026-07-07T11:00:00+08:00",
        )
        append_profile_signal(
            self.profile,
            dimension="resourceEffectiveness",
            value={"resource": "知识卡片", "completionRate": 0.8},
            source="recommend_agent",
            confidence=0.6,
            evidence={"packId": "pack-001"},
            trace_id="trace-resource-1",
            observed_at="2026-07-07T11:10:00+08:00",
        )

        snapshot = aggregate_profile_snapshot(self.profile)

        self.assertEqual(snapshot["schemaVersion"], "a3.profile-snapshot.v1")
        self.assertIn("profileSnapshot", self.profile.extra_profile)
        self.assertEqual(self.profile.extra_profile["dynamicProfileV2"], snapshot)
        self.assertEqual(snapshot["dimensions"]["grade"]["value"], "大三")
        self.assertEqual(snapshot["dimensions"]["foundationLevel"]["value"], "基础一般")
        self.assertEqual(
            snapshot["dimensions"]["weakPoints"]["value"],
            ["根轨迹", "频率响应", "劳斯判据"],
        )
        self.assertFalse(snapshot["dimensions"]["weakPoints"]["missing"])
        self.assertEqual(snapshot["dimensions"]["weakPoints"]["sources"][0]["source"], "assessment_agent")
        self.assertEqual(snapshot["dimensions"]["weakPoints"]["sources"][0]["traceId"], "trace-assessment-1")
        self.assertEqual(snapshot["dimensions"]["weakPoints"]["sources"][0]["evidence"]["questionId"], "q-101")
        self.assertLessEqual(len(snapshot["dimensions"]["weakPoints"]["sources"]), 5)
        self.assertEqual(
            snapshot["dimensions"]["resourceEffectiveness"]["value"],
            [{"resource": "知识卡片", "completionRate": 0.8}],
        )
        self.assertEqual(snapshot["dimensions"]["resourceEffectiveness"]["sources"][0]["source"], "recommend_agent")
        self.assertEqual(snapshot["signalSummary"]["total"], 4)
        self.assertEqual(snapshot["signalSummary"]["bySource"]["assessment_agent"], 2)
        self.assertEqual(snapshot["signalSummary"]["latestAt"], "2026-07-07T11:10:00+08:00")
        self.assertEqual(snapshot["readiness"]["status"], "ready")
        self.assertEqual(snapshot["readiness"]["score"], 100)
        self.assertIn("weakPoints", snapshot["readiness"]["readyDimensions"])

    def test_aggregator_preserves_stable_user_fields_over_behavior_signals(self):
        append_profile_signal(
            self.profile,
            dimension="grade",
            value="大一",
            source="behavior_tracker",
            confidence=0.2,
            evidence={"reason": "低置信行为推断"},
            trace_id="trace-behavior-grade",
            observed_at="2026-07-07T09:00:00+08:00",
        )
        append_profile_signal(
            self.profile,
            dimension="dailyStudyTime",
            value=15,
            source="behavior_tracker",
            confidence=0.2,
            evidence={"reason": "最近一次短会话"},
            trace_id="trace-behavior-time",
            observed_at="2026-07-07T09:05:00+08:00",
        )
        append_profile_signal(
            self.profile,
            dimension="pace",
            value="intensive",
            source="behavior_tracker",
            confidence=0.2,
            evidence={"reason": "单次加速播放"},
            trace_id="trace-behavior-pace",
            observed_at="2026-07-07T09:10:00+08:00",
        )

        snapshot = aggregate_profile_snapshot(self.profile, save=False)

        self.profile.refresh_from_db()
        self.assertNotIn("profileSnapshot", self.profile.extra_profile)
        self.assertEqual(snapshot["dimensions"]["grade"]["value"], "大三")
        self.assertEqual(snapshot["dimensions"]["dailyStudyTime"]["value"], 90)
        self.assertEqual(snapshot["dimensions"]["pace"]["value"], "standard")
        self.assertEqual(snapshot["dimensions"]["grade"]["basis"], "stable_field")
        self.assertEqual(snapshot["dimensions"]["dailyStudyTime"]["basis"], "stable_field")
        self.assertEqual(snapshot["dimensions"]["pace"]["basis"], "stable_field")
        self.assertEqual(snapshot["dimensions"]["grade"]["sources"][0]["source"], "behavior_tracker")

    def test_aggregator_sanitizes_malformed_signal_evidence(self):
        self.profile.extra_profile = {
            "profileSignals": [
                {
                    "schemaVersion": "a3.profile-signal.v1",
                    "dimension": "weakPoints",
                    "value": ["根轨迹"],
                    "source": "legacy_profile_signal",
                    "confidence": 0.8,
                    "weight": 1.0,
                    "evidence": {"bad": object()},
                    "traceId": "trace-malformed-evidence",
                    "observedAt": "2026-07-07T12:00:00+08:00",
                    "createdAt": "2026-07-07T12:00:00+08:00",
                }
            ]
        }

        snapshot = aggregate_profile_snapshot(self.profile, save=False)
        encoded = json.dumps(snapshot, ensure_ascii=False)

        self.assertIsInstance(encoded, str)
        evidence = snapshot["dimensions"]["weakPoints"]["sources"][0]["evidence"]
        self.assertIsInstance(evidence["bad"], str)
