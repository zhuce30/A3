import django.core.validators
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


DEFAULT_ASSET_ID = "teacher-default-v1"
PERSONA_IDS = (
    "structured-teacher",
    "socratic-guide",
    "practice-coach",
    "foundation-coach",
)


def seed_tutor_persona_operations(apps, schema_editor):
    TutorAvatarAsset = apps.get_model("learning", "TutorAvatarAsset")
    TutorPersonaConfiguration = apps.get_model("learning", "TutorPersonaConfiguration")

    asset = TutorAvatarAsset.objects.create(
        asset_id=DEFAULT_ASSET_ID,
        display_name="默认教师数字人",
        public_path="/a3/assets/teacher-avatar/teacher.vrm",
        thumbnail_path="",
        author="",
        source_name="",
        source_url="",
        license_name="",
        license_url="",
        usage_scope=[],
        sha256="1b94e3e82b181db1dba503fa2ab97f54574a52e2e6d6ced2db8ed20a7e1c9af4",
        file_size_bytes=16_496_824,
        status="enabled",
        is_default=True,
        default_slot="default",
        metadata={
            "licenseStatus": "incomplete",
            "legacyCompatibility": True,
        },
    )
    TutorPersonaConfiguration.objects.bulk_create(
        [TutorPersonaConfiguration(persona_id=persona_id, avatar_asset=asset) for persona_id in PERSONA_IDS]
    )


class Migration(migrations.Migration):
    dependencies = [
        ("learning", "0013_learning_report_indexes"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="TutorAvatarAsset",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("asset_id", models.CharField(max_length=64, unique=True)),
                ("display_name", models.CharField(max_length=120)),
                ("public_path", models.CharField(max_length=255)),
                ("thumbnail_path", models.CharField(blank=True, max_length=255)),
                ("author", models.CharField(blank=True, max_length=120)),
                ("source_name", models.CharField(blank=True, max_length=120)),
                ("source_url", models.URLField(blank=True)),
                ("license_name", models.CharField(blank=True, max_length=120)),
                ("license_url", models.URLField(blank=True)),
                ("usage_scope", models.JSONField(blank=True, default=list)),
                ("sha256", models.CharField(max_length=64)),
                ("file_size_bytes", models.PositiveBigIntegerField()),
                (
                    "status",
                    models.CharField(
                        choices=[("draft", "草稿"), ("enabled", "启用"), ("disabled", "停用")],
                        default="draft",
                        max_length=16,
                    ),
                ),
                ("is_default", models.BooleanField(default=False)),
                ("default_slot", models.CharField(editable=False, max_length=7, null=True, unique=True)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "a3_tutor_avatar_assets",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("default_slot", "default"),
                                ("default_slot__isnull", False),
                                ("is_default", True),
                            ),
                            models.Q(("default_slot__isnull", True), ("is_default", False)),
                            _connector="OR",
                        ),
                        name="tutor_avatar_default_slot_consistent",
                    )
                ],
            },
        ),
        migrations.CreateModel(
            name="TutorPersonaConfiguration",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("persona_id", models.CharField(max_length=64, unique=True)),
                ("enabled", models.BooleanField(default=True)),
                ("voice_preview_enabled", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "avatar_asset",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="persona_configurations",
                        to="learning.tutoravatarasset",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="updated_tutor_personas",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "a3_tutor_persona_configurations"},
        ),
        migrations.CreateModel(
            name="TutorPersonaFeedback",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("persona_id", models.CharField(max_length=64)),
                (
                    "rating",
                    models.PositiveSmallIntegerField(
                        validators=[
                            django.core.validators.MinValueValidator(1),
                            django.core.validators.MaxValueValidator(5),
                        ]
                    ),
                ),
                ("tags", models.JSONField(blank=True, default=list)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="tutor_feedback",
                        to="learning.coachingsession",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="tutor_persona_feedback",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "a3_tutor_persona_feedback",
                "indexes": [
                    models.Index(fields=["persona_id", "-created_at"], name="idx_tutor_feedback_persona")
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("user", "session"),
                        name="unique_user_session_tutor_feedback",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("rating__gte", 1), ("rating__lte", 5)),
                        name="tutor_feedback_rating_1_5",
                    ),
                ],
            },
        ),
        migrations.RunPython(seed_tutor_persona_operations, migrations.RunPython.noop),
    ]
