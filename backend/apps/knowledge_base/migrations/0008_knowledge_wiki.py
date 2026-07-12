from __future__ import annotations

import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("knowledge_base", "0007_add_parse_index_job_type"),
    ]

    operations = [
        migrations.CreateModel(
            name="KnowledgeConcept",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("preferred_label", models.CharField(max_length=160)),
                ("normalized_label", models.CharField(max_length=180)),
                ("concept_type", models.CharField(default="concept", max_length=32)),
                ("summary", models.TextField(blank=True)),
                ("source_count", models.PositiveIntegerField(default=0)),
                ("evidence", models.JSONField(blank=True, default=list)),
                ("confidence", models.FloatField(default=0)),
                ("schema_version", models.CharField(default="a3.knowledge-wiki.v1", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_concepts", to=settings.AUTH_USER_MODEL)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="concepts", to="knowledge_base.knowledgeresource")),
            ],
            options={
                "db_table": "a3_knowledge_concepts",
                "ordering": ["preferred_label"],
            },
        ),
        migrations.CreateModel(
            name="KnowledgeDefinition",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("definition", models.TextField()),
                ("language", models.CharField(default="zh", max_length=16)),
                ("evidence", models.JSONField(blank=True, default=list)),
                ("confidence", models.FloatField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("concept", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="definitions", to="knowledge_base.knowledgeconcept")),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_definitions", to=settings.AUTH_USER_MODEL)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="definitions", to="knowledge_base.knowledgeresource")),
                ("source_block", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="definitions", to="knowledge_base.knowledgeblock")),
            ],
            options={
                "db_table": "a3_knowledge_definitions",
                "ordering": ["-confidence", "created_at"],
            },
        ),
        migrations.CreateModel(
            name="KnowledgeAlias",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("alias", models.CharField(max_length=160)),
                ("normalized_alias", models.CharField(max_length=180)),
                ("evidence", models.JSONField(blank=True, default=list)),
                ("confidence", models.FloatField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("concept", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="aliases", to="knowledge_base.knowledgeconcept")),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_aliases", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "a3_knowledge_aliases",
                "ordering": ["alias"],
            },
        ),
        migrations.CreateModel(
            name="KnowledgeSummary",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("title", models.CharField(max_length=200)),
                ("summary", models.TextField()),
                ("summary_type", models.CharField(default="document", max_length=32)),
                ("evidence", models.JSONField(blank=True, default=list)),
                ("confidence", models.FloatField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("concept", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="summaries", to="knowledge_base.knowledgeconcept")),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_summaries", to=settings.AUTH_USER_MODEL)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="summaries", to="knowledge_base.knowledgeresource")),
            ],
            options={
                "db_table": "a3_knowledge_summaries",
                "ordering": ["title"],
            },
        ),
        migrations.AddIndex(
            model_name="knowledgeconcept",
            index=models.Index(fields=["owner", "resource"], name="a3_kb_con_owner_res_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgeconcept",
            index=models.Index(fields=["owner", "normalized_label"], name="a3_kb_con_owner_label_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgeconcept",
            index=models.Index(fields=["concept_type"], name="a3_kb_con_type_idx"),
        ),
        migrations.AddConstraint(
            model_name="knowledgeconcept",
            constraint=models.UniqueConstraint(fields=("owner", "resource", "normalized_label", "concept_type"), name="a3_unique_kb_concept"),
        ),
        migrations.AddIndex(
            model_name="knowledgedefinition",
            index=models.Index(fields=["owner", "resource"], name="a3_kb_def_owner_res_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgedefinition",
            index=models.Index(fields=["concept"], name="a3_kb_def_concept_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgealias",
            index=models.Index(fields=["owner", "normalized_alias"], name="a3_kb_alias_owner_idx"),
        ),
        migrations.AddConstraint(
            model_name="knowledgealias",
            constraint=models.UniqueConstraint(fields=("owner", "concept", "normalized_alias"), name="a3_unique_kb_alias"),
        ),
        migrations.AddIndex(
            model_name="knowledgesummary",
            index=models.Index(fields=["owner", "resource"], name="a3_kb_sum_owner_res_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgesummary",
            index=models.Index(fields=["summary_type"], name="a3_kb_sum_type_idx"),
        ),
    ]
