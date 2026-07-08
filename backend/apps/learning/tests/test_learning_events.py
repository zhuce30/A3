from datetime import timedelta
import json
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from unittest.mock import patch
from uuid import uuid4

from backend.apps.accounts.models import User
from backend.apps.assessments.models import AssessmentSession, Question, WrongQuestion
from backend.apps.assessments.services import answer_assessment_question, retry_wrong
from backend.apps.compat.llm import LLMUnavailable
from backend.apps.compat.resource_generation import build_learning_effect_report, evaluate_learning_effect, record_resource_feedback
from backend.apps.learning.effect_events import aggregate_learning_events, list_recent_learning_events, record_learning_event
from backend.apps.learning.models import Chapter, Course, KnowledgePoint, LearningEvent
from backend.apps.learning.resource_attribution import build_resource_effect_attribution
from backend.apps.learning.services import append_classroom_chat_messages, append_coaching_messages, complete_study_plan_task, submit_daily_reflection
from backend.apps.profiles.models import LearnerProfile


class LearningEventServiceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001111", password="TestPassword123")

    def test_record_learning_event_persists_normalized_event(self):
        event = record_learning_event(
            self.user,
            event_type="resource_completed",
            target_type="resource_pack",
            target_id="pack-1",
            knowledge_point_id="kp-function",
            resource_type="practice_set",
            duration_sec=-3,
            score="82.5",
            quality={"correctRate": 0.8},
            metadata={"goal": "function practice"},
            trace_id="trace-1",
        )

        event.refresh_from_db()
        self.assertEqual(event.user, self.user)
        self.assertEqual(event.event_type, "resource_completed")
        self.assertEqual(event.target_type, "resource_pack")
        self.assertEqual(event.target_id, "pack-1")
        self.assertEqual(event.knowledge_point_id, "kp-function")
        self.assertEqual(event.resource_type, "practice_set")
        self.assertEqual(event.duration_sec, 0)
        self.assertEqual(event.score, 82.5)
        self.assertEqual(event.quality, {"correctRate": 0.8})
        self.assertEqual(event.metadata, {"goal": "function practice"})
        self.assertEqual(event.trace_id, "trace-1")

    def test_list_recent_learning_events_returns_serialized_newest_first(self):
        first = record_learning_event(self.user, event_type="task_completed", target_type="study_plan", target_id="task-1")
        second = record_learning_event(self.user, event_type="reflection_submitted", target_type="study_plan", target_id="reflection-1")
        LearningEvent.objects.filter(id=second.id).update(created_at=timezone.now() + timedelta(seconds=1))

        events = list_recent_learning_events(self.user, limit=10)

        self.assertEqual([item["id"] for item in events], [str(second.id), str(first.id)])
        self.assertEqual(events[0]["eventType"], "reflection_submitted")
        self.assertIn("createdAt", events[0])

    def test_aggregate_learning_events_counts_behavior_and_scores(self):
        record_learning_event(self.user, event_type="task_completed", target_type="study_plan", duration_sec=300)
        record_learning_event(self.user, event_type="resource_completed", target_type="resource_pack", resource_type="practice_set", duration_sec=600, score=80)
        record_learning_event(self.user, event_type="resource_skipped", target_type="resource_pack", resource_type="lecture_doc")

        summary = aggregate_learning_events(self.user, days=30)

        self.assertEqual(summary["totalEvents"], 3)
        self.assertEqual(summary["eventCounts"]["task_completed"], 1)
        self.assertEqual(summary["eventCounts"]["resource_completed"], 1)
        self.assertEqual(summary["resourceUsage"]["completed"], 1)
        self.assertEqual(summary["resourceUsage"]["skipped"], 1)
        self.assertEqual(summary["resourceUsage"]["byType"]["practice_set"]["completed"], 1)
        self.assertEqual(summary["totalDurationSec"], 900)
        self.assertEqual(summary["averageScore"], 80)


class LearningEventApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001112", password="TestPassword123")

    def test_recent_events_requires_login(self):
        response = self.client.get(reverse("learning-events-recent"))

        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.json()["success"])

    def test_recent_events_api_returns_current_user_events_only(self):
        other = User.objects.create_user(phone="13800001113", password="TestPassword123")
        record_learning_event(self.user, event_type="task_completed", target_type="study_plan", target_id="task-1")
        record_learning_event(other, event_type="task_completed", target_type="study_plan", target_id="other-task")
        self.client.force_login(self.user)

        response = self.client.get(reverse("learning-events-recent"), {"limit": "20"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(len(payload["events"]), 1)
        self.assertEqual(payload["events"][0]["targetId"], "task-1")

    def test_summary_events_api_returns_aggregate(self):
        record_learning_event(self.user, event_type="task_completed", duration_sec=120)
        self.client.force_login(self.user)

        response = self.client.get(reverse("learning-events-summary"), {"days": "30"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["summary"]["totalEvents"], 1)
        self.assertEqual(payload["summary"]["totalDurationSec"], 120)


class LearningEventWorkflowWritebackTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001114", password="TestPassword123")

    def test_complete_study_plan_task_records_task_completed_event(self):
        knowledge_point_id = str(uuid4())
        LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "studyPlan": {
                    "planId": "plan-1",
                    "days": [
                        {
                            "dayIndex": 1,
                            "date": "2026-07-08",
                            "progress": 0,
                            "tasks": [
                                {
                                    "id": "task-1",
                                    "type": "practice",
                                    "title": "Function practice",
                                    "href": "/a3/assessment",
                                    "estimatedMinutes": 20,
                                    "status": "pending",
                                    "knowledgePointId": knowledge_point_id,
                                }
                            ],
                        }
                    ],
                }
            },
        )

        complete_study_plan_task(self.user, day_index=1, task_id="task-1")

        event = LearningEvent.objects.get(user=self.user, event_type="task_completed")
        self.assertEqual(event.target_type, "study_plan_task")
        self.assertEqual(event.target_id, "task-1")
        self.assertEqual(event.knowledge_point_id, knowledge_point_id)
        self.assertEqual(event.duration_sec, 1200)
        self.assertEqual(event.metadata["taskType"], "practice")

    def test_submit_daily_reflection_records_reflection_event(self):
        LearnerProfile.objects.create(user=self.user, extra_profile={})

        result = submit_daily_reflection(
            self.user,
            {"summary": "I finished function practice.", "confusion": "Need more recursion.", "confidence": 4},
        )

        event = LearningEvent.objects.get(user=self.user, event_type="reflection_submitted")
        self.assertEqual(event.target_type, "daily_reflection")
        self.assertEqual(event.target_id, result["reflection"]["reflectionId"])
        self.assertEqual(event.score, 4)
        self.assertEqual(event.metadata["summary"], "I finished function practice.")

    def test_record_resource_feedback_records_matching_resource_event(self):
        LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "studyPlan": {
                    "planId": "plan-1",
                    "days": [{"dayIndex": 1, "tasks": [], "progress": 0}],
                },
                "resourcePacks": [
                    {
                        "resourcePackId": "pack-1",
                        "goal": "Function practice",
                        "learningGoal": "Function practice",
                    }
                ],
            },
        )

        record_resource_feedback(self.user, "pack-1", {"action": "completed", "resourceType": "practice_set", "score": 88})

        event = LearningEvent.objects.get(user=self.user, event_type="resource_completed")
        self.assertEqual(event.target_type, "resource_pack")
        self.assertEqual(event.target_id, "pack-1")
        self.assertEqual(event.resource_type, "practice_set")
        self.assertEqual(event.score, 88)
        self.assertEqual(event.metadata["goal"], "Function practice")


class LearningEventAssessmentAndCoachingTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001115", password="TestPassword123")
        self.course = Course.objects.create(code="LE-001", title="Learning Events")
        self.chapter = Chapter.objects.create(course=self.course, order=1, title="Basics")
        self.point = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="LE-KP-001",
            order=1,
            title="Function basics",
        )

    def _question(self, suffix: str, correct_answer: str = "A") -> Question:
        return Question.objects.create(
            knowledge_point=self.point,
            stem=f"Question {suffix}",
            options=[
                {"key": "A", "text": "Option A"},
                {"key": "B", "text": "Option B"},
                {"key": "C", "text": "Option C"},
                {"key": "D", "text": "Option D"},
            ],
            correct_answer=correct_answer,
            explanation="Because A is correct.",
            difficulty=2,
        )

    def test_answer_assessment_question_records_answer_and_completion_events(self):
        first = self._question("1")
        second = self._question("2")
        session = AssessmentSession.objects.create(
            user=self.user,
            question_ids=[str(first.id), str(second.id)],
        )

        answer_assessment_question(self.user, session, "A")
        answer_assessment_question(self.user, session, "B")

        answer_events = LearningEvent.objects.filter(user=self.user, event_type="question_answered").order_by("created_at")
        self.assertEqual(answer_events.count(), 2)
        self.assertEqual(answer_events[0].target_type, "assessment_question")
        self.assertEqual(answer_events[0].target_id, str(first.id))
        self.assertEqual(answer_events[0].knowledge_point_id, str(self.point.id))
        self.assertEqual(answer_events[0].score, 100)
        self.assertEqual(answer_events[1].score, 0)
        completed = LearningEvent.objects.get(user=self.user, event_type="assessment_submitted")
        self.assertEqual(completed.target_type, "assessment_session")
        self.assertEqual(completed.target_id, str(session.id))
        self.assertEqual(completed.score, 50)

    def test_wrong_question_created_and_retried_records_events(self):
        question = self._question("wrong")
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id)])

        answer_assessment_question(self.user, session, "B")
        wrong = WrongQuestion.objects.get(user=self.user, question=question)
        retry_wrong(self.user, wrong, "A")

        added = LearningEvent.objects.get(user=self.user, event_type="wrong_question_added")
        self.assertEqual(added.target_type, "wrong_question")
        self.assertEqual(added.target_id, str(wrong.id))
        self.assertEqual(added.knowledge_point_id, str(self.point.id))
        reviewed = LearningEvent.objects.get(user=self.user, event_type="wrong_question_reviewed")
        self.assertEqual(reviewed.target_type, "wrong_question")
        self.assertEqual(reviewed.target_id, str(wrong.id))
        self.assertEqual(reviewed.score, 100)

    def test_classroom_and_coaching_messages_record_coach_message_events(self):
        LearnerProfile.objects.create(user=self.user, extra_profile={})

        append_classroom_chat_messages(
            self.user,
            [{"id": "classroom-message-1", "role": "user", "content": "Explain process scheduling."}],
        )
        append_coaching_messages(
            self.user,
            [{"id": "coaching-message-1", "role": "user", "content": "I need help with deadlocks."}],
        )

        events = list(LearningEvent.objects.filter(user=self.user, event_type="coach_message_sent").order_by("created_at"))
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].target_type, "classroom_chat")
        self.assertEqual(events[0].target_id, "classroom-message-1")
        self.assertEqual(events[0].metadata["role"], "user")
        self.assertEqual(events[1].target_type, "coaching_message")
        self.assertEqual(events[1].metadata["clientId"], "coaching-message-1")


