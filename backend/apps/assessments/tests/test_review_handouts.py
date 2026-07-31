from __future__ import annotations

from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.assessments.models import Question, WrongQuestion
from backend.apps.learning.models import Chapter, Course, KnowledgePoint
from backend.apps.profiles.models import LearnerProfile


class ReviewHandoutDomainTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            phone="13800003333",
            password="TestPassword123",
            display_name="讲义同学",
        )
        LearnerProfile.objects.create(user=self.user, weak_points=["死锁"])
        course = Course.objects.create(code="HANDOUT-001", title="操作系统")
        chapter = Chapter.objects.create(course=course, order=1, title="进程管理")
        self.deadlock = KnowledgePoint.objects.create(
            chapter=chapter, code="HANDOUT-KP-1", order=1, title="死锁"
        )
        self.scheduling = KnowledgePoint.objects.create(
            chapter=chapter, code="HANDOUT-KP-2", order=2, title="进程调度"
        )
        self._wrong(
            self.deadlock,
            "死锁条件题",
            wrong_count=4,
            review_after=timezone.now() - timedelta(days=2),
        )
        self._wrong(
            self.scheduling,
            "调度算法题",
            wrong_count=2,
            review_after=timezone.now() + timedelta(days=2),
        )

    def _wrong(self, point, stem, *, wrong_count, review_after):
        question = Question.objects.create(
            knowledge_point=point,
            stem=stem,
            options=[
                {"key": "A", "text": "选项一"},
                {"key": "B", "text": "选项二"},
            ],
            correct_answer="B",
            explanation=f"{point.title}的可信题目解析。",
            error_cause=f"{point.title}概念混淆",
        )
        return WrongQuestion.objects.create(
            user=self.user,
            question=question,
            wrong_count=wrong_count,
            last_wrong_answer="A",
            review_after=review_after,
        )

    def test_rank_weak_points_uses_wrong_history_due_state_and_profile(self):
        from backend.apps.assessments.review_handouts import create_snapshot, rank_weak_points

        snapshot = create_snapshot(self.user, "active")
        ranked = rank_weak_points(snapshot)

        self.assertEqual(ranked[0]["knowledgePoint"], "死锁")
        self.assertGreater(ranked[0]["score"], ranked[1]["score"])
        self.assertEqual(ranked[0]["activeCount"], 1)
        self.assertEqual(ranked[0]["wrongCount"], 4)
        self.assertTrue(ranked[0]["profileMatched"])
        self.assertTrue(ranked[0]["dueCount"])

    def test_create_review_handout_job_reuses_active_identical_snapshot(self):
        from backend.apps.assessments.review_handouts import create_review_handout_job

        first, first_created = create_review_handout_job(self.user, "active")
        second, second_created = create_review_handout_job(self.user, "active")

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first.id, second.id)
        self.assertEqual(first.status, "queued")
        self.assertEqual(first.snapshot_hash, second.snapshot_hash)
        self.assertEqual(first.snapshot["studentName"], "讲义同学")
        self.assertEqual(len(first.ranked_weak_points), 2)

    def test_serialize_review_handout_job_never_exposes_server_paths(self):
        from backend.apps.assessments.review_handouts import (
            create_review_handout_job,
            serialize_review_handout_job,
        )

        job, _ = create_review_handout_job(self.user, "active")
        job.status = "succeeded"
        job.docx_path = "D:/private/review.docx"
        job.pdf_path = "D:/private/review.pdf"
        job.save(update_fields=["status", "docx_path", "pdf_path", "updated_at"])

        payload = serialize_review_handout_job(job)
        rendered = str(payload)
        self.assertNotIn("D:/private", rendered)
        self.assertTrue(payload["docxDownloadUrl"].endswith("/download/docx/"))
        self.assertTrue(payload["pdfDownloadUrl"].endswith("/download/pdf/"))
