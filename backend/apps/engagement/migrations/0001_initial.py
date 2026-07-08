from __future__ import annotations

import uuid

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
            name="UserFavorite",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("title", models.CharField(max_length=160)),
                (
                    "resource_type",
                    models.CharField(
                        choices=[
                            ("video", "视频"),
                            ("courseware", "课件"),
                            ("knowledge_card", "知识卡片"),
                            ("exercise", "练习"),
                            ("note", "笔记"),
                        ],
                        max_length=24,
                    ),
                ),
                ("source", models.CharField(blank=True, max_length=120)),
                ("url", models.CharField(blank=True, max_length=500)),
                ("group", models.CharField(default="默认收藏夹", max_length=64)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="favorites", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "a3_user_favorites",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="UserNotification",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("title", models.CharField(max_length=160)),
                ("detail", models.TextField()),
                (
                    "notification_type",
                    models.CharField(
                        choices=[
                            ("learning_task", "学习任务"),
                            ("assessment", "测评反馈"),
                            ("knowledge_base", "知识库"),
                            ("system", "系统通知"),
                            ("teacher", "教师提醒"),
                        ],
                        default="system",
                        max_length=24,
                    ),
                ),
                ("unread", models.BooleanField(default=True)),
                ("action_url", models.CharField(blank=True, max_length=500)),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("read_at", models.DateTimeField(blank=True, null=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="notifications", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "a3_user_notifications",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="userfavorite",
            index=models.Index(fields=["user", "resource_type"], name="a3_user_fa_user_id_33755b_idx"),
        ),
        migrations.AddIndex(
            model_name="userfavorite",
            index=models.Index(fields=["user", "group"], name="a3_user_fa_user_id_64db81_idx"),
        ),
        migrations.AddConstraint(
            model_name="userfavorite",
            constraint=models.UniqueConstraint(fields=("user", "title", "resource_type", "source"), name="uniq_a3_user_favorite_source"),
        ),
        migrations.AddIndex(
            model_name="usernotification",
            index=models.Index(fields=["user", "unread", "-created_at"], name="a3_user_no_user_id_3c273c_idx"),
        ),
        migrations.AddIndex(
            model_name="usernotification",
            index=models.Index(fields=["user", "notification_type"], name="a3_user_no_user_id_8a56d2_idx"),
        ),
    ]

