from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any

from django.conf import settings
from django.db.models import Q

from backend.apps.compat.agent_runtime import AgentRun, recent_agent_runs
from backend.apps.compat.agent_workflows import get_agent_workflow_contract
from backend.apps.compat.llm import generate_planner_adjustment, generate_tutoring_answer
from backend.apps.compat.recommendations import build_recommendation_payload
from backend.apps.compat.safety import check_learning_safety
from backend.apps.compat.verification import verify_answer
from backend.apps.assessments.generation import run_question_generation_job, serialize_question_generation_job
from backend.apps.assessments.models import Question, QuestionGenerationJob, QuestionQualityCheck, StudentQuestionMastery, WrongQuestion
from backend.apps.assessments.services import answer_assessment_question, build_learning_report, merge_active_wrong_questions_into_review_queue
from backend.apps.engagement.models import UserNotification
from backend.apps.knowledge_base.models import KnowledgeAsset, KnowledgeBlock, KnowledgeGraphClaim, KnowledgeGraphEntity, KnowledgeGraphRelation, KnowledgeIndexEntry, KnowledgeResource, ResourceStatus
from backend.apps.knowledge_base.display import format_source_display_location, format_source_type_label, safe_source_filename, source_origin_label
from backend.apps.knowledge_base.services import indexed_resource_scope_by_path
from backend.apps.learning.services import classroom_context, execute_teacher_task, generate_learning_path, generate_study_plan, serialize_path, submit_admission_diagnostic, teacher_workbench
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
from backend.apps.profiles.profile_signals import append_profile_signal
from backend.apps.profiles.services import extract_and_save_profile
from backend.domains.knowledge_base.retriever import search_knowledge_base


RECOMMEND_WORKFLOW_SEQUENCE = [
    "LearningStateAgent",
    "RetrieverAgent",
    "RankerAgent",
    "VerifierAgent",
    "ResourcePackAgent",
]

QA_WORKFLOW_SEQUENCE = [
    "SafetyAgent",
    "RetrieverAgent",
    "TeacherAgent",
    "VerifierAgent",
    "FollowUpAgent",
]

ASSESS_GRADE_WORKFLOW_SEQUENCE = [
    "AdaptivePracticeAgent",
    "AssessmentAgent",
    "ProfileUpdateAgent",
    "ReviewSchedulerAgent",
    "StudyPlanAgent",
]

QUESTION_BANK_WORKFLOW_SEQUENCE = [
    "QuestionGeneratorAgent",
    "QuestionVerifierAgent",
]

PROFILE_EXTRACT_WORKFLOW_SEQUENCE = [
    "SafetyAgent",
    "ProfileAgent",
    "MemoryAgent",
]

PROFILE_SETUP_WORKFLOW_SEQUENCE = [
    "ProfileNormalizeAgent",
    "ProfileCommitAgent",
    "PlannerAgent",
    "StudyPlanAgent",
]

PATH_GENERATE_WORKFLOW_SEQUENCE = [
    "LearningStateAgent",
    "PlannerAgent",
    "GraphAgent",
    "StudyPlanAgent",
]

VERIFY_ANSWER_WORKFLOW_SEQUENCE = [
    "SafetyAgent",
    "ClaimExtractorAgent",
    "VerifierAgent",
]

ADMISSION_DIAGNOSTIC_WORKFLOW_SEQUENCE = [
    "DiagnosticAgent",
    "ProfileUpdateAgent",
    "PlannerAgent",
    "StudyPlanAgent",
]

TEACHER_TASK_WORKFLOW_SEQUENCE = [
    "TeacherWorkbenchAgent",
    "NotificationAgent",
    "StudentFollowupAgent",
]

FOLLOW_UP_TYPES = {"concept", "example", "practice", "evidence", "clarify"}


def _normalize_follow_up_item(item: dict, index: int) -> dict:
    label = str(item.get("label") or "").strip()[:24] or ["继续追问", "换个例子", "做道练习"][index % 3]
    question = str(item.get("question") or "").strip()
    item_type = str(item.get("type") or "").strip() or "concept"
    if item_type not in FOLLOW_UP_TYPES:
        item_type = "concept"
    if question and not question.endswith(("？", "?")):
        question = f"{question}？"
    return {
        "label": label,
        "question": question,
        "type": item_type,
        "reason": str(item.get("reason") or "").strip()[:80],
    }


def build_follow_up_suggestions(
    question: str,
    answer: str,
    *,
    verified: bool,
    safe: bool,
    target_title: str,
    source_count: int,
) -> list[dict]:
    target = target_title or "当前知识点"
    if not safe:
        raw_items = [
            {"label": "换个学习问题", "question": f"能不能围绕{target}问一个合规的学习问题", "type": "clarify", "reason": "当前问题触发安全边界"},
            {"label": "看基础概念", "question": f"请讲解{target}的基础概念", "type": "concept", "reason": "回到课堂目标"},
        ]
    elif not verified or source_count == 0:
        raw_items = [
            {"label": "补充证据", "question": "我需要上传哪类资料才能验证这个回答", "type": "evidence", "reason": "当前回答证据不足"},
            {"label": "换个问法", "question": f"能不能只基于已验证内容解释{target}", "type": "clarify", "reason": "降低幻觉风险"},
            {"label": "学习方法", "question": f"如果资料不足，我该如何自学{target}", "type": "concept", "reason": "给出安全下一步"},
        ]
    else:
        raw_items = [
            {"label": "继续追问概念", "question": f"能不能用更直观的方式解释{target}", "type": "concept", "reason": "加深概念理解"},
            {"label": "看工程例子", "question": f"能不能给一个{target}的工程应用例子", "type": "example", "reason": "连接应用场景"},
            {"label": "来一道练习", "question": f"围绕{target}出一道带解析的练习题", "type": "practice", "reason": "转入测评闭环"},
        ]
    return [_normalize_follow_up_item(item, index) for index, item in enumerate(raw_items) if item.get("question")][:3]


@dataclass
class AgentContext:
    user: Any
    workflow: str
    goal: str = ""
    payload: dict = field(default_factory=dict)
    state: dict = field(default_factory=dict)


@dataclass
class AgentResult:
    output: dict = field(default_factory=dict)
    state_patch: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    quality: dict = field(default_factory=dict)
    input_summary: dict = field(default_factory=dict)
    output_summary: dict = field(default_factory=dict)
    state_diff: dict = field(default_factory=dict)
    detail: str = ""


@dataclass
class KernelRunResult:
    success: bool
    state: dict
    trace: dict
    output: dict = field(default_factory=dict)


class BaseAgent:
    name = "BaseAgent"
    role = "agent"
    detail = "Run agent step."
    max_retries = 0
    timeout_ms = None
    output_schema_version = "a3.agent-output.v1"
    output_schema: dict = {}

    def run(self, context: AgentContext) -> AgentResult:
        raise NotImplementedError

    def fallback(self, context: AgentContext, error: Exception) -> AgentResult | None:
        return None


class AgentKernel:
    def __init__(self, circuit_breaker=None):
        self._agents: dict[str, BaseAgent] = {}
        self._circuit_breaker = circuit_breaker

    def register(self, agent: BaseAgent):
        if not agent.name:
            raise ValueError("agent.name is required")
        self._agents[agent.name] = agent

    def run(self, context: AgentContext, sequence: list[str]) -> KernelRunResult:
        run = AgentRun(context.user, context.workflow, context.goal)
        state = dict(context.state)
        state["traceId"] = run.trace_id
        output: dict = {"traceId": run.trace_id}
        for name in sequence:
            agent = self._agents.get(name)
            if agent is None:
                raise ValueError(f"Unknown agent: {name}")
            step_context = AgentContext(
                user=context.user,
                workflow=context.workflow,
                goal=context.goal,
                payload=context.payload,
                state=state,
            )
            runtime_policy = _runtime_policy_for_agent(agent)
            circuit_decision = self._check_circuit_breaker(step_context, agent)
            try:
                if circuit_decision.get("open"):
                    raise RuntimeError(f"circuit breaker open: {circuit_decision.get('reason') or 'unknown'}")
                result = self._run_agent_with_policy(agent, step_context, runtime_policy)
                schema_validation = _validate_agent_output_schema(agent, result.output)
                if not schema_validation["valid"]:
                    raise ValueError(f"{agent.name} output schema violation: {'; '.join(schema_validation['errors'])}")
                status = "completed"
            except Exception as exc:
                fallback_result = agent.fallback(step_context, exc)
                if fallback_result is None:
                    if circuit_decision.get("open"):
                        run.fallback_strategy = "circuit_breaker"
                        run.step(
                            "CircuitBreakerAgent",
                            "runtime governance",
                            str(exc),
                            status="failed",
                            metadata={"circuitBreaker": circuit_decision},
                            input_summary={"workflow": context.workflow, "agent": agent.name},
                            output_summary={"success": False},
                            quality={"circuitOpen": True},
                        )
                        run.status = "failed"
                        run.persist()
                        return KernelRunResult(success=False, state=state, output={**output, "error": str(exc)}, trace=run.as_dict())
                    run.fail(str(exc))
                    return KernelRunResult(success=False, state=state, output={**output, "error": str(exc)}, trace=run.as_dict())
                run.fallback_strategy = "circuit_breaker" if circuit_decision.get("open") else "fallback_result"
                result = fallback_result
                schema_validation = _validate_agent_output_schema(agent, result.output)
                status = "degraded"
            state.update(result.output)
            state.update(result.state_patch)
            output.update(result.output)
            metadata = {
                "runtimePolicy": runtime_policy,
                "outputSchema": schema_validation,
                "degradation": {
                    "status": status,
                    "degraded": status == "degraded",
                    "fallbackStrategy": run.fallback_strategy,
                    "reason": (runtime_policy.get("errors") or [""])[-1] if status == "degraded" else "",
                },
            }
            if circuit_decision.get("open"):
                metadata["circuitBreaker"] = circuit_decision
            run.step(
                agent.name,
                agent.role,
                result.detail or agent.detail,
                status=status,
                metadata=metadata,
                input_summary=result.input_summary or None,
                output_summary=result.output_summary or result.output,
                state_diff=result.state_diff or result.state_patch,
                evidence=result.evidence,
                quality=result.quality,
            )
        contract_error = _validate_workflow_output_contract(context.workflow, output)
        if contract_error:
            run.fallback_strategy = "contract_violation"
            run.step(
                "ContractAgent",
                "workflow contract",
                contract_error,
                status="failed",
                input_summary={"workflow": context.workflow},
                output_summary={"success": False},
                evidence={"requiredOutputMissing": True},
                quality={"contractSatisfied": False},
            )
            run.status = "failed"
            run.persist()
            return KernelRunResult(success=False, state=state, output={**output, "error": contract_error}, trace=run.as_dict())
        run.complete()
        return KernelRunResult(success=True, state=state, output=output, trace=run.as_dict())

    def _check_circuit_breaker(self, context: AgentContext, agent: BaseAgent) -> dict:
        if self._circuit_breaker is None:
            return {"open": False}
        decision = self._circuit_breaker(context, agent)
        if isinstance(decision, bool):
            return {"open": decision, "reason": "policy"}
        if isinstance(decision, dict):
            return {"open": bool(decision.get("open") or decision.get("status") == "open"), **decision}
        return {"open": False}

    def _run_agent_with_policy(self, agent: BaseAgent, context: AgentContext, runtime_policy: dict) -> AgentResult:
        max_retries = int(runtime_policy["maxRetries"])
        timeout_ms = runtime_policy["timeoutMs"]
        last_error: Exception | None = None
        for _ in range(max_retries + 1):
            runtime_policy["attempts"] += 1
            started = perf_counter()
            try:
                result = agent.run(context)
                elapsed_ms = max(1, int((perf_counter() - started) * 1000))
                runtime_policy["elapsedMs"] = elapsed_ms
                if timeout_ms is not None and elapsed_ms > int(timeout_ms):
                    runtime_policy["timedOut"] = True
                    raise TimeoutError(f"{agent.name} exceeded {timeout_ms}ms")
                runtime_policy["timedOut"] = False
                return result
            except Exception as exc:
                last_error = exc
                runtime_policy["elapsedMs"] = max(1, int((perf_counter() - started) * 1000))
                runtime_policy["errors"].append(str(exc))
                if isinstance(exc, TimeoutError):
                    runtime_policy["timedOut"] = True
        if last_error is None:
            last_error = RuntimeError(f"{agent.name} failed without an exception")
        raise last_error


