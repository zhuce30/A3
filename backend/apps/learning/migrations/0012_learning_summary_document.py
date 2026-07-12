import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("learning", "0011_learningevent_client_timestamp_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="LearningSummaryDocument",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("title", models.CharField(max_length=120)),
                ("file_name", models.CharField(max_length=180)),
                ("prompt", models.CharField(blank=True, max_length=240)),
                ("content_md", models.TextField()),
                ("summary_date", models.DateField(default=django.utils.timezone.localdate)),
                ("source_snapshot", models.JSONField(blank=True, default=dict)),
                ("schema_version", models.CharField(default="a3.learning-summary-document.v1", max_length=64)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="learning_summary_documents",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "a3_learning_summary_documents",
                "ordering": ["-created_at", "-id"],
            },
        ),
        migrations.AddIndex(
            model_name="learningsummarydocument",
            index=models.Index(fields=["user", "-created_at"], name="idx_summary_user_time"),
        ),
        migrations.AddIndex(
            model_name="learningsummarydocument",
            index=models.Index(fields=["user", "summary_date"], name="idx_summary_user_date"),
        ),
        migrations.AddConstraint(
            model_name="learningsummarydocument",
            constraint=models.UniqueConstraint(fields=("user", "file_name"), name="unique_user_summary_file_name"),
        ),
    ]
