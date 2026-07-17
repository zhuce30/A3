from django.db import models
from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.learning.models import ResourcePackLog


class ResourcePackLogModelTests(TestCase):
    def test_defines_user_completion_report_index(self):
        indexes = {index.name: tuple(index.fields) for index in ResourcePackLog._meta.indexes}

        self.assertEqual(indexes.get("a3_pack_user_done_idx"), ("user", "completed_at"))

    def test_practice_href_accepts_long_generated_links(self):
        user = User.objects.create_user(phone="13800009991", password="TestPassword123")
        long_href = "/a3/assessment?practice=" + "root-locus-frequency-response-" * 20

        field = ResourcePackLog._meta.get_field("practice_href")
        self.assertIsInstance(field, models.TextField)

        log = ResourcePackLog.objects.create(
            user=user,
            task_id="resource-pack:long-practice-href",
            task_title="长链接资源包",
            learning_goal="根轨迹与频率响应综合练习",
            practice_href=long_href,
        )

        log.refresh_from_db()
        self.assertEqual(log.practice_href, long_href)
