import json
from unittest.mock import patch

from django.db import connection
from django.test import Client, TestCase, override_settings

from backend.apps.accounts.models import User, UserRole
from backend.apps.compat.models import (
    ResourceGenerationJob,
    VideoComposition,
    VideoGenerationJob,
    VideoGenerationSegment,
)
from backend.apps.knowledge_base.models import (
    IndexJobStatus,
    IndexJobType,
    KnowledgeIndexJob,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.knowledge_base.services import accessible_resources_for_user
from backend.apps.learning.models import Course
from backend.apps.system.models import AdminAuditLog, SecurityEvent


class AdminActionApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_user(
            phone="admin-actions",
            password="password123",
            role=UserRole.ADMIN,
            display_name="系统管理员",
        )
        self.teacher = User.objects.create_user(
            phone="teacher-actions",
            password="password123",
            role=UserRole.TEACHER,
            display_name="课程教师",
        )
        self.student = User.objects.create_user(
            phone="student-actions",
            password="password123",
            role=UserRole.STUDENT,
            display_name="测试学生",
        )
        self.course = Course.objects.create(code="ADMIN-101", title="管理测试课程")
        self.resource = KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="控制原理讲义.pdf",
            stored_path="relative/control.pdf",
            file_type="pdf",
            resource_scope=ResourceScope.TEACHER,
            visibility="owner",
            status=ResourceStatus.INDEXED,
        )
        self.client.force_login(self.admin)

    def post_json(self, path, body):
        return self.client.post(path, data=json.dumps(body, ensure_ascii=False), content_type="application/json")

    def assert_audit(self, *, action, target_id, reason, success):
        audit = AdminAuditLog.objects.filter(action=action).latest("id")
        self.assertEqual(audit.actor, self.admin)
        self.assertEqual(audit.target_id, str(target_id))
        self.assertEqual(audit.reason, reason)
        self.assertEqual(audit.success, success)
        serialized = json.dumps(
            {"before": audit.before, "after": audit.after, "metadata": audit.metadata},
            ensure_ascii=False,
        ).lower()
        for forbidden in ("password", "token", "secret", "stored_path", "celery_task_id"):
            self.assertNotIn(forbidden, serialized)
        return audit

    def test_course_status_transition_requires_reason_and_is_audited(self):
        route = f"/api/admin/catalog/courses/{self.course.pk}/status/"

        response = self.post_json(route, {"isActive": False, "reason": "课程内容正在修订"})

        self.assertEqual(response.status_code, 200)
        self.course.refresh_from_db()
        self.assertFalse(self.course.is_active)
        audit = self.assert_audit(
            action="course.deactivate",
            target_id=self.course.pk,
            reason="课程内容正在修订",
            success=True,
        )
        self.assertEqual(audit.before, {"isActive": True})
        self.assertEqual(audit.after, {"isActive": False})

        failed = self.post_json(route, {"isActive": True, "reason": ""})
        self.assertEqual(failed.status_code, 400)
        self.assertTrue(failed.json()["error"])
        self.assert_audit(action="course.status", target_id=self.course.pk, reason="", success=False)

        sensitive = self.post_json(
            route,
            {"isActive": True, "reason": "token=admin-secret D:\\private\\config.txt"},
        )
        self.assertEqual(sensitive.status_code, 400)
        sensitive_audit = AdminAuditLog.objects.filter(action="course.status").latest("id")
        self.assertEqual(sensitive_audit.reason, "敏感内容已隐藏")
        self.assertNotIn("admin-secret", json.dumps(sensitive_audit.metadata, ensure_ascii=False))

        activated = self.post_json(route, {"status": "active", "reason": "课程修订已经完成"})
        self.assertEqual(activated.status_code, 200)
        self.course.refresh_from_db()
        self.assertTrue(self.course.is_active)
        self.assert_audit(
            action="course.activate",
            target_id=self.course.pk,
            reason="课程修订已经完成",
            success=True,
        )

    def test_resource_publish_and_offline_change_actual_accessibility(self):
        route = f"/api/admin/catalog/resources/{self.resource.pk}/status/"
        self.assertFalse(accessible_resources_for_user(self.student).filter(pk=self.resource.pk).exists())

        published = self.post_json(route, {"status": "published", "reason": "讲义已通过课程审核"})

        self.assertEqual(published.status_code, 200)
        self.resource.refresh_from_db()
        self.assertEqual(self.resource.visibility, "shared")
        self.assertTrue(accessible_resources_for_user(self.student).filter(pk=self.resource.pk).exists())
        self.assert_audit(
            action="resource.publish",
            target_id=self.resource.pk,
            reason="讲义已通过课程审核",
            success=True,
        )

        offline = self.post_json(route, {"status": "offline", "reason": "资料需要重新复核"})

        self.assertEqual(offline.status_code, 200)
        self.resource.refresh_from_db()
        self.assertEqual(self.resource.visibility, "offline")
        self.assertFalse(accessible_resources_for_user(self.student).filter(pk=self.resource.pk).exists())
        self.assert_audit(
            action="resource.offline",
            target_id=self.resource.pk,
            reason="资料需要重新复核",
            success=True,
        )

    def test_resource_catalog_publication_status_uses_visibility_allowlist(self):
        shared = KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="shared.pdf",
            stored_path="relative/shared.pdf",
            file_type="pdf",
            resource_scope=ResourceScope.TEACHER,
            visibility="shared",
            status=ResourceStatus.INDEXED,
        )
        offline = KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="offline.pdf",
            stored_path="relative/offline.pdf",
            file_type="pdf",
            resource_scope=ResourceScope.TEACHER,
            visibility="offline",
            status=ResourceStatus.INDEXED,
        )

        all_response = self.client.get("/api/admin/catalog/resources/?page=1&pageSize=20")
        published_response = self.client.get(
            "/api/admin/catalog/resources/?page=1&pageSize=20&status=published"
        )

        self.assertEqual(all_response.status_code, 200)
        statuses = {item["id"]: item["publicationStatus"] for item in all_response.json()["items"]}
        self.assertEqual(statuses[str(self.resource.pk)], "owner_only")
        self.assertEqual(statuses[str(shared.pk)], "published")
        self.assertEqual(statuses[str(offline.pk)], "offline")
        published_ids = {item["id"] for item in published_response.json()["items"]}
        self.assertEqual(published_ids, {str(shared.pk)})

    @patch("backend.apps.knowledge_base.tasks.run_index_job.delay")
    def test_resource_reindex_reuses_real_dispatch_and_audits(self, delay):
        atomic_depth = len(connection.atomic_blocks)

        def assert_state_committed(job_id):
            self.assertEqual(len(connection.atomic_blocks), atomic_depth)
            job = KnowledgeIndexJob.objects.get(pk=job_id)
            self.resource.refresh_from_db()
            self.assertEqual(job.status, IndexJobStatus.QUEUED)
            self.assertEqual(self.resource.status, ResourceStatus.INDEXING)
            delay.return_value.id = "reindex-task-id"
            return delay.return_value

        delay.side_effect = assert_state_committed

        response = self.post_json(
            f"/api/admin/catalog/resources/{self.resource.pk}/reindex/",
            {"reason": "索引版本已升级"},
        )

        self.assertEqual(response.status_code, 202)
        self.resource.refresh_from_db()
        job = KnowledgeIndexJob.objects.get(pk=self.resource.index_job_id)
        self.assertEqual(job.job_type, IndexJobType.PARSE)
        self.assertEqual(job.status, IndexJobStatus.QUEUED)
        self.assertEqual(job.celery_task_id, "reindex-task-id")
        self.assertEqual(self.resource.status, ResourceStatus.INDEXING)
        delay.assert_called_once_with(str(job.pk))
        self.assert_audit(
            action="resource.reindex",
            target_id=self.resource.pk,
            reason="索引版本已升级",
            success=True,
        )

    @override_settings(DEBUG=False)
    @patch(
        "backend.apps.knowledge_base.tasks.run_index_job.delay",
        side_effect=RuntimeError("broker token=queue-secret D:\\private\\broker.ini"),
    )
    def test_resource_reindex_records_post_commit_dispatch_failure_without_leaking_error(self, delay):
        response = self.post_json(
            f"/api/admin/catalog/resources/{self.resource.pk}/reindex/",
            {"reason": "验证队列故障处理"},
        )

        self.assertEqual(response.status_code, 503)
        resource = KnowledgeResource.objects.get(pk=self.resource.pk)
        self.assertEqual(resource.status, ResourceStatus.FAILED)
        self.assertTrue(resource.error_message)
        job = KnowledgeIndexJob.objects.get(pk=resource.index_job_id)
        self.assertEqual(job.status, IndexJobStatus.FAILED)
        self.assertEqual(job.error_message, "索引任务调度失败，请稍后重试。")
        audits = AdminAuditLog.objects.filter(action="resource.reindex", target_id=str(self.resource.pk))
        self.assertEqual(audits.count(), 1)
        self.assertFalse(audits.get().success)
        self.assertEqual(audits.get().metadata, {"errorCode": "dispatch_failed"})
        catalog = self.client.get("/api/admin/catalog/resources/?page=1&pageSize=20")
        payload = json.dumps(catalog.json(), ensure_ascii=False).lower()
        self.assertNotIn("queue-secret", payload)
        self.assertNotIn("broker.ini", payload)
        self.assertNotIn("d:\\private", payload)

    @patch("backend.apps.knowledge_base.tasks.run_index_job.delay")
    def test_failed_supported_job_retries_but_resource_generation_does_not(self, delay):
        index_job = KnowledgeIndexJob.objects.create(
            owner=self.teacher,
            job_type=IndexJobType.PARSE,
            status=IndexJobStatus.FAILED,
            error_message="provider token=must-not-be-audited",
            celery_task_id="old-retry-task-id",
        )
        self.resource.index_job = index_job
        self.resource.status = ResourceStatus.FAILED
        self.resource.save(update_fields=["index_job", "status", "updated_at"])
        atomic_depth = len(connection.atomic_blocks)

        def assert_state_committed(job_id):
            self.assertEqual(len(connection.atomic_blocks), atomic_depth)
            queued_job = KnowledgeIndexJob.objects.get(pk=job_id)
            self.resource.refresh_from_db()
            self.assertEqual(queued_job.status, IndexJobStatus.QUEUED)
            self.assertEqual(queued_job.celery_task_id, "")
            self.assertEqual(self.resource.status, ResourceStatus.UPLOADED)
            delay.return_value.id = "retry-task-id"
            return delay.return_value

        delay.side_effect = assert_state_committed

        response = self.post_json(
            f"/api/admin/tasks/knowledge_index/{index_job.pk}/retry/",
            {"reason": "修复解析依赖后重试"},
        )

        self.assertEqual(response.status_code, 202)
        index_job.refresh_from_db()
        self.assertEqual(index_job.status, IndexJobStatus.QUEUED)
        self.assertEqual(index_job.celery_task_id, "retry-task-id")
        self.assert_audit(
            action="task.retry",
            target_id=index_job.pk,
            reason="修复解析依赖后重试",
            success=True,
        )

        unsupported = ResourceGenerationJob.objects.create(
            job_id="unsupported-resource-retry",
            user=self.student,
            status="failed",
        )
        failed = self.post_json(
            f"/api/admin/tasks/resource_generation/{unsupported.pk}/retry/",
            {"reason": "尝试重试"},
        )
        self.assertEqual(failed.status_code, 409)
        unsupported.refresh_from_db()
        self.assertEqual(unsupported.status, "failed")
        self.assert_audit(
            action="task.retry",
            target_id=unsupported.pk,
            reason="尝试重试",
            success=False,
        )

    @override_settings(DEBUG=False)
    @patch(
        "backend.apps.knowledge_base.tasks.run_index_job.delay",
        side_effect=RuntimeError("broker token=retry-secret D:\\private\\retry.ini"),
    )
    def test_failed_knowledge_retry_dispatch_writes_only_failure_audit(self, delay):
        index_job = KnowledgeIndexJob.objects.create(
            owner=self.teacher,
            job_type=IndexJobType.PARSE,
            status=IndexJobStatus.FAILED,
            error_message="previous failure",
            celery_task_id="stale-celery-task-id",
        )
        self.resource.index_job = index_job
        self.resource.status = ResourceStatus.FAILED
        self.resource.save(update_fields=["index_job", "status", "updated_at"])
        indexed_resource = KnowledgeResource.objects.create(
            owner=self.teacher,
            index_job=index_job,
            original_name="already-indexed.pdf",
            stored_path="D:\\fixtures\\already-indexed.pdf",
            file_type=".pdf",
            file_size=64,
            resource_scope=ResourceScope.TEACHER,
            status=ResourceStatus.INDEXED,
        )

        response = self.post_json(
            f"/api/admin/tasks/knowledge_index/{index_job.pk}/retry/",
            {"reason": "验证重试队列故障"},
        )

        self.assertEqual(response.status_code, 503)
        index_job.refresh_from_db()
        self.resource.refresh_from_db()
        self.assertEqual(index_job.status, IndexJobStatus.FAILED)
        self.assertEqual(index_job.celery_task_id, "")
        self.assertEqual(index_job.error_message, "索引任务调度失败，请稍后重试。")
        self.assertEqual(self.resource.status, ResourceStatus.FAILED)
        self.assertTrue(self.resource.error_message)
        indexed_resource.refresh_from_db()
        self.assertEqual(indexed_resource.status, ResourceStatus.INDEXED)
        audits = AdminAuditLog.objects.filter(action="task.retry", target_id=str(index_job.pk))
        self.assertEqual(audits.count(), 1)
        audit = audits.get()
        self.assertFalse(audit.success)
        self.assertEqual(audit.metadata, {"errorCode": "dispatch_failed", "kind": "knowledge_index"})
        serialized = json.dumps(
            {"before": audit.before, "after": audit.after, "metadata": audit.metadata},
            ensure_ascii=False,
        ).lower()
        self.assertNotIn("retry-secret", serialized)
        self.assertNotIn("retry.ini", serialized)

    @patch("backend.apps.compat.video_jobs.dispatch_video_job")
    def test_failed_video_retry_uses_existing_failed_segment_transition(self, dispatch):
        job = VideoGenerationJob.objects.create(
            job_id="supported-video-retry",
            user=self.student,
            resource_pack_id="retry-pack",
            status="failed",
            stage="failed",
        )
        segment = VideoGenerationSegment.objects.create(
            job=job,
            index=1,
            title="失败片段",
            prompt="重新生成片段",
            status="failed",
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.post_json(
                f"/api/admin/tasks/video_generation/{job.pk}/retry/",
                {"reason": "仅重试失败片段"},
            )

        self.assertEqual(response.status_code, 202)
        job.refresh_from_db()
        segment.refresh_from_db()
        self.assertEqual(job.status, "queued")
        self.assertEqual(segment.status, "pending")
        dispatch.assert_called_once()

    @patch("backend.apps.compat.video_compositions._send_queued_task")
    def test_failed_composition_retry_reuses_stage_dispatch(self, send_queued_task):
        job = VideoGenerationJob.objects.create(
            job_id="supported-composition-retry",
            user=self.student,
            resource_pack_id="composition-pack",
            status="succeeded",
        )
        VideoGenerationSegment.objects.create(
            job=job,
            index=1,
            title="旁白片段",
            prompt="旁白",
            narration="用于验证旁白重试。",
            narration_fits=True,
            status="succeeded",
        )
        composition = VideoComposition.objects.create(
            job=job,
            status="failed",
            stage="narration",
            error_message="旧失败信息",
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.post_json(
                f"/api/admin/tasks/video_composition/{composition.pk}/retry/",
                {"reason": "旁白队列恢复后重试"},
            )

        self.assertEqual(response.status_code, 202)
        composition.refresh_from_db()
        self.assertEqual(composition.status, "queued")
        self.assertEqual(composition.stage, "narration")
        self.assertTrue(composition.celery_task_id)
        send_queued_task.assert_called_once()

    @patch("backend.apps.system.admin_task_services.current_app.control.revoke")
    def test_cancel_requires_supported_state_kind_and_persisted_task_id(self, revoke):
        cancellable = KnowledgeIndexJob.objects.create(
            owner=self.teacher,
            job_type=IndexJobType.PARSE,
            status=IndexJobStatus.RUNNING,
            celery_task_id="persisted-index-task-id",
        )

        response = self.post_json(
            f"/api/admin/tasks/knowledge_index/{cancellable.pk}/cancel/",
            {"reason": "任务占用资源异常"},
        )

        self.assertEqual(response.status_code, 200)
        cancellable.refresh_from_db()
        self.assertEqual(cancellable.status, "cancelled")
        self.assertIsNotNone(cancellable.finished_at)
        revoke.assert_called_once_with("persisted-index-task-id", terminate=True)
        self.assert_audit(
            action="task.cancel",
            target_id=cancellable.pk,
            reason="任务占用资源异常",
            success=True,
        )

        queued = KnowledgeIndexJob.objects.create(
            owner=self.teacher,
            job_type=IndexJobType.PARSE,
            status=IndexJobStatus.QUEUED,
            celery_task_id="queued-index-task-id",
        )
        queued_response = self.post_json(
            f"/api/admin/tasks/knowledge_index/{queued.pk}/cancel/",
            {"reason": "取消尚未开始的任务"},
        )
        self.assertEqual(queued_response.status_code, 200)
        queued.refresh_from_db()
        self.assertEqual(queued.status, "cancelled")
        revoke.assert_any_call("queued-index-task-id", terminate=True)

        no_task_id = KnowledgeIndexJob.objects.create(
            owner=self.teacher,
            job_type=IndexJobType.PARSE,
            status=IndexJobStatus.QUEUED,
        )
        failed = self.post_json(
            f"/api/admin/tasks/knowledge_index/{no_task_id.pk}/cancel/",
            {"reason": "缺少任务编号"},
        )
        self.assertEqual(failed.status_code, 409)
        no_task_id.refresh_from_db()
        self.assertEqual(no_task_id.status, IndexJobStatus.QUEUED)
        self.assert_audit(
            action="task.cancel",
            target_id=no_task_id.pk,
            reason="缺少任务编号",
            success=False,
        )

        resource_job = ResourceGenerationJob.objects.create(
            job_id="admin-resource-cancel",
            user=self.student,
            status="queued",
            stage="queued",
            metadata={"executionBackend": "celery", "celeryTaskId": "resource-generation-task-id"},
        )
        resource_response = self.post_json(
            f"/api/admin/tasks/resource_generation/{resource_job.pk}/cancel/",
            {"reason": "排队时间异常，管理员终止任务"},
        )
        self.assertEqual(resource_response.status_code, 200)
        resource_job.refresh_from_db()
        self.assertEqual(resource_job.status, "cancelled")
        self.assertEqual(resource_job.stage, "cancelled")
        self.assertIsNotNone(resource_job.finished_at)
        revoke.assert_any_call("resource-generation-task-id", terminate=True)
        self.assert_audit(
            action="task.cancel",
            target_id=resource_job.pk,
            reason="排队时间异常，管理员终止任务",
            success=True,
        )

        legacy_resource_job = ResourceGenerationJob.objects.create(
            job_id="admin-resource-cancel-without-task-id",
            user=self.student,
            status="queued",
            stage="queued",
            metadata={"executionBackend": "celery"},
        )
        legacy_response = self.post_json(
            f"/api/admin/tasks/resource_generation/{legacy_resource_job.pk}/cancel/",
            {"reason": "清理缺少任务编号的旧排队任务"},
        )
        self.assertEqual(legacy_response.status_code, 200)
        legacy_resource_job.refresh_from_db()
        self.assertEqual(legacy_resource_job.status, "cancelled")
        self.assertEqual(legacy_resource_job.progress, 100)

    @patch("backend.apps.system.admin_task_services.current_app.control.revoke")
    def test_video_generation_is_never_cancellable_from_parent_task(self, revoke):
        job = VideoGenerationJob.objects.create(
            job_id="non-cooperative-video-cancel",
            user=self.student,
            resource_pack_id="video-cancel-pack",
            status="running",
            stage="generating",
            celery_task_id="parent-video-task-id",
        )

        detail = self.client.get(f"/api/admin/tasks/video_generation/{job.pk}/")
        response = self.post_json(
            f"/api/admin/tasks/video_generation/{job.pk}/cancel/",
            {"reason": "尝试取消视频生成"},
        )

        self.assertEqual(detail.status_code, 200)
        self.assertFalse(detail.json()["task"]["eligibility"]["cancel"])
        self.assertEqual(response.status_code, 409)
        job.refresh_from_db()
        self.assertEqual(job.status, "running")
        revoke.assert_not_called()

    def test_security_review_enforces_transitions_and_audits_failures(self):
        event = SecurityEvent.objects.create(
            user=self.student,
            category="unsafe_request",
            severity="warning",
            source="safety_agent",
            summary="检测到疑似越权请求",
            metadata={"token": "must-not-leak", "rule": "privacy"},
        )
        route = f"/api/admin/security-events/{event.pk}/review/"

        confirmed = self.post_json(
            route,
            {"status": "confirmed", "reason": "已核对请求上下文", "note": "转交安全负责人"},
        )

        self.assertEqual(confirmed.status_code, 200)
        event.refresh_from_db()
        self.assertEqual(event.review_status, SecurityEvent.ReviewStatus.CONFIRMED)
        self.assertEqual(event.reviewer, self.admin)
        self.assertIsNotNone(event.reviewed_at)
        self.assert_audit(
            action="security_event.review",
            target_id=event.pk,
            reason="已核对请求上下文",
            success=True,
        )

        invalid = self.post_json(route, {"status": "false_positive", "reason": "重复修改"})
        self.assertEqual(invalid.status_code, 409)
        event.refresh_from_db()
        self.assertEqual(event.review_status, SecurityEvent.ReviewStatus.CONFIRMED)
        self.assert_audit(
            action="security_event.review",
            target_id=event.pk,
            reason="重复修改",
            success=False,
        )

    @override_settings(
        CELERY_BROKER_URL="redis://user:password@private-redis.internal:6379/0",
        EMAIL_HOST_PASSWORD="smtp-password",
        EMAIL_HOST_USER="sender@example.test",
        KNOWLEDGE_UPLOAD_ROOT="D:\\private\\knowledge",
        OPENAI_API_KEY="paid-provider-secret",
    )
    @patch("backend.apps.system.admin_configuration._verify_model_provider")
    def test_configuration_is_secret_free_and_provider_verify_is_non_paid(self, provider_verify):
        provider_verify.return_value = {
            "status": "configured",
            "message": "模型服务配置格式有效，未执行付费调用",
            "evidence": {"configured": True, "paidCallPerformed": False},
        }

        listed = self.client.get("/api/admin/configuration/")

        self.assertEqual(listed.status_code, 200)
        payload_text = json.dumps(listed.json(), ensure_ascii=False).lower()
        for forbidden in (
            "db-password",
            "private-db.internal",
            "private-redis.internal",
            "smtp-password",
            "paid-provider-secret",
            "d:\\private",
            "redis://",
        ):
            self.assertNotIn(forbidden, payload_text)
        provider_verify.assert_not_called()

        verified = self.post_json(
            "/api/admin/configuration/model_provider/verify/",
            {"reason": "发布前检查模型配置"},
        )
        self.assertEqual(verified.status_code, 200)
        self.assertFalse(verified.json()["item"]["evidence"]["paidCallPerformed"])
        provider_verify.assert_called_once_with(timeout=2.0)
        self.assert_audit(
            action="configuration.verify",
            target_id="model_provider",
            reason="发布前检查模型配置",
            success=True,
        )

    @patch(
        "backend.apps.system.admin_configuration._verify_database",
        side_effect=RuntimeError("postgres://user:password@private-db.internal/db /srv/config.py"),
    )
    def test_configuration_verify_failure_is_sanitized_and_audited(self, _verify_database):
        response = self.post_json(
            "/api/admin/configuration/database/verify/",
            {"reason": "检查数据库连通性"},
        )

        self.assertEqual(response.status_code, 503)
        payload = json.dumps(response.json(), ensure_ascii=False).lower()
        self.assertNotIn("password", payload)
        self.assertNotIn("private-db", payload)
        self.assertNotIn("/srv/", payload)
        self.assert_audit(
            action="configuration.verify",
            target_id="database",
            reason="检查数据库连通性",
            success=False,
        )

    def test_audit_list_is_paginated_redacted_and_admin_only(self):
        AdminAuditLog.objects.create(
            actor=self.admin,
            action="legacy.unsafe",
            target_type="resource",
            target_id="unsafe-1",
            reason="检查 D:\\private\\secret.txt",
            before={"token": "raw-token", "status": "before"},
            after={"status": "after", "storedPath": "D:\\private\\secret.txt"},
            metadata={"error": "Traceback: /srv/private/app.py"},
        )

        response = self.client.get("/api/admin/audit-logs/?page=1&pageSize=20")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["pagination"]["total"], 1)
        payload_text = json.dumps(response.json(), ensure_ascii=False).lower()
        for forbidden in ("raw-token", "secret.txt", "/srv/private", "traceback"):
            self.assertNotIn(forbidden, payload_text)

        self.client.force_login(self.teacher)
        self.assertEqual(self.client.get("/api/admin/audit-logs/").status_code, 403)

    def test_action_routes_reject_non_object_json_and_still_audit_attempt(self):
        route = f"/api/admin/catalog/courses/{self.course.pk}/status/"

        response = self.client.post(route, data="[]", content_type="application/json")

        self.assertEqual(response.status_code, 400)
        self.assertTrue(response.json()["error"])
        self.assert_audit(action="course.status", target_id=self.course.pk, reason="", success=False)
