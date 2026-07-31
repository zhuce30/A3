import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("assessments", "0007_tutor_analytics_indexes"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ReviewHandoutJob",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("scope", models.CharField(default="active", max_length=16)),
                ("snapshot_hash", models.CharField(db_index=True, max_length=64)),
                ("snapshot", models.JSONField(default=dict)),
                ("ranked_weak_points", models.JSONField(default=list)),
                ("status", models.CharField(default="queued", max_length=16)),
                ("progress", models.PositiveSmallIntegerField(default=0)),
                ("stage", models.CharField(default="queued", max_length=40)),
                ("message", models.CharField(blank=True, max_length=255)),
                ("trace_id", models.CharField(blank=True, db_index=True, max_length=64)),
                ("celery_task_id", models.CharField(blank=True, max_length=64)),
                ("citations", models.JSONField(blank=True, default=list)),
                ("verified", models.BooleanField(default=False)),
                ("degraded", models.BooleanField(default=False)),
                ("docx_path", models.CharField(blank=True, max_length=500)),
                ("pdf_path", models.CharField(blank=True, max_length=500)),
                ("error_message", models.TextField(blank=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="review_handout_jobs", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "a3_review_handout_jobs", "ordering": ["-created_at"]},
        ),
        migrations.AddIndex(
            model_name="reviewhandoutjob",
            index=models.Index(fields=["user", "-created_at"], name="a3_handout_user_created_idx"),
        ),
        migrations.AddIndex(
            model_name="reviewhandoutjob",
            index=models.Index(fields=["user", "snapshot_hash", "status"], name="a3_handout_hash_status_idx"),
        ),
    ]
