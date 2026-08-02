from __future__ import annotations

import unicodedata
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


def normalize_tag_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


class Notebook(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_notebooks")
    name = models.CharField(max_length=160)
    sort_order = models.PositiveIntegerField(default=0)
    is_archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_notebooks"
        ordering = ["sort_order", "created_at"]
        indexes = [models.Index(fields=["user", "is_archived", "sort_order"], name="idx_note_book_user_sort")]


class NoteTag(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_tags")
    name = models.CharField(max_length=64)
    normalized_name = models.CharField(max_length=64, editable=False)
    color = models.CharField(max_length=32, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_tags"
        ordering = ["normalized_name", "created_at"]
        indexes = [models.Index(fields=["user", "name"], name="idx_note_tag_user_name")]
        constraints = [
            models.UniqueConstraint(fields=["user", "normalized_name"], name="uniq_note_tag_user_norm")
        ]

    def save(self, *args, **kwargs) -> None:
        self.name = self.name.strip()
        self.normalized_name = normalize_tag_name(self.name)
        super().save(*args, **kwargs)


class Note(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="personal_notes")
    notebook = models.ForeignKey(
        Notebook,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="notes",
    )
    title = models.CharField(max_length=240, blank=True)
    content_json = models.JSONField(default=dict, blank=True)
    content_text = models.TextField(blank=True, editable=False)
    version = models.PositiveIntegerField(default=1)
    is_pinned = models.BooleanField(default=False)
    last_edited_at = models.DateTimeField(default=timezone.now)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    tags = models.ManyToManyField(NoteTag, blank=True, related_name="notes")

    class Meta:
        db_table = "a3_note_notes"
        ordering = ["-is_pinned", "-last_edited_at", "-created_at"]
        indexes = [
            models.Index(fields=["user", "deleted_at", "-last_edited_at"], name="idx_note_user_deleted_edit"),
            models.Index(fields=["user", "notebook", "deleted_at"], name="idx_note_user_book_deleted"),
        ]


class NoteRevision(models.Model):
    class Source(models.TextChoices):
        CHECKPOINT = "checkpoint", "Checkpoint"
        MANUAL = "manual", "Manual"
        AI_WRITEBACK = "ai_writeback", "AI writeback"
        RESTORE = "restore", "Restore"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    note = models.ForeignKey(Note, on_delete=models.CASCADE, related_name="revisions")
    version = models.PositiveIntegerField()
    source = models.CharField(max_length=16, choices=Source.choices)
    title_snapshot = models.CharField(max_length=240, blank=True)
    content_json_snapshot = models.JSONField(default=dict, blank=True)
    content_text_snapshot = models.TextField(blank=True)
    actor_metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_revisions"
        ordering = ["-version"]
        indexes = [models.Index(fields=["note", "-created_at"], name="idx_note_rev_note_time")]
        constraints = [models.UniqueConstraint(fields=["note", "version"], name="uniq_note_revision_version")]


class NoteMutation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_mutations")
    note = models.ForeignKey(Note, on_delete=models.CASCADE, related_name="mutations")
    mutation_id = models.UUIDField(default=uuid.uuid4)
    resulting_version = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_mutations"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["note", "-created_at"], name="idx_note_mut_note_time")]
        constraints = [models.UniqueConstraint(fields=["user", "mutation_id"], name="uniq_note_user_mutation")]


class NoteAttachment(models.Model):
    class Kind(models.TextChoices):
        FILE = "file", "File"
        IMAGE = "image", "Image"
        LINK = "link", "Link"

    class ParseStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_attachments")
    note = models.ForeignKey(Note, on_delete=models.CASCADE, related_name="attachments")
    kind = models.CharField(max_length=16, choices=Kind.choices)
    display_name = models.CharField(max_length=255)
    relative_path = models.CharField(max_length=500, blank=True)
    source_url = models.URLField(max_length=2048, blank=True)
    mime_type = models.CharField(max_length=255, blank=True)
    size_bytes = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True)
    parse_status = models.CharField(max_length=16, choices=ParseStatus.choices, default=ParseStatus.PENDING)
    extracted_text = models.TextField(blank=True)
    preview_metadata = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_attachments"
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["user", "note", "deleted_at"], name="idx_note_att_user_note"),
            models.Index(fields=["parse_status", "created_at"], name="idx_note_att_parse_time"),
        ]


class NoteAiSession(models.Model):
    class ScopeType(models.TextChoices):
        NOTE = "note", "Note"
        NOTEBOOK = "notebook", "Notebook"
        SELECTION = "selection", "Selection"

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        ARCHIVED = "archived", "Archived"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_ai_sessions")
    title = models.CharField(max_length=240, blank=True)
    scope_type = models.CharField(max_length=16, choices=ScopeType.choices)
    scope_snapshot = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_ai_sessions"
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["user", "status", "-updated_at"], name="idx_note_session_user_time")]