class LearningStateAgent(BaseAgent):
    name = "LearningStateAgent"
    role = "learning state"
    detail = "Read learner profile, goals, weak points, and current path signals."

    def run(self, context: AgentContext) -> AgentResult:
        return AgentResult(
            output={"learningStateReady": True},
            state_patch={"learningState": {"goal": context.payload.get("goal") or context.goal}},
            quality={"stateAvailable": True},
        )


class PlannerAgent(BaseAgent):
    name = "PlannerAgent"
    role = "path planning"
    detail = "Generate an individualized learning path from profile and course constraints."
    max_retries = 1
    timeout_ms = 5000

    def run(self, context: AgentContext) -> AgentResult:
        if context.workflow == "admission_diagnostic":
            result = context.state.get("diagnosticResult") if isinstance(context.state.get("diagnosticResult"), dict) else {}
            path_payload = result.get("path") if isinstance(result.get("path"), dict) else {}
            items = path_payload.get("items") if isinstance(path_payload.get("items"), list) else []
            rationale = path_payload.get("rationale") if isinstance(path_payload.get("rationale"), dict) else {}
            return AgentResult(
                output={"path": path_payload, "pathId": str(path_payload.get("id") or "")},
                state_patch={"path": path_payload, "pathItemCount": len(items)},
                input_summary={
                    "diagnosticScore": context.state.get("diagnosticScore"),
                    "weakPoints": len(context.state.get("diagnosticWeakPoints") or []),
                },
                output_summary={
                    "pathId": str(path_payload.get("id") or ""),
                    "items": len(items),
                },
                state_diff={"LearningPath": "refreshed", "LearningPathItem": len(items)},
                evidence={
                    "plannerInput": "diagnostic_profile",
                    "strategy": rationale.get("strategy") or "",
                    "weakPointCount": len(rationale.get("weakPoints") or []),
                    "pathItemCount": len(items),
                    "courseId": str((path_payload.get("course") or {}).get("id") or "") if isinstance(path_payload.get("course"), dict) else "",
                },
                quality={
                    "hasPathItems": bool(items),
                    "weakPointsConsidered": bool(rationale.get("weakPoints")),
                },
                detail="Confirm diagnostic-generated learning path is explainable.",
            )
        if context.workflow == "profile_setup":
            path = generate_learning_path(context.user, force=True)
            path_payload = serialize_path(path)
            items = path_payload.get("items") if isinstance(path_payload.get("items"), list) else []
            rationale = path_payload.get("rationale") if isinstance(path_payload.get("rationale"), dict) else {}
            planner_advice = generate_planner_adjustment(
                profile=_profile_snapshot_for_llm(context.user),
                path=path_payload,
                goal=context.goal,
            )
            return AgentResult(
                output={"path": path_payload, "pathGenerated": True, "pathId": str(path.id), "plannerAdvice": planner_advice},
                state_patch={"path": path_payload, "pathGenerated": True, "pathItemCount": len(items), "plannerAdvice": planner_advice},
                input_summary={
                    "source": "structured_profile",
                    "weakPoints": len(context.state.get("weakPoints") or []),
                },
                output_summary={"pathId": str(path.id), "items": len(items), "version": path.version},
                state_diff={"LearningPath": "generated", "LearningPathItem": len(items)},
                evidence={
                    "plannerInput": "structured_profile",
                    "strategy": rationale.get("strategy") or "",
                    "weakPointCount": len(rationale.get("weakPoints") or []),
                    "pathItemCount": len(items),
                    "courseId": str(path.course_id),
                    "llmAdvice": planner_advice.get("advice") or "",
                    "llmProvider": planner_advice.get("provider") or "",
                    "llmModel": planner_advice.get("model") or "",
                    "llmFallback": bool(planner_advice.get("fallback")),
                    "ruleGuardrail": "learning_path_persisted_before_llm_advice",
                },
                quality={
                    "hasPathItems": bool(items),
                    "weakPointsConsidered": bool(rationale.get("weakPoints")),
                    "llmAdviceAvailable": bool(planner_advice.get("advice")),
                },
                detail="Generate learning path immediately after structured profile setup.",
            )
        if context.workflow != "path_generate":
            return AgentResult(output={"plannerReady": True}, state_patch={"plannerReady": True})
        path = generate_learning_path(
            context.user,
            course=context.payload.get("course"),
            force=bool(context.payload.get("force", False)),
        )
        path_payload = serialize_path(path)
        items = path_payload.get("items") if isinstance(path_payload.get("items"), list) else []
        rationale = path_payload.get("rationale") if isinstance(path_payload.get("rationale"), dict) else {}
        planner_advice = generate_planner_adjustment(
            profile=_profile_snapshot_for_llm(context.user),
            path=path_payload,
            goal=str(context.payload.get("goal") or context.goal or ""),
        )
        return AgentResult(
            output={"path": path_payload, "pathId": str(path.id), "plannerAdvice": planner_advice},
            state_patch={"path": path_payload, "pathItemCount": len(items), "plannerAdvice": planner_advice},
            input_summary={
                "courseId": str(path.course_id),
                "force": bool(context.payload.get("force", False)),
                "weakPoints": len(rationale.get("weakPoints") or []),
            },
            output_summary={
                "pathId": str(path.id),
                "items": len(items),
                "version": path.version,
            },
            state_diff={"LearningPath": "generated", "LearningPathItem": len(items)},
            evidence={
                "strategy": rationale.get("strategy") or "",
                "weakPointCount": len(rationale.get("weakPoints") or []),
                "pathItemCount": len(items),
                "courseId": str(path.course_id),
                "llmAdvice": planner_advice.get("advice") or "",
                "llmProvider": planner_advice.get("provider") or "",
                "llmModel": planner_advice.get("model") or "",
                "llmFallback": bool(planner_advice.get("fallback")),
                "ruleGuardrail": "learning_path_persisted_before_llm_advice",
            },
            quality={
                "hasPathItems": bool(items),
                "weakPointsConsidered": bool(rationale.get("weakPoints")),
                "llmAdviceAvailable": bool(planner_advice.get("advice")),
            },
        )


class GraphAgent(BaseAgent):
    name = "GraphAgent"
    role = "prerequisite graph"
    detail = "Validate prerequisite graph order and explain path node sequencing."

    def run(self, context: AgentContext) -> AgentResult:
        path_payload = context.state.get("path") if isinstance(context.state.get("path"), dict) else {}
        items = path_payload.get("items") if isinstance(path_payload.get("items"), list) else []
        current_items = [item for item in items if isinstance(item, dict) and item.get("status") == "current"]
        locked_items = [item for item in items if isinstance(item, dict) and item.get("status") == "locked"]
        return AgentResult(
            output={"graphValidated": bool(items)},
            state_patch={"graphValidated": bool(items)},
            input_summary={"items": len(items)},
            output_summary={"currentItems": len(current_items), "lockedItems": len(locked_items)},
            state_diff={"PrerequisiteGraph": "validated"},
            evidence={
                "firstNode": ((items[0] or {}).get("knowledgePoint") or {}).get("title") if items else "",
                "currentNodeCount": len(current_items),
                "lockedNodeCount": len(locked_items),
                "prerequisiteOrderChecked": bool(items),
            },
            quality={"singleCurrentNode": len(current_items) <= 1, "hasLockedSequence": bool(locked_items)},
        )


class RetrieverAgent(BaseAgent):
    name = "RetrieverAgent"
    role = "knowledge retrieval"
    detail = "Prepare retrieval mode and evidence requirements for recommendation."
    max_retries = 1
    timeout_ms = 3000

    def run(self, context: AgentContext) -> AgentResult:
        if context.workflow == "qa_interact":
            question = str(context.payload.get("question") or "").strip()
            qa_context = classroom_context(context.user)
            context_sources = qa_context.get("sources") if isinstance(qa_context.get("sources"), list) else []
            retrieval_mode = "classroom_context"
            reasoning_mode = "deep" if str(context.payload.get("mode") or "").strip().lower() == "deep" else "fast"
            requested_scope = _normalize_qa_scope(context.payload.get("scope"))
            selected_resource_id = str(context.payload.get("resourceId") or "").strip()
            top_k = 8 if reasoning_mode == "deep" else 5
            candidate_multiplier = 2
            rag_results = []
            source_scope_by_path = indexed_resource_scope_by_path(context.user, include_global=True)
            source_scope_by_path = _filter_qa_source_scope(
                source_scope_by_path,
                scope=requested_scope,
                resource_id=selected_resource_id,
            )
            allowed_source_paths = set(source_scope_by_path)
            fusion_sources, fusion_metadata = _search_classroom_fusion_sources(
                context.user,
                question,
                top_k=top_k,
                source_scope_by_path=source_scope_by_path,
                reasoning_mode=reasoning_mode,
            )
            realtime_rag_enabled = os.getenv("A3_QA_REALTIME_RAG_ENABLED", "0").strip() == "1"
            if realtime_rag_enabled and not fusion_sources:
                try:
                    rag_results = (
                        search_knowledge_base(
                            query=question,
                            top_k=top_k,
                            allowed_source_paths=allowed_source_paths,
                            source_scope_by_path=source_scope_by_path,
                            candidate_multiplier=candidate_multiplier,
                            force_lexical=True,
                            visual_use_embedding=False,
                        )
                        if question and allowed_source_paths
                        else []
                    )
                except Exception:
                    rag_results = []
            if fusion_sources:
                sources = fusion_sources
                retrieval_mode = "graph_vector_fusion"
            elif rag_results:
                sources = [_rag_result_to_source(item, index) for index, item in enumerate(rag_results, start=1)]
                retrieval_mode = "realtime_rag"
            else:
                sources = context_sources
                retrieval_mode = "classroom_context_fast"
            return AgentResult(
                output={"classroomContext": qa_context, "sources": sources, "retrievalMode": retrieval_mode},
                state_patch={"sourceCount": len(sources), "sources": sources, "classroomContext": qa_context, "retrievalMode": retrieval_mode},
                evidence={
                    "sourceCount": len(sources),
                    "retrievalMode": retrieval_mode,
                    "query": question,
                    "topK": top_k,
                    "candidateMultiplier": candidate_multiplier,
                    "allowedSourceCount": len(allowed_source_paths),
                    "realtimeRagEnabled": realtime_rag_enabled,
                    "indexedBlockSearch": bool(fusion_metadata.get("blockCount")),
                    "fusionComponents": fusion_metadata.get("components", []),
                    "fusionGraphCount": fusion_metadata.get("graphCount", 0),
                    "fusionBlockCount": fusion_metadata.get("blockCount", 0),
                    "fusionVectorIndexedCount": fusion_metadata.get("vectorIndexedCount", 0),
                    "reasoningMode": reasoning_mode,
                    "requestedScope": requested_scope,
                    "selectedResourceId": selected_resource_id,
                    "budgetMode": "interactive_qa",
                },
                quality={"hasSources": bool(sources), "realtimeRag": retrieval_mode == "realtime_rag", "fusionRetrieval": retrieval_mode == "graph_vector_fusion", "fastIndexedBlocks": bool(fusion_metadata.get("blockCount"))},
                detail="Retrieve graph/vector/lexical fused sources for classroom QA.",
            )
        mode = "deep" if context.payload.get("mode") == "deep" else "fast"
        top_k = max(1, min(int(context.payload.get("topK") or 6), 12))
        return AgentResult(
            output={"retrievalConfig": {"mode": mode, "topK": top_k}},
            state_patch={"retrievalConfig": {"mode": mode, "topK": top_k}},
            evidence={
                "mode": mode,
                "topK": top_k,
                "source": "local_knowledge_base",
                "fallback": "keyword_or_cached_when_vector_unavailable",
            },
            quality={"retrievalConfigured": True},
        )

    def fallback(self, context: AgentContext, error: Exception) -> AgentResult | None:
        if context.workflow != "qa_interact":
            return None
        qa_context = classroom_context(context.user)
        sources = qa_context.get("sources") if isinstance(qa_context.get("sources"), list) else []
        return AgentResult(
            output={"classroomContext": qa_context, "sources": sources, "retrievalMode": "retriever_fallback"},
            state_patch={"sourceCount": len(sources), "sources": sources, "classroomContext": qa_context, "retrievalMode": "retriever_fallback"},
            evidence={"sourceCount": len(sources), "retrievalMode": "retriever_fallback", "error": str(error)},
            quality={"hasSources": bool(sources), "fallbackUsed": True},
            detail="Fallback to classroom context when realtime retrieval is unavailable.",
        )


