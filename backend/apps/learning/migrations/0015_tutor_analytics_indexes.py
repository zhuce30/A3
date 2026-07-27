from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("learning", "0014_tutor_persona_operations"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="coachingsession",
            index=models.Index(fields=["started_at"], name="idx_coach_started_at"),
        ),
    ]
