from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone


class Course(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True)
    title = models.CharField(max_length=128)
    description = models.TextField(blank=True)
    edition = models.CharField(max_length=64, blank=True)
    cover = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_courses"
        ordering = ["code"]


class CourseTeachingAssignment(models.Model):
    teacher = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="teaching_assignments")
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="teaching_assignments")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_course_teaching_assignments"
        constraints = [models.UniqueConstraint(fields=["teacher", "course"], name="unique_teacher_course_assignment")]


class Chapter(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="chapters")
    order = models.PositiveSmallIntegerField()
    title = models.CharField(max_length=128)
    description = models.TextField(blank=True)
    estimated_minutes = models.PositiveIntegerField(default=60)

    class Meta:
        db_table = "a3_course_chapters"
        ordering = ["order"]
        constraints = [models.UniqueConstraint(fields=["course", "order"], name="unique_course_chapter_order")]


class KnowledgePoint(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    chapter = models.ForeignKey(Chapter, on_delete=models.CASCADE, related_name="knowledge_points")
    code = models.CharField(max_length=64, unique=True)
    order = models.PositiveSmallIntegerField()
    title = models.CharField(max_length=128)
    description = models.TextField(blank=True)
    difficulty = models.PositiveSmallIntegerField(default=2)
    estimated_minutes = models.PositiveIntegerField(default=30)

    class Meta:
        db_table = "a3_knowledge_points"
        ordering = ["chapter__order", "order"]


class KnowledgePrerequisite(models.Model):
    knowledge_point = models.ForeignKey(KnowledgePoint, on_delete=models.CASCADE, related_name="prerequisite_edges")
    prerequisite = models.ForeignKey(KnowledgePoint, on_delete=models.CASCADE, related_name="dependent_edges")

    class Meta:
        db_table = "a3_knowledge_prerequisites"
        constraints = [models.UniqueConstraint(fields=["knowledge_point", "prerequisite"], name="unique_knowledge_prerequisite")]


class CourseEnrollment(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="course_enrollments")
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="enrollments")
    progress = models.PositiveSmallIntegerField(default=0)
    enrolled_at = models.DateTimeField(auto_now_add=True)
    last_studied_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "a3_course_enrollments"
        constraints = [models.UniqueConstraint(fields=["user", "course"], name="unique_user_course_enrollment")]


class LearningPathStatus(models.TextChoices):
    ACTIVE = "active", "使用中"
    ARCHIVED = "archived", "已归档"


class LearningPath(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="learning_paths")
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="learning_paths")
    version = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, choices=LearningPathStatus.choices, default=LearningPathStatus.ACTIVE)
    title = models.CharField(max_length=160)
    rationale = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_learning_paths"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "status", "-created_at"], name="a3_path_user_status_idx")]
        constraints = [models.UniqueConstraint(fields=["user", "course", "version"], name="unique_learning_path_version")]


class PathItemStatus(models.TextChoices):
    LOCKED = "locked", "待解锁"
    CURRENT = "current", "进行中"
    COMPLETED = "completed", "已完成"


