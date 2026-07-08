from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    initial = True
    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [
        migrations.CreateModel(
            name="KnowledgeResource",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("original_name", models.CharField(max_length=255)),
                ("stored_path", models.CharField(max_length=500)),
                ("file_type", models.CharField(max_length=16)),
                ("file_size", models.PositiveBigIntegerField(default=0)),
                ("status", models.CharField(choices=[("uploaded", "已上传"), ("indexing", "索引中"), ("indexed", "已索引"), ("failed", "处理失败")], default="uploaded", max_length=16)),
                ("document_count", models.PositiveIntegerField(default=0)),
                ("chunk_count", models.PositiveIntegerField(default=0)),
                ("error_message", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_resources", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "a3_knowledge_resources", "ordering": ["-created_at"]},
        ),
    ]
