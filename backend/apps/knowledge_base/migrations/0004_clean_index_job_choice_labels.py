from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("knowledge_base", "0003_multimodal_blocks"),
    ]

    operations = [
        migrations.AlterField(
            model_name="knowledgeindexjob",
            name="job_type",
            field=models.CharField(choices=[("upload", "upload"), ("rebuild", "rebuild")], max_length=16),
        ),
        migrations.AlterField(
            model_name="knowledgeindexjob",
            name="status",
            field=models.CharField(
                choices=[
                    ("queued", "queued"),
                    ("running", "running"),
                    ("succeeded", "succeeded"),
                    ("failed", "failed"),
                ],
                default="queued",
                max_length=16,
            ),
        ),
    ]
