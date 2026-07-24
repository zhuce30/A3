from django.test import TestCase

from backend.apps.accounts.models import User, UserRole
from backend.apps.system.models import AdminAuditLog, SecurityEvent


class AdminGovernanceTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            phone="admin-governance",
            password="password123",
            role=UserRole.ADMIN,
        )
        self.student = User.objects.create_user(
            phone="student-governance",
            password="password123",
        )

    def test_security_event_supports_all_review_states(self):
        expected_statuses = {
            "pending",
            "confirmed",
            "false_positive",
            "resolved",
        }
        field = SecurityEvent._meta.get_field("review_status")

        self.assertEqual({value for value, _label in field.choices}, expected_statuses)

        for status in expected_statuses:
            event = SecurityEvent.objects.create(
                user=self.student,
                category="content_safety",
                summary=f"review state {status}",
                review_status=status,
                reviewer=self.admin if status != "pending" else None,
                review_note="reviewed" if status != "pending" else "",
            )
            event.refresh_from_db()
            self.assertEqual(event.review_status, status)

    def test_security_event_defaults_to_pending(self):
        event = SecurityEvent.objects.create(
            category="content_safety",
            summary="awaiting review",
        )

        self.assertEqual(event.review_status, "pending")
        self.assertIsNone(event.reviewer)
        self.assertIsNone(event.reviewed_at)
        self.assertEqual(event.review_note, "")

    def test_record_admin_audit_persists_target_and_safe_values(self):
        from backend.apps.system.admin_audit import record_admin_audit

        log = record_admin_audit(
            actor=self.admin,
            action="user.status.update",
            target_user=self.student,
            target_type="user",
            target_id=str(self.student.pk),
            summary="Disable an inactive learner account",
            reason="Requested by operations",
            before={"is_active": True, "label": "safe ordinary value"},
            after={"is_active": False, "label": "safe ordinary value"},
            metadata={"request_id": "req-123", "safe_note": "token is harmless here"},
            actor_ip="203.0.113.10",
            success=True,
        )

        stored = AdminAuditLog.objects.get(pk=log.pk)
        self.assertEqual(stored.actor, self.admin)
        self.assertEqual(stored.target_user, self.student)
        self.assertEqual(stored.target_type, "user")
        self.assertEqual(stored.target_id, str(self.student.pk))
        self.assertEqual(stored.summary, "Disable an inactive learner account")
        self.assertEqual(stored.reason, "Requested by operations")
        self.assertEqual(stored.before, {"is_active": True, "label": "safe ordinary value"})
        self.assertEqual(stored.after, {"is_active": False, "label": "safe ordinary value"})
        self.assertEqual(
            stored.metadata,
            {"request_id": "req-123", "safe_note": "token is harmless here"},
        )
        self.assertEqual(stored.actor_ip, "203.0.113.10")
        self.assertTrue(stored.success)

    def test_record_admin_audit_recursively_removes_sensitive_keys(self):
        from backend.apps.system.admin_audit import record_admin_audit

        sensitive_payload = {
            "password": "remove",
            "passwd": "remove",
            "refreshToken": "remove",
            "session_cookie": "remove",
            "clientSecret": "remove",
            "Authorization": "remove",
            "api-key": "remove",
            "api_key": "remove",
            "apikey": "remove",
            "access_key": "remove",
            "session": "remove",
            "session_id": "remove",
            "verification_code": "remove",
            "smtp_auth_code": "remove",
            "signed_url": "remove",
            "conversation_body": "remove",
            "file_content": "remove",
            "private_key": "remove",
            "safe": "keep",
            "request_id": "req-456",
            "safe_note": "keep this ordinary value",
            "nested": {
                "safe_nested": 7,
                "secret_key": "remove",
                "items": [
                    {
                        "cookieValue": "remove",
                        "signedDownloadUrl": "remove",
                        "message_body": "remove",
                        "label": "keep",
                    },
                    "safe-list-value",
                ],
            },
        }

        log = record_admin_audit(
            actor=self.admin,
            action="configuration.verify",
            target_type="configuration",
            target_id="llm-provider",
            before=sensitive_payload,
            after=sensitive_payload,
            metadata=sensitive_payload,
            success=False,
        )

        expected = {
            "safe": "keep",
            "request_id": "req-456",
            "safe_note": "keep this ordinary value",
            "nested": {
                "safe_nested": 7,
                "items": [{"label": "keep"}, "safe-list-value"],
            },
        }
        self.assertEqual(log.before, expected)
        self.assertEqual(log.after, expected)
        self.assertEqual(log.metadata, expected)

    def test_record_admin_audit_preserves_falsey_json_values(self):
        from backend.apps.system.admin_audit import record_admin_audit

        for index, value in enumerate((False, 0, "", [])):
            with self.subTest(value=value):
                log = record_admin_audit(
                    actor=self.admin,
                    action="json.falsey.persist",
                    target_id=str(index),
                    before=value,
                    after=value,
                    metadata=value,
                )
                log.refresh_from_db()

                self.assertEqual(log.before, value)
                self.assertEqual(log.after, value)
                self.assertEqual(log.metadata, value)

    def test_record_admin_audit_normalizes_non_finite_floats_to_null(self):
        from backend.apps.system.admin_audit import record_admin_audit

        log = record_admin_audit(
            actor=self.admin,
            action="metrics.capture",
            before={"nan": float("nan"), "safe": 1.5},
            after={"positive_infinity": float("inf")},
            metadata={"values": [float("-inf"), 2.5]},
        )
        log.refresh_from_db()

        self.assertEqual(log.before, {"nan": None, "safe": 1.5})
        self.assertEqual(log.after, {"positive_infinity": None})
        self.assertEqual(log.metadata, {"values": [None, 2.5]})
