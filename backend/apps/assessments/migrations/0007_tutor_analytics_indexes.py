from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("assessments", "0006_wrongquestion_report_time_index"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="assessmentsession",
            index=models.Index(
                fields=["user", "status", "completed_at"],
                name="a3_asmt_user_stat_done_idx",
            ),
        ),
    ]