class RankerAgent(BaseAgent):
    name = "RankerAgent"
    role = "personalized ranking"
    detail = "Build grounded recommendation payload with profile, path, and KB evidence."

    def run(self, context: AgentContext) -> AgentResult:
        config = context.state.get("retrievalConfig") or {}
        payload = build_recommendation_payload(
            context.user,
            goal=str(context.payload.get("goal") or ""),
            top_k=int(config.get("topK") or 6),
            retrieval_mode=str(config.get("mode") or "fast"),
        )
        recommendations = payload.get("recommendations") if isinstance(payload.get("recommendations"), list) else []
        rationale = payload.get("rationale") if isinstance(payload.get("rationale"), dict) else {}
        first_evidence = (
            recommendations[0].get("evidence")
            if recommendations and isinstance(recommendations[0], dict) and isinstance(recommendations[0].get("evidence"), dict)
            else {}
        )
        ranking_basis = first_evidence.get("rankingBasis") if isinstance(first_evidence.get("rankingBasis"), list) else []
        profile_match = first_evidence.get("profileMatch") if isinstance(first_evidence.get("profileMatch"), dict) else {}
        return AgentResult(
            output={"recommendationPayload": payload, **payload},
            state_patch={"recommendationCount": len(recommendations)},
            evidence={
                "sourceCount": len(payload.get("sources") or []),
                "rankingBasis": ranking_basis,
                "profileMatch": profile_match,
                "fallbackUsed": bool(rationale.get("fallbackUsed")),
                "retrievalMode": rationale.get("retrievalMode") or config.get("mode") or "fast",
            },
            quality={
                "hasRecommendations": bool(recommendations),
                "rankingBasisExposed": bool(ranking_basis),
                "profileMatchExposed": bool(profile_match),
            },
        )


class VerifierAgent(BaseAgent):
    name = "VerifierAgent"
    role = "recommendation verification"
    detail = "Check citation coverage and profile-match transparency."
    max_retries = 1
    timeout_ms = 3000

    def run(self, context: AgentContext) -> AgentResult:
        if context.workflow == "verify_answer":
            question = str(context.payload.get("question") or "").strip()
            answer = str(context.payload.get("answer") or "").strip()
            sources = context.payload.get("sources") if isinstance(context.payload.get("sources"), list) else []
            verification = verify_answer(question, answer, sources)
            return AgentResult(
                output={"verification": verification.as_dict(), **verification.as_dict()},
                state_patch={"verified": verification.verified},
                input_summary={
                    "sources": len(sources),
                    "answerLength": len(answer),
                    "candidateClaims": context.state.get("candidateClaimCount", 0),
                },
                output_summary={
                    "verified": verification.verified,
                    "citations": len(verification.citations),
                    "claims": len(verification.claims),
                    "refusalReason": verification.refusalReason,
                },
                state_diff={"VerificationLog": "evaluated"},
                evidence={
                    "sourceCount": len(sources),
                    "citationCount": len(verification.citations),
                    "claimCount": len(verification.claims),
                    "missingEvidence": verification.refusalReason == "missing_evidence",
                },
                quality={
                    "verified": verification.verified,
                    "claimSupportRate": _claim_support_rate_for_kernel(verification.claims),
                    "safe": verification.safety.get("safe"),
                    "safety": {
                        "safe": verification.safety.get("safe"),
                        "category": verification.safety.get("category") or "education",
                        "reason": verification.safety.get("reason") or "",
                        "decision": "allow" if verification.safety.get("safe") else "block",
                    },
                    "contract": {
                        "schemaVersion": "a3.verify-answer.v1",
                        "satisfied": bool(isinstance(verification.as_dict(), dict)),
                    },
                },
                detail="Verify answer safety, citations, and claim support.",
            )
        if context.workflow == "qa_interact":
            question = str(context.payload.get("question") or "").strip()
            answer = str(context.state.get("draftAnswer") or "").strip()
            sources = context.state.get("sources") if isinstance(context.state.get("sources"), list) else []
            verification = verify_answer(question, answer, sources)
            return AgentResult(
                output={"verification": verification.as_dict(), **verification.as_dict()},
                state_patch={"verified": verification.verified},
                evidence={
                    "sourceCount": len(sources),
                    "citationCount": len(verification.citations),
                    "claimCount": len(verification.claims),
                    "missingEvidence": verification.refusalReason == "missing_evidence",
                },
                quality={
                    "verified": verification.verified,
                    "safe": verification.safety.get("safe"),
                    "safety": {
                        "safe": verification.safety.get("safe"),
                        "category": verification.safety.get("category") or "education",
                        "reason": verification.safety.get("reason") or "",
                        "decision": "allow" if verification.safety.get("safe") else "block",
                    },
                    "contract": {
                        "schemaVersion": "a3.qa-interact.verify.v1",
                        "satisfied": bool(isinstance(verification.as_dict(), dict)),
                    },
                },
                detail="Verify tutoring answer against safety policy and citations.",
            )
        payload = context.state.get("recommendationPayload") or {}
        recommendations = payload.get("recommendations") or []
        sources = payload.get("sources") or []
        citation_coverage = round(min(1.0, len(sources) / max(1, len(recommendations))), 3)
        return AgentResult(
            output={"recommendationVerified": citation_coverage > 0},
            state_patch={"recommendationQuality": {"citationCoverage": citation_coverage}},
            evidence={"sourceCount": len(sources), "recommendationCount": len(recommendations)},
            quality={"citationCoverage": citation_coverage},
        )


class ResourcePackAgent(BaseAgent):
    name = "ResourcePackAgent"
    role = "resource pack synthesis"
    detail = "Validate executable resource pack and next learning action."

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.state.get("recommendationPayload") or {}
        pack = payload.get("resourcePack") if isinstance(payload.get("resourcePack"), dict) else {}
        practice = pack.get("practice") if isinstance(pack.get("practice"), dict) else {}
        resources = pack.get("resources") if isinstance(pack.get("resources"), list) else []
        return AgentResult(
            output={"resourcePackReady": bool(resources)},
            state_patch={"resourcePackReady": bool(resources)},
            evidence={
                "resourceCount": len(resources),
                "practiceActionHref": practice.get("href") or "",
                "fallbackUsed": bool((pack.get("metrics") or {}).get("fallbackUsed")) if isinstance(pack.get("metrics"), dict) else False,
            },
            quality={"hasPracticeAction": bool(practice.get("href"))},
        )


class SafetyAgent(BaseAgent):
    name = "SafetyAgent"
    role = "learning safety"
    detail = "Classify the learner request before tutoring."

    def run(self, context: AgentContext) -> AgentResult:
        text = str(context.payload.get("question") or context.payload.get("text") or "").strip()
        answer = str(context.payload.get("answer") or "").strip()
        if context.workflow == "verify_answer" and answer:
            text = f"{text}\n{answer}".strip()
        safety = check_learning_safety(text)
        return AgentResult(
            output={"safety": safety.as_dict()},
            state_patch={"safe": safety.safe},
            input_summary={
                "questionLength": len(str(context.payload.get("question") or "")),
                "answerLength": len(answer),
                "sources": len(context.payload.get("sources") or []) if isinstance(context.payload.get("sources"), list) else 0,
            } if context.workflow == "verify_answer" else {},
            output_summary={
                "safe": safety.safe,
                "category": safety.category,
                "reason": safety.reason,
            } if context.workflow == "verify_answer" else {},
            evidence={"policy": "learning_safety_rules", "category": safety.category, "reason": safety.reason},
            quality={
                "safe": safety.safe,
                "policyDecision": "allow" if safety.safe else "block",
                "safety": {
                    "safe": safety.safe,
                    "category": safety.category,
                    "reason": safety.reason,
                    "decision": "allow" if safety.safe else "block",
                },
            },
        )


class ClaimExtractorAgent(BaseAgent):
    name = "ClaimExtractorAgent"
    role = "claim extraction"
    detail = "Extract candidate factual claims before evidence verification."

    def run(self, context: AgentContext) -> AgentResult:
        answer = str(context.payload.get("answer") or "").strip()
        sources = context.payload.get("sources") if isinstance(context.payload.get("sources"), list) else []
        separators = [".", "。", "!", "！", "?", "？", "\n"]
        normalized = answer
        for separator in separators[1:]:
            normalized = normalized.replace(separator, separators[0])
        candidate_claims = [part.strip() for part in normalized.split(separators[0]) if len(part.strip()) >= 6]
        if not candidate_claims and answer:
            candidate_claims = [answer]
        return AgentResult(
            output={"candidateClaims": candidate_claims},
            state_patch={"candidateClaimCount": len(candidate_claims)},
            input_summary={"answerLength": len(answer), "sources": len(sources)},
            output_summary={"candidateClaims": len(candidate_claims)},
            state_diff={"claims": "extracted"},
            evidence={"sourceCount": len(sources)},
            quality={"hasCandidateClaims": bool(candidate_claims)},
        )


class ProfileAgent(BaseAgent):
    name = "ProfileAgent"
    role = "profile extraction"
    detail = "Extract structured learner profile fields from free-form text."
    max_retries = 1
    timeout_ms = 2500

    def run(self, context: AgentContext) -> AgentResult:
        text = str(context.payload.get("text") or "").strip()
        result = extract_and_save_profile(context.user, text)
        updated_fields = result.get("updatedFields") if isinstance(result.get("updatedFields"), list) else []
        weak_points = result.get("profile", {}).get("weakPoints") if isinstance(result.get("profile"), dict) else []
        profile_field_names = [str(field) for field in updated_fields if str(field).strip()]
        return AgentResult(
            output={"profileExtractResult": result, **result},
            state_patch={"updatedFields": updated_fields},
            input_summary={"textLength": len(text)},
            output_summary={"updatedFields": updated_fields, "weakPoints": len(weak_points or [])},
            state_diff={"LearnerProfile": "updated" if updated_fields else "unchanged"},
            evidence={
                "source": "free_form_profile_text",
                "updatedFieldCount": len(profile_field_names),
                "weakPointCount": len(weak_points or []),
                "profileFieldNames": profile_field_names,
            },
            quality={"profileFieldsExtracted": bool(updated_fields)},
        )


class MemoryAgent(BaseAgent):
    name = "MemoryAgent"
    role = "profile memory"
    detail = "Confirm extracted learner profile has been persisted."

    def run(self, context: AgentContext) -> AgentResult:
        result = context.state.get("profileExtractResult") if isinstance(context.state.get("profileExtractResult"), dict) else {}
        profile = result.get("profile") if isinstance(result.get("profile"), dict) else {}
        weak_points = profile.get("weakPoints") if isinstance(profile.get("weakPoints"), list) else []
        return AgentResult(
            output={"memoryCommitted": bool(profile)},
            state_patch={"memoryCommitted": bool(profile)},
            output_summary={"weakPoints": len(weak_points)},
            state_diff={"LearnerProfile": "persisted" if profile else "missing"},
            evidence={
                "profileId": profile.get("id") or "",
                "persistTarget": "LearnerProfile",
                "weakPointCount": len(weak_points),
                "memoryCommitted": bool(profile),
            },
            quality={"memoryWrite": bool(profile)},
        )


class ProfileNormalizeAgent(BaseAgent):
    name = "ProfileNormalizeAgent"
    role = "structured profile normalization"
    detail = "Normalize structured learner profile choices before persistence."

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.payload if isinstance(context.payload, dict) else {}
        multi_fields = ("learningGoals", "weakPoints", "learningPreferences", "expectedResources")
        selected_counts = {
            field: len(payload.get(field) or []) if isinstance(payload.get(field), list) else 0
            for field in multi_fields
        }
        scalar_fields = [
            field
            for field in ("displayName", "majorDirection", "grade", "foundationLevel", "dailyStudyTime", "pace")
            if str(payload.get(field) or "").strip()
        ]
        return AgentResult(
            output={"normalizedProfileInput": payload},
            state_patch={
                "normalizedProfileInput": payload,
                "weakPoints": payload.get("weakPoints") if isinstance(payload.get("weakPoints"), list) else [],
            },
            input_summary={"fieldCount": len(payload)},
            output_summary={"scalarFields": len(scalar_fields), "multiSelections": selected_counts},
            state_diff={"profileInput": "normalized"},
            evidence={
                "source": "structured_profile_setup_form",
                "scalarFieldCount": len(scalar_fields),
                "multiFieldCounts": selected_counts,
            },
            quality={"hasRequiredProfileSignals": bool(scalar_fields) and bool(selected_counts.get("weakPoints"))},
        )


