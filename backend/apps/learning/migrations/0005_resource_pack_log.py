from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone
import uuid


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("learning", "0004_seed_default_teacher_assignments"),
    ]

    operations = [
        migrations.CreateModel(
            name="ResourcePackLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("task_id", models.CharField(max_length=160)),
                ("task_title", models.CharField(blank=True, max_length=160)),
                ("learning_goal", models.CharField(max_length=160)),
                ("verified_source_count", models.PositiveIntegerField(default=0)),
                ("confidence", models.CharField(default="medium", max_length=32)),
                ("practice_href", models.CharField(default="/a3/assessment", max_length=255)),
                ("source", models.CharField(default="study_plan_completion", max_length=64)),
                ("next_step_reason", models.TextField(blank=True)),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("completed_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="resource_pack_logs", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "a3_resource_pack_logs",
                "ordering": ["-completed_at", "-created_at"],
            },
        ),
        migrations.AddConstraint(
            model_name="resourcepacklog",
            constraint=models.UniqueConstraint(fields=("user", "task_id"), name="unique_user_resource_pack_task"),
        ),
    ]