class NoteAiMessage(models.Model):
    class Role(models.TextChoices):
        USER = "user", "User"
        ASSISTANT = "assistant", "Assistant"

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        STREAMING = "streaming", "Streaming"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(NoteAiSession, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    content = models.TextField(blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    client_request_id = models.UUIDField(default=uuid.uuid4)
    citations = models.JSONField(default=list, blank=True)
    verified = models.BooleanField(default=False)
    claims = models.JSONField(default=list, blank=True)
    safety = models.JSONField(default=dict, blank=True)
    degraded = models.BooleanField(default=False)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_ai_messages"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["session", "created_at"], name="idx_note_msg_session_time")]
        constraints = [
            models.UniqueConstraint(fields=["session", "client_request_id"], name="uniq_note_session_request")
        ]


class NoteWritebackPreview(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPLIED = "applied", "Applied"
        EXPIRED = "expired", "Expired"
        REJECTED = "rejected", "Rejected"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_writeback_previews")
    session = models.ForeignKey(NoteAiSession, on_delete=models.CASCADE, related_name="writeback_previews")
    target_note = models.ForeignKey(Note, on_delete=models.CASCADE, related_name="writeback_previews")
    target_version = models.PositiveIntegerField()
    proposed_content_json = models.JSONField(default=dict)
    diff_summary = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_writeback_previews"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "status", "expires_at"], name="idx_note_preview_user_exp")]


class NoteDailyDigest(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        PROCESSING = "processing", "Processing"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"

    class GeneratedBy(models.TextChoices):
        AUTOMATIC = "automatic", "Automatic"
        MANUAL = "manual", "Manual"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_daily_digests")
    digest_date = models.DateField()
    revision = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    title = models.CharField(max_length=240, blank=True)
    content_md = models.TextField(blank=True)
    source_snapshot = models.JSONField(default=dict, blank=True)
    generated_by = models.CharField(max_length=16, choices=GeneratedBy.choices, default=GeneratedBy.AUTOMATIC)
    idempotency_key = models.UUIDField(default=uuid.uuid4)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_daily_digests"
        ordering = ["-digest_date", "-revision"]
        indexes = [models.Index(fields=["user", "digest_date", "status"], name="idx_note_digest_user_date")]
        constraints = [
            models.UniqueConstraint(fields=["user", "digest_date", "revision"], name="uniq_note_digest_revision"),
            models.UniqueConstraint(fields=["user", "idempotency_key"], name="uniq_note_digest_idempotency"),
        ]


class NoteMemory(models.Model):
    class MemoryType(models.TextChoices):
        CORE = "core", "Core"
        EPISODIC = "episodic", "Episodic"

    class Status(models.TextChoices):
        CANDIDATE = "candidate", "Candidate"
        CONFIRMED = "confirmed", "Confirmed"
        PAUSED = "paused", "Paused"
        SUPERSEDED = "superseded", "Superseded"
        DELETED = "deleted", "Deleted"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_memories")
    memory_type = models.CharField(max_length=16, choices=MemoryType.choices)
    content = models.TextField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.CANDIDATE)
    importance = models.FloatField(default=0.5)
    confidence = models.FloatField(default=0.5)
    source_session = models.ForeignKey(
        NoteAiSession,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="memories",
    )
    source_message = models.ForeignKey(
        NoteAiMessage,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="memories",
    )
    source_note_refs = models.JSONField(default=list, blank=True)
    valid_from = models.DateTimeField(default=timezone.now)
    valid_until = models.DateTimeField(null=True, blank=True)
    superseded_by = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="supersedes",
    )
    confirmed_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_memories"
        ordering = ["-importance", "-updated_at"]
        indexes = [
            models.Index(fields=["user", "status", "memory_type"], name="idx_note_memory_user_state"),
            models.Index(fields=["user", "valid_until"], name="idx_note_memory_user_exp"),
        ]

    @property
    def is_usable(self) -> bool:
        now = timezone.now()
        return (
            self.status == self.Status.CONFIRMED
            and self.deleted_at is None
            and self.valid_from <= now
            and (self.valid_until is None or self.valid_until > now)
        )


class NoteExportJob(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        PROCESSING = "processing", "Processing"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        EXPIRED = "expired", "Expired"

    class Format(models.TextChoices):
        MARKDOWN_ZIP = "markdown_zip", "Markdown ZIP"
        JSON_ZIP = "json_zip", "JSON ZIP"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_export_jobs")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    format = models.CharField(max_length=16, choices=Format.choices)
    selection_snapshot = models.JSONField(default=dict, blank=True)
    relative_path = models.CharField(max_length=500, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_export_jobs"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "status", "-created_at"], name="idx_note_export_user_state")]


class NoteAuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_audit_events")
    action = models.CharField(max_length=64)
    object_type = models.CharField(max_length=64)
    object_id = models.UUIDField()
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_audit_events"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="idx_note_audit_user_time"),
            models.Index(fields=["object_type", "object_id"], name="idx_note_audit_object"),
        ]
