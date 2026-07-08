from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [
        ("knowledge_base", "0002_index_jobs"),
    ]

    operations = [
        migrations.AlterField(
            model_name="knowledgeresource",
            name="status",
            field=models.CharField(
                choices=[
                    ("uploaded", "uploaded"),
                    ("indexing", "indexing"),
                    ("indexed", "indexed"),
                    ("indexed_with_warnings", "indexed with warnings"),
                    ("failed", "failed"),
                ],
                default="uploaded",
                max_length=32,
            ),
        ),
        migrations.CreateModel(
            name="KnowledgeParseRun",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("status", models.CharField(default="queued", max_length=32)),
                ("parser", models.CharField(default="native", max_length=64)),
                ("pages", models.PositiveIntegerField(default=0)),
                ("text_blocks", models.PositiveIntegerField(default=0)),
                ("image_blocks", models.PositiveIntegerField(default=0)),
                ("table_blocks", models.PositiveIntegerField(default=0)),
                ("formula_blocks", models.PositiveIntegerField(default=0)),
                ("ocr_chars", models.PositiveIntegerField(default=0)),
                ("quality_score", models.FloatField(default=0)),
                ("warnings", models.JSONField(blank=True, default=list)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("error_message", models.TextField(blank=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="parse_runs", to="knowledge_base.knowledgeresource")),
            ],
            options={"db_table": "a3_knowledge_parse_runs", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="KnowledgePage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("page_number", models.PositiveIntegerField(blank=True, null=True)),
                ("slide_number", models.PositiveIntegerField(blank=True, null=True)),
                ("width", models.PositiveIntegerField(default=0)),
                ("height", models.PositiveIntegerField(default=0)),
                ("ocr_text", models.TextField(blank=True)),
                ("summary", models.TextField(blank=True)),
                ("quality_score", models.FloatField(default=0)),
                ("warnings", models.JSONField(blank=True, default=list)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("parse_run", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="pages_detail", to="knowledge_base.knowledgeparserun")),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="pages", to="knowledge_base.knowledgeresource")),
            ],
            options={"db_table": "a3_knowledge_pages", "ordering": ["page_number", "slide_number", "created_at"]},
        ),
        migrations.CreateModel(
            name="KnowledgeAsset",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("kind", models.CharField(max_length=32)),
                ("mime_type", models.CharField(blank=True, max_length=128)),
                ("storage_path", models.CharField(max_length=500)),
                ("sha256", models.CharField(blank=True, max_length=64)),
                ("width", models.PositiveIntegerField(default=0)),
                ("height", models.PositiveIntegerField(default=0)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("page", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="assets", to="knowledge_base.knowledgepage")),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="assets", to="knowledge_base.knowledgeresource")),
            ],
            options={"db_table": "a3_knowledge_assets", "ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="KnowledgeBlock",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("modality", models.CharField(max_length=32)),
                ("text", models.TextField(blank=True)),
                ("markdown", models.TextField(blank=True)),
                ("html", models.TextField(blank=True)),
                ("bbox", models.JSONField(blank=True, default=list)),
                ("confidence", models.FloatField(default=0)),
                ("warnings", models.JSONField(blank=True, default=list)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("asset", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="blocks", to="knowledge_base.knowledgeasset")),
                ("page", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="blocks", to="knowledge_base.knowledgepage")),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="blocks", to="knowledge_base.knowledgeresource")),
            ],
            options={"db_table": "a3_knowledge_blocks", "ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="KnowledgeIndexEntry",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("index_type", models.CharField(max_length=32)),
                ("index_backend", models.CharField(max_length=64)),
                ("external_id", models.CharField(blank=True, max_length=128)),
                ("status", models.CharField(default="queued", max_length=32)),
                ("error_message", models.TextField(blank=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("block", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="index_entries", to="knowledge_base.knowledgeblock")),
            ],
            options={"db_table": "a3_knowledge_index_entries", "ordering": ["-updated_at"]},
        ),
    ]
