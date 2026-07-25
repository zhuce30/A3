from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("knowledge_base", "0011_curated_learning_resource"),
    ]

    operations = [
        migrations.AlterField(
            model_name="knowledgeindexjob",
            name="status",
            field=models.CharField(
                choices=[
                    ("queued", "queued"),
                    ("running", "running"),
                    ("succeeded", "succeeded"),
                    ("failed", "failed"),
                    ("cancelled", "cancelled"),
                ],
                default="queued",
                max_length=16,
            ),
        ),
    ]
