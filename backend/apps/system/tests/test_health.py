from __future__ import annotations

from django.test import Client, TestCase, override_settings

from backend.apps.accounts.models import User


class SystemHealthTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800003001", password="Password123")
        self.client = Client()

    def test_health_requires_login(self):
        response = self.client.get("/api/system/health/")
        self.assertEqual(response.status_code, 401)

    @override_settings(SMS_WEBHOOK_URL="https://sms.example.test/send", CELERY_BROKER_URL="redis://127.0.0.1:6379/0")
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
        self.assertNotIn("SMS_WEBHOOK_TOKEN", str(data))
