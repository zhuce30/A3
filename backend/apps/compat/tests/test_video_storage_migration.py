from __future__ import annotations

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class VideoStorageMigrationTests(TransactionTestCase):
    migrate_from = ("compat", "0006_videogenerationjob_videogenerationsegment_and_more")
    migrate_to = ("compat", "0007_video_segment_persistent_storage")

    def setUp(self):
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        old_apps = executor.loader.project_state([self.migrate_from]).apps
        user_model = old_apps.get_model("accounts", "User")
        job_model = old_apps.get_model("compat", "VideoGenerationJob")
        segment_model = old_apps.get_model("compat", "VideoGenerationSegment")
        user = user_model.objects.create(phone="13800009103", password="unused")
        job = job_model.objects.create(
            job_id="migration-video-job",
            user_id=user.id,
            resource_pack_id="migration-pack",
        )
        for index in (1, 2, 3):
            segment_model.objects.create(
                job_id=job.id,
                index=index,
                title=f"Segment {index}",
                prompt=f"Migration test {index}",
            )

        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        self.apps = executor.loader.project_state([self.migrate_to]).apps

    def test_existing_segments_receive_distinct_playback_ids(self):
        segment_model = self.apps.get_model("compat", "VideoGenerationSegment")
        playback_ids = list(
            segment_model.objects.order_by("index").values_list("playback_id", flat=True)
        )

        self.assertEqual(len(playback_ids), 3)
        self.assertNotIn(None, playback_ids)
        self.assertEqual(len(set(playback_ids)), 3)
