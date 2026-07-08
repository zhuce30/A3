from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AgentRun",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("trace_id", models.CharField(db_index=True, max_length=64, unique=True)),
                ("schema_version", models.CharField(default="a3.agent-run.v1", max_length=32)),
                ("workflow", models.CharField(max_length=80)),
                ("goal", models.CharField(blank=True, max_length=255)),
                ("status", models.CharField(default="running", max_length=32)),
                ("fallback_strategy", models.CharField(default="none", max_length=80)),
                ("latency_ms", models.PositiveIntegerField(default=1)),
                ("started_at", models.DateTimeField()),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="a3_agent_runs",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "a3_agent_runs",
                "ordering": ["-started_at", "-id"],
            },
        ),
        migrations.CreateModel(
            name="AgentStep",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("order", models.PositiveSmallIntegerField()),
                ("name", models.CharField(max_length=80)),
                ("role", models.CharField(blank=True, max_length=80)),
                ("status", models.CharField(default="completed", max_length=32)),
                ("detail", models.TextField(blank=True)),
                ("latency_ms", models.PositiveIntegerField(default=1)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="steps",
                        to="compat.agentrun",
                    ),
                ),
            ],
            options={
                "db_table": "a3_agent_steps",
                "ordering": ["order", "id"],
            },
        ),
        migrations.AddIndex(
            model_name="agentrun",
            index=models.Index(fields=["user", "-started_at"], name="a3_agent_run_user_started_idx"),
        ),
        migrations.AddIndex(
            model_name="agentrun",
            index=models.Index(fields=["workflow", "status"], name="a3_agent_run_flow_status_idx"),
        ),
        migrations.AddConstraint(
            model_name="agentstep",
            constraint=models.UniqueConstraint(fields=("run", "order"), name="a3_agent_step_run_order_unique"),
        ),
    ]
