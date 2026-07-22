import uuid

from django.db import migrations, models


def populate_playback_ids(apps, schema_editor):
    segment_model = apps.get_model("compat", "VideoGenerationSegment")
    missing_ids = segment_model.objects.filter(playback_id__isnull=True).values_list(
        "id", flat=True
    )
    for segment_id in missing_ids.iterator():
        segment_model.objects.filter(id=segment_id).update(playback_id=uuid.uuid4())


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
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.RunPython(populate_playback_ids, migrations.RunPython.noop),
        migrations.AlterField(
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
