from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class AgentRun(models.Model):
    trace_id = models.CharField(max_length=64, unique=True, db_index=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="a3_agent_runs")
    schema_version = models.CharField(max_length=32, default="a3.agent-run.v1")
    workflow = models.CharField(max_length=80)
    goal = models.CharField(max_length=255, blank=True)
    status = models.CharField(max_length=32, default="running")
    fallback_strategy = models.CharField(max_length=80, default="none")
    latency_ms = models.PositiveIntegerField(default=1)
    started_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_agent_runs"
        ordering = ["-started_at", "-id"]
        indexes = [
            models.Index(fields=["user", "-started_at"], name="a3_agent_run_user_started_idx"),
            models.Index(fields=["workflow", "status"], name="a3_agent_run_flow_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.trace_id}:{self.workflow}:{self.status}"


class AgentStep(models.Model):
    run = models.ForeignKey(AgentRun, on_delete=models.CASCADE, related_name="steps")
    order = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=80)
    role = models.CharField(max_length=80, blank=True)
    status = models.CharField(max_length=32, default="completed")
    detail = models.TextField(blank=True)
    latency_ms = models.PositiveIntegerField(default=1)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_agent_steps"
        ordering = ["order", "id"]
        constraints = [
            models.UniqueConstraint(fields=["run", "order"], name="a3_agent_step_run_order_unique"),
        ]

    def __str__(self) -> str:
        return f"{self.run_id}:{self.order}:{self.name}"


class AgentSpan(models.Model):
    run = models.ForeignKey(AgentRun, on_delete=models.CASCADE, related_name="spans")
    parent_step = models.CharField(max_length=80, blank=True)
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=40)
    status = models.CharField(max_length=32, default="completed")
    latency_ms = models.PositiveIntegerField(default=1)
    started_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_agent_spans"
        ordering = ["started_at", "id"]
        indexes = [
            models.Index(fields=["run", "parent_step"], name="a3_agent_span_run_parent_idx"),
            models.Index(fields=["kind", "status"], name="a3_agent_span_kind_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.run_id}:{self.kind}:{self.name}:{self.status}"


class OpenMAICArtifact(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="a3_openmaic_artifacts")
    resource_pack_id = models.CharField(max_length=64, db_index=True)
    artifact_type = models.CharField(max_length=40)
    job_id = models.CharField(max_length=120, blank=True, db_index=True)
    status = models.CharField(max_length=32, default="queued")
    provider = models.CharField(max_length=120, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_openmaic_artifacts"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["user", "resource_pack_id", "-created_at"], name="a3_openmaic_user_pack_idx"),
            models.Index(fields=["artifact_type", "status"], name="a3_openmaic_type_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.resource_pack_id}:{self.artifact_type}:{self.status}"


class ResourceGenerationJob(models.Model):
    job_id = models.CharField(max_length=120, unique=True, db_index=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="a3_resource_generation_jobs")
    workflow = models.CharField(max_length=80, default="resource_generate")
    status = models.CharField(max_length=32, default="queued")
    progress = models.PositiveSmallIntegerField(default=0)
    stage = models.CharField(max_length=40, default="queued")
    message = models.CharField(max_length=255, blank=True)
    goal = models.TextField(blank=True)
    top_k = models.PositiveSmallIntegerField(default=5)
    resource_type = models.CharField(max_length=40, blank=True)
    resource_pack_id = models.CharField(max_length=64, blank=True, db_index=True)
    trace_id = models.CharField(max_length=64, blank=True, db_index=True)
    result = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_resource_generation_jobs"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="a3_resgen_user_created_idx"),
            models.Index(fields=["workflow", "status"], name="a3_resgen_flow_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.job_id}:{self.status}:{self.progress}"


class VideoGenerationJob(models.Model):
    job_id = models.CharField(max_length=120, unique=True, db_index=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="a3_video_generation_jobs")
    resource_pack_id = models.CharField(max_length=64, db_index=True)
    resource_type = models.CharField(max_length=40, default="micro_video_script")
    provider = models.CharField(max_length=40, default="seedance")
    status = models.CharField(max_length=32, default="queued")
    stage = models.CharField(max_length=40, default="queued")
    progress = models.PositiveSmallIntegerField(default=0)
    message = models.CharField(max_length=255, blank=True)
    requested_duration = models.PositiveSmallIntegerField(default=60)
    aspect_ratio = models.CharField(max_length=16, default="16:9")
    resolution = models.CharField(max_length=16, default="1080p")
    celery_task_id = models.CharField(max_length=64, blank=True)
    trace_id = models.CharField(max_length=64, blank=True, db_index=True)
    retry_generation = models.PositiveSmallIntegerField(default=0)
    artifact = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_video_generation_jobs"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="a3_vidjob_user_created_idx"),
            models.Index(fields=["status", "updated_at"], name="a3_vidjob_status_update_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.job_id}:{self.status}:{self.progress}"


class VideoGenerationSegment(models.Model):
    job = models.ForeignKey(VideoGenerationJob, on_delete=models.CASCADE, related_name="segments")
    index = models.PositiveSmallIntegerField()
    title = models.CharField(max_length=120)
    prompt = models.TextField()
    duration = models.PositiveSmallIntegerField(default=10)
    aspect_ratio = models.CharField(max_length=16, default="16:9")
    resolution = models.CharField(max_length=16, default="1080p")
    status = models.CharField(max_length=32, default="pending")
    provider_task_id = models.CharField(max_length=160, blank=True)
    celery_task_id = models.CharField(max_length=64, blank=True)
    submission_attempts = models.PositiveSmallIntegerField(default=0)
    poll_attempts = models.PositiveIntegerField(default=0)
    network_retry_count = models.PositiveSmallIntegerField(default=0)
    storage_attempts = models.PositiveSmallIntegerField(default=0)
    playback_id = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True, editable=False)
    video_url = models.TextField(blank=True)
    stored_path = models.TextField(blank=True)
    content_type = models.CharField(max_length=120, blank=True)
    file_size = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True)
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    error_code = models.CharField(max_length=80, blank=True)
    error_message = models.TextField(blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    last_polled_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_video_generation_segments"
        ordering = ["index", "id"]
        indexes = [
            models.Index(fields=["job", "index"], name="a3_vidseg_job_index_idx"),
            models.Index(fields=["status", "last_polled_at"], name="a3_vidseg_status_poll_idx"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["job", "index"], name="a3_vidseg_job_index_unique"),
        ]

    def __str__(self) -> str:
        return f"{self.job.job_id}:{self.index}:{self.status}"