class ProfileCommitAgent(BaseAgent):
    name = "ProfileCommitAgent"
    role = "structured profile commit"
    detail = "Persist structured learner profile without generating learning assets."
    max_retries = 1
    timeout_ms = 2500

    def run(self, context: AgentContext) -> AgentResult:
        from backend.apps.profiles.services import _save_learning_profile_core

        payload = context.state.get("normalizedProfileInput")
        if not isinstance(payload, dict):
            payload = context.payload if isinstance(context.payload, dict) else {}
        result = _save_learning_profile_core(context.user, payload, refresh_learning_assets=False)
        profile = result.get("profile") if isinstance(result.get("profile"), dict) else {}
        profile_fields = [
            "grade",
            "majorDirection",
            "foundationLevel",
            "dailyStudyTime",
            "pace",
            "learningGoals",
            "weakPoints",
            "learningPreferences",
            "expectedResources",
        ]
        updated_fields = [field for field in profile_fields if profile.get(field)]
        weak_points = profile.get("weakPoints") if isinstance(profile.get("weakPoints"), list) else []
        return AgentResult(
            output={"profile": profile, "profileSetupResult": result, "updatedFields": updated_fields},
            state_patch={"profile": profile, "profileCommitted": bool(profile), "weakPoints": weak_points},
            input_summary={"normalizedFields": len(payload)},
            output_summary={"updatedFields": updated_fields, "weakPoints": len(weak_points)},
            state_diff={"LearnerProfile": "persisted", "User.onboarding_step": "complete"},
            evidence={
                "persistTarget": "LearnerProfile",
                "updatedFieldCount": len(updated_fields),
                "weakPointCount": len(weak_points),
                "profileId": profile.get("id") or "",
            },
            quality={"profileCommitted": bool(profile), "profileReady": result.get("profileReadiness", {}).get("status") == "ready"},
        )


class TeacherAgent(BaseAgent):
    name = "TeacherAgent"
    role = "grounded tutoring"
    detail = "Draft a tutoring answer from current target and retrieved sources."

    def run(self, context: AgentContext) -> AgentResult:
        question = str(context.payload.get("question") or "").strip()
        qa_context = context.state.get("classroomContext") if isinstance(context.state.get("classroomContext"), dict) else {}
        sources = context.state.get("sources") if isinstance(context.state.get("sources"), list) else []
        target = qa_context.get("target") if isinstance(qa_context.get("target"), dict) else {}
        llm_result = generate_tutoring_answer(question, target=target, sources=sources)
        answer = str(llm_result.get("answer") or "").strip()
        return AgentResult(
            output={"draftAnswer": answer},
            state_patch={"draftAnswer": answer},
            evidence={
                "sourceCount": len(sources),
                "sourceTitles": [str(source.get("title") or "") for source in sources[:3] if isinstance(source, dict)],
                "targetTitle": target.get("title") or "current knowledge point",
                "llmProvider": llm_result.get("provider") or "",
                "llmModel": llm_result.get("model") or "",
                "llmFallback": bool(llm_result.get("fallback")),
                "llmFinishReason": llm_result.get("finishReason") or "",
                "llmContinuationUsed": bool(llm_result.get("continuationUsed")),
            },
            quality={"groundedDraft": bool(sources), "llmDraftAvailable": bool(answer)},
        )


class FollowUpAgent(BaseAgent):
    name = "FollowUpAgent"
    role = "guided follow-up"
    detail = "Suggest grounded next questions after a classroom answer."
    max_retries = 0
    timeout_ms = 1000

    def run(self, context: AgentContext) -> AgentResult:
        question = str(context.payload.get("question") or "").strip()
        answer = str(context.state.get("draftAnswer") or "").strip()
        verification = context.state.get("verification") if isinstance(context.state.get("verification"), dict) else {}
        sources = context.state.get("sources") if isinstance(context.state.get("sources"), list) else []
        qa_context = context.state.get("classroomContext") if isinstance(context.state.get("classroomContext"), dict) else {}
        target = qa_context.get("target") if isinstance(qa_context.get("target"), dict) else {}
        safety = verification.get("safety") if isinstance(verification.get("safety"), dict) else {}
        follow_ups = build_follow_up_suggestions(
            question,
            answer,
            verified=bool(verification.get("verified")),
            safe=bool(safety.get("safe", True)),
            target_title=str(target.get("title") or ""),
            source_count=len(sources),
        )
        return AgentResult(
            output={"followUps": follow_ups},
            state_patch={"followUps": follow_ups},
            input_summary={"verified": bool(verification.get("verified")), "sourceCount": len(sources)},
            output_summary={"followUpCount": len(follow_ups), "types": [item["type"] for item in follow_ups]},
            state_diff={"ClassroomFollowUps": len(follow_ups)},
            evidence={
                "question": question[:120],
                "answerLength": len(answer),
                "targetTitle": target.get("title") or "",
                "sourceCount": len(sources),
                "verified": bool(verification.get("verified")),
            },
            quality={
                "hasFollowUps": len(follow_ups) >= 2,
                "safeWhenUnverified": bool(verification.get("verified"))
                or all(item["type"] in {"evidence", "clarify", "concept"} for item in follow_ups),
            },
        )


class TeacherWorkbenchAgent(BaseAgent):
    name = "TeacherWorkbenchAgent"
    role = "teacher workbench analysis"
    detail = "Read class learning state and validate teacher task scope."

    def run(self, context: AgentContext) -> AgentResult:
        workbench = teacher_workbench(context.user)
        students = workbench.get("students") if isinstance(workbench.get("students"), list) else []
        task_type = str(context.payload.get("type") or "").strip()
        student_id = str(context.payload.get("studentId") or "").strip()
        risk_students = [student for student in students if isinstance(student, dict) and student.get("riskLevel") in {"high", "medium"}]
        target_in_scope = not student_id or any(str(student.get("id") or "") == student_id for student in students if isinstance(student, dict))
        return AgentResult(
            output={"teacherWorkbench": workbench},
            state_patch={
                "teacherWorkbench": workbench,
                "teacherTaskType": task_type,
                "targetInScope": target_in_scope,
            },
            input_summary={"taskType": task_type, "targeted": bool(student_id)},
            output_summary={"students": len(students), "riskStudents": len(risk_students), "targetInScope": target_in_scope},
            state_diff={"TeacherWorkbench": "read"},
            evidence={
                "taskType": task_type,
                "studentCount": len(students),
                "riskStudentCount": len(risk_students),
                "targetStudentId": student_id,
                "targetInScope": target_in_scope,
            },
            quality={"teacherScopeResolved": bool(students) or not student_id, "targetInScope": target_in_scope},
            detail="Validate teacher task against current class learning state.",
        )


class NotificationAgent(BaseAgent):
    name = "NotificationAgent"
    role = "teacher notification dispatch"
    detail = "Execute teacher task and write student notifications."

    def run(self, context: AgentContext) -> AgentResult:
        task_type = str(context.payload.get("type") or "").strip()
        student_id = str(context.payload.get("studentId") or "").strip()
        message = str(context.payload.get("message") or "").strip()
        dedupe_key = str(context.payload.get("dedupeKey") or "").strip()
        result = execute_teacher_task(context.user, task_type, student_id=student_id, message=message, dedupe_key=dedupe_key)
        notification_queryset = UserNotification.objects.filter(
            payload__teacherId=str(context.user.id),
            payload__taskType=task_type,
        )
        if student_id:
            notification_queryset = notification_queryset.filter(user_id=student_id)
        latest = notification_queryset.order_by("-created_at").first()
        action_url = str(result.get("actionUrl") or getattr(latest, "action_url", "") or "")
        return AgentResult(
            output={"teacherTaskResult": result},
            state_patch={"teacherTaskResult": result, "teacherTaskActionUrl": action_url},
            input_summary={"taskType": task_type, "targeted": bool(student_id)},
            output_summary={
                "createdNotifications": result.get("createdNotifications", 0),
                "existingNotifications": result.get("existingNotifications", 0),
                "actionUrl": action_url,
            },
            state_diff={"UserNotification": int(result.get("createdNotifications") or 0)},
            evidence={
                "taskType": task_type,
                "createdNotifications": int(result.get("createdNotifications") or 0),
                "existingNotifications": int(result.get("existingNotifications") or 0),
                "writeBackTarget": "UserNotification",
                "targetStudentId": str(result.get("targetStudentId") or student_id),
                "actionUrl": action_url,
                "dedupeKey": dedupe_key,
                "dedupeApplied": bool(dedupe_key),
            },
            quality={
                "notificationWritten": int(result.get("createdNotifications") or 0) > 0,
                "notificationAvailable": int(result.get("createdNotifications") or 0) + int(result.get("existingNotifications") or 0) > 0,
                "dedupeApplied": bool(dedupe_key),
            },
            detail="Dispatch teacher task into student notification center.",
        )


def _rag_result_to_source(item, index: int) -> dict:
    metadata = item.metadata if isinstance(item.metadata, dict) else {}
    source_type_label = format_source_type_label(metadata, fallback="本地资料")
    return {
        "id": f"rag-{index}",
        "title": str(metadata.get("title") or metadata.get("file_name") or metadata.get("original_name") or safe_source_filename(metadata.get("source_path")) or "知识库片段"),
        "location": format_source_display_location(metadata),
        "type": source_type_label,
        "sourceTypeLabel": source_type_label,
        "sourceOrigin": source_origin_label(metadata),
        "sourceScope": str(metadata.get("source_scope") or metadata.get("sourceScope") or ""),
        "score": round(float(item.score), 3) if item.score is not None else None,
        "snippet": str(item.text or "")[:800],
    }


def _normalize_qa_scope(value) -> str:
    scope = str(value or "all").strip().lower()
    return scope if scope in {"all", "personal", "teacher", "class", "global"} else "all"


def _filter_qa_source_scope(source_scope_by_path: dict[str, str], *, scope: str, resource_id: str) -> dict[str, str]:
    filtered = dict(source_scope_by_path or {})
    if scope != "all":
        filtered = {path: item_scope for path, item_scope in filtered.items() if item_scope == scope}
    if resource_id:
        resource = KnowledgeResource.objects.filter(id=resource_id).only("stored_path").first()
        if resource and resource.stored_path:
            resolved = str(Path(resource.stored_path).resolve())
            filtered = {path: item_scope for path, item_scope in filtered.items() if str(Path(path).resolve()) == resolved}
        else:
            filtered = {}
    return filtered


def _search_classroom_indexed_blocks(user, question: str, *, top_k: int, source_scope_by_path: dict[str, str], reasoning_mode: str = "fast") -> list[dict]:
    terms = _classroom_query_terms(question)
    if not terms:
        return []
    resources = list(
        KnowledgeResource.objects.filter(
            status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS],
            stored_path__in=list(source_scope_by_path.keys()),
        ).only("id", "original_name", "stored_path", "file_type", "resource_scope", "updated_at")
    )
    if not resources:
        return []
    resource_by_id = {resource.id: resource for resource in resources}
    query_filter = None
    for term in terms[:8]:
        term_filter = (
            Q(text__icontains=term)
            | Q(markdown__icontains=term)
            | Q(resource__original_name__icontains=term)
        )
        query_filter = term_filter if query_filter is None else query_filter | term_filter
    if query_filter is None:
        return []
    block_limit = 900 if reasoning_mode == "deep" else 500
    blocks = (
        KnowledgeBlock.objects.filter(resource_id__in=resource_by_id.keys())
        .filter(query_filter)
        .select_related("resource", "page", "asset")
        .order_by("-resource__updated_at", "page__page_number", "page__slide_number", "created_at")[:block_limit]
    )
    ranked = []
    seen_resources: dict[str, int] = {}
    for block in blocks:
        resource = block.resource
        text = (block.markdown or block.text or "").strip()
        if not text:
            continue
        score = _classroom_block_score(question, terms, block, resource, seen_resources.get(str(resource.id), 0), reasoning_mode=reasoning_mode)
        if score <= 0:
            continue
        ranked.append((score, block))
        seen_resources[str(resource.id)] = seen_resources.get(str(resource.id), 0) + 1
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [
        _knowledge_block_to_source(block, index, score, source_scope_by_path)
        for index, (score, block) in enumerate(ranked[:top_k], start=1)
    ]


