from __future__ import annotations

import hashlib
import unicodedata
import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models.signals import m2m_changed
from django.dispatch import receiver
from django.utils import timezone

from backend.apps.notes.validators import validate_finite_number, validate_note_metadata, validate_relative_path


MAX_MEMORY_SUPERSESSION_DEPTH = 64


def normalize_tag_name(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


class ValidatedModel(models.Model):
    class Meta:
        abstract = True

    def save(self, *args, **kwargs) -> None:
        self.full_clean()
        super().save(*args, **kwargs)


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


class NoteTag(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_tags")
    name = models.CharField(max_length=64)
    normalized_name = models.CharField(max_length=255, editable=False)
    normalized_key = models.CharField(max_length=64, editable=False)
    color = models.CharField(max_length=32, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_tags"
        ordering = ["normalized_name", "created_at"]
        indexes = [models.Index(fields=["user", "normalized_name"], name="idx_note_tag_user_norm")]
        constraints = [
            models.UniqueConstraint(fields=["user", "normalized_key"], name="uniq_note_tag_user_key")
        ]

    def save(self, *args, **kwargs) -> None:
        self.name = unicodedata.normalize("NFKC", self.name).strip()
        self.normalized_name = normalize_tag_name(self.name)
        self.normalized_key = hashlib.sha256(self.normalized_name.encode("utf-8")).hexdigest()
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "name" in update_fields:
            kwargs["update_fields"] = set(update_fields) | {"normalized_name", "normalized_key"}
        super().save(*args, **kwargs)


class Note(ValidatedModel):
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

    def clean(self) -> None:
        if self.notebook_id and self.user_id and self.notebook.user_id != self.user_id:
            raise ValidationError({"notebook": "Notebook must belong to the note owner."})


class NoteRevision(ValidatedModel):
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
    actor_metadata = models.JSONField(default=dict, blank=True, validators=[validate_note_metadata])
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_revisions"
        ordering = ["-version"]
        indexes = [models.Index(fields=["note", "-created_at"], name="idx_note_rev_note_time")]
        constraints = [models.UniqueConstraint(fields=["note", "version"], name="uniq_note_revision_version")]


class NoteMutation(ValidatedModel):
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

    def clean(self) -> None:
        if self.note_id and self.user_id and self.note.user_id != self.user_id:
            raise ValidationError({"note": "Note must belong to the mutation owner."})


class NoteAttachment(ValidatedModel):
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
    relative_path = models.CharField(max_length=500, blank=True, validators=[validate_relative_path])
    source_url = models.URLField(max_length=2048, blank=True)
    mime_type = models.CharField(max_length=255, blank=True)
    size_bytes = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True)
    parse_status = models.CharField(max_length=16, choices=ParseStatus.choices, default=ParseStatus.PENDING)
    parse_generation = models.PositiveIntegerField(default=1)
    parse_attempts = models.PositiveSmallIntegerField(default=0)
    parse_lease_token = models.UUIDField(null=True, blank=True, editable=False)
    parse_started_at = models.DateTimeField(null=True, blank=True)
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
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(kind="link", relative_path="") & ~models.Q(source_url="")
                    | models.Q(kind__in=["file", "image"], source_url="") & ~models.Q(relative_path="")
                ),
                name="chk_note_att_kind_location",
            )
        ]

    def clean(self) -> None:
        errors = {}
        if self.note_id and self.user_id and self.note.user_id != self.user_id:
            errors["note"] = "Note must belong to the attachment owner."
        if self.kind == self.Kind.LINK:
            if not self.source_url:
                errors["source_url"] = "Link attachments require a source URL."
            if self.relative_path:
                errors["relative_path"] = "Link attachments cannot have a relative path."
        elif self.kind in {self.Kind.FILE, self.Kind.IMAGE}:
            if not self.relative_path:
                errors["relative_path"] = "File and image attachments require a relative path."
            if self.source_url:
                errors["source_url"] = "File and image attachments cannot have a source URL."
        if errors:
            raise ValidationError(errors)


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
    run_generation = models.PositiveIntegerField(default=0)
    run_lease_token = models.UUIDField(null=True, blank=True, editable=False)
    run_started_at = models.DateTimeField(null=True, blank=True)
    run_heartbeat_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_ai_messages"
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["session", "created_at"], name="idx_note_msg_session_time"),
            models.Index(fields=["status", "run_heartbeat_at"], name="idx_note_msg_status_beat"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["session", "client_request_id"], name="uniq_note_session_request")
        ]


class NoteWritebackPreview(ValidatedModel):
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

    def clean(self) -> None:
        errors = {}
        if self.session_id and self.user_id and self.session.user_id != self.user_id:
            errors["session"] = "Session must belong to the preview owner."
        if self.target_note_id and self.user_id and self.target_note.user_id != self.user_id:
            errors["target_note"] = "Target note must belong to the preview owner."
        if errors:
            raise ValidationError(errors)


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


