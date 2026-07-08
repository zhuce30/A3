from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("knowledge_base", "0004_clean_index_job_choice_labels"),
    ]

    operations = [
        migrations.AddField(
            model_name="knowledgeresource",
            name="resource_scope",
            field=models.CharField(
                choices=[
                    ("personal", "personal"),
                    ("teacher", "teacher"),
                    ("class", "class"),
                    ("global", "global"),
                ],
                default="teacher",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="knowledgeresource",
            name="course_key",
            field=models.CharField(blank=True, max_length=128),
        ),
        migrations.AddField(
            model_name="knowledgeresource",
            name="visibility",
            field=models.CharField(default="owner", max_length=32),
        ),
        migrations.AddField(
            model_name="knowledgeresource",
            name="student_profile_snapshot",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