def _search_classroom_fusion_sources(user, question: str, *, top_k: int, source_scope_by_path: dict[str, str], reasoning_mode: str = "fast") -> tuple[list[dict], dict]:
    block_sources = _search_classroom_indexed_blocks(
        user,
        question,
        top_k=max(top_k * 2, top_k),
        source_scope_by_path=source_scope_by_path,
        reasoning_mode=reasoning_mode,
    )
    block_sources = [_enrich_block_source_with_index_types(source) for source in block_sources]
    graph_sources = _search_classroom_graph_sources(
        user,
        question,
        top_k=max(top_k, 4),
        source_scope_by_path=source_scope_by_path,
    )
    merged: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for source in sorted([*graph_sources, *block_sources], key=lambda item: float(item.get("score") or 0), reverse=True):
        key = (
            str(source.get("resourceId") or ""),
            str(source.get("blockId") or source.get("claimId") or source.get("entityId") or ""),
            str(source.get("retriever") or "block"),
        )
        if key in seen:
            continue
        seen.add(key)
        merged.append({**source, "id": f"fusion-source-{len(merged) + 1}"})
        if len(merged) >= top_k:
            break
    components = []
    if block_sources:
        components.append("block")
    if any(source.get("indexTypes") for source in block_sources):
        components.append("vector")
    if graph_sources:
        components.append("graph")
    return merged, {
        "components": components,
        "blockCount": len(block_sources),
        "graphCount": len(graph_sources),
        "vectorIndexedCount": sum(1 for source in block_sources if source.get("indexTypes")),
    }


def _enrich_block_source_with_index_types(source: dict) -> dict:
    block_id = str(source.get("blockId") or "").strip()
    if not block_id:
        return {**source, "retriever": source.get("retriever") or "block", "indexTypes": []}
    index_types = list(
        KnowledgeIndexEntry.objects.filter(block_id=block_id, status="indexed")
        .order_by("index_type")
        .values_list("index_type", flat=True)
        .distinct()
    )
    score = float(source.get("score") or 0)
    if "text_vector" in index_types:
        score += 1.5
    if "visual_vector" in index_types:
        score += 1.0
    if "lexical" in index_types:
        score += 0.5
    return {
        **source,
        "retriever": "block",
        "indexTypes": index_types,
        "score": round(score, 3),
    }


def _search_classroom_graph_sources(user, question: str, *, top_k: int, source_scope_by_path: dict[str, str]) -> list[dict]:
    terms = _classroom_query_terms(question)
    if not terms:
        return []
    resources = _fusion_resources_for_scope(source_scope_by_path)
    if not resources:
        return []
    resource_by_id = {resource.id: resource for resource in resources}
    claim_rows = KnowledgeGraphClaim.objects.filter(owner=user, resource_id__in=resource_by_id.keys()).select_related("resource")[:600]
    entity_rows = KnowledgeGraphEntity.objects.filter(owner=user, resource_id__in=resource_by_id.keys()).select_related("resource")[:600]
    relation_rows = KnowledgeGraphRelation.objects.filter(owner=user, resource_id__in=resource_by_id.keys()).select_related("resource", "source_entity", "target_entity")[:600]
    candidates: list[tuple[float, dict]] = []
    for claim in claim_rows:
        text = str(claim.text or "")
        score = _graph_text_score(text, terms) + (2.5 if claim.verified else 0.8) + (0 if claim.degraded else 1.0)
        if score <= 0:
            continue
        candidates.append((score, _graph_claim_to_source(claim, score, source_scope_by_path)))
    for entity in entity_rows:
        text = " ".join([entity.label, entity.normalized_label, entity.summary, " ".join(str(alias) for alias in (entity.aliases or []))])
        score = _graph_text_score(text, terms) + (0 if entity.degraded else 0.8)
        if score <= 0:
            continue
        candidates.append((score, _graph_entity_to_source(entity, score, source_scope_by_path)))
    for relation in relation_rows:
        text = " ".join([relation.source_entity.label, relation.label, relation.target_entity.label, relation.relation_type, _graph_evidence_text(relation.evidence)])
        score = _graph_text_score(text, terms) + float(relation.weight or 0) + (0 if relation.degraded else 0.8)
        if score <= 0:
            continue
        candidates.append((score, _graph_relation_to_source(relation, score, source_scope_by_path)))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return [source for _, source in candidates[:top_k]]


def _fusion_resources_for_scope(source_scope_by_path: dict[str, str]) -> list[KnowledgeResource]:
    paths = list(source_scope_by_path.keys())
    if not paths:
        return []
    return list(
        KnowledgeResource.objects.filter(
            status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS],
            stored_path__in=paths,
        ).only("id", "original_name", "stored_path", "file_type", "resource_scope", "updated_at")
    )


def _graph_text_score(text: str, terms: list[str]) -> float:
    value = str(text or "").lower()
    score = 0.0
    for term in terms:
        normalized = term.lower()
        if not normalized:
            continue
        score += min(value.count(normalized), 4) * (2.0 if len(normalized) >= 3 else 1.0)
    return score


def _graph_claim_to_source(claim: KnowledgeGraphClaim, score: float, source_scope_by_path: dict[str, str]) -> dict:
    resource = claim.resource
    metadata = _graph_source_metadata(resource, source_scope_by_path)
    return {
        "id": f"graph-claim-{claim.id}",
        "title": resource.original_name,
        "location": _graph_evidence_location(claim.evidence) or format_source_display_location(metadata),
        "type": "知识图谱断言",
        "sourceTypeLabel": "知识图谱断言",
        "sourceOrigin": source_origin_label(metadata),
        "sourceScope": str(metadata.get("source_scope") or ""),
        "score": round(float(score), 3),
        "snippet": claim.text[:900],
        "retriever": "graph",
        "graphType": "claim",
        "claimId": str(claim.id),
        "resourceId": str(resource.id),
        "verified": bool(claim.verified),
        "schemaVersion": claim.schema_version,
    }


def _graph_entity_to_source(entity: KnowledgeGraphEntity, score: float, source_scope_by_path: dict[str, str]) -> dict:
    resource = entity.resource
    metadata = _graph_source_metadata(resource, source_scope_by_path)
    return {
        "id": f"graph-entity-{entity.id}",
        "title": resource.original_name,
        "location": _graph_locations_label(entity.source_locations) or format_source_display_location(metadata),
        "type": "知识图谱实体",
        "sourceTypeLabel": "知识图谱实体",
        "sourceOrigin": source_origin_label(metadata),
        "sourceScope": str(metadata.get("source_scope") or ""),
        "score": round(float(score), 3),
        "snippet": f"{entity.label}：{entity.summary}"[:900],
        "retriever": "graph",
        "graphType": "entity",
        "entityId": str(entity.id),
        "resourceId": str(resource.id),
        "schemaVersion": entity.schema_version,
    }


def _graph_relation_to_source(relation: KnowledgeGraphRelation, score: float, source_scope_by_path: dict[str, str]) -> dict:
    resource = relation.resource
    metadata = _graph_source_metadata(resource, source_scope_by_path)
    evidence_text = _graph_evidence_text(relation.evidence)
    relation_text = f"{relation.source_entity.label} {relation.label or relation.relation_type} {relation.target_entity.label}"
    return {
        "id": f"graph-relation-{relation.id}",
        "title": resource.original_name,
        "location": _graph_evidence_location(relation.evidence) or format_source_display_location(metadata),
        "type": "知识图谱关系",
        "sourceTypeLabel": "知识图谱关系",
        "sourceOrigin": source_origin_label(metadata),
        "sourceScope": str(metadata.get("source_scope") or ""),
        "score": round(float(score), 3),
        "snippet": (evidence_text or relation_text)[:900],
        "retriever": "graph",
        "graphType": "relation",
        "relationId": str(relation.id),
        "resourceId": str(resource.id),
        "schemaVersion": relation.schema_version,
    }


def _graph_source_metadata(resource: KnowledgeResource, source_scope_by_path: dict[str, str]) -> dict:
    resolved_path = str(Path(resource.stored_path).resolve()) if resource.stored_path else ""
    return {
        "source_path": resolved_path,
        "original_name": resource.original_name,
        "source_type": str(resource.file_type or "").lstrip(".") or "resource",
        "source_scope": resource.resource_scope or source_scope_by_path.get(resolved_path, ""),
        "resource_id": str(resource.id),
    }


def _graph_evidence_text(evidence: list | dict | str) -> str:
    if isinstance(evidence, str):
        return evidence
    if isinstance(evidence, dict):
        return str(evidence.get("text") or evidence.get("snippet") or evidence.get("quote") or "")
    if isinstance(evidence, list):
        return " ".join(_graph_evidence_text(item) for item in evidence[:3]).strip()
    return ""


def _graph_evidence_location(evidence: list | dict | str) -> str:
    items = evidence if isinstance(evidence, list) else [evidence]
    for item in items:
        if not isinstance(item, dict):
            continue
        page = item.get("page") or item.get("pageNumber")
        slide = item.get("slide") or item.get("slideNumber")
        if page:
            return f"page {page}"
        if slide:
            return f"slide {slide}"
    return ""


def _graph_locations_label(locations: list | dict | str) -> str:
    return _graph_evidence_location(locations)


def _classroom_query_terms(question: str) -> list[str]:
    raw = str(question or "").strip()
    terms: list[str] = []
    for ascii_token in re.findall(r"[A-Za-z0-9_]{2,}", raw.lower()):
        terms.append(ascii_token)
    for cjk in re.findall(r"[\u4e00-\u9fff]{2,}", raw):
        terms.append(cjk)
        for size in (4, 3, 2):
            if len(cjk) > size:
                terms.extend(cjk[index:index + size] for index in range(0, len(cjk) - size + 1))
    deduped = []
    for term in terms:
        if term not in deduped:
            deduped.append(term)
    return deduped[:24]


def _classroom_block_score(question: str, terms: list[str], block: KnowledgeBlock, resource: KnowledgeResource, resource_rank: int, *, reasoning_mode: str = "fast") -> float:
    text = f"{block.markdown or ''}\n{block.text or ''}".lower()
    title = str(resource.original_name or "").lower()
    score = 0.0
    for term in terms:
        normalized = term.lower()
        if not normalized:
            continue
        score += min(text.count(normalized), 6) * (2.0 if len(normalized) >= 3 else 1.0)
        if normalized in title:
            score += 2.5
    compact_question = re.sub(r"\s+", "", question.lower())
    if compact_question and compact_question in re.sub(r"\s+", "", text):
        score += 5.0
    if resource.resource_scope == "personal":
        score += 4.0
    elif resource.resource_scope in {"teacher", "class"}:
        score += 1.2
    if str(resource.file_type or "").lower() == ".pptx":
        score += 2.0
        if reasoning_mode == "deep":
            score += 1.0
    if reasoning_mode == "deep" and block.modality in {"table", "formula", "page_image", "slide_image"}:
        score += 1.0
    if block.modality in {"text", "table", "formula"}:
        score += 0.6
    if _looks_like_table_of_contents(text):
        score -= 8.0 if reasoning_mode == "deep" else 6.0
    if _looks_like_explanatory_block(text):
        score += 4.0 if reasoning_mode == "deep" else 3.0
    if resource_rank:
        score -= resource_rank * 0.35
    return score


def _looks_like_table_of_contents(text: str) -> bool:
    value = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    if not value:
        return False
    toc_markers = ("目录", "本章内容", "本章目录", "contents", "table of contents")
    has_toc_marker = any(marker in value for marker in toc_markers)
    if not has_toc_marker:
        return False
    bullet_like = len(re.findall(r"(?:^|\s)(?:[>•\-]|\d+[.、]|第[一二三四五六七八九十0-9]+[章节])", value))
    explanatory_markers = ("是指", "是", "定义", "例如", "包括", "用于", "通过", "因此", "所以", "原因", "特点")
    explanatory_hits = sum(1 for marker in explanatory_markers if marker in value)
    return bullet_like >= 3 and explanatory_hits <= 2


def _looks_like_explanatory_block(text: str) -> bool:
    value = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    if len(value) < 30:
        return False
    explanatory_markers = ("是指", "定义", "例如", "包括", "用于", "通过", "因此", "所以", "特点", "作用", "组成")
    hits = sum(1 for marker in explanatory_markers if marker in value)
    return hits >= 2


