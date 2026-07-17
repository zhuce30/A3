from datetime import date, datetime, time, timedelta, timezone as datetime_timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from backend.apps.assessments.models import AssessmentAnswer, AssessmentSession, Question, WrongQuestion
from backend.apps.assessments.services import _knowledge_point_insights, build_learning_report
from backend.apps.learning.models import (
    Chapter,
    Course,
    KnowledgePoint,
    LearningPath,
    LearningPathItem,
    PathItemStatus,
)
from backend.apps.profiles.models import LearnerProfile


class LearningReportV2Tests(TestCase):
    def test_report_models_define_report_access_path_indexes(self):
        expected_indexes = {
            AssessmentAnswer: {
                "a3_ans_sess_time_ok_idx": ("session", "answered_at", "is_correct"),
            },
            WrongQuestion: {
                "a3_wrong_user_master_idx": ("user", "mastered", "-last_wrong_at"),
                "a3_wrong_user_time_idx": ("user", "-last_wrong_at"),
            },
            LearningPath: {
                "a3_path_user_status_idx": ("user", "status", "-created_at"),
            },
        }

        for model, expected in expected_indexes.items():
            actual = {index.name: tuple(index.fields) for index in model._meta.indexes}
            for name, fields in expected.items():
                with self.subTest(model=model.__name__, index=name):
                    self.assertEqual(actual.get(name), fields)

    def setUp(self):
        self.user = get_user_model().objects.create_user(phone="13800006661", password="TestPassword123")
        course = Course.objects.create(code="report-v2", title="操作系统")
        chapter = Chapter.objects.create(course=course, order=1, title="进程管理")
        self.knowledge_point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="report-v2-scheduling",
            order=1,
            title="进程调度",
        )
        self.questions = [
            Question.objects.create(
                knowledge_point=self.knowledge_point,
                stem=f"进程调度题 {index}",
                options=[{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
                correct_answer="A",
                explanation="用于学习报告测试。",
                error_cause="调度规则理解不清。",
            )
            for index in range(1, 9)
        ]

    def _create_answers(self, *, days_ago: int, correctness: list[bool]) -> list[AssessmentAnswer]:
        session = AssessmentSession.objects.create(user=self.user, question_ids=[])
        answered_at = timezone.now() - timedelta(days=days_ago)
        answers = []
        for question, is_correct in zip(self.questions[: len(correctness)], correctness, strict=True):
            answer = AssessmentAnswer.objects.create(
                session=session,
                question=question,
                selected_answer="A" if is_correct else "B",
                is_correct=is_correct,
            )
            AssessmentAnswer.objects.filter(pk=answer.pk).update(answered_at=answered_at)
            answer.refresh_from_db()
            answers.append(answer)
        return answers

    def _set_study_plan(self, plan) -> None:
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        extra_profile = dict(profile.extra_profile or {})
        extra_profile["studyPlan"] = plan
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])
        self.user.refresh_from_db()

    def test_adds_summary_comparison_knowledge_points_and_data_quality(self):
        self._create_answers(days_ago=1, correctness=[True, True, True, False])
        self._create_answers(days_ago=8, correctness=[True, True, False, False])
        WrongQuestion.objects.create(
            user=self.user,
            question=self.questions[3],
            wrong_count=2,
            last_wrong_answer="B",
        )

        current_task = {
            "id": "current-plan-task",
            "title": "Finish the current study-plan lesson",
            "subtitle": "Complete the lesson and update plan progress.",
            "href": "/a3/classroom?task=current-plan-task",
            "estimatedMinutes": 24,
            "status": "pending",
        }
        self._set_study_plan({"days": [{"date": timezone.localdate().isoformat(), "tasks": [current_task]}]})
        report = build_learning_report(self.user, "7d")

        self.assertEqual(report["studentSummary"]["schemaVersion"], "a3.student-report-summary.v1")
        self.assertTrue(report["studentSummary"]["primaryAction"]["href"].startswith("/a3/"))
        self.assertEqual(report["studentSummary"]["primaryAction"]["href"], "/a3/wrong-notebook")
        self.assertIs(
            report["comparisons"]["accuracy"]["comparable"],
            True,
            report["comparisons"],
        )
        self.assertEqual(report["comparisons"]["accuracy"]["percentagePointChange"], 25.0)
        self.assertEqual(report["knowledgePointInsights"][0]["knowledgePoint"], "进程调度")
        self.assertLessEqual(len(report["knowledgePointInsights"]), 3)
        self.assertIn(report["dataQuality"]["evidenceState"], {"ready", "partial", "insufficient"})
        self.assertTrue(
            {
                "period",
                "metrics",
                "trends",
                "capabilityAxes",
                "suggestions",
                "weeklySummary",
                "weeklyPrescription",
                "actionLoop",
                "wrongReviewInsight",
                "resourcePackEffect",
                "updatedAt",
            }.issubset(report)
        )

    def test_primary_action_uses_current_study_plan_task_before_assessment(self):
        task = {
            "id": "d1-learn",
            "title": "Study process scheduling",
            "subtitle": "Explain the scheduling trade-offs after the lesson.",
            "href": "/a3/classroom?task=d1-learn",
            "estimatedMinutes": 26,
            "status": "pending",
        }
        self._set_study_plan({"days": [{"date": timezone.localdate().isoformat(), "tasks": [task]}]})
        with patch(
            "backend.apps.learning.services.current_study_plan",
            side_effect=AssertionError("report generation must not refresh or mutate the study plan"),
        ) as current_plan:
            action = build_learning_report(self.user, "7d")["studentSummary"]["primaryAction"]

        current_plan.assert_not_called()
        self.assertEqual(
            action,
            {
                "label": task["title"],
                "href": task["href"],
                "estimatedMinutes": task["estimatedMinutes"],
                "expectedOutcome": task["subtitle"],
            },
        )

    def test_primary_action_uses_assessment_when_no_wrong_question_or_plan_task(self):
        action = build_learning_report(self.user, "7d")["studentSummary"]["primaryAction"]

        self.assertEqual(action["href"], "/a3/assessment")

    def test_primary_action_uses_today_after_sufficient_stable_assessment_evidence(self):
        self._create_answers(days_ago=1, correctness=[True, True, True])

        action = build_learning_report(self.user, "7d")["studentSummary"]["primaryAction"]

        self.assertEqual(action["href"], "/a3/today")

    def test_30d_comparison_uses_two_adjacent_thirty_day_windows_including_boundaries(self):
        for days_ago, is_correct in (
            (0, True),
            (10, True),
            (20, True),
            (29, False),
            (30, True),
            (40, True),
            (50, False),
            (59, False),
            (60, True),
        ):
            self._create_answers(days_ago=days_ago, correctness=[is_correct])

        comparisons = build_learning_report(self.user, "30d")["comparisons"]
        current = comparisons["currentWindow"]
        previous = comparisons["previousWindow"]

        self.assertEqual((date.fromisoformat(current["end"]) - date.fromisoformat(current["start"])).days, 29)
        self.assertEqual((date.fromisoformat(previous["end"]) - date.fromisoformat(previous["start"])).days, 29)
        self.assertEqual(date.fromisoformat(previous["end"]) + timedelta(days=1), date.fromisoformat(current["start"]))
        self.assertEqual(current["answeredCount"], 4)
        self.assertEqual(previous["answeredCount"], 4)
        self.assertIs(comparisons["accuracy"]["comparable"], True)
        self.assertEqual(comparisons["accuracy"]["percentagePointChange"], 25.0)

    def test_additive_fields_preserve_legacy_core_report_contract(self):
        self._create_answers(days_ago=1, correctness=[True, False])
        WrongQuestion.objects.create(
            user=self.user,
            question=self.questions[1],
            wrong_count=1,
            last_wrong_answer="B",
        )

        report = build_learning_report(self.user, "7d")

        self.assertEqual(
            report["metrics"],
            {
                "studyMinutes": 0,
                "studyDays": 1,
                "masteredKnowledgePoints": 0,
                "totalKnowledgePoints": 0,
                "answeredQuestions": 2,
                "accuracy": 50.0,
                "activeWrongQuestions": 1,
                "masteredWrongQuestions": 0,
                "pathProgress": 0,
            },
        )
        self.assertEqual(
            set(report["weeklyPrescription"]),
            {"weeklyTarget", "diagnosis", "focusAreas", "completionCriteria", "primaryAction", "nextWeekActions"},
        )
        self.assertEqual(report["weeklyPrescription"]["primaryAction"]["href"], "/a3/wrong-notebook")
        self.assertEqual(
            set(report["actionLoop"]),
            {"schemaVersion", "continuityMessage", "primaryReason", "primaryAction", "steps"},
        )
        self.assertEqual(report["actionLoop"]["schemaVersion"], "a3.report-action-loop.v1")
        self.assertEqual(report["actionLoop"]["primaryAction"]["href"], "/a3/wrong-notebook")
        self.assertEqual([step["kind"] for step in report["actionLoop"]["steps"]], ["today", "review", "plan"])

    def test_accuracy_comparison_requires_three_answers_in_both_windows(self):
        self._create_answers(days_ago=1, correctness=[True, True, False])
        self._create_answers(days_ago=8, correctness=[True, False])

        accuracy = build_learning_report(self.user, "7d")["comparisons"]["accuracy"]

        self.assertIs(accuracy["comparable"], False)
        self.assertIsNone(accuracy["percentagePointChange"])
        self.assertIn("至少 3 次作答", accuracy["reason"])

    def test_term_comparison_is_unavailable_without_real_prior_term(self):
        self._create_answers(days_ago=1, correctness=[True, True, True])

        accuracy = build_learning_report(self.user, "term")["comparisons"]["accuracy"]

        self.assertIs(accuracy["comparable"], False)
        self.assertIsNone(accuracy["percentagePointChange"])
        self.assertIn("本学期", accuracy["reason"])

    def test_empty_report_is_structurally_complete_without_invented_trend(self):
        report = build_learning_report(self.user, "7d")

        self.assertEqual(report["knowledgePointInsights"], [])
        self.assertEqual(report["studentSummary"]["progressSignal"], "本周期暂无作答")
        self.assertNotIn("提升", report["studentSummary"]["headline"])
        self.assertNotIn("改善", report["studentSummary"]["headline"])
        self.assertIs(report["comparisons"]["accuracy"]["comparable"], False)
        self.assertIsNone(report["comparisons"]["accuracy"]["percentagePointChange"])
        self.assertEqual(report["dataQuality"]["evidenceState"], "insufficient")
        self.assertTrue(report["dataQuality"]["missingReasons"])

    def test_malformed_study_plan_snapshot_is_read_safely_without_refreshing_plan(self):
        valid_task = {
            "title": "Continue the saved lesson",
            "subtitle": "Finish the lesson and record the result.",
            "href": "/a3/classroom?task=saved",
            "estimatedMinutes": "18",
            "status": "pending",
        }
        self._set_study_plan(
            {
                "days": [
                    {"date": "not-a-date", "dayIndex": "broken", "tasks": [None, "bad-task"]},
                    {"date": timezone.localdate().isoformat(), "dayIndex": None, "tasks": [valid_task]},
                    "bad-day",
                ]
            }
        )

        with patch(
            "backend.apps.learning.services.current_study_plan",
            side_effect=AssertionError("report generation must not call current_study_plan"),
        ) as current_plan:
            action = build_learning_report(self.user, "7d")["studentSummary"]["primaryAction"]

        current_plan.assert_not_called()
        self.assertEqual(action["href"], valid_task["href"])
        self.assertEqual(action["estimatedMinutes"], 18)

    def test_period_boundaries_use_the_project_local_calendar_date(self):
        utc_before_local_midnight = datetime(2026, 7, 16, 16, 30, tzinfo=datetime_timezone.utc)
        local_day = date(2026, 7, 17)

        with patch("backend.apps.assessments.services.timezone.now", return_value=utc_before_local_midnight), patch(
            "backend.apps.assessments.services.timezone.localdate", return_value=local_day
        ):
            report = build_learning_report(self.user, "7d")

        self.assertEqual(report["period"]["start"], "2026-07-11")
        self.assertEqual(report["period"]["end"], "2026-07-17")
        self.assertEqual(report["comparisons"]["currentWindow"]["end"], "2026-07-17")

    def test_future_answers_and_path_completions_are_excluded_from_term_report(self):
        today = timezone.localdate()
        report_end_at = timezone.make_aware(datetime.combine(today + timedelta(days=1), time.min))
        future_at = report_end_at + timedelta(hours=2)
        session = AssessmentSession.objects.create(user=self.user, question_ids=[])
        answer = AssessmentAnswer.objects.create(
            session=session,
            question=self.questions[0],
            selected_answer="A",
            is_correct=True,
        )
        AssessmentAnswer.objects.filter(pk=answer.pk).update(answered_at=future_at)
        path = LearningPath.objects.create(
            user=self.user,
            course=self.knowledge_point.chapter.course,
            title="Future evidence path",
        )
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=self.knowledge_point,
            order=1,
            status=PathItemStatus.COMPLETED,
            progress=100,
            estimated_minutes=45,
            completed_at=future_at,
        )

        report = build_learning_report(self.user, "term")

        self.assertEqual(
            report["metrics"],
            {
                "studyMinutes": 0,
                "studyDays": 0,
                "masteredKnowledgePoints": 0,
                "totalKnowledgePoints": 1,
                "answeredQuestions": 0,
                "accuracy": 0,
                "activeWrongQuestions": 0,
                "masteredWrongQuestions": 0,
                "pathProgress": 0,
            },
        )
        self.assertEqual(report["period"]["start"], today.isoformat())
        self.assertTrue(all(bucket["questions"] == 0 for bucket in report["trends"]))
        self.assertEqual(report["comparisons"]["currentWindow"]["answeredCount"], 0)
        self.assertEqual(report["knowledgePointInsights"], [])
        self.assertEqual(next(axis["value"] for axis in report["capabilityAxes"] if axis["label"] == "持续学习"), 0)
        self.assertEqual(report["dataQuality"]["evidenceState"], "insufficient")

    def test_knowledge_point_insights_use_bounded_aggregate_queries(self):
        self._create_answers(days_ago=1, correctness=[True, False, True, False])
        WrongQuestion.objects.create(
            user=self.user,
            question=self.questions[1],
            wrong_count=1,
            last_wrong_answer="B",
        )

        with CaptureQueriesContext(connection) as queries:
            insights = _knowledge_point_insights(self.user, start=None, limit=3)

        answer_table = AssessmentAnswer._meta.db_table.lower()
        captured_sql = [query["sql"] for query in queries.captured_queries]
        answer_queries = [
            sql
            for sql in captured_sql
            if answer_table in sql.lower()
        ]
        self.assertEqual(len(insights), 1)
        self.assertEqual(
            {
                key: insights[0][key]
                for key in (
                    "knowledgePoint",
                    "answeredCount",
                    "wrongCount",
                    "latestResult",
                    "activeWrongQuestions",
                    "status",
                )
            },
            {
                "knowledgePoint": "进程调度",
                "answeredCount": 4,
                "wrongCount": 2,
                "latestResult": "incorrect",
                "activeWrongQuestions": 1,
                "status": "needs_review",
            },
        )
        self.assertEqual(insights[0]["action"]["href"], "/a3/wrong-notebook")
        self.assertTrue(answer_queries)
        self.assertLessEqual(len(queries.captured_queries), 2, "\n\n".join(captured_sql))
        self.assertLessEqual(len(answer_queries), 1, "\n\n".join(answer_queries))

    def test_populated_30d_report_has_stable_bounded_database_queries(self):
        self._create_answers(days_ago=1, correctness=[True, True, False, False])
        self._create_answers(days_ago=12, correctness=[True, False, True])
        self._create_answers(days_ago=35, correctness=[True, False, False])
        path = LearningPath.objects.create(user=self.user, course=self.knowledge_point.chapter.course, title="Report path")
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=self.knowledge_point,
            order=1,
            status=PathItemStatus.COMPLETED,
            progress=100,
            estimated_minutes=25,
            completed_at=timezone.now() - timedelta(days=2),
        )
        WrongQuestion.objects.create(
            user=self.user,
            question=self.questions[2],
            wrong_count=2,
            last_wrong_answer="B",
        )
        WrongQuestion.objects.create(
            user=self.user,
            question=self.questions[3],
            wrong_count=1,
            mastered=True,
            last_wrong_answer="B",
        )

        LearnerProfile.objects.get_or_create(user=self.user)
        self.user.refresh_from_db()
        self.user.learner_profile

        answer_table = AssessmentAnswer._meta.db_table.lower()

        def capture_report_queries():
            with CaptureQueriesContext(connection) as queries:
                report = build_learning_report(self.user, "30d")
            captured_sql = [query["sql"] for query in queries.captured_queries]
            answer_queries = [sql for sql in captured_sql if answer_table in sql.lower()]
            return report, captured_sql, answer_queries

        small_report, small_queries, small_answer_queries = capture_report_queries()

        for order in range(2, 13):
            point = KnowledgePoint.objects.create(
                chapter=self.knowledge_point.chapter,
                code=f"report-v2-extra-{order}",
                order=order,
                title=f"Extra report point {order}",
            )
            LearningPathItem.objects.create(
                path=path,
                knowledge_point=point,
                order=order,
                status=PathItemStatus.CURRENT if order == 2 else PathItemStatus.LOCKED,
            )
        for index, question in enumerate(self.questions):
            if index in {2, 3}:
                continue
            WrongQuestion.objects.create(
                user=self.user,
                question=question,
                wrong_count=index + 1,
                mastered=index % 2 == 0,
                last_wrong_answer="B",
            )
        for days_ago in range(25):
            self._create_answers(
                days_ago=days_ago,
                correctness=[index % 3 != 0 for index in range(len(self.questions))],
            )

        large_report, large_queries, large_answer_queries = capture_report_queries()
        small_total_queries = len(small_queries)
        large_total_queries = len(large_queries)
        small_answer_queries = len(small_answer_queries)
        large_answer_queries = len(large_answer_queries)

        self.assertEqual(small_report["metrics"]["answeredQuestions"], 7)
        self.assertGreater(large_report["metrics"]["answeredQuestions"], 200)
        self.assertGreater(small_answer_queries, 0)
        self.assertGreater(large_answer_queries, 0)
        self.assertEqual(large_total_queries, small_total_queries, "\n\n".join(large_queries))
        self.assertEqual(large_answer_queries, small_answer_queries, "\n\n".join(large_queries))
        self.assertLessEqual(small_total_queries, 12, "\n\n".join(small_queries))
        self.assertLessEqual(large_total_queries, 12, "\n\n".join(large_queries))
        self.assertLessEqual(small_answer_queries, 4, "\n\n".join(small_queries))
        self.assertLessEqual(large_answer_queries, 4, "\n\n".join(large_queries))
