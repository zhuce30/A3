from __future__ import annotations

from django.conf import settings
from django.db import models


class LearningPace(models.TextChoices):
    RELAXED = "relaxed", "稳扎稳打"
    STANDARD = "standard", "标准节奏"
    INTENSIVE = "intensive", "强化提升"


class LearnerProfile(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="learner_profile",
        verbose_name="用户",
    )
    grade = models.CharField("年级", max_length=64, blank=True)
    major_direction = models.CharField("学科方向", max_length=128, blank=True)
    foundation_level = models.CharField("基础水平", max_length=64, blank=True)
    daily_study_time = models.PositiveSmallIntegerField("每日学习时长", default=60)
    pace = models.CharField("学习节奏", max_length=32, choices=LearningPace.choices, default=LearningPace.STANDARD)
    learning_goals = models.JSONField("学习目标", default=list, blank=True)
    weak_points = models.JSONField("薄弱知识点", default=list, blank=True)
    learning_preferences = models.JSONField("学习偏好", default=dict, blank=True)
    expected_resources = models.JSONField("期望资源", default=list, blank=True)
    extra_profile = models.JSONField("扩展画像", default=dict, blank=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        db_table = "a3_learner_profiles"
        verbose_name = "学习画像"
        verbose_name_plural = "学习画像"

    def __str__(self) -> str:
        return f"{self.user_id}:{self.major_direction or '未设置'}"
