from __future__ import annotations

from django.conf import settings
from django.db import models


class AdminAuditLog(models.Model):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="admin_audit_logs")
    action = models.CharField(max_length=64)
    target_user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="admin_audit_targets")
    success = models.BooleanField(default=True)
    reason = models.CharField(max_length=255, blank=True)
    before = models.JSONField(default=dict, blank=True)
    after = models.JSONField(default=dict, blank=True)
    actor_ip = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "a3_admin_audit_logs"
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["actor", "action", "-created_at"], name="a3_audit_actor_action_idx")]


class SecurityEvent(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="security_events")
    category = models.CharField(max_length=64)
    severity = models.CharField(max_length=16, default="info")
    source = models.CharField(max_length=64, default="a3")
    summary = models.CharField(max_length=255)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "a3_security_events"
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["category", "severity", "-created_at"], name="a3_security_category_idx")]
