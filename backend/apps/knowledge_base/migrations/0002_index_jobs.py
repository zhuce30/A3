from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("knowledge_base", "0001_initial"),
    ]
    operations = [
        migrations.CreateModel(
            name="KnowledgeIndexJob",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("job_type", models.CharField(choices=[("upload", "增量入库"), ("rebuild", "全量重建")], max_length=16)),
                ("status", models.CharField(choices=[("queued", "排队中"), ("running", "处理中"), ("succeeded", "已完成"), ("failed", "执行失败")], default="queued", max_length=16)),
                ("celery_task_id", models.CharField(blank=True, max_length=64)),
                ("progress", models.PositiveSmallIntegerField(default=0)),
                ("total_files", models.PositiveIntegerField(default=0)),
                ("processed_files", models.PositiveIntegerField(default=0)),
                ("current_file", models.CharField(blank=True, max_length=255)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("error_message", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_index_jobs", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "a3_knowledge_index_jobs", "ordering": ["-created_at"]},
        ),
        migrations.AddField(
            model_name="knowledgeresource",
            name="index_job",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="resources", to="knowledge_base.knowledgeindexjob"),
        ),
    ]
