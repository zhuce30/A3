import json

from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.learning.models import CoachingMessage, CoachingMessageRole, CoachingSession, CoachingSessionStatus, Course, CourseEnrollment, CourseTeachingAssignment
from backend.apps.profiles.models import LearnerProfile


class CoachingSessionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800006601", password="TestPassword123")
        LearnerProfile.objects.create(user=self.user)
        self.client = Client()
        self.client.force_login(self.user)

    def test_empty_coaching_session_returns_recoverable_payload(self):
        response = self.client.get("/api/learning/coaching/session/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["session"]["messages"], [])
        self.assertEqual(payload["session"]["schemaVersion"], "a3.coaching-session.v1")

    def test_coaching_session_persists_verified_messages(self):
        response = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps(
                {
                    "messages": [
                        {"id": "user-1", "role": "user", "content": "反馈控制是什么？"},
                        {
                            "id": "assistant-1",
                            "role": "assistant",
                            "content": "反馈控制会把输出量回送并与输入量比较。",
                            "verified": True,
                            "citations": [{"title": "反馈控制结构", "location": "第 1 章"}],
                            "claims": [{"id": "c1", "text": "反馈控制使用输出回送。", "verified": True}],
                        },
                    ],
                    "summary": "解释了反馈控制的基本闭环结构。",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)

        history = self.client.get("/api/learning/coaching/session/")
        session = history.json()["session"]

        self.assertEqual([item["id"] for item in session["messages"][-2:]], ["user-1", "assistant-1"])
        self.assertTrue(session["messages"][-1]["verified"])
        self.assertEqual(session["messages"][-1]["citations"][0]["title"], "反馈控制结构")
        self.assertEqual(session["summary"], "解释了反馈控制的基本闭环结构。")

        persisted = CoachingSession.objects.get(user=self.user)
        self.assertEqual(persisted.summary, "解释了反馈控制的基本闭环结构。")
        self.assertEqual(CoachingMessage.objects.filter(session=persisted).count(), 2)
        self.assertTrue(CoachingMessage.objects.get(session=persisted, role="assistant").verified)

    def test_legacy_extra_profile_session_is_imported_once(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "coachingSession": {
                "messages": [{"id": "legacy-user", "role": "user", "content": "旧记录"}],
                "summary": "旧摘要",
                "updatedAt": "2026-07-04T10:00:00+08:00",
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.get("/api/learning/coaching/session/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["session"]["messages"][0]["id"], "legacy-user")
        self.assertEqual(CoachingMessage.objects.filter(session__user=self.user).count(), 1)

        self.client.get("/api/learning/coaching/session/")

        self.assertEqual(CoachingMessage.objects.filter(session__user=self.user).count(), 1)

    def test_reposting_same_client_message_does_not_duplicate_audit_rows(self):
        payload = {
            "messages": [
                {"id": "user-1", "role": "user", "content": "反馈控制是什么？"},
                {"id": "assistant-1", "role": "assistant", "content": "反馈控制会回送输出。"},
            ]
        }

        self.client.post("/api/learning/coaching/session/", data=json.dumps(payload), content_type="application/json")
        self.client.post("/api/learning/coaching/session/", data=json.dumps(payload), content_type="application/json")

        session = CoachingSession.objects.get(user=self.user)
        self.assertEqual(CoachingMessage.objects.filter(session=session).count(), 2)

    def test_user_can_end_current_coaching_session(self):
        self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"role": "user", "content": "结束前的问题"}]}),
            content_type="application/json",
        )

        response = self.client.post("/api/learning/coaching/session/end/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["session"]["status"], "ended")

    def test_new_append_after_end_creates_new_active_session(self):
        self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"role": "user", "content": "第一场"}]}),
            content_type="application/json",
        )
        self.client.post("/api/learning/coaching/session/end/")
        self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"role": "user", "content": "第二场"}]}),
            content_type="application/json",
        )

        self.assertEqual(CoachingSession.objects.filter(user=self.user).count(), 2)
        self.assertEqual(CoachingSession.objects.filter(user=self.user, status="active").count(), 1)

    def test_coaching_session_is_scoped_to_current_user(self):
        self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": [{"id": "user-1", "role": "user", "content": "只属于当前用户"}]}),
            content_type="application/json",
        )
        other = User.objects.create_user(phone="13800006602", password="TestPassword123")
        LearnerProfile.objects.create(user=other)
        self.client.force_login(other)

        response = self.client.get("/api/learning/coaching/session/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["session"]["messages"], [])

    def test_coaching_session_rejects_empty_append_payload(self):
        response = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps({"messages": []}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_coaching_sessions_lists_recent_sessions(self):
        ended = CoachingSession.objects.create(
            user=self.user,
            status=CoachingSessionStatus.ENDED,
            topic_title="反馈控制结构",
            summary="已完成反馈控制答疑",
        )
        CoachingMessage.objects.create(session=ended, role=CoachingMessageRole.USER, content="反馈控制是什么？")
        CoachingMessage.objects.create(
            session=ended,
            role=CoachingMessageRole.ASSISTANT,
            content="反馈控制会比较目标与输出。",
            verified=True,
            citations=[{"title": "控制系统基础"}],
        )

        response = self.client.get("/api/learning/coaching/sessions/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["sessions"][0]["id"], str(ended.id))
        self.assertEqual(payload["sessions"][0]["topicTitle"], "反馈控制结构")
        self.assertEqual(payload["sessions"][0]["questionCount"], 1)
        self.assertEqual(payload["sessions"][0]["verifiedReplyCount"], 1)
        self.assertEqual(payload["sessions"][0]["citationCount"], 1)

    def test_coaching_session_detail_only_allows_owner(self):
        other = User.objects.create_user(phone="13800006603", password="TestPassword123")
        LearnerProfile.objects.create(user=other)
        session = CoachingSession.objects.create(user=self.user, topic_title="传递函数")
        CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="传递函数是什么？")
        self.client.force_login(other)

        response = self.client.get(f"/api/learning/coaching/sessions/{session.id}/")

        self.assertEqual(response.status_code, 404)

    def test_coaching_summary_updates_session_metadata_and_notification(self):
        session = CoachingSession.objects.create(user=self.user, topic_title="反馈控制结构")
        CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="为什么负反馈能改善稳定性？")
        CoachingMessage.objects.create(
            session=session,
            role=CoachingMessageRole.ASSISTANT,
            content="负反馈能降低扰动影响，但需要结合稳定裕度判断。",
            verified=True,
            citations=[{"title": "控制系统基础", "location": "第 1 章"}],
            claims=[{"id": "c1", "text": "负反馈能降低扰动影响", "verified": True}],
        )

        response = self.client.post(f"/api/learning/coaching/sessions/{session.id}/summary/")

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["summary"]["questionCount"], 1)
        self.assertEqual(payload["summary"]["verifiedReplyCount"], 1)
        self.assertEqual(payload["summary"]["citationCount"], 1)
        self.assertIn(payload["summary"]["nextAction"]["href"], {"/a3/wrong-notebook", "/a3/study-plan", "/a3/assessment", "/a3/knowledge-base"})
        session.refresh_from_db()
        self.assertEqual(session.metadata["summary"]["schemaVersion"], "a3.coaching-summary.v1")

    def test_realtime_message_metadata_is_persisted_and_summarized(self):
        response = self.client.post(
            "/api/learning/coaching/session/",
            data=json.dumps(
                {
                    "messages": [
                        {
                            "id": "assistant-realtime-1",
                            "role": "assistant",
                            "content": "根轨迹渐近线需要结合极点和零点数量判断。",
                            "verified": True,
                            "citations": [{"title": "根轨迹课件", "previewUrl": "/api/kb/assets/a1/preview/"}],
                            "metadata": {
                                "realtime": {"provider": "dashscope_qwen_omni_realtime", "latencyMs": 820},
                                "visualEvidence": {"source": "screen", "assetIds": ["asset-1"]},
                            },
                        }
                    ],
                    "summary": "实时辅导写入测试",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        session = CoachingSession.objects.get(user=self.user)
        message = CoachingMessage.objects.get(session=session)
        self.assertEqual(message.metadata["realtime"]["provider"], "dashscope_qwen_omni_realtime")
        self.assertEqual(message.metadata["visualEvidence"]["source"], "screen")

        summary_response = self.client.post(f"/api/learning/coaching/sessions/{session.id}/summary/")

        self.assertEqual(summary_response.status_code, 201)
        session.refresh_from_db()
        self.assertEqual(session.metadata["summary"]["verifiedReplyCount"], 1)
        self.assertEqual(session.metadata["summary"]["visualEvidenceCount"], 1)

    def test_teacher_workbench_includes_coaching_activity(self):
        teacher = User.objects.create_user(phone="13800006604", password="TestPassword123", role="teacher")
        student = User.objects.create_user(phone="13800006605", password="TestPassword123")
        LearnerProfile.objects.create(user=student)
        course = Course.objects.create(code="COACH-AUDIT", title="辅导审计课程")
        CourseTeachingAssignment.objects.create(teacher=teacher, course=course)
        CourseEnrollment.objects.create(user=student, course=course)
        session = CoachingSession.objects.create(user=student, course=course, status=CoachingSessionStatus.ENDED, topic_title="反馈控制结构")
        CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="反馈控制是什么？")
        CoachingMessage.objects.create(session=session, role=CoachingMessageRole.ASSISTANT, content="回答", verified=True)
        self.client.force_login(teacher)

        response = self.client.get("/api/learning/teacher/workbench/")

        self.assertEqual(response.status_code, 200)
        workbench = response.json()["workbench"]
        self.assertGreaterEqual(workbench["coachingSummary"]["totalSessions"], 1)
        self.assertGreaterEqual(workbench["coachingSummary"]["studentsUsedCoaching"], 1)
        self.assertGreaterEqual(workbench["coachingSummary"]["verifiedReplyCount"], 1)
