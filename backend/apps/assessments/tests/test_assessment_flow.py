import json
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.assessments.models import AssessmentAnswer, AssessmentSession, Question, WrongQuestion
from backend.apps.engagement.models import UserNotification
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
