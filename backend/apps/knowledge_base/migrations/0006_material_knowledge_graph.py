from __future__ import annotations

import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("knowledge_base", "0005_resource_scope"),
    ]

    operations = [
        migrations.CreateModel(
            name="KnowledgeGraphEntity",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("label", models.CharField(max_length=160)),
                ("normalized_label", models.CharField(max_length=180)),
                ("entity_type", models.CharField(default="concept", max_length=32)),
                ("aliases", models.JSONField(blank=True, default=list)),
                ("summary", models.TextField(blank=True)),
                ("confidence", models.FloatField(default=0)),
                ("source_count", models.PositiveIntegerField(default=0)),
                ("source_locations", models.JSONField(blank=True, default=list)),
                ("degraded", models.BooleanField(default=True)),
                ("extraction_method", models.CharField(default="rule_fallback", max_length=32)),
                ("schema_version", models.CharField(default="a3.material-knowledge-graph.v1", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_graph_entities", to=settings.AUTH_USER_MODEL)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="graph_entities", to="knowledge_base.knowledgeresource")),
            ],
            options={
                "db_table": "a3_knowledge_graph_entities",
                "ordering": ["label"],
            },
        ),
        migrations.CreateModel(
            name="KnowledgeGraphClaim",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("text", models.TextField()),
                ("entity_ids", models.JSONField(blank=True, default=list)),
                ("verified", models.BooleanField(default=False)),
                ("evidence", models.JSONField(blank=True, default=list)),
                ("degraded", models.BooleanField(default=True)),
                ("extraction_method", models.CharField(default="rule_fallback", max_length=32)),
                ("schema_version", models.CharField(default="a3.material-knowledge-graph.v1", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_graph_claims", to=settings.AUTH_USER_MODEL)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="graph_claims", to="knowledge_base.knowledgeresource")),
            ],
            options={
                "db_table": "a3_knowledge_graph_claims",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="KnowledgeGraphRelation",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("relation_type", models.CharField(default="related_to", max_length=32)),
                ("label", models.CharField(default="相关", max_length=80)),
                ("weight", models.FloatField(default=0)),
                ("evidence", models.JSONField(blank=True, default=list)),
                ("degraded", models.BooleanField(default=True)),
                ("extraction_method", models.CharField(default="rule_fallback", max_length=32)),
                ("schema_version", models.CharField(default="a3.material-knowledge-graph.v1", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="knowledge_graph_relations", to=settings.AUTH_USER_MODEL)),
                ("resource", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="graph_relations", to="knowledge_base.knowledgeresource")),
                ("source_entity", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="outgoing_relations", to="knowledge_base.knowledgegraphentity")),
                ("target_entity", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="incoming_relations", to="knowledge_base.knowledgegraphentity")),
            ],
            options={
                "db_table": "a3_knowledge_graph_relations",
                "ordering": ["relation_type", "label"],
            },
        ),
        migrations.AddIndex(
            model_name="knowledgegraphentity",
            index=models.Index(fields=["owner", "resource"], name="a3_knowled_owner_i_9d0417_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgegraphentity",
            index=models.Index(fields=["owner", "normalized_label"], name="a3_knowled_owner_i_9110be_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgegraphentity",
            index=models.Index(fields=["entity_type"], name="a3_knowled_entity__1cb1b5_idx"),
        ),
        migrations.AddConstraint(
            model_name="knowledgegraphentity",
            constraint=models.UniqueConstraint(fields=("owner", "resource", "normalized_label", "entity_type"), name="a3_unique_kb_graph_entity"),
        ),
        migrations.AddIndex(
            model_name="knowledgegraphclaim",
            index=models.Index(fields=["owner", "resource"], name="a3_knowled_owner_i_bfc6c5_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgegraphrelation",
            index=models.Index(fields=["owner", "resource"], name="a3_knowled_owner_i_8f3b7f_idx"),
        ),
        migrations.AddIndex(
            model_name="knowledgegraphrelation",
            index=models.Index(fields=["relation_type"], name="a3_knowled_relatio_a1017a_idx"),
        ),
        migrations.AddConstraint(
            model_name="knowledgegraphrelation",
            constraint=models.UniqueConstraint(fields=("owner", "resource", "source_entity", "target_entity", "relation_type"), name="a3_unique_kb_graph_relation"),
        ),
    ]
