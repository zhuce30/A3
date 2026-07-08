from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class ResourceStatus(models.TextChoices):
    UPLOADED = "uploaded", "uploaded"
    INDEXING = "indexing", "indexing"
    INDEXED = "indexed", "indexed"
    INDEXED_WITH_WARNINGS = "indexed_with_warnings", "indexed with warnings"
    FAILED = "failed", "failed"


class ResourceScope(models.TextChoices):
    PERSONAL = "personal", "personal"
    TEACHER = "teacher", "teacher"
    CLASS = "class", "class"
    GLOBAL = "global", "global"


class IndexJobType(models.TextChoices):
    UPLOAD = "upload", "upload"
    REBUILD = "rebuild", "rebuild"
    PARSE = "parse", "parse"


class IndexJobStatus(models.TextChoices):
    QUEUED = "queued", "queued"
    RUNNING = "running", "running"
    SUCCEEDED = "succeeded", "succeeded"
    FAILED = "failed", "failed"


class KnowledgeIndexJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_index_jobs",
    )
    job_type = models.CharField(max_length=16, choices=IndexJobType.choices)
    status = models.CharField(max_length=16, choices=IndexJobStatus.choices, default=IndexJobStatus.QUEUED)
    celery_task_id = models.CharField(max_length=64, blank=True)
    progress = models.PositiveSmallIntegerField(default=0)
    total_files = models.PositiveIntegerField(default=0)
    processed_files = models.PositiveIntegerField(default=0)
    current_file = models.CharField(max_length=255, blank=True)
    result = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_index_jobs"
        ordering = ["-created_at"]


class KnowledgeResource(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_resources",
    )
    index_job = models.ForeignKey(
        KnowledgeIndexJob,
        on_delete=models.SET_NULL,
        related_name="resources",
        null=True,
        blank=True,
    )
    original_name = models.CharField(max_length=255)
    stored_path = models.CharField(max_length=500)
    file_type = models.CharField(max_length=16)
    file_size = models.PositiveBigIntegerField(default=0)
    resource_scope = models.CharField(max_length=16, choices=ResourceScope.choices, default=ResourceScope.TEACHER)
    course_key = models.CharField(max_length=128, blank=True)
    visibility = models.CharField(max_length=32, default="owner")
    student_profile_snapshot = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=32, choices=ResourceStatus.choices, default=ResourceStatus.UPLOADED)
    document_count = models.PositiveIntegerField(default=0)
    chunk_count = models.PositiveIntegerField(default=0)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_resources"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.original_name


class KnowledgeParseRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="parse_runs",
    )
    status = models.CharField(max_length=32, default="queued")
    parser = models.CharField(max_length=64, default="native")
    pages = models.PositiveIntegerField(default=0)
    text_blocks = models.PositiveIntegerField(default=0)
    image_blocks = models.PositiveIntegerField(default=0)
    table_blocks = models.PositiveIntegerField(default=0)
    formula_blocks = models.PositiveIntegerField(default=0)
    ocr_chars = models.PositiveIntegerField(default=0)
    quality_score = models.FloatField(default=0)
    warnings = models.JSONField(default=list, blank=True)
    result = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_parse_runs"
        ordering = ["-created_at"]


class KnowledgePage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="pages",
    )
    parse_run = models.ForeignKey(
        KnowledgeParseRun,
        on_delete=models.CASCADE,
        related_name="pages_detail",
        null=True,
        blank=True,
    )
    page_number = models.PositiveIntegerField(null=True, blank=True)
    slide_number = models.PositiveIntegerField(null=True, blank=True)
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    ocr_text = models.TextField(blank=True)
    summary = models.TextField(blank=True)
    quality_score = models.FloatField(default=0)
    warnings = models.JSONField(default=list, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_knowledge_pages"
        ordering = ["page_number", "slide_number", "created_at"]


class KnowledgeAsset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="assets",
    )
    page = models.ForeignKey(
        KnowledgePage,
        on_delete=models.CASCADE,
        related_name="assets",
        null=True,
        blank=True,
    )
    kind = models.CharField(max_length=32)
    mime_type = models.CharField(max_length=128, blank=True)
    storage_path = models.CharField(max_length=500)
    sha256 = models.CharField(max_length=64, blank=True)
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_knowledge_assets"
        ordering = ["created_at"]


