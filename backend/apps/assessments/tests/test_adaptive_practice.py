import json

from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.assessments.models import (
    Question,
    QuestionEvidence,
    QuestionReviewStatus,
    QuestionSourceType,
    StudentQuestionMastery,
    WrongQuestion,
)
from backend.apps.assessments.services import create_assessment, serialize_session
from backend.apps.assessments.verification import verify_question
from backend.apps.knowledge_base.models import KnowledgeResource, ResourceScope
from backend.apps.learning.models import Course, KnowledgePoint


class AdaptivePracticeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009995", password="TestPassword123")
        self.other = User.objects.create_user(phone="13800009996", password="TestPassword123")
        course = Course.objects.get(code="AUTO-CONTROL-001")
        points = list(KnowledgePoint.objects.filter(chapter__course=course).order_by("chapter__order", "order")[:2])
        self.point = points[0]
        self.other_point = points[1] if len(points) > 1 else points[0]
        self.resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="personal.pdf",
            stored_path="tmp/personal.pdf",
            file_type="pdf",
            file_size=1024,
            resource_scope=ResourceScope.PERSONAL,
        )

    def _question(self, *, point=None, difficulty=2, owner=None, source_type=QuestionSourceType.TEACHER, status=QuestionReviewStatus.APPROVED):
        return Question.objects.create(
            knowledge_point=point or self.point,
            stem=f"测试题 {difficulty} 的关键考查点是什么？",
            options=[
                {"key": "A", "text": "核心概念"},
                {"key": "B", "text": "无关术语"},
                {"key": "C", "text": "随机结论"},
                {"key": "D", "text": "题外信息"},
            ],
            correct_answer="A",
            explanation="该题用于检查学生是否理解当前知识点的核心概念。",
            difficulty=difficulty,
            source_type=source_type,
            review_status=status,
            scope="personal" if owner else "global",
            owner=owner,
            is_active=True,
        )

    def _personal_verified_question(self, owner):
        question = self._question(
            owner=owner,
            source_type=QuestionSourceType.PERSONAL_GENERATED,
            status=QuestionReviewStatus.DRAFT,
            difficulty=1,
        )
        QuestionEvidence.objects.create(
            question=question,
            resource=self.resource,
            block_id="block-1",
            page_number=1,
            quote="个人资料中的核心概念说明。",
            modality="text",
            score=0.9,
        )
        verify_question(question)
        return question

    def test_adaptive_practice_prioritizes_recent_wrong_knowledge_point(self):
        Question.objects.all().update(is_active=False)
        weak_question = self._question(point=self.point, difficulty=3)
        other_question = self._question(point=self.other_point, difficulty=1)
        WrongQuestion.objects.create(user=self.user, question=weak_question, wrong_count=3)

        session = create_assessment(self.user, force=True, mode="practice", strategy="adaptive", limit=1)

        self.assertEqual(session.question_ids, [str(weak_question.id)])
        self.assertNotIn(str(other_question.id), session.question_ids)

    def test_adaptive_practice_includes_own_auto_verified_personal_question_only(self):
        Question.objects.all().update(is_active=False)
        own_question = self._personal_verified_question(self.user)
        other_question = self._personal_verified_question(self.other)
        approved = self._question(difficulty=5)

        session = create_assessment(self.user, force=True, mode="practice", strategy="adaptive", limit=3)

        self.assertIn(str(own_question.id), session.question_ids)
        self.assertIn(str(approved.id), session.question_ids)
        self.assertNotIn(str(other_question.id), session.question_ids)

    def test_answer_updates_student_question_mastery(self):
        Question.objects.all().update(is_active=False)
        question = self._question(difficulty=1)
        session = create_assessment(self.user, force=True, mode="assessment", limit=1)
        client = Client()
        client.force_login(self.user)

        response = client.post(
            f"/api/assessments/sessions/{session.id}/answer/",
            data=json.dumps({"selectedAnswer": question.correct_answer}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        mastery = StudentQuestionMastery.objects.get(user=self.user, knowledge_point=question.knowledge_point)
        self.assertEqual(mastery.attempts, 1)
        self.assertEqual(mastery.correct, 1)
        self.assertGreater(mastery.mastery_score, 0.5)