class LearningEffectReportEventBackfillTests(TestCase):
    def test_learning_effect_report_reads_learning_event_resource_usage(self):
        user = User.objects.create_user(phone="13800001116", password="TestPassword123")
        LearnerProfile.objects.create(user=user, extra_profile={})
        record_learning_event(user, event_type="resource_opened", target_type="resource_pack", target_id="pack-1")
        record_learning_event(user, event_type="resource_completed", target_type="resource_pack", target_id="pack-1", score=90)
        record_learning_event(user, event_type="resource_skipped", target_type="resource_pack", target_id="pack-2")

        report = build_learning_effect_report(user)

        self.assertEqual(report["resourceUsage"]["opened"], 1)
        self.assertEqual(report["resourceUsage"]["completed"], 1)
        self.assertEqual(report["resourceUsage"]["skipped"], 1)
        self.assertEqual(report["masterySignals"]["averageFeedbackScore"], 90)

    def test_learning_effect_report_v2_includes_knowledge_gain_trends_and_confidence(self):
        user = User.objects.create_user(phone="13800001117", password="TestPassword123")
        course = Course.objects.create(code="LE-002", title="Learning Effect V2")
        chapter = Chapter.objects.create(course=course, order=1, title="Basics")
        point = KnowledgePoint.objects.create(chapter=chapter, code="LE-KP-002", order=1, title="Loop basics")
        LearnerProfile.objects.create(user=user, weak_points=["Loop basics"], extra_profile={})
        old_event = record_learning_event(
            user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-old",
            knowledge_point_id=str(point.id),
            score=0,
            quality={"isCorrect": False},
        )
        mid_event = record_learning_event(
            user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-mid",
            knowledge_point_id=str(point.id),
            score=100,
            quality={"isCorrect": True},
        )
        recent_event = record_learning_event(
            user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-recent",
            knowledge_point_id=str(point.id),
            score=100,
            quality={"isCorrect": True},
        )
        LearningEvent.objects.filter(id=old_event.id).update(created_at=timezone.now() - timedelta(days=20))
        LearningEvent.objects.filter(id=mid_event.id).update(created_at=timezone.now() - timedelta(days=10))
        LearningEvent.objects.filter(id=recent_event.id).update(created_at=timezone.now() - timedelta(days=1))

        report = build_learning_effect_report(user)

        self.assertEqual(report["schemaVersion"], "a3.learning-effect.v2")
        self.assertEqual(report["confidence"], "high")
        self.assertEqual(report["missingEvidence"], [])
        self.assertEqual(report["overallEffectScore"], 65)
        knowledge = report["knowledgePoints"][0]
        self.assertEqual(knowledge["knowledgePointId"], str(point.id))
        self.assertEqual(knowledge["name"], "Loop basics")
        self.assertEqual(knowledge["preScore"], 0)
        self.assertEqual(knowledge["postScore"], 100)
        self.assertEqual(knowledge["learningGain"], 100)
        self.assertEqual(knowledge["attemptCount"], 3)
        self.assertEqual(knowledge["correctRate"], 0.667)
        self.assertEqual(knowledge["trend"], "improving")
        self.assertEqual(knowledge["confidence"], "high")
        self.assertEqual(report["trends"]["sevenDay"]["assessment"]["attemptCount"], 1)
        self.assertEqual(report["trends"]["fourteenDay"]["assessment"]["attemptCount"], 2)
        self.assertEqual(report["trends"]["thirtyDay"]["assessment"]["attemptCount"], 3)

    def test_learning_effect_report_v2_marks_low_confidence_when_evidence_is_missing(self):
        user = User.objects.create_user(phone="13800001118", password="TestPassword123")
        LearnerProfile.objects.create(user=user, extra_profile={})

        report = build_learning_effect_report(user)

        self.assertEqual(report["schemaVersion"], "a3.learning-effect.v2")
        self.assertEqual(report["confidence"], "low")
        self.assertIn("近 30 天测评数据不足", report["missingEvidence"])
        self.assertIn("近 30 天学习事件不足", report["missingEvidence"])
        self.assertEqual(report["knowledgePoints"], [])


class ResourceEffectAttributionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001121", password="TestPassword123")
        course = Course.objects.create(code="LE-ATTR-001", title="Resource Attribution")
        chapter = Chapter.objects.create(course=course, order=1, title="Basics")
        self.point = KnowledgePoint.objects.create(chapter=chapter, code="LE-ATTR-KP", order=1, title="Memory paging")
        LearnerProfile.objects.create(user=self.user, extra_profile={})

    def test_resource_effect_attribution_computes_rates_gain_and_confidence(self):
        before = record_learning_event(
            self.user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-before",
            knowledge_point_id=str(self.point.id),
            score=40,
        )
        opened = record_learning_event(
            self.user,
            event_type="resource_opened",
            target_type="resource_pack",
            target_id="pack-1",
            knowledge_point_id=str(self.point.id),
            resource_type="practice_set",
        )
        record_learning_event(
            self.user,
            event_type="resource_completed",
            target_type="resource_pack",
            target_id="pack-1",
            knowledge_point_id=str(self.point.id),
            resource_type="practice_set",
            score=90,
        )
        record_learning_event(
            self.user,
            event_type="resource_favorited",
            target_type="resource_pack",
            target_id="pack-1",
            knowledge_point_id=str(self.point.id),
            resource_type="practice_set",
        )
        for index, score in enumerate((80, 100), start=1):
            record_learning_event(
                self.user,
                event_type="question_answered",
                target_type="assessment_question",
                target_id=f"q-after-{index}",
                knowledge_point_id=str(self.point.id),
                score=score,
            )
        LearningEvent.objects.filter(id=before.id).update(created_at=timezone.now() - timedelta(days=3))
        LearningEvent.objects.filter(id=opened.id).update(created_at=timezone.now() - timedelta(days=2))

        report = build_resource_effect_attribution(self.user, days=30)

        self.assertEqual(report["schemaVersion"], "a3.resource-effect-attribution.v1")
        effect = report["resourceTypes"][0]
        self.assertEqual(effect["resourceType"], "practice_set")
        self.assertEqual(effect["completionRate"], 1)
        self.assertEqual(effect["favoriteRate"], 0.333)
        self.assertEqual(effect["postAssessmentGain"], 50)
        self.assertEqual(effect["effectConfidence"], "medium")
        self.assertFalse(effect["explorationRecommended"])

    def test_resource_attribution_api_requires_login_and_returns_report(self):
        record_learning_event(self.user, event_type="resource_opened", resource_type="lecture_doc")

        response = self.client.get(reverse("learning-resource-attribution"))
        self.assertEqual(response.status_code, 401)

        self.client.force_login(self.user)
        response = self.client.get(reverse("learning-resource-attribution"), {"days": "30"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["attribution"]["resourceTypes"][0]["resourceType"], "lecture_doc")


class LearningEffectAnalyzerAgentTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001119", password="TestPassword123")
        course = Course.objects.create(code="LE-003", title="Learning Effect Agent")
        chapter = Chapter.objects.create(course=course, order=1, title="Basics")
        self.point = KnowledgePoint.objects.create(chapter=chapter, code="LE-KP-003", order=1, title="Deadlock basics")
        LearnerProfile.objects.create(user=self.user, weak_points=["Deadlock basics"], extra_profile={})
        record_learning_event(
            self.user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-1",
            knowledge_point_id=str(self.point.id),
            score=0,
            quality={"isCorrect": False},
        )
        record_learning_event(
            self.user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-2",
            knowledge_point_id=str(self.point.id),
            score=100,
            quality={"isCorrect": True},
        )
        record_learning_event(
            self.user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-3",
            knowledge_point_id=str(self.point.id),
            score=100,
            quality={"isCorrect": True},
        )

    @patch("backend.apps.compat.resource_generation.chat_completion")
    def test_evaluate_learning_effect_uses_llm_structured_analysis(self, chat):
        chat.return_value = {
            "content": json.dumps(
                {
                    "schemaVersion": "a3.learning-effect-analysis.v1",
                    "summary": "Deadlock basics is improving.",
                    "riskLevel": "low",
                    "riskReasons": [],
                    "findings": [
                        {
                            "type": "knowledge_point",
                            "targetId": str(self.point.id),
                            "finding": "Learning gain is positive.",
                            "confidence": "high",
                            "evidenceKeys": ["knowledgePoints[0].learningGain"],
                        }
                    ],
                    "nextIntervention": {
                        "type": "increase_challenge",
                        "reason": "Recent answers are correct.",
                        "targetKnowledgePointId": str(self.point.id),
                    },
                }
            ),
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
            "finishReason": "stop",
            "usage": {},
        }

        report = evaluate_learning_effect(self.user)

        self.assertEqual(report["analysisSource"], "llm")
        self.assertFalse(report["analysisDegraded"])
        self.assertEqual(report["analysis"]["riskLevel"], "low")
        self.assertEqual(report["analysis"]["nextIntervention"]["type"], "increase_challenge")
        self.assertIn("agentTrace", report)
        self.assertEqual(report["agentTrace"]["workflow"], "learning_effect_analysis")
        self.assertTrue(any(step["name"] == "LearningEffectAnalyzerAgent" for step in report["agentTrace"]["steps"]))
        persisted = build_learning_effect_report(self.user)
        self.assertEqual(persisted["analysisSource"], "llm")
        self.assertEqual(persisted["analysis"]["summary"], "Deadlock basics is improving.")

    @patch("backend.apps.compat.resource_generation.chat_completion")
    def test_evaluate_learning_effect_falls_back_to_rules_when_llm_unavailable(self, chat):
        chat.side_effect = LLMUnavailable("no key")

        report = evaluate_learning_effect(self.user)

        self.assertEqual(report["analysisSource"], "rules_fallback")
        self.assertTrue(report["analysisDegraded"])
        self.assertIn("no key", report["analysisDegradedReason"])
        self.assertIn("agentTrace", report)
        analyzer_step = next(step for step in report["agentTrace"]["steps"] if step["name"] == "LearningEffectAnalyzerAgent")
        self.assertEqual(analyzer_step["status"], "degraded")
        self.assertIn("nextIntervention", report["analysis"])

    @patch("backend.apps.compat.resource_generation.chat_completion")
    def test_evaluate_learning_effect_writes_next_intervention_to_study_plan(self, chat):
        chat.return_value = {
            "content": json.dumps(
                {
                    "schemaVersion": "a3.learning-effect-analysis.v1",
                    "summary": "Deadlock basics needs remedial practice.",
                    "riskLevel": "high",
                    "riskReasons": [{"reason": "Recent miss", "evidenceKeys": ["knowledgePoints[0].wrongCount"]}],
                    "findings": [],
                    "nextIntervention": {
                        "type": "add_remedial_practice",
                        "reason": "Wrong answers remain concentrated on deadlocks.",
                        "targetKnowledgePointId": str(self.point.id),
                    },
                }
            ),
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
            "finishReason": "stop",
            "usage": {},
        }
        profile = LearnerProfile.objects.get(user=self.user)
        profile.extra_profile = {
            "studyPlan": {
                "planId": "plan-m4",
                "overallProgress": 0,
                "adjustmentTimeline": [],
                "days": [
                    {
                        "dayIndex": 1,
                        "date": timezone.localdate().isoformat(),
                        "progress": 0,
                        "tasks": [],
                    }
                ],
            }
        }
        profile.save(update_fields=["extra_profile"])

        report = evaluate_learning_effect(self.user)

        self.assertIn("planAdjustmentAction", report)
        profile.refresh_from_db()
        plan = profile.extra_profile["studyPlan"]
        adjustment = plan["lastLearningEffectAdjustment"]
        self.assertEqual(adjustment["strategy"], "add_remedial_practice")
        self.assertEqual(adjustment["action"]["taskType"], "practice")
        self.assertEqual(adjustment["action"]["knowledgePointId"], str(self.point.id))
        self.assertEqual(plan["adjustmentTimeline"][0]["type"], "learning_effect")
        self.assertEqual(plan["days"][0]["tasks"][0]["metadata"]["generatedBy"], "learning_effect_adjustment")
