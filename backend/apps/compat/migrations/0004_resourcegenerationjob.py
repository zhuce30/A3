from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("compat", "0003_agentspan"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ResourceGenerationJob",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("job_id", models.CharField(db_index=True, max_length=120, unique=True)),
                ("workflow", models.CharField(default="resource_generate", max_length=80)),
                ("status", models.CharField(default="queued", max_length=32)),
                ("progress", models.PositiveSmallIntegerField(default=0)),
                ("stage", models.CharField(default="queued", max_length=40)),
                ("message", models.CharField(blank=True, max_length=255)),
                ("goal", models.CharField(blank=True, max_length=500)),
                ("top_k", models.PositiveSmallIntegerField(default=5)),
                ("resource_type", models.CharField(blank=True, max_length=40)),
                ("resource_pack_id", models.CharField(blank=True, db_index=True, max_length=64)),
                ("trace_id", models.CharField(blank=True, db_index=True, max_length=64)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("error_message", models.TextField(blank=True)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="a3_resource_generation_jobs", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "a3_resource_generation_jobs",
                "ordering": ["-created_at", "-id"],
            },
        ),
        migrations.AddIndex(
            model_name="resourcegenerationjob",
            index=models.Index(fields=["user", "-created_at"], name="a3_resgen_user_created_idx"),
        ),
        migrations.AddIndex(
            model_name="resourcegenerationjob",
            index=models.Index(fields=["workflow", "status"], name="a3_resgen_flow_status_idx"),
        ),
    ]
