from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User, UserAccessState, UserRole
from backend.apps.compat.models import AgentRun, ResourceGenerationJob, VideoGenerationJob
from backend.apps.knowledge_base.models import IndexJobType, KnowledgeIndexJob
from backend.apps.learning.models import CoachingSession, ResourcePackLog
from backend.apps.system.admin_overview import build_admin_overview
from backend.apps.system.models import AdminAuditLog, SecurityEvent


SHANGHAI = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 25, 4, 30, tzinfo=timezone.UTC)
SIX_STATES = {"queued", "running", "succeeded", "failed", "cancelled", "stale"}


class AdminOverviewTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = Client()
        self.admin = User.objects.create_user(
            phone="admin-overview",
            password="password123",
            role=UserRole.ADMIN,
        )
        self.student = User.objects.create_user(
            phone="student-overview",
            password="password123",
            role=UserRole.STUDENT,
        )
        self.client.force_login(self.admin)

    def tearDown(self):
        cache.clear()

    @patch("backend.apps.system.admin_overview.timezone.now", return_value=NOW)
    def test_returns_v2_real_data_contract_across_shanghai_dates(self, _now):
        self._seed_operational_records()

        response = self.client.get("/api/admin/overview/?range=7d")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["schemaVersion"], "a3.admin-overview.v2")
        self.assertEqual(payload["range"], "7d")
        self.assertEqual(payload["dataStatus"], "collected")
        self.assertEqual(payload["period"]["timeZone"], "Asia/Shanghai")
        self.assertEqual(payload["period"]["startDate"], "2026-07-19")
        self.assertEqual(payload["period"]["endDate"], "2026-07-25")

        trends = payload["trends"]
        self.assertEqual(len(trends), 7)
        self.assertEqual(
            [bucket["date"] for bucket in trends],
            [f"2026-07-{day:02d}" for day in range(19, 26)],
        )
        self.assertEqual(trends[0]["activeUsers"], 1)
        self.assertEqual(trends[0]["coachingSessions"], 1)
        self.assertEqual(trends[2]["resourcePacks"], 1)
        self.assertEqual(trends[5]["agentRuns"], 1)
        self.assertEqual(trends[6]["coachingSessions"], 0)

        self.assertEqual(payload["metrics"]["users"]["value"], 2)
        self.assertEqual(payload["metrics"]["newUsers"]["value"], 1)
        self.assertEqual(payload["metrics"]["activeUsers"]["value"], 1)
        self.assertEqual(payload["metrics"]["coachingSessions"]["value"], 2)
        self.assertEqual(payload["metrics"]["resourcePacks"]["value"], 1)
        self.assertEqual(payload["metrics"]["agentRuns"]["value"], 4)
        self.assertEqual(payload["metrics"]["agentFailureRate"]["value"], 25.0)
        self.assertEqual(payload["metrics"]["securityEvents"]["value"], 1)
        self.assertTrue(all(metric["dataStatus"] == "collected" for metric in payload["metrics"].values()))

        self.assertEqual(set(payload["taskTotals"]), SIX_STATES)
        self.assertEqual(
            payload["tasks"]["resource"],
            {"queued": 1, "running": 1, "succeeded": 1, "failed": 1, "cancelled": 1, "stale": 1},
        )
        self.assertEqual(payload["tasks"]["knowledge"]["stale"], 1)
        self.assertEqual(payload["tasks"]["agent"]["succeeded"], 1)
        self.assertEqual(payload["taskTotals"]["cancelled"], 3)
        self.assertGreaterEqual(payload["taskTotals"]["failed"], 4)
        self.assertEqual(payload["knowledgeBase"]["failedJobs"], 1)

        alert_types = {item["type"] for item in payload["alerts"]}
        self.assertIn("failed_tasks", alert_types)
        self.assertIn("stale_tasks", alert_types)
        self.assertIn("security_events", alert_types)
        self.assertTrue(all(item["dataStatus"] == "collected" for item in payload["alerts"]))

        activity_types = {item["type"] for item in payload["activity"]}
        self.assertIn("admin_audit", activity_types)
        self.assertIn("coaching_session", activity_types)
        self.assertIn("resource_pack", activity_types)
        self.assertIn("agent_run", activity_types)
        self.assertTrue(all(item["createdAt"] for item in payload["activity"]))

    def test_rejects_unsupported_ranges_without_changing_admin_permissions(self):
        response = self.client.get("/api/admin/overview/?range=14d")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"success": False, "error": "时间范围仅支持 24h、7d 或 30d"})

        self.client.logout()
        self.assertEqual(self.client.get("/api/admin/overview/?range=7d").status_code, 401)
        self.client.force_login(self.student)
        self.assertEqual(self.client.get("/api/admin/overview/?range=7d").status_code, 403)

    @patch("backend.apps.system.admin_overview.timezone.now", return_value=NOW)
    def test_caches_the_complete_response_for_thirty_seconds_by_range(self, _now):
        first = self.client.get("/api/admin/overview/?range=7d").json()
        User.objects.create_user(phone="not-visible-until-refresh", password="password123")

        cached = self.client.get("/api/admin/overview/?range=7d").json()
        different_range = self.client.get("/api/admin/overview/?range=30d").json()

        self.assertEqual(cached["generatedAt"], first["generatedAt"])
        self.assertEqual(cached["metrics"]["users"], first["metrics"]["users"])
        self.assertEqual(different_range["metrics"]["users"]["value"], 3)

    @patch("backend.apps.system.admin_overview.build_system_health", side_effect=RuntimeError("probe unavailable"))
    @patch("backend.apps.system.admin_overview.timezone.now", return_value=NOW)
    def test_marks_response_partial_when_a_noncritical_probe_fails(self, _now, _health):
        response = self.client.get("/api/admin/overview/?range=7d")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["dataStatus"], "partial")
        self.assertEqual(payload["services"][0]["status"], "unknown")
        self.assertEqual(payload["services"][0]["dataStatus"], "partial")
        self.assertEqual(payload["metrics"]["users"]["dataStatus"], "collected")

    @patch("backend.apps.system.admin_overview._build_services", return_value=([], False))
    @patch("backend.apps.system.admin_overview.timezone.now", return_value=NOW)
    def test_seven_day_aggregation_has_a_fixed_query_count(self, _now, _services):
        self._seed_operational_records()
        cache.clear()

        # The 22nd query is the fixed compatibility aggregate for security.events24h.
        with self.assertNumQueries(22):
            overview = build_admin_overview("7d")

        self.assertEqual(len(overview["trends"]), 7)

    def _seed_operational_records(self):
        self._set_created_at(self.admin, self._local_time(-10, 9))
        self._set_created_at(self.student, self._local_time(-2, 9))
        UserAccessState.objects.create(user=self.student, last_seen_at=self._local_time(-6, 0, 30))

        first_session = CoachingSession.objects.create(user=self.student, topic_title="day one")
        second_session = CoachingSession.objects.create(user=self.student, topic_title="day five")
        self._set_timestamps(first_session, self._local_time(-6, 1))
        self._set_timestamps(second_session, self._local_time(-2, 14))

        resource_pack = ResourcePackLog.objects.create(
            user=self.student,
            task_id="overview-pack",
            learning_goal="real aggregation",
        )
        self._set_timestamps(resource_pack, self._local_time(-4, 8))

        completed_run = AgentRun.objects.create(
            trace_id="overview-completed",
            user=self.student,
            workflow="overview",
            status="completed",
            started_at=self._local_time(-1, 10),
            completed_at=self._local_time(-1, 10, 5),
        )
        failed_run = AgentRun.objects.create(
            trace_id="overview-failed",
            user=self.student,
            workflow="overview",
            status="failed",
            started_at=self._local_time(-2, 10),
            completed_at=self._local_time(-2, 10, 5),
        )
        self._set_timestamps(completed_run, self._local_time(-1, 10))
        self._set_timestamps(failed_run, self._local_time(-2, 10))

        for index, status in enumerate(("pending", "processing", "completed", "error", "canceled")):
            job = ResourceGenerationJob.objects.create(
                job_id=f"resource-{index}",
                user=self.student,
                status=status,
            )
            updated_at = NOW - timedelta(minutes=10 if status == "pending" else 5) if status in {"pending", "processing"} else self._local_time(0, 8 + index)
            self._set_timestamps(job, updated_at)
        stale_resource = ResourceGenerationJob.objects.create(
            job_id="resource-stale",
            user=self.student,
            status="running",
        )
        self._set_timestamps(stale_resource, NOW - timedelta(hours=2))

        for index, status in enumerate(("queued", "running", "succeeded", "failed", "cancelled")):
            job = VideoGenerationJob.objects.create(
                job_id=f"video-{index}",
                user=self.student,
                resource_pack_id="overview-pack",
                status=status,
            )
            updated_at = NOW - timedelta(minutes=10 if status == "queued" else 5) if status in {"queued", "running"} else self._local_time(0, 8 + index)
            self._set_timestamps(job, updated_at)

        for index, status in enumerate(("queued", "running", "succeeded", "failed")):
            job = KnowledgeIndexJob.objects.create(
                owner=self.student,
                job_type=IndexJobType.UPLOAD,
                status=status,
            )
            updated_at = NOW - timedelta(minutes=10 if status == "queued" else 5) if status in {"queued", "running"} else self._local_time(0, 8 + index)
            self._set_timestamps(job, updated_at)
        stale_index = KnowledgeIndexJob.objects.create(
            owner=self.student,
            job_type=IndexJobType.UPLOAD,
            status="running",
        )
        self._set_timestamps(stale_index, NOW - timedelta(hours=2))

        cancelled_run = AgentRun.objects.create(
            trace_id="overview-cancelled",
            user=self.student,
            workflow="overview",
            status="cancelled",
            started_at=self._local_time(0, 9),
        )
        stale_run = AgentRun.objects.create(
            trace_id="overview-stale",
            user=self.student,
            workflow="overview",
            status="running",
            started_at=NOW - timedelta(hours=2),
        )
        self._set_timestamps(cancelled_run, self._local_time(0, 9))
        self._set_timestamps(stale_run, NOW - timedelta(hours=2))

        security_event = SecurityEvent.objects.create(
            user=self.student,
            category="overview_security",
            severity="warning",
            source="test",
            summary="Real security evidence",
        )
        self._set_timestamps(security_event, self._local_time(-1, 11))
        audit = AdminAuditLog.objects.create(
            actor=self.admin,
            action="overview.inspect",
            summary="Real admin activity",
        )
        self._set_timestamps(audit, self._local_time(0, 11))

    def _local_time(self, day_offset: int, hour: int, minute: int = 0):
        local_now = NOW.astimezone(SHANGHAI)
        local_day = local_now.date() + timedelta(days=day_offset)
        return datetime.combine(local_day, datetime.min.time(), SHANGHAI).replace(hour=hour, minute=minute)

    def _set_created_at(self, instance, value):
        type(instance).objects.filter(pk=instance.pk).update(created_at=value)

    def _set_timestamps(self, instance, value):
        fields = {"created_at": value}
        if hasattr(instance, "updated_at"):
            fields["updated_at"] = value
        type(instance).objects.filter(pk=instance.pk).update(**fields)
