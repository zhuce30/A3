from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("assessments", "0005_assessmentanswer_report_index"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="wrongquestion",
            index=models.Index(
                fields=["user", "-last_wrong_at"],
                name="a3_wrong_user_time_idx",
            ),
        ),
    ]
