import json
from unittest.mock import patch

from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.assessments.models import (
    Question,
    QuestionEvidence,
    QuestionGenerationJob,
    QuestionQualityCheck,
    QuestionReviewStatus,
    QuestionSourceType,
    QuestionType,
    StudentQuestionMastery,
)
from backend.apps.assessments.services import create_assessment, serialize_session
from backend.apps.assessments.verification import verify_question
from backend.apps.compat.models import AgentRun
from backend.apps.knowledge_base.models import KnowledgeResource, ResourceScope
from backend.apps.learning.models import Course


class QuestionBankMetadataTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009991", password="TestPassword123")
        course = Course.objects.get(code="AUTO-CONTROL-001")
        self.point = course.chapters.first().knowledge_points.first()

    def test_seeded_questions_have_safe_question_bank_defaults(self):
        question = Question.objects.filter(is_active=True).first()

        self.assertIsNotNone(question)
        self.assertEqual(question.question_type, QuestionType.SINGLE_CHOICE)
        self.assertEqual(question.source_type, QuestionSourceType.SEEDED)
        self.assertEqual(question.review_status, QuestionReviewStatus.APPROVED)
        self.assertEqual(question.scope, "global")
        self.assertIsNone(question.owner)
        self.assertEqual(question.quality_score, 1.0)
        self.assertEqual(question.metadata, {})

    def test_generated_question_can_store_evidence_quality_and_job_state(self):
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="control.pptx",
            stored_path="tmp/control.pptx",
            file_type="pptx",
            file_size=1024,
            resource_scope=ResourceScope.PERSONAL,
        )
        job = QuestionGenerationJob.objects.create(
            user=self.user,
            knowledge_point=self.point,
            resource=resource,
            scope="personal",
            requested_count=2,
        )
        question = Question.objects.create(
            knowledge_point=self.point,
            stem="负反馈控制系统的主要作用是什么？",
            options=[
                {"key": "A", "text": "增大稳态误差"},
                {"key": "B", "text": "改善稳定性并抑制扰动"},
                {"key": "C", "text": "取消传感器"},
                {"key": "D", "text": "使输出恒为零"},
            ],
            correct_answer="B",
            explanation="负反馈通常可以减小误差并提高系统抗扰能力。",
            difficulty=2,
            source_type=QuestionSourceType.PERSONAL_GENERATED,
            review_status=QuestionReviewStatus.DRAFT,
            scope="personal",
            owner=self.user,
            source_resource=resource,
            source_block_id="slide-1",
            evidence_summary="课件第 1 页说明了负反馈的抗扰作用。",
            generation_job=job,
        )
        evidence = QuestionEvidence.objects.create(
            question=question,
            resource=resource,
            block_id="slide-1",
            page_number=1,
            preview_url="/api/kb/resources/example/preview/1",
            quote="负反馈可抑制扰动并改善性能。",
            modality="visual",
            score=0.88,
        )
        check = QuestionQualityCheck.objects.create(
            question=question,
            checker="rule_based",
            passed=True,
            score=0.86,
            issues=[],
            evidence={"evidenceCount": 1},
        )

        question.refresh_from_db()
        self.assertEqual(question.evidence_items.count(), 1)
        self.assertEqual(question.quality_checks.count(), 1)
        self.assertEqual(question.evidence_items.first(), evidence)
        self.assertEqual(question.quality_checks.first(), check)
        self.assertEqual(question.source_resource, resource)
        self.assertEqual(question.generation_job, job)

    def test_student_question_mastery_is_unique_per_user_and_knowledge_point(self):
        mastery = StudentQuestionMastery.objects.create(
            user=self.user,
            knowledge_point=self.point,
            attempts=3,
            correct=2,
            mastery_score=0.67,
        )

        self.assertEqual(str(mastery.user_id), str(self.user.id))
        self.assertEqual(mastery.knowledge_point, self.point)
        self.assertEqual(mastery.mastery_score, 0.67)


class QuestionVerificationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009992", password="TestPassword123")
        course = Course.objects.get(code="AUTO-CONTROL-001")
        self.point = course.chapters.first().knowledge_points.first()
        self.resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="root-locus.pdf",
            stored_path="tmp/root-locus.pdf",
            file_type="pdf",
            file_size=2048,
            resource_scope=ResourceScope.PERSONAL,
        )

    def _generated_question(self, **overrides):
        with_evidence = overrides.pop("with_evidence", True)
        payload = {
            "knowledge_point": self.point,
            "stem": "根轨迹描述的是哪一类点随参数变化的轨迹？",
            "options": [
                {"key": "A", "text": "闭环极点"},
                {"key": "B", "text": "开环零点"},
                {"key": "C", "text": "输入信号"},
                {"key": "D", "text": "传感器型号"},
            ],
            "correct_answer": "A",
            "explanation": "根轨迹描述闭环特征方程的根随开环增益等参数变化的轨迹，因此答案是闭环极点。",
            "difficulty": 2,
            "source_type": QuestionSourceType.PERSONAL_GENERATED,
            "review_status": QuestionReviewStatus.DRAFT,
            "scope": "personal",
            "owner": self.user,
            "source_resource": self.resource,
        }
        payload.update(overrides)
        question = Question.objects.create(**payload)
        if with_evidence:
            QuestionEvidence.objects.create(
                question=question,
                resource=self.resource,
                block_id="page-2",
                page_number=2,
                quote="根轨迹是闭环特征根随参数变化的轨迹。",
                modality="text",
                score=0.91,
            )
        return question

    def test_verify_question_accepts_grounded_generated_question(self):
        question = self._generated_question()

        result = verify_question(question)

        question.refresh_from_db()
        self.assertTrue(result.passed)
        self.assertGreaterEqual(result.score, 0.8)
        self.assertEqual(result.next_status, QuestionReviewStatus.AUTO_VERIFIED)
        self.assertEqual(question.review_status, QuestionReviewStatus.AUTO_VERIFIED)
        self.assertEqual(question.quality_checks.count(), 1)
        self.assertTrue(question.quality_checks.first().passed)

    def test_verify_question_rejects_generated_question_without_evidence(self):
        question = self._generated_question(with_evidence=False)

        result = verify_question(question)

        question.refresh_from_db()
        self.assertFalse(result.passed)
        self.assertEqual(question.review_status, QuestionReviewStatus.REJECTED)
        self.assertIn("missing_evidence", [issue["code"] for issue in result.issues])

    def test_verify_question_rejects_invalid_answer_key(self):
        question = self._generated_question(correct_answer="Z")

        result = verify_question(question)

        question.refresh_from_db()
        self.assertFalse(result.passed)
        self.assertEqual(question.review_status, QuestionReviewStatus.REJECTED)
        self.assertIn("invalid_answer", [issue["code"] for issue in result.issues])

    def test_verify_question_rejects_weak_explanation(self):
        question = self._generated_question(explanation="A")

        result = verify_question(question)

        question.refresh_from_db()
        self.assertFalse(result.passed)
        self.assertEqual(question.review_status, QuestionReviewStatus.REJECTED)
        self.assertIn("weak_explanation", [issue["code"] for issue in result.issues])

    def test_formal_assessment_excludes_auto_verified_personal_questions(self):
        Question.objects.all().update(is_active=False)
        generated = self._generated_question()
        generated.difficulty = 1
        generated.save(update_fields=["difficulty"])
        verify_question(generated)
        approved = Question.objects.create(
            knowledge_point=self.point,
            stem="正式测评应该使用哪类题目？",
            options=[
                {"key": "A", "text": "已审核题"},
                {"key": "B", "text": "草稿题"},
                {"key": "C", "text": "已拒绝题"},
                {"key": "D", "text": "其他用户私有题"},
            ],
            correct_answer="A",
            explanation="正式测评必须使用已审核题，保证答案和解析稳定。",
            difficulty=5,
            source_type=QuestionSourceType.TEACHER,
            review_status=QuestionReviewStatus.APPROVED,
            scope="global",
            is_active=True,
        )

        session = create_assessment(self.user, force=True, mode="assessment", limit=1)
        payload = serialize_session(session)

        self.assertNotEqual(payload["currentQuestion"]["id"], str(generated.id))
        self.assertEqual(payload["currentQuestion"]["id"], str(approved.id))


