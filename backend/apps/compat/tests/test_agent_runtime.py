from .common import *


class CompatApiTests(CompatApiTestCase):
    def test_agent_kernel_registers_and_runs_named_agents_in_order(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class FirstAgent(BaseAgent):
            name = "FirstAgent"

            def run(self, context):
                return AgentResult(
                    output={"first": True},
                    state_patch={"order": ["first"]},
                    evidence={"source": "unit"},
                    quality={"ok": True},
                )

        class SecondAgent(BaseAgent):
            name = "SecondAgent"

            def run(self, context):
                return AgentResult(
                    output={"second": context.state["first"]},
                    state_patch={"order": [*context.state["order"], "second"]},
                )

        kernel = AgentKernel()
        kernel.register(FirstAgent())
        kernel.register(SecondAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="unit", goal="test kernel", payload={}),
            ["FirstAgent", "SecondAgent"],
        )

        self.assertTrue(result.success)
        self.assertEqual(result.state["order"], ["first", "second"])
        self.assertEqual([step["name"] for step in result.trace["steps"]], ["FirstAgent", "SecondAgent"])
        self.assertEqual(result.trace["workflow"], "unit")


    def test_agent_kernel_uses_agent_fallback_and_marks_degraded_step(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class FailingAgent(BaseAgent):
            name = "FailingAgent"
            role = "fallback test"
            detail = "Primary operation fails."

            def run(self, context):
                raise RuntimeError("primary unavailable")

            def fallback(self, context, error):
                return AgentResult(
                    output={"fallbackUsed": True},
                    state_patch={"degraded": True},
                    evidence={"error": str(error)},
                    quality={"fallback": "used"},
                    detail="Fallback result used.",
                )

        kernel = AgentKernel()
        kernel.register(FailingAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="fallback_unit", goal="test fallback", payload={}),
            ["FailingAgent"],
        )

        self.assertTrue(result.success)
        self.assertTrue(result.state["fallbackUsed"])
        self.assertEqual(result.trace["fallbackStrategy"], "fallback_result")
        self.assertEqual(result.trace["steps"][0]["status"], "degraded")
        self.assertEqual(result.trace["steps"][0]["metadata"]["evidence"]["error"], "primary unavailable")


    def test_agent_kernel_fails_when_workflow_required_output_is_missing(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class IncompleteRecommendationAgent(BaseAgent):
            name = "IncompleteRecommendationAgent"

            def run(self, context):
                return AgentResult(output={"recommendationVerified": True})

        kernel = AgentKernel()
        kernel.register(IncompleteRecommendationAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="recommend", goal="contract check", payload={}),
            ["IncompleteRecommendationAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["status"], "failed")
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("recommendations", result.output["error"])
        self.assertIn("sources", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")
        self.assertEqual(result.trace["steps"][-1]["status"], "failed")


    def test_agent_kernel_fails_when_workflow_output_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongTypeRecommendationAgent(BaseAgent):
            name = "WrongTypeRecommendationAgent"

            def run(self, context):
                return AgentResult(output={"recommendations": "not-a-list", "sources": {"bad": True}})

        kernel = AgentKernel()
        kernel.register(WrongTypeRecommendationAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="recommend", goal="contract type check", payload={}),
            ["WrongTypeRecommendationAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("recommendations expected array", result.output["error"])
        self.assertIn("sources expected array", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_fails_when_nested_object_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongNestedRecommendationAgent(BaseAgent):
            name = "WrongNestedRecommendationAgent"

            def run(self, context):
                return AgentResult(output={
                    "recommendations": [],
                    "sources": [],
                    "resourcePack": {
                        "title": "Root locus pack",
                        "resources": "not-a-list",
                    },
                })

        kernel = AgentKernel()
        kernel.register(WrongNestedRecommendationAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="recommend", goal="nested contract type check", payload={}),
            ["WrongNestedRecommendationAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("resourcePack.resources expected array", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_fails_when_array_item_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongArrayItemRecommendationAgent(BaseAgent):
            name = "WrongArrayItemRecommendationAgent"

            def run(self, context):
                return AgentResult(output={
                    "recommendations": [{"title": "Root locus", "score": "high"}],
                    "sources": [],
                    "resourcePack": {
                        "title": "Root locus pack",
                        "resources": [{"title": 123, "href": "/a3/classroom"}],
                    },
                })

        kernel = AgentKernel()
        kernel.register(WrongArrayItemRecommendationAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="recommend", goal="array item contract type check", payload={}),
            ["WrongArrayItemRecommendationAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("recommendations[0].score expected number", result.output["error"])
        self.assertIn("resourcePack.resources[0].title expected string", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_fails_when_qa_citation_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongQaCitationAgent(BaseAgent):
            name = "WrongQaCitationAgent"

            def run(self, context):
                return AgentResult(output={
                    "answer": "Use the cited source to review root locus.",
                    "verified": True,
                    "citations": [{"title": 123, "score": "high"}],
                })

        kernel = AgentKernel()
        kernel.register(WrongQaCitationAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="qa_interact", goal="qa citation contract", payload={}),
            ["WrongQaCitationAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("citations[0].title expected string", result.output["error"])
        self.assertIn("citations[0].score expected number", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_fails_when_assessment_profile_update_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongAssessmentProfileAgent(BaseAgent):
            name = "WrongAssessmentProfileAgent"

            def run(self, context):
                return AgentResult(output={
                    "session": {"status": 3, "score": "full"},
                    "isCorrect": False,
                    "profileUpdate": {"weakPoints": "root locus"},
                })

        kernel = AgentKernel()
        kernel.register(WrongAssessmentProfileAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="assess_grade", goal="assessment contract", payload={}),
            ["WrongAssessmentProfileAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("session.status expected string", result.output["error"])
        self.assertIn("session.score expected number", result.output["error"])
        self.assertIn("profileUpdate.weakPoints expected array", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_fails_when_path_generate_plan_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongPathPlanAgent(BaseAgent):
            name = "WrongPathPlanAgent"

            def run(self, context):
                return AgentResult(output={
                    "path": {
                        "title": "Root locus path",
                        "items": [{
                            "status": 3,
                            "estimatedMinutes": "thirty",
                            "knowledgePoint": {"title": 456},
                        }],
                    },
                    "studyPlan": {
                        "durationDays": "seven",
                        "days": [{
                            "day": "one",
                            "tasks": [{"title": 123, "estimatedMinutes": "ten", "completed": "no"}],
                        }],
                    },
                })

        kernel = AgentKernel()
        kernel.register(WrongPathPlanAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="path_generate", goal="path contract", payload={}),
            ["WrongPathPlanAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("path.items[0].status expected string", result.output["error"])
        self.assertIn("path.items[0].estimatedMinutes expected number", result.output["error"])
        self.assertIn("path.items[0].knowledgePoint.title expected string", result.output["error"])
        self.assertIn("studyPlan.durationDays expected integer", result.output["error"])
        self.assertIn("studyPlan.days[0].day expected integer", result.output["error"])
        self.assertIn("studyPlan.days[0].tasks[0].title expected string", result.output["error"])
        self.assertIn("studyPlan.days[0].tasks[0].estimatedMinutes expected number", result.output["error"])
        self.assertIn("studyPlan.days[0].tasks[0].completed expected boolean", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_fails_when_profile_extract_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongProfileExtractAgent(BaseAgent):
            name = "WrongProfileExtractAgent"

            def run(self, context):
                return AgentResult(output={
                    "profile": {
                        "grade": 2,
                        "majorDirection": ["automation"],
                        "foundationLevel": 3,
                        "dailyMinutes": "forty",
                        "learningGoals": "pass exam",
                        "weakPoints": "root locus",
                        "expectedResources": "video",
                    },
                    "updatedFields": "all",
                })

        kernel = AgentKernel()
        kernel.register(WrongProfileExtractAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="profile_extract", goal="profile contract", payload={}),
            ["WrongProfileExtractAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("profile.grade expected string", result.output["error"])
        self.assertIn("profile.majorDirection expected string", result.output["error"])
        self.assertIn("profile.foundationLevel expected string", result.output["error"])
        self.assertIn("profile.dailyMinutes expected number", result.output["error"])
        self.assertIn("profile.learningGoals expected array", result.output["error"])
        self.assertIn("profile.weakPoints expected array", result.output["error"])
        self.assertIn("profile.expectedResources expected array", result.output["error"])
        self.assertIn("updatedFields expected array", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_retries_step_and_records_policy_metadata(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class FlakyAgent(BaseAgent):
            name = "FlakyAgent"
            max_retries = 1
            timeout_ms = 250

            def __init__(self):
                self.calls = 0

            def run(self, context):
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("temporary outage")
                return AgentResult(output={"recovered": True})

        agent = FlakyAgent()
        kernel = AgentKernel()
        kernel.register(agent)

        result = kernel.run(
            AgentContext(user=self.user, workflow="retry_unit", goal="retry metadata", payload={}),
            ["FlakyAgent"],
        )

        self.assertTrue(result.success)
        self.assertEqual(agent.calls, 2)
        step_metadata = result.trace["steps"][0]["metadata"]
        self.assertEqual(step_metadata["runtimePolicy"]["maxRetries"], 1)
        self.assertEqual(step_metadata["runtimePolicy"]["timeoutMs"], 250)
        self.assertEqual(step_metadata["runtimePolicy"]["attempts"], 2)
        self.assertEqual(step_metadata["runtimePolicy"]["errors"], ["temporary outage"])

    def test_agent_kernel_clears_timeout_flag_after_successful_retry(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class SlowThenFastAgent(BaseAgent):
            name = "SlowThenFastAgent"
            max_retries = 1
            timeout_ms = 100

            def run(self, context):
                return AgentResult(output={"recovered": True})

        kernel = AgentKernel()
        kernel.register(SlowThenFastAgent())

        with patch("backend.apps.compat.agent_kernel.perf_counter", side_effect=[10.0, 10.2, 10.2, 10.2, 10.25]):
            result = kernel.run(
                AgentContext(user=self.user, workflow="retry_timeout_unit", goal="retry timeout metadata", payload={}),
                ["SlowThenFastAgent"],
            )

        self.assertTrue(result.success)
        runtime_policy = result.trace["steps"][0]["metadata"]["runtimePolicy"]
        self.assertEqual(runtime_policy["attempts"], 2)
        self.assertEqual(runtime_policy["errors"], ["SlowThenFastAgent exceeded 100ms"])
        self.assertFalse(runtime_policy["timedOut"])
        self.assertEqual(runtime_policy["elapsedMs"], 50)


    def test_core_agents_declare_runtime_retry_and_timeout_policies(self):
        from backend.apps.compat.agent_kernel import AssessmentAgent, PlannerAgent, ProfileAgent, StudyPlanAgent

        policies = {
            "ProfileAgent": (ProfileAgent.max_retries, ProfileAgent.timeout_ms),
            "PlannerAgent": (PlannerAgent.max_retries, PlannerAgent.timeout_ms),
            "AssessmentAgent": (AssessmentAgent.max_retries, AssessmentAgent.timeout_ms),
            "StudyPlanAgent": (StudyPlanAgent.max_retries, StudyPlanAgent.timeout_ms),
        }

        self.assertEqual(policies["ProfileAgent"], (1, 2500))
        self.assertEqual(policies["PlannerAgent"], (1, 5000))
        self.assertEqual(policies["AssessmentAgent"], (0, 2000))
        self.assertEqual(policies["StudyPlanAgent"], (1, 4000))


    @override_settings(A3_AGENT_RUNTIME_POLICIES={"ConfigurableAgent": {"maxRetries": 2, "timeoutMs": 777}})
    def test_agent_kernel_runtime_policy_can_be_overridden_by_settings(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class ConfigurableAgent(BaseAgent):
            name = "ConfigurableAgent"
            max_retries = 0
            timeout_ms = 100

            def run(self, context):
                return AgentResult(output={"ok": True})

        kernel = AgentKernel()
        kernel.register(ConfigurableAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="runtime_policy_unit", goal="settings override", payload={}),
            ["ConfigurableAgent"],
        )

        runtime_policy = result.trace["steps"][0]["metadata"]["runtimePolicy"]
        self.assertEqual(runtime_policy["maxRetries"], 2)
        self.assertEqual(runtime_policy["timeoutMs"], 777)


    def test_agent_kernel_uses_fallback_when_circuit_breaker_is_open(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class CircuitOpenAgent(BaseAgent):
            name = "CircuitOpenAgent"
            role = "circuit test"
            detail = "Should not run while circuit is open."

            def __init__(self):
                self.run_calls = 0
                self.fallback_calls = 0

            def run(self, context):
                self.run_calls += 1
                return AgentResult(output={"ran": True})

            def fallback(self, context, error):
                self.fallback_calls += 1
                return AgentResult(output={"fallbackUsed": True}, detail="Circuit breaker fallback used.")

        agent = CircuitOpenAgent()
        kernel = AgentKernel(circuit_breaker=lambda context, agent: {
            "open": True,
            "reason": "agent_failure_rate",
            "failureRate": 0.75,
        })
        kernel.register(agent)

        result = kernel.run(
            AgentContext(user=self.user, workflow="circuit_unit", goal="circuit breaker", payload={}),
            ["CircuitOpenAgent"],
        )

        self.assertTrue(result.success)
        self.assertEqual(agent.run_calls, 0)
        self.assertEqual(agent.fallback_calls, 1)
        self.assertTrue(result.output["fallbackUsed"])
        self.assertEqual(result.trace["fallbackStrategy"], "circuit_breaker")
        self.assertEqual(result.trace["steps"][0]["status"], "degraded")
        self.assertEqual(result.trace["steps"][0]["metadata"]["circuitBreaker"]["reason"], "agent_failure_rate")


    def test_agent_kernel_fails_before_run_when_circuit_breaker_is_open_without_fallback(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class NoFallbackCircuitOpenAgent(BaseAgent):
            name = "NoFallbackCircuitOpenAgent"

            def __init__(self):
                self.run_calls = 0

            def run(self, context):
                self.run_calls += 1
                return AgentResult(output={"ran": True})

        agent = NoFallbackCircuitOpenAgent()
        kernel = AgentKernel(circuit_breaker=lambda context, agent: {
            "open": True,
            "reason": "workflow_failure_rate",
            "failureRate": 0.8,
        })
        kernel.register(agent)

        result = kernel.run(
            AgentContext(user=self.user, workflow="circuit_unit", goal="circuit breaker failure", payload={}),
            ["NoFallbackCircuitOpenAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(agent.run_calls, 0)
        self.assertEqual(result.trace["fallbackStrategy"], "circuit_breaker")
        self.assertEqual(result.trace["steps"][0]["name"], "CircuitBreakerAgent")
        self.assertEqual(result.trace["steps"][0]["status"], "failed")
        self.assertEqual(result.trace["steps"][0]["metadata"]["circuitBreaker"]["reason"], "workflow_failure_rate")
        self.assertIn("circuit breaker open", result.output["error"])


    def test_recent_run_circuit_breaker_opens_for_degraded_agent_history(self):
        from backend.apps.compat.agent_kernel import AgentContext, BaseAgent, build_recent_run_circuit_breaker

        class TeacherAgentForPolicy(BaseAgent):
            name = "TeacherAgent"

        for index in range(3):
            run = RuntimeAgentRun(self.user, "qa_interact", f"teacher failure history {index}")
            run.step("RetrieverAgent", "retrieval", "retrieved sources", status="completed")
            run.step("TeacherAgent", "grounded tutoring", "teacher failed", status="failed")
            run.status = "failed"
            run.persist()

        policy = build_recent_run_circuit_breaker(self.user, min_samples=3, open_threshold=0.5)
        decision = policy(
            AgentContext(user=self.user, workflow="qa_interact", goal="policy check", payload={}),
            TeacherAgentForPolicy(),
        )

        self.assertTrue(decision["open"])
        self.assertEqual(decision["reason"], "agent_failure_rate")
        self.assertEqual(decision["workflow"], "qa_interact")
        self.assertEqual(decision["agent"], "TeacherAgent")
        self.assertEqual(decision["failureRate"], 1.0)


    def test_recent_run_circuit_breaker_opens_for_workflow_failure_history(self):
        from backend.apps.compat.agent_kernel import AgentContext, BaseAgent, build_recent_run_circuit_breaker

        class RetrieverAgentForPolicy(BaseAgent):
            name = "RetrieverAgent"

        for index in range(3):
            run = RuntimeAgentRun(self.user, "recommend", f"workflow failure history {index}")
            run.step("LearningStateAgent", "state", "state loaded", status="completed")
            run.step("RetrieverAgent", "retrieval", "retrieval degraded elsewhere", status="completed")
            run.status = "failed"
            run.persist()

        policy = build_recent_run_circuit_breaker(self.user, min_samples=3, open_threshold=0.5)
        decision = policy(
            AgentContext(user=self.user, workflow="recommend", goal="policy check", payload={}),
            RetrieverAgentForPolicy(),
        )

        self.assertTrue(decision["open"])
        self.assertEqual(decision["reason"], "workflow_failure_rate")
        self.assertEqual(decision["workflow"], "recommend")
        self.assertEqual(decision["agent"], "RetrieverAgent")
        self.assertEqual(decision["failureRate"], 1.0)


    @override_settings(A3_AGENT_CIRCUIT_MIN_SAMPLES=2, A3_AGENT_CIRCUIT_OPEN_THRESHOLD=0.75)
    def test_recent_run_circuit_breaker_reads_thresholds_from_settings(self):
        from backend.apps.compat.agent_kernel import AgentContext, BaseAgent, build_recent_run_circuit_breaker

        class TeacherAgentForSettingsPolicy(BaseAgent):
            name = "TeacherAgent"

        for index in range(2):
            run = RuntimeAgentRun(self.user, "qa_interact", f"settings threshold history {index}")
            run.step("TeacherAgent", "grounded tutoring", "teacher failed", status="failed")
            run.status = "failed"
            run.persist()

        policy = build_recent_run_circuit_breaker(self.user)
        decision = policy(
            AgentContext(user=self.user, workflow="qa_interact", goal="settings policy", payload={}),
            TeacherAgentForSettingsPolicy(),
        )

        self.assertTrue(decision["open"])
        self.assertEqual(decision["reason"], "agent_failure_rate")
        self.assertEqual(decision["steps"], 2)
        self.assertEqual(decision["failureRate"], 1.0)


    def test_agent_circuit_breaker_defaults_are_declared_in_settings(self):
        from django.conf import settings

        self.assertEqual(settings.A3_AGENT_CIRCUIT_RECENT_LIMIT, 12)
        self.assertEqual(settings.A3_AGENT_CIRCUIT_MIN_SAMPLES, 3)
        self.assertEqual(settings.A3_AGENT_CIRCUIT_OPEN_THRESHOLD, 0.5)


    def test_backend_env_example_documents_agent_circuit_breaker_settings(self):
        from backend.core.settings import BACKEND_ROOT
        env_example = (BACKEND_ROOT / ".env.example").read_text(encoding="utf-8")

        self.assertIn("A3_AGENT_CIRCUIT_RECENT_LIMIT=12", env_example)
        self.assertIn("A3_AGENT_CIRCUIT_MIN_SAMPLES=3", env_example)
        self.assertIn("A3_AGENT_CIRCUIT_OPEN_THRESHOLD=0.5", env_example)


    def test_backend_env_example_documents_agent_runtime_policy_settings(self):
        from backend.core.settings import BACKEND_ROOT
        env_example = (BACKEND_ROOT / ".env.example").read_text(encoding="utf-8")

        expected_keys = [
            "A3_PROFILE_AGENT_MAX_RETRIES=1",
            "A3_PROFILE_AGENT_TIMEOUT_MS=2500",
            "A3_PLANNER_AGENT_MAX_RETRIES=1",
            "A3_PLANNER_AGENT_TIMEOUT_MS=5000",
            "A3_RETRIEVER_AGENT_MAX_RETRIES=1",
            "A3_RETRIEVER_AGENT_TIMEOUT_MS=3000",
            "A3_VERIFIER_AGENT_MAX_RETRIES=1",
            "A3_VERIFIER_AGENT_TIMEOUT_MS=3000",
            "A3_ASSESSMENT_AGENT_MAX_RETRIES=0",
            "A3_ASSESSMENT_AGENT_TIMEOUT_MS=2000",
            "A3_STUDY_PLAN_AGENT_MAX_RETRIES=1",
            "A3_STUDY_PLAN_AGENT_TIMEOUT_MS=4000",
        ]

        for key in expected_keys:
            with self.subTest(key=key):
                self.assertIn(key, env_example)


    def test_recommend_workflow_kernel_runs_learning_retrieval_rank_verify_pack_agents(self):
        from backend.apps.compat.agent_kernel import build_recommendation_kernel, run_recommendation_workflow

        kernel = build_recommendation_kernel()
        result = run_recommendation_workflow(
            self.user,
            payload={"goal": "root locus", "topK": 3, "mode": "fast"},
            kernel=kernel,
        )

        self.assertTrue(result.success)
        payload = result.output["recommendationPayload"]
        self.assertGreaterEqual(len(payload["recommendations"]), 1)
        self.assertIn("resourcePack", payload)
        step_names = [step["name"] for step in result.trace["steps"]]
        self.assertEqual(
            step_names,
            ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
        )
        verifier_step = next(step for step in result.trace["steps"] if step["name"] == "VerifierAgent")
        self.assertIn("quality", verifier_step["metadata"])
        self.assertIn("citationCoverage", verifier_step["metadata"]["quality"])
        retriever_step = next(step for step in result.trace["steps"] if step["name"] == "RetrieverAgent")
        self.assertGreater(retriever_step["metadata"]["runtimePolicy"]["maxRetries"], 0)
        self.assertGreater(verifier_step["metadata"]["runtimePolicy"]["maxRetries"], 0)


    def test_recommend_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import RECOMMEND_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("recommend")

        self.assertEqual(tuple(RECOMMEND_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_qa_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import QA_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("qa_interact")

        self.assertEqual(tuple(QA_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_assess_grade_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import ASSESS_GRADE_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("assess_grade")

        self.assertEqual(tuple(ASSESS_GRADE_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_admission_diagnostic_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import ADMISSION_DIAGNOSTIC_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("admission_diagnostic")

        self.assertEqual(tuple(ADMISSION_DIAGNOSTIC_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_teacher_task_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import TEACHER_TASK_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("teacher_task_execute")

        self.assertEqual(tuple(TEACHER_TASK_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_profile_extract_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import PROFILE_EXTRACT_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("profile_extract")

        self.assertEqual(tuple(PROFILE_EXTRACT_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_path_generate_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import PATH_GENERATE_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("path_generate")

        self.assertEqual(tuple(PATH_GENERATE_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_agent_runtime_persists_trace_to_independent_tables_and_legacy_profile(self):
        run = RuntimeAgentRun(self.user, "recommend", "生成个性化推荐")
        run.step(
            "RetrieverAgent",
            "知识库检索",
            "检索当前路径相关资源",
            metadata={"topK": 3},
        )
        run.complete()

        persisted = AgentRun.objects.get(trace_id=run.trace_id)
        self.assertEqual(persisted.user, self.user)
        self.assertEqual(persisted.schema_version, "a3.agent-run.v1")
        self.assertEqual(persisted.workflow, "recommend")
        self.assertEqual(persisted.goal, "生成个性化推荐")
        self.assertEqual(persisted.status, "completed")
        self.assertGreaterEqual(persisted.latency_ms, 1)
        self.assertEqual(persisted.fallback_strategy, "none")

        step = AgentStep.objects.get(run=persisted)
        self.assertEqual(step.name, "RetrieverAgent")
        self.assertEqual(step.role, "知识库检索")
        self.assertEqual(step.status, "completed")
        self.assertEqual(step.order, 1)
        self.assertEqual(step.metadata["topK"], 3)

        profile = LearnerProfile.objects.get(user=self.user)
        legacy_runs = profile.extra_profile["agentRuns"]
        self.assertEqual(legacy_runs[0]["traceId"], run.trace_id)
        self.assertEqual(legacy_runs[0]["schemaVersion"], "a3.agent-run.v1")
        self.assertEqual(legacy_runs[0]["fallbackStrategy"], "none")

    def test_manual_agent_step_gets_schema_and_degradation_metadata(self):
        run = RuntimeAgentRun(self.user, "openmaic_video_bridge", "manual bridge trace")
        run.step(
            "A3VideoBridgeAgent",
            "openmaic video bridge",
            "record degraded provider writeback",
            status="degraded",
            evidence={"degraded": True},
        )
        run.complete()

        persisted = AgentRun.objects.get(trace_id=run.trace_id)
        step = AgentStep.objects.get(run=persisted)
        self.assertEqual(step.metadata["outputSchema"]["schemaVersion"], "a3.agent-output.v1")
        self.assertTrue(step.metadata["outputSchema"]["valid"])
        self.assertEqual(step.metadata["degradation"]["status"], "degraded")
        self.assertTrue(step.metadata["degradation"]["degraded"])
        self.assertEqual(step.metadata["degradation"]["fallbackStrategy"], "none")
        self.assertEqual(step.metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")


    def test_agent_run_legacy_profile_copy_is_lightweight(self):
        run = RuntimeAgentRun(self.user, "recommend", "legacy summary payload")
        run.step(
            "RankerAgent",
            "personalized ranking",
            "ranked resources",
            metadata={"runtimePolicy": {"maxRetries": 1, "timeoutMs": 3000, "attempts": 1, "errors": [], "timedOut": False}},
            input_summary={"goal": "root locus"},
            output_summary={"recommendations": 3},
            state_diff={"RecommendationLog": "created"},
            evidence={"rankingBasis": ["weak point", "current path"]},
            quality={"profileMatchCoverage": 1.0},
        )
        run.complete()

        profile = LearnerProfile.objects.get(user=self.user)
        legacy_trace = profile.extra_profile["agentRuns"][0]
        metadata = legacy_trace["steps"][0]["metadata"]
        self.assertEqual(legacy_trace["traceId"], run.trace_id)
        self.assertEqual(metadata["runtimePolicy"]["timeoutMs"], 3000)
        self.assertNotIn("inputSummary", metadata)
        self.assertNotIn("outputSummary", metadata)
        self.assertNotIn("stateDiff", metadata)
        self.assertNotIn("evidence", metadata)
        self.assertNotIn("quality", metadata)


    def test_agent_workflow_registry_describes_required_contracts(self):
        workflows = describe_agent_workflows()

        by_key = {item["workflow"]: item for item in workflows}
        self.assertIn("profile_interview", by_key)
        self.assertIn("recommend", by_key)
        self.assertIn("resource_feedback", by_key)
        self.assertIn("question_bank_generate", by_key)
        self.assertIn("verify_answer", by_key)
        self.assertIn("assess_grade", by_key)
        self.assertEqual(by_key["recommend"]["schemaVersion"], "a3.agent-workflow.v1")
        self.assertEqual(
            by_key["recommend"]["requiredSteps"],
            ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
        )
        self.assertIn("TeacherInterventionAgent", by_key["recommend"]["targetSteps"])
        self.assertEqual(
            by_key["assess_grade"]["requiredSteps"],
            ["AdaptivePracticeAgent", "AssessmentAgent", "ProfileUpdateAgent", "ReviewSchedulerAgent", "StudyPlanAgent"],
        )
        self.assertEqual(
            by_key["question_bank_generate"]["requiredSteps"],
            ["QuestionGeneratorAgent", "QuestionVerifierAgent"],
        )
        self.assertEqual(
            by_key["qa_interact"]["requiredSteps"],
            ["SafetyAgent", "RetrieverAgent", "TeacherAgent", "VerifierAgent", "FollowUpAgent"],
        )
        self.assertIn("followUps", by_key["qa_interact"]["outputSchema"]["properties"])
        self.assertIn("QuestionQualityCheck", by_key["question_bank_generate"]["stateUpdates"])
        self.assertIn("stateUpdates", by_key["assess_grade"])
        self.assertIn("WrongQuestion", by_key["assess_grade"]["stateUpdates"])
        self.assertIn("inputSchema", by_key["recommend"])
        self.assertIn("outputSchema", by_key["recommend"])
        self.assertIn("qualityMetrics", by_key["recommend"])
        self.assertIn("goal", by_key["recommend"]["inputSchema"]["properties"])
        self.assertIn("resourcePack", by_key["recommend"]["outputSchema"]["properties"])
        self.assertEqual(
            by_key["profile_interview"]["requiredSteps"],
            ["SafetyAgent", "ProfileInterviewAgent", "LearnerModelAgent", "MemoryCommitAgent", "PlannerAgent"],
        )
        self.assertIn("profileCommitted", {item["key"] for item in by_key["profile_interview"]["qualityMetrics"]})
        metric_keys = {item["key"] for item in by_key["recommend"]["qualityMetrics"]}
        self.assertIn("citationCoverage", metric_keys)
        self.assertEqual(
            by_key["resource_feedback"]["requiredSteps"],
            ["ResourceFeedbackAgent", "LearningEffectAgent", "StudyPlanAgent", "MemoryCommitAgent"],
        )
        self.assertIn("studyPlanAdjusted", {item["key"] for item in by_key["resource_feedback"]["qualityMetrics"]})


    def test_agent_runtime_step_standardizes_trace_metadata(self):
        run = RuntimeAgentRun(self.user, "recommend", "personalized recommendation")

        run.step(
            "RetrievalAgent",
            "retrieval",
            "retrieve learning resources",
            metadata={"topK": 3},
            input_summary={"goal": "root locus", "weakPoints": 1},
            output_summary={"sources": 2},
            state_diff={"LearnerProfile": "read"},
            evidence={"fallbackUsed": False},
            quality={"citationCoverage": 1.0},
        )
        run.complete()

        step = AgentStep.objects.get(run__trace_id=run.trace_id)
        self.assertEqual(step.metadata["topK"], 3)
        self.assertEqual(step.metadata["inputSummary"], {"goal": "root locus", "weakPoints": 1})
        self.assertEqual(step.metadata["outputSummary"], {"sources": 2})
        self.assertEqual(step.metadata["stateDiff"], {"LearnerProfile": "read"})
        self.assertEqual(step.metadata["evidence"], {"fallbackUsed": False})
        self.assertEqual(step.metadata["quality"], {"citationCoverage": 1.0})
        self.assertEqual(step.metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")


    def test_recommend_workflow_persists_standardized_step_metadata(self):
        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"goal": "root locus", "topK": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        steps = {step.name: step for step in run.steps.all()}

        retrieval_metadata = steps["RetrieverAgent"].metadata
        ranker_metadata = steps["RankerAgent"].metadata

        # RetrieverAgent persists retrieval config in outputSummary and evidence
        self.assertEqual(retrieval_metadata["evidence"]["topK"], 3)
        self.assertEqual(retrieval_metadata["evidence"]["mode"], "fast")
        self.assertEqual(retrieval_metadata["evidence"]["source"], "local_knowledge_base")
        self.assertEqual(retrieval_metadata["evidence"]["fallback"], "keyword_or_cached_when_vector_unavailable")
        self.assertIn("retrievalConfig", retrieval_metadata["outputSummary"])
        self.assertIn("retrievalConfig", retrieval_metadata["stateDiff"])
        self.assertTrue(retrieval_metadata["quality"]["retrievalConfigured"])

        # RankerAgent persists recommendations payload in outputSummary and source count in evidence
        self.assertIn("recommendations", ranker_metadata["outputSummary"])
        self.assertIn("recommendationCount", ranker_metadata["stateDiff"])
        self.assertIn("sourceCount", ranker_metadata["evidence"])
        self.assertIn("rankingBasis", ranker_metadata["evidence"])
        self.assertIn("profileMatch", ranker_metadata["evidence"])
        self.assertIn("fallbackUsed", ranker_metadata["evidence"])
        self.assertIn("hasRecommendations", ranker_metadata["quality"])
        self.assertIn("rankingBasisExposed", ranker_metadata["quality"])
        self.assertIn("profileMatchExposed", ranker_metadata["quality"])

        resource_pack_metadata = steps["ResourcePackAgent"].metadata
        self.assertIn("resourceCount", resource_pack_metadata["evidence"])
        self.assertIn("practiceActionHref", resource_pack_metadata["evidence"])
        self.assertTrue(resource_pack_metadata["quality"]["hasPracticeAction"])


    def test_assess_grade_workflow_persists_state_diff_metadata(self):
        course = Course.objects.get(code="AUTO-CONTROL-001")
        point = course.chapters.first().knowledge_points.first()
        question = Question.objects.create(
            knowledge_point=point,
            stem="agent trace grading question",
            options=[
                {"key": "A", "text": "A option"},
                {"key": "B", "text": "B option"},
                {"key": "C", "text": "C option"},
                {"key": "D", "text": "D option"},
            ],
            correct_answer="A",
            explanation="trace explanation",
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
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        steps = {step.name: step for step in run.steps.all()}

        adaptive_metadata = steps["AdaptivePracticeAgent"].metadata
        assessment_metadata = steps["AssessmentAgent"].metadata
        profile_metadata = steps["ProfileUpdateAgent"].metadata
        review_metadata = steps["ReviewSchedulerAgent"].metadata
        plan_metadata = steps["StudyPlanAgent"].metadata
        self.assertIn("questionCount", adaptive_metadata["evidence"])
        self.assertIn("masteryRecords", adaptive_metadata["evidence"])
        self.assertEqual(assessment_metadata["inputSummary"]["sessionId"], str(session.id))
        self.assertFalse(assessment_metadata["outputSummary"]["isCorrect"])
        self.assertIn("WrongQuestion", assessment_metadata["stateDiff"])
        self.assertEqual(assessment_metadata["evidence"]["writeBackTarget"], "wrong_notebook")
        self.assertEqual(assessment_metadata["evidence"]["questionId"], str(question.id))
        self.assertTrue(assessment_metadata["quality"]["feedbackExplained"])
        self.assertIn("LearnerProfile.weak_points", profile_metadata["stateDiff"])
        self.assertIn("extra_profile.lastAssessmentSync", profile_metadata["stateDiff"])
        self.assertEqual(profile_metadata["evidence"]["updateSource"], "wrong_question_sync")
        self.assertIn("weakPointCount", profile_metadata["evidence"])
        self.assertIn("activeWrongQuestions", review_metadata["evidence"])
        self.assertEqual(review_metadata["evidence"]["scheduleReason"], "active_wrong_questions")
        self.assertIn("studyPlan", plan_metadata["stateDiff"])
        self.assertEqual(plan_metadata["evidence"]["plannerInput"], "latest_wrong_questions_and_profile")
        self.assertIn("dayCount", plan_metadata["evidence"])
        self.assertIn("taskCount", plan_metadata["evidence"])
        self.assertIn("refreshReason", plan_metadata["evidence"])


    def test_agent_workflow_contract_reports_missing_required_steps(self):
        # recommend workflow requires: LearningStateAgent, RetrieverAgent, RankerAgent, VerifierAgent, ResourcePackAgent
        trace = {
            "workflow": "recommend",
            "steps": [
                {"name": "LearningStateAgent", "status": "completed"},
                {"name": "RetrieverAgent", "status": "completed"},
            ],
        }

        result = evaluate_trace_contract(trace)

        self.assertFalse(result["ready"])
        self.assertEqual(result["workflow"], "recommend")
        self.assertEqual(result["missingRequiredSteps"], ["RankerAgent", "VerifierAgent", "ResourcePackAgent"])
        self.assertEqual(result["presentRequiredSteps"], ["LearningStateAgent", "RetrieverAgent"])
        self.assertEqual(result["unknownSteps"], [])


    def test_agent_runtime_execute_step_retries_then_persists_attempt_metadata(self):
        attempts = {"count": 0}

        def flaky_operation():
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RuntimeError("temporary retrieval error")
            return {"items": 3}

        run = RuntimeAgentRun(self.user, "recommend", "带重试的资源推荐")
        result = run.execute_step(
            "RetrieverAgent",
            "知识库检索",
            "调用知识库检索",
            flaky_operation,
            max_retries=1,
        )
        run.complete()

        self.assertEqual(result, {"items": 3})
        self.assertEqual(attempts["count"], 2)
        persisted = AgentRun.objects.get(trace_id=run.trace_id)
        self.assertEqual(persisted.status, "completed")
        self.assertEqual(persisted.metadata["retryPolicy"]["maxRetries"], 1)
        step = persisted.steps.get(order=1)
        self.assertEqual(step.status, "completed")
        self.assertEqual(step.metadata["attempts"], 2)
        self.assertEqual(step.metadata["errors"], ["temporary retrieval error"])


    def test_agent_runtime_execute_step_uses_fallback_after_timeout(self):
        with patch(
            "backend.apps.compat.agent_runtime.perf_counter",
            side_effect=[100.0, 100.0, 100.2, 100.2, 100.2, 100.2, 100.2, 100.2],
        ):
            run = RuntimeAgentRun(self.user, "qa_interact", "超时降级课堂问答")
            result = run.execute_step(
                "TeacherAgent",
                "课堂辅导",
                "调用模型生成回答，超时后降级",
                lambda: "slow model answer",
                timeout_ms=50,
                fallback=lambda exc: "fallback answer",
            )
            run.complete()

        self.assertEqual(result, "fallback answer")
        persisted = AgentRun.objects.get(trace_id=run.trace_id)
        self.assertEqual(persisted.status, "completed")
        self.assertEqual(persisted.fallback_strategy, "fallback_result")
        self.assertEqual(persisted.metadata["lastError"]["type"], "TimeoutError")
        step = persisted.steps.get(order=1)
        self.assertEqual(step.status, "degraded")
        self.assertTrue(step.metadata["timedOut"])
        self.assertEqual(step.metadata["timeoutMs"], 50)
