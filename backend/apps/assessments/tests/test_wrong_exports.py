from __future__ import annotations

from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.assessments.models import Question, WrongQuestion
from backend.apps.learning.models import Chapter, Course, KnowledgePoint
from backend.apps.profiles.models import LearnerProfile


class WrongExportDomainTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13800001111",
            password="TestPassword123",
            display_name="测试同学",
        )
        self.other_user = User.objects.create_user(
            phone="13800002222",
            password="TestPassword123",
            display_name="其他同学",
        )
        LearnerProfile.objects.create(user=self.user, weak_points=["进程调度"])
        course = Course.objects.create(code="EXPORT-001", title="操作系统导出测试")
        chapter = Chapter.objects.create(course=course, order=1, title="处理机管理")
        self.point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="EXPORT-KP-001",
            order=1,
            title="进程调度",
        )
        now = timezone.now()
        self.future = self._wrong(self.user, "未来复习题", review_after=now + timedelta(days=2))
        self.due = self._wrong(self.user, "今日到期题", review_after=now - timedelta(hours=1), wrong_count=3)
        self.mastered = self._wrong(self.user, "已掌握题", review_after=now - timedelta(days=2), mastered=True)
        self.other = self._wrong(self.other_user, "其他用户题", review_after=now - timedelta(days=1))

    def _wrong(
        self,
        user,
        stem: str,
        *,
        review_after,
        mastered: bool = False,
        wrong_count: int = 1,
    ) -> WrongQuestion:
        question = Question.objects.create(
            knowledge_point=self.point,
            stem=stem,
            options=[
                {"key": "A", "text": "先来先服务"},
                {"key": "B", "text": "时间片轮转"},
            ],
            correct_answer="B",
            explanation="时间片轮转会周期性地把处理机分配给就绪进程。",
            error_cause="混淆了非抢占式与抢占式调度",
        )
        wrong = WrongQuestion.objects.create(
            user=user,
            question=question,
            wrong_count=wrong_count,
            mastered=mastered,
            last_wrong_answer="A",
            review_after=review_after,
        )
        return wrong

    def test_select_wrong_questions_supports_all_scopes_and_owner_isolation(self):
        from backend.apps.assessments.wrong_exports import select_wrong_questions

        self.assertEqual(
            {item.id for item in select_wrong_questions(self.user, "active")},
            {self.future.id, self.due.id},
        )
        self.assertEqual(
            {item.id for item in select_wrong_questions(self.user, "due")},
            {self.due.id},
        )
        self.assertEqual(
            {item.id for item in select_wrong_questions(self.user, "mastered")},
            {self.mastered.id},
        )
        self.assertEqual(
            {item.id for item in select_wrong_questions(self.user, "all")},
            {self.future.id, self.due.id, self.mastered.id},
        )

    def test_select_wrong_questions_rejects_unknown_scope(self):
        from backend.apps.assessments.wrong_exports import WrongExportRequestError, select_wrong_questions

        with self.assertRaisesMessage(WrongExportRequestError, "导出范围"):
            select_wrong_questions(self.user, "private")

    def test_snapshot_contains_answers_sources_and_stable_summary(self):
        from backend.apps.assessments.wrong_exports import build_wrong_question_snapshot, select_wrong_questions

        snapshot = build_wrong_question_snapshot(
            self.user,
            "active",
            select_wrong_questions(self.user, "active"),
        )

        self.assertEqual(snapshot["schemaVersion"], "1.0")
        self.assertEqual(snapshot["scope"], "active")
        self.assertEqual(snapshot["studentName"], "测试同学")
        self.assertEqual(snapshot["summary"]["totalCount"], 2)
        self.assertEqual(snapshot["summary"]["activeCount"], 2)
        self.assertEqual(snapshot["summary"]["masteredCount"], 0)
        self.assertEqual(snapshot["summary"]["knowledgePoints"], ["进程调度"])
        row = next(item for item in snapshot["questions"] if item["stem"] == "今日到期题")
        self.assertEqual(row["correctAnswer"], "B")
        self.assertEqual(row["lastWrongAnswer"], "A")
        self.assertIn("时间片轮转", row["explanation"])
        self.assertEqual(row["chapter"], "处理机管理")
        self.assertEqual(row["course"], "操作系统导出测试")
        self.assertNotIn("phone", snapshot)

