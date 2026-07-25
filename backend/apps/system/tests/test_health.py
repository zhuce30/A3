from __future__ import annotations

from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.system import views
from backend.apps.system.services import build_system_health


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
            patch("backend.apps.system.views.pymysql.connect") as database_connect,
            patch("backend.apps.system.views.Redis.from_url") as redis_connect,
        ):
            response = self.client.get("/api/system/live/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"success": True, "status": "alive"})
        database_connect.assert_not_called()
        redis_connect.assert_not_called()

    def test_ready_is_public_and_reports_database_and_redis_ready(self):
        with (
            patch("backend.apps.system.views._database_ready", return_value=True),
            patch("backend.apps.system.views._cache_ready", return_value=True),
        ):
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
        with (
            patch(
                "backend.apps.system.views.pymysql.connect",
                side_effect=RuntimeError(secret_error),
            ),
            patch("backend.apps.system.views._cache_ready", return_value=True),
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

    @override_settings(CACHE_REDIS_URL="redis://redis:6379/2")
    def test_ready_returns_503_when_redis_probe_fails_without_leaking_details(self):
        secret_error = "redis://a3:cache-password@redis:6379/2"
        with (
            patch("backend.apps.system.views._database_ready", return_value=True),
            patch("backend.apps.system.views.Redis.from_url") as redis_factory,
        ):
            redis_factory.side_effect = RuntimeError(
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

    @override_settings(CACHE_REDIS_URL="redis://redis:6379/2")
    def test_ready_uses_probe_local_one_second_driver_timeouts(self):
        with (
            patch("backend.apps.system.views.pymysql.connect") as mysql_connect,
            patch("backend.apps.system.views.Redis.from_url") as redis_factory,
        ):
            mysql_connect.return_value.cursor.return_value.__enter__.return_value.fetchone.return_value = (1,)
            redis_factory.return_value.ping.return_value = True
            response = self.client.get("/api/system/ready/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(mysql_connect.call_args.kwargs["connect_timeout"], 1)
        self.assertEqual(mysql_connect.call_args.kwargs["read_timeout"], 1)
        self.assertEqual(mysql_connect.call_args.kwargs["write_timeout"], 1)
        self.assertEqual(redis_factory.call_args.kwargs["socket_connect_timeout"], 1)
        self.assertEqual(redis_factory.call_args.kwargs["socket_timeout"], 1)

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
        self.assertEqual(checks["celeryBeat"]["status"], "warning")
        self.assertEqual(checks["celeryBeat"]["detail"]["task"], "learning.evaluate_optimization_policy_outcomes")
        self.assertEqual(checks["celeryBeat"]["detail"]["kwargs"], {"days": 7})
        self.assertNotIn("SMS_WEBHOOK_TOKEN", str(data))

    def test_health_isolates_one_probe_failure_without_leaking_exception(self):
        secret_error = "smtp://admin:private-password@example.test"
        with patch(
            "backend.apps.system.services._course_check",
            side_effect=RuntimeError(secret_error),
        ):
            result = build_system_health()

        checks = {item["name"]: item for item in result["checks"]}
        self.assertEqual(len(checks), 9)
        self.assertIn("database", checks)
        self.assertIn("redis", checks)
        self.assertEqual(checks["defaultCourse"]["status"], "error")
        self.assertEqual(checks["defaultCourse"]["dataStatus"], "partial")
        self.assertEqual(checks["defaultCourse"]["detail"], {})
        self.assertNotIn(secret_error, str(result))
        self.assertNotIn("private-password", str(result))

    def test_health_database_probe_does_not_expose_connection_exception(self):
        secret_error = "mysql://admin:private-password@database.test/a3"
        with patch(
            "backend.apps.system.services.connection.ensure_connection",
            side_effect=RuntimeError(secret_error),
        ):
            result = build_system_health()

        database = next(item for item in result["checks"] if item["name"] == "database")
        self.assertEqual(database["status"], "error")
        self.assertNotIn(secret_error, str(result))
        self.assertNotIn("private-password", str(result))
