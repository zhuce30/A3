from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
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


class CuratedResourceType(models.TextChoices):
    LECTURE_DOC = "lecture_doc", "讲解文档"
    CODE_LAB = "code_lab", "实操案例"
    VIDEO = "video", "视频"


class CuratedResourceDeliveryMode(models.TextChoices):
    INTERNAL_DOCUMENT = "internal_document", "站内文档"
    EXTERNAL_LINK = "external_link", "外部链接"


class CuratedResourceDifficulty(models.TextChoices):
    FOUNDATION = "foundation", "基础"
    INTERMEDIATE = "intermediate", "中等"
    ADVANCED = "advanced", "进阶"


class CuratedResourceVerificationStatus(models.TextChoices):
    VERIFIED = "verified", "已核验"
    NEEDS_REVIEW = "needs_review", "待复核"
    BROKEN = "broken", "不可用"


class IndexJobType(models.TextChoices):
    UPLOAD = "upload", "upload"
    REBUILD = "rebuild", "rebuild"
    PARSE = "parse", "parse"
    WIKI = "wiki", "wiki"


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
    progress_detail = models.JSONField(default=dict, blank=True)
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


class CuratedLearningResource(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    resource_code = models.CharField(max_length=64, unique=True)
    course = models.ForeignKey(
        "learning.Course",
        on_delete=models.CASCADE,
        related_name="curated_resources",
    )
    knowledge_points = models.ManyToManyField(
        "learning.KnowledgePoint",
        related_name="curated_resources",
        blank=True,
    )
    knowledge_resource = models.OneToOneField(
        KnowledgeResource,
        on_delete=models.SET_NULL,
        related_name="curated_resource",
        null=True,
        blank=True,
    )
    resource_type = models.CharField(max_length=24, choices=CuratedResourceType.choices)
    delivery_mode = models.CharField(max_length=24, choices=CuratedResourceDeliveryMode.choices)
    title = models.CharField(max_length=255)
    summary = models.TextField(blank=True)
    external_url = models.URLField(max_length=1000, blank=True)
    provider = models.CharField(max_length=255, blank=True)
    difficulty = models.CharField(
        max_length=24,
        choices=CuratedResourceDifficulty.choices,
        default=CuratedResourceDifficulty.INTERMEDIATE,
    )
    estimated_minutes = models.PositiveIntegerField(default=0)
    key_segment = models.CharField(max_length=255, blank=True)
    prerequisites = models.JSONField(default=list, blank=True)
    learner_profiles = models.JSONField(default=list, blank=True)
    weakness_triggers = models.JSONField(default=list, blank=True)
    learning_objectives = models.JSONField(default=list, blank=True)
    completion_criteria = models.JSONField(default=list, blank=True)
    recommendation_template = models.TextField(blank=True)
    keywords = models.JSONField(default=list, blank=True)
    is_free = models.BooleanField(default=True)
    verification_status = models.CharField(
        max_length=24,
        choices=CuratedResourceVerificationStatus.choices,
        default=CuratedResourceVerificationStatus.NEEDS_REVIEW,
    )
    verified_at = models.DateField(null=True, blank=True)
    content_hash = models.CharField(max_length=64, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_curated_learning_resources"
        ordering = ["resource_code"]
        indexes = [
            models.Index(fields=["course", "is_active"], name="a3_curated_course_active_idx"),
            models.Index(fields=["resource_type", "is_active"], name="a3_curated_type_active_idx"),
            models.Index(fields=["verification_status"], name="a3_curated_verify_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.resource_code} {self.title}"

    def clean(self) -> None:
        super().clean()
        errors = {}
        if self.delivery_mode == CuratedResourceDeliveryMode.INTERNAL_DOCUMENT and not self.knowledge_resource_id:
            errors["knowledge_resource"] = "站内文档必须关联知识库文件"
        if self.delivery_mode == CuratedResourceDeliveryMode.EXTERNAL_LINK and not self.external_url.lower().startswith("https://"):
            errors["external_url"] = "外部资源必须使用 HTTPS 链接"
        if errors:
            raise ValidationError(errors)


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


class KnowledgeConcept(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_concepts",
    )
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="concepts",
    )
    preferred_label = models.CharField(max_length=160)
    normalized_label = models.CharField(max_length=180)
    concept_type = models.CharField(max_length=32, default="concept")
    summary = models.TextField(blank=True)
    source_count = models.PositiveIntegerField(default=0)
    evidence = models.JSONField(default=list, blank=True)
    confidence = models.FloatField(default=0)
    schema_version = models.CharField(max_length=64, default="a3.knowledge-wiki.v1")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_concepts"
        ordering = ["preferred_label"]
        indexes = [
            models.Index(fields=["owner", "resource"], name="a3_kb_con_owner_res_idx"),
            models.Index(fields=["owner", "normalized_label"], name="a3_kb_con_owner_label_idx"),
            models.Index(fields=["concept_type"], name="a3_kb_con_type_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "resource", "normalized_label", "concept_type"],
                name="a3_unique_kb_concept",
            ),
        ]


class KnowledgeDefinition(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_definitions",
    )
    concept = models.ForeignKey(
        KnowledgeConcept,
        on_delete=models.CASCADE,
        related_name="definitions",
    )
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="definitions",
    )
    source_block = models.ForeignKey(
        KnowledgeBlock,
        on_delete=models.SET_NULL,
        related_name="definitions",
        null=True,
        blank=True,
    )
    definition = models.TextField()
    language = models.CharField(max_length=16, default="zh")
    evidence = models.JSONField(default=list, blank=True)
    confidence = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_definitions"
        ordering = ["-confidence", "created_at"]
        indexes = [
            models.Index(fields=["owner", "resource"], name="a3_kb_def_owner_res_idx"),
            models.Index(fields=["concept"], name="a3_kb_def_concept_idx"),
        ]


class KnowledgeAlias(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_aliases",
    )
    concept = models.ForeignKey(
        KnowledgeConcept,
        on_delete=models.CASCADE,
        related_name="aliases",
    )
    alias = models.CharField(max_length=160)
    normalized_alias = models.CharField(max_length=180)
    evidence = models.JSONField(default=list, blank=True)
    confidence = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_knowledge_aliases"
        ordering = ["alias"]
        indexes = [
            models.Index(fields=["owner", "normalized_alias"], name="a3_kb_alias_owner_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "concept", "normalized_alias"],
                name="a3_unique_kb_alias",
            ),
        ]


class KnowledgeSummary(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_summaries",
    )
    concept = models.ForeignKey(
        KnowledgeConcept,
        on_delete=models.CASCADE,
        related_name="summaries",
        null=True,
        blank=True,
    )
    resource = models.ForeignKey(
        KnowledgeResource,
        on_delete=models.CASCADE,
        related_name="summaries",
    )
    title = models.CharField(max_length=200)
    summary = models.TextField()
    summary_type = models.CharField(max_length=32, default="document")
    evidence = models.JSONField(default=list, blank=True)
    confidence = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_knowledge_summaries"
        ordering = ["title"]
        indexes = [
            models.Index(fields=["owner", "resource"], name="a3_kb_sum_owner_res_idx"),
            models.Index(fields=["summary_type"], name="a3_kb_sum_type_idx"),
        ]
