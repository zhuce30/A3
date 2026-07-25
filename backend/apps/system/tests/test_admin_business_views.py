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
    VideoGenerationSegment,
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

    def test_conversation_reveal_redacts_structured_and_header_style_secrets(self):
        structured_secret = "JSON-API-KEY-7f3d"
        bearer_secret = "BEARER-TOKEN-8a4e"
        cookie_secret = "COOKIE-SECRET-9b5f"
        inline_secret = "INLINE-TOKEN-0c6a"
        header_api_key = "HEADER-API-KEY-1d7b"
        normalized_secrets = {
            "clientSecret": "CLIENT-SECRET-3f9d",
            "private.key": "PRIVATE-KEY-4a0e",
            "session-Cookie": "SESSION-COOKIE-5b1f",
            "credentials": {"value": "CREDENTIAL-VALUE-6c2a", "safeLooking": "DROP-SUBTREE"},
            "refresh.token": "REFRESH-TOKEN-7d3b",
            "access_token": "ACCESS-TOKEN-8e4c",
        }
        session = CoachingSession.objects.create(user=self.student, topic_title="敏感信息脱敏测试")
        CoachingMessage.objects.create(
            session=session,
            role="user",
            content=json.dumps(
                {
                    "question": "保留这个正常问题",
                    "apiKey": structured_secret,
                    "nested": {
                        "Authorization": f"Bearer {bearer_secret}",
                        "safe": "保留嵌套字段",
                        **normalized_secrets,
                    },
                },
                ensure_ascii=False,
            ),
        )
        CoachingMessage.objects.create(
            session=session,
            role="assistant",
            content=(
                "请保留普通解释\n"
                f"Authorization: Bearer {bearer_secret}\n"
                f"Cookie: sid={cookie_secret}; theme=dark\n"
                f"X-API-Key: {header_api_key}\n"
                f'调试数据 {{"token": "{inline_secret}", "question": "保留内容"}}'
            ),
        )
        self._login_admin()

        response = self.client.post(
            f"/api/admin/conversations/{session.pk}/reveal/",
            data={"reason": "核对敏感信息脱敏"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        contents = [item["content"] for item in response.json()["messages"]]
        serialized = json.dumps(contents, ensure_ascii=False)
        for secret in (
            structured_secret,
            bearer_secret,
            cookie_secret,
            inline_secret,
            header_api_key,
            "CLIENT-SECRET-3f9d",
            "PRIVATE-KEY-4a0e",
            "SESSION-COOKIE-5b1f",
            "CREDENTIAL-VALUE-6c2a",
            "DROP-SUBTREE",
            "REFRESH-TOKEN-7d3b",
            "ACCESS-TOKEN-8e4c",
        ):
            self.assertNotIn(secret, serialized)
        structured_content = next(content for content in contents if content.startswith("{"))
        text_content = next(content for content in contents if content.startswith("请保留"))
        structured = json.loads(structured_content)
        self.assertEqual(structured, {"question": "保留这个正常问题", "nested": {"safe": "保留嵌套字段"}})
        self.assertIn("请保留普通解释", text_content)
        self.assertIn("保留内容", text_content)

    def test_conversation_reveal_redacts_normalized_keys_in_truncated_non_json_text(self):
        secrets = {
            "clientSecret": "TEXT-CLIENT-SECRET-a101",
            "private.key": "TEXT-PRIVATE-KEY-b202",
            "session-Cookie": "TEXT-SESSION-COOKIE-c303",
            "credentials": "TEXT-CREDENTIAL-d404",
            "Authorization": "Bearer TEXT-AUTH-e505",
            "api.key": "TEXT-API-KEY-f606",
            "access-token": "TEXT-ACCESS-TOKEN-a707",
            "refreshToken": "TEXT-REFRESH-TOKEN-b808",
        }
        content = (
            "保留开头的普通学习内容\n"
            f"clientSecret: {secrets['clientSecret']}\n"
            f'"private.key": "{secrets["private.key"]}\n'
            f"session-Cookie={secrets['session-Cookie']}\n"
            f'credentials: {{"value":"{secrets["credentials"]}\n'
            f"Authorization: {secrets['Authorization']}\n"
            f"api.key: {secrets['api.key']}\n"
            f"access-token={secrets['access-token']}\n"
            f'"refreshToken": "{secrets["refreshToken"]}\n'
            "保留结尾的普通说明"
        )
        session = CoachingSession.objects.create(user=self.student, topic_title="截断正文脱敏")
        CoachingMessage.objects.create(session=session, role="user", content=content)
        self._login_admin()

        response = self.client.post(
            f"/api/admin/conversations/{session.pk}/reveal/",
            data={"reason": "验证截断正文脱敏"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        revealed = response.json()["messages"][0]["content"]
        for secret in secrets.values():
            self.assertNotIn(secret, revealed)
        self.assertIn("保留开头的普通学习内容", revealed)
        self.assertIn("保留结尾的普通说明", revealed)

    def test_conversation_reveal_redacts_complete_multiline_private_key_blocks(self):
        key_types = ("PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY")
        blocks = []
        body_markers = []
        for index, key_type in enumerate(key_types):
            marker = f"PRIVATE-KEY-BODY-{index}-must-not-leak"
            body_markers.append(marker)
            prefix = "privateKey: " if index == 0 else ""
            blocks.append(
                f"{prefix}-----BEGIN {key_type}-----\n"
                f"{marker}\n"
                "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n"
                f"-----END {key_type}-----"
            )
        session = CoachingSession.objects.create(user=self.student, topic_title="私钥块脱敏")
        CoachingMessage.objects.create(
            session=session,
            role="user",
            content="保留普通说明\n" + "\n".join(blocks) + "\n保留结束说明",
        )
        self._login_admin()

        response = self.client.post(
            f"/api/admin/conversations/{session.pk}/reveal/",
            data={"reason": "核对私钥块脱敏"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        revealed = response.json()["messages"][0]["content"]
        for marker in body_markers:
            self.assertNotIn(marker, revealed)
        self.assertNotIn("-----BEGIN", revealed)
        self.assertNotIn("-----END", revealed)
        self.assertNotIn("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", revealed)
        self.assertIn("保留普通说明", revealed)
        self.assertIn("保留结束说明", revealed)

    def test_conversation_reveal_redacts_incomplete_private_key_before_output_truncation(self):
        body_marker = "BOUNDARY-PRIVATE-KEY-BASE64-must-not-leak"
        prefix = "保留边界前缀" + ("A" * 19880)
        content = (
            f"{prefix}\n"
            "-----BEGIN PRIVATE KEY-----\n"
            f"{body_marker}\n"
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC-TRUNCATED-WITHOUT-END"
        )
        session = CoachingSession.objects.create(user=self.student, topic_title="边界私钥脱敏")
        CoachingMessage.objects.create(session=session, role="user", content=content)
        self._login_admin()

        response = self.client.post(
            f"/api/admin/conversations/{session.pk}/reveal/",
            data={"reason": "核对边界私钥脱敏"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        revealed = response.json()["messages"][0]["content"]
        self.assertLessEqual(len(revealed), 20000)
        self.assertIn("保留边界前缀", revealed)
        self.assertNotIn("-----BEGIN PRIVATE KEY-----", revealed)
        self.assertNotIn(body_marker, revealed)
        self.assertNotIn("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", revealed)

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
        self.assertEqual({item["chunkCount"] for item in payload["items"]}, {10, 20, 30})
        self.assertTrue(all("indexJob" in item for item in payload["items"]))
        self._assert_no_sensitive_values(payload)

    def test_catalog_hides_tracebacks_but_preserves_ordinary_short_errors(self):
        traceback_marker = "TRACEBACK-PRIVATE-MARKER"
        ordinary_error = "文件格式暂不支持"
        traceback_resource = KnowledgeResource.objects.get(original_name="控制原理资料 0.pdf")
        ordinary_resource = KnowledgeResource.objects.get(original_name="控制原理资料 1.pdf")
        traceback_resource.error_message = (
            "Traceback (most recent call last):\n"
            '  File "worker.py", line 17, in index\n'
            f"ValueError: {traceback_marker}"
        )
        traceback_resource.save(update_fields=["error_message"])
        ordinary_resource.error_message = ordinary_error
        ordinary_resource.save(update_fields=["error_message"])
        self._login_admin()

        response = self.client.get("/api/admin/resources/?page=1&pageSize=20&scope=course")

        self.assertEqual(response.status_code, 200)
        items = {item["name"]: item for item in response.json()["items"]}
        self.assertEqual(items[traceback_resource.original_name]["errorSummary"], "处理失败，详细错误已隐藏")
        self.assertNotIn(traceback_marker, json.dumps(response.json(), ensure_ascii=False))
        self.assertEqual(items[ordinary_resource.original_name]["errorSummary"], ordinary_error)

    def test_catalog_hides_extended_local_object_and_provider_paths(self):
        path_errors = (
            "/app/private/error.log",
            "/usr/local/bin/worker",
            "/data/uploads/source.pdf",
            "/workspace/index/store.bin",
            "/mnt/volume/output.mp4",
            "/root/private/config.json",
            "/storage/private/archive.zip",
            "/project/runtime/output.log",
            "/future-root/private/evidence.bin",
            r"\\fileserver\private\document.pdf",
            "file:///app/private/report.txt",
            "s3://private-bucket/object-key",
            "gs://private-bucket/object-key",
            "ftp://provider.example/private/file.bin",
            "https://provider.example/output?X-Amz-Signature=provider-secret",
        )
        for index, error in enumerate(path_errors):
            KnowledgeResource.objects.create(
                owner=self.teacher,
                original_name=f"路径错误 {index}.pdf",
                stored_path=f"D:\\private\\path-{index}.pdf",
                file_type="pdf",
                resource_scope="course",
                course_key=self.course.code,
                status="failed",
                error_message=error,
            )
        self._login_admin()

        response = self.client.get("/api/admin/resources/?page=1&pageSize=20&scope=course")

        self.assertEqual(response.status_code, 200)
        path_items = [item for item in response.json()["items"] if item["name"].startswith("路径错误")]
        self.assertEqual(len(path_items), len(path_errors))
        self.assertTrue(all(item["errorSummary"] == "处理失败，详细错误已隐藏" for item in path_items))
        serialized = json.dumps(path_items, ensure_ascii=False).lower()
        for marker in (
            "/app/",
            "/usr/",
            "/data/",
            "/workspace/",
            "/mnt/",
            "/root/",
            "/storage/",
            "/project/",
            "/future-root/",
            "fileserver",
            "file://",
            "s3://",
            "gs://",
            "ftp://",
        ):
            self.assertNotIn(marker, serialized)

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

    def test_failed_video_retry_requires_a_persisted_failed_segment_without_n_plus_one(self):
        without_segment = VideoGenerationJob.objects.create(
            job_id="failed-video-without-segment",
            user=self.student,
            resource_pack_id="pack-without-segment",
            status="failed",
            stage="failed",
        )
        with_segment = VideoGenerationJob.objects.create(
            job_id="failed-video-with-segment",
            user=self.student,
            resource_pack_id="pack-with-segment",
            status="failed",
            stage="failed",
        )
        VideoGenerationSegment.objects.create(
            job=with_segment,
            index=0,
            title="失败片段",
            prompt="安全测试提示",
            status="failed",
        )
        self._login_admin()

        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(
                "/api/admin/tasks/?page=1&pageSize=20&kind=video_generation&status=failed"
            )

        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(len(captured), 4, [query["sql"] for query in captured.captured_queries])
        items = {item["jobId"]: item for item in response.json()["items"]}
        self.assertFalse(items[without_segment.job_id]["eligibility"]["retry"])
        self.assertTrue(items[with_segment.job_id]["eligibility"]["retry"])

        without_detail = self.client.get(
            f"/api/admin/tasks/video_generation/{without_segment.pk}/"
        ).json()["task"]
        with_detail = self.client.get(
            f"/api/admin/tasks/video_generation/{with_segment.pk}/"
        ).json()["task"]
        self.assertFalse(without_detail["eligibility"]["retry"])
        self.assertTrue(with_detail["eligibility"]["retry"])

    def test_task_normalization_matches_real_video_and_composition_states(self):
        partial_without_segment = VideoGenerationJob.objects.create(
            job_id="partial-video-without-segment",
            user=self.student,
            resource_pack_id="partial-pack-without",
            status="partial",
            stage="complete",
        )
        partial_with_segment = VideoGenerationJob.objects.create(
            job_id="partial-video-with-segment",
            user=self.student,
            resource_pack_id="partial-pack-with",
            status="partial",
            stage="complete",
        )
        VideoGenerationSegment.objects.create(
            job=partial_with_segment,
            index=0,
            title="部分失败片段",
            prompt="部分失败测试",
            status="failed",
        )
        composition_states = ("generating_narration", "narration_ready", "composing")
        for index, status in enumerate(composition_states):
            job = VideoGenerationJob.objects.create(
                job_id=f"active-composition-job-{index}",
                user=self.student,
                resource_pack_id=f"active-composition-pack-{index}",
                status="succeeded",
            )
            VideoComposition.objects.create(
                job=job,
                status=status,
                stage=status,
                celery_task_id=f"old-composition-task-{index}",
            )
        queued_job = VideoGenerationJob.objects.create(
            job_id="queued-composition-job",
            user=self.student,
            resource_pack_id="queued-composition-pack",
            status="succeeded",
        )
        VideoComposition.objects.create(
            job=queued_job,
            status="queued",
            stage="queued",
            celery_task_id="active-queued-composition-task",
        )
        self._login_admin()

        failed_response = self.client.get(
            "/api/admin/tasks/?page=1&pageSize=20&kind=video_generation&status=failed"
        )
        running_response = self.client.get(
            "/api/admin/tasks/?page=1&pageSize=20&kind=video_composition&status=running"
        )
        queued_response = self.client.get(
            "/api/admin/tasks/?page=1&pageSize=20&kind=video_composition&status=queued"
        )

        self.assertEqual(failed_response.status_code, 200)
        failed_items = {item["jobId"]: item for item in failed_response.json()["items"]}
        self.assertEqual(failed_items[partial_without_segment.job_id]["status"], "failed")
        self.assertFalse(failed_items[partial_without_segment.job_id]["eligibility"]["retry"])
        self.assertEqual(failed_items[partial_with_segment.job_id]["status"], "failed")
        self.assertTrue(failed_items[partial_with_segment.job_id]["eligibility"]["retry"])
        self.assertEqual(running_response.status_code, 200)
        running_items = running_response.json()["items"]
        self.assertEqual({item["stage"] for item in running_items}, {"generating_narration", "composing"})
        self.assertTrue(all(item["status"] == "running" for item in running_items))
        self.assertTrue(all(item["eligibility"]["cancel"] for item in running_items))
        self.assertEqual(queued_response.status_code, 200)
        narration_ready = next(
            item for item in queued_response.json()["items"] if item["stage"] == "narration_ready"
        )
        raw_queued = next(item for item in queued_response.json()["items"] if item["stage"] == "queued")
        self.assertEqual(narration_ready["status"], "queued")
        self.assertFalse(narration_ready["eligibility"]["cancel"])
        self.assertEqual(raw_queued["status"], "queued")
        self.assertTrue(raw_queued["eligibility"]["cancel"])

    def test_resource_generation_retry_is_not_advertised_without_a_transition(self):
        self._login_admin()

        response = self.client.get(
            "/api/admin/tasks/?page=1&pageSize=20&kind=resource_generation&status=failed"
        )

        self.assertEqual(response.status_code, 200)
        item = response.json()["items"][0]
        self.assertFalse(item["eligibility"]["retry"])
        self.assertEqual(item["eligibility"]["retryReason"], "retry_transition_not_supported")

    def test_task_detail_uses_kind_specific_native_ids_without_casts(self):
        resource_job = ResourceGenerationJob.objects.get(job_id="resource-job-0")
        video_job = VideoGenerationJob.objects.get(job_id="video-job-0")
        index_job = self.index_jobs[0]
        composition = VideoComposition.objects.get(job=video_job)
        self._login_admin()
        routes = (
            ("resource_generation", str(resource_job.pk), str(resource_job.pk)),
            ("video_generation", str(video_job.pk), str(video_job.pk)),
            ("knowledge_index", str(index_job.pk), str(index_job.pk)),
            ("video_composition", str(composition.pk), str(composition.pk)),
        )

        for kind, item_id, expected_id in routes:
            with self.subTest(kind=kind), CaptureQueriesContext(connection) as captured:
                response = self.client.get(f"/api/admin/tasks/{kind}/{item_id}/")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["task"]["id"], expected_id)
            self.assertNotIn("CAST(", "\n".join(query["sql"].upper() for query in captured.captured_queries))

        malformed_routes = (
            "/api/admin/tasks/knowledge_index/not-a-uuid/",
            "/api/admin/tasks/video_composition/not-an-integer/",
            "/api/admin/tasks/resource_generation/not-an-integer/",
            "/api/admin/tasks/video_generation/not-an-integer/",
        )
        for route in malformed_routes:
            with self.subTest(route=route):
                response = self.client.get(route)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "任务编号无效")

    def test_task_list_uses_route_safe_primary_id_when_job_id_contains_slash(self):
        unsafe_job_id = "provider/folder/job-unsafe"
        job = ResourceGenerationJob.objects.create(
            job_id=unsafe_job_id,
            user=self.student,
            status="failed",
            stage="failed",
        )
        self._login_admin()

        response = self.client.get(
            "/api/admin/tasks/?page=1&pageSize=20&kind=resource_generation&status=failed"
        )

        self.assertEqual(response.status_code, 200)
        item = next(item for item in response.json()["items"] if item["jobId"] == unsafe_job_id)
        self.assertEqual(item["id"], str(job.pk))
        self.assertNotIn("/", item["id"])
        detail = self.client.get(f"/api/admin/tasks/resource_generation/{item['id']}/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["task"]["jobId"], unsafe_job_id)

    def test_task_list_avoids_text_casts_for_native_identifiers(self):
        self._login_admin()
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get("/api/admin/tasks/?page=1&pageSize=20")

        self.assertEqual(response.status_code, 200)
        sql = "\n".join(query["sql"].upper() for query in captured.captured_queries)
        self.assertNotIn("CAST(", sql)

    def test_agent_detail_uses_explicit_operational_metadata_allowlist(self):
        prompt_secret = "AGENT-GOAL-PROMPT-SECRET-2e8c"
        self.runs[0].goal = f"用户完整提示词：{prompt_secret}"
        self.runs[0].save(update_fields=["goal"])
        self._login_admin()
        response = self.client.get("/api/admin/agent-runs/?page=1&pageSize=20&workflow=recommend")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["pagination"]["total"], 3)
        self.assertEqual(payload["items"][0]["stepCount"], 1)
        self.assertEqual(payload["items"][0]["spanCount"], 1)
        self.assertNotIn(prompt_secret, json.dumps(payload, ensure_ascii=False))
        self.assertTrue(all("goal" not in item for item in payload["items"]))
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
        self.assertNotIn("goal", run)
        self.assertNotIn(prompt_secret, json.dumps(run, ensure_ascii=False))
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

    def test_deep_pagination_requires_narrower_filters(self):
        self._login_admin()

        response = self.client.get("/api/admin/tasks/?page=251&pageSize=20")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(),
            {"success": False, "error": "分页范围过深，请缩小筛选条件后重试"},
        )

    def test_conversation_reveal_rejects_non_object_and_malformed_json_with_chinese_errors(self):
        self._login_admin()
        route = f"/api/admin/conversations/{self.sessions[0].pk}/reveal/"
        cases = (
            ("[]", "请求体必须是 JSON 对象"),
            ('"reason"', "请求体必须是 JSON 对象"),
            ("null", "请求体必须是 JSON 对象"),
            ("123", "请求体必须是 JSON 对象"),
            ('{"reason":', "请求 JSON 格式无效"),
        )
        self.client.raise_request_exception = False
        for body, expected_error in cases:
            with self.subTest(body=body):
                response = self.client.post(route, data=body, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {"success": False, "error": expected_error})

    def test_multi_row_lists_have_bounded_query_counts(self):
        self._login_admin()
        bounds = (
            ("/api/admin/conversations/?pageSize=20", 6),
            ("/api/admin/courses/?pageSize=20", 4),
            ("/api/admin/resources/?pageSize=20", 4),
            ("/api/admin/tasks/?pageSize=20", 10),
            ("/api/admin/agent-runs/?pageSize=20", 4),
        )
        for route, maximum in bounds:
            with self.subTest(route=route), CaptureQueriesContext(connection) as captured:
                response = self.client.get(route)
                self.assertEqual(response.status_code, 200)
            self.assertLessEqual(len(captured), maximum, [query["sql"] for query in captured.captured_queries])