def _knowledge_block_to_source(block: KnowledgeBlock, index: int, score: float, source_scope_by_path: dict[str, str]) -> dict:
    resource = block.resource
    page = block.page
    resolved_path = str(Path(resource.stored_path).resolve()) if resource.stored_path else ""
    metadata = {
        "source_path": resolved_path,
        "original_name": resource.original_name,
        "source_type": str(resource.file_type or "").lstrip(".") or "resource",
        "source_scope": resource.resource_scope or source_scope_by_path.get(resolved_path, ""),
        "resource_id": str(resource.id),
        "block_id": str(block.id),
    }
    if page:
        if page.page_number:
            metadata["page_label"] = page.page_number
            metadata["page"] = page.page_number
        if page.slide_number:
            metadata["slide"] = page.slide_number
    source_type_label = format_source_type_label(metadata, fallback="本地资料")
    asset = _preview_asset_for_block(block)
    asset_payload = (
        {
            "assetId": str(asset.id),
            "kind": asset.kind,
            "previewUrl": f"/api/kb/assets/{asset.id}/preview/",
        }
        if asset
        else None
    )
    return {
        "id": f"kb-block-{index}",
        "title": resource.original_name,
        "location": format_source_display_location(metadata),
        "type": source_type_label,
        "sourceTypeLabel": source_type_label,
        "sourceOrigin": source_origin_label(metadata),
        "sourceScope": str(metadata.get("source_scope") or ""),
        "score": round(float(score), 3),
        "snippet": (block.markdown or block.text or "").strip()[:900],
        "asset": asset_payload,
        "previewUrl": asset_payload["previewUrl"] if asset_payload else "",
        "blockId": str(block.id),
        "resourceId": str(resource.id),
    }


def _preview_asset_for_block(block: KnowledgeBlock) -> KnowledgeAsset | None:
    if block.asset_id and block.asset:
        return block.asset
    if not block.page_id:
        return None
    preferred = KnowledgeAsset.objects.filter(
        page_id=block.page_id,
        kind__in=["rendered_slide", "rendered_page", "original"],
    ).order_by("created_at").first()
    if preferred:
        return preferred
    return KnowledgeAsset.objects.filter(page_id=block.page_id).order_by("created_at").first()


class StudentFollowupAgent(BaseAgent):
    name = "StudentFollowupAgent"
    role = "student follow-up"
    detail = "Verify student can resume the assigned learning action."

    def run(self, context: AgentContext) -> AgentResult:
        result = context.state.get("teacherTaskResult") if isinstance(context.state.get("teacherTaskResult"), dict) else {}
        action_url = str(context.state.get("teacherTaskActionUrl") or result.get("actionUrl") or "")
        created = int(result.get("createdNotifications") or 0)
        existing = int(result.get("existingNotifications") or 0)
        task_type = str(result.get("taskType") or context.payload.get("type") or "")
        available = created + existing
        return AgentResult(
            output={"studentFollowup": {"actionUrl": action_url, "createdNotifications": created, "existingNotifications": existing}},
            state_patch={"studentFollowupReady": bool(available and action_url)},
            input_summary={"taskType": task_type, "createdNotifications": created, "existingNotifications": existing},
            output_summary={"actionUrl": action_url, "studentCanResume": bool(available and action_url)},
            state_diff={"studentNextAction": action_url or "missing"},
            evidence={
                "taskType": task_type,
                "actionUrl": action_url,
                "createdNotifications": created,
                "existingNotifications": existing,
                "resumeSurface": "notifications",
            },
            quality={"studentCanResume": bool(available and action_url), "hasActionUrl": bool(action_url)},
            detail="Confirm teacher task has a student-facing resume action.",
        )


class QuestionGeneratorAgent(BaseAgent):
    name = "QuestionGeneratorAgent"
    role = "question generation"
    detail = "Generate candidate questions from knowledge-base evidence without fabricating fallback questions."
    max_retries = 0
    timeout_ms = 25000

    def run(self, context: AgentContext) -> AgentResult:
        job = context.payload["job"]
        job = run_question_generation_job(job)
        payload = serialize_question_generation_job(job)
        return AgentResult(
            output={"questionGenerationJob": payload},
            state_patch={"questionGenerationJobId": str(job.id), "questionGenerationStatus": job.status},
            input_summary={
                "jobId": str(job.id),
                "scope": job.scope,
                "requestedCount": job.requested_count,
                "resourceId": str(job.resource_id) if job.resource_id else "",
            },
            output_summary={
                "status": job.status,
                "generatedCount": job.generated_count,
                "verifiedCount": job.verified_count,
                "rejectedCount": job.rejected_count,
            },
            state_diff={"QuestionGenerationJob": job.status},
            evidence={
                "jobId": str(job.id),
                "resourceId": str(job.resource_id) if job.resource_id else "",
                "knowledgePointId": str(job.knowledge_point_id) if job.knowledge_point_id else "",
                "error": job.error,
            },
            quality={
                "noFakeQuestions": job.generated_count == Question.objects.filter(generation_job=job).count(),
                "failedWithoutFabrication": job.status != "failed" or job.generated_count == 0,
            },
            detail="Run question generation job and persist candidate questions only when evidence/model output is valid.",
        )


class QuestionVerifierAgent(BaseAgent):
    name = "QuestionVerifierAgent"
    role = "question verification"
    detail = "Summarize generated question quality checks and review readiness."
    max_retries = 0
    timeout_ms = 3000

    def run(self, context: AgentContext) -> AgentResult:
        job_id = str(context.state.get("questionGenerationJobId") or "")
        job = QuestionGenerationJob.objects.filter(id=job_id).first()
        questions = list(Question.objects.filter(generation_job=job).prefetch_related("quality_checks")) if job else []
        checks = list(QuestionQualityCheck.objects.filter(question__in=questions))
        passed = sum(1 for check in checks if check.passed)
        return AgentResult(
            output={"questionVerification": {"questionCount": len(questions), "qualityCheckCount": len(checks), "passed": passed}},
            state_patch={"questionVerificationReady": True},
            input_summary={"jobId": job_id, "questionCount": len(questions)},
            output_summary={"qualityCheckCount": len(checks), "passed": passed},
            state_diff={"QuestionQualityCheck": len(checks)},
            evidence={
                "questionIds": [str(question.id) for question in questions[:10]],
                "reviewStatuses": [question.review_status for question in questions[:10]],
            },
            quality={
                "allGeneratedChecked": len(questions) == 0 or len(checks) >= len(questions),
                "approvedForReview": passed,
            },
        )


class AdaptivePracticeAgent(BaseAgent):
    name = "AdaptivePracticeAgent"
    role = "adaptive practice selection"
    detail = "Record selected question sources, review state, and mastery signals before grading."
    max_retries = 0
    timeout_ms = 1500

    def run(self, context: AgentContext) -> AgentResult:
        session = context.payload["session"]
        question_ids = [str(item) for item in session.question_ids or []]
        questions = list(Question.objects.filter(id__in=question_ids).select_related("knowledge_point"))
        mastery_records = StudentQuestionMastery.objects.filter(
            user=context.user,
            knowledge_point_id__in=[question.knowledge_point_id for question in questions],
        ).count()
        source_counts: dict[str, int] = {}
        status_counts: dict[str, int] = {}
        for question in questions:
            source_counts[question.source_type] = source_counts.get(question.source_type, 0) + 1
            status_counts[question.review_status] = status_counts.get(question.review_status, 0) + 1
        return AgentResult(
            output={"adaptivePractice": {"questionCount": len(questions), "sourceCounts": source_counts, "reviewStatusCounts": status_counts}},
            state_patch={"adaptivePracticeReady": True},
            input_summary={"sessionId": str(session.id), "questionCount": len(question_ids)},
            output_summary={"sourceCounts": source_counts, "reviewStatusCounts": status_counts},
            state_diff={"AssessmentSession.question_ids": len(question_ids), "StudentQuestionMastery": mastery_records},
            evidence={
                "questionCount": len(questions),
                "masteryRecords": mastery_records,
                "sourceCounts": source_counts,
                "reviewStatusCounts": status_counts,
            },
            quality={
                "formalAssessmentUsesApproved": all(question.review_status == "approved" for question in questions)
                if getattr(session, "status", "") else True,
                "hasSelectableQuestions": bool(questions),
            },
        )


class AssessmentAgent(BaseAgent):
    name = "AssessmentAgent"
    role = "assessment grading"
    detail = "Grade answer and write wrong-question state."
    max_retries = 0
    timeout_ms = 2000

    def run(self, context: AgentContext) -> AgentResult:
        session = context.payload["session"]
        selected_answer = context.payload.get("selectedAnswer", "")
        skipped = bool(context.payload.get("skipped", False))
        result = answer_assessment_question(context.user, session, selected_answer, skipped)
        answered_question_id = ""
        result_session = result.get("session") if isinstance(result.get("session"), dict) else {}
        try:
            answered_index = max(0, int(result_session.get("currentIndex") or 1) - 1)
            answered_question_id = str((session.question_ids or [])[answered_index] or "")
        except (IndexError, TypeError, ValueError):
            answered_question_id = ""
        wrong_question_written = bool(
            answered_question_id
            and WrongQuestion.objects.filter(user=context.user, question_id=answered_question_id, mastered=False).exists()
        )
        remediation_writeback_ok = bool(result["isCorrect"] or wrong_question_written)
        return AgentResult(
            output={"assessmentResult": result, **result},
            state_patch={"assessmentResult": result, "wrongQuestionWritten": wrong_question_written},
            input_summary={
                "sessionId": str(session.id),
                "skipped": skipped,
                "answerProvided": bool(str(selected_answer).strip()),
            },
            output_summary={
                "isCorrect": result["isCorrect"],
                "sessionStatus": result["session"]["status"],
                "score": result["session"]["score"],
            },
            state_diff={
                "AssessmentSession": "advanced",
                "WrongQuestion": "written" if wrong_question_written else "unchanged",
            },
            evidence={
                "sessionId": str(session.id),
                "questionId": answered_question_id,
                "wrongQuestionWritten": wrong_question_written,
                "writeBackTarget": "wrong_notebook",
                "writeBackRequired": not result["isCorrect"],
            },
            quality={
                "wrongQuestionWriteBack": remediation_writeback_ok,
                "feedbackExplained": bool(result.get("explanation") or result.get("errorCause")),
            },
            detail="Grade submitted answer and advance assessment session.",
        )


class DiagnosticAgent(BaseAgent):
    name = "DiagnosticAgent"
    role = "admission diagnostic"
    detail = "Score admission diagnostic and update learner profile."
    max_retries = 0
    timeout_ms = 3500

    def run(self, context: AgentContext) -> AgentResult:
        result = submit_admission_diagnostic(context.user, context.payload)
        diagnostic = result.get("diagnostic") if isinstance(result.get("diagnostic"), dict) else {}
        weak_points = diagnostic.get("weakPoints") if isinstance(diagnostic.get("weakPoints"), list) else []
        answers = diagnostic.get("answers") if isinstance(diagnostic.get("answers"), list) else []
        return AgentResult(
            output={"diagnosticResult": result, **result},
            state_patch={
                "diagnosticResult": result,
                "diagnosticWeakPoints": weak_points,
                "diagnosticScore": diagnostic.get("score"),
            },
            input_summary={
                "answerCount": len(context.payload.get("answers") or []) if isinstance(context.payload.get("answers"), list) else 0,
                "durationDays": context.payload.get("durationDays"),
                "dailyMinutes": context.payload.get("dailyMinutes"),
            },
            output_summary={
                "score": diagnostic.get("score"),
                "level": (diagnostic.get("level") or {}).get("code") if isinstance(diagnostic.get("level"), dict) else "",
                "weakPoints": len(weak_points),
            },
            state_diff={
                "LearnerProfile": "updated",
                "extra_profile.admissionDiagnostic": "updated",
                "LearningPath": "refreshed",
                "studyPlan": "refreshed",
            },
            evidence={
                "questionCount": int(diagnostic.get("totalCount") or len(answers)),
                "correctCount": int(diagnostic.get("correctCount") or 0),
                "weakPointCount": len(weak_points),
                "score": int(diagnostic.get("score") or 0),
                "levelCode": (diagnostic.get("level") or {}).get("code") if isinstance(diagnostic.get("level"), dict) else "",
                "writeBackTarget": "admissionDiagnostic",
            },
            quality={
                "levelAssigned": bool((diagnostic.get("level") or {}).get("code")) if isinstance(diagnostic.get("level"), dict) else False,
                "profileWriteBack": True,
            },
            detail="Score diagnostic answers and persist admission diagnostic state.",
        )