class QuestionGenerationApiTests(TestCase):
    def setUp(self):
        self.student = User.objects.create_user(phone="13800009993", password="TestPassword123")
        self.teacher = User.objects.create_user(phone="13800009994", password="TestPassword123", role="teacher")
        course = Course.objects.get(code="AUTO-CONTROL-001")
        self.point = course.chapters.first().knowledge_points.first()
        self.resource = KnowledgeResource.objects.create(
            owner=self.student,
            original_name="student-material.pdf",
            stored_path="tmp/student-material.pdf",
            file_type="pdf",
            file_size=2048,
            resource_scope=ResourceScope.PERSONAL,
        )

    def test_generate_questions_requires_login(self):
        response = self.client.post(
            "/api/assessments/questions/generate/",
            data=json.dumps({"resourceId": str(self.resource.id), "count": 2}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 401)

    def test_student_can_only_generate_personal_question_jobs(self):
        self.client.force_login(self.student)

        response = self.client.post(
            "/api/assessments/questions/generate/",
            data=json.dumps({"resourceId": str(self.resource.id), "scope": "teacher", "count": 2}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(QuestionGenerationJob.objects.exists())

    @patch.dict(
        "os.environ",
        {"A3_LLM_API_KEY": "", "DASHSCOPE_API_KEY": "", "OPENAI_API_KEY": ""},
        clear=False,
    )
    def test_generate_questions_without_llm_key_creates_failed_job_without_fake_questions(self):
        self.client.force_login(self.student)

        response = self.client.post(
            "/api/assessments/questions/generate/",
            data=json.dumps({
                "resourceId": str(self.resource.id),
                "knowledgePointId": str(self.point.id),
                "scope": "personal",
                "count": 2,
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertTrue(payload.get("traceId"))
        self.assertIn("API Key", payload["error"])
        job = QuestionGenerationJob.objects.get(user=self.student)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.requested_count, 2)
        self.assertEqual(job.generated_count, 0)
        self.assertEqual(Question.objects.filter(generation_job=job).count(), 0)
        steps = list(AgentRun.objects.get(trace_id=payload["traceId"]).steps.values_list("name", flat=True))
        self.assertEqual(steps, ["QuestionGeneratorAgent", "QuestionVerifierAgent"])

    def test_student_lists_only_own_personal_candidates(self):
        other = User.objects.create_user(phone="13800009997", password="TestPassword123")
        own = Question.objects.create(
            knowledge_point=self.point,
            stem="我的资料生成题是否只对本人可见？",
            options=[
                {"key": "A", "text": "是"},
                {"key": "B", "text": "否"},
                {"key": "C", "text": "公开给所有人"},
                {"key": "D", "text": "只给管理员"},
            ],
            correct_answer="A",
            explanation="个人资料生成题默认只对资料所有者可见。",
            source_type=QuestionSourceType.PERSONAL_GENERATED,
            review_status=QuestionReviewStatus.AUTO_VERIFIED,
            scope="personal",
            owner=self.student,
            is_active=True,
        )
        QuestionEvidence.objects.create(
            question=own,
            resource=self.resource,
            quote="个人资料生成题只进入个人题库。",
            modality="text",
            score=0.8,
        )
        Question.objects.create(
            knowledge_point=self.point,
            stem="其他人的个人题",
            options=[{"key": "A", "text": "A"}, {"key": "B", "text": "B"}, {"key": "C", "text": "C"}, {"key": "D", "text": "D"}],
            correct_answer="A",
            explanation="其他人的个人题不能被当前学生列出。",
            source_type=QuestionSourceType.PERSONAL_GENERATED,
            review_status=QuestionReviewStatus.AUTO_VERIFIED,
            scope="personal",
            owner=other,
            is_active=True,
        )
        self.client.force_login(self.student)

        response = self.client.get("/api/assessments/questions/?scope=personal")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        ids = [item["id"] for item in payload["questions"]]
        self.assertIn(str(own.id), ids)
        self.assertEqual(len(ids), 1)
        self.assertEqual(payload["questions"][0]["evidence"][0]["quote"], "个人资料生成题只进入个人题库。")

    def test_teacher_can_review_auto_verified_question(self):
        question = Question.objects.create(
            knowledge_point=self.point,
            stem="教师是否可以审核候选题？",
            options=[
                {"key": "A", "text": "可以"},
                {"key": "B", "text": "不可以"},
                {"key": "C", "text": "只能学生审核"},
                {"key": "D", "text": "只能系统审核"},
            ],
            correct_answer="A",
            explanation="教师可以把自动验证候选题审核通过为正式题。",
            source_type=QuestionSourceType.KB_GENERATED,
            review_status=QuestionReviewStatus.AUTO_VERIFIED,
            scope="teacher",
            is_active=True,
        )
        self.client.force_login(self.teacher)

        response = self.client.post(
            f"/api/assessments/questions/{question.id}/review/",
            data=json.dumps({"action": "approve", "reason": "答案唯一，解析可用"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        question.refresh_from_db()
        self.assertEqual(question.review_status, QuestionReviewStatus.APPROVED)
        self.assertTrue(question.is_active)
        self.assertEqual(question.metadata["reviewReason"], "答案唯一，解析可用")

    def test_student_cannot_review_question(self):
        question = Question.objects.create(
            knowledge_point=self.point,
            stem="学生是否可以审核公共题？",
            options=[{"key": "A", "text": "A"}, {"key": "B", "text": "B"}, {"key": "C", "text": "C"}, {"key": "D", "text": "D"}],
            correct_answer="A",
            explanation="学生不具备题库审核权限。",
            source_type=QuestionSourceType.KB_GENERATED,
            review_status=QuestionReviewStatus.AUTO_VERIFIED,
            scope="teacher",
            is_active=True,
        )
        self.client.force_login(self.student)

        response = self.client.post(
            f"/api/assessments/questions/{question.id}/review/",
            data=json.dumps({"action": "approve"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 403)
