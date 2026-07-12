import json
from datetime import timedelta
from unittest.mock import patch

from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.assessments.models import AssessmentAnswer, AssessmentSession, Question, QuestionReviewStatus, QuestionSourceType, WrongQuestion
from backend.apps.engagement.models import UserNotification
from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgeResource, ResourceScope, ResourceStatus
from backend.apps.learning.models import Course, ResourcePackLog
from backend.apps.learning.services import default_course, generate_learning_path
from backend.apps.profiles.models import LearnerProfile


class AssessmentFlowTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800008888", password="TestPassword123")
        LearnerProfile.objects.create(user=self.user, foundation_level="基础", weak_points=["虚拟内存"])
        generate_learning_path(self.user, default_course())
        self.client = Client()
        self.client.force_login(self.user)

    def test_current_assessment_uses_seeded_questions(self):
        response = self.client.get("/api/assessments/current/")
        self.assertEqual(response.status_code, 200)
        payload = response.json()["session"]
        self.assertGreater(payload["totalQuestions"], 0)
        self.assertNotIn("correctAnswer", payload["currentQuestion"])

    def test_current_assessment_replaces_demo_or_invalid_questions(self):
        point = Course.objects.get(code="OS-001").chapters.first().knowledge_points.first()
        demo_question = Question.objects.create(
            knowledge_point=point,
            stem="Agent workflow demo assessment question",
            options=["A", "B", "C", "D"],
            correct_answer="A",
            explanation="Demo explanation",
            error_cause="Demo weak-point cause",
        )
        AssessmentSession.objects.create(user=self.user, question_ids=[str(demo_question.id)])

        response = self.client.get("/api/assessments/current/")

        self.assertEqual(response.status_code, 200)
        session = response.json()["session"]
        self.assertGreater(session["totalQuestions"], 0)
        self.assertNotEqual(session["currentQuestion"]["stem"], "Agent workflow demo assessment question")
        self.assertIsInstance(session["currentQuestion"]["options"][0], dict)

    def test_wrong_answer_creates_wrong_notebook_record(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        response = self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["isCorrect"])
        self.assertEqual(WrongQuestion.objects.filter(user=self.user).count(), 1)

    def test_wrong_answer_updates_profile_review_queue_and_notification(self):
        session = self.client.get("/api/assessments/current/").json()["session"]

        response = self.client.post(
            "/api/assess/grade/",
            data=json.dumps({"sessionId": session["id"], "selectedAnswer": "Z"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        wrong = WrongQuestion.objects.select_related("question__knowledge_point").get(user=self.user)
        profile = LearnerProfile.objects.get(user=self.user)
        plan = profile.extra_profile["studyPlan"]
        review_item = plan["reviewQueue"][0]
        signal_sources = {signal.get("source") for signal in profile.extra_profile.get("profileSignals", [])}
        self.assertIn(wrong.question.knowledge_point.title, profile.weak_points)
        self.assertIn("wrong_question_sync", signal_sources)
        self.assertIn("profileSnapshot", profile.extra_profile)
        self.assertEqual(review_item["wrongQuestionId"], str(wrong.id))
        self.assertEqual(review_item["knowledgePoint"], wrong.question.knowledge_point.title)
        self.assertEqual(review_item["status"], "scheduled")
        self.assertEqual(review_item["href"], "/a3/wrong-notebook")
        self.assertTrue(
            UserNotification.objects.filter(
                user=self.user,
                action_url="/a3/wrong-notebook",
                payload__wrongQuestionId=str(wrong.id),
            ).exists()
        )

    def test_wrong_answer_sync_handles_legacy_bad_weak_points(self):
        course = Course.objects.get(code="OS-001")
        point = course.chapters.first().knowledge_points.first()
        question = Question.objects.create(
            knowledge_point=point,
            stem="legacy weak points regression question",
            options=[
                {"key": "A", "text": "correct"},
                {"key": "B", "text": "wrong"},
                {"key": "C", "text": "wrong again"},
                {"key": "D", "text": "wrong once more"},
            ],
            correct_answer="A",
            explanation="This long explanation should not become a mistake pattern signal.",
            error_cause="bounded misconception",
        )
        profile = LearnerProfile.objects.get(user=self.user)
        profile.weak_points = "legacy-bad-value"
        profile.save(update_fields=["weak_points", "updated_at"])
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id)])

        response = self.client.post(
            "/api/assess/grade/",
            data=json.dumps({"sessionId": str(session.id), "selectedAnswer": "B"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        profile.refresh_from_db()
        signal_sources = {signal.get("source") for signal in profile.extra_profile.get("profileSignals", [])}
        mistake_signal = next(
            signal
            for signal in profile.extra_profile.get("profileSignals", [])
            if signal.get("source") == "assessment_wrong_answer"
        )
        self.assertIn("wrong_question_sync", signal_sources)
        self.assertIn(point.title, profile.weak_points)
        self.assertIn("profileSnapshot", profile.extra_profile)
        self.assertEqual(mistake_signal.get("value"), ["bounded misconception"])

    def test_two_correct_retries_mark_wrong_question_mastered(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}), content_type="application/json",
        )
        wrong = WrongQuestion.objects.select_related("question").get(user=self.user)
        for _ in range(2):
            response = self.client.post(
                f"/api/assessments/wrong-questions/{wrong.id}/retry/",
                data=json.dumps({"selectedAnswer": wrong.question.correct_answer}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200)
        wrong.refresh_from_db()
        self.assertTrue(wrong.mastered)
        profile = LearnerProfile.objects.get(user=self.user)
        review_queue = profile.extra_profile["studyPlan"]["reviewQueue"]
        self.assertNotIn(str(wrong.id), [item["wrongQuestionId"] for item in review_queue])

    def test_report_aggregates_real_answers(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}), content_type="application/json",
        )
        report = self.client.get("/api/assessments/report/").json()["report"]
        self.assertEqual(report["metrics"]["answeredQuestions"], 1)
        self.assertEqual(report["metrics"]["accuracy"], 0)
        self.assertEqual(report["metrics"]["activeWrongQuestions"], 1)
        self.assertIn("weeklySummary", report)
        self.assertIn("weeklyPrescription", report)
        self.assertGreaterEqual(len(report["weeklyPrescription"]["nextWeekActions"]), 1)
        self.assertTrue(report["weeklyPrescription"]["primaryAction"]["href"].startswith("/a3/"))

    def test_report_period_filters_answer_metrics(self):
        questions = list(Question.objects.all()[:2])
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id) for question in questions])
        old_answer = AssessmentAnswer.objects.create(session=session, question=questions[0], selected_answer="A", is_correct=False)
        AssessmentAnswer.objects.filter(id=old_answer.id).update(answered_at=timezone.now() - timedelta(days=40))
        current_answer = AssessmentAnswer.objects.create(session=session, question=questions[1], selected_answer=questions[1].correct_answer, is_correct=True)
        AssessmentAnswer.objects.filter(id=current_answer.id).update(answered_at=timezone.now())

        term_report = self.client.get("/api/assessments/report/?period=term").json()["report"]
        week_report = self.client.get("/api/assessments/report/?period=7d").json()["report"]

        self.assertEqual(term_report["period"]["key"], "term")
        self.assertEqual(week_report["period"]["key"], "7d")
        self.assertEqual(term_report["metrics"]["answeredQuestions"], 2)
        self.assertEqual(week_report["metrics"]["answeredQuestions"], 1)
        self.assertEqual(week_report["metrics"]["accuracy"], 100)
        self.assertEqual(len(week_report["trends"]), 7)

    def test_report_includes_wrong_review_insight(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )
        wrong = WrongQuestion.objects.select_related("question__knowledge_point").get(user=self.user)

        report = self.client.get("/api/assessments/report/").json()["report"]
        insight = report["wrongReviewInsight"]

        self.assertEqual(insight["schemaVersion"], "a3.wrong-review-insight.v1")
        self.assertEqual(insight["activeWrongQuestions"], 1)
        self.assertEqual(insight["masteredWrongQuestions"], 0)
        self.assertIn(wrong.question.knowledge_point.title, insight["recentKnowledgePoints"])
        self.assertEqual(insight["nextAction"]["href"], "/a3/wrong-notebook")
        self.assertTrue(insight["summary"])

    def test_report_includes_weekly_reflection_summary(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "dailyReflections": [
                {
                    "reflectionId": "r1",
                    "date": "2999-01-01",
                    "summary": "I understood the main idea.",
                    "confusion": "",
                    "confidence": 4,
                    "todayProgress": 80,
                    "createdAt": "2999-01-01T00:00:00",
                }
            ],
            "studyPlan": {
                "planId": "p1",
                "days": [
                    {
                        "tasks": [
                            {"id": "t1", "status": "completed"},
                            {"id": "t2", "status": "pending", "rolledOverFrom": {"dayIndex": 1}},
                        ]
                    }
                ],
                "lastTaskFeedback": {"headline": "Practice completed."},
            },
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        report = self.client.get("/api/assessments/report/").json()["report"]

        self.assertEqual(report["weeklySummary"]["reflectionCount"], 1)
        self.assertEqual(report["weeklySummary"]["averageConfidence"], 4)
        self.assertEqual(report["weeklySummary"]["planCompletion"], 50)
        self.assertEqual(report["weeklySummary"]["rolloverTasks"], 1)

    def test_report_weekly_summary_explains_latest_plan_change(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "studyPlan": {
                "planId": "plan-change-report",
                "days": [
                    {
                        "tasks": [
                            {"id": "resource-pack:root-locus", "status": "pending"},
                        ]
                    }
                ],
                "explanation": {
                    "currentChange": {
                        "id": "resource-pack:root-locus",
                        "type": "resource_pack",
                        "title": "资源包加入今日任务",
                        "detail": "已将《root locus》加入今日任务。",
                        "reason": "用户从资源推荐页主动加入，系统将推荐结果回流到学习计划。",
                        "impact": "今日新增 1 个资源包任务",
                        "createdAt": "2999-01-01T00:00:00+00:00",
                    },
                    "adjustments": [
                        {
                            "id": "resource-pack:root-locus",
                            "type": "resource_pack",
                            "title": "资源包加入今日任务",
                            "reason": "用户从资源推荐页主动加入，系统将推荐结果回流到学习计划。",
                            "impact": "今日新增 1 个资源包任务",
                            "createdAt": "2999-01-01T00:00:00+00:00",
                        }
                    ],
                    "nextAction": {
                        "label": "查看今日资源包任务",
                        "href": "/a3/today",
                        "reason": "最近计划变化来自推荐资源包加入，完成今日任务后会继续回流到画像和练习。",
                    },
                },
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        report = self.client.get("/api/assessments/report/").json()["report"]
        plan_change = report["weeklySummary"]["planChange"]

        self.assertEqual(plan_change["schemaVersion"], "a3.report-plan-change.v1")
        self.assertEqual(plan_change["currentChange"]["type"], "resource_pack")
        self.assertEqual(plan_change["nextAction"]["href"], "/a3/today")
        self.assertEqual(plan_change["recentAdjustments"][0]["id"], "resource-pack:root-locus")

    def test_report_prescription_explains_weekly_target(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "studyPlan": {
                "planId": "p2",
                "overallProgress": 40,
                "days": [
                    {
                        "tasks": [
                            {"id": "t1", "status": "completed"},
                            {"id": "t2", "status": "pending"},
                            {"id": "t3", "status": "pending", "rolledOverFrom": {"dayIndex": 1}},
                        ]
                    }
                ],
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        report = self.client.get("/api/assessments/report/").json()["report"]
        prescription = report["weeklyPrescription"]

        self.assertIn("weeklyTarget", prescription)
        self.assertEqual(prescription["weeklyTarget"]["current"], 1)
        self.assertEqual(prescription["weeklyTarget"]["target"], 3)
        self.assertIn("reason", prescription["weeklyTarget"])
        self.assertIn("diagnosis", prescription)
        self.assertIn("headline", prescription["diagnosis"])
        self.assertIn("evidence", prescription["diagnosis"])
        self.assertGreaterEqual(len(prescription["focusAreas"]), 1)
        self.assertGreaterEqual(len(prescription["completionCriteria"]), 2)
        self.assertGreaterEqual(len(prescription["nextWeekActions"]), 2)

    def test_report_includes_continuous_action_loop(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}), content_type="application/json",
        )

        report = self.client.get("/api/assessments/report/").json()["report"]
        action_loop = report["actionLoop"]

        self.assertEqual(action_loop["schemaVersion"], "a3.report-action-loop.v1")
        self.assertIn("continuityMessage", action_loop)
        self.assertIn("primaryReason", action_loop)
        self.assertEqual(action_loop["primaryAction"]["href"], "/a3/wrong-notebook")
        self.assertEqual([step["kind"] for step in action_loop["steps"]], ["today", "review", "plan"])
        self.assertTrue(all(step["href"].startswith("/a3/") for step in action_loop["steps"]))
        self.assertTrue(all(step["reason"] for step in action_loop["steps"]))

    def test_report_includes_resource_pack_effect(self):
        profile = self.user.learner_profile
        profile.extra_profile = {
            "resourcePackRuns": [
                {
                    "schemaVersion": "a3.resource-pack-run.v1",
                    "runId": "r1",
                    "taskId": "resource-pack:root-locus",
                    "taskTitle": "Root locus resource pack",
                    "learningGoal": "root locus",
                    "verifiedSourceCount": 3,
                    "confidence": "high",
                    "practiceHref": "/a3/assessment?practice=root%20locus",
                    "source": "study_plan_completion",
                    "completedAt": timezone.now().isoformat(),
                    "nextStepReason": "Practice immediately.",
                }
            ]
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        report = self.client.get("/api/assessments/report/").json()["report"]

        effect = report["resourcePackEffect"]
        self.assertEqual(effect["schemaVersion"], "a3.resource-pack-effect.v1")
        self.assertEqual(effect["totalRuns"], 1)
        self.assertEqual(effect["verifiedSourceCount"], 3)
        self.assertEqual(effect["practiceStartedCount"], 1)
        self.assertEqual(effect["latestRun"]["learningGoal"], "root locus")
        self.assertEqual(effect["nextAction"]["href"], "/a3/assessment?practice=root%20locus")
        self.assertTrue(effect["conversionMessage"])

    def test_report_resource_pack_effect_reads_resource_pack_logs(self):
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:root-locus",
            task_title="Root locus resource pack",
            learning_goal="root locus",
            verified_source_count=3,
            confidence="high",
            practice_href="/a3/assessment?practice=root%20locus",
            source="study_plan_completion",
            next_step_reason="Practice immediately.",
        )

        report = self.client.get("/api/assessments/report/").json()["report"]

        effect = report["resourcePackEffect"]
        self.assertEqual(effect["totalRuns"], 1)
        self.assertEqual(effect["verifiedSourceCount"], 3)
        self.assertEqual(effect["practiceStartedCount"], 1)
        self.assertEqual(effect["latestRun"]["learningGoal"], "root locus")
        self.assertEqual(effect["latestRun"]["taskTitle"], "Root locus resource pack")

    def test_wrong_questions_return_review_schedule_summary(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )
        wrong = WrongQuestion.objects.get(user=self.user)
        wrong.review_after = timezone.now() - timedelta(days=1)
        wrong.save(update_fields=["review_after"])

        response = self.client.get("/api/assessments/wrong-questions/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("reviewSummary", payload)
        self.assertEqual(payload["reviewSummary"]["overdueCount"], 1)
        self.assertEqual(payload["reviewSummary"]["todayCount"], 1)
        self.assertEqual(payload["reviewSummary"]["nextAction"]["href"], "/a3/wrong-notebook")

    def test_start_assessment_can_focus_on_weak_knowledge_point(self):
        course = Course.objects.get(code="OS-001")
        point = course.chapters.first().knowledge_points.first()
        Question.objects.create(
            knowledge_point=point,
            stem="专项练习题",
            options=[{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
            correct_answer="A",
            explanation="专项解析",
            error_cause="专项错因",
        )

        response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": point.title, "limit": 1}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        session = response.json()["session"]
        self.assertEqual(session["mode"], "practice")
        self.assertEqual(session["focus"]["knowledgePoint"], point.title)
        self.assertEqual(session["totalQuestions"], 1)

    def test_start_assessment_accepts_partial_knowledge_point_for_practice(self):
        course = Course.objects.get(code="OS-001")
        point = course.chapters.get(title="虚拟内存管理").knowledge_points.get(title="虚拟内存与页面置换")
        Question.objects.create(
            knowledge_point=point,
            stem="虚拟内存专项练习题",
            options=[{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
            correct_answer="A",
            explanation="虚拟内存专项解析",
            error_cause="虚拟内存专项错因",
        )

        response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": "虚拟内存", "limit": 1}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        session = response.json()["session"]
        self.assertEqual(session["mode"], "practice")
        self.assertEqual(session["focus"]["knowledgePoint"], "虚拟内存与页面置换")
        self.assertEqual(session["totalQuestions"], 1)

    def test_start_assessment_returns_practice_suggestions_from_profile_and_wrong_questions(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )

        response = self.client.post("/api/assessments/start/", data=json.dumps({}), content_type="application/json")

        self.assertEqual(response.status_code, 201)
        suggestions = response.json()["practiceSuggestions"]
        self.assertGreaterEqual(len(suggestions), 1)
        self.assertIn("knowledgePoint", suggestions[0])
        self.assertIn("reason", suggestions[0])
        self.assertIn("wrongCount", suggestions[0])

    def test_mastering_wrong_question_returns_feedback_and_notification(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )
        wrong = WrongQuestion.objects.select_related("question").get(user=self.user)

        first = self.client.post(
            f"/api/assessments/wrong-questions/{wrong.id}/retry/",
            data=json.dumps({"selectedAnswer": wrong.question.correct_answer}),
            content_type="application/json",
        )
        second = self.client.post(
            f"/api/assessments/wrong-questions/{wrong.id}/retry/",
            data=json.dumps({"selectedAnswer": wrong.question.correct_answer}),
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        payload = second.json()
        self.assertTrue(payload["wrongQuestion"]["mastered"])
        self.assertIn("studyPlan", payload)
        self.assertIn("report", payload)
        self.assertEqual(payload["nextAction"]["href"], "/a3/assessment")
        self.assertIn("retryFeedback", payload)
        self.assertEqual(payload["retryFeedback"]["masteryStatus"], "mastered")
        self.assertIn("nextReviewAt", payload["retryFeedback"])
        self.assertIn("errorCauseChange", payload["retryFeedback"])
        self.assertIn("reward", payload["retryFeedback"])
        self.assertGreaterEqual(len(payload["retryFeedback"]["motivators"]), 1)
        self.assertTrue(UserNotification.objects.filter(user=self.user, action_url="/a3/assessment").exists())

    def test_wrong_retry_feedback_explains_unmastered_review_loop(self):
        session = self.client.get("/api/assessments/current/").json()["session"]
        self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )
        wrong = WrongQuestion.objects.select_related("question").get(user=self.user)

        response = self.client.post(
            f"/api/assessments/wrong-questions/{wrong.id}/retry/",
            data=json.dumps({"selectedAnswer": "Z"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["isCorrect"])
        self.assertEqual(payload["retryFeedback"]["masteryStatus"], "needs_review")
        self.assertEqual(payload["retryFeedback"]["nextAction"]["href"], "/a3/wrong-notebook")
        self.assertIn("下次复习", payload["retryFeedback"]["reviewPlan"])
        self.assertIn("错因", payload["retryFeedback"]["errorCauseChange"])

    def test_completed_assessment_returns_next_action(self):
        session = self.client.post("/api/assessments/start/", data=json.dumps({"limit": 1}), content_type="application/json").json()["session"]
        question = session["currentQuestion"]

        response = self.client.post(
            f"/api/assessments/sessions/{session['id']}/answer/",
            data=json.dumps({"selectedAnswer": question["options"][0]["key"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["session"]["status"], "completed")
        self.assertIn("nextAction", payload)
        self.assertTrue(payload["nextAction"]["href"].startswith("/a3/"))

    def test_start_practice_backfills_personalized_questions_when_point_bank_is_empty(self):
        Question.objects.all().update(is_active=False)
        point = default_course().chapters.first().knowledge_points.first()

        response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": point.title, "limit": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        session = response.json()["session"]
        self.assertEqual(session["totalQuestions"], 3)
        self.assertIsNotNone(session["currentQuestion"])
        self.assertGreaterEqual(
            Question.objects.filter(source_type=QuestionSourceType.VARIANT, is_active=True).count(),
            3,
        )

    def test_start_practice_backfills_from_current_path_when_requested_point_is_new(self):
        Question.objects.all().update(is_active=False)

        response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": "上传资料里的新专题", "limit": 2}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        session = response.json()["session"]
        self.assertEqual(session["mode"], "practice")
        self.assertEqual(session["totalQuestions"], 2)
        self.assertGreaterEqual(
            Question.objects.filter(source_type=QuestionSourceType.VARIANT, owner=self.user, is_active=True).count(),
            2,
        )

    def test_practice_backfill_uses_profile_weak_points_error_cause_and_material_evidence(self):
        Question.objects.all().update(is_active=False)
        course = default_course()
        weak_point = course.chapters.first().knowledge_points.first()
        profile = LearnerProfile.objects.get(user=self.user)
        profile.foundation_level = "基础薄弱"
        profile.weak_points = [weak_point.title]
        profile.learning_goals = ["补齐操作系统薄弱点"]
        profile.expected_resources = ["练习题库", "知识卡片"]
        profile.save(update_fields=["foundation_level", "weak_points", "learning_goals", "expected_resources", "updated_at"])
        source = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="学生上传的进程调度讲义.pdf",
            stored_path="kb/student/process-scheduling.pdf",
            file_type="pdf",
            resource_scope=ResourceScope.PERSONAL,
            course_key=course.code,
            status=ResourceStatus.INDEXED,
            chunk_count=1,
        )
        KnowledgeBlock.objects.create(
            resource=source,
            modality="text",
            text=f"{weak_point.title} 常见误区：只背结论，不会解释调度目标和适用场景。",
            confidence=0.91,
        )
        wrong_question = Question.objects.create(
            knowledge_point=weak_point,
            stem="历史错题",
            options=[
                {"key": "A", "text": "正确"},
                {"key": "B", "text": "错误"},
                {"key": "C", "text": "错误"},
                {"key": "D", "text": "错误"},
            ],
            correct_answer="A",
            explanation="历史解析",
            error_cause="把适用场景和定义混在一起",
            is_active=False,
        )
        WrongQuestion.objects.create(user=self.user, question=wrong_question, last_wrong_answer="B")

        response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": weak_point.title, "limit": 4}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()["session"]
        self.assertEqual(payload["totalQuestions"], 4)
        generated = list(Question.objects.filter(owner=self.user, is_active=True).order_by("created_at"))
        self.assertEqual(len(generated), 4)
        kinds = {question.metadata.get("questionKind") for question in generated}
        self.assertGreaterEqual(len(kinds), 3)
        for question in generated:
            metadata = question.metadata
            self.assertEqual(question.knowledge_point_id, weak_point.id)
            self.assertLessEqual(question.difficulty, 2)
            self.assertIn(weak_point.title, metadata["profileSignals"]["weakPoints"])
            self.assertEqual(metadata["profileSignals"]["foundationLevel"], "基础薄弱")
            self.assertIn("把适用场景和定义混在一起", metadata["profileSignals"]["recentErrorCauses"])
            self.assertIn("薄弱点", metadata["generationReason"])
            self.assertEqual(metadata["sourceEvidence"][0]["resourceTitle"], "学生上传的进程调度讲义.pdf")
            self.assertTrue(question.evidence_items.filter(resource=source).exists())
        current_question = payload["currentQuestion"]
        self.assertIn("personalization", current_question)
        self.assertEqual(current_question["personalization"]["foundationLevel"], "基础薄弱")
        self.assertIn(weak_point.title, current_question["personalization"]["profileSignals"]["weakPoints"])

    def test_repeated_practice_excludes_answered_questions_and_advances_dynamic_variants(self):
        Question.objects.all().update(is_active=False)
        course = default_course()
        point = course.chapters.first().knowledge_points.first()
        profile = LearnerProfile.objects.get(user=self.user)
        profile.weak_points = [point.title]
        profile.save(update_fields=["weak_points", "updated_at"])
        source = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="持续变式资料.pdf",
            stored_path="kb/student/sustainable-variants.pdf",
            file_type="pdf",
            resource_scope=ResourceScope.PERSONAL,
            course_key=course.code,
            status=ResourceStatus.INDEXED,
            chunk_count=2,
        )
        blocks = [
            KnowledgeBlock.objects.create(
                resource=source,
                modality="text",
                text=f"{point.title} 证据片段 {index}：用于不同应用场景和参数条件。",
                confidence=0.9 - index * 0.05,
            )
            for index in range(2)
        ]

        first_response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": point.title, "limit": 4}),
            content_type="application/json",
        )
        self.assertEqual(first_response.status_code, 201)
        first_session = AssessmentSession.objects.get(id=first_response.json()["session"]["id"])
        first_ids = list(first_session.question_ids)
        first_questions = list(Question.objects.filter(id__in=first_ids))
        first_variants = [int(question.metadata["variantIndex"]) for question in first_questions]
        for question_id in first_ids:
            question = Question.objects.get(id=question_id)
            answer_response = self.client.post(
                f"/api/assessments/sessions/{first_session.id}/answer/",
                data=json.dumps({"selectedAnswer": question.correct_answer}),
                content_type="application/json",
            )
            self.assertEqual(answer_response.status_code, 200)

        second_response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": point.title, "limit": 4}),
            content_type="application/json",
        )

        self.assertEqual(second_response.status_code, 201)
        second_session = AssessmentSession.objects.get(id=second_response.json()["session"]["id"])
        second_ids = list(second_session.question_ids)
        self.assertTrue(set(first_ids).isdisjoint(second_ids))
        second_questions = list(Question.objects.filter(id__in=second_ids).order_by("created_at"))
        second_variants = [int(question.metadata["variantIndex"]) for question in second_questions]
        self.assertGreater(min(second_variants), max(first_variants))
        contexts = [question.metadata.get("variantContext") for question in second_questions]
        self.assertTrue(all(isinstance(context, dict) for context in contexts))
        self.assertGreaterEqual(len({context["scenario"] for context in contexts}), 2)
        self.assertGreaterEqual(len({context["parameter"] for context in contexts}), 2)
        self.assertGreaterEqual(len({context["evidenceBlockId"] for context in contexts}), 2)
        for question in second_questions:
            self.assertEqual(question.review_status, QuestionReviewStatus.AUTO_VERIFIED)
            self.assertTrue(question.is_active)
            self.assertTrue(question.evidence_items.filter(resource=source).exists())
            self.assertTrue(question.quality_checks.filter(checker="practice_supply", passed=True).exists())
        self.assertEqual(
            {context["evidenceBlockId"] for context in contexts},
            {str(block.id) for block in blocks},
        )
        personalization = second_response.json()["session"]["currentQuestion"]["personalization"]
        self.assertIn(personalization.get("variantIndex"), second_variants)
        variant_context = personalization.get("variantContext") or {}
        self.assertTrue(variant_context.get("scenario"))
        self.assertGreater(variant_context.get("parameter", 0), 0)

    @patch("celery.current_app.send_task")
    def test_answering_personal_variant_dispatches_low_watermark_refill_after_commit(self, send_task):
        Question.objects.all().update(is_active=False)
        course = default_course()
        point = course.chapters.first().knowledge_points.first()
        profile = LearnerProfile.objects.get(user=self.user)
        profile.weak_points = [point.title]
        profile.save(update_fields=["weak_points", "updated_at"])
        start_response = self.client.post(
            "/api/assessments/start/",
            data=json.dumps({"mode": "practice", "knowledgePoint": point.title, "limit": 1}),
            content_type="application/json",
        )
        self.assertEqual(start_response.status_code, 201)
        session = AssessmentSession.objects.get(id=start_response.json()["session"]["id"])
        question = Question.objects.get(id=session.question_ids[0])

        with self.captureOnCommitCallbacks(execute=True):
            answer_response = self.client.post(
                f"/api/assessments/sessions/{session.id}/answer/",
                data=json.dumps({"selectedAnswer": question.correct_answer}),
                content_type="application/json",
            )

        self.assertEqual(answer_response.status_code, 200)
        send_task.assert_called_once_with(
            "assessments.refill_personal_question_pool",
            args=[str(self.user.id), str(point.id)],
            kwargs={"target_size": 12},
        )

    @patch("celery.current_app.send_task", side_effect=RuntimeError("broker unavailable"))
    def test_refill_dispatch_failure_does_not_break_answer_writeback(self, _send_task):
        point = default_course().chapters.first().knowledge_points.first()
        question = Question.objects.create(
            owner=self.user,
            knowledge_point=point,
            stem="异步补池失败不影响答题",
            options=[{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
            correct_answer="A",
            explanation="答题事务与补池消息发送解耦。",
            source_type=QuestionSourceType.VARIANT,
            review_status=QuestionReviewStatus.AUTO_VERIFIED,
            scope="personal",
            is_active=True,
            metadata={"generatedBy": "assessment_practice_supply", "variantIndex": 1},
        )
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id)])
        self.client.raise_request_exception = False

        try:
            with patch("backend.apps.assessments.services.logger.warning") as warning, self.captureOnCommitCallbacks(execute=True):
                response = self.client.post(
                    f"/api/assessments/sessions/{session.id}/answer/",
                    data=json.dumps({"selectedAnswer": "A"}),
                    content_type="application/json",
                )
        except RuntimeError as exc:
            self.fail(f"异步补池发送失败不应冒泡到答题请求：{exc}")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(AssessmentAnswer.objects.filter(session=session, question=question).exists())
        warning.assert_called_once()

    def test_personal_pool_archives_old_answered_variants_above_capacity(self):
        from backend.apps.assessments.services import refill_personal_question_pool

        point = default_course().chapters.first().knowledge_points.first()
        questions = [
            Question.objects.create(
                owner=self.user,
                knowledge_point=point,
                stem=f"容量归档变式 {index}",
                options=[{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
                correct_answer="A",
                explanation="容量归档测试解析",
                source_type=QuestionSourceType.VARIANT,
                review_status=QuestionReviewStatus.AUTO_VERIFIED,
                scope="personal",
                is_active=True,
                metadata={
                    "generatedBy": "assessment_practice_supply",
                    "variantIndex": index + 1,
                    "questionKind": "application",
                },
            )
            for index in range(45)
        ]
        answered_session = AssessmentSession.objects.create(
            user=self.user,
            question_ids=[str(question.id) for question in questions[:10]],
            status="completed",
            current_index=10,
            completed_at=timezone.now(),
        )
        for question in questions[:10]:
            AssessmentAnswer.objects.create(
                session=answered_session,
                question=question,
                selected_answer="A",
                is_correct=True,
            )

        result = refill_personal_question_pool(self.user, point, target_size=12)

        active = Question.objects.filter(
            owner=self.user,
            knowledge_point=point,
            metadata__generatedBy="assessment_practice_supply",
            is_active=True,
            archived_at__isnull=True,
        )
        archived = Question.objects.filter(owner=self.user, knowledge_point=point, archived_at__isnull=False)
        self.assertEqual(result.get("archived"), 5)
        self.assertEqual(active.count(), 40)
        self.assertEqual(archived.count(), 5)
        self.assertTrue(set(archived.values_list("id", flat=True)).issubset({question.id for question in questions[:10]}))
        self.assertFalse(archived.filter(id__in=[question.id for question in questions[10:]]).exists())
        for metadata in archived.values_list("metadata", flat=True):
            self.assertEqual(metadata["archiveReason"], "personal_pool_capacity")

    def test_refill_task_reports_verified_grounded_supply(self):
        from backend.apps.assessments.tasks import refill_personal_question_pool_task

        Question.objects.all().update(is_active=False)
        course = default_course()
        point = course.chapters.first().knowledge_points.first()
        profile = LearnerProfile.objects.get(user=self.user)
        profile.weak_points = [point.title]
        profile.save(update_fields=["weak_points", "updated_at"])

        with patch("backend.apps.assessments.tasks.close_old_connections"):
            result = refill_personal_question_pool_task.run(
                str(self.user.id),
                str(point.id),
                target_size=4,
            )

        self.assertEqual(result.get("generated"), 4)
        self.assertEqual(result.get("verified"), 4)
        self.assertEqual(result.get("rejected"), 0)
        self.assertEqual(result.get("available"), 4)
        generated = Question.objects.filter(
            owner=self.user,
            knowledge_point=point,
            metadata__generatedBy="assessment_practice_supply",
        )
        self.assertEqual(generated.count(), 4)
        for question in generated:
            self.assertEqual(question.review_status, QuestionReviewStatus.AUTO_VERIFIED)
            self.assertTrue(question.evidence_items.exists())
            self.assertTrue(question.quality_checks.filter(checker="practice_supply", passed=True).exists())

    @patch("backend.apps.assessments.services.generate_grounded_personal_candidates")
    def test_refill_uses_grounded_llm_candidates_and_rules_fill_the_gap(self, generate_candidates):
        from backend.apps.assessments.personal_question_llm import GroundedCandidateBatch
        from backend.apps.assessments.services import refill_personal_question_pool

        Question.objects.all().update(is_active=False)
        course = default_course()
        point = course.chapters.first().knowledge_points.first()
        source = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="LLM 证据讲义.pdf",
            stored_path="kb/student/llm-grounding.pdf",
            file_type="pdf",
            resource_scope=ResourceScope.PERSONAL,
            course_key=course.code,
            status=ResourceStatus.INDEXED,
            chunk_count=1,
        )
        block = KnowledgeBlock.objects.create(
            resource=source,
            modality="text",
            text=f"{point.title} 的场景证据：参数变化会影响系统表现。",
            confidence=0.93,
        )
        generate_candidates.return_value = GroundedCandidateBatch(
            candidates=[{
                "variantIndex": 1,
                "questionKind": "scenario",
                "stem": f"证据约束场景题：如何根据参数变化分析{point.title}？",
                "options": [
                    {"key": "A", "text": "先读取证据中的条件再判断"},
                    {"key": "B", "text": "忽略参数"},
                    {"key": "C", "text": "直接套用其他知识点"},
                    {"key": "D", "text": "只看题目长度"},
                ],
                "correctAnswer": "A",
                "explanation": "资料证据明确指出参数变化会影响系统表现，因此应先读取条件。",
                "errorCause": "忽略证据条件",
                "evidenceBlockIds": [str(block.id)],
                "reasoningForm": "parameter_change",
            }],
            provider="dashscope",
            model="qwen-plus",
            fallback=False,
            error="",
            rejected_count=0,
        )

        result = refill_personal_question_pool(self.user, point, target_size=3)

        self.assertEqual(result["available"], 3)
        self.assertEqual(result["llmGenerated"], 1)
        self.assertEqual(result["ruleGenerated"], 2)
        llm_question = Question.objects.get(owner=self.user, metadata__generationMode="grounded_llm")
        self.assertEqual(llm_question.metadata["llm"]["provider"], "dashscope")
        self.assertEqual(llm_question.metadata["reasoningForm"], "parameter_change")
        self.assertEqual(llm_question.source_block_id, str(block.id))
        self.assertTrue(llm_question.evidence_items.filter(block_id=str(block.id)).exists())
        self.assertTrue(llm_question.quality_checks.filter(checker="practice_supply", passed=True).exists())
        personalization = llm_question.metadata
        self.assertEqual(personalization["generationMode"], "grounded_llm")
        serialized = __import__(
            "backend.apps.assessments.services", fromlist=["serialize_question"]
        ).serialize_question(llm_question)["personalization"]
        self.assertEqual(serialized["generationMode"], "grounded_llm")
        self.assertEqual(serialized["reasoningForm"], "parameter_change")
        self.assertEqual(serialized["llm"]["model"], "qwen-plus")