class ProfileUpdateAgent(BaseAgent):
    name = "ProfileUpdateAgent"
    role = "profile update"
    detail = "Sync active wrong-question knowledge points to learner profile."

    def run(self, context: AgentContext) -> AgentResult:
        if context.workflow == "admission_diagnostic":
            result = context.state.get("diagnosticResult") if isinstance(context.state.get("diagnosticResult"), dict) else {}
            diagnostic = result.get("diagnostic") if isinstance(result.get("diagnostic"), dict) else {}
            profile = LearnerProfile.objects.get(user=context.user)
            weak_points = profile.weak_points if isinstance(profile.weak_points, list) else []
            append_profile_signal(
                profile,
                dimension="weakPoints",
                value=weak_points,
                source="admission_diagnostic",
                confidence=0.88,
                evidence={"score": diagnostic.get("score"), "level": diagnostic.get("level")},
                trace_id=str(context.state.get("traceId") or ""),
                weight=0.9,
                save=False,
            )
            aggregate_profile_snapshot(profile, save=True)
            return AgentResult(
                output={
                    "profileUpdate": {
                        "weakPoints": weak_points,
                        "foundationLevel": profile.foundation_level,
                        "dailyStudyTime": profile.daily_study_time,
                    }
                },
                state_patch={"profileUpdate": {"weakPoints": weak_points}},
                input_summary={
                    "diagnosticScore": diagnostic.get("score"),
                    "diagnosticWeakPoints": len(diagnostic.get("weakPoints") or []) if isinstance(diagnostic.get("weakPoints"), list) else 0,
                },
                output_summary={
                    "weakPoints": len(weak_points),
                    "foundationLevel": profile.foundation_level,
                    "dailyStudyTime": profile.daily_study_time,
                },
                state_diff={
                    "LearnerProfile.foundation_level": profile.foundation_level,
                    "LearnerProfile.daily_study_time": profile.daily_study_time,
                    "LearnerProfile.weak_points": len(weak_points),
                },
                evidence={
                    "weakPoints": weak_points,
                    "weakPointCount": len(weak_points),
                    "updateSource": "admission_diagnostic",
                },
                quality={"weakPointSync": bool(weak_points), "studyLoadSynced": bool(profile.daily_study_time)},
                detail="Confirm diagnostic signals were written back to learner profile.",
            )
        result = context.state.get("assessmentResult") or {}
        if result.get("isCorrect") and result.get("session", {}).get("status") != "completed":
            return AgentResult(
                output={"profileUpdate": None},
                state_patch={"profileUpdateSkipped": True},
                evidence={"profileUpdateRequired": False, "reason": "correct_answer"},
                quality={"weakPointSync": True},
                detail="Skip profile update because the answer was correct and produced no weak-point signal.",
            )
        profile_update = _sync_profile_weak_points_for_kernel(context.user)
        return AgentResult(
            output={"profileUpdate": profile_update},
            state_patch={"profileUpdate": profile_update},
            input_summary={
                "activeWrongQuestions": profile_update.get("extraProfile", {}).get("lastAssessmentSync", {}).get("activeWrongQuestions", 0),
            },
            output_summary={
                "weakPoints": len(profile_update.get("weakPoints") or []),
            },
            state_diff={
                "LearnerProfile.weak_points": len(profile_update.get("weakPoints") or []),
                "extra_profile.lastAssessmentSync": "updated",
            },
            evidence={
                "weakPoints": profile_update.get("weakPoints") or [],
                "weakPointCount": len(profile_update.get("weakPoints") or []),
                "updateSource": "wrong_question_sync",
            },
            quality={"weakPointSync": bool(profile_update.get("weakPoints"))},
        )


class ReviewSchedulerAgent(BaseAgent):
    name = "ReviewSchedulerAgent"
    role = "review scheduling"
    detail = "Summarize review pressure from active wrong questions before planning."

    def run(self, context: AgentContext) -> AgentResult:
        active_wrong = WrongQuestion.objects.filter(user=context.user, mastered=False).count()
        return AgentResult(
            output={"reviewSchedule": {"activeWrongQuestions": active_wrong}},
            state_patch={"reviewSchedule": {"activeWrongQuestions": active_wrong}},
            evidence={
                "activeWrongQuestions": active_wrong,
                "scheduleReason": "active_wrong_questions",
            },
            quality={"reviewPressureCaptured": active_wrong >= 0},
        )


class StudyPlanAgent(BaseAgent):
    name = "StudyPlanAgent"
    role = "study plan refresh"
    detail = "Refresh study plan from latest profile and wrong-question state."
    max_retries = 1
    timeout_ms = 4000

    def run(self, context: AgentContext) -> AgentResult:
        if context.workflow == "admission_diagnostic":
            result = context.state.get("diagnosticResult") if isinstance(context.state.get("diagnosticResult"), dict) else {}
            study_plan = result.get("plan") if isinstance(result.get("plan"), dict) else {}
            days = study_plan.get("days") if isinstance(study_plan.get("days"), list) else []
            today_tasks = len((days or [{}])[0].get("tasks", []))
            task_count = sum(len(day.get("tasks") or []) for day in days if isinstance(day, dict))
            return AgentResult(
                output={"studyPlan": study_plan},
                state_patch={"studyPlan": study_plan},
                input_summary={
                    "diagnosticScore": context.state.get("diagnosticScore"),
                    "weakPoints": len(context.state.get("diagnosticWeakPoints") or []),
                },
                output_summary={
                    "durationDays": study_plan.get("durationDays"),
                    "todayTasks": today_tasks,
                    "overallProgress": study_plan.get("overallProgress"),
                },
                state_diff={"studyPlan": "refreshed"},
                evidence={
                    "plannerInput": "diagnostic_path_and_profile",
                    "dayCount": len(days),
                    "taskCount": task_count,
                    "todayTaskCount": today_tasks,
                    "refreshReason": "admission_diagnostic",
                },
                quality={"planCreatedFromDiagnostic": bool(days), "hasTodayTasks": today_tasks > 0},
                detail="Confirm diagnostic-generated study plan is ready for daily execution.",
            )
        if context.workflow == "path_generate":
            study_plan = generate_study_plan(context.user, force=True)
            days = study_plan.get("days") if isinstance(study_plan.get("days"), list) else []
            today_tasks = len((days or [{}])[0].get("tasks", []))
            task_count = sum(len(day.get("tasks") or []) for day in days if isinstance(day, dict))
            return AgentResult(
                output={"studyPlan": study_plan},
                state_patch={"studyPlan": study_plan},
                input_summary={
                    "pathItems": context.state.get("pathItemCount", 0),
                    "force": True,
                },
                output_summary={
                    "durationDays": study_plan.get("durationDays"),
                    "todayTasks": today_tasks,
                    "overallProgress": study_plan.get("overallProgress"),
                },
                state_diff={"studyPlan": "refreshed"},
                evidence={
                    "plannerInput": "latest_learning_path",
                    "dayCount": len(days),
                    "taskCount": task_count,
                    "todayTaskCount": today_tasks,
                },
                quality={"planCreatedFromPath": bool(study_plan.get("days"))},
                detail="Refresh study plan after learning path generation.",
            )
        if context.workflow == "profile_setup":
            study_plan = generate_study_plan(context.user, duration_days=14, force=True)
            days = study_plan.get("days") if isinstance(study_plan.get("days"), list) else []
            today_tasks = len((days or [{}])[0].get("tasks", []))
            task_count = sum(len(day.get("tasks") or []) for day in days if isinstance(day, dict))
            return AgentResult(
                output={"studyPlan": study_plan, "studyPlanGenerated": bool(days)},
                state_patch={"studyPlan": study_plan, "studyPlanGenerated": bool(days)},
                input_summary={
                    "pathItems": context.state.get("pathItemCount", 0),
                    "durationDays": 14,
                },
                output_summary={
                    "durationDays": study_plan.get("durationDays"),
                    "todayTasks": today_tasks,
                    "overallProgress": study_plan.get("overallProgress"),
                },
                state_diff={"studyPlan": "generated"},
                evidence={
                    "plannerInput": "structured_profile_and_generated_path",
                    "dayCount": len(days),
                    "taskCount": task_count,
                    "todayTaskCount": today_tasks,
                    "refreshReason": "profile_setup",
                },
                quality={"studyPlanGenerated": bool(days), "hasTodayTasks": today_tasks > 0},
                detail="Generate a 14-day study plan immediately after structured profile setup.",
            )
        result = context.state.get("assessmentResult") or {}
        profile_update = context.state.get("profileUpdate")
        if profile_update is None and result.get("session", {}).get("status") != "completed":
            return AgentResult(
                output={"studyPlan": None, "report": None},
                state_patch={"studyPlanSkipped": True},
                evidence={"planRefreshRequired": False, "reason": "no_remediation_state_change"},
                quality={"planRefreshOnError": True},
                detail="Skip plan refresh because the answer did not change remediation state.",
            )
        study_plan = generate_study_plan(context.user, force=True)
        study_plan = merge_active_wrong_questions_into_review_queue(context.user, study_plan)
        report = build_learning_report(context.user) if result.get("session", {}).get("status") == "completed" else None
        days = study_plan.get("days") if isinstance(study_plan.get("days"), list) else []
        today_tasks = len((days or [{}])[0].get("tasks", []))
        task_count = sum(len(day.get("tasks") or []) for day in days if isinstance(day, dict))
        return AgentResult(
            output={"studyPlan": study_plan, "report": report},
            state_patch={"studyPlan": study_plan},
            input_summary={
                "force": True,
                "weakPoints": len((context.state.get("profileUpdate") or {}).get("weakPoints") or []),
            },
            output_summary={
                "durationDays": study_plan.get("durationDays"),
                "todayTasks": today_tasks,
            },
            state_diff={
                "studyPlan": "refreshed",
            },
            evidence={
                "plannerInput": "latest_wrong_questions_and_profile",
                "dayCount": len(days),
                "taskCount": task_count,
                "todayTaskCount": today_tasks,
                "refreshReason": "assessment_result_or_profile_update",
            },
            quality={"planRefreshOnError": bool(study_plan.get("days"))},
        )


def build_recommendation_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (LearningStateAgent(), RetrieverAgent(), RankerAgent(), VerifierAgent(), ResourcePackAgent()):
        kernel.register(agent)
    return kernel


def run_recommendation_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_recommendation_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    goal = str(payload.get("goal") or "personalized resource recommendation")
    return kernel.run(
        AgentContext(user=user, workflow="recommend", goal=goal, payload=payload),
        RECOMMEND_WORKFLOW_SEQUENCE,
    )


def build_qa_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (SafetyAgent(), RetrieverAgent(), TeacherAgent(), VerifierAgent(), FollowUpAgent()):
        kernel.register(agent)
    return kernel


def run_qa_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_qa_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    question = str(payload.get("question") or "")
    return kernel.run(
        AgentContext(user=user, workflow="qa_interact", goal=question, payload=payload),
        QA_WORKFLOW_SEQUENCE,
    )


def build_assessment_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (AdaptivePracticeAgent(), AssessmentAgent(), ProfileUpdateAgent(), ReviewSchedulerAgent(), StudyPlanAgent()):
        kernel.register(agent)
    return kernel


def build_question_bank_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (QuestionGeneratorAgent(), QuestionVerifierAgent()):
        kernel.register(agent)
    return kernel


def build_admission_diagnostic_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (DiagnosticAgent(), ProfileUpdateAgent(), PlannerAgent(), StudyPlanAgent()):
        kernel.register(agent)
    return kernel


def build_teacher_task_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (TeacherWorkbenchAgent(), NotificationAgent(), StudentFollowupAgent()):
        kernel.register(agent)
    return kernel


def run_teacher_task_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_teacher_task_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    task_type = str(payload.get("type") or "")
    return kernel.run(
        AgentContext(user=user, workflow="teacher_task_execute", goal=f"execute teacher task {task_type}", payload=payload),
        TEACHER_TASK_WORKFLOW_SEQUENCE,
    )


def run_admission_diagnostic_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_admission_diagnostic_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    goal = str(payload.get("goal") or "admission diagnostic")
    return kernel.run(
        AgentContext(user=user, workflow="admission_diagnostic", goal=goal, payload=payload),
        ADMISSION_DIAGNOSTIC_WORKFLOW_SEQUENCE,
    )