class KnowledgeBlock(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="blocks",
    )
    page = models.ForeignKey(
        KnowledgePage,
        on_delete=models.CASCADE,
        related_name="blocks",
        null=True,
        blank=True,
    )
    asset = models.ForeignKey(
        KnowledgeAsset,
        on_delete=models.SET_NULL,
        related_name="blocks",
        null=True,
        blank=True,
    )
    modality = models.CharField(max_length=32)
    text = models.TextField(blank=True)
    markdown = models.TextField(blank=True)
    html = models.TextField(blank=True)
    bbox = models.JSONField(default=list, blank=True)
    confidence = models.FloatField(default=0)
    warnings = models.JSONField(default=list, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_knowledge_blocks"
        ordering = ["created_at"]


class KnowledgeIndexEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    block = models.ForeignKey(
        KnowledgeBlock,
        on_delete=models.CASCADE,
        related_name="index_entries",
    )
    index_type = models.CharField(max_length=32)
    index_backend = models.CharField(max_length=64)
    external_id = models.CharField(max_length=128, blank=True)
    status = models.CharField(max_length=32, default="queued")
    error_message = models.TextField(blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_knowledge_index_entries"
        ordering = ["-updated_at"]


class KnowledgeGraphEntity(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_graph_entities",
    )
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="graph_entities",
    )
    label = models.CharField(max_length=160)
    normalized_label = models.CharField(max_length=180)
    entity_type = models.CharField(max_length=32, default="concept")
    aliases = models.JSONField(default=list, blank=True)
    summary = models.TextField(blank=True)
    confidence = models.FloatField(default=0)
    source_count = models.PositiveIntegerField(default=0)
    source_locations = models.JSONField(default=list, blank=True)
    degraded = models.BooleanField(default=True)
    extraction_method = models.CharField(max_length=32, default="rule_fallback")
    schema_version = models.CharField(max_length=64, default="a3.material-knowledge-graph.v1")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_graph_entities"
        ordering = ["label"]
        indexes = [
            models.Index(fields=["owner", "resource"], name="a3_knowled_owner_i_9d0417_idx"),
            models.Index(fields=["owner", "normalized_label"], name="a3_knowled_owner_i_9110be_idx"),
            models.Index(fields=["entity_type"], name="a3_knowled_entity__1cb1b5_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "resource", "normalized_label", "entity_type"],
                name="a3_unique_kb_graph_entity",
            ),
        ]


class KnowledgeGraphRelation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_graph_relations",
    )
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="graph_relations",
    )
    source_entity = models.ForeignKey(
        KnowledgeGraphEntity,
        on_delete=models.CASCADE,
        related_name="outgoing_relations",
    )
    target_entity = models.ForeignKey(
        KnowledgeGraphEntity,
        on_delete=models.CASCADE,
        related_name="incoming_relations",
    )
    relation_type = models.CharField(max_length=32, default="related_to")
    label = models.CharField(max_length=80, default="相关")
    weight = models.FloatField(default=0)
    evidence = models.JSONField(default=list, blank=True)
    degraded = models.BooleanField(default=True)
    extraction_method = models.CharField(max_length=32, default="rule_fallback")
    schema_version = models.CharField(max_length=64, default="a3.material-knowledge-graph.v1")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_graph_relations"
        ordering = ["relation_type", "label"]
        indexes = [
            models.Index(fields=["owner", "resource"], name="a3_knowled_owner_i_8f3b7f_idx"),
            models.Index(fields=["relation_type"], name="a3_knowled_relatio_a1017a_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "resource", "source_entity", "target_entity", "relation_type"],
                name="a3_unique_kb_graph_relation",
            ),
        ]


class KnowledgeGraphClaim(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_graph_claims",
    )
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="graph_claims",
    )
    text = models.TextField()
    entity_ids = models.JSONField(default=list, blank=True)
    verified = models.BooleanField(default=False)
    evidence = models.JSONField(default=list, blank=True)
    degraded = models.BooleanField(default=True)
    extraction_method = models.CharField(max_length=32, default="rule_fallback")
    schema_version = models.CharField(max_length=64, default="a3.material-knowledge-graph.v1")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_graph_claims"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["owner", "resource"], name="a3_knowled_owner_i_bfc6c5_idx"),
        ]
