from __future__ import annotations

from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.system import views


class SystemHealthTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800003001", password="Password123")
        self.client = Client()
        views._readiness_snapshot = None

    def tearDown(self):
        views._readiness_snapshot = None

    def test_health_requires_login(self):
        response = self.client.get("/api/system/health/")
        self.assertEqual(response.status_code, 401)

    def test_live_is_public_and_does_not_probe_dependencies(self):
        with (
            patch("backend.apps.system.views.connection.cursor") as database_cursor,
            patch("backend.apps.system.views.caches") as cache_handler,
        ):
            response = self.client.get("/api/system/live/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"success": True, "status": "alive"})
        database_cursor.assert_not_called()
        cache_handler.assert_not_called()

    def test_ready_is_public_and_reports_database_and_redis_ready(self):
        response = self.client.get("/api/system/ready/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "success": True,
                "status": "ready",
                "dependencies": {"database": "ok", "redis": "ok"},
            },
        )

    def test_ready_returns_503_when_database_probe_fails_without_leaking_details(self):
        secret_error = "mysql://a3:database-password@mysql:3306/a3_learning"
        with patch(
            "backend.apps.system.views.connection.cursor",
            side_effect=RuntimeError(secret_error),
        ):
            response = self.client.get("/api/system/ready/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {
                "success": False,
                "status": "not_ready",
                "dependencies": {"database": "error", "redis": "ok"},
            },
        )
        self.assertNotIn(secret_error, response.content.decode())
        self.assertNotIn("database-password", response.content.decode())

    def test_ready_returns_503_when_redis_probe_fails_without_leaking_details(self):
        secret_error = "redis://a3:cache-password@redis:6379/2"
        with patch("backend.apps.system.views.caches") as cache_handler:
            cache_handler.__getitem__.return_value.set.side_effect = RuntimeError(
                secret_error
            )
            response = self.client.get("/api/system/ready/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {
                "success": False,
                "status": "not_ready",
                "dependencies": {"database": "ok", "redis": "error"},
            },
        )
        self.assertNotIn(secret_error, response.content.decode())
        self.assertNotIn("cache-password", response.content.decode())

    def test_ready_coalesces_dependency_probes_for_a_short_window(self):
        with (
            patch("backend.apps.system.views._database_ready", return_value=True) as database,
            patch("backend.apps.system.views._cache_ready", return_value=True) as redis,
        ):
            first = self.client.get("/api/system/ready/")
            second = self.client.get("/api/system/ready/")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        database.assert_called_once_with()
        redis.assert_called_once_with()

    @override_settings(
        SMS_WEBHOOK_URL="https://sms.example.test/send",
        CELERY_BROKER_URL="redis://127.0.0.1:6379/0",
        CELERY_BEAT_SCHEDULE={
            "a3-evaluate-optimization-policy-outcomes-daily": {
                "task": "learning.evaluate_optimization_policy_outcomes",
                "schedule": 86400,
                "kwargs": {"days": 7},
            }
        },
    )
    def test_health_returns_checks_for_logged_in_user(self):
        self.client.force_login(self.user)
        response = self.client.get("/api/system/health/")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertIn(data["overallStatus"], {"ok", "warning", "error"})
        checks = {item["name"]: item for item in data["checks"]}
        self.assertIn("database", checks)
        self.assertIn("defaultCourse", checks)
        self.assertEqual(checks["defaultCourse"]["detail"].get("defaultCourseCode"), "OS-001")
        self.assertIn("smsVerification", checks)
        self.assertEqual(checks["celeryBeat"]["status"], "ok")
        self.assertEqual(checks["celeryBeat"]["detail"]["task"], "learning.evaluate_optimization_policy_outcomes")
        self.assertEqual(checks["celeryBeat"]["detail"]["kwargs"], {"days": 7})
        self.assertNotIn("SMS_WEBHOOK_TOKEN", str(data))
