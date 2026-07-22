import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("compat", "0006_videogenerationjob_videogenerationsegment_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="videogenerationsegment",
            name="storage_attempts",
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="playback_id",
            field=models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, unique=True),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="stored_path",
            field=models.TextField(blank=True),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="content_type",
            field=models.CharField(blank=True, max_length=120),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="file_size",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="sha256",
            field=models.CharField(blank=True, max_length=64),
        ),
    ]