def run_assess_grade_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_assessment_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    session = payload.get("session")
    goal = f"grade assessment session {getattr(session, 'id', '')}"
    return kernel.run(
        AgentContext(user=user, workflow="assess_grade", goal=goal, payload=payload),
        ASSESS_GRADE_WORKFLOW_SEQUENCE,
    )


def run_question_generation_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_question_bank_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    job = payload.get("job")
    goal = f"generate question candidates {getattr(job, 'id', '')}"
    return kernel.run(
        AgentContext(user=user, workflow="question_bank_generate", goal=goal, payload=payload),
        QUESTION_BANK_WORKFLOW_SEQUENCE,
    )


def build_profile_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (SafetyAgent(), ProfileAgent(), MemoryAgent()):
        kernel.register(agent)
    return kernel


def build_profile_setup_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (ProfileNormalizeAgent(), ProfileCommitAgent(), PlannerAgent(), StudyPlanAgent()):
        kernel.register(agent)
    return kernel


def run_profile_extract_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_profile_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    text = str(payload.get("text") or "")
    return kernel.run(
        AgentContext(user=user, workflow="profile_extract", goal="extract learner profile", payload={"text": text}),
        PROFILE_EXTRACT_WORKFLOW_SEQUENCE,
    )


def run_profile_setup_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_profile_setup_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    return kernel.run(
        AgentContext(user=user, workflow="profile_setup", goal="setup structured learner profile", payload=payload),
        PROFILE_SETUP_WORKFLOW_SEQUENCE,
    )


def build_path_generate_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (LearningStateAgent(), PlannerAgent(), GraphAgent(), StudyPlanAgent()):
        kernel.register(agent)
    return kernel


def run_path_generate_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_path_generate_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    course = payload.get("course")
    goal = f"generate learning path for {getattr(course, 'code', '') or 'active course'}"
    return kernel.run(
        AgentContext(user=user, workflow="path_generate", goal=goal, payload=payload),
        PATH_GENERATE_WORKFLOW_SEQUENCE,
    )


def build_verify_answer_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (SafetyAgent(), ClaimExtractorAgent(), VerifierAgent()):
        kernel.register(agent)
    return kernel


def run_verify_answer_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_verify_answer_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    question = str(payload.get("question") or "")
    return kernel.run(
        AgentContext(user=user, workflow="verify_answer", goal=question, payload=payload),
        VERIFY_ANSWER_WORKFLOW_SEQUENCE,
    )


def build_recent_run_circuit_breaker(user, *, limit: int | None = None, min_samples: int | None = None, open_threshold: float | None = None):
    limit = int(limit if limit is not None else getattr(settings, "A3_AGENT_CIRCUIT_RECENT_LIMIT", 12))
    min_samples = int(min_samples if min_samples is not None else getattr(settings, "A3_AGENT_CIRCUIT_MIN_SAMPLES", 3))
    open_threshold = float(open_threshold if open_threshold is not None else getattr(settings, "A3_AGENT_CIRCUIT_OPEN_THRESHOLD", 0.5))
    runs = recent_agent_runs(user, limit=limit)
    agent_stats: dict[str, dict] = {}
    workflow_stats: dict[str, dict] = {}
    for run in runs:
        if not isinstance(run, dict):
            continue
        workflow = str(run.get("workflow") or "")
        if workflow:
            workflow_item = workflow_stats.setdefault(workflow, {"workflow": workflow, "runs": 0, "failedRuns": 0})
            workflow_item["runs"] += 1
            if str(run.get("status") or "") == "failed":
                workflow_item["failedRuns"] += 1
        steps = run.get("steps") if isinstance(run.get("steps"), list) else []
        for step in steps:
            if not isinstance(step, dict):
                continue
            agent_name = str(step.get("name") or "")
            if not workflow or not agent_name:
                continue
            key = f"{workflow}:{agent_name}"
            stats = agent_stats.setdefault(key, {"workflow": workflow, "agent": agent_name, "steps": 0, "failedSteps": 0})
            stats["steps"] += 1
            if str(step.get("status") or "completed") == "failed":
                stats["failedSteps"] += 1

    def policy(context: AgentContext, agent: BaseAgent) -> dict:
        key = f"{context.workflow}:{agent.name}"
        stats = agent_stats.get(key)
        if not stats:
            workflow_item = workflow_stats.get(context.workflow)
            if not workflow_item:
                return {"open": False}
            runs_count = int(workflow_item["runs"])
            failed_runs = int(workflow_item["failedRuns"])
            workflow_failure_rate = round(failed_runs / runs_count, 3) if runs_count else 0.0
            workflow_open = runs_count >= int(min_samples) and workflow_failure_rate >= float(open_threshold)
            return {
                "open": workflow_open,
                "reason": "workflow_failure_rate" if workflow_open else "healthy",
                "workflow": workflow_item["workflow"],
                "agent": agent.name,
                "runs": runs_count,
                "failedRuns": failed_runs,
                "failureRate": workflow_failure_rate,
            }
        steps = int(stats["steps"])
        failed = int(stats["failedSteps"])
        failure_rate = round(failed / steps, 3) if steps else 0.0
        open_circuit = steps >= int(min_samples) and failure_rate >= float(open_threshold)
        if not open_circuit:
            workflow_item = workflow_stats.get(context.workflow)
            if workflow_item:
                runs_count = int(workflow_item["runs"])
                failed_runs = int(workflow_item["failedRuns"])
                workflow_failure_rate = round(failed_runs / runs_count, 3) if runs_count else 0.0
                workflow_open = runs_count >= int(min_samples) and workflow_failure_rate >= float(open_threshold)
                if workflow_open:
                    return {
                        "open": True,
                        "reason": "workflow_failure_rate",
                        "workflow": workflow_item["workflow"],
                        "agent": agent.name,
                        "runs": runs_count,
                        "failedRuns": failed_runs,
                        "failureRate": workflow_failure_rate,
                    }
        return {
            "open": open_circuit,
            "reason": "agent_failure_rate" if open_circuit else "healthy",
            "workflow": stats["workflow"],
            "agent": stats["agent"],
            "steps": steps,
            "failedSteps": failed,
            "failureRate": failure_rate,
        }

    return policy


def _runtime_policy_for_agent(agent: BaseAgent) -> dict:
    policies = getattr(settings, "A3_AGENT_RUNTIME_POLICIES", {})
    configured = policies.get(agent.name) if isinstance(policies, dict) else None
    if not isinstance(configured, dict):
        configured = {}
    max_retries = configured.get("maxRetries", getattr(agent, "max_retries", 0))
    timeout_ms = configured.get("timeoutMs", getattr(agent, "timeout_ms", None))
    return {
        "maxRetries": max(0, int(max_retries or 0)),
        "timeoutMs": None if timeout_ms is None else int(timeout_ms),
        "attempts": 0,
        "errors": [],
        "timedOut": False,
        "elapsedMs": 0,
    }


def _profile_snapshot_for_llm(user) -> dict:
    profile = getattr(user, "learner_profile", None)
    if profile is None:
        return {}
    return {
        "grade": profile.grade,
        "majorDirection": profile.major_direction,
        "foundationLevel": profile.foundation_level,
        "dailyStudyTime": profile.daily_study_time,
        "pace": profile.pace,
        "learningGoals": profile.learning_goals if isinstance(profile.learning_goals, list) else [],
        "weakPoints": profile.weak_points if isinstance(profile.weak_points, list) else [],
        "expectedResources": profile.expected_resources if isinstance(profile.expected_resources, list) else [],
    }


def _claim_support_rate_for_kernel(claims: list[dict]) -> float:
    if not claims:
        return 0.0
    verified = sum(1 for claim in claims if isinstance(claim, dict) and claim.get("verified"))
    return round(verified / len(claims), 3)


def _validate_workflow_output_contract(workflow: str, output: dict) -> str:
    contract = get_agent_workflow_contract(workflow)
    if contract is None:
        return ""
    output_schema = contract.output_schema if isinstance(contract.output_schema, dict) else {}
    errors = _validate_schema_node(output, output_schema, "")
    if not errors:
        return ""
    return f"Workflow {workflow} contract violation: {'; '.join(errors)}"


def _validate_agent_output_schema(agent: BaseAgent, output: dict) -> dict:
    schema = getattr(agent, "output_schema", {}) or {}
    schema_version = str(getattr(agent, "output_schema_version", "") or "a3.agent-output.v1")
    if not isinstance(schema, dict) or not schema:
        return {"schemaVersion": schema_version, "valid": True, "errors": [], "mode": "default"}
    errors = _validate_schema_node(output, schema, "")
    return {
        "schemaVersion": schema_version,
        "valid": not errors,
        "errors": errors,
        "mode": "agent_output",
    }


def _validate_schema_node(value, schema: dict, path: str) -> list[str]:
    if not isinstance(schema, dict):
        return []
    errors: list[str] = []
    expected_type = str(schema.get("type") or "").strip()
    label = path or "output"
    if expected_type and not _matches_json_schema_type(value, expected_type):
        return [f"{label} expected {expected_type}"]

    if expected_type == "object" or isinstance(value, dict):
        if not isinstance(value, dict):
            return errors
        required = schema.get("required") if isinstance(schema.get("required"), list) else []
        missing = [field for field in required if field not in value or value.get(field) is None]
        if missing:
            if path:
                errors.append(f"{path} missing required fields: {', '.join(str(field) for field in missing)}")
            else:
                errors.append(f"missing required output fields: {', '.join(str(field) for field in missing)}")
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        for field, child_schema in properties.items():
            if field not in value or value.get(field) is None:
                continue
            child_path = f"{path}.{field}" if path else str(field)
            errors.extend(_validate_schema_node(value[field], child_schema, child_path))
        return errors

    if expected_type == "array" or isinstance(value, list):
        if not isinstance(value, list):
            return errors
        item_schema = schema.get("items") if isinstance(schema.get("items"), dict) else None
        if item_schema:
            for index, item in enumerate(value):
                errors.extend(_validate_schema_node(item, item_schema, f"{path}[{index}]"))
    return errors


def _matches_json_schema_type(value, expected_type: str) -> bool:
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _sync_profile_weak_points_for_kernel(user) -> dict:
    wrong_items = list(
        WrongQuestion.objects.filter(user=user, mastered=False)
        .select_related("question__knowledge_point")
        .order_by("-wrong_count", "-last_wrong_at")[:8]
    )
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    raw_weak_points = profile.weak_points if isinstance(profile.weak_points, list) else []
    existing = [str(item).strip() for item in raw_weak_points if str(item).strip()]
    updated = list(existing)
    for wrong in wrong_items:
        title = wrong.question.knowledge_point.title
        if title not in updated:
            updated.append(title)
    profile.weak_points = updated[:8]
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    extra_profile["lastAssessmentSync"] = {
        "activeWrongQuestions": len(wrong_items),
        "source": "api_assess_grade",
    }
    profile.extra_profile = extra_profile
    append_profile_signal(
        profile,
        dimension="weakPoints",
        value=updated[:8],
        source="wrong_question_sync",
        confidence=0.9 if wrong_items else 0.4,
        evidence={"activeWrongQuestions": len(wrong_items)},
        weight=0.95,
        save=False,
    )
    append_profile_signal(
        profile,
        dimension="mistakePatterns",
        value=_mistake_patterns_from_wrong_questions(wrong_items),
        source="assessment_wrong_answer",
        confidence=0.85,
        evidence={"activeWrongQuestions": len(wrong_items)},
        weight=0.9,
        save=False,
    )
    snapshot = aggregate_profile_snapshot(profile, save=False)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    extra_profile["profileSnapshot"] = snapshot
    extra_profile["dynamicProfileV2"] = snapshot
    profile.extra_profile = extra_profile
    profile.save(update_fields=["weak_points", "extra_profile", "updated_at"])
    return {
        "weakPoints": profile.weak_points,
        "extraProfile": profile.extra_profile,
    }


def _mistake_patterns_from_wrong_questions(wrong_items: list[WrongQuestion]) -> list[str]:
    patterns: list[str] = []
    for wrong in wrong_items:
        question = getattr(wrong, "question", None)
        candidates = [
            getattr(question, "error_cause", "") if question is not None else "",
        ]
        for candidate in candidates:
            text = str(candidate or "").strip()[:160]
            if text and text not in patterns:
                patterns.append(text)
                break
        if len(patterns) >= 8:
            break
    return patterns
