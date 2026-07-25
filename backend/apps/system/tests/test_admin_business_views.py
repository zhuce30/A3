import json
from datetime import timedelta

from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from backend.apps.accounts.models import User, UserRole
from backend.apps.compat.models import (
    AgentRun,
    AgentSpan,
    AgentStep,
    ResourceGenerationJob,
    VideoComposition,
    VideoGenerationJob,
)
from backend.apps.knowledge_base.models import KnowledgeIndexJob, KnowledgeResource
from backend.apps.learning.models import (
    Chapter,
    CoachingMessage,
    CoachingSession,
    Course,
    CourseEnrollment,
    CourseTeachingAssignment,
    KnowledgePoint,
)
from backend.apps.system.models import AdminAuditLog


class AdminBusinessViewsTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_user(
            phone="admin-business",
            password="password123",
            role=UserRole.ADMIN,
            display_name="系统管理员",
        )
        self.student = User.objects.create_user(
            phone="student-business",
            password="password123",
            role=UserRole.STUDENT,
            display_name="测试学生",
        )
        self.teacher = User.objects.create_user(
            phone="teacher-business",
            password="password123",
            role=UserRole.TEACHER,
            display_name="测试教师",
        )
        self.course = Course.objects.create(code="AUTO-101", title="自动控制原理")
        chapter = Chapter.objects.create(course=self.course, order=1, title="线性系统")
        KnowledgePoint.objects.create(chapter=chapter, code="AUTO-KP-1", order=1, title="根轨迹")
        CourseTeachingAssignment.objects.create(course=self.course, teacher=self.teacher)
        CourseEnrollment.objects.create(course=self.course, user=self.student)

        self.sessions = []
        for index in range(3):
            session = CoachingSession.objects.create(
                user=self.student,
                course=self.course,
                topic_title=f"辅导会话 {index}",
                metadata={
                    "traceId": f"conversation-trace-{index}",
                    "learningGoal": "掌握根轨迹",
                    "cookie": "session-cookie",
                    "storedPath": "D:\\private\\conversation.txt",
                    "providerUrl": "https://provider.example/private",
                    "unknown": "must-not-leak",
                },
            )
            CoachingMessage.objects.create(
                session=session,
                role="assistant",
                content=f"受保护的会话正文 {index}",
                verified=True,
                metadata={"token": "secret-token", "providerUrl": "https://provider.example/message"},
            )
            self.sessions.append(session)
        for index in range(21):
            CoachingMessage.objects.create(
                session=self.sessions[0],
                role="user",
                content=f"分页消息 {index}",
                degraded=index == 0,
                safety={"blocked": index == 1},
            )

        self.index_jobs = []
        for index in range(3):
            index_job = KnowledgeIndexJob.objects.create(
                owner=self.teacher,
                job_type="upload",
                status="failed" if index == 0 else "succeeded",
                progress=100 if index else 40,
                celery_task_id=f"celery-index-secret-{index}",
                error_message="D:\\private\\index.log" if index == 0 else "",
            )
            KnowledgeResource.objects.create(
                owner=self.teacher,
                index_job=index_job,
                original_name=f"控制原理资料 {index}.pdf",
                stored_path=f"D:\\private\\course-{index}.pdf",
                file_type="pdf",
                file_size=1024,
                resource_scope="course",
                course_key=self.course.code,
                visibility="course",
                status="failed" if index == 0 else "ready",
                document_count=index + 1,
                chunk_count=(index + 1) * 10,
                error_message="/srv/private/index.txt" if index == 0 else "",
            )
            self.index_jobs.append(index_job)

        now = timezone.now()
        for index in range(3):
            ResourceGenerationJob.objects.create(
                job_id=f"resource-job-{index}",
                user=self.student,
                status="failed" if index == 0 else "succeeded",
                progress=20 if index == 0 else 100,
                stage="generate",
                trace_id=f"resource-trace-{index}",
                error_message="https://provider.example/signed-output" if index == 0 else "",
                metadata={"apiKey": "secret"},
            )
            video_job = VideoGenerationJob.objects.create(
                job_id=f"video-job-{index}",
                user=self.student,
                resource_pack_id=f"pack-{index}",
                provider="secret-provider",
                status="queued" if index == 0 else "succeeded",
                stage="submit",
                progress=0 if index == 0 else 100,
                celery_task_id=f"celery-video-secret-{index}",
                trace_id=f"video-trace-{index}",
                artifact={"signedUrl": "https://provider.example/signed"},
                started_at=now - timedelta(seconds=10),
                finished_at=now if index else None,
            )
            VideoComposition.objects.create(
                job=video_job,
                status="failed" if index == 0 else "succeeded",
                stage="compose",
                progress=30 if index == 0 else 100,
                narration_text="private narration body",
                final_video_path=f"D:\\private\\final-{index}.mp4",
                subtitles_path=f"/srv/private/subtitle-{index}.srt",
                celery_task_id=f"celery-composition-secret-{index}",
                error_message="token=provider-secret" if index == 0 else "",
            )

        self.runs = []
        for index in range(3):
            run = AgentRun.objects.create(
                trace_id=f"agent-trace-{index}",
                user=self.student,
                workflow="recommend",
                goal="生成个性化推荐",
                status="failed" if index == 0 else "succeeded",
                fallback_strategy="keyword",
                latency_ms=120 + index,
                started_at=now - timedelta(seconds=2),
                completed_at=now,
                metadata={
                    "retryPolicy": {"maxRetries": 2, "timeoutMs": 3000},
                    "prompt": "private prompt body",
                    "unknown": "must-not-leak",
                    "localPath": "D:\\private\\trace.json",
                    "providerUrl": "https://provider.example/trace",
                    "apiToken": "secret-token",
                },
            )
            AgentStep.objects.create(
                run=run,
                order=1,
                name="RetrieverAgent",
                role="retriever",
                status="completed",
                detail="private output body",
                latency_ms=60,
                metadata={
                    "runtimePolicy": {"maxRetries": 1, "timeoutMs": 1000, "attempts": 1},
                    "topK": 3,
                    "output": "private output",
                    "unknown": "must-not-leak",
                },
            )
            AgentSpan.objects.create(
                run=run,
                parent_step="RetrieverAgent",
                name="vector_search",
                kind="retrieval",
                status="completed",
                latency_ms=40,
                started_at=now - timedelta(seconds=1),
                completed_at=now,
                metadata={
                    "provider": "local",
                    "model": "bge-small",
                    "latencyMs": 40,
                    "providerUrl": "https://provider.example/span",
                    "storedPath": "/srv/private/vector.index",
                    "prompt": "private prompt",
                    "unknown": "must-not-leak",
                },
            )
            self.runs.append(run)

    def _login_admin(self):
        self.client.force_login(self.admin)

    def _assert_no_sensitive_values(self, payload):
        serialized = json.dumps(payload, ensure_ascii=False).lower()
        for forbidden in (
            "session-cookie",
            "secret-token",
            "must-not-leak",
            "d:\\private",
            "/srv/private",
            "provider.example",
            "private prompt",
            "private output",
            "private narration",
            "celery-video-secret",
            "celery-composition-secret",
            "celery-index-secret",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_business_routes_require_admin_role(self):
        routes = (
            ("get", "/api/admin/conversations/"),
            ("get", f"/api/admin/conversations/{self.sessions[0].pk}/"),
            ("post", f"/api/admin/conversations/{self.sessions[0].pk}/reveal/"),
            ("get", "/api/admin/courses/"),
            ("get", "/api/admin/resources/"),
            ("get", "/api/admin/tasks/"),
            ("get", "/api/admin/tasks/resource_generation/1/"),
            ("get", "/api/admin/agent-runs/"),
            ("get", f"/api/admin/agent-runs/{self.runs[0].trace_id}/"),
        )
        for method, route in routes:
            with self.subTest(method=method, route=route, role="anonymous"):
                response = getattr(self.client, method)(route)
                self.assertEqual(response.status_code, 401)
        for role, user in ((UserRole.STUDENT, self.student), (UserRole.TEACHER, self.teacher)):
            self.client.force_login(user)
            for method, route in routes:
                with self.subTest(method=method, route=route, role=role):
                    response = getattr(self.client, method)(route)
                    self.assertEqual(response.status_code, 403)
            self.client.logout()

    def test_conversation_list_and_detail_hide_bodies_and_sensitive_metadata(self):
        self._login_admin()
        response = self.client.get("/api/admin/conversations/?page=1&pageSize=20&status=active")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["pagination"], {"page": 1, "pageSize": 20, "total": 3})
        item = next(item for item in payload["items"] if item["id"] == str(self.sessions[0].pk))
        self.assertEqual(item["messageCount"], 22)
        self.assertNotIn("content", item)
        self._assert_no_sensitive_values(payload)

        response = self.client.get(f"/api/admin/conversations/{self.sessions[0].pk}/")
        self.assertEqual(response.status_code, 200)
        detail = response.json()["conversation"]
        self.assertEqual(detail["traceId"], "conversation-trace-0")
        self.assertEqual(detail["learningGoal"], "掌握根轨迹")
        self.assertNotIn("messages", detail)
        self.assertNotIn("content", detail)
        self._assert_no_sensitive_values(detail)

    def test_conversation_reveal_requires_reason_is_paginated_and_audited(self):
        self._login_admin()
        route = f"/api/admin/conversations/{self.sessions[0].pk}/reveal/"
        response = self.client.post(route, data={"reason": "   "}, content_type="application/json")
        self.assertEqual(response.status_code, 400)

        response = self.client.post(
            f"{route}?page=2&pageSize=20",
            data={"reason": "处理用户投诉"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["pagination"], {"page": 2, "pageSize": 20, "total": 22})
        self.assertEqual(len(payload["messages"]), 2)
        self.assertIn("content", payload["messages"][0])
        self._assert_no_sensitive_values(payload)

        audit = AdminAuditLog.objects.get(action="conversation.reveal")
        self.assertEqual(audit.actor, self.admin)
        self.assertEqual(audit.target_type, "coaching_session")
        self.assertEqual(audit.target_id, str(self.sessions[0].pk))
        self.assertEqual(audit.reason, "处理用户投诉")
        self.assertEqual(audit.metadata, {"page": 2, "pageSize": 20, "messageCount": 2})
        self._assert_no_sensitive_values({"before": audit.before, "after": audit.after, "metadata": audit.metadata})

    def test_catalog_lists_real_counts_without_stored_paths(self):
        self._login_admin()
        courses = self.client.get("/api/admin/courses/?page=1&pageSize=20&active=true")
        self.assertEqual(courses.status_code, 200)
        course = courses.json()["items"][0]
        self.assertEqual(course["chapterCount"], 1)
        self.assertEqual(course["knowledgePointCount"], 1)
        self.assertEqual(course["teacherCount"], 1)
        self.assertEqual(course["studentCount"], 1)

        resources = self.client.get("/api/admin/resources/?page=1&pageSize=20&scope=course")
        self.assertEqual(resources.status_code, 200)
        payload = resources.json()
        self.assertEqual(payload["pagination"]["total"], 3)
        self.assertEqual(payload["items"][0]["chunkCount"], 30)
        self.assertIn("indexJob", payload["items"][0])
        self._assert_no_sensitive_values(payload)

    def test_tasks_are_normalized_paginated_and_show_evidence_based_eligibility(self):
        self._login_admin()
        response = self.client.get("/api/admin/tasks/?page=1&pageSize=20&status=failed")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertGreaterEqual(payload["pagination"]["total"], 3)
        kinds = {item["kind"] for item in payload["items"]}
        self.assertTrue({"resource_generation", "knowledge_index", "video_composition"}.issubset(kinds))
        for item in payload["items"]:
            self.assertEqual(
                set(item),
                {
                    "id",
                    "kind",
                    "jobId",
                    "user",
                    "status",
                    "stage",
                    "progress",
                    "createdAt",
                    "updatedAt",
                    "startedAt",
                    "finishedAt",
                    "durationMs",
                    "errorSummary",
                    "traceId",
                    "eligibility",
                },
            )
            self.assertIsInstance(item["eligibility"]["retry"], bool)
            self.assertIsInstance(item["eligibility"]["cancel"], bool)
        self._assert_no_sensitive_values(payload)

        first = payload["items"][0]
        detail = self.client.get(f"/api/admin/tasks/{first['kind']}/{first['id']}/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["task"]["id"], first["id"])
        self._assert_no_sensitive_values(detail.json())

    def test_agent_detail_uses_explicit_operational_metadata_allowlist(self):
        self._login_admin()
        response = self.client.get("/api/admin/agent-runs/?page=1&pageSize=20&workflow=recommend")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["pagination"]["total"], 3)
        self.assertEqual(payload["items"][0]["stepCount"], 1)
        self.assertEqual(payload["items"][0]["spanCount"], 1)
        self._assert_no_sensitive_values(payload)

        response = self.client.get(f"/api/admin/agent-runs/{self.runs[0].trace_id}/")
        self.assertEqual(response.status_code, 200)
        run = response.json()["run"]
        self.assertEqual(run["metadata"], {"retryPolicy": {"maxRetries": 2, "timeoutMs": 3000}})
        self.assertEqual(
            run["steps"][0]["metadata"],
            {"runtimePolicy": {"maxRetries": 1, "timeoutMs": 1000, "attempts": 1}, "topK": 3},
        )
        self.assertEqual(
            run["spans"][0]["metadata"],
            {"provider": "local", "model": "bge-small", "latencyMs": 40},
        )
        self.assertNotIn("detail", run["steps"][0])
        self._assert_no_sensitive_values(run)

    def test_invalid_pagination_and_filters_return_readable_chinese_errors(self):
        self._login_admin()
        routes = (
            "/api/admin/conversations/?page=0",
            "/api/admin/courses/?pageSize=19",
            "/api/admin/resources/?pageSize=101",
            "/api/admin/tasks/?kind=unknown",
            "/api/admin/agent-runs/?status=unknown-status",
        )
        for route in routes:
            with self.subTest(route=route):
                response = self.client.get(route)
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.json()["success"])
                self.assertTrue(response.json()["error"])

    def test_multi_row_lists_have_bounded_query_counts(self):
        self._login_admin()
        bounds = (
            ("/api/admin/conversations/?pageSize=20", 6),
            ("/api/admin/courses/?pageSize=20", 4),
            ("/api/admin/resources/?pageSize=20", 4),
            ("/api/admin/tasks/?pageSize=20", 5),
            ("/api/admin/agent-runs/?pageSize=20", 4),
        )
        for route, maximum in bounds:
            with self.subTest(route=route), CaptureQueriesContext(connection) as captured:
                response = self.client.get(route)
                self.assertEqual(response.status_code, 200)
            self.assertLessEqual(len(captured), maximum, [query["sql"] for query in captured.captured_queries])
