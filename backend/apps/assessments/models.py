from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class QuestionType(models.TextChoices):
    SINGLE_CHOICE = "single_choice", "single choice"
    MULTIPLE_CHOICE = "multiple_choice", "multiple choice"
    SHORT_ANSWER = "short_answer", "short answer"


class QuestionSourceType(models.TextChoices):
    SEEDED = "seeded", "seeded"
    TEACHER = "teacher", "teacher"
    KB_GENERATED = "kb_generated", "knowledge base generated"
    PERSONAL_GENERATED = "personal_generated", "personal material generated"
    VARIANT = "variant", "wrong question variant"


class QuestionReviewStatus(models.TextChoices):
    DRAFT = "draft", "draft"
    AUTO_VERIFIED = "auto_verified", "auto verified"
    APPROVED = "approved", "approved"
    REJECTED = "rejected", "rejected"
    DISABLED = "disabled", "disabled"


class QuestionGenerationStatus(models.TextChoices):
    QUEUED = "queued", "queued"
    RUNNING = "running", "running"
    GENERATED = "generated", "generated"
    SUCCEEDED = "succeeded", "succeeded"
    FAILED = "failed", "failed"


class Question(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    knowledge_point = models.ForeignKey(
        "learning.KnowledgePoint", on_delete=models.CASCADE, related_name="questions"
    )
    stem = models.TextField()
    options = models.JSONField(default=list)
    correct_answer = models.CharField(max_length=16)
    explanation = models.TextField()
    error_cause = models.CharField(max_length=255, blank=True)
    difficulty = models.PositiveSmallIntegerField(default=2)
    is_active = models.BooleanField(default=True)
    question_type = models.CharField(
        max_length=32,
        choices=QuestionType.choices,
        default=QuestionType.SINGLE_CHOICE,
    )
    source_type = models.CharField(
        max_length=32,
        choices=QuestionSourceType.choices,
        default=QuestionSourceType.SEEDED,
    )
    review_status = models.CharField(
        max_length=32,
        choices=QuestionReviewStatus.choices,
        default=QuestionReviewStatus.APPROVED,
    )
    scope = models.CharField(max_length=32, default="global")
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="owned_questions",
    )
    source_resource = models.ForeignKey(
        "knowledge_base.KnowledgeResource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="questions",
    )
    source_block_id = models.CharField(max_length=128, blank=True)
    evidence_summary = models.TextField(blank=True)
    quality_score = models.FloatField(default=1.0)
    metadata = models.JSONField(default=dict, blank=True)
    generation_job = models.ForeignKey(
        "assessments.QuestionGenerationJob",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="questions",
    )
    archived_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_questions"
        ordering = ["knowledge_point__chapter__order", "knowledge_point__order", "difficulty"]


class QuestionGenerationJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="question_generation_jobs",
    )
    knowledge_point = models.ForeignKey(
        "learning.KnowledgePoint",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="question_generation_jobs",
    )
    resource = models.ForeignKey(
        "knowledge_base.KnowledgeResource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="question_generation_jobs",
    )
    scope = models.CharField(max_length=32, default="personal")
    status = models.CharField(
        max_length=32,
        choices=QuestionGenerationStatus.choices,
        default=QuestionGenerationStatus.QUEUED,
    )
    requested_count = models.PositiveSmallIntegerField(default=5)
    generated_count = models.PositiveSmallIntegerField(default=0)
    verified_count = models.PositiveSmallIntegerField(default=0)
    rejected_count = models.PositiveSmallIntegerField(default=0)
    error = models.CharField(max_length=255, blank=True)
    trace = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_question_generation_jobs"
        ordering = ["-created_at"]


class QuestionEvidence(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="evidence_items")
    resource = models.ForeignKey(
        "knowledge_base.KnowledgeResource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="question_evidence",
    )
    block_id = models.CharField(max_length=128, blank=True)
    page_number = models.PositiveIntegerField(null=True, blank=True)
    preview_url = models.CharField(max_length=512, blank=True)
    quote = models.TextField(blank=True)
    modality = models.CharField(max_length=32, default="text")
    score = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_question_evidence"
        ordering = ["-score", "created_at"]


class QuestionQualityCheck(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="quality_checks")
    checker = models.CharField(max_length=64)
    passed = models.BooleanField(default=False)
    score = models.FloatField(default=0)
    issues = models.JSONField(default=list, blank=True)
    evidence = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_question_quality_checks"
        ordering = ["-created_at"]


class StudentQuestionMastery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="question_mastery")
    knowledge_point = models.ForeignKey(
        "learning.KnowledgePoint",
        on_delete=models.CASCADE,
        related_name="student_question_mastery",
    )
    attempts = models.PositiveIntegerField(default=0)
    correct = models.PositiveIntegerField(default=0)
    mastery_score = models.FloatField(default=0.5)
    last_practiced_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_student_question_mastery"
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(fields=["user", "knowledge_point"], name="unique_user_question_mastery_point")
        ]


class PersonalQuestionSequence(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="personal_question_sequences",
    )
    knowledge_point = models.ForeignKey(
        "learning.KnowledgePoint",
        on_delete=models.CASCADE,
        related_name="personal_question_sequences",
    )
    next_variant_index = models.PositiveIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_personal_question_sequences"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "knowledge_point"],
                name="unique_user_personal_question_sequence_point",
            )
        ]


class SessionStatus(models.TextChoices):
    IN_PROGRESS = "in_progress", "进行中"
    COMPLETED = "completed", "已完成"


class AssessmentSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assessment_sessions")
    learning_path = models.ForeignKey(
        "learning.LearningPath", null=True, blank=True, on_delete=models.SET_NULL, related_name="assessment_sessions"
    )
    status = models.CharField(max_length=16, choices=SessionStatus.choices, default=SessionStatus.IN_PROGRESS)
    question_ids = models.JSONField(default=list)
    current_index = models.PositiveIntegerField(default=0)
    score = models.PositiveSmallIntegerField(default=0)
    started_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "a3_assessment_sessions"
        ordering = ["-started_at"]
        indexes = [
            models.Index(
                fields=["user", "status", "completed_at"],
                name="a3_asmt_user_stat_done_idx",
            )
        ]


class AssessmentAnswer(models.Model):
    session = models.ForeignKey(AssessmentSession, on_delete=models.CASCADE, related_name="answers")
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="answers")
    selected_answer = models.CharField(max_length=16, blank=True)
    is_correct = models.BooleanField(default=False)
    is_skipped = models.BooleanField(default=False)
    answered_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_assessment_answers"
        indexes = [
            models.Index(
                fields=["session", "answered_at", "is_correct"],
                name="a3_ans_sess_time_ok_idx",
            )
        ]
        constraints = [models.UniqueConstraint(fields=["session", "question"], name="unique_session_question_answer")]


class WrongQuestion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="wrong_questions")
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="wrong_records")
    wrong_count = models.PositiveIntegerField(default=1)
    consecutive_correct = models.PositiveSmallIntegerField(default=0)
    mastered = models.BooleanField(default=False)
    last_wrong_answer = models.CharField(max_length=16, blank=True)
    last_wrong_at = models.DateTimeField(auto_now=True)
    review_after = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "a3_wrong_questions"
        ordering = ["mastered", "-last_wrong_at"]
        indexes = [
            models.Index(
                fields=["user", "mastered", "-last_wrong_at"],
                name="a3_wrong_user_master_idx",
            ),
            models.Index(
                fields=["user", "-last_wrong_at"],
                name="a3_wrong_user_time_idx",
            ),
        ]
        constraints = [models.UniqueConstraint(fields=["user", "question"], name="unique_user_wrong_question")]
