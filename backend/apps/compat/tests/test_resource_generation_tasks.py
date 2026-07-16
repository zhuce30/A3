import importlib
import importlib.util
from unittest.mock import patch

from django.test import TransactionTestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat.models import ResourceGenerationJob


class ResourceGenerationTaskTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13900001234",
            password="test-password",
        )

    def _load_task(self):
        spec = importlib.util.find_spec("backend.apps.compat.tasks")
        self.assertIsNotNone(spec, "compat Celery task module must exist")
        return importlib.import_module("backend.apps.compat.tasks").run_resource_generation_job

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_task_persists_successful_resource_pack(self, generate):
        generate.return_value = {
            "success": True,
            "traceId": "trace-resource-task-001",
            "resourcePack": {
                "resourcePackId": "pack-resource-task-001",
                "traceId": "trace-resource-task-001",
                "resources": [{"type": "mind_map"}],
            },
        }
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-task-success-001",
            user=self.user,
            goal="生成操作系统思维导图",
            top_k=3,
            resource_type="mind_map",
        )

        self._load_task().run(job.job_id)

        job.refresh_from_db()
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(job.stage, "completed")
        self.assertEqual(job.progress, 100)
        self.assertEqual(job.resource_pack_id, "pack-resource-task-001")
        self.assertEqual(job.trace_id, "trace-resource-task-001")
        self.assertEqual(job.result["resourcePack"]["resources"][0]["type"], "mind_map")
        self.assertIsNotNone(job.started_at)
        self.assertIsNotNone(job.finished_at)
        generate.assert_called_once_with(
            self.user,
            goal="生成操作系统思维导图",
            top_k=3,
            resource_type="mind_map",
        )

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_task_persists_readable_failure(self, generate):
        generate.side_effect = RuntimeError("模型服务暂时不可用")
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-task-failed-001",
            user=self.user,
            goal="生成思维导图",
            top_k=3,
            resource_type="mind_map",
            started_at=timezone.now(),
        )

        self._load_task().run(job.job_id)

        job.refresh_from_db()
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.stage, "failed")
        self.assertEqual(job.progress, 100)
        self.assertIn("模型服务暂时不可用", job.message)
        self.assertIn("模型服务暂时不可用", job.error_message)
        self.assertIsNotNone(job.finished_at)
