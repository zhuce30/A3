import importlib
import importlib.util
import json
from unittest.mock import patch

from django.core.management import call_command
from django.db import InterfaceError
from django.test import TransactionTestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat.models import ResourceGenerationJob
from backend.apps.learning.models import ResourcePackLog
from backend.apps.profiles.models import LearnerProfile
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult


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
        generate.assert_called_once()
        call_args, call_kwargs = generate.call_args
        self.assertEqual(call_args, (self.user,))
        self.assertEqual(call_kwargs["goal"], "生成操作系统思维导图")
        self.assertEqual(call_kwargs["top_k"], 3)
        self.assertEqual(call_kwargs["resource_type"], "mind_map")
        # 逐 Agent 实时进度依赖任务传入 on_step 回调。
        self.assertTrue(callable(call_kwargs["on_step"]))

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

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_cancelled_task_is_not_started_by_late_worker_delivery(self, generate):
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-task-cancelled-before-start",
            user=self.user,
            status="cancelled",
            stage="cancelled",
            progress=100,
            message="任务已取消",
            finished_at=timezone.now(),
        )

        result = self._load_task().run(job.job_id)

        job.refresh_from_db()
        self.assertEqual(result, {})
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.stage, "cancelled")
        generate.assert_not_called()

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_running_task_does_not_overwrite_concurrent_cancellation(self, generate):
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-task-cancelled-during-agent",
            user=self.user,
            goal="生成案例拆解",
            resource_type="case_study",
        )

        def cancel_during_generation(*_args, **kwargs):
            ResourceGenerationJob.objects.filter(pk=job.pk).update(
                status="cancelled",
                stage="cancelled",
                progress=100,
                message="任务已取消",
                finished_at=timezone.now(),
            )
            kwargs["on_step"](
                {"order": 1, "total": 1, "name": "RetrieverAgent", "phase": "started"}
            )

        generate.side_effect = cancel_during_generation

        result = self._load_task().run(job.job_id)

        job.refresh_from_db()
        self.assertTrue(result["cancelled"])
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.stage, "cancelled")
        self.assertEqual(job.progress, 100)

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_generation_failure_does_not_overwrite_concurrent_cancellation(self, generate):
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-task-cancelled-before-failure-write",
            user=self.user,
            goal="生成案例拆解",
            resource_type="case_study",
        )

        def cancel_then_fail(*_args, **_kwargs):
            ResourceGenerationJob.objects.filter(pk=job.pk).update(
                status="cancelled",
                stage="cancelled",
                progress=100,
                message="任务已取消",
                finished_at=timezone.now(),
            )
            raise RuntimeError("上游调用已中止")

        generate.side_effect = cancel_then_fail

        result = self._load_task().run(job.job_id)

        job.refresh_from_db()
        self.assertTrue(result["cancelled"])
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.stage, "cancelled")

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_task_reconnects_before_persisting_failure_after_database_disconnect(self, generate):
        generate.side_effect = InterfaceError(0, "")
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-task-db-disconnect-001",
            user=self.user,
            goal="生成思维导图",
            top_k=3,
            resource_type="mind_map",
        )
        original_save = ResourceGenerationJob.save
        failed_save_attempts = 0

        def fail_first_failure_write(instance, *args, **kwargs):
            nonlocal failed_save_attempts
            if instance.pk == job.pk and instance.status == "failed" and failed_save_attempts == 0:
                failed_save_attempts += 1
                raise InterfaceError(0, "")
            return original_save(instance, *args, **kwargs)

        with patch.object(ResourceGenerationJob, "save", new=fail_first_failure_write):
            result = self._load_task().run(job.job_id)

        job.refresh_from_db()
        self.assertEqual(result["success"], False)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.stage, "failed")
        self.assertEqual(job.progress, 100)
        self.assertEqual(failed_save_attempts, 1)
        self.assertEqual(job.error_message, "数据库连接暂时中断，请重新生成资源。")

    def test_resource_profile_snapshot_does_not_embed_profile_history(self):
        from backend.apps.compat.resource_generation import _profile_snapshot

        profile = LearnerProfile.objects.create(
            user=self.user,
            grade="大二",
            major_direction="计算机科学与技术",
            foundation_level="基础一般",
            daily_study_time=45,
            learning_goals=["掌握操作系统"],
            weak_points=["死锁"],
            expected_resources=["案例拆解"],
            extra_profile={
                "resourcePacks": [
                    {
                        "resourcePackId": "old-pack",
                        "learnerProfileSnapshot": {
                            "extraProfile": {"resourcePacks": [{"content": "x" * 20000}]},
                        },
                    },
                ],
                "agentRuns": [{"traceId": "old-trace", "content": "y" * 20000}],
            },
        )

        snapshot = _profile_snapshot(profile)

        self.assertNotIn("extraProfile", snapshot)
        self.assertEqual(snapshot["grade"], "大二")
        self.assertEqual(snapshot["weakPoints"], ["死锁"])
        self.assertEqual(snapshot["expectedResources"], ["案例拆解"])
        self.assertLess(len(json.dumps(snapshot, ensure_ascii=False).encode("utf-8")), 10_000)

    def test_compacting_stored_resource_pack_removes_recursive_profile_history(self):
        from backend.apps.compat.resource_generation import compact_resource_pack_payload

        pack = {
            "resourcePackId": "pack-001",
            "resources": [{"type": "case_study", "content": {"title": "死锁案例"}}],
            "learnerProfileSnapshot": {
                "grade": "大二",
                "weakPoints": ["死锁"],
                "extraProfile": {
                    "resourcePacks": [{"resourcePackId": "nested-pack", "content": "x" * 20000}],
                    "agentRuns": [{"traceId": "nested-trace"}],
                },
            },
        }
        compacted = compact_resource_pack_payload(pack)

        self.assertEqual(compacted["resourcePackId"], "pack-001")
        self.assertEqual(compacted["resources"], pack["resources"])
        self.assertEqual(compacted["learnerProfileSnapshot"]["grade"], "大二")
        self.assertNotIn("extraProfile", compacted["learnerProfileSnapshot"])
        self.assertLess(len(json.dumps(compacted, ensure_ascii=False).encode("utf-8")), 10_000)

    def test_compaction_command_updates_profile_and_resource_log_payloads(self):
        pack = {
            "resourcePackId": "pack-command-001",
            "resources": [{"type": "case_study", "content": {"title": "死锁案例"}}],
            "learnerProfileSnapshot": {
                "grade": "大二",
                "extraProfile": {"resourcePacks": [{"content": "x" * 20000}]},
            },
        }
        profile = LearnerProfile.objects.create(
            user=self.user,
            extra_profile={"resourcePacks": [pack], "unrelated": {"keep": True}},
        )
        log = ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:pack-command-001",
            learning_goal="死锁",
            source="resource_generation",
            payload=pack,
        )

        call_command("compact_resource_pack_storage", user_id=self.user.id)

        profile.refresh_from_db()
        log.refresh_from_db()
        stored_pack = profile.extra_profile["resourcePacks"][0]
        self.assertNotIn("extraProfile", stored_pack["learnerProfileSnapshot"])
        self.assertEqual(stored_pack["resources"], pack["resources"])
        self.assertTrue(profile.extra_profile["unrelated"]["keep"])
        self.assertNotIn("extraProfile", log.payload["learnerProfileSnapshot"])
        self.assertEqual(log.payload["resources"], pack["resources"])

    def test_resource_task_has_bounded_execution_and_does_not_requeue_worker_loss(self):
        task = self._load_task()

        self.assertTrue(task.acks_late)
        self.assertFalse(task.reject_on_worker_lost)
        self.assertEqual(task.soft_time_limit, 1200)
        self.assertEqual(task.time_limit, 1320)

    @patch("backend.apps.compat.resource_generation.search_knowledge_base")
    def test_resource_source_search_filters_to_accessible_paths(self, search):
        from backend.apps.compat.resource_generation import _search_resource_sources

        search.return_value = [
            KnowledgeBaseSearchResult(
                score=0.91,
                text="死锁的四个必要条件",
                metadata={"title": "操作系统讲义", "source_path": "D:/kb/os.pdf"},
            )
        ]
        scope_by_path = {"D:/kb/os.pdf": "teacher"}

        sources = _search_resource_sources(
            "死锁",
            top_k=3,
            fallback_sources=[],
            source_scope_by_path=scope_by_path,
        )

        search.assert_called_once_with(
            query="死锁",
            top_k=3,
            allowed_source_paths=set(scope_by_path),
            source_scope_by_path=scope_by_path,
        )
        self.assertEqual(sources[0]["title"], "操作系统讲义")
        self.assertEqual(sources[0]["location"], "操作系统讲义")
        self.assertNotIn("D:/", sources[0]["location"])

    @patch("backend.apps.compat.resource_generation.search_knowledge_base")
    def test_resource_source_search_does_not_scan_all_resources_when_scope_is_empty(self, search):
        from backend.apps.compat.resource_generation import _search_resource_sources

        sources = _search_resource_sources(
            "死锁",
            top_k=3,
            fallback_sources=[],
            source_scope_by_path={},
        )

        search.assert_not_called()
        self.assertEqual(sources[0]["id"], "learning-state")