class LearningPathItem(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    path = models.ForeignKey(LearningPath, on_delete=models.CASCADE, related_name="items")
    knowledge_point = models.ForeignKey(KnowledgePoint, on_delete=models.CASCADE, related_name="path_items")
    order = models.PositiveIntegerField()
    status = models.CharField(max_length=16, choices=PathItemStatus.choices, default=PathItemStatus.LOCKED)
    progress = models.PositiveSmallIntegerField(default=0)
    reason = models.CharField(max_length=255, blank=True)
    estimated_minutes = models.PositiveIntegerField(default=30)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "a3_learning_path_items"
        ordering = ["order"]
        constraints = [
            models.UniqueConstraint(fields=["path", "order"], name="unique_path_item_order"),
            models.UniqueConstraint(fields=["path", "knowledge_point"], name="unique_path_knowledge_point"),
        ]


class ResourcePackLog(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="resource_pack_logs")
    task_id = models.CharField(max_length=160)
    task_title = models.CharField(max_length=160, blank=True)
    learning_goal = models.CharField(max_length=160)
    verified_source_count = models.PositiveIntegerField(default=0)
    confidence = models.CharField(max_length=32, default="medium")
    practice_href = models.TextField(default="/a3/assessment")
    source = models.CharField(max_length=64, default="study_plan_completion")
    next_step_reason = models.TextField(blank=True)
    payload = models.JSONField(default=dict, blank=True)
    completed_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_resource_pack_logs"
        ordering = ["-completed_at", "-created_at"]
        indexes = [
            models.Index(
                fields=["user", "-completed_at", "-created_at"],
                name="a3_pack_user_done_idx",
            )
        ]
        constraints = [models.UniqueConstraint(fields=["user", "task_id"], name="unique_user_resource_pack_task")]


class LearningEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="learning_events")
    event_id = models.CharField(max_length=128, blank=True, default="")
    event_type = models.CharField(max_length=64)
    target_type = models.CharField(max_length=64, blank=True, default="")
    target_id = models.CharField(max_length=128, blank=True, default="")
    knowledge_point_id = models.CharField(max_length=128, blank=True, default="")
    resource_type = models.CharField(max_length=64, blank=True, default="")
    duration_sec = models.PositiveIntegerField(default=0)
    score = models.FloatField(null=True, blank=True)
    quality = models.JSONField(default=dict, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    trace_id = models.CharField(max_length=128, blank=True, default="")
    source_page = models.CharField(max_length=255, blank=True, default="")
    client_timestamp = models.DateTimeField(null=True, blank=True)
    schema_version = models.CharField(max_length=64, blank=True, default="a3.learning-event.v1")
    ingest_status = models.CharField(max_length=32, blank=True, default="accepted")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "a3_learning_events"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="idx_event_user_time"),
            models.Index(fields=["user", "event_id"], name="idx_event_user_event_id"),
            models.Index(fields=["user", "event_type", "-created_at"], name="idx_event_user_type_time"),
            models.Index(fields=["user", "knowledge_point_id", "-created_at"], name="idx_event_user_kp_time"),
            models.Index(fields=["user", "resource_type", "-created_at"], name="idx_event_user_res_time"),
            models.Index(fields=["user", "source_page", "-created_at"], name="idx_event_user_page_time"),
        ]


class LearningSummaryDocument(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="learning_summary_documents")
    title = models.CharField(max_length=120)
    file_name = models.CharField(max_length=180)
    prompt = models.CharField(max_length=240, blank=True)
    content_md = models.TextField()
    summary_date = models.DateField(default=timezone.localdate)
    source_snapshot = models.JSONField(default=dict, blank=True)
    schema_version = models.CharField(max_length=64, default="a3.learning-summary-document.v1")
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_learning_summary_documents"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="idx_summary_user_time"),
            models.Index(fields=["user", "summary_date"], name="idx_summary_user_date"),
        ]
        constraints = [models.UniqueConstraint(fields=["user", "file_name"], name="unique_user_summary_file_name")]


class CoachingSessionStatus(models.TextChoices):
    ACTIVE = "active", "进行中"
    ENDED = "ended", "已结束"
    ARCHIVED = "archived", "已归档"


class CoachingSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="coaching_sessions")
    course = models.ForeignKey(Course, on_delete=models.SET_NULL, null=True, blank=True, related_name="coaching_sessions")
    knowledge_point = models.ForeignKey(KnowledgePoint, on_delete=models.SET_NULL, null=True, blank=True, related_name="coaching_sessions")
    status = models.CharField(max_length=16, choices=CoachingSessionStatus.choices, default=CoachingSessionStatus.ACTIVE)
    topic_title = models.CharField(max_length=160, blank=True)
    summary = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_coaching_sessions"
        ordering = ["-updated_at", "-created_at"]
        indexes = [
            models.Index(fields=["user", "status", "-updated_at"], name="idx_coach_user_status"),
            models.Index(fields=["knowledge_point", "-updated_at"], name="idx_coach_point_time"),
            models.Index(fields=["started_at"], name="idx_coach_started_at"),
        ]


