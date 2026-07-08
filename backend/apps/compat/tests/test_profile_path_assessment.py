from .common import *


class CompatApiTests(CompatApiTestCase):
    def test_profile_extract_uses_kernel_trace_agents(self):
        self.user.privacy_accepted = True
        self.user.save(update_fields=["privacy_accepted", "updated_at"])

        response = self.client.post(
            "/api/profile/extract/",
            data=json.dumps({
                "text": "I am a sophomore automation student. I have weak foundation in root locus and want practice questions.",
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("profile", payload)
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        step_names = list(run.steps.order_by("order").values_list("name", flat=True))
        self.assertEqual(step_names, ["SafetyAgent", "ProfileAgent", "MemoryAgent"])
        steps = {step.name: step for step in run.steps.all()}
        safety_metadata = steps["SafetyAgent"].metadata
        profile_metadata = steps["ProfileAgent"].metadata
        memory_metadata = steps["MemoryAgent"].metadata
        self.assertEqual(safety_metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")
        self.assertEqual(safety_metadata["evidence"]["policy"], "learning_safety_rules")
        self.assertIn("category", safety_metadata["safety"])
        self.assertEqual(profile_metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")
        self.assertEqual(profile_metadata["evidence"]["source"], "free_form_profile_text")
        self.assertGreaterEqual(profile_metadata["evidence"]["updatedFieldCount"], 1)
        self.assertGreaterEqual(profile_metadata["evidence"]["weakPointCount"], 1)
        self.assertIn("profileFieldNames", profile_metadata["evidence"])
        self.assertEqual(profile_metadata["quality"]["profileFieldsExtracted"], True)
        self.assertEqual(memory_metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")
        self.assertEqual(memory_metadata["evidence"]["persistTarget"], "LearnerProfile")
        self.assertIn("profileId", memory_metadata["evidence"])
        self.assertGreaterEqual(memory_metadata["evidence"]["weakPointCount"], 1)
        self.assertEqual(memory_metadata["quality"]["memoryWrite"], True)


    def test_path_generate_alias_uses_existing_planner(self):
        course = Course.objects.get(code="AUTO-CONTROL-001")

        response = self.client.post(
            "/api/path/generate/",
            data=json.dumps({"courseId": str(course.id), "force": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["success"])
        self.assertGreater(len(response.json()["path"]["items"]), 0)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=response.json()["traceId"])
        step_names = [step.name for step in run.steps.all()]
        self.assertEqual(step_names, ["LearningStateAgent", "PlannerAgent", "GraphAgent", "StudyPlanAgent"])
        steps = {step.name: step for step in run.steps.all()}
        planner_metadata = steps["PlannerAgent"].metadata
        graph_metadata = steps["GraphAgent"].metadata
        plan_metadata = steps["StudyPlanAgent"].metadata
        self.assertIn("strategy", planner_metadata["evidence"])
        self.assertIn("weakPointCount", planner_metadata["evidence"])
        self.assertIn("pathItemCount", planner_metadata["evidence"])
        self.assertIn("firstNode", graph_metadata["evidence"])
        self.assertIn("currentNodeCount", graph_metadata["evidence"])
        self.assertIn("lockedNodeCount", graph_metadata["evidence"])
        self.assertEqual(plan_metadata["evidence"]["plannerInput"], "latest_learning_path")
        self.assertIn("dayCount", plan_metadata["evidence"])
        self.assertIn("taskCount", plan_metadata["evidence"])

    @patch("backend.apps.compat.agent_kernel.generate_planner_adjustment")
    def test_planner_agent_adds_llm_adjustment_without_replacing_rule_path(self, generate_planner_adjustment):
        generate_planner_adjustment.return_value = {
            "advice": "Keep root locus first, then add a short review block before frequency response.",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        response = self.client.post(
            "/api/path/generate/",
            data=json.dumps({"goal": "root locus", "force": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertGreater(len(payload["path"]["items"]), 0)
        generate_planner_adjustment.assert_called_once()
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        planner_step = run.steps.get(name="PlannerAgent")
        self.assertEqual(planner_step.metadata["evidence"]["llmProvider"], "dashscope")
        self.assertFalse(planner_step.metadata["evidence"]["llmFallback"])
        self.assertIn("review block", planner_step.metadata["evidence"]["llmAdvice"])
        self.assertEqual(planner_step.metadata["evidence"]["ruleGuardrail"], "learning_path_persisted_before_llm_advice")


    def test_open_api_progress_track_returns_dashboard_payload(self):
        response = self.client.get("/api/v1/progress/track/")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertIn("path", response.json())


    @override_settings(A3_AGENT_CIRCUIT_MIN_SAMPLES=999999)
    def test_assess_grade_uses_kernel_trace_agents(self):
        course = Course.objects.get(code="AUTO-CONTROL-001")
        point = course.chapters.first().knowledge_points.first()
        question = Question.objects.create(
            knowledge_point=point,
            stem="agent kernel grading question",
            options=[
                {"key": "A", "text": "correct"},
                {"key": "B", "text": "wrong"},
                {"key": "C", "text": "wrong again"},
                {"key": "D", "text": "wrong once more"},
            ],
            correct_answer="A",
            explanation="kernel explanation",
            error_cause="concept confusion",
        )
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id)])
        LearnerProfile.objects.create(user=self.user, weak_points=[])

        response = self.client.post(
            "/api/assess/grade/",
            data=json.dumps({"sessionId": str(session.id), "selectedAnswer": "B"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        evidence = payload["loopEvidence"]
        self.assertEqual(evidence["schemaVersion"], "a3.learning-loop-evidence.v1")
        self.assertEqual(evidence["trigger"], "assessment_submit")
        self.assertEqual(evidence["subject"]["sessionId"], str(session.id))
        targets = {item["target"]: item for item in evidence["writeBacks"]}
        self.assertEqual(targets["wrong_notebook"]["status"], "updated")
        self.assertEqual(targets["learner_profile"]["status"], "updated")
        self.assertEqual(targets["study_plan"]["status"], "updated")
        self.assertEqual(targets["report"]["status"], "refreshed")
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        step_names = list(run.steps.order_by("order").values_list("name", flat=True))
        self.assertEqual(
            step_names,
            ["AdaptivePracticeAgent", "AssessmentAgent", "ProfileUpdateAgent", "ReviewSchedulerAgent", "StudyPlanAgent"],
        )


    def test_assess_grade_alias_syncs_wrong_point_to_profile(self):
        course = Course.objects.get(code="AUTO-CONTROL-001")
        point = course.chapters.first().knowledge_points.first()
        question = Question.objects.create(
            knowledge_point=point,
            stem="鏍硅建杩规祴璇曢",
            options=[
                {"key": "A", "text": "correct"},
                {"key": "B", "text": "wrong"},
                {"key": "C", "text": "wrong again"},
                {"key": "D", "text": "wrong once more"},
            ],
            correct_answer="A",
            explanation="瑙ｆ瀽",
            error_cause="姒傚康娣锋穯",
        )
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id)])
        LearnerProfile.objects.create(user=self.user, weak_points=[])

        response = self.client.post(
            "/api/assess/grade/",
            data=json.dumps({"sessionId": str(session.id), "selectedAnswer": "B"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["isCorrect"])
        self.assertIn(point.title, payload["profileUpdate"]["weakPoints"])
        profile = LearnerProfile.objects.get(user=self.user)
        self.assertIn(point.title, profile.weak_points)

    def test_admission_diagnostic_writes_profile_signals_and_snapshot(self):
        response = self.client.post(
            "/api/learning/admission-diagnostic/",
            data=json.dumps(
                {
                    "goal": "final review",
                    "dailyMinutes": 45,
                    "durationDays": 7,
                    "answers": [
                        {"questionId": "transfer-function", "selectedIndex": 0},
                        {"questionId": "stability", "selectedIndex": 1},
                        {"questionId": "root-locus", "selectedIndex": 0},
                        {"questionId": "time-response", "selectedIndex": 2},
                        {"questionId": "frequency-response", "selectedIndex": 0},
                    ],
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["success"])
        profile = LearnerProfile.objects.get(user=self.user)
        signal_sources = {signal.get("source") for signal in profile.extra_profile.get("profileSignals", [])}
        self.assertIn("admission_diagnostic", signal_sources)
        self.assertIn("profileSnapshot", profile.extra_profile)