class NoteMemory(ValidatedModel):
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
    importance = models.FloatField(
        default=0.5,
        validators=[validate_finite_number, MinValueValidator(0), MaxValueValidator(5)],
    )
    confidence = models.FloatField(
        default=0.5,
        validators=[validate_finite_number, MinValueValidator(0), MaxValueValidator(1)],
    )
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
        constraints = [
            models.CheckConstraint(
                condition=models.Q(importance__gte=0, importance__lte=5),
                name="chk_note_memory_importance",
            ),
            models.CheckConstraint(
                condition=models.Q(confidence__gte=0, confidence__lte=1),
                name="chk_note_memory_confidence",
            ),
            models.CheckConstraint(
                condition=models.Q(valid_until__isnull=True) | models.Q(valid_until__gt=models.F("valid_from")),
                name="chk_note_memory_validity",
            ),
            models.CheckConstraint(
                condition=~models.Q(status="confirmed") | models.Q(confirmed_at__isnull=False),
                name="chk_note_memory_confirmed",
            ),
            models.CheckConstraint(
                condition=models.Q(superseded_by__isnull=True) | ~models.Q(id=models.F("superseded_by")),
                name="chk_note_memory_not_self",
            ),
        ]

    def clean(self) -> None:
        errors = {}
        if self.source_session_id and self.user_id and self.source_session.user_id != self.user_id:
            errors["source_session"] = "Source session must belong to the memory owner."
        if self.source_message_id and self.user_id and self.source_message.session.user_id != self.user_id:
            errors["source_message"] = "Source message must belong to the memory owner."
        if (
            self.source_session_id
            and self.source_message_id
            and self.source_message.session_id != self.source_session_id
        ):
            errors["source_message"] = "Source message must belong to the selected source session."
        if self.valid_until is not None and self.valid_from is not None and self.valid_until <= self.valid_from:
            errors["valid_until"] = "Validity end must be later than validity start."
        if self.status == self.Status.CONFIRMED and self.confirmed_at is None:
            errors["confirmed_at"] = "Confirmed memories require a confirmation timestamp."
        if self.superseded_by_id:
            if self.superseded_by_id == self.pk:
                errors["superseded_by"] = "A memory cannot supersede itself."
            elif self.user_id and self.superseded_by.user_id != self.user_id:
                errors["superseded_by"] = "Superseding memory must belong to the same user."
            elif self._supersession_chain_is_invalid():
                errors["superseded_by"] = "Memory supersession cannot contain a cycle or exceed 64 nodes."
        if errors:
            raise ValidationError(errors)

    def _supersession_chain_is_invalid(self) -> bool:
        current_id = self.superseded_by_id
        seen = {self.pk}
        for _ in range(MAX_MEMORY_SUPERSESSION_DEPTH):
            if current_id is None:
                return False
            if current_id in seen:
                return True
            seen.add(current_id)
            current_id = type(self).objects.filter(pk=current_id).values_list("superseded_by_id", flat=True).first()
        return current_id is not None

    @property
    def is_usable(self) -> bool:
        now = timezone.now()
        return (
            self.status == self.Status.CONFIRMED
            and self.confirmed_at is not None
            and self.deleted_at is None
            and self.valid_from <= now
            and (self.valid_until is None or self.valid_until > now)
        )


class NoteExportJob(ValidatedModel):
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
    run_generation = models.PositiveIntegerField(default=0)
    run_lease_token = models.UUIDField(null=True, blank=True, editable=False)
    run_started_at = models.DateTimeField(null=True, blank=True)
    enqueue_attempts = models.PositiveSmallIntegerField(default=0)
    relative_path = models.CharField(max_length=500, blank=True, validators=[validate_relative_path])
    output_size_bytes = models.PositiveBigIntegerField(default=0)
    output_sha256 = models.CharField(max_length=64, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_export_jobs"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "status", "-created_at"], name="idx_note_export_user_state")]


class NotePhysicalCleanup(ValidatedModel):
    class Kind(models.TextChoices):
        ATTACHMENT_DIRECTORY = "attachment_dir", "Attachment directory"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=24, choices=Kind.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    owner_ref = models.CharField(max_length=64)
    reference_id = models.UUIDField()
    note_ref = models.UUIDField()
    relative_path = models.CharField(max_length=500, validators=[validate_relative_path])
    attempts = models.PositiveSmallIntegerField(default=0)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_note_physical_cleanups"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["status", "updated_at"], name="idx_note_cleanup_state")]


class NoteAuditEvent(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="note_audit_events")
    action = models.CharField(max_length=64)
    object_type = models.CharField(max_length=64)
    object_id = models.UUIDField()
    metadata = models.JSONField(default=dict, blank=True, validators=[validate_note_metadata])
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_note_audit_events"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="idx_note_audit_user_time"),
            models.Index(fields=["object_type", "object_id"], name="idx_note_audit_object"),
        ]


@receiver(m2m_changed, sender=Note.tags.through)
def validate_note_tag_ownership(sender, instance, action, reverse, model, pk_set, **kwargs) -> None:
    if action != "pre_add" or not pk_set:
        return
    has_mismatch = model.objects.filter(pk__in=pk_set).exclude(user_id=instance.user_id).exists()
    if has_mismatch:
        raise ValidationError("Notes and tags must belong to the same user.")
