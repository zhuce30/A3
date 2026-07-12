import json
from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat.llm import LLMUnavailable
from backend.apps.learning.effect_events import record_learning_event
from backend.apps.learning.models import CoachingSession, LearningSummaryDocument
from backend.apps.profiles.models import LearnerProfile


class LearningSummaryDocumentApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007701", password="TestPassword123")
        LearnerProfile.objects.create(
            user=self.user,
            weak_points=["进程调度"],
            learning_goals=["完成操作系统期末复习"],
            extra_profile={
                "studyPlan": {
                    "planId": "plan-summary",
                    "days": [
                        {
                            "dayIndex": 1,
                            "date": timezone.localdate().isoformat(),
                            "tasks": [
                                {
                                    "id": "task-1",
                                    "title": "完成进程调度练习",
                                    "status": "completed",
                                    "estimatedMinutes": 25,
                                }
                            ],
                        }
                    ],
                }
            },
        )

    def test_report_summary_list_requires_login(self):
        response = self.client.get(reverse("learning-report-summaries"))

        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.json()["success"])

    def test_create_report_summary_generates_markdown_from_real_learning_data(self):
        self.client.force_login(self.user)
        record_learning_event(
            self.user,
            event_type="task_completed",
            target_type="study_plan_task",
            target_id="task-1",
            duration_sec=1500,
            metadata={"title": "完成进程调度练习"},
        )
        record_learning_event(
            self.user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-1",
            score=100,
            quality={"isCorrect": True},
        )
        CoachingSession.objects.create(user=self.user, topic_title="进程调度答疑", summary="解释了时间片轮转。")

        response = self.client.post(
            reverse("learning-report-summaries"),
            data=json.dumps({"prompt": "总结我今天学了什么"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        document = payload["document"]
        self.assertEqual(document["schemaVersion"], "a3.learning-summary-document.v1")
        self.assertEqual(document["title"], "今日学习总结")
        self.assertEqual(document["fileName"], f"{timezone.localdate().isoformat()}-今日学习总结.md")
        self.assertIn("# 今日学习总结", document["contentMd"])
        self.assertIn("完成进程调度练习", document["contentMd"])
        self.assertIn("进程调度", document["contentMd"])
        self.assertEqual(payload["documents"][0]["id"], document["id"])
        self.assertEqual(LearningSummaryDocument.objects.filter(user=self.user).count(), 1)

    def test_same_day_report_summary_file_names_are_incremental(self):
        self.client.force_login(self.user)

        first = self.client.post(
            reverse("learning-report-summaries"),
            data=json.dumps({"prompt": "总结今天"}),
            content_type="application/json",
        )
        second = self.client.post(
            reverse("learning-report-summaries"),
            data=json.dumps({"prompt": "再总结一次"}),
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json()["document"]["fileName"], f"{timezone.localdate().isoformat()}-今日学习总结.md")
        self.assertEqual(second.json()["document"]["fileName"], f"{timezone.localdate().isoformat()}-今日学习总结-02.md")

    def test_report_summary_history_is_scoped_to_current_user(self):
        other = User.objects.create_user(phone="13800007702", password="TestPassword123")
        LearningSummaryDocument.objects.create(
            user=other,
            title="今日学习总结",
            file_name="other.md",
            prompt="总结",
            content_md="# Other",
            summary_date=timezone.localdate(),
        )
        own = LearningSummaryDocument.objects.create(
            user=self.user,
            title="今日学习总结",
            file_name="own.md",
            prompt="总结",
            content_md="# Own",
            summary_date=timezone.localdate(),
        )
        self.client.force_login(self.user)

        response = self.client.get(reverse("learning-report-summaries"))

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual([item["id"] for item in payload["documents"]], [str(own.id)])

    def test_report_summary_detail_only_allows_owner(self):
        other = User.objects.create_user(phone="13800007703", password="TestPassword123")
        document = LearningSummaryDocument.objects.create(
            user=other,
            title="今日学习总结",
            file_name="other.md",
            prompt="总结",
            content_md="# Other",
            summary_date=timezone.localdate(),
        )
        self.client.force_login(self.user)

        response = self.client.get(reverse("learning-report-summary-detail", args=[document.id]))

        self.assertEqual(response.status_code, 404)

    @patch("backend.apps.learning.report_summaries.chat_completion")
    def test_create_report_summary_uses_llm_markdown_when_available(self, chat):
        self.client.force_login(self.user)
        chat.return_value = {
            "content": "# 今日学习总结\n\n## 今天学了什么\n- LLM 生成的进程调度总结\n\n## 下一步建议\n- 复盘时间片轮转",
            "provider": "dashscope",
            "model": "qwen-plus",
            "finishReason": "stop",
            "usage": {"total_tokens": 128},
        }

        response = self.client.post(
            reverse("learning-report-summaries"),
            data=json.dumps({"prompt": "请用 markdown 总结今天"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        document = response.json()["document"]
        self.assertIn("LLM 生成的进程调度总结", document["contentMd"])
        self.assertEqual(document["sourceSnapshot"]["generation"]["source"], "llm")
        self.assertEqual(document["sourceSnapshot"]["generation"]["provider"], "dashscope")
        chat.assert_called_once()

    @patch("backend.apps.learning.report_summaries.chat_completion")
    def test_create_report_summary_falls_back_when_llm_unavailable(self, chat):
        self.client.force_login(self.user)
        chat.side_effect = LLMUnavailable("no key")

        response = self.client.post(
            reverse("learning-report-summaries"),
            data=json.dumps({"prompt": "总结今天"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        document = response.json()["document"]
        self.assertIn("# 今日学习总结", document["contentMd"])
        self.assertEqual(document["sourceSnapshot"]["generation"]["source"], "rules_fallback")
        self.assertIn("no key", document["sourceSnapshot"]["generation"]["degradedReason"])
