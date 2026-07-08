from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class FavoriteType(models.TextChoices):
    VIDEO = "video", "视频"
    COURSEWARE = "courseware", "课件"
    KNOWLEDGE_CARD = "knowledge_card", "知识卡片"
    EXERCISE = "exercise", "练习"
    NOTE = "note", "笔记"


class NotificationType(models.TextChoices):
    LEARNING_TASK = "learning_task", "学习任务"
    ASSESSMENT = "assessment", "测评反馈"
    KNOWLEDGE_BASE = "knowledge_base", "知识库"
    SYSTEM = "system", "系统通知"
    TEACHER = "teacher", "教师提醒"


class UserFavorite(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="favorites")
    title = models.CharField(max_length=160)
    resource_type = models.CharField(max_length=24, choices=FavoriteType.choices)
    source = models.CharField(max_length=120, blank=True)
    url = models.CharField(max_length=500, blank=True)
    group = models.CharField(max_length=64, default="默认收藏夹")
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_user_favorites"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "resource_type"], name="a3_user_fa_user_id_33755b_idx"),
            models.Index(fields=["user", "group"], name="a3_user_fa_user_id_64db81_idx"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["user", "title", "resource_type", "source"], name="uniq_a3_user_favorite_source")
        ]


class UserNotification(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    title = models.CharField(max_length=160)
    detail = models.TextField()
    notification_type = models.CharField(max_length=24, choices=NotificationType.choices, default=NotificationType.SYSTEM)
    unread = models.BooleanField(default=True)
    action_url = models.CharField(max_length=500, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "a3_user_notifications"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "unread", "-created_at"], name="a3_user_no_user_id_3c273c_idx"),
            models.Index(fields=["user", "notification_type"], name="a3_user_no_user_id_8a56d2_idx"),
        ]
