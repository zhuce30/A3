from __future__ import annotations

from unittest.mock import Mock, patch

from django.core.cache import cache
from django.core import mail
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.accounts.services import (
    VERIFICATION_CODE_MAX_ATTEMPTS,
    create_verification_code,
    register_user,
    verify_code,
)


@override_settings(DEBUG=True, VERIFICATION_CODE_DEV_MODE=True)
class VerificationCodeTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_code_is_scoped_by_purpose_and_consumed_once(self):
        delivery = create_verification_code("13800138000", purpose="register", allow_dev_code=True)

        self.assertEqual(delivery.dev_code, "123456")
        self.assertFalse(verify_code("13800138000", "123456", purpose="reset"))
        self.assertTrue(verify_code("13800138000", "123456", purpose="register"))
        self.assertFalse(verify_code("13800138000", "123456", purpose="register"))

    def test_code_is_invalidated_after_too_many_failures(self):
        create_verification_code("13800138001", purpose="bind", allow_dev_code=True)

        for _ in range(VERIFICATION_CODE_MAX_ATTEMPTS):
            self.assertFalse(verify_code("13800138001", "000000", purpose="bind"))

        self.assertFalse(verify_code("13800138001", "123456", purpose="bind"))


@override_settings(DEBUG=False, SMS_WEBHOOK_URL="https://sms.example.test/send")
class ProductionDeliveryTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    @patch("backend.apps.accounts.services.requests.post")
    def test_production_delivery_does_not_expose_code(self, post: Mock):
        post.return_value.raise_for_status.return_value = None

        delivery = create_verification_code("13800138002", purpose="register")

        self.assertTrue(delivery.sent)
        self.assertIsNone(delivery.dev_code)
        post.assert_called_once()

    @override_settings(SMS_WEBHOOK_URL="", EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend", DEFAULT_FROM_EMAIL="3062221819@qq.com")
    def test_email_delivery_sends_code_without_sms_webhook(self):
        delivery = create_verification_code("student@example.com", purpose="register")

        self.assertTrue(delivery.sent)
        self.assertIsNone(delivery.dev_code)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ["student@example.com"])
        self.assertIn("验证码", mail.outbox[0].subject)


@override_settings(DEBUG=True, VERIFICATION_CODE_DEV_MODE=True)
class RegistrationVerificationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.request = RequestFactory().post("/api/auth/register/")
        self.request.session = self.client.session

    def test_registration_requires_server_verified_code(self):
        create_verification_code("13800138003", purpose="register", allow_dev_code=True)
        user = register_user(
            self.request,
            phone="13800138003",
            code="123456",
            password="secure-pass-123",
            role="student",
            display_name="测试学生",
        )

        self.assertEqual(user.phone, "13800138003")
        self.assertTrue(User.objects.filter(phone="13800138003").exists())

    def test_email_registration_uses_email_code_and_internal_account_identifier(self):
        create_verification_code("student@example.com", purpose="register", allow_dev_code=True)
        user = register_user(
            self.request,
            email="student@example.com",
            code="123456",
            password="secure-pass-123",
            role="student",
            display_name="邮箱学生",
        )

        self.assertEqual(user.email, "student@example.com")
        self.assertTrue(user.phone.startswith("email:"))
        self.assertTrue(user.phone_bound)
        self.assertTrue(User.objects.filter(email="student@example.com").exists())

    def test_registration_rejects_wrong_code(self):
        create_verification_code("13800138004", purpose="register", allow_dev_code=True)

        with self.assertRaisesRegex(ValueError, "验证码"):
            register_user(
                self.request,
                phone="13800138004",
                code="000000",
                password="secure-pass-123",
                role="student",
            )

        self.assertFalse(User.objects.filter(phone="13800138004").exists())

    def test_registration_rejects_privileged_roles(self):
        create_verification_code("13800138005", purpose="register", allow_dev_code=True)

        with self.assertRaisesRegex(ValueError, "后台开通"):
            register_user(
                self.request,
                phone="13800138005",
                code="123456",
                password="secure-pass-123",
                role="teacher",
            )

        self.assertFalse(User.objects.filter(phone="13800138005").exists())


class CsrfProtectionTests(TestCase):
    def test_write_api_requires_csrf_token(self):
        client = Client(enforce_csrf_checks=True)

        rejected = client.post(
            "/api/auth/send-code/",
            data='{"target":"13800138006","purpose":"register"}',
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 403)

        token_response = client.get("/api/auth/csrf/")
        self.assertEqual(token_response.status_code, 200)
        token = token_response.json()["csrfToken"]
        accepted = client.post(
            "/api/auth/send-code/",
            data='{"target":"13800138006","purpose":"register"}',
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertNotEqual(accepted.status_code, 403)


@override_settings(DEBUG=True, VERIFICATION_CODE_DEV_MODE=True)
class VerificationCodeViewTests(TestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_local_debug_request_can_receive_dev_code(self):
        response = self.client.post(
            "/api/auth/send-code/",
            data='{"target":"13800138007","purpose":"register"}',
            content_type="application/json",
            REMOTE_ADDR="127.0.0.1",
            HTTP_HOST="localhost",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["devCode"], "123456")

    @patch("backend.apps.accounts.services.requests.post")
    @override_settings(SMS_WEBHOOK_URL="https://sms.example.test/send", ALLOWED_HOSTS=["testserver", "example.test"])
    def test_non_local_debug_request_does_not_receive_dev_code(self, post: Mock):
        post.return_value.raise_for_status.return_value = None
        response = self.client.post(
            "/api/auth/send-code/",
            data='{"target":"13800138008","purpose":"register"}',
            content_type="application/json",
            REMOTE_ADDR="10.0.0.8",
            HTTP_HOST="example.test",
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("devCode", response.json())
        post.assert_called_once()
