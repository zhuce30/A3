from django.db import migrations, models


def clear_untouched_profile_defaults(apps, schema_editor):
    LearnerProfile = apps.get_model("profiles", "LearnerProfile")
    candidates = LearnerProfile.objects.filter(
        user__profile_completed=False,
        grade="",
        major_direction="",
        foundation_level="",
        daily_study_time=60,
        pace="standard",
    )
    for profile in candidates.iterator():
        if (
            not profile.learning_goals
            and not profile.weak_points
            and not profile.learning_preferences
            and not profile.expected_resources
        ):
            profile.daily_study_time = 0
            profile.pace = ""
            profile.save(update_fields=["daily_study_time", "pace"])


class Migration(migrations.Migration):
    dependencies = [
        ("profiles", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="learnerprofile",
            name="daily_study_time",
            field=models.PositiveSmallIntegerField(default=0, verbose_name="每日学习时长"),
        ),
        migrations.AlterField(
            model_name="learnerprofile",
            name="pace",
            field=models.CharField(
                blank=True,
                choices=[("relaxed", "稳扎稳打"), ("standard", "标准节奏"), ("intensive", "强化提升")],
                default="",
                max_length=32,
                verbose_name="学习节奏",
            ),
        ),
        migrations.RunPython(clear_untouched_profile_defaults, migrations.RunPython.noop),
    ]
