from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from backend.apps.accounts.models import User, UserRole
from backend.apps.assessments.models import (
    AssessmentAnswer,
    AssessmentSession,
    Question,
    SessionStatus,
)
from backend.apps.assessments.services import answer_assessment_question
from backend.apps.learning.models import (
    Chapter,
    CoachingMessage,
    CoachingMessageRole,
    CoachingSession,
    CoachingSessionStatus,
    Course,
    KnowledgePoint,
    TutorAvatarAsset,
    TutorPersonaConfiguration,
    TutorPersonaFeedback,
)
from backend.apps.learning.services import append_coaching_messages
from backend.apps.system.models import AdminAuditLog
from backend.apps.system.admin_tutor_services import (
    _build_analytics,
    _cached_analytics,
    invalidate_admin_tutor_analytics_cache,
)
from backend.apps.system.admin_tutor_cache import (
    admin_tutor_analytics_cache_key,
    get_admin_tutor_analytics_generation,
)


OVERLAY_CACHE_KEY = "a3:tutor-persona-config:v1"
KNOWN_PERSONA_IDS = {
    "structured-teacher",
    "socratic-guide",
    "practice-coach",
    "foundation-coach",
}


class AdminTutorApiTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = Client()
        self.admin = User.objects.create_user(
            phone="13800008001",
            email="admin-private@example.com",
            password="TestPassword123",
            role=UserRole.ADMIN,
        )
        self.student = User.objects.create_user(
            phone="13800008002",
            email="student-private@example.com",
            display_name="Private learner name",
            password="TestPassword123",
            role=UserRole.STUDENT,
        )
        self.teacher = User.objects.create_user(
            phone="13800008003",
            password="TestPassword123",
            role=UserRole.TEACHER,
        )
        self.client.force_login(self.admin)
        self.now = timezone.now()

        self.course = Course.objects.create(code="ADMIN-TUTOR", title="Tutor analytics")
        self.chapter = Chapter.objects.create(course=self.course, order=1, title="Chapter")
        self.point = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="ADMIN-TUTOR-KP-1",
            order=1,
            title="Point one",
        )
        self.other_point = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="ADMIN-TUTOR-KP-2",
            order=2,
            title="Point two",
        )

    def tearDown(self):
        cache.clear()

    def patch_persona(self, persona_id="structured-teacher", **payload):
        if "expectedUpdatedAt" not in payload:
            updated_at = (
                TutorPersonaConfiguration.objects.filter(persona_id=persona_id)
                .values_list("updated_at", flat=True)
                .first()
            )
            if updated_at is not None:
                payload["expectedUpdatedAt"] = updated_at.isoformat()
        return self.client.patch(
            f"/api/admin/tutors/personas/{persona_id}/",
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR="203.0.113.44, 10.0.0.8",
        )

    def create_session(
        self,
        *,
        user=None,
        persona_id="structured-teacher",
        status=CoachingSessionStatus.ENDED,
        started_at=None,
        ended_at=None,
        fallback_used=False,
        include_fallback_evidence=True,
        knowledge_point=None,
        private_metadata=None,
    ):
        started_at = started_at or self.now - timedelta(days=1)
        if ended_at is None and status == CoachingSessionStatus.ENDED:
            ended_at = started_at + timedelta(minutes=20)
        metadata = {
            "tutorPersona": {
                "id": persona_id,
                "name": "Public persona",
                "instruction": "private prompt must never leak",
                "voice": {"openaiVoice": "private-provider-voice"},
            },
            "providerKey": "provider-secret-key",
            "absolutePath": "C:\\private\\avatar.vrm",
        }
        if include_fallback_evidence:
            metadata["fallbackUsed"] = fallback_used
        if private_metadata:
            metadata.update(private_metadata)
        return CoachingSession.objects.create(
            user=user or self.student,
            course=self.course,
            knowledge_point=knowledge_point if knowledge_point is not None else self.point,
            status=status,
            metadata=metadata,
            started_at=started_at,
            ended_at=ended_at,
        )

    def create_messages(self, session, *, user_count, assistant_verified):
        for index in range(user_count):
            CoachingMessage.objects.create(
                session=session,
                role=CoachingMessageRole.USER,
                content=f"private student message {index}",
            )
        for index, verified in enumerate(assistant_verified):
            CoachingMessage.objects.create(
                session=session,
                role=CoachingMessageRole.ASSISTANT,
                content=f"private assistant message {index}",
                verified=verified,
                metadata={"providerVoice": "must-not-leak"},
            )

    def create_question(self, point, suffix):
        return Question.objects.create(
            knowledge_point=point,
            stem=f"Question {suffix}",
            options=["A", "B"],
            correct_answer="A",
            explanation="Explanation",
        )

    def create_assessment(
        self,
        *,
        user,
        completed_at,
        answers,
        status=SessionStatus.COMPLETED,
        overall_score=0,
        assessment_id=None,
    ):
        create_fields = {
            "user": user,
            "status": status,
            "question_ids": [str(question.id) for question, _is_correct in answers],
            "score": overall_score,
            "completed_at": completed_at,
        }
        if assessment_id is not None:
            create_fields["id"] = assessment_id
        assessment = AssessmentSession.objects.create(
            **create_fields,
        )
        for question, is_correct in answers:
            AssessmentAnswer.objects.create(
                session=assessment,
                question=question,
                selected_answer="A" if is_correct else "B",
                is_correct=is_correct,
            )
        return assessment

    def test_get_and_patch_are_admin_only(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/admin/tutors/").status_code, 401)
        self.assertEqual(
            self.client.patch(
                "/api/admin/tutors/personas/structured-teacher/",
                data=json.dumps({"enabled": True, "reason": "maintenance"}),
                content_type="application/json",
            ).status_code,
            401,
        )

        for user in (self.student, self.teacher):
            with self.subTest(role=user.role):
                self.client.force_login(user)
                self.assertEqual(self.client.get("/api/admin/tutors/").status_code, 403)
                self.assertEqual(
                    self.client.patch(
                        "/api/admin/tutors/personas/structured-teacher/",
                        data=json.dumps({"enabled": True, "reason": "maintenance"}),
                        content_type="application/json",
                    ).status_code,
                    403,
                )

    def test_get_defaults_to_30d_and_rejects_unknown_ranges(self):
        response = self.client.get("/api/admin/tutors/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["range"], "30d")

        for value in ("1d", "7D", "", "all", "30 days"):
            with self.subTest(value=value):
                response = self.client.get("/api/admin/tutors/", {"range": value})
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.json()["success"])

    def test_get_has_stable_shape_and_explicit_empty_metric_statuses(self):
        response = self.client.get("/api/admin/tutors/", {"range": "7d"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            set(payload),
            {"success", "range", "dataStatus", "kpis", "personas", "assets", "providerStatus", "analytics"},
        )
        self.assertEqual(
            set(payload["kpis"]),
            {"enabledPersonaCount", "sessionCount", "verifiedResponseRate", "satisfaction"},
        )
        self.assertEqual(
            set(payload["analytics"]),
            {"adoption", "sessionQuality", "feedback", "assessmentAssociation"},
        )
        self.assertEqual(payload["kpis"]["sessionCount"], 0)
        self.assertIsNone(payload["kpis"]["verifiedResponseRate"]["value"])
        self.assertEqual(payload["kpis"]["verifiedResponseRate"]["dataStatus"], "not_collected")
        self.assertEqual(
            payload["kpis"]["satisfaction"],
            {"value": None, "sampleCount": 0, "dataStatus": "not_collected"},
        )
        adoption = payload["analytics"]["adoption"][0]
        feedback = {
            item["metric"]: item for item in payload["analytics"]["feedback"]
        }
        self.assertIsNone(adoption["value"])
        self.assertEqual(adoption["dataStatus"], "not_collected")
        self.assertEqual(feedback["coverage"]["dataStatus"], "not_collected")
        association = payload["analytics"]["assessmentAssociation"]
        self.assertEqual(association["dataStatus"], "insufficient_sample")
        self.assertIsNone(association["averageDelta"])
        self.assertEqual(association["pairCount"], 0)
        self.assertTrue(association["observedAssociation"])
        self.assertEqual(association["note"], "观察到的相关性，不代表因果关系")

        allowed_statuses = {"collected", "partial", "not_collected", "insufficient_sample"}
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn('"dataStatus": "unknown"', serialized)
        for status in self._all_data_statuses(payload):
            self.assertIn(status, allowed_statuses)

    def test_analytics_collections_are_arrays_with_adoption_trend(self):
        response = self.client.get("/api/admin/tutors/", {"range": "7d"})

        self.assertEqual(response.status_code, 200)
        analytics = response.json()["analytics"]
        self.assertIsInstance(analytics["adoption"], list)
        self.assertIsInstance(analytics["sessionQuality"], list)
        self.assertIsInstance(analytics["feedback"], list)
        self.assertEqual(len(analytics["adoption"]), 7)
        self.assertEqual(
            set(analytics["adoption"][0]),
            {"date", "value", "numerator", "denominator", "dataStatus"},
        )
        self.assertTrue(all(point["value"] is None for point in analytics["adoption"]))
        self.assertTrue(
            all(point["dataStatus"] == "not_collected" for point in analytics["adoption"])
        )

    def test_persona_asset_and_provider_rows_are_safe_projections(self):
        default_asset = TutorAvatarAsset.objects.get(is_default=True)
        default_asset.author = "private author"
        default_asset.source_name = "private source"
        default_asset.source_url = "https://private.example/source"
        default_asset.license_name = ""
        default_asset.license_url = "https://private.example/license"
        default_asset.metadata = {
            "privatePrompt": "do not return",
            "providerVoice": "private-voice",
            "absolutePath": "D:\\private\\teacher.vrm",
            "apiKey": "secret",
        }
        default_asset.save()
        response = self.client.get("/api/admin/tutors/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual({row["id"] for row in payload["personas"]}, KNOWN_PERSONA_IDS)
        for row in payload["personas"]:
            self.assertEqual(
                set(row),
                {
                    "id",
                    "name",
                    "shortDescription",
                    "teachingStyle",
                    "allowedWorkflows",
                    "schemaVersion",
                    "enabled",
                    "avatarAssetId",
                    "voicePreviewEnabled",
                    "configurationDataStatus",
                    "updatedAt",
                },
            )
        self.assertEqual(len(payload["assets"]), 1)
        self.assertEqual(
            set(payload["assets"][0]),
            {
                "assetId",
                "displayName",
                "publicPath",
                "fileSizeBytes",
                "sha256",
                "status",
                "isDefault",
                "licenseComplete",
            },
        )
        self.assertTrue(payload["assets"][0]["publicPath"].startswith("/a3/assets/teacher-avatar/"))
        self.assertFalse(payload["assets"][0]["licenseComplete"])
        self.assertEqual(
            payload["providerStatus"],
            [
                {
                    "id": "tutorVoicePreview",
                    "status": "unknown",
                    "dataStatus": "not_collected",
                }
            ],
        )

        serialized = json.dumps(payload, ensure_ascii=False).lower()
        for secret in (
            "private prompt",
            "private-provider-voice",
            "private-voice",
            "provider-secret-key",
            "admin-private@example.com",
            "student-private@example.com",
            "private learner name",
            "private student message",
            "private assistant message",
            "private.example",
            "d:\\private",
            "c:\\private",
            "apikey",
        ):
            self.assertNotIn(secret.lower(), serialized)

    def test_exact_session_feedback_and_quality_metric_math(self):
        structured = self.create_session(persona_id="structured-teacher", fallback_used=False)
        self.create_messages(structured, user_count=2, assistant_verified=[True, False])
        TutorPersonaFeedback.objects.create(
            user=self.student,
            session=structured,
            persona_id="structured-teacher",
            rating=5,
        )

        socratic = self.create_session(
            persona_id="socratic-guide",
            status=CoachingSessionStatus.ACTIVE,
            ended_at=None,
            fallback_used=True,
        )
        self.create_messages(socratic, user_count=1, assistant_verified=[True])

        unknown = self.create_session(persona_id="unknown-persona", fallback_used=False)
        self.create_messages(unknown, user_count=3, assistant_verified=[])

        response = self.client.get("/api/admin/tutors/", {"range": "7d"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        analytics = payload["analytics"]

        self.assertEqual(payload["kpis"]["sessionCount"], 3)
        self.assertEqual(payload["kpis"]["verifiedResponseRate"]["value"], 0.6667)
        self.assertEqual(payload["kpis"]["satisfaction"], {"value": 5.0, "sampleCount": 1, "dataStatus": "collected"})
        adoption = analytics["adoption"]
        adoption_numerator = sum(point["numerator"] for point in adoption)
        adoption_denominator = sum(point["denominator"] for point in adoption)
        self.assertEqual(
            round(adoption_numerator / adoption_denominator, 4),
            0.6667,
        )
        self.assertEqual(adoption_numerator, 2)
        self.assertEqual(adoption_denominator, 3)
        per_persona_metric = self._metric(analytics["sessionQuality"], "perPersonaSessionCount")
        per_persona = {row["personaId"]: row["sessionCount"] for row in per_persona_metric["values"]}
        self.assertEqual(per_persona["structured-teacher"], 1)
        self.assertEqual(per_persona["socratic-guide"], 1)
        self.assertEqual(per_persona["practice-coach"], 0)
        self.assertEqual(self._metric(analytics["sessionQuality"], "averageStudentMessageTurns")["value"], 2.0)
        self.assertEqual(self._metric(analytics["sessionQuality"], "verifiedAssistantResponseRate")["value"], 0.6667)
        self.assertEqual(self._metric(analytics["sessionQuality"], "normalEndedRate")["value"], 0.6667)
        self.assertEqual(self._metric(analytics["sessionQuality"], "runtimeFallbackRate")["value"], 0.5)
        self.assertEqual(
            self._metric(analytics["feedback"], "coverage"),
            {"metric": "coverage", "value": 1.0, "numerator": 1, "denominator": 1, "dataStatus": "collected"},
        )
        self.assertEqual(self._metric(analytics["feedback"], "satisfaction")["sampleCount"], 1)

    def test_missing_runtime_fallback_evidence_is_partial_not_false(self):
        self.create_session(persona_id="structured-teacher", include_fallback_evidence=False)

        payload = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()
        metric = self._metric(payload["analytics"]["sessionQuality"], "runtimeFallbackRate")

        self.assertIsNone(metric["value"])
        self.assertEqual(metric["numerator"], 0)
        self.assertEqual(metric["denominator"], 1)
        self.assertEqual(metric["evidenceCount"], 0)
        self.assertEqual(metric["dataStatus"], "not_collected")

    def test_sessions_outside_range_do_not_affect_metrics(self):
        self.create_session(started_at=self.now - timedelta(days=8), ended_at=self.now - timedelta(days=8) + timedelta(minutes=10))
        self.create_session(started_at=self.now - timedelta(days=6))

        seven_days = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()
        self.assertEqual(seven_days["kpis"]["sessionCount"], 1)

    def test_normal_ended_rate_excludes_archived_sessions_from_denominator(self):
        self.create_session(status=CoachingSessionStatus.ENDED)
        self.create_session(status=CoachingSessionStatus.ACTIVE, ended_at=None)
        self.create_session(status=CoachingSessionStatus.ARCHIVED)

        payload = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()

        self.assertEqual(
            self._metric(payload["analytics"]["sessionQuality"], "normalEndedRate"),
            {"metric": "normalEndedRate", "value": 0.5, "numerator": 1, "denominator": 2, "dataStatus": "collected"},
        )

    def test_assessment_association_uses_point_answers_windows_and_order(self):
        point_questions = [self.create_question(self.point, f"point-{index}") for index in range(2)]
        other_question = self.create_question(self.other_point, "other-point")

        for index in range(5):
            learner = User.objects.create_user(
                phone=f"138000081{index:02d}",
                password="TestPassword123",
                role=UserRole.STUDENT,
            )
            started_at = self.now - timedelta(days=2)
            ended_at = started_at + timedelta(hours=1)
            self.create_session(
                user=learner,
                persona_id="practice-coach",
                started_at=started_at,
                ended_at=ended_at,
                knowledge_point=self.point,
            )

            self.create_assessment(
                user=learner,
                completed_at=started_at - timedelta(days=8),
                answers=[(point_questions[0], True), (point_questions[1], True)],
                overall_score=100,
            )
            self.create_assessment(
                user=learner,
                completed_at=started_at - timedelta(days=2),
                answers=[(point_questions[0], False), (point_questions[1], False)],
                overall_score=99,
            )
            self.create_assessment(
                user=learner,
                completed_at=started_at - timedelta(hours=1),
                answers=[(point_questions[0], True), (point_questions[1], False)],
                overall_score=99,
            )
            self.create_assessment(
                user=learner,
                completed_at=started_at - timedelta(minutes=30),
                answers=[(other_question, True)],
                overall_score=100,
            )
            self.create_assessment(
                user=learner,
                completed_at=ended_at + timedelta(hours=1),
                answers=[(point_questions[0], True), (point_questions[1], True)],
                overall_score=1,
            )
            self.create_assessment(
                user=learner,
                completed_at=ended_at + timedelta(hours=2),
                answers=[(point_questions[0], False), (point_questions[1], False)],
                overall_score=0,
            )
            self.create_assessment(
                user=learner,
                completed_at=ended_at + timedelta(days=8),
                answers=[(point_questions[0], False), (point_questions[1], False)],
                overall_score=0,
            )
            self.create_assessment(
                user=learner,
                completed_at=ended_at + timedelta(minutes=30),
                answers=[(point_questions[0], False), (point_questions[1], False)],
                status=SessionStatus.IN_PROGRESS,
                overall_score=0,
            )

        association = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()["analytics"][
            "assessmentAssociation"
        ]
        self.assertEqual(
            association,
            {
                "averageDelta": 50.0,
                "positiveCount": 5,
                "flatCount": 0,
                "negativeCount": 0,
                "pairCount": 5,
                "coverage": {"value": 1.0, "numerator": 5, "denominator": 5, "dataStatus": "collected"},
                "observedAssociation": True,
                "note": "观察到的相关性，不代表因果关系",
                "dataStatus": "collected",
            },
        )

    def test_assessment_association_under_five_pairs_hides_delta(self):
        questions = [self.create_question(self.point, f"small-{index}") for index in range(2)]
        for index in range(5):
            learner = User.objects.create_user(
                phone=f"138000082{index:02d}",
                password="TestPassword123",
            )
            started_at = self.now - timedelta(days=2)
            ended_at = started_at + timedelta(minutes=30)
            self.create_session(user=learner, started_at=started_at, ended_at=ended_at)
            self.create_assessment(
                user=learner,
                completed_at=started_at - timedelta(hours=1),
                answers=[(questions[0], False), (questions[1], False)],
            )
            if index < 4:
                self.create_assessment(
                    user=learner,
                    completed_at=ended_at + timedelta(hours=1),
                    answers=[(questions[0], True), (questions[1], True)],
                )

        association = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()["analytics"][
            "assessmentAssociation"
        ]
        self.assertEqual(association["pairCount"], 4)
        self.assertIsNone(association["averageDelta"])
        self.assertEqual(association["positiveCount"], 4)
        self.assertEqual(association["dataStatus"], "insufficient_sample")
        self.assertEqual(
            association["coverage"],
            {"value": 0.8, "numerator": 4, "denominator": 5, "dataStatus": "collected"},
        )

    def test_assessment_association_excludes_exact_session_boundaries(self):
        question = self.create_question(self.point, "strict-boundaries")
        started_at = self.now - timedelta(days=2)
        ended_at = started_at + timedelta(hours=1)
        self.create_session(started_at=started_at, ended_at=ended_at)
        for completed_at, is_correct in (
            (started_at - timedelta(minutes=1), False),
            (started_at, True),
            (ended_at, False),
            (ended_at + timedelta(minutes=1), True),
        ):
            self.create_assessment(
                user=self.student,
                completed_at=completed_at,
                answers=[(question, is_correct)],
            )

        association = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()["analytics"][
            "assessmentAssociation"
        ]

        self.assertEqual(association["pairCount"], 1)
        self.assertEqual(association["positiveCount"], 1)
        self.assertEqual(association["flatCount"], 0)
        self.assertEqual(association["negativeCount"], 0)

    def test_assessment_association_breaks_same_time_ties_by_session_id(self):
        question = self.create_question(self.point, "same-time-order")
        started_at = self.now - timedelta(days=2)
        ended_at = started_at + timedelta(hours=1)
        self.create_session(started_at=started_at, ended_at=ended_at)
        before_at = started_at - timedelta(hours=1)
        after_at = ended_at + timedelta(hours=1)

        for assessment_id, completed_at, is_correct in (
            ("00000000-0000-0000-0000-000000000002", before_at, True),
            ("00000000-0000-0000-0000-000000000001", before_at, False),
            ("00000000-0000-0000-0000-000000000004", after_at, False),
            ("00000000-0000-0000-0000-000000000003", after_at, True),
        ):
            self.create_assessment(
                assessment_id=assessment_id,
                user=self.student,
                completed_at=completed_at,
                answers=[(question, is_correct)],
            )

        association = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()["analytics"][
            "assessmentAssociation"
        ]

        self.assertEqual(association["pairCount"], 1)
        self.assertEqual(association["positiveCount"], 0)
        self.assertEqual(association["flatCount"], 1)
        self.assertEqual(association["negativeCount"], 0)

    def test_assessment_association_excludes_unknown_and_missing_persona_sessions(self):
        question = self.create_question(self.point, "persona-filter")
        started_at = self.now - timedelta(days=2)
        ended_at = started_at + timedelta(minutes=30)
        self.create_session(started_at=started_at, ended_at=ended_at)

        for index, metadata in enumerate(
            (
                {"tutorPersona": {"id": "unknown-persona"}, "fallbackUsed": False},
                {"fallbackUsed": False},
            )
        ):
            learner = User.objects.create_user(
                phone=f"138000083{index:02d}",
                password="TestPassword123",
            )
            CoachingSession.objects.create(
                user=learner,
                course=self.course,
                knowledge_point=self.point,
                status=CoachingSessionStatus.ENDED,
                metadata=metadata,
                started_at=started_at,
                ended_at=ended_at,
            )
            self.create_assessment(
                user=learner,
                completed_at=started_at - timedelta(hours=1),
                answers=[(question, False)],
            )
            self.create_assessment(
                user=learner,
                completed_at=ended_at + timedelta(hours=1),
                answers=[(question, True)],
            )

        association = self.client.get("/api/admin/tutors/", {"range": "7d"}).json()["analytics"][
            "assessmentAssociation"
        ]

        self.assertEqual(association["pairCount"], 0)
        self.assertEqual(
            association["coverage"],
            {"value": 0.0, "numerator": 0, "denominator": 1, "dataStatus": "collected"},
        )

    def test_get_analytics_query_count_is_bounded_independent_of_session_count(self):
        for index in range(12):
            session = self.create_session(persona_id="structured-teacher")
            self.create_messages(session, user_count=index % 3, assistant_verified=[index % 2 == 0])
        cache.clear()

        with CaptureQueriesContext(connection) as captured:
            response = self.client.get("/api/admin/tutors/", {"range": "7d"})

        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(len(captured), 12)

    def test_message_and_feedback_metrics_use_range_filtered_session_joins(self):
        session = self.create_session()
        self.create_messages(session, user_count=1, assistant_verified=[True])
        TutorPersonaFeedback.objects.create(
            user=self.student,
            session=session,
            persona_id="structured-teacher",
            rating=4,
        )
        cache.clear()

        with CaptureQueriesContext(connection) as captured:
            response = self.client.get("/api/admin/tutors/", {"range": "7d"})

        self.assertEqual(response.status_code, 200)
        queries = [query["sql"].lower() for query in captured.captured_queries]
        message_sql = next(query for query in queries if "a3_coaching_messages" in query)
        feedback_sql = next(query for query in queries if "a3_tutor_persona_feedback" in query)
        for sql in (message_sql, feedback_sql):
            self.assertIn("join", sql)
            self.assertIn("a3_coaching_sessions", sql)
            self.assertIn("started_at", sql)
            self.assertNotIn('session_id" in (', sql)

    def test_tutor_analytics_models_expose_range_lookup_indexes(self):
        coaching_indexes = {
            (index.name, tuple(index.fields)) for index in CoachingSession._meta.indexes
        }
        assessment_indexes = {
            (index.name, tuple(index.fields)) for index in AssessmentSession._meta.indexes
        }

        self.assertIn(("idx_coach_started_at", ("started_at",)), coaching_indexes)
        self.assertIn(
            ("a3_asmt_user_stat_done_idx", ("user", "status", "completed_at")),
            assessment_indexes,
        )

    def test_analytics_cache_hits_for_sixty_seconds(self):
        first = self.create_session()
        with patch(
            "backend.apps.system.admin_tutor_services._build_analytics",
            wraps=_build_analytics,
        ) as build:
            first_response = self.client.get("/api/admin/tutors/", {"range": "7d"})
            cached_response = self.client.get("/api/admin/tutors/", {"range": "7d"})

        self.assertEqual(first_response.json()["kpis"]["sessionCount"], 1)
        self.assertEqual(cached_response.json()["kpis"]["sessionCount"], 1)
        self.assertEqual(build.call_count, 1)

        second = self.create_session(persona_id="socratic-guide")
        invalidate_admin_tutor_analytics_cache()
        third_response = self.client.get("/api/admin/tutors/", {"range": "7d"})
        self.assertEqual(third_response.json()["kpis"]["sessionCount"], 2)
        self.assertNotEqual(first.pk, second.pk)

    def test_cache_invalidation_prevents_in_flight_stale_build_from_being_restored(self):
        stale_build_started = Event()
        release_stale_build = Event()
        stale_payload = {"sessionCount": 1, "analytics": {"source": "stale"}}
        fresh_payload = {"sessionCount": 2, "analytics": {"source": "fresh"}}

        def build_analytics(*, days):
            if not stale_build_started.is_set():
                stale_build_started.set()
                self.assertTrue(release_stale_build.wait(timeout=5))
                return stale_payload
            return fresh_payload

        with patch(
            "backend.apps.system.admin_tutor_services._build_analytics",
            side_effect=build_analytics,
        ) as build:
            with ThreadPoolExecutor(max_workers=1) as executor:
                stale_future = executor.submit(_cached_analytics, "7d")
                self.assertTrue(stale_build_started.wait(timeout=5))
                invalidate_admin_tutor_analytics_cache()
                release_stale_build.set()
                self.assertEqual(stale_future.result(timeout=5), stale_payload)

            self.assertEqual(_cached_analytics("7d"), fresh_payload)

        self.assertEqual(build.call_count, 2)

    def test_coaching_message_write_refreshes_cached_session_metrics_on_commit(self):
        initial = self.client.get("/api/admin/tutors/", {"range": "7d"})
        self.assertEqual(initial.json()["kpis"]["sessionCount"], 0)

        with self.captureOnCommitCallbacks(execute=True):
            append_coaching_messages(
                self.student,
                [{"id": "cache-refresh-user", "role": "user", "content": "Explain scheduling."}],
                tutor_persona_id="structured-teacher",
            )

        refreshed = self.client.get("/api/admin/tutors/", {"range": "7d"})
        self.assertEqual(refreshed.json()["kpis"]["sessionCount"], 1)
        self.assertEqual(
            self._metric(
                refreshed.json()["analytics"]["sessionQuality"],
                "averageStudentMessageTurns",
            )["value"],
            1.0,
        )

    def test_assessment_completion_refreshes_cached_association_on_commit(self):
        question = self.create_question(self.point, "cache-refresh")
        question.options = [
            {"key": "A", "text": "Correct option"},
            {"key": "B", "text": "Incorrect option"},
        ]
        question.save(update_fields=["options"])
        started_at = self.now - timedelta(hours=3)
        ended_at = self.now - timedelta(hours=2)
        self.create_session(started_at=started_at, ended_at=ended_at)
        self.create_assessment(
            user=self.student,
            completed_at=started_at - timedelta(hours=1),
            answers=[(question, False)],
        )
        pending = self.create_assessment(
            user=self.student,
            completed_at=None,
            answers=[],
            status=SessionStatus.IN_PROGRESS,
        )
        pending.question_ids = [str(question.id)]
        pending.save(update_fields=["question_ids"])

        initial = self.client.get("/api/admin/tutors/", {"range": "7d"})
        self.assertEqual(initial.json()["analytics"]["assessmentAssociation"]["pairCount"], 0)

        with self.captureOnCommitCallbacks(execute=True):
            answer_assessment_question(self.student, pending, "A")

        refreshed = self.client.get("/api/admin/tutors/", {"range": "7d"})
        self.assertEqual(refreshed.json()["analytics"]["assessmentAssociation"]["pairCount"], 1)

    def test_cache_read_and_write_failures_degrade_safely(self):
        self.create_session()
        with patch(
            "backend.apps.system.admin_tutor_cache.cache.get",
            side_effect=RuntimeError("cache down"),
        ):
            read_failure = self.client.get("/api/admin/tutors/", {"range": "7d"})

        cache.clear()
        self.assertIsNotNone(get_admin_tutor_analytics_generation())
        with patch(
            "backend.apps.system.admin_tutor_services.cache.set",
            side_effect=RuntimeError("cache down"),
        ):
            write_failure = self.client.get("/api/admin/tutors/", {"range": "7d"})

        self.assertEqual(read_failure.status_code, 200)
        self.assertEqual(read_failure.json()["kpis"]["sessionCount"], 1)
        self.assertEqual(write_failure.status_code, 200)
        self.assertEqual(write_failure.json()["kpis"]["sessionCount"], 1)

    def test_patch_rejects_invalid_body_reason_unknown_fields_and_types(self):
        invalid_json = self.client.patch(
            "/api/admin/tutors/personas/structured-teacher/",
            data="{",
            content_type="application/json",
        )
        self.assertEqual(invalid_json.status_code, 400)

        missing_expected_updated_at = self.client.patch(
            "/api/admin/tutors/personas/structured-teacher/",
            data=json.dumps({"enabled": True, "reason": "maintenance"}),
            content_type="application/json",
        )
        self.assertEqual(missing_expected_updated_at.status_code, 400)

        cases = (
            ({"enabled": False}, 400),
            ({"enabled": False, "reason": "   "}, 400),
            ({"enabled": False, "reason": "x" * 256}, 400),
            ({"reason": "maintenance"}, 400),
            ({"enabled": "false", "reason": "maintenance"}, 400),
            ({"voicePreviewEnabled": 1, "reason": "maintenance"}, 400),
            ({"avatarAssetId": 7, "reason": "maintenance"}, 400),
            ({"enabled": True, "privatePrompt": "leak", "reason": "maintenance"}, 400),
            ({"enabled": True, "reason": "rotate api_key=secret"}, 400),
            ({"enabled": True, "reason": "maintenance", "expectedUpdatedAt": None}, 400),
            ({"enabled": True, "reason": "maintenance", "expectedUpdatedAt": "not-a-date"}, 400),
            ({"enabled": True, "reason": "maintenance", "expectedUpdatedAt": "2026-07-26T12:00:00"}, 400),
        )
        for body, expected_status in cases:
            with self.subTest(body=body):
                response = self.patch_persona(**body)
                self.assertEqual(response.status_code, expected_status)

    def test_patch_rejects_unknown_code_persona_even_if_database_row_exists(self):
        default_asset = TutorAvatarAsset.objects.get(is_default=True)
        TutorPersonaConfiguration.objects.create(
            persona_id="database-only-persona",
            avatar_asset=default_asset,
        )

        response = self.patch_persona("database-only-persona", enabled=False, reason="maintenance")
        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.json()["success"])

    def test_patch_rejects_unknown_disabled_and_unsafe_assets(self):
        disabled = TutorAvatarAsset.objects.create(
            asset_id="disabled-avatar",
            display_name="Disabled",
            public_path="/a3/assets/teacher-avatar/disabled.vrm",
            sha256="a" * 64,
            file_size_bytes=10,
            status="disabled",
        )
        unsafe_paths = (
            "https://example.com/avatar.vrm",
            "/a3/assets/teacher-avatar/../private.vrm",
            "/a3/assets/teacher-avatar/private.glb",
            "C:\\private\\avatar.vrm",
        )
        for index, public_path in enumerate(unsafe_paths):
            TutorAvatarAsset.objects.create(
                asset_id=f"unsafe-avatar-{index}",
                display_name="Unsafe",
                public_path=public_path,
                sha256=str(index) * 64,
                file_size_bytes=10,
                status="enabled",
            )

        unknown = self.patch_persona(avatarAssetId="missing-avatar", reason="maintenance")
        disabled_response = self.patch_persona(avatarAssetId=disabled.asset_id, reason="maintenance")
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(disabled_response.status_code, 400)
        for index in range(len(unsafe_paths)):
            with self.subTest(index=index):
                response = self.patch_persona(avatarAssetId=f"unsafe-avatar-{index}", reason="maintenance")
                self.assertEqual(response.status_code, 400)

    def test_patch_rejects_new_corrupt_asset_binding_while_disabling(self):
        disabled = TutorAvatarAsset.objects.create(
            asset_id="disabled-during-disable",
            display_name="Disabled during disable",
            public_path="/a3/assets/teacher-avatar/disabled-during-disable.vrm",
            sha256="3" * 64,
            file_size_bytes=10,
            status="disabled",
        )
        unsafe = TutorAvatarAsset.objects.create(
            asset_id="unsafe-during-disable",
            display_name="Unsafe during disable",
            public_path="/a3/assets/teacher-avatar/../unsafe-during-disable.vrm",
            sha256="4" * 64,
            file_size_bytes=10,
            status="enabled",
        )

        for asset in (disabled, unsafe):
            with self.subTest(asset=asset.asset_id):
                response = self.patch_persona(
                    enabled=False,
                    avatarAssetId=asset.asset_id,
                    reason="disable without rebinding corrupt asset",
                )

                self.assertEqual(response.status_code, 400)
                configuration = TutorPersonaConfiguration.objects.get(
                    persona_id="structured-teacher"
                )
                self.assertTrue(configuration.enabled)
                self.assertNotEqual(configuration.avatar_asset, asset)

    def test_patch_uses_expected_updated_at_for_optimistic_concurrency(self):
        persona = next(
            item
            for item in self.client.get("/api/admin/tutors/").json()["personas"]
            if item["id"] == "structured-teacher"
        )
        body = {
            "voicePreviewEnabled": False,
            "reason": "optimistic update",
            "expectedUpdatedAt": persona["updatedAt"],
        }

        first = self.client.patch(
            "/api/admin/tutors/personas/structured-teacher/",
            data=json.dumps(body),
            content_type="application/json",
        )
        stale = self.client.patch(
            "/api/admin/tutors/personas/structured-teacher/",
            data=json.dumps({**body, "voicePreviewEnabled": True}),
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 200)
        self.assertNotEqual(first.json()["persona"]["updatedAt"], persona["updatedAt"])
        self.assertEqual(stale.status_code, 409)
        self.assertIn("刷新", stale.json()["error"])
        self.assertEqual(stale.json()["errorCode"], "stale_update")
        configuration = TutorPersonaConfiguration.objects.get(persona_id="structured-teacher")
        self.assertFalse(configuration.voice_preview_enabled)
        self.assertEqual(AdminAuditLog.objects.filter(action="tutor.persona.update").count(), 1)

    def test_patch_updates_safe_fields_and_records_sanitized_audit_with_ip(self):
        asset = TutorAvatarAsset.objects.create(
            asset_id="licensed-avatar-v2",
            display_name="Licensed avatar",
            public_path="/a3/assets/teacher-avatar/licensed-v2.vrm",
            author="Author",
            source_name="Source",
            source_url="https://example.com/source",
            license_name="CC-BY",
            license_url="https://example.com/license",
            usage_scope=["education"],
            sha256="b" * 64,
            file_size_bytes=2048,
            status="enabled",
            metadata={"privatePrompt": "never audit", "providerVoice": "never audit"},
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.patch_persona(
                avatarAssetId=asset.asset_id,
                voicePreviewEnabled=False,
                reason="Approved asset rotation",
            )

        self.assertEqual(response.status_code, 200)
        configuration = TutorPersonaConfiguration.objects.get(persona_id="structured-teacher")
        self.assertEqual(configuration.avatar_asset, asset)
        self.assertFalse(configuration.voice_preview_enabled)
        self.assertEqual(configuration.updated_by, self.admin)
        self.assertEqual(
            set(response.json()["persona"]),
            {
                "id",
                "name",
                "shortDescription",
                "teachingStyle",
                "allowedWorkflows",
                "schemaVersion",
                "enabled",
                "avatarAssetId",
                "voicePreviewEnabled",
                "configurationDataStatus",
                "updatedAt",
            },
        )

        audit = AdminAuditLog.objects.get(action="tutor.persona.update")
        self.assertEqual(audit.actor, self.admin)
        self.assertEqual(audit.target_type, "tutor_persona")
        self.assertEqual(audit.target_id, "structured-teacher")
        self.assertEqual(audit.reason, "Approved asset rotation")
        self.assertEqual(audit.actor_ip, "203.0.113.44")
        self.assertEqual(
            set(audit.before),
            {"enabled", "avatarAssetId", "voicePreviewEnabled"},
        )
        self.assertEqual(
            set(audit.after),
            {"enabled", "avatarAssetId", "voicePreviewEnabled"},
        )
        self.assertEqual(audit.after["avatarAssetId"], asset.asset_id)
        serialized = json.dumps({"before": audit.before, "after": audit.after}).lower()
        for secret in (
            "privateprompt",
            "provider",
            "openaivoice",
            "dashscopevoice",
            "absolutepath",
            "private",
            "example.com",
        ):
            self.assertNotIn(secret, serialized)

    def test_patch_prevents_disabling_final_enabled_known_persona(self):
        TutorPersonaConfiguration.objects.filter(persona_id__in=KNOWN_PERSONA_IDS).exclude(
            persona_id="structured-teacher"
        ).update(enabled=False)
        default_asset = TutorAvatarAsset.objects.get(is_default=True)
        TutorPersonaConfiguration.objects.create(
            persona_id="unknown-enabled-persona",
            avatar_asset=default_asset,
            enabled=True,
        )

        response = self.patch_persona(enabled=False, reason="maintenance")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json().get("errorCode"), "last_enabled_persona")
        self.assertNotEqual(response.json().get("errorCode"), "stale_update")
        self.assertTrue(TutorPersonaConfiguration.objects.get(persona_id="structured-teacher").enabled)
        self.assertFalse(AdminAuditLog.objects.filter(action="tutor.persona.update").exists())

    def test_patch_does_not_count_enabled_personas_with_disabled_or_unsafe_assets_as_usable(self):
        disabled_asset = TutorAvatarAsset.objects.create(
            asset_id="disabled-invariant-avatar",
            display_name="Disabled invariant",
            public_path="/a3/assets/teacher-avatar/disabled-invariant.vrm",
            sha256="c" * 64,
            file_size_bytes=10,
            status="disabled",
        )
        unsafe_asset = TutorAvatarAsset.objects.create(
            asset_id="unsafe-invariant-avatar",
            display_name="Unsafe invariant",
            public_path="/a3/assets/teacher-avatar/../unsafe-invariant.vrm",
            sha256="d" * 64,
            file_size_bytes=10,
            status="enabled",
        )
        TutorPersonaConfiguration.objects.filter(persona_id__in=KNOWN_PERSONA_IDS).exclude(
            persona_id__in=("structured-teacher", "socratic-guide")
        ).update(enabled=False)
        other = TutorPersonaConfiguration.objects.get(persona_id="socratic-guide")

        for asset in (disabled_asset, unsafe_asset):
            with self.subTest(asset=asset.asset_id):
                other.avatar_asset = asset
                other.enabled = True
                other.save(update_fields=["avatar_asset", "enabled", "updated_at"])

                response = self.patch_persona(enabled=False, reason="maintenance")

                self.assertEqual(response.status_code, 409)
                self.assertTrue(
                    TutorPersonaConfiguration.objects.get(persona_id="structured-teacher").enabled
                )

    def test_patch_validates_current_bound_asset_when_avatar_id_is_omitted(self):
        disabled_asset = TutorAvatarAsset.objects.create(
            asset_id="disabled-current-avatar",
            display_name="Disabled current",
            public_path="/a3/assets/teacher-avatar/disabled-current.vrm",
            sha256="e" * 64,
            file_size_bytes=10,
            status="disabled",
        )
        unsafe_asset = TutorAvatarAsset.objects.create(
            asset_id="unsafe-current-avatar",
            display_name="Unsafe current",
            public_path="https://example.com/unsafe-current.vrm",
            sha256="f" * 64,
            file_size_bytes=10,
            status="enabled",
        )
        target = TutorPersonaConfiguration.objects.get(persona_id="structured-teacher")

        for asset in (disabled_asset, unsafe_asset):
            with self.subTest(asset=asset.asset_id):
                target.avatar_asset = asset
                target.save(update_fields=["avatar_asset", "updated_at"])

                response = self.patch_persona(voicePreviewEnabled=False, reason="maintenance")

                self.assertEqual(response.status_code, 400)
                target.refresh_from_db()
                self.assertTrue(target.voice_preview_enabled)

    def test_patch_allows_disabling_persona_with_corrupt_bound_asset(self):
        disabled_asset = TutorAvatarAsset.objects.create(
            asset_id="disabled-recovery-avatar",
            display_name="Disabled recovery",
            public_path="/a3/assets/teacher-avatar/disabled-recovery.vrm",
            sha256="1" * 64,
            file_size_bytes=10,
            status="disabled",
        )
        unsafe_asset = TutorAvatarAsset.objects.create(
            asset_id="unsafe-recovery-avatar",
            display_name="Unsafe recovery",
            public_path="/a3/assets/teacher-avatar/../unsafe-recovery.vrm",
            sha256="2" * 64,
            file_size_bytes=10,
            status="enabled",
        )

        for asset in (disabled_asset, unsafe_asset):
            with self.subTest(asset=asset.asset_id):
                target = TutorPersonaConfiguration.objects.get(persona_id="structured-teacher")
                target.enabled = True
                target.avatar_asset = asset
                target.save(update_fields=["enabled", "avatar_asset", "updated_at"])

                response = self.patch_persona(enabled=False, reason="disable corrupt configuration")

                self.assertEqual(response.status_code, 200)
                target.refresh_from_db()
                self.assertFalse(target.enabled)
                self.assertEqual(target.avatar_asset, asset)

    def test_patch_requires_at_least_one_usable_default_asset(self):
        TutorAvatarAsset.objects.filter(is_default=True).update(status="disabled")

        response = self.patch_persona(voicePreviewEnabled=False, reason="maintenance")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json().get("errorCode"), "default_asset_required")
        self.assertNotEqual(response.json().get("errorCode"), "stale_update")
        self.assertTrue(
            TutorPersonaConfiguration.objects.get(persona_id="structured-teacher").voice_preview_enabled
        )

    def test_patch_invalidates_overlay_and_all_analytics_caches_on_commit(self):
        generation = get_admin_tutor_analytics_generation()
        analytics_keys = tuple(
            admin_tutor_analytics_cache_key(item, generation) for item in ("7d", "30d", "90d")
        )
        for key in (*analytics_keys, OVERLAY_CACHE_KEY):
            cache.set(key, {"stale": True}, timeout=60)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.patch_persona(voicePreviewEnabled=False, reason="maintenance")

        self.assertEqual(response.status_code, 200)
        self.assertNotEqual(get_admin_tutor_analytics_generation(), generation)
        for key in (*analytics_keys, OVERLAY_CACHE_KEY):
            self.assertIsNone(cache.get(key))

    @staticmethod
    def _all_data_statuses(value):
        statuses = []
        if isinstance(value, dict):
            if "dataStatus" in value:
                statuses.append(value["dataStatus"])
            for child in value.values():
                statuses.extend(AdminTutorApiTests._all_data_statuses(child))
        elif isinstance(value, list):
            for child in value:
                statuses.extend(AdminTutorApiTests._all_data_statuses(child))
        return statuses

    @staticmethod
    def _metric(rows, metric):
        return next(row for row in rows if row.get("metric") == metric)
