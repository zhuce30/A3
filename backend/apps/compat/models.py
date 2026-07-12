from __future__ import annotations

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