class CoachingMessageRole(models.TextChoices):
    USER = "user", "学生"
    ASSISTANT = "assistant", "助教"


class CoachingMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(CoachingSession, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16, choices=CoachingMessageRole.choices)
    content = models.TextField()
    verified = models.BooleanField(default=False)
    citations = models.JSONField(default=list, blank=True)
    claims = models.JSONField(default=list, blank=True)
    safety = models.JSONField(default=dict, blank=True)
    refusal_reason = models.CharField(max_length=500, blank=True)
    degraded = models.BooleanField(default=False)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "a3_coaching_messages"
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(fields=["session", "created_at"], name="idx_coach_msg_session"),
            models.Index(fields=["role", "verified"], name="idx_coach_msg_role_verified"),
        ]


class TutorAvatarAsset(models.Model):
    asset_id = models.CharField(max_length=64, unique=True)
    display_name = models.CharField(max_length=120)
    public_path = models.CharField(max_length=255)
    thumbnail_path = models.CharField(max_length=255, blank=True)
    author = models.CharField(max_length=120, blank=True)
    source_name = models.CharField(max_length=120, blank=True)
    source_url = models.URLField(blank=True)
    license_name = models.CharField(max_length=120, blank=True)
    license_url = models.URLField(blank=True)
    usage_scope = models.JSONField(default=list, blank=True)
    sha256 = models.CharField(max_length=64)
    file_size_bytes = models.PositiveBigIntegerField()
    status = models.CharField(
        max_length=16,
        choices=(("draft", "草稿"), ("enabled", "启用"), ("disabled", "停用")),
        default="draft",
    )
    is_default = models.BooleanField(default=False)
    default_slot = models.CharField(max_length=7, null=True, unique=True, editable=False)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.default_slot = "default" if self.is_default else None
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "is_default" in update_fields:
            kwargs["update_fields"] = set(update_fields) | {"default_slot"}
        return super().save(*args, **kwargs)

    class Meta:
        db_table = "a3_tutor_avatar_assets"
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(is_default=True, default_slot="default", default_slot__isnull=False)
                    | models.Q(is_default=False, default_slot__isnull=True)
                ),
                name="tutor_avatar_default_slot_consistent",
            )
        ]


class TutorPersonaConfiguration(models.Model):
    persona_id = models.CharField(max_length=64, unique=True)
    enabled = models.BooleanField(default=True)
    avatar_asset = models.ForeignKey(TutorAvatarAsset, on_delete=models.PROTECT, related_name="persona_configurations")
    voice_preview_enabled = models.BooleanField(default=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="updated_tutor_personas",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_tutor_persona_configurations"


class TutorPersonaFeedback(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="tutor_persona_feedback")
    session = models.ForeignKey(CoachingSession, on_delete=models.CASCADE, related_name="tutor_feedback")
    persona_id = models.CharField(max_length=64)
    rating = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(5)])
    tags = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def clean(self):
        super().clean()
        if not self.user_id or not self.session_id:
            return
        session_user_id = (
            CoachingSession.objects.filter(pk=self.session_id).values_list("user_id", flat=True).first()
        )
        if session_user_id is not None and self.user_id != session_user_id:
            raise ValidationError({"user": "反馈用户必须与辅导会话用户一致。"})

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    class Meta:
        db_table = "a3_tutor_persona_feedback"
        constraints = [
            models.UniqueConstraint(fields=["user", "session"], name="unique_user_session_tutor_feedback"),
            models.CheckConstraint(
                condition=models.Q(rating__gte=1, rating__lte=5),
                name="tutor_feedback_rating_1_5",
            ),
        ]
        indexes = [models.Index(fields=["persona_id", "-created_at"], name="idx_tutor_feedback_persona")]
