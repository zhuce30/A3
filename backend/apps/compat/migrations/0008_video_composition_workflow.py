import uuid

import django.db.models.deletion
from django.db import migrations, models


def populate_audio_playback_ids(apps, schema_editor):
    segment_model = apps.get_model("compat", "VideoGenerationSegment")
    batch_size = 500
    batch = []
    missing_segments = segment_model.objects.filter(audio_playback_id__isnull=True).only("id")
    for segment in missing_segments.iterator(chunk_size=batch_size):
        segment.audio_playback_id = uuid.uuid4()
        batch.append(segment)
        if len(batch) == batch_size:
            segment_model.objects.bulk_update(
                batch,
                ["audio_playback_id"],
                batch_size=batch_size,
            )
            batch.clear()
    if batch:
        segment_model.objects.bulk_update(
            batch,
            ["audio_playback_id"],
            batch_size=batch_size,
        )


class Migration(migrations.Migration):
    dependencies = [
        ("compat", "0007_video_segment_persistent_storage"),
    ]

    operations = [
        migrations.AddField(
            model_name="videogenerationsegment",
            name="visual",
            field=models.TextField(blank=True),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="narration",
            field=models.TextField(blank=True),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="source_ids",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="narration_estimated_ms",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="narration_fits",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_status",
            field=models.CharField(default="pending", max_length=32),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_path",
            field=models.TextField(blank=True),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_content_type",
            field=models.CharField(blank=True, max_length=120),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_file_size",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_sha256",
            field=models.CharField(blank=True, max_length=64),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_duration_ms",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="videogenerationsegment",
            name="audio_playback_id",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.RunPython(populate_audio_playback_ids, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="videogenerationsegment",
            name="audio_playback_id",
            field=models.UUIDField(
                default=uuid.uuid4,
                editable=False,
                unique=True,
            ),
        ),
        migrations.CreateModel(
            name="VideoComposition",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("status", models.CharField(default="draft", max_length=32)),
                ("stage", models.CharField(default="storyboard", max_length=40)),
                ("progress", models.PositiveSmallIntegerField(default=0)),
                ("message", models.CharField(blank=True, max_length=255)),
                ("tts_provider", models.CharField(default="qwen-tts", max_length=40)),
                ("tts_model", models.CharField(default="qwen3-tts-flash", max_length=80)),
                ("voice", models.CharField(default="Cherry", max_length=80)),
                ("speed", models.FloatField(default=1.0)),
                ("narration_text", models.TextField(blank=True)),
                ("subtitles_path", models.TextField(blank=True)),
                ("final_video_path", models.TextField(blank=True)),
                ("final_content_type", models.CharField(blank=True, max_length=120)),
                ("final_file_size", models.PositiveBigIntegerField(default=0)),
                ("final_sha256", models.CharField(blank=True, max_length=64)),
                (
                    "playback_id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        unique=True,
                    ),
                ),
                ("celery_task_id", models.CharField(blank=True, max_length=64)),
                ("narration_attempts", models.PositiveSmallIntegerField(default=0)),
                ("compose_attempts", models.PositiveSmallIntegerField(default=0)),
                ("error_code", models.CharField(blank=True, max_length=80)),
                ("error_message", models.TextField(blank=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "job",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="composition",
                        to="compat.videogenerationjob",
                    ),
                ),
            ],
            options={
                "db_table": "a3_video_compositions",
                "ordering": ["-created_at", "-id"],
            },
        ),
        migrations.AddIndex(
            model_name="videocomposition",
            index=models.Index(
                fields=["status", "updated_at"],
                name="a3_vidcomp_status_update_idx",
            ),
        ),
    ]
