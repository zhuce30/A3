from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("knowledge_base", "0009_add_wiki_index_job_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="knowledgeindexjob",
            name="progress_detail",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
