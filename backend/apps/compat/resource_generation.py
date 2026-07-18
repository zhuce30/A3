from __future__ import annotations

import json
import os
import sys
from datetime import timedelta
from urllib.parse import quote
from uuid import uuid4

from django.utils import timezone

from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent, build_recent_run_circuit_breaker
from backend.apps.compat.llm import LLMUnavailable, chat_completion
from backend.apps.compat.models import OpenMAICArtifact
from backend.apps.compat.verification import verify_answer
from backend.apps.learning.effect_events import aggregate_learning_events, record_learning_event
from backend.apps.learning.effect_metrics import build_learning_effect_metrics
from backend.apps.learning.models import ResourcePackLog
from backend.apps.learning.plan_policy import apply_plan_adjustment_to_study_plan, build_plan_adjustment_from_analysis
from backend.apps.learning.services import classroom_context, current_study_plan, generate_study_plan
from backend.apps.profiles.models import LearnerProfile
from backend.domains.knowledge_base.retriever import search_knowledge_base


RESOURCE_TYPES = (
    "lecture_doc",
    "knowledge_card",
    "mind_map",
    "practice_set",
    "case_study",
    "code_lab",
    "micro_video_script",
)

OPENMAIC_ARTIFACT_TYPES = {"openmaic_classroom", "openmaic_video", "openmaic_pptx_export"}

RESOURCE_CONTENT_SCHEMA_VERSION = "a3.resource-content.rich.v1"
RESOURCE_PACK_PROFILE_SNAPSHOT_FIELDS = (
    "id",
    "grade",
    "majorDirection",
    "foundationLevel",
    "dailyStudyTime",
    "pace",
    "learningGoals",
    "weakPoints",
    "learningPreferences",
    "expectedResources",
    "resourcePreferences",
    "dimensionCount",
)

RESOURCE_GENERATE_WORKFLOW_SEQUENCE = [
    "RetrieverAgent",
    "PedagogyAgent",
    "ResourceSynthesisAgent",
    "PracticeGenerationAgent",
    "VerifierAgent",
    "ResourcePackCommitAgent",
]

RESOURCE_FEEDBACK_WORKFLOW_SEQUENCE = [
    "ResourceFeedbackAgent",
    "LearningEffectAgent",
    "LearningEffectAnalyzerAgent",
    "StudyPlanAgent",
    "MemoryCommitAgent",
]

LEARNING_EFFECT_ANALYSIS_WORKFLOW_SEQUENCE = [
    "LearningEffectAnalyzerAgent",
    "LearningEffectMemoryCommitAgent",
]

OPENMAIC_CLASSROOM_BRIDGE_WORKFLOW_SEQUENCE = ["A3ResourceBridgeAgent", "ResourcePackCommitAgent"]
OPENMAIC_VIDEO_BRIDGE_WORKFLOW_SEQUENCE = ["A3VideoBridgeAgent", "ResourcePackCommitAgent"]
OPENMAIC_PPTX_EXPORT_BRIDGE_WORKFLOW_SEQUENCE = ["A3PPTXExportBridgeAgent", "ResourcePackCommitAgent"]
OPENMAIC_INTERACTION_BRIDGE_WORKFLOW_SEQUENCE = ["A3OpenMAICInteractionBridgeAgent", "ProfileAgent"]


RESOURCE_TYPE_LABELS = {
    "lecture_doc": "课程讲解文档",
    "knowledge_card": "知识点速记卡",
    "mind_map": "知识点思维导图",
    "practice_set": "专项练习题",
    "case_study": "工程实践案例",
    "code_lab": "代码类实操案例",
    "micro_video_script": "短视频/动画脚本",
}


def _requested_resource_type(payload: dict) -> str:
    resource_type = str(payload.get("resourceType") or payload.get("resource_type") or "").strip()
    if not resource_type:
        return ""
    if resource_type not in RESOURCE_TYPES:
        raise ValueError(f"resourceType 必须是以下类型之一：{', '.join(RESOURCE_TYPES)}")
    return resource_type


def _requested_resource_types(payload: dict) -> list[str]:
    resource_type = _requested_resource_type(payload)
    return [resource_type] if resource_type else list(RESOURCE_TYPES)


class ResourceRetrieverAgent(BaseAgent):
    name = "RetrieverAgent"
    role = "knowledge retrieval"
    detail = "Retrieve grounded sources for personalized multimodal resource generation."
    max_retries = 1
    timeout_ms = 3000
    output_schema = {
        "type": "object",
        "properties": {
            "resolvedGoal": {"type": "string"},
            "resourceSources": {"type": "array"},
            "profileSnapshot": {"type": "object"},
            "profileDimensionCount": {"type": "integer"},
        },
        "required": ["resolvedGoal", "resourceSources"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        profile = LearnerProfile.objects.filter(user=context.user).first()
        classroom = classroom_context(context.user)
        target = classroom.get("target") if isinstance(classroom.get("target"), dict) else {}
        resolved_goal = str(context.payload.get("goal") or target.get("title") or "褰撳墠瀛︿範鐩爣").strip()
        top_k = max(6, int(context.payload.get("topK") or 6))
        sources = _search_resource_sources(resolved_goal, top_k=top_k, fallback_sources=classroom.get("sources") or [])
        return AgentResult(
            output={
                "resolvedGoal": resolved_goal,
                "resourceSources": sources,
                "profileSnapshot": _profile_snapshot(profile),
                "profileDimensionCount": _profile_dimension_count(profile),
            },
            state_patch={"profile": profile, "topK": top_k},
            input_summary={"goal": resolved_goal, "topK": top_k},
            output_summary={"sourceCount": len(sources), "profileDimensionCount": _profile_dimension_count(profile)},
            state_diff={"resourceSources": len(sources), "profile": "loaded" if profile else "missing", "topK": top_k},
            evidence={"retrievalMode": "resource_generation_rag", "sourceCount": len(sources), "topK": top_k},
            quality={"grounded": bool(sources), "fallbackUsed": bool(sources and sources[0].get("id") == "learning-state")},
        )

    def fallback(self, context: AgentContext, error: Exception) -> AgentResult:
        fallback_goal = str(context.payload.get("goal") or context.goal or "褰撳墠瀛︿範鐩爣").strip()
        sources = _search_resource_sources(fallback_goal, top_k=1, fallback_sources=[])
        return AgentResult(
            output={
                "resolvedGoal": fallback_goal,
                "resourceSources": sources,
                "profileSnapshot": {},
                "profileDimensionCount": 0,
            },
            input_summary={"goal": fallback_goal},
            output_summary={"sourceCount": len(sources), "fallback": True},
            evidence={"retrievalMode": "resource_generation_goal_fallback", "reason": str(error)},
            quality={"grounded": bool(sources), "fallbackUsed": True},
            detail="Use current goal as fallback evidence when resource retrieval fails.",
        )


class PedagogyAgent(BaseAgent):
    name = "PedagogyAgent"
    role = "learning design"
    detail = "Select resource strategy from learner profile, weak points, and source evidence."
    output_schema = {
        "type": "object",
        "properties": {"resourceStrategy": {"type": "object"}},
        "required": ["resourceStrategy"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        profile = context.state.get("profile")
        expected = getattr(profile, "expected_resources", None) if profile is not None else []
        weak_points = getattr(profile, "weak_points", None) if profile is not None else []
        strategy = {
            "schemaVersion": "a3.resource-strategy.v1",
            "goal": context.state.get("resolvedGoal") or context.goal,
            "resourceTypes": _requested_resource_types(context.payload),
            "weakPoints": list(weak_points or [])[:5],
            "preferredFormats": list(expected or [])[:5],
            "agentRoles": {
                "RetrieverAgent": "source grounding",
                "PedagogyAgent": "learning design",
                "ResourceSynthesisAgent": "multimodal generation",
                "PracticeGenerationAgent": "practice and code lab readiness",
                "VerifierAgent": "citation and safety verification",
                "ResourcePackCommitAgent": "state writeback",
            },
        }
        return AgentResult(
            output={"resourceStrategy": strategy},
            input_summary={
                "profileDimensions": context.state.get("profileDimensionCount", 0),
                "sourceCount": len(context.state.get("resourceSources") or []),
            },
            output_summary={"resourceTypes": len(RESOURCE_TYPES), "weakPoints": len(strategy["weakPoints"])},
            evidence={"profileDimensions": context.state.get("profileDimensionCount", 0), "sourceCount": len(context.state.get("resourceSources") or [])},
            quality={"personalized": bool(context.state.get("profileDimensionCount"))},
        )


class ResourceSynthesisAgent(BaseAgent):
    name = "ResourceSynthesisAgent"
    role = "resource synthesis"
    detail = "Generate required personalized resource types from strategy and citations."
    max_retries = 1
    timeout_ms = 120000
    output_schema = {
        "type": "object",
        "properties": {"resources": {"type": "array"}},
        "required": ["resources"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        goal = str(context.state.get("resolvedGoal") or context.goal or "")
        profile = context.state.get("profile")
        sources = context.state.get("resourceSources") if isinstance(context.state.get("resourceSources"), list) else []
        requested_types = _requested_resource_types(context.payload)
        allow_llm = _resource_llm_enabled(full_pack=len(requested_types) > 1)
        resources = [_build_resource_item(kind, goal, profile, sources, allow_llm=allow_llm) for kind in requested_types]
        synthesis_runs = [item.get("synthesis") for item in resources if isinstance(item.get("synthesis"), dict)]
        llm_count = len([item for item in synthesis_runs if item.get("mode") == "llm"])
        degraded_count = len([item for item in synthesis_runs if item.get("degraded")])
        return AgentResult(
            output={"resources": resources},
            output_summary={"resourceTypes": [item["type"] for item in resources], "llmEnhanced": llm_count, "degraded": degraded_count},
            evidence={
                "resourceCount": len(resources),
                "citationCount": sum(len(item["citations"]) for item in resources),
                "contentSchemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
                "llmEnhanced": llm_count,
                "degraded": degraded_count,
                "sourceCount": len(sources),
            },
            quality={"coversRequiredSevenTypes": len({item["type"] for item in resources}) == 7},
        )


class PracticeGenerationAgent(BaseAgent):
    name = "PracticeGenerationAgent"
    role = "practice generation"
    detail = "Verify practice, assessment, and code-lab entries are independently available."
    output_schema = {
        "type": "object",
        "properties": {"practiceReadiness": {"type": "object"}},
        "required": ["practiceReadiness"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        resources = context.state.get("resources") if isinstance(context.state.get("resources"), list) else []
        resource_types = {item.get("type") for item in resources if isinstance(item, dict)}
        goal = str(context.state.get("resolvedGoal") or "")
        readiness = {
            "schemaVersion": "a3.resource-practice-readiness.v1",
            "practiceSetIncluded": "practice_set" in resource_types,
            "codeLabIncluded": "code_lab" in resource_types,
            "assessmentHref": f"/a3/assessment?practice={quote(goal)}",
        }
        return AgentResult(
            output={"practiceReadiness": readiness},
            output_summary=readiness,
            evidence={"practiceSetIncluded": readiness["practiceSetIncluded"], "codeLabIncluded": readiness["codeLabIncluded"]},
            quality={"practiceReady": readiness["practiceSetIncluded"], "codeLabReady": readiness["codeLabIncluded"]},
        )


class ResourceVerifierAgent(BaseAgent):
    name = "VerifierAgent"
    role = "resource verification"
    detail = "Validate citation coverage and safety status for generated resources."
    output_schema = {
        "type": "object",
        "properties": {"resourceVerification": {"type": "object"}},
        "required": ["resourceVerification"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        resources = context.state.get("resources") if isinstance(context.state.get("resources"), list) else []
        verified_count = len([item for item in resources if isinstance(item, dict) and item.get("verified")])
        citation_count = sum(len(item.get("citations") or []) for item in resources if isinstance(item, dict))
        verification = {
            "schemaVersion": "a3.resource-verification.v1",
            "verifiedResourceCount": verified_count,
            "resourceCount": len(resources),
            "citationCount": citation_count,
            "verified": bool(resources) and verified_count == len(resources),
        }
        return AgentResult(
            output={"resourceVerification": verification},
            output_summary=verification,
            evidence={"verifiedResourceCount": verified_count, "citationCount": citation_count},
            quality={"verified": verification["verified"], "citationCoverage": 1 if resources and citation_count else 0},
        )


class ResourcePackCommitAgent(BaseAgent):
    name = "ResourcePackCommitAgent"
    role = "state commit"
    detail = "Persist resource pack and learning event into learner state."
    output_schema = {
        "type": "object",
        "properties": {
            "resourcePack": {"type": "object"},
            "resourcePackId": {"type": "string"},
        },
        "required": ["resourcePack", "resourcePackId"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        goal = str(context.state.get("resolvedGoal") or context.goal or "褰撳墠瀛︿範鐩爣").strip()
        profile = context.state.get("profile")
        resources = context.state.get("resources") if isinstance(context.state.get("resources"), list) else []
        pack_id = uuid4().hex
        requested_type = _requested_resource_type(context.payload)
        pack = {
            "schemaVersion": "a3.resource-pack.v2",
            "resourcePackId": pack_id,
            "generationMode": "single" if requested_type else "full",
            "requestedResourceType": requested_type,
            "goal": goal,
            "learnerProfileSnapshot": _profile_snapshot(profile),
            "resourceStrategy": context.state.get("resourceStrategy") or {},
            "practiceReadiness": context.state.get("practiceReadiness") or {},
            "resourceVerification": context.state.get("resourceVerification") or {},
            "resources": resources,
            "nextActions": _resource_pack_next_actions(goal),
            "traceId": str(context.state.get("traceId") or ""),
            "createdAt": timezone.now().isoformat(),
        }
        _store_resource_pack(context.user, pack)
        return AgentResult(
            output={"resourcePack": pack, "resourcePackId": pack_id},
            output_summary={"resourcePackId": pack_id, "resourceCount": len(resources)},
            state_diff={"LearnerProfile.extra_profile.resourcePacks": "appended", "ResourcePackLog": "upserted"},
            evidence={"traceId": pack["traceId"], "resourcePackId": pack_id},
            quality={"committed": True, "schemaVersion": pack["schemaVersion"]},
        )


def build_resource_generate_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (
        ResourceRetrieverAgent(),
        PedagogyAgent(),
        ResourceSynthesisAgent(),
        PracticeGenerationAgent(),
        ResourceVerifierAgent(),
        ResourcePackCommitAgent(),
    ):
        kernel.register(agent)
    return kernel


def run_resource_generate_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or build_resource_generate_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    goal = str(payload.get("goal") or "鐢熸垚涓€у寲澶氭ā鎬佽祫婧愬寘")
    return kernel.run(
        AgentContext(user=user, workflow="resource_generate", goal=goal, payload=payload),
        RESOURCE_GENERATE_WORKFLOW_SEQUENCE,
    )


class ResourceFeedbackAgent(BaseAgent):
    name = "ResourceFeedbackAgent"
    role = "resource usage feedback"
    detail = "Persist resource usage feedback as a learner event."
    output_schema = {
        "type": "object",
        "properties": {"feedback": {"type": "object"}},
        "required": ["feedback"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        pack = context.payload.get("pack") if isinstance(context.payload.get("pack"), dict) else {}
        pack_id = str(context.payload.get("packId") or pack.get("resourcePackId") or "")
        action = str(context.payload.get("action") or "").strip()
        feedback = {
            "packId": pack_id,
            "goal": pack.get("goal") or "",
            "action": action,
            "resourceType": str(context.payload.get("resourceType") or ""),
            "score": _resource_feedback_score(context.payload.get("score")),
            "createdAt": timezone.now().isoformat(),
        }
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        extra = dict(profile.extra_profile or {})
        feedbacks = [item for item in extra.get("resourceFeedback", []) if isinstance(item, dict)]
        feedbacks.insert(0, feedback)
        extra["resourceFeedback"] = feedbacks[:100]
        _append_learning_event(
            extra,
            "resource_feedback",
            f"{action}: {pack.get('goal')}",
            {"resourceType": feedback["resourceType"], "action": action, "score": feedback["score"]},
        )
        try:
            from backend.apps.profiles.profile_updates import create_profile_update_candidates_from_event

            profile.extra_profile = extra
            create_profile_update_candidates_from_event(
                profile,
                event_type="resource_feedback",
                source="resource_feedback",
                signals={"resourceType": feedback["resourceType"], "action": action, "score": feedback["score"]},
                evidence={"packId": pack_id, "goal": feedback["goal"]},
                save=False,
            )
            extra = dict(profile.extra_profile or {})
        except Exception:
            pass
        try:
            record_learning_event(
                context.user,
                event_type=f"resource_{action}",
                target_type="resource_pack",
                target_id=pack_id,
                resource_type=feedback["resourceType"],
                score=feedback["score"],
                metadata={
                    "goal": feedback["goal"],
                    "action": action,
                    "resourcePackId": pack_id,
                },
                trace_id=str(context.state.get("traceId") or ""),
            )
        except Exception:
            pass
        profile.extra_profile = extra
        profile.save(update_fields=["extra_profile", "updated_at"])
        return AgentResult(
            output={"feedback": feedback},
            state_patch={"feedback": feedback},
            input_summary={
                "packId": pack_id,
                "goal": feedback["goal"],
                "action": action,
                "resourceType": feedback["resourceType"],
                "score": feedback["score"],
            },
            output_summary={"feedbackPersisted": True, "totalFeedback": len(extra["resourceFeedback"])},
            state_diff={"LearnerProfile.extra_profile.resourceFeedback": "prepended"},
            evidence={"totalFeedback": len(extra["resourceFeedback"])},
            quality={"schemaVersion": "a3.resource-feedback.v1", "feedbackPersisted": True},
        )


class LearningEffectAgent(BaseAgent):
    name = "LearningEffectAgent"
    role = "learning effect evaluation"
    detail = "Evaluate learning effect from resource feedback and plan progress."
    output_schema = {
        "type": "object",
        "properties": {"effectReport": {"type": "object"}},
        "required": ["effectReport"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        effect_report = build_learning_effect_report(context.user)
        adjustment = effect_report.get("planAdjustment") if isinstance(effect_report.get("planAdjustment"), dict) else {}
        adjustment_evidence = adjustment.get("evidence") if isinstance(adjustment.get("evidence"), dict) else {}
        return AgentResult(
            output={"effectReport": effect_report},
            state_patch={"effectReport": effect_report},
            output_summary={
                "strategy": adjustment.get("strategy"),
                "resourceEffectiveness": effect_report.get("resourceEffectiveness"),
            },
            evidence={
                "averageFeedbackScore": adjustment_evidence.get("averageFeedbackScore", 0),
                "completed": adjustment_evidence.get("completed", 0),
                "skipped": adjustment_evidence.get("skipped", 0),
                "planCompletionRate": adjustment_evidence.get("planCompletionRate", 0),
            },
            quality={"schemaVersion": effect_report.get("schemaVersion"), "hasPlanAdjustment": bool(adjustment)},
        )


class LearningEffectAnalyzerAgent(BaseAgent):
    name = "LearningEffectAnalyzerAgent"
    role = "learning effect analysis"
    detail = "Analyze learning effect metrics with LLM or structured rules fallback."
    output_schema = {
        "type": "object",
        "properties": {
            "analysis": {"type": "object"},
            "analysisSource": {"type": "string"},
            "analysisDegraded": {"type": "boolean"},
            "analysisDegradedReason": {"type": "string"},
        },
        "required": ["analysis", "analysisSource", "analysisDegraded", "analysisDegradedReason"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        effect_report = context.state.get("effectReport") if isinstance(context.state.get("effectReport"), dict) else {}
        if not effect_report:
            effect_report = build_learning_effect_report(context.user, include_persisted_analysis=False)
        profile = LearnerProfile.objects.filter(user=context.user).first()
        profile_summary = {
            "foundationLevel": getattr(profile, "foundation_level", "") if profile else "",
            "dailyStudyTime": getattr(profile, "daily_study_time", 0) if profile else 0,
            "weakPoints": getattr(profile, "weak_points", []) if profile else [],
            "learningGoals": getattr(profile, "learning_goals", []) if profile else [],
        }
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "You are A3 LearningEffectAnalyzerAgent. Analyze only the structured evidence provided. "
                        "Do not invent data, peer averages, citations, page numbers, or long-term trends. "
                        "Return strict JSON with schemaVersion, summary, riskLevel, riskReasons, findings, and nextIntervention."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "profileSnapshot": profile_summary,
                            "effectReport": _learning_effect_analysis_input(effect_report),
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0.1,
            max_tokens=900,
            timeout_seconds=float(os.getenv("A3_LEARNING_EFFECT_LLM_TIMEOUT_SECONDS", "12")),
            response_format={"type": "json_object"},
        )
        analysis = _normalize_learning_effect_analysis(json.loads(result["content"]), effect_report)
        return AgentResult(
            output={
                "analysis": analysis,
                "analysisSource": "llm",
                "analysisDegraded": False,
                "analysisDegradedReason": "",
            },
            state_patch={
                "analysis": analysis,
                "analysisSource": "llm",
                "analysisDegraded": False,
                "analysisDegradedReason": "",
            },
            input_summary={
                "schemaVersion": effect_report.get("schemaVersion"),
                "confidence": effect_report.get("confidence"),
                "knowledgePointCount": len(effect_report.get("knowledgePoints", [])) if isinstance(effect_report.get("knowledgePoints"), list) else 0,
            },
            output_summary={
                "source": "llm",
                "riskLevel": analysis.get("riskLevel"),
                "nextIntervention": (analysis.get("nextIntervention") or {}).get("type") if isinstance(analysis.get("nextIntervention"), dict) else "",
            },
            evidence={
                "provider": result.get("provider"),
                "model": result.get("model"),
                "finishReason": result.get("finishReason"),
            },
            quality={"schemaVersion": analysis.get("schemaVersion"), "evidenceBounded": True},
        )

    def fallback(self, context: AgentContext, error: Exception) -> AgentResult | None:
        effect_report = context.state.get("effectReport") if isinstance(context.state.get("effectReport"), dict) else {}
        if not effect_report:
            effect_report = build_learning_effect_report(context.user, include_persisted_analysis=False)
        analysis = _rules_learning_effect_analysis(effect_report)
        reason = str(error)
        return AgentResult(
            output={
                "analysis": analysis,
                "analysisSource": "rules_fallback",
                "analysisDegraded": True,
                "analysisDegradedReason": reason,
            },
            state_patch={
                "analysis": analysis,
                "analysisSource": "rules_fallback",
                "analysisDegraded": True,
                "analysisDegradedReason": reason,
            },
            input_summary={"schemaVersion": effect_report.get("schemaVersion"), "fallbackReason": reason},
            output_summary={
                "source": "rules_fallback",
                "riskLevel": analysis.get("riskLevel"),
                "nextIntervention": (analysis.get("nextIntervention") or {}).get("type") if isinstance(analysis.get("nextIntervention"), dict) else "",
            },
            evidence={"degraded": True, "reason": reason},
            quality={"schemaVersion": analysis.get("schemaVersion"), "evidenceBounded": True},
            detail="LLM unavailable or invalid; returned structured rules fallback analysis.",
        )


class ResourceFeedbackStudyPlanAgent(BaseAgent):
    name = "StudyPlanAgent"
    role = "adaptive plan writeback"
    detail = "Write the resource feedback strategy back to today's plan."
    output_schema = {
        "type": "object",
        "properties": {"studyPlan": {"type": "object"}},
        "required": ["studyPlan"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        effect_report = context.state.get("effectReport") if isinstance(context.state.get("effectReport"), dict) else {}
        adjustment = effect_report.get("planAdjustment") if isinstance(effect_report.get("planAdjustment"), dict) else {}
        adjustment_evidence = adjustment.get("evidence") if isinstance(adjustment.get("evidence"), dict) else {}
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        extra = dict(profile.extra_profile or {})
        extra["learningEffectReport"] = effect_report
        _apply_resource_feedback_plan_adjustment(context.user, extra, effect_report)
        plan = extra.get("studyPlan") if isinstance(extra.get("studyPlan"), dict) else {}
        persisted_adjustment = plan.get("lastResourceFeedbackAdjustment") if isinstance(plan.get("lastResourceFeedbackAdjustment"), dict) else {}
        profile.extra_profile = extra
        profile.save(update_fields=["extra_profile", "updated_at"])
        return AgentResult(
            output={"studyPlan": plan},
            state_patch={"studyPlan": plan},
            output_summary={
                "strategy": persisted_adjustment.get("strategy") or adjustment.get("strategy"),
                "taskId": persisted_adjustment.get("taskId"),
                "nextAction": (persisted_adjustment.get("nextAction") or {}).get("label")
                if isinstance(persisted_adjustment.get("nextAction"), dict)
                else None,
            },
            state_diff={"LearnerProfile.extra_profile.studyPlan": "adjusted"},
            evidence={
                "latestGoal": adjustment_evidence.get("latestGoal"),
                "taskId": persisted_adjustment.get("taskId"),
                "appliedAt": persisted_adjustment.get("appliedAt"),
            },
            quality={"strategy": persisted_adjustment.get("strategy") or adjustment.get("strategy")},
        )


class ResourceFeedbackMemoryCommitAgent(BaseAgent):
    name = "MemoryCommitAgent"
    role = "state commit"
    detail = "提交学习效果报告、计划调整和 Agent trace。"
    output_schema = {
        "type": "object",
        "properties": {"memoryCommitted": {"type": "boolean"}},
        "required": ["memoryCommitted"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        return AgentResult(
            output={"memoryCommitted": True},
            state_patch={"memoryCommitted": True},
            state_diff={
                "LearnerProfile.extra_profile.learningEffectReport": "updated",
                "LearnerProfile.extra_profile.agentRuns": "prepended",
            },
            evidence={"traceId": context.state.get("traceId")},
            quality={"memoryCommitted": True},
        )


class LearningEffectMemoryCommitAgent(BaseAgent):
    name = "LearningEffectMemoryCommitAgent"
    role = "learning effect memory commit"
    detail = "Persist learning effect analysis and trace evidence."
    output_schema = {
        "type": "object",
        "properties": {"memoryCommitted": {"type": "boolean"}},
        "required": ["memoryCommitted"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        _persist_learning_effect_analysis(
            context.user,
            analysis=context.state.get("analysis") if isinstance(context.state.get("analysis"), dict) else {},
            source=str(context.state.get("analysisSource") or "rules_fallback"),
            degraded=bool(context.state.get("analysisDegraded")),
            degraded_reason=str(context.state.get("analysisDegradedReason") or ""),
            trace={},
        )
        return AgentResult(
            output={"memoryCommitted": True},
            state_patch={"memoryCommitted": True},
            state_diff={"LearnerProfile.extra_profile.learningEffectAnalysis": "updated"},
            evidence={"analysisSource": context.state.get("analysisSource"), "degraded": bool(context.state.get("analysisDegraded"))},
            quality={"memoryCommitted": True},
        )


def build_resource_feedback_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (
        ResourceFeedbackAgent(),
        LearningEffectAgent(),
        LearningEffectAnalyzerAgent(),
        ResourceFeedbackStudyPlanAgent(),
        ResourceFeedbackMemoryCommitAgent(),
    ):
        kernel.register(agent)
    return kernel


def build_learning_effect_analysis_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (
        LearningEffectAnalyzerAgent(),
        LearningEffectMemoryCommitAgent(),
    ):
        kernel.register(agent)
    return kernel


def run_resource_feedback_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or build_resource_feedback_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    pack = payload.get("pack") if isinstance(payload.get("pack"), dict) else {}
    goal = f"资源反馈回流：{pack.get('goal') or payload.get('packId') or ''}"
    return kernel.run(
        AgentContext(user=user, workflow="resource_feedback", goal=goal, payload=payload),
        RESOURCE_FEEDBACK_WORKFLOW_SEQUENCE,
    )


def run_learning_effect_analysis_workflow(user, effect_report: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or build_learning_effect_analysis_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    return kernel.run(
        AgentContext(
            user=user,
            workflow="learning_effect_analysis",
            goal="学习效果评估 v2 分析",
            payload={},
            state={"effectReport": effect_report},
        ),
        LEARNING_EFFECT_ANALYSIS_WORKFLOW_SEQUENCE,
    )



def _resource_pack_next_actions(goal: str) -> list[dict]:
    return [
        {
            "label": "进入 AI 课堂讲解",
            "href": "/a3/classroom",
            "reason": "先完成讲解，再进入练习和复盘。",
        },
        {
            "label": "开始专项练习",
            "href": f"/a3/assessment?practice={quote(goal)}",
            "reason": "用测评结果回写画像和错题本。",
        },
        {
            "label": "查看学习报告",
            "href": "/a3/report",
            "reason": "资源使用后查看掌握度变化。",
        },
    ]


def generate_resource_pack_v2(user, *, goal: str = "", top_k: int = 3, resource_type: str = "") -> dict:
    payload = {"goal": goal, "topK": top_k}
    if resource_type:
        payload["resourceType"] = resource_type
        _requested_resource_type(payload)
    result = run_resource_generate_workflow(user, payload)
    if not result.success:
        raise RuntimeError(str(result.output.get("error") or "resource generation failed"))
    pack = result.output.get("resourcePack")
    if not isinstance(pack, dict):
        raise RuntimeError("resource generation did not return a resource pack")
    return {"success": True, "traceId": result.trace["traceId"], "resourcePack": pack}


def list_resource_packs(user) -> list[dict]:
    profile = LearnerProfile.objects.filter(user=user).first()
    extra = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    packs = extra.get("resourcePacks") if isinstance(extra.get("resourcePacks"), list) else []
    if not packs:
        logs = ResourcePackLog.objects.filter(user=user, source="resource_generation").order_by(
            "-completed_at", "-created_at"
        )[:30]
        packs = [
            log.payload
            for log in logs
            if isinstance(log.payload, dict)
            and log.payload.get("resourcePackId")
            and isinstance(log.payload.get("resources"), list)
        ]
    return [_attach_openmaic_artifacts(user, pack) for pack in packs]


def get_resource_pack(user, pack_id: str) -> dict | None:
    for pack in list_resource_packs(user):
        if str(pack.get("resourcePackId")) == str(pack_id):
            return pack
    return None


def record_resource_feedback(user, pack_id: str, payload: dict) -> dict:
    pack = get_resource_pack(user, pack_id)
    if not pack:
        raise ValueError("资源包不存在")
    action = str(payload.get("action") or "").strip()
    if action not in {"opened", "completed", "skipped", "favorited"}:
        raise ValueError("action 必须是 opened/completed/skipped/favorited")

    score = _resource_feedback_score(payload.get("score"))
    workflow_result = run_resource_feedback_workflow(
        user,
        {
            "packId": pack_id,
            "pack": pack,
            "action": action,
            "resourceType": str(payload.get("resourceType") or ""),
            "score": score,
        },
    )
    if not workflow_result.success:
        error = str(workflow_result.output.get("error") or "resource feedback workflow failed")
        return _degraded_resource_feedback_result(
            user,
            pack=pack,
            pack_id=pack_id,
            action=action,
            resource_type=str(payload.get("resourceType") or ""),
            score=score,
            reason=error,
        )
    effect_report = workflow_result.output.get("effectReport") if isinstance(workflow_result.output.get("effectReport"), dict) else {}
    analysis = workflow_result.output.get("analysis") if isinstance(workflow_result.output.get("analysis"), dict) else {}
    if effect_report and analysis:
        effect_report = {
            **effect_report,
            "analysis": analysis,
            "analysisSource": str(workflow_result.output.get("analysisSource") or "rules_fallback"),
            "analysisDegraded": bool(workflow_result.output.get("analysisDegraded")),
            "analysisDegradedReason": str(workflow_result.output.get("analysisDegradedReason") or ""),
            "agentTrace": workflow_result.trace,
        }
        _persist_learning_effect_analysis(
            user,
            analysis=analysis,
            source=effect_report["analysisSource"],
            degraded=effect_report["analysisDegraded"],
            degraded_reason=effect_report["analysisDegradedReason"],
            trace=workflow_result.trace,
        )
        plan_adjustment_action = _apply_learning_effect_plan_adjustment(user, effect_report)
        if plan_adjustment_action:
            effect_report["planAdjustmentAction"] = plan_adjustment_action
    return {
        "feedback": workflow_result.output.get("feedback") or {},
        "effectReport": effect_report,
        "traceId": workflow_result.trace["traceId"],
    }


def _degraded_resource_feedback_result(
    user,
    *,
    pack: dict,
    pack_id: str,
    action: str,
    resource_type: str,
    score: int | None,
    reason: str,
) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    feedback = {
        "packId": pack_id,
        "goal": pack.get("goal") or "",
        "action": action,
        "resourceType": resource_type,
        "score": score,
        "createdAt": timezone.now().isoformat(),
        "degraded": True,
        "degradedReason": reason[:240],
    }
    feedbacks = [item for item in extra.get("resourceFeedback", []) if isinstance(item, dict)]
    feedbacks.insert(0, feedback)
    extra["resourceFeedback"] = feedbacks[:100]
    try:
        from backend.apps.profiles.profile_updates import create_profile_update_candidates_from_event

        profile.extra_profile = extra
        create_profile_update_candidates_from_event(
            profile,
            event_type="resource_feedback",
            source="resource_feedback",
            signals={"resourceType": resource_type, "action": action, "score": score},
            evidence={"packId": pack_id, "goal": feedback["goal"], "degraded": True},
            save=False,
        )
        extra = dict(profile.extra_profile or {})
    except Exception:
        pass
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    effect_report = build_learning_effect_report(user, include_persisted_analysis=False)
    _apply_resource_feedback_plan_adjustment(user, extra, effect_report)
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {
        "feedback": feedback,
        "effectReport": {
            **effect_report,
            "analysisDegraded": True,
            "analysisDegradedReason": reason[:240],
        },
        "traceId": "",
    }


def _resource_feedback_score(value) -> int | None:
    if value is None or value == "":
        return None
    return max(0, min(100, _safe_int(value, 0)))


class OpenMAICClassroomBridgeAgent(BaseAgent):
    name = "A3ResourceBridgeAgent"
    role = "openmaic classroom bridge"
    detail = "Receive OpenMAIC classroom job evidence."
    output_schema = {"type": "object", "properties": {"artifact": {"type": "object"}}, "required": ["artifact"]}

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.payload
        artifact = {
            "schemaVersion": "a3.openmaic-classroom-artifact.v1",
            "type": "openmaic_classroom",
            "jobId": str(payload.get("jobId") or "").strip(),
            "status": str(payload.get("status") or "queued").strip().lower(),
            "classroomId": str(payload.get("classroomId") or ""),
            "classroomUrl": str(payload.get("classroomUrl") or ""),
            "scenesCount": _safe_int(payload.get("scenesCount"), 0),
            "pptxExportable": bool(payload.get("pptxExportable")),
            "provider": str(payload.get("provider") or "openmaic-generate-classroom"),
            "elapsedMs": _safe_int(payload.get("elapsedMs"), 0),
            "degradedReason": str(payload.get("degradedReason") or ""),
            "createdAt": timezone.now().isoformat(),
        }
        return AgentResult(
            output={"artifact": artifact},
            state_patch={"artifact": artifact},
            input_summary={"packId": payload.get("packId"), "jobId": artifact["jobId"], "status": artifact["status"]},
            output_summary={"status": artifact["status"], "classroomId": artifact["classroomId"]},
            evidence={"classroomId": artifact["classroomId"], "scenesCount": artifact["scenesCount"], "pptxExportable": artifact["pptxExportable"]},
            quality={"statusTransparent": True, "degraded": bool(artifact["degradedReason"])},
        )


class OpenMAICVideoBridgeAgent(BaseAgent):
    name = "A3VideoBridgeAgent"
    role = "openmaic video bridge"
    detail = "Receive OpenMAIC video provider evidence."
    output_schema = {"type": "object", "properties": {"artifact": {"type": "object"}}, "required": ["artifact"]}

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.payload
        segments = _normalize_openmaic_video_segments(payload.get("segments"))
        artifact = {
            "schemaVersion": "a3.openmaic-video-artifact.v1",
            "type": "openmaic_video",
            "status": str(payload.get("status") or "").strip().lower(),
            "provider": str(payload.get("provider") or "").strip(),
            "resourceType": str(payload.get("resourceType") or "micro_video_script"),
            "videoUrl": str(payload.get("videoUrl") or ""),
            "duration": _safe_int(payload.get("duration"), 0),
            "width": _safe_int(payload.get("width"), 0),
            "height": _safe_int(payload.get("height"), 0),
            "segments": segments,
            "elapsedMs": _safe_int(payload.get("elapsedMs"), 0),
            "degradedReason": str(payload.get("degradedReason") or ""),
            "createdAt": timezone.now().isoformat(),
        }
        return AgentResult(
            output={"artifact": artifact},
            state_patch={"artifact": artifact},
            input_summary={"packId": payload.get("packId"), "provider": artifact["provider"], "status": artifact["status"]},
            output_summary={"status": artifact["status"], "hasVideoUrl": bool(artifact["videoUrl"]), "segments": len(segments)},
            evidence={"videoUrl": bool(artifact["videoUrl"]), "segments": len(segments), "degraded": bool(artifact["degradedReason"])},
            quality={"providerEvidenceRecorded": True, "degradationTransparent": bool(artifact["degradedReason"] or artifact["status"] == "succeeded")},
        )


class OpenMAICPPTXExportBridgeAgent(BaseAgent):
    name = "A3PPTXExportBridgeAgent"
    role = "openmaic pptx export bridge"
    detail = "Receive OpenMAIC PPTX export evidence."
    output_schema = {"type": "object", "properties": {"artifact": {"type": "object"}}, "required": ["artifact"]}

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.payload
        artifact = {
            "schemaVersion": "a3.openmaic-pptx-export-artifact.v1",
            "type": "openmaic_pptx_export",
            "jobId": str(payload.get("jobId") or "").strip(),
            "status": str(payload.get("status") or "succeeded").strip().lower(),
            "provider": str(payload.get("provider") or "openmaic-pptx-export"),
            "classroomId": str(payload.get("classroomId") or ""),
            "classroomUrl": str(payload.get("classroomUrl") or ""),
            "fileName": str(payload.get("fileName") or ""),
            "slidesCount": _safe_int(payload.get("slidesCount"), 0),
            "elapsedMs": _safe_int(payload.get("elapsedMs"), 0),
            "degradedReason": str(payload.get("degradedReason") or ""),
            "createdAt": timezone.now().isoformat(),
        }
        return AgentResult(
            output={"artifact": artifact},
            state_patch={"artifact": artifact},
            input_summary={"packId": payload.get("packId"), "jobId": artifact["jobId"], "status": artifact["status"]},
            output_summary={"status": artifact["status"], "fileName": artifact["fileName"]},
            evidence={"fileName": artifact["fileName"], "slidesCount": artifact["slidesCount"], "classroomId": artifact["classroomId"]},
            quality={"exportEvidenceRecorded": True, "artifactHistoryUpdated": True},
        )


class OpenMAICResourcePackCommitAgent(BaseAgent):
    name = "ResourcePackCommitAgent"
    role = "state commit"
    detail = "Attach OpenMAIC artifact to the A3 resource pack."
    output_schema = {"type": "object", "properties": {"resourcePack": {"type": "object"}}, "required": ["resourcePack"]}

    def run(self, context: AgentContext) -> AgentResult:
        artifact = context.state.get("artifact") if isinstance(context.state.get("artifact"), dict) else {}
        pack_id = str(context.payload.get("packId") or "")
        updated_pack = _update_resource_pack_artifact(context.user, pack_id, artifact)
        return AgentResult(
            output={"resourcePack": updated_pack},
            state_patch={"resourcePack": updated_pack},
            output_summary={"packId": pack_id, "artifactType": artifact.get("type"), "status": artifact.get("status")},
            state_diff={"LearnerProfile.extra_profile.resourcePacks": "updated", "ResourcePackLog.payload": "updated"},
            evidence={"artifactType": artifact.get("type"), "status": artifact.get("status")},
            quality={"artifactPersisted": True},
        )


class OpenMAICInteractionBridgeAgent(BaseAgent):
    name = "A3OpenMAICInteractionBridgeAgent"
    role = "openmaic classroom interaction bridge"
    detail = "Normalize OpenMAIC classroom interaction as an A3 event payload."
    output_schema = {"type": "object", "properties": {"interaction": {"type": "object"}}, "required": ["interaction"]}

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.payload
        event_type = str(payload.get("eventType") or "").strip() or "interaction"
        progress = _safe_float(payload.get("progress"), 0)
        interaction = {
            "schemaVersion": "a3.openmaic-classroom-interaction.v1",
            "eventType": f"openmaic_{event_type}",
            "resourcePackId": str(payload.get("packId") or ""),
            "classroomId": str(payload.get("classroomId") or "").strip(),
            "classroomJobId": str(payload.get("classroomJobId") or "").strip(),
            "classroomUrl": str(payload.get("classroomUrl") or ""),
            "sceneId": str(payload.get("sceneId") or ""),
            "sceneTitle": str(payload.get("sceneTitle") or ""),
            "actionType": str(payload.get("actionType") or "").strip(),
            "actionId": str(payload.get("actionId") or ""),
            "progress": progress,
            "elapsedMs": _safe_int(payload.get("elapsedMs"), 0),
            "createdAt": timezone.now().isoformat(),
        }
        return AgentResult(
            output={"interaction": interaction},
            state_patch={"interaction": interaction},
            input_summary={"packId": interaction["resourcePackId"], "classroomId": interaction["classroomId"], "actionType": interaction["actionType"]},
            output_summary={"eventType": interaction["eventType"], "progress": progress},
            evidence={"sceneId": interaction["sceneId"], "progress": progress},
            quality={"interactionTraceable": True},
        )


class OpenMAICInteractionProfileAgent(BaseAgent):
    name = "ProfileAgent"
    role = "learning event commit"
    detail = "Append OpenMAIC interaction signal to learner profile events."
    output_schema = {"type": "object", "properties": {"interaction": {"type": "object"}}, "required": ["interaction"]}

    def run(self, context: AgentContext) -> AgentResult:
        interaction = context.state.get("interaction") if isinstance(context.state.get("interaction"), dict) else {}
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        extra = dict(profile.extra_profile or {})
        _append_learning_event(
            extra,
            interaction.get("eventType") or "openmaic_interaction",
            f"OpenMAIC classroom interaction: {interaction.get('actionType') or ''}",
            {
                "resourcePackId": interaction.get("resourcePackId"),
                "classroomId": interaction.get("classroomId"),
                "classroomJobId": interaction.get("classroomJobId"),
                "sceneId": interaction.get("sceneId"),
                "sceneTitle": interaction.get("sceneTitle"),
                "actionType": interaction.get("actionType"),
                "actionId": interaction.get("actionId"),
                "progress": interaction.get("progress"),
                "elapsedMs": interaction.get("elapsedMs"),
            },
        )
        try:
            from backend.apps.profiles.profile_updates import create_profile_update_candidates_from_event

            profile.extra_profile = extra
            create_profile_update_candidates_from_event(
                profile,
                event_type=str(interaction.get("eventType") or "openmaic_interaction"),
                source="classroom",
                signals={
                    "questionCount": 1 if interaction.get("actionType") else 0,
                    "resourceType": "openmaic_classroom",
                    "progress": interaction.get("progress"),
                    "sceneTitle": interaction.get("sceneTitle"),
                },
                evidence={
                    "resourcePackId": interaction.get("resourcePackId"),
                    "classroomId": interaction.get("classroomId"),
                    "sceneId": interaction.get("sceneId"),
                },
                raw_preview=str(interaction.get("sceneTitle") or interaction.get("actionType") or ""),
                save=False,
            )
            extra = dict(profile.extra_profile or {})
        except Exception:
            pass
        profile.extra_profile = extra
        profile.save(update_fields=["extra_profile", "updated_at"])
        return AgentResult(
            output={"interaction": interaction},
            output_summary={"learningEventWritten": True},
            state_diff={"LearnerProfile.extra_profile.learningEvents": "updated"},
            evidence={"eventType": interaction.get("eventType"), "progress": interaction.get("progress")},
            quality={"learningEventWritten": True},
        )


def _bridge_kernel(*agents: BaseAgent) -> AgentKernel:
    kernel = AgentKernel()
    for agent in agents:
        kernel.register(agent)
    return kernel


def run_openmaic_classroom_bridge_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or _bridge_kernel(OpenMAICClassroomBridgeAgent(), OpenMAICResourcePackCommitAgent())
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    return kernel.run(AgentContext(user=user, workflow="openmaic_classroom_bridge", goal=f"OpenMAIC classroom writeback: {payload.get('packId')}", payload=payload), OPENMAIC_CLASSROOM_BRIDGE_WORKFLOW_SEQUENCE)


def run_openmaic_video_bridge_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or _bridge_kernel(OpenMAICVideoBridgeAgent(), OpenMAICResourcePackCommitAgent())
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    return kernel.run(AgentContext(user=user, workflow="openmaic_video_bridge", goal=f"OpenMAIC video writeback: {payload.get('packId')}", payload=payload), OPENMAIC_VIDEO_BRIDGE_WORKFLOW_SEQUENCE)


def _normalize_openmaic_video_segments(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    segments = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            continue
        segments.append({
            "index": _safe_int(item.get("index"), index),
            "title": str(item.get("title") or f"片段 {index}"),
            "status": str(item.get("status") or "").strip().lower(),
            "videoUrl": str(item.get("videoUrl") or ""),
            "duration": _safe_int(item.get("duration"), 0),
            "width": _safe_int(item.get("width"), 0),
            "height": _safe_int(item.get("height"), 0),
            "degradedReason": str(item.get("degradedReason") or ""),
        })
    return segments[:12]


def run_openmaic_pptx_export_bridge_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or _bridge_kernel(OpenMAICPPTXExportBridgeAgent(), OpenMAICResourcePackCommitAgent())
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    return kernel.run(AgentContext(user=user, workflow="openmaic_pptx_export_bridge", goal=f"OpenMAIC PPTX writeback: {payload.get('packId')}", payload=payload), OPENMAIC_PPTX_EXPORT_BRIDGE_WORKFLOW_SEQUENCE)


def run_openmaic_interaction_bridge_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or _bridge_kernel(OpenMAICInteractionBridgeAgent(), OpenMAICInteractionProfileAgent())
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    return kernel.run(AgentContext(user=user, workflow="openmaic_interaction_bridge", goal=f"OpenMAIC interaction writeback: {payload.get('packId')}", payload=payload), OPENMAIC_INTERACTION_BRIDGE_WORKFLOW_SEQUENCE)


def record_openmaic_classroom_artifact(user, pack_id: str, payload: dict) -> dict:
    if not get_resource_pack(user, pack_id):
        raise ValueError("资源包不存在")
    job_id = str(payload.get("jobId") or "").strip()
    if not job_id:
        raise ValueError("jobId 不能为空")
    status = str(payload.get("status") or "queued").strip().lower()
    if status not in {"queued", "running", "succeeded", "failed"}:
        raise ValueError("status 必须是 queued/running/succeeded/failed")
    result = run_openmaic_classroom_bridge_workflow(user, {"packId": pack_id, **payload, "jobId": job_id, "status": status})
    if not result.success:
        raise RuntimeError(str(result.output.get("error") or "openmaic classroom bridge failed"))
    return {"artifact": result.output.get("artifact") or {}, "resourcePack": result.output.get("resourcePack") or {}, "traceId": result.trace["traceId"]}


def record_openmaic_video_artifact(user, pack_id: str, payload: dict) -> dict:
    if not get_resource_pack(user, pack_id):
        raise ValueError("资源包不存在")
    status = str(payload.get("status") or "").strip().lower()
    if status not in {"succeeded", "partial", "failed", "running", "queued"}:
        raise ValueError("status 必须是 queued/running/succeeded/partial/failed")
    provider = str(payload.get("provider") or "").strip()
    if not provider:
        raise ValueError("provider 不能为空")
    result = run_openmaic_video_bridge_workflow(user, {"packId": pack_id, **payload, "status": status, "provider": provider})
    if not result.success:
        raise RuntimeError(str(result.output.get("error") or "openmaic video bridge failed"))
    return {"artifact": result.output.get("artifact") or {}, "resourcePack": result.output.get("resourcePack") or {}, "traceId": result.trace["traceId"]}


def record_openmaic_pptx_export_artifact(user, pack_id: str, payload: dict) -> dict:
    if not get_resource_pack(user, pack_id):
        raise ValueError("资源包不存在")
    job_id = str(payload.get("jobId") or "").strip()
    if not job_id:
        raise ValueError("jobId 不能为空")
    status = str(payload.get("status") or "succeeded").strip().lower()
    if status not in {"queued", "running", "succeeded", "failed"}:
        raise ValueError("status 必须是 queued/running/succeeded/failed")
    result = run_openmaic_pptx_export_bridge_workflow(user, {"packId": pack_id, **payload, "jobId": job_id, "status": status})
    if not result.success:
        raise RuntimeError(str(result.output.get("error") or "openmaic pptx bridge failed"))
    return {"artifact": result.output.get("artifact") or {}, "resourcePack": result.output.get("resourcePack") or {}, "traceId": result.trace["traceId"]}


def record_openmaic_classroom_interaction(user, pack_id: str, payload: dict) -> dict:
    if not get_resource_pack(user, pack_id):
        raise ValueError("资源包不存在")
    classroom_id = str(payload.get("classroomId") or "").strip()
    classroom_job_id = str(payload.get("classroomJobId") or "").strip()
    action_type = str(payload.get("actionType") or "").strip()
    if not classroom_id:
        raise ValueError("classroomId 不能为空")
    if not classroom_job_id:
        raise ValueError("classroomJobId 不能为空")
    if not action_type:
        raise ValueError("actionType 不能为空")
    result = run_openmaic_interaction_bridge_workflow(user, {"packId": pack_id, **payload, "classroomId": classroom_id, "classroomJobId": classroom_job_id, "actionType": action_type})
    if not result.success:
        raise RuntimeError(str(result.output.get("error") or "openmaic interaction bridge failed"))
    return {"interaction": result.output.get("interaction") or {}, "traceId": result.trace["traceId"]}


def evaluate_learning_effect(user) -> dict:
    report = build_learning_effect_report(user, include_persisted_analysis=False)
    workflow_result = run_learning_effect_analysis_workflow(user, report)
    if workflow_result.success:
        analysis = workflow_result.output.get("analysis") if isinstance(workflow_result.output.get("analysis"), dict) else _rules_learning_effect_analysis(report)
        source = str(workflow_result.output.get("analysisSource") or "rules_fallback")
        degraded = bool(workflow_result.output.get("analysisDegraded"))
        degraded_reason = str(workflow_result.output.get("analysisDegradedReason") or "")
        report = {
            **report,
            "analysis": analysis,
            "analysisSource": source,
            "analysisDegraded": degraded,
            "analysisDegradedReason": degraded_reason,
            "agentTrace": workflow_result.trace,
        }
    else:
        analysis = _rules_learning_effect_analysis(report)
        report = {
            **report,
            "analysis": analysis,
            "analysisSource": "rules_fallback",
            "analysisDegraded": True,
            "analysisDegradedReason": str(workflow_result.output.get("error") or "learning effect analysis workflow failed"),
            "agentTrace": workflow_result.trace,
        }
    _persist_learning_effect_analysis(
        user,
        analysis=report["analysis"],
        source=report["analysisSource"],
        degraded=report["analysisDegraded"],
        degraded_reason=report["analysisDegradedReason"],
        trace=report["agentTrace"],
    )
    from backend.apps.learning.optimization_policy import append_policy_decision_history, build_continuous_optimization_policy_report

    policy_report = build_continuous_optimization_policy_report(user, effect_report=report)
    report["optimizationPolicy"] = policy_report
    append_policy_decision_history(user, policy_report)
    plan_adjustment_action = _apply_learning_effect_plan_adjustment(user, report)
    if plan_adjustment_action:
        report["planAdjustmentAction"] = plan_adjustment_action
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    extra["learningEffectReport"] = report
    extra["continuousOptimizationPolicyReport"] = policy_report
    _append_learning_event(
        extra,
        "learning_effect_evaluated",
        "学习效果评估已刷新",
        {"resourceEffectiveness": report["resourceEffectiveness"]},
    )
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return report


def build_learning_effect_report(user, *, include_persisted_analysis: bool = True) -> dict:
    profile = LearnerProfile.objects.filter(user=user).first()
    extra = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    feedbacks = [item for item in extra.get("resourceFeedback", []) if isinstance(item, dict)]
    event_degraded_reason = ""
    try:
        event_summary = aggregate_learning_events(user, days=30)
    except Exception as exc:
        event_summary = {
            "resourceUsage": {},
            "eventStream": {
                "status": "degraded",
                "degraded": True,
                "reason": str(exc)[:240],
            },
            "recentEvents": [],
        }
        event_degraded_reason = str(exc)[:240]
    event_usage = event_summary.get("resourceUsage") if isinstance(event_summary.get("resourceUsage"), dict) else {}
    event_stream = event_summary.get("eventStream") if isinstance(event_summary.get("eventStream"), dict) else {}
    event_total = sum(_safe_int(event_usage.get(key), 0) for key in ["opened", "completed", "skipped", "favorited"])
    if event_total:
        opened = _safe_int(event_usage.get("opened"), 0)
        completed = _safe_int(event_usage.get("completed"), 0)
        skipped = _safe_int(event_usage.get("skipped"), 0)
        favorited = _safe_int(event_usage.get("favorited"), 0)
        scores = [
            _safe_int(item.get("score"), 0)
            for item in event_summary.get("recentEvents", [])
            if str(item.get("eventType") or "").startswith("resource_") and _safe_int(item.get("score"), 0) > 0
        ]
        total_feedback = event_total
        latest_goal = _latest_resource_event_goal(event_summary.get("recentEvents", []))
    else:
        opened = len([item for item in feedbacks if item.get("action") == "opened"])
        completed = len([item for item in feedbacks if item.get("action") == "completed"])
        skipped = len([item for item in feedbacks if item.get("action") == "skipped"])
        favorited = len([item for item in feedbacks if item.get("action") == "favorited"])
        scores = [_safe_int(item.get("score"), 0) for item in feedbacks if _safe_int(item.get("score"), 0) > 0]
        total_feedback = len(feedbacks)
        latest_goal = str(feedbacks[0].get("goal") or "") if feedbacks else ""
    average_score = round(sum(scores) / len(scores), 1) if scores else 0

    plan = current_study_plan(user) or generate_study_plan(user)
    task_count = _plan_task_count(plan)
    completed_tasks = _completed_plan_task_count(plan)
    completion_rate = round(completed_tasks / task_count, 3) if task_count else 0
    effectiveness = round((completed * 0.5) + (len(scores) * 0.25) + (sum(scores) / max(1, len(scores)) / 100), 3)
    adjustment_strategy = _plan_adjustment_strategy(
        completed=completed,
        skipped=skipped,
        favorited=favorited,
        average_score=average_score,
    )

    try:
        metrics = build_learning_effect_metrics(user, days=30)
    except Exception as exc:
        event_degraded_reason = event_degraded_reason or str(exc)[:240]
        metrics = _degraded_learning_effect_metrics(days=30, reason=event_degraded_reason)

    report = {
        "schemaVersion": "a3.learning-effect.v2",
        **metrics,
        "resourceUsage": {
            "opened": opened,
            "completed": completed,
            "skipped": skipped,
            "favorited": favorited,
            "totalFeedback": total_feedback,
        },
        "eventStream": event_stream,
        "resourceEffectiveness": effectiveness,
        "masterySignals": {
            "averageFeedbackScore": average_score,
            "weakPoints": profile.weak_points if profile else [],
        },
        "planExecution": {
            "taskCount": task_count,
            "completedTasks": completed_tasks,
            "completionRate": completion_rate,
        },
        "planAdjustment": {
            "strategy": adjustment_strategy,
            "reason": _plan_adjustment_reason(adjustment_strategy),
            "evidence": {
                "opened": opened,
                "completed": completed,
                "skipped": skipped,
                "favorited": favorited,
                "averageFeedbackScore": average_score,
                "planCompletionRate": completion_rate,
                "latestGoal": latest_goal,
            },
            "nextAction": _plan_adjustment_next_action(adjustment_strategy, latest_goal),
        },
        "updatedAt": timezone.now().isoformat(),
    }
    if event_degraded_reason:
        missing = report.get("missingEvidence") if isinstance(report.get("missingEvidence"), list) else []
        report["missingEvidence"] = [*missing, "学习事件表暂不可用，已使用资源反馈记录降级评估"]
        report["eventStream"] = {
            **(report.get("eventStream") if isinstance(report.get("eventStream"), dict) else {}),
            "status": "degraded",
            "degraded": True,
            "reason": event_degraded_reason,
        }
    from backend.apps.learning.optimization_policy import build_continuous_optimization_policy_report

    report["optimizationPolicy"] = build_continuous_optimization_policy_report(user, effect_report=report)
    if include_persisted_analysis:
        persisted = extra.get("learningEffectAnalysis") if isinstance(extra.get("learningEffectAnalysis"), dict) else {}
        if persisted:
            report.update(
                {
                    "analysis": persisted.get("analysis") if isinstance(persisted.get("analysis"), dict) else _rules_learning_effect_analysis(report),
                    "analysisSource": str(persisted.get("source") or "rules_fallback"),
                    "analysisDegraded": bool(persisted.get("degraded")),
                    "analysisDegradedReason": str(persisted.get("degradedReason") or ""),
                    "agentTrace": persisted.get("trace") if isinstance(persisted.get("trace"), dict) else {},
                }
            )
    return report


def _learning_effect_analysis_input(effect_report: dict) -> dict:
    return {
        "schemaVersion": effect_report.get("schemaVersion"),
        "overallEffectScore": effect_report.get("overallEffectScore"),
        "confidence": effect_report.get("confidence"),
        "missingEvidence": effect_report.get("missingEvidence", []),
        "behavior": effect_report.get("behavior", {}),
        "assessment": effect_report.get("assessment", {}),
        "knowledgePoints": effect_report.get("knowledgePoints", [])[:6] if isinstance(effect_report.get("knowledgePoints"), list) else [],
        "trends": effect_report.get("trends", {}),
        "resourceUsage": effect_report.get("resourceUsage", {}),
        "planExecution": effect_report.get("planExecution", {}),
    }


def _degraded_learning_effect_metrics(*, days: int, reason: str) -> dict:
    now = timezone.now()
    started_at = now - timedelta(days=days)
    empty_behavior = {
        "activeDays": 0,
        "totalDurationSec": 0,
        "taskCompletionRate": 0,
        "completedTaskCount": 0,
        "taskEventCount": 0,
        "reflectionCount": 0,
        "eventCount": 0,
    }
    empty_assessment = {
        "attemptCount": 0,
        "averageScore": 0,
        "correctRate": 0,
        "wrongQuestionCount": 0,
        "reviewedWrongQuestionCount": 0,
    }
    return {
        "overallEffectScore": 0,
        "confidence": "low",
        "missingEvidence": [
            "学习事件流暂不可用",
            reason or "事件表结构需要迁移",
        ],
        "timeWindow": {
            "days": days,
            "startedAt": started_at.date().isoformat(),
            "endedAt": now.date().isoformat(),
        },
        "behavior": empty_behavior,
        "assessment": empty_assessment,
        "knowledgePoints": [],
        "trends": {
            "sevenDay": {"days": 7, "behavior": empty_behavior, "assessment": empty_assessment},
            "fourteenDay": {"days": 14, "behavior": empty_behavior, "assessment": empty_assessment},
            "thirtyDay": {"days": 30, "behavior": empty_behavior, "assessment": empty_assessment},
        },
        "baseline": {
            "type": "degraded_no_event_stream",
            "planExpectedCompletionRate": 0.8,
            "actualCompletionRate": 0,
        },
    }


def _normalize_learning_effect_analysis(raw: dict, effect_report: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("analysis output must be an object")
    summary = str(raw.get("summary") or "").strip()[:500] or _rules_learning_effect_analysis(effect_report)["summary"]
    risk_level = str(raw.get("riskLevel") or "medium").strip().lower()
    if risk_level not in {"low", "medium", "high"}:
        risk_level = "medium"
    findings = raw.get("findings") if isinstance(raw.get("findings"), list) else []
    next_intervention = raw.get("nextIntervention") if isinstance(raw.get("nextIntervention"), dict) else {}
    return {
        "schemaVersion": "a3.learning-effect-analysis.v1",
        "summary": summary,
        "riskLevel": risk_level,
        "riskReasons": [item for item in (raw.get("riskReasons") if isinstance(raw.get("riskReasons"), list) else []) if isinstance(item, dict)][:5],
        "findings": [item for item in findings if isinstance(item, dict)][:8],
        "nextIntervention": {
            "type": str(next_intervention.get("type") or "add_spaced_review"),
            "reason": str(next_intervention.get("reason") or "根据学习效果评估安排下一步复习。")[:240],
            "targetKnowledgePointId": str(next_intervention.get("targetKnowledgePointId") or ""),
        },
    }


def _rules_learning_effect_analysis(effect_report: dict) -> dict:
    confidence = str(effect_report.get("confidence") or "low")
    missing = effect_report.get("missingEvidence") if isinstance(effect_report.get("missingEvidence"), list) else []
    knowledge_points = effect_report.get("knowledgePoints") if isinstance(effect_report.get("knowledgePoints"), list) else []
    weakest = next((item for item in knowledge_points if isinstance(item, dict) and item.get("learningGain", 0) < 0), None)
    strongest = next((item for item in knowledge_points if isinstance(item, dict) and item.get("learningGain", 0) >= 0), None)
    if missing:
        risk_level = "medium"
        summary = "当前学习效果证据不足，建议先补齐测评、任务完成和资源使用记录。"
        intervention = {"type": "add_diagnostic_practice", "reason": "需要补齐后测证据。", "targetKnowledgePointId": ""}
    elif weakest:
        risk_level = "high"
        summary = f"{weakest.get('name') or '当前知识点'} 出现退步信号，需要优先补救。"
        intervention = {"type": "add_remedial_practice", "reason": "知识点学习增益为负。", "targetKnowledgePointId": str(weakest.get("knowledgePointId") or "")}
    elif strongest and confidence == "high":
        risk_level = "low"
        summary = f"{strongest.get('name') or '当前知识点'} 学习增益为正，可以提高挑战或进入迁移练习。"
        intervention = {"type": "increase_challenge", "reason": "近期作答证据充分且后测表现较好。", "targetKnowledgePointId": str(strongest.get("knowledgePointId") or "")}
    else:
        risk_level = "medium"
        summary = "学习效果保持稳定，建议继续执行计划并安排间隔复习。"
        intervention = {"type": "add_spaced_review", "reason": "维持当前掌握度并降低遗忘风险。", "targetKnowledgePointId": ""}
    return {
        "schemaVersion": "a3.learning-effect-analysis.v1",
        "summary": summary,
        "riskLevel": risk_level,
        "riskReasons": [{"reason": item, "evidenceKeys": ["missingEvidence"]} for item in missing[:3]],
        "findings": [
            {
                "type": "knowledge_point",
                "targetId": str(item.get("knowledgePointId") or ""),
                "finding": f"{item.get('name') or '知识点'} 增益 {item.get('learningGain', 0)}，趋势 {item.get('trend') or 'stable'}。",
                "confidence": str(item.get("confidence") or confidence),
                "evidenceKeys": ["knowledgePoints.learningGain", "knowledgePoints.trend"],
            }
            for item in knowledge_points[:5]
            if isinstance(item, dict)
        ],
        "nextIntervention": intervention,
    }


def _persist_learning_effect_analysis(user, *, analysis: dict, source: str, degraded: bool, degraded_reason: str, trace: dict) -> None:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    extra["learningEffectAnalysis"] = {
        "analysis": analysis if isinstance(analysis, dict) else {},
        "source": source,
        "degraded": degraded,
        "degradedReason": degraded_reason,
        "trace": trace if isinstance(trace, dict) else {},
        "updatedAt": timezone.now().isoformat(),
    }
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])


def _apply_learning_effect_plan_adjustment(user, report: dict) -> dict:
    analysis = report.get("analysis") if isinstance(report.get("analysis"), dict) else {}
    if not analysis:
        return {}
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    plan = extra.get("studyPlan") if isinstance(extra.get("studyPlan"), dict) else None
    if plan is None:
        plan = current_study_plan(user) or generate_study_plan(user)
    if not isinstance(plan, dict):
        return {}
    adjustment = build_plan_adjustment_from_analysis(analysis, report)
    policy_report = report.get("optimizationPolicy") if isinstance(report.get("optimizationPolicy"), dict) else {}
    if policy_report:
        from backend.apps.learning.optimization_policy import decorate_adjustment_with_policy_decision

        adjustment = decorate_adjustment_with_policy_decision(adjustment, policy_report)
    adjusted_plan = apply_plan_adjustment_to_study_plan(plan, adjustment)
    if policy_report:
        extra["continuousOptimizationPolicyReport"] = policy_report
    extra["studyPlan"] = adjusted_plan
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return adjusted_plan.get("lastLearningEffectAdjustment", {}) if isinstance(adjusted_plan, dict) else {}


def _latest_resource_event_goal(events: list) -> str:
    for item in events:
        if not isinstance(item, dict):
            continue
        if not str(item.get("eventType") or "").startswith("resource_"):
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        goal = str(metadata.get("goal") or "").strip()
        if goal:
            return goal
    return ""


def _search_resource_sources(goal: str, *, top_k: int, fallback_sources: list[dict]) -> list[dict]:
    try:
        results = search_knowledge_base(query=goal, top_k=max(1, top_k))
    except Exception:
        results = []
    sources = [
        {
            "id": f"rag-{index}",
            "title": str(item.metadata.get("title") or "知识库片段"),
            "location": str(item.metadata.get("display_location") or item.metadata.get("source_path") or "本地知识库"),
            "type": "RAG",
            "score": round(float(item.score), 3) if item.score is not None else None,
            "snippet": item.text[:500],
        }
        for index, item in enumerate(results, start=1)
    ]
    if sources:
        return sources

    context_sources = [
        source
        for source in fallback_sources
        if isinstance(source, dict) and str(source.get("snippet") or "").strip()
    ]
    if context_sources:
        return [{**source, "type": source.get("type") or "课程上下文"} for source in context_sources[:top_k]]
    return [{
        "id": "learning-state",
        "title": goal,
        "location": "当前学习目标",
        "type": "学习状态",
        "score": None,
        "snippet": f"当前个性化学习目标为“{goal}”，资源基于画像、路径节点和课程上下文生成。",
    }]


def _build_resource_item(resource_type: str, goal: str, profile: LearnerProfile | None, sources: list[dict], *, allow_llm: bool) -> dict:
    citations = _normalized_resource_sources(sources, limit=6, goal=goal)
    reason = _personalization_reason(profile, resource_type)
    content, synthesis = _resource_content(resource_type, goal, citations, profile, allow_llm=allow_llm)
    verification = verify_answer(
        goal,
        _content_text(content),
        [{**citation, "type": citation.get("type") or "RAG", "score": citation.get("score")} for citation in citations],
    )
    return {
        "type": resource_type,
        "title": _resource_title(resource_type, goal),
        "content": content,
        "citations": verification.citations or [{**citation, "type": citation.get("type") or "RAG"} for citation in citations],
        "verified": bool(verification.verified or verification.citations),
        "personalizationReason": reason,
        "synthesis": synthesis,
        "estimatedMinutes": _estimated_minutes(resource_type),
    }


def _resource_title(resource_type: str, goal: str) -> str:
    return f"{goal} 路 {RESOURCE_TYPE_LABELS[resource_type]}"


def _resource_content(resource_type: str, goal: str, sources: list[dict], profile: LearnerProfile | None, *, allow_llm: bool) -> tuple[dict, dict]:
    llm_content, llm_meta = _try_llm_resource_content(resource_type, goal, sources, profile, allow_llm=allow_llm)
    if llm_content:
        llm_content = _repair_llm_resource_content(resource_type, llm_content, goal, sources, profile)
    llm_quality = _resource_content_quality(resource_type, llm_content) if llm_content else None
    if llm_content and llm_quality and llm_quality["passed"]:
        content = _attach_content_defaults(llm_content, resource_type, sources, mode="llm")
        return content, {**llm_meta, "mode": "llm", "degraded": False, "quality": llm_quality}

    content = _fallback_resource_content(resource_type, goal, sources, profile)
    fallback_quality = _resource_content_quality(resource_type, content)
    synthesis = {
        **llm_meta,
        "mode": "rules",
        "degraded": bool(llm_meta.get("attempted")),
        "degradationReason": llm_meta.get("error") or ("LLM disabled" if not llm_meta.get("attempted") else "LLM output did not pass specialist quality checks"),
        "quality": fallback_quality,
        **({"rejectedLlmQuality": llm_quality} if llm_quality else {}),
    }
    return content, synthesis


def _repair_llm_resource_content(resource_type: str, content: dict, goal: str, sources: list[dict], profile: LearnerProfile | None) -> dict:
    if not isinstance(content, dict):
        return content
    if resource_type == "practice_set":
        return _repair_practice_set_content(content, goal, sources, profile)
    if resource_type == "case_study":
        return _repair_case_study_content(content, goal, sources, profile)
    if resource_type == "code_lab":
        return _repair_code_lab_content(content, goal, sources, profile)
    if resource_type != "mind_map":
        return content
    repaired = dict(content)
    nodes = repaired.get("nodes")
    if not isinstance(nodes, list) or len(nodes) < 3:
        return repaired
    normalized_nodes = []
    source_ids = [f"S{index}" for index in range(1, min(len(sources), 6) + 1)]
    for index, node in enumerate(nodes, start=1):
        if not isinstance(node, dict):
            continue
        label = str(node.get("label") or node.get("title") or f"分支 {index}").strip()
        children = node.get("children")
        if not isinstance(children, list):
            children = []
        source_id_list = node.get("sourceIds") if isinstance(node.get("sourceIds"), list) else source_ids[: min(len(source_ids), 2)]
        normalized_nodes.append({
            **node,
            "label": label,
            "children": [str(child).strip() for child in children if str(child).strip()][:6],
            "sourceIds": source_id_list,
        })
    if not normalized_nodes:
        return repaired
    root = str(repaired.get("root") or goal or "当前学习主题").strip()
    repaired["root"] = root
    repaired["nodes"] = normalized_nodes
    repaired.setdefault("markdown", _mind_map_markdown(root, normalized_nodes))
    repaired.setdefault("mermaid", _mind_map_mermaid(root, normalized_nodes))
    repaired.setdefault("algorithm", "llm_repaired_markdown_mindmap.v1")
    repaired.setdefault("layout", {"style": "radial", "primaryAxis": "llm_structured", "sourceAware": True})
    repaired.setdefault("studyPath", _mind_map_study_path(root, normalized_nodes, profile))
    return repaired


def _repair_practice_set_content(content: dict, goal: str, sources: list[dict], profile: LearnerProfile | None) -> dict:
    fallback = _fallback_resource_content("practice_set", goal, sources, profile)
    fallback_questions = list(fallback.get("questions") or [])
    provided = content.get("questions") if isinstance(content.get("questions"), list) else []
    questions = []
    for index in range(max(8, len(provided))):
        base = dict(fallback_questions[index % len(fallback_questions)])
        candidate = provided[index] if index < len(provided) and isinstance(provided[index], dict) else {}
        base.update({key: value for key, value in candidate.items() if value not in (None, "", [])})
        base["id"] = str(base.get("id") or f"q{index + 1}")
        base["type"] = str(base.get("type") or "analysis")
        base["knowledgePoint"] = str(base.get("knowledgePoint") or goal)
        base["difficulty"] = str(base.get("difficulty") or "中等")
        base["stem"] = str(base.get("stem") or fallback_questions[index % len(fallback_questions)]["stem"])
        base["answer"] = str(base.get("answer") or "请依据资料证据完成作答。")
        base["explanation"] = str(base.get("explanation") or fallback_questions[index % len(fallback_questions)]["explanation"])
        base["distractorAnalysis"] = _list_or_fallback(base.get("distractorAnalysis"), fallback_questions[index % len(fallback_questions)].get("distractorAnalysis"))
        base["commonMistake"] = str(base.get("commonMistake") or "只记结论，没有检查题目条件和证据。")
        base["evaluationRubric"] = _list_or_fallback(base.get("evaluationRubric"), ["结论正确", "说明判断条件", "引用资料证据"])
        base["sourceIds"] = _list_or_fallback(base.get("sourceIds"), fallback.get("sourceIds"))[:4]
        questions.append(base)
    return {**fallback, **content, "questions": questions, "sourceIds": _list_or_fallback(content.get("sourceIds"), fallback.get("sourceIds"))}


def _repair_case_study_content(content: dict, goal: str, sources: list[dict], profile: LearnerProfile | None) -> dict:
    fallback = _fallback_resource_content("case_study", goal, sources, profile)
    repaired = {**fallback, **{key: value for key, value in content.items() if value not in (None, "", [])}}
    repaired["role"] = str(repaired.get("role") or fallback["role"])
    repaired["constraints"] = _list_or_fallback(repaired.get("constraints"), fallback["constraints"])
    repaired["materials"] = _list_or_fallback(repaired.get("materials"), fallback["materials"])
    repaired["decisionPoints"] = _list_or_fallback(repaired.get("decisionPoints"), fallback["decisionPoints"])
    repaired["studentPrompt"] = str(repaired.get("studentPrompt") or repaired.get("task") or fallback["studentPrompt"])
    repaired["analysisSteps"] = _list_or_fallback(repaired.get("analysisSteps"), repaired.get("steps") if isinstance(repaired.get("steps"), list) else fallback["analysisSteps"])
    repaired["expertAnalysis"] = str(repaired.get("expertAnalysis") or repaired.get("analysis") or fallback["expertAnalysis"])
    repaired["rubric"] = _list_or_fallback(repaired.get("rubric"), fallback["rubric"])
    repaired["reflection"] = str(repaired.get("reflection") or fallback["reflection"])
    repaired["sourceIds"] = _list_or_fallback(repaired.get("sourceIds"), fallback["sourceIds"])
    repaired.setdefault("steps", repaired["analysisSteps"])
    repaired.setdefault("analysis", repaired["expertAnalysis"])
    return repaired


def _repair_code_lab_content(content: dict, goal: str, sources: list[dict], profile: LearnerProfile | None) -> dict:
    fallback = _fallback_resource_content("code_lab", goal, sources, profile)
    has_runner_contract = bool(content.get("starterCode") and content.get("testCases"))
    repaired = {**fallback, **{key: value for key, value in content.items() if value not in (None, "", [])}}
    if not has_runner_contract:
        repaired["starterCode"] = fallback["starterCode"]
        repaired["testCases"] = fallback["testCases"]
        repaired["expectedOutput"] = fallback["expectedOutput"]
    repaired["language"] = "Python"
    repaired["environment"] = str(repaired.get("environment") or fallback["environment"])
    for field in ("concepts", "steps", "testCases", "hints", "commonFailures", "checkpoints"):
        repaired[field] = _list_or_fallback(repaired.get(field), fallback[field])
    repaired["objective"] = str(repaired.get("objective") or fallback["objective"])
    repaired["extension"] = str(repaired.get("extension") or fallback["extension"])
    repaired["sourceIds"] = _list_or_fallback(repaired.get("sourceIds"), fallback["sourceIds"])
    return repaired


def _list_or_fallback(value, fallback=None) -> list:
    if isinstance(value, list):
        return list(value)
    return list(fallback) if isinstance(fallback, list) else []


def _fallback_resource_content(resource_type: str, goal: str, sources: list[dict], profile: LearnerProfile | None) -> dict:
    evidence = _evidence_units(sources, goal)
    source_ids = [item["sourceId"] for item in evidence]
    primary = evidence[0]["snippet"]
    weak_points = [point for point in (getattr(profile, "weak_points", None) or []) if point][:4]
    preferred = [item for item in (getattr(profile, "expected_resources", None) or []) if item][:4]
    profile_line = _profile_learning_line(profile)
    if resource_type == "lecture_doc":
        return {
            "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
            "sourceIds": source_ids,
            "sections": _lecture_doc_sections(goal, evidence, source_ids, profile_line, weak_points),
        }
    if resource_type == "knowledge_card":
        cards = [
            {"front": f"{goal} 的一句话定义是什么？", "back": primary, "sourceIds": source_ids[:2]},
            {"front": f"学习 {goal} 前先确认什么？", "back": "确认对象、条件、变量/协议字段、输入输出和课程资料中的上下文。", "sourceIds": source_ids[:2]},
            {"front": f"{goal} 最容易错在哪里？", "back": _misconception_text(goal, weak_points, evidence), "sourceIds": source_ids[:3]},
            {"front": f"如何判断自己掌握了 {goal}？", "back": "能解释资料证据，能做一道迁移题，能把错误原因写入错题本。", "sourceIds": source_ids[:2]},
        ]
        return {"schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION, "front": cards[0]["front"], "back": cards[0]["back"], "cards": cards, "tags": _profile_tags(profile), "sourceIds": source_ids}
    if resource_type == "mind_map":
        return _fallback_mind_map_content(goal, evidence, source_ids, weak_points, profile)
    if resource_type == "practice_set":
        question_types = ["concept", "choice", "fill_blank", "application", "analysis", "debug", "transfer", "reflection"]
        return {
            "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
            "questions": [
                {
                    "id": f"q{index + 1}",
                    "type": kind,
                    "knowledgePoint": goal,
                    "stem": _practice_stem(kind, goal, evidence, index),
                    **({"options": _practice_choice_options(goal)} if kind == "choice" else {}),
                    "answer": _practice_answer(kind, goal, evidence, index),
                    "explanation": _practice_explanation(kind, goal, evidence, index),
                    "difficulty": ["基础", "基础", "基础", "中等", "中等", "中等", "提高", "复盘"][index],
                    "distractorAnalysis": _practice_distractor_analysis(goal) if kind == "choice" else [],
                    "commonMistake": _practice_common_mistake(kind, goal),
                    "evaluationRubric": ["结论正确", "说明适用条件", "引用至少一条资料证据"],
                    "sourceIds": source_ids[: min(len(source_ids), 2 + (index % 3))],
                }
                for index, kind in enumerate(question_types)
            ],
            "sourceIds": source_ids,
        }
    if resource_type == "case_study":
        analysis_steps = ["识别场景中的对象、目标和限制", "从材料中提取可验证事实", "定位需要做出的关键决策", "比较候选方案及其代价", "给出结论并标注证据", "复盘一个可能导致误判的条件"]
        expert_analysis = _step_explanation(goal, evidence)
        return {
            "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
            "scenario": f"{goal} 课程资料驱动案例",
            "role": f"你是负责分析该问题的{getattr(profile, 'major_direction', '') or '课程学习者'}",
            "constraints": ["只能使用给定材料和已验证课程知识", "结论必须说明适用条件", "关键判断必须标注来源"],
            "background": f"案例从本地知识库抽取 {len(evidence)} 条证据，面向{getattr(profile, 'major_direction', '') or '当前课程'}学生，用于把知识点转成可分析任务。",
            "task": f"根据资料证据分析“{goal}”在真实题目或课程场景中的作用，并写出判断依据。",
            "studentPrompt": f"先不要查看专家结论。请写出你对“{goal}”的判断、两个依据和一个仍不确定的条件。",
            "materials": [{"title": item["title"], "snippet": item["snippet"], "sourceId": item["sourceId"]} for item in evidence[:4]],
            "decisionPoints": ["当前场景是否满足知识点的适用条件", "哪条材料能够直接支持关键判断", "方案收益与潜在风险如何权衡"],
            "analysisSteps": analysis_steps,
            "steps": analysis_steps,
            "expertAnalysis": expert_analysis,
            "analysis": expert_analysis,
            "rubric": ["识别对象和限制", "引用材料证据", "推理过程完整", "结论与条件一致", "指出风险或例外"],
            "reflection": "完成后把不会的条件写入错题本，下一轮推荐会优先补同类资料。",
            "sourceIds": source_ids,
        }
    if resource_type == "code_lab":
        keywords = _keywords_for_goal(goal, evidence)[:4]
        expected_score = _code_lab_expected_score(keywords, evidence[:4])
        return {
            "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
            "language": "Python",
            "objective": f"用一段可运行脚本把“{goal}”转成可观察、可修改、可复盘的实验结果。",
            "environment": "Python 3.10+，只依赖标准库；如需绘图可自行扩展 matplotlib。",
            "concepts": keywords or [goal],
            "starterCode": "\n".join([
                "from dataclasses import dataclass",
                "",
                "@dataclass",
                "class Evidence:",
                "    title: str",
                "    weight: float",
                "",
                "def score_understanding(keywords, evidences):",
                "    matched = 0",
                "    for keyword in keywords:",
                "        if any(keyword in evidence.title for evidence in evidences):",
                "            matched += 1",
                "    return round(matched / max(1, len(keywords)), 2)",
                "",
                "evidences = [",
                *[f"    Evidence({json.dumps(item['title'], ensure_ascii=False)}, {round(1 - index * 0.08, 2)})," for index, item in enumerate(evidence[:4])],
                "]",
                f"keywords = [{', '.join(json.dumps(token, ensure_ascii=False) for token in keywords)}]",
                "print(score_understanding(keywords, evidences))",
            ]),
            "steps": [
                "阅读讲解文档中的核心定义，确认实验要观察的关键词。",
                "运行 starterCode，理解 evidence、keywords 和评分函数的含义。",
                "把关键词替换成你在资料中看到的关键术语，观察分数变化。",
                "新增一条来自本地资料的 Evidence，确认代码能处理更多来源。",
                "把实验结论写成 3 行：依据、判断、下一步复习动作。",
            ],
            "expectedOutput": "输出 0.0 到 1.0 之间的小数；分数越高，说明关键词和资料证据匹配越充分。",
            "testCases": [
                {
                    "name": "默认资料匹配分",
                    "stdin": "",
                    "expectedStdout": f"{expected_score}\n",
                }
            ],
            "hints": [
                "先运行原始代码，记录默认输出，再开始修改。",
                "如果输出不符合预期，先检查输入、循环边界和返回值。",
                "一次只改一个变量，并比较修改前后的输出。",
            ],
            "commonFailures": [
                "把关键词匹配写成完全相等，导致近义术语无法命中。",
                "修改输入后没有同步更新预期输出。",
                "只看最终数字，没有解释数字对应的课程含义。",
            ],
            "checkpoints": [
                "能说明每条 Evidence 来自哪份资料。",
                "能解释关键词为什么能代表当前知识点。",
                "能修改输入并预测输出变化。",
                "能把实验发现写回今日任务或错题复盘。",
            ],
            "extension": "把 score_understanding 改成同时计算资料来源权重，比较不同课件/文本对当前知识点的支持程度。",
            "evidence": _join_snippets(evidence[:3]),
            "sourceIds": source_ids,
        }
    return {
        "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
        "shots": [
            {"scene": "开场定位", "durationSeconds": 8, "visual": "学生面对抽象概念的困惑表情，背景保持干净，不出现任何文字或符号", "narration": f"今天围绕“{goal}”，先解决你最容易混淆的判断条件。", "sourceIds": source_ids[:1]},
            {"scene": "资料证据", "durationSeconds": 12, "visual": "教材、笔记和资料卡片以图标形式聚合，使用颜色高亮，不展示可读文字", "narration": _short_snippet(evidence, 0), "sourceIds": source_ids[:2]},
            {"scene": "概念拆解", "durationSeconds": 14, "visual": "四个无文字图标依次点亮，表示对象、条件、过程和结果", "narration": f"把“{goal}”拆成对象、条件、过程和结果，先看条件是否满足。", "sourceIds": source_ids[:3]},
            {"scene": "步骤演示", "durationSeconds": 16, "visual": "用箭头、节点和颜色变化展示逐步推理，不出现板书文字", "narration": _step_explanation(goal, evidence)[:180], "sourceIds": source_ids[:3]},
            {"scene": "易错提醒", "durationSeconds": 10, "visual": "错误路径变暗、正确路径高亮，用图标表达，不出现字母或汉字", "narration": _misconception_text(goal, weak_points, evidence)[:160], "sourceIds": source_ids[:2]},
            {"scene": "即时练习", "durationSeconds": 12, "visual": "学生暂停思考，屏幕仅出现抽象选择卡片和倒计时图标，不出现题干文字", "narration": f"暂停 20 秒，回答：什么时候不能直接使用“{goal}”？", "sourceIds": source_ids[:2]},
            {"scene": "收束行动", "durationSeconds": 8, "visual": "学习路径、练习和错题本用三个简洁图标串联，不出现界面文字", "narration": "完成后进入专项练习，系统会把结果回写画像和下一轮推荐。", "sourceIds": source_ids[:1]},
        ],
        "style": {"pace": "短句、图解、先证据后结论", "preferredFormats": preferred},
        "sourceIds": source_ids,
    }


def _lecture_doc_sections(goal: str, evidence: list[dict], source_ids: list[str], profile_line: str, weak_points: list[str]) -> list[dict]:
    if _is_deadlock_topic(goal, evidence):
        return _deadlock_lecture_sections(goal, evidence, source_ids, profile_line)
    primary = evidence[0]["snippet"] if evidence else goal
    return [
        {"heading": "学习目标", "body": f"围绕“{goal}”建立可复述、可做题、可迁移到课程任务的理解。{profile_line}", "sourceIds": source_ids[:2]},
        {"heading": "先修知识", "body": f"先确认相关术语、背景场景和公式/协议/流程含义。资料证据：{_join_snippets(evidence[:2])}", "sourceIds": source_ids[:2]},
        {"heading": "核心概念拆解", "body": f"先给出一句话定义：{primary}。再明确概念边界、适用条件、典型表现和判断依据，避免把相近概念混为一谈。", "sourceIds": source_ids[:3]},
        {"heading": "推导与步骤", "body": _step_explanation(goal, evidence), "sourceIds": source_ids[:4]},
        {"heading": "例题/场景应用", "body": f"选取资料中的场景，先写出已知条件，再说明为什么要使用“{goal}”，最后给出判断或计算结论。", "sourceIds": source_ids[:4]},
        {"heading": "常见误区", "body": _misconception_text(goal, weak_points, evidence), "sourceIds": source_ids[:3]},
        {"heading": "课后复盘", "body": "用 3 句话完成复盘：概念是什么、证据来自哪份资料、下一题如何判断是否该用这个知识点。", "sourceIds": source_ids[:2]},
    ]


def _deadlock_lecture_sections(goal: str, evidence: list[dict], source_ids: list[str], profile_line: str) -> list[dict]:
    evidence_text = _join_snippets(evidence[:2]) or "死锁是多个进程因竞争资源而互相等待，导致都无法继续推进的状态。"
    return [
        {
            "heading": "学习目标",
            "body": f"本讲围绕“{goal}”建立三件事：能判断什么是死锁，能说明死锁产生条件，能用银行家算法分析系统是否安全。{profile_line}",
            "sourceIds": source_ids[:2],
        },
        {
            "heading": "生活化引入",
            "body": "可以把死锁理解成两个人各拿着对方需要的工具，同时又不愿先放下自己手里的工具。两人都在等待对方释放资源，结果谁也无法继续。操作系统中的进程竞争打印机、磁带机、锁等资源时，也可能出现这种互相等待。",
            "sourceIds": source_ids[:2],
        },
        {
            "heading": "核心概念拆解",
            "body": f"死锁是多个进程在并发执行中，因为争夺有限资源而形成的永久等待状态。关键词不是“慢”或“暂时阻塞”，而是形成互相等待链，且没有外部干预就无法继续。资料证据：{evidence_text}",
            "sourceIds": source_ids[:3],
        },
        {
            "heading": "死锁的四个必要条件",
            "body": "死锁同时满足四个必要条件：1. 互斥，一个资源同一时刻只能被一个进程占用；2. 占有并等待，进程已经占有部分资源，同时继续请求新资源；3. 不可剥夺，资源不能被系统强行抢走，只能由占有者主动释放；4. 循环等待，存在 P1 等 P2、P2 等 P3、最终又等回 P1 的等待环。破坏任意一个条件，都可以预防死锁。",
            "sourceIds": source_ids[:3],
        },
        {
            "heading": "资源分配图怎么判断",
            "body": "资源分配图用圆表示进程，用方框表示资源。进程指向资源表示请求边，资源指向进程表示分配边。若图中不存在环，一定没有死锁；若每类资源只有一个实例，出现环就意味着死锁；若某类资源有多个实例，有环只说明可能死锁，还需要进一步检测。",
            "sourceIds": source_ids[:4],
        },
        {
            "heading": "处理死锁的四类方法",
            "body": "死锁处理通常分为四类：预防，通过破坏四个必要条件避免死锁；避免，在分配前判断是否会进入不安全状态，典型方法是银行家算法；检测，允许系统运行后定期检查是否已经死锁；解除，发现死锁后通过撤销进程、回滚或剥夺资源恢复系统。",
            "sourceIds": source_ids[:4],
        },
        {
            "heading": "银行家算法步骤",
            "body": "银行家算法用 Available、Max、Allocation、Need 四类数据判断系统是否安全。Need = Max - Allocation。判断时先找一个 Need 小于等于 Available 的进程，假设它能完成并释放 Allocation；更新 Available 后继续寻找下一个进程。如果能让所有进程依次完成，就存在安全序列，系统处于安全状态；否则是不安全状态。",
            "sourceIds": source_ids[:4],
        },
        {
            "heading": "常见误区",
            "body": "第一，不安全状态不一定已经死锁，只是未来可能进入死锁。第二，资源分配图有环不一定死锁，要看资源实例数量。第三，阻塞、饥饿和死锁不同：阻塞可能很快解除，饥饿是长期得不到资源，死锁是多个进程构成互相等待。第四，银行家算法判断的是安全性，不是直接检测当前是否已经死锁。",
            "sourceIds": source_ids[:3],
        },
        {
            "heading": "课后复盘",
            "body": "复习时按这条线索自测：先说出死锁定义，再背出四个必要条件，然后画资源分配图，最后用银行家算法判断是否存在安全序列。做题时优先写 Need 表和 Available 变化过程，避免只凭直觉判断。",
            "sourceIds": source_ids[:2],
        },
    ]


def _normalized_resource_sources(sources: list[dict], *, limit: int, goal: str) -> list[dict]:
    normalized: list[dict] = []
    require_deadlock_evidence = _is_deadlock_topic(goal, [])
    for index, source in enumerate(sources or [], start=1):
        if not isinstance(source, dict):
            continue
        snippet = str(source.get("snippet") or "").strip()
        if not snippet:
            continue
        if require_deadlock_evidence and not _source_mentions_deadlock(source):
            continue
        normalized.append({
            "id": str(source.get("id") or f"source-{index}"),
            "title": str(source.get("title") or f"资料片段 {index}"),
            "location": str(source.get("location") or "本地知识库"),
            "type": str(source.get("type") or "RAG"),
            "score": source.get("score"),
            "snippet": snippet[:900],
        })
        if len(normalized) >= limit:
            break
    if normalized:
        return normalized
    return [{
        "id": "learning-state",
        "title": goal,
        "location": "当前学习目标",
        "type": "学习状态",
        "score": None,
        "snippet": f"当前学习目标是“{goal}”，资源基于画像、学习路径和今日任务生成。",
    }]


def _source_mentions_deadlock(source: dict) -> bool:
    text = f"{source.get('title', '')} {source.get('snippet', '')} {source.get('location', '')}"
    return any(keyword in text for keyword in ("死锁", "银行家", "资源分配图", "循环等待", "deadlock", "Deadlock"))


def _fallback_mind_map_content(goal: str, evidence: list[dict], source_ids: list[str], weak_points: list[str], profile: LearnerProfile | None) -> dict:
    topic = str(goal or "").strip() or "当前学习主题"
    if _is_deadlock_topic(topic, evidence):
        nodes = [
            {
                "label": "概念边界",
                "children": [
                    "死锁：一组进程互相等待对方占有的资源，导致都无法继续推进",
                    "先区分：饥饿是长期得不到资源，死锁是循环等待导致系统停住",
                    "判断口径：看是否存在不可推进的等待闭环，而不是只看阻塞数量",
                ],
                "sourceIds": source_ids[:2],
            },
            {
                "label": "四个必要条件",
                "children": [
                    "互斥：资源一次只能被一个进程使用",
                    "占有并等待：已拿到资源的进程继续请求新资源",
                    "不可抢占：资源不能被系统强制剥夺，只能主动释放",
                    "循环等待：进程之间形成首尾相接的等待链",
                ],
                "sourceIds": source_ids[:3],
            },
            {
                "label": "资源分配图",
                "children": [
                    "请求边：进程 -> 资源，表示进程正在等待资源",
                    "分配边：资源 -> 进程，表示资源实例已经分给进程",
                    "单实例资源：有环通常可判定死锁",
                    "多实例资源：有环只是风险信号，还要结合可用实例判断",
                ],
                "sourceIds": source_ids[:3],
            },
            {
                "label": "处理策略对比",
                "children": [
                    "预防：破坏四个必要条件之一，保守但实现直接",
                    "避免：分配前判断是否仍处于安全状态",
                    "检测：允许发生，周期性找等待环或不可完成进程集合",
                    "解除：撤销进程、回滚状态或抢占资源，代价较高",
                ],
                "sourceIds": source_ids[:4],
            },
            {
                "label": "银行家算法",
                "children": [
                    "核心表：Available、Max、Allocation、Need",
                    "请求检查：Request <= Need 且 Request <= Available",
                    "试探分配：临时扣减 Available、增加 Allocation、减少 Need",
                    "安全性检测：能找到安全序列才真正分配",
                ],
                "sourceIds": source_ids[:4],
            },
            {
                "label": "检测与解除",
                "children": [
                    "检测输入：当前可用资源、已分配矩阵、请求矩阵",
                    "检测输出：哪些进程无法完成，是否形成死锁集合",
                    "解除方式：终止进程、资源抢占、回滚检查点",
                    "选择原则：优先考虑代价、已运行时间、占用资源量和影响范围",
                ],
                "sourceIds": source_ids[:4],
            },
            {
                "label": "题型路径",
                "children": [
                    "概念题：先写定义，再列四个必要条件",
                    "判断题：画资源分配图，区分单实例和多实例",
                    "算法题：按银行家算法表格逐步找安全序列",
                    "简答题：从预防、避免、检测、解除四类策略横向对比",
                ],
                "sourceIds": source_ids[:3],
            },
            {
                "label": "错题提醒",
                "children": weak_points[:4] or [
                    "把有环直接等同于多实例死锁",
                    "忘记 Need = Max - Allocation",
                    "安全状态不等于一定不会等待，只表示存在完成顺序",
                    "解除死锁时只写终止进程，没说明代价和选择依据",
                ],
                "sourceIds": source_ids[:2],
            },
        ]
    else:
        nodes = [
            {"label": "概念边界", "children": [_short_snippet(evidence, 0) or f"先给出“{topic}”的一句话定义", "说明它解决什么问题", "列出容易混淆的相近概念"], "sourceIds": source_ids[:2]},
            {"label": "先修依赖", "children": ["相关术语", "输入输出关系", "公式/流程前提"], "sourceIds": source_ids[:2]},
            {"label": "核心机制", "children": [_short_snippet(evidence, 1) or "把过程拆成条件、步骤、结果", "关键步骤", "影响因素"], "sourceIds": source_ids[:3]},
            {"label": "证据来源", "children": [f"{item['sourceId']}：{item['title']}" for item in evidence[:4]], "sourceIds": source_ids[:4]},
            {"label": "题型路径", "children": ["概念判断题", "过程分析题", "迁移应用题", "错因复盘题"], "sourceIds": source_ids[:4]},
            {"label": "易错点", "children": weak_points or ["概念混淆", "条件遗漏", "结论没有引用依据"], "sourceIds": source_ids[:3]},
            {"label": "复习动作", "children": ["完成专项练习", "整理错题原因", "回到今日任务打卡"], "sourceIds": source_ids[:2]},
        ]

    markdown = _mind_map_markdown(topic, nodes)
    return {
        "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
        "root": topic,
        "algorithm": "evidence_guided_markdown_mindmap.v2",
        "layout": {"style": "radial", "primaryAxis": "exam_path", "sourceAware": True},
        "nodes": nodes,
        "markdown": markdown,
        "mermaid": _mind_map_mermaid(topic, nodes),
        "studyPath": _mind_map_study_path(topic, nodes, profile),
        "sourceIds": source_ids,
    }


def _is_deadlock_topic(goal: str, evidence: list[dict]) -> bool:
    text = goal + " " + " ".join(str(item.get("snippet") or "") for item in evidence[:4])
    return any(keyword in text for keyword in ("死锁", "银行家", "资源分配图", "循环等待", "deadlock", "Deadlock"))


def _mind_map_markdown(root: str, nodes: list[dict]) -> str:
    lines = [f"# {root}"]
    for node in nodes:
        lines.append(f"## {node['label']}")
        for child in node.get("children", [])[:6]:
            lines.append(f"- {child}")
    return "\n".join(lines)


def _mind_map_mermaid(root: str, nodes: list[dict]) -> str:
    lines = ["mindmap", f"  root(({_mermaid_label(root)}))"]
    for node in nodes[:8]:
        lines.append(f"    {_mermaid_label(str(node.get('label') or '分支'))}")
        for child in (node.get("children") or [])[:4]:
            lines.append(f"      {_mermaid_label(str(child))}")
    return "\n".join(lines)


def _mermaid_label(value: str) -> str:
    text = str(value or "").replace("\n", " ").replace("(", "（").replace(")", "）").strip()
    return text[:34] or "节点"


def _mind_map_study_path(root: str, nodes: list[dict], profile: LearnerProfile | None) -> list[dict]:
    daily_minutes = getattr(profile, "daily_study_time", 0) or 30
    chunk = 8 if daily_minutes <= 30 else 12
    return [
        {"step": 1, "title": "先看中心和一级分支", "minutes": chunk, "action": f"用自己的话说出“{root}”解决的问题"},
        {"step": 2, "title": "沿题型路径做题", "minutes": chunk, "action": "从概念、判断、算法、简答四类题各选一个"},
        {"step": 3, "title": "回写错因", "minutes": max(5, chunk - 3), "action": "把最不稳的分支加入错题本或今日复习"},
    ]


def _evidence_units(sources: list[dict], goal: str) -> list[dict]:
    units = []
    for index, source in enumerate(_normalized_resource_sources(sources, limit=6, goal=goal), start=1):
        units.append({
            "sourceId": f"S{index}",
            "title": source["title"],
            "location": source["location"],
            "snippet": source["snippet"],
            "score": source.get("score"),
        })
    return units


def _attach_content_defaults(content: dict, resource_type: str, sources: list[dict], *, mode: str) -> dict:
    next_content = dict(content)
    next_content.setdefault("schemaVersion", RESOURCE_CONTENT_SCHEMA_VERSION)
    next_content.setdefault("generationMode", mode)
    next_content.setdefault("resourceType", resource_type)
    next_content.setdefault("sourceIds", [f"S{index}" for index in range(1, min(len(sources), 6) + 1)])
    return next_content


def _try_llm_resource_content(resource_type: str, goal: str, sources: list[dict], profile: LearnerProfile | None, *, allow_llm: bool) -> tuple[dict | None, dict]:
    if not allow_llm:
        return None, {"attempted": False, "provider": "rules", "model": "", "error": ""}
    evidence = _evidence_units(sources, goal)
    try:
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "你是 A3 智学引擎的 ResourceSynthesisAgent。"
                        "只能基于给定本地知识库证据和学生画像生成学习资源。"
                        "必须输出 JSON object，不要 Markdown 代码围栏，不要编造教材页码、来源或系统不具备的执行能力。"
                        f"当前资源使用以下专业生成契约：{_resource_specialist_instructions(resource_type)}"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "resourceType": resource_type,
                            "goal": goal,
                            "learnerProfile": _profile_snapshot(profile),
                            "evidence": evidence,
                            "requirements": _resource_llm_requirements(resource_type),
                            "qualityChecklist": _resource_specialist_instructions(resource_type),
                            "schemaVersion": RESOURCE_CONTENT_SCHEMA_VERSION,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0.25,
            max_tokens=int(os.getenv("A3_RESOURCE_LLM_MAX_TOKENS", "3600")),
            timeout_seconds=float(os.getenv("A3_RESOURCE_LLM_TIMEOUT_SECONDS", os.getenv("A3_LLM_TIMEOUT_SECONDS", "45"))),
            response_format={"type": "json_object"},
        )
        content = json.loads(result["content"])
        if not isinstance(content, dict):
            raise ValueError("LLM JSON root is not an object")
        return content, {
            "attempted": True,
            "provider": str(result.get("provider") or "dashscope"),
            "model": str(result.get("model") or ""),
            "finishReason": str(result.get("finishReason") or ""),
        }
    except (LLMUnavailable, ValueError, TypeError, json.JSONDecodeError) as exc:
        return None, {"attempted": True, "provider": "dashscope", "model": os.getenv("A3_LLM_MODEL", ""), "error": str(exc)}
    except Exception as exc:
        return None, {"attempted": True, "provider": "dashscope", "model": os.getenv("A3_LLM_MODEL", ""), "error": str(exc)}


def _resource_llm_enabled(*, full_pack: bool = False) -> bool:
    flag = os.getenv("A3_RESOURCE_LLM_ENABLED", "auto").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    if "test" in sys.argv and flag == "auto":
        return False
    has_key = bool((os.getenv("A3_LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip())
    if full_pack and flag == "auto":
        return os.getenv("A3_RESOURCE_LLM_FULL_PACK_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"} and has_key
    return has_key if flag == "auto" else flag in {"1", "true", "yes", "on"}


def _resource_llm_requirements(resource_type: str) -> dict:
    return {
        "lecture_doc": {"sections": "至少 6 节，每节含 heading/body/sourceIds，覆盖目标、先修、概念、步骤、例题、误区、复盘"},
        "knowledge_card": {"cards": "至少 4 张 front/back/sourceIds 卡片"},
        "mind_map": {"nodes": "至少 7 个一级节点，每个 3-5 个 children，并标 sourceIds；同时输出 markdown 和 mermaid。结构必须像真实思维导图：中心主题、概念边界、核心机制、证据来源、题型路径、易错点、复习动作。操作系统死锁主题必须覆盖四个必要条件、资源分配图、银行家算法、检测与解除"},
        "practice_set": {
            "questions": "至少 8 题；每题包含 id/type/knowledgePoint/difficulty/stem/answer/explanation/distractorAnalysis/commonMistake/evaluationRubric/sourceIds；选择题还需 options，覆盖概念、条件判断、应用、分析、纠错和迁移，并形成难度梯度",
        },
        "case_study": {
            "case": "包含 scenario/role/constraints/background/task/studentPrompt/materials/decisionPoints/analysisSteps/expertAnalysis/rubric/reflection/sourceIds；材料必须足以让学生先判断，专家分析不能提前写进学生任务",
        },
        "code_lab": {
            "lab": "language 必须是 Python；包含 objective/environment/concepts/starterCode/steps/expectedOutput/testCases/hints/commonFailures/checkpoints/extension/sourceIds；代码只依赖标准库，testCases 必须能用于真实 runner 判题",
        },
        "micro_video_script": {"shots": "至少 7 个镜头，每个含 scene/durationSeconds/visual/narration/sourceIds；visual 只能描述无文字画面，所有中文概念放到 narration，不要要求视频模型生成板书、字幕、标题或屏幕文字"},
    }[resource_type]


def _resource_specialist_instructions(resource_type: str) -> str:
    specialists = {
        "practice_set": (
            "你是 PracticeSetSpecialist。围绕学生薄弱点设计逐题反馈练习；题型和难度必须有梯度；"
            "选择题干扰项要对应真实误区；解析必须说明条件、推理和证据；不得在题干中泄露答案。"
        ),
        "case_study": (
            "你是 CaseStudySpecialist。设计可供学生先判断、再查看专家拆解的案例；"
            "场景必须包含角色、约束、材料和信息差；决策点可比较；专家分析必须独立于学生任务。"
        ),
        "code_lab": (
            "你是 CodeLabSpecialist。生成可由真实 runner 执行的 Python 标准库实验；"
            "代码、预期输出和测试用例必须一致；提供分层提示、常见失败、检查点和扩展挑战；不得虚构运行结果。"
        ),
    }
    return specialists.get(resource_type, "生成结构完整、证据可追溯、适合当前画像的学习资源。")


def _resource_content_quality(resource_type: str, content: dict | None) -> dict:
    if not isinstance(content, dict):
        return _quality_report([("valid_json", False, "内容不是 JSON object")])
    if resource_type == "practice_set":
        questions = [item for item in content.get("questions") or [] if isinstance(item, dict)]
        question_types = {str(item.get("type") or "") for item in questions}
        checks = [
            ("question_count", len(questions) >= 8, f"题目数 {len(questions)}/8"),
            ("question_variety", len(question_types) >= 6, f"题型数 {len(question_types)}/6"),
            ("learning_metadata", all(item.get("id") and item.get("knowledgePoint") and item.get("difficulty") for item in questions), "每题包含 ID、知识点和难度"),
            ("feedback_quality", all(item.get("answer") and item.get("explanation") and item.get("commonMistake") and item.get("evaluationRubric") for item in questions), "每题包含答案、解析、错因和量规"),
            ("grounding", bool(questions) and all(item.get("sourceIds") for item in questions), "每题包含来源"),
        ]
        return _quality_report(checks, required={"grounding"})
    if resource_type == "case_study":
        checks = [
            ("scenario", bool(content.get("scenario") and content.get("role") and content.get("constraints")), "场景、角色和约束完整"),
            ("materials", len(content.get("materials") or []) >= 2, "至少两条案例材料"),
            ("decision_task", bool(content.get("task") and content.get("studentPrompt") and len(content.get("decisionPoints") or []) >= 2), "学生任务和决策点完整"),
            ("expert_analysis", len(content.get("analysisSteps") or []) >= 4 and bool(content.get("expertAnalysis")), "专家拆解完整"),
            ("rubric_grounding", len(content.get("rubric") or []) >= 3 and bool(content.get("sourceIds")), "评价量规和来源完整"),
        ]
        return _quality_report(checks, required={"rubric_grounding"})
    if resource_type == "code_lab":
        test_cases = [item for item in content.get("testCases") or [] if isinstance(item, dict)]
        checks = [
            ("runner_language", str(content.get("language") or "").lower() == "python", "使用 Python runner"),
            ("runnable_contract", bool(content.get("objective") and content.get("environment") and content.get("starterCode")), "目标、环境和代码完整"),
            ("learning_steps", len(content.get("concepts") or []) >= 1 and len(content.get("steps") or []) >= 5, "概念和实验步骤完整"),
            ("test_contract", bool(test_cases) and all("expectedStdout" in item for item in test_cases), "测试用例包含预期输出"),
            ("debug_support", len(content.get("checkpoints") or []) >= 4 and len(content.get("hints") or []) >= 2 and len(content.get("commonFailures") or []) >= 2 and bool(content.get("extension") and content.get("sourceIds")), "检查点、提示、失败诊断和来源完整"),
        ]
        return _quality_report(checks, required={"test_contract"})
    passed = _is_rich_resource_content(resource_type, content)
    return _quality_report([("legacy_rich_content", passed, "满足现有资源完整性规则")])


def _quality_report(checks: list[tuple[str, bool, str]], *, required: set[str] | None = None) -> dict:
    normalized = [{"name": name, "passed": bool(passed), "detail": detail} for name, passed, detail in checks]
    score = round(sum(1 for item in normalized if item["passed"]) / max(1, len(normalized)) * 100)
    required = required or set()
    required_passed = all(item["passed"] for item in normalized if item["name"] in required)
    return {"passed": score >= 80 and required_passed, "score": score, "checks": normalized}


def _is_rich_resource_content(resource_type: str, content: dict) -> bool:
    if not isinstance(content, dict):
        return False
    if resource_type == "lecture_doc":
        return len(content.get("sections") or []) >= 6
    if resource_type == "knowledge_card":
        return len(content.get("cards") or []) >= 4 or bool(content.get("front") and content.get("back"))
    if resource_type == "mind_map":
        return len(content.get("nodes") or []) >= 5 and bool(content.get("markdown") or content.get("mermaid"))
    if resource_type == "practice_set":
        return len(content.get("questions") or []) >= 6
    if resource_type == "case_study":
        return bool(content.get("scenario") and content.get("steps") and content.get("analysis"))
    if resource_type == "code_lab":
        return bool(content.get("starterCode") and len(content.get("steps") or []) >= 4 and len(content.get("checkpoints") or []) >= 3)
    if resource_type == "micro_video_script":
        return len(content.get("shots") or []) >= 6
    return True


def _join_snippets(evidence: list[dict]) -> str:
    return "；".join(str(item.get("snippet") or "")[:140] for item in evidence if item.get("snippet"))


def _code_lab_expected_score(keywords: list[str], evidence: list[dict]) -> float:
    matched = 0
    titles = [str(item.get("title") or "") for item in evidence]
    for keyword in keywords:
        if any(str(keyword) in title for title in titles):
            matched += 1
    return round(matched / max(1, len(keywords)), 2)


def _short_snippet(evidence: list[dict], index: int) -> str:
    if not evidence:
        return ""
    item = evidence[index % len(evidence)]
    return str(item.get("snippet") or "")[:120]


def _profile_learning_line(profile: LearnerProfile | None) -> str:
    if not profile:
        return "当前画像不足，先按课程目标和资料证据组织学习。"
    weak = "、".join(profile.weak_points or []) or "暂未记录"
    preferred = "、".join(profile.expected_resources or []) or "综合资源"
    return f"画像显示基础为“{profile.foundation_level or '未评估'}”，薄弱点为“{weak}”，偏好“{preferred}”。"


def _step_explanation(goal: str, evidence: list[dict]) -> str:
    return (
        f"处理“{goal}”时先定位资料中的定义，再抽取适用条件；"
        f"然后把条件代入题目或场景，检查是否存在例外；"
        f"最后用证据支撑结论。关键依据包括：{_join_snippets(evidence[:3])}。"
    )


def _misconception_text(goal: str, weak_points: list[str], evidence: list[dict]) -> str:
    weak = "、".join(weak_points) if weak_points else "概念边界、适用条件、结论表述"
    return f"学习“{goal}”时容易把{weak}混在一起。先回到资料证据确认条件，再写结论，避免只背定义不看场景。"


def _practice_stem(kind: str, goal: str, evidence: list[dict], index: int) -> str:
    prompts = {
        "concept": f"用 2 句话解释“{goal}”的核心含义，并标出一个关键词。",
        "choice": f"下列哪种情况最需要优先使用“{goal}”进行判断？请说明理由。",
        "fill_blank": f"补全句子：“{goal}”的判断不能只看结论，还要先确认____和____。",
        "application": f"根据资料片段：{_short_snippet(evidence, index)}，说明它如何支持“{goal}”。",
        "analysis": f"把“{goal}”拆成对象、条件、过程、结果四部分。",
        "debug": f"一个同学直接套用“{goal}”但没有检查适用条件，这个解法哪里有风险？",
        "transfer": f"把“{goal}”迁移到一个新的课程场景，写出你会先问的 3 个问题。",
        "reflection": f"如果这题做错了，错因更可能是概念不清、条件遗漏还是证据不足？请写出复盘动作。",
    }
    return prompts[kind]


def _practice_answer(kind: str, goal: str, evidence: list[dict], index: int) -> str:
    if kind == "fill_blank":
        return "适用条件；资料证据"
    if kind == "choice":
        return "B"
    if kind == "debug":
        return "风险在于跳过条件检查，可能把相似概念或不适用场景误判为同一类问题。"
    return f"答案应围绕“{goal}”并引用资料证据：{_short_snippet(evidence, index)}"


def _practice_choice_options(goal: str) -> list[str]:
    return [
        f"A. 只要题目出现“{goal}”就直接套用结论",
        f"B. 先确认对象、适用条件和资料证据，再使用“{goal}”判断",
        "C. 忽略题目条件，只比较最终数值",
        "D. 只凭记忆选择最熟悉的术语",
    ]


def _practice_distractor_analysis(goal: str) -> list[str]:
    return [
        f"A 错在把术语出现当成适用条件，缺少对“{goal}”边界的检查。",
        "C 错在跳过过程和约束，最终数值相同也可能来自不同机制。",
        "D 错在没有使用题目材料和可验证证据。",
    ]


def _practice_common_mistake(kind: str, goal: str) -> str:
    if kind == "choice":
        return f"看到“{goal}”相关术语就立即选答案，没有核对条件。"
    if kind in {"application", "analysis", "debug", "transfer"}:
        return "只写结论，没有展开对象、条件、过程和证据之间的关系。"
    return "只背定义，没有用自己的话说明边界、例外和证据。"


def _practice_explanation(kind: str, goal: str, evidence: list[dict], index: int) -> str:
    return f"解析：先从本地资料抽取证据，再判断它和“{goal}”的关系。参考证据：{_short_snippet(evidence, index)}"


def _keywords_for_goal(goal: str, evidence: list[dict]) -> list[str]:
    tokens = [part for part in goal.replace("，", " ").replace("、", " ").split() if part]
    for item in evidence[:3]:
        snippet = str(item.get("snippet") or "")
        for token in snippet.replace("，", " ").replace("。", " ").replace("、", " ").split():
            if 2 <= len(token) <= 12 and token not in tokens:
                tokens.append(token)
            if len(tokens) >= 6:
                return tokens
    return tokens or [goal]


def _store_resource_pack(user, pack: dict) -> None:
    pack = compact_resource_pack_payload(pack)
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    packs = [item for item in extra.get("resourcePacks", []) if isinstance(item, dict)]
    packs.insert(0, pack)
    extra["resourcePacks"] = packs[:30]
    _append_learning_event(
        extra,
        "resource_pack_generated",
        f"生成资源包：{pack.get('goal')}",
        {"resourceTypes": [item.get("type") for item in pack.get("resources", [])]},
    )
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    ResourcePackLog.objects.update_or_create(
        user=user,
        task_id=f"resource-pack:{pack['resourcePackId']}",
        defaults={
            "task_title": _resource_pack_log_text(pack.get("goal", "")),
            "learning_goal": _resource_pack_log_text(pack.get("goal", "")),
            "verified_source_count": sum(len(item.get("citations") or []) for item in pack.get("resources", [])),
            "confidence": "high",
            "practice_href": next(
                (item.get("href") for item in pack.get("nextActions", []) if item.get("href", "").startswith("/a3/assessment")),
                "/a3/assessment",
            ),
            "source": "resource_generation",
            "next_step_reason": "资源包生成后进入讲解、练习和效果评估闭环。",
            "payload": pack,
        },
    )


def _update_resource_pack_artifact(user, pack_id: str, artifact: dict) -> dict:
    _record_openmaic_artifact_row(user, pack_id, artifact)
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    packs = [item for item in extra.get("resourcePacks", []) if isinstance(item, dict)]
    updated_pack: dict | None = None
    for index, item in enumerate(packs):
        if str(item.get("resourcePackId")) != str(pack_id):
            continue
        next_pack = dict(item)
        artifacts = [entry for entry in next_pack.get("multimodalArtifacts", []) if isinstance(entry, dict)]
        artifacts = [entry for entry in artifacts if entry.get("jobId") != artifact.get("jobId")]
        artifacts.insert(0, artifact)
        next_pack["multimodalArtifacts"] = artifacts[:10]
        next_actions = [entry for entry in next_pack.get("nextActions", []) if isinstance(entry, dict)]
        if artifact.get("classroomUrl") and not any(entry.get("label") == "OpenMAIC 课堂" for entry in next_actions):
            next_actions.insert(
                0,
                {
                    "label": "OpenMAIC 课堂",
                    "href": artifact["classroomUrl"],
                    "reason": "基于画像、薄弱点和知识库引用生成的互动课堂，可继续导出 PPTX。",
                },
            )
        next_pack["nextActions"] = next_actions
        packs[index] = next_pack
        updated_pack = next_pack
        break
    if not updated_pack:
        raise ValueError("璧勬簮鍖呬笉瀛樺湪")

    extra["resourcePacks"] = packs[:30]
    _append_learning_event(
        extra,
        "openmaic_classroom_generated",
        f"OpenMAIC 课堂产物已回写：{updated_pack.get('goal')}",
        {
            "packId": pack_id,
            "jobId": artifact.get("jobId"),
            "classroomId": artifact.get("classroomId"),
            "status": artifact.get("status"),
        },
    )
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    ResourcePackLog.objects.update_or_create(
        user=user,
        task_id=f"resource-pack:{pack_id}",
        defaults={
            "task_title": _resource_pack_log_text(updated_pack.get("goal", "")),
            "learning_goal": _resource_pack_log_text(updated_pack.get("goal", "")),
            "verified_source_count": sum(len(item.get("citations") or []) for item in updated_pack.get("resources", [])),
            "confidence": "high",
            "practice_href": next(
                (item.get("href") for item in updated_pack.get("nextActions", []) if str(item.get("href", "")).startswith("/a3/assessment")),
                "/a3/assessment",
            ),
            "source": "resource_generation",
            "next_step_reason": "OpenMAIC 课堂生成结果已进入 A3 资源包，可继续学习、导出和反馈。",
            "payload": updated_pack,
        },
    )
    return _attach_openmaic_artifacts(user, updated_pack)


def _resource_pack_log_text(value: object, limit: int = 160) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _record_openmaic_artifact_row(user, pack_id: str, artifact: dict) -> None:
    artifact_type = str(artifact.get("type") or "")
    if artifact_type not in OPENMAIC_ARTIFACT_TYPES:
        return
    job_id = str(artifact.get("jobId") or "").strip()
    defaults = {
        "status": str(artifact.get("status") or "unknown"),
        "provider": str(artifact.get("provider") or ""),
        "payload": dict(artifact),
    }
    if job_id:
        OpenMAICArtifact.objects.update_or_create(
            user=user,
            resource_pack_id=str(pack_id),
            artifact_type=artifact_type,
            job_id=job_id,
            defaults=defaults,
        )
        return
    OpenMAICArtifact.objects.create(
        user=user,
        resource_pack_id=str(pack_id),
        artifact_type=artifact_type,
        job_id="",
        **defaults,
    )


def _attach_openmaic_artifacts(user, pack: dict) -> dict:
    if not isinstance(pack, dict):
        return pack
    pack_id = str(pack.get("resourcePackId") or "")
    if not pack_id:
        return pack
    next_pack = dict(pack)
    audit_artifacts = _openmaic_artifact_history(user, pack_id)
    legacy_artifacts = [
        entry
        for entry in next_pack.get("multimodalArtifacts", [])
        if isinstance(entry, dict) and entry.get("type") in OPENMAIC_ARTIFACT_TYPES
    ]
    merged: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for artifact in [*audit_artifacts, *legacy_artifacts]:
        key = (str(artifact.get("type") or ""), str(artifact.get("jobId") or artifact.get("createdAt") or ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(artifact)
    next_pack["multimodalArtifacts"] = sorted(merged, key=_artifact_sort_key, reverse=True)[:30]
    return next_pack


def _openmaic_artifact_history(user, pack_id: str) -> list[dict]:
    records = OpenMAICArtifact.objects.filter(user=user, resource_pack_id=str(pack_id)).order_by("-created_at", "-id")[:30]
    return [_serialize_openmaic_artifact_record(record) for record in records]


def _serialize_openmaic_artifact_record(record: OpenMAICArtifact) -> dict:
    payload = dict(record.payload or {})
    payload.setdefault("type", record.artifact_type)
    payload.setdefault("status", record.status)
    payload.setdefault("provider", record.provider)
    payload.setdefault("jobId", record.job_id)
    payload.setdefault("createdAt", record.created_at.isoformat())
    payload.setdefault("resourcePackId", record.resource_pack_id)
    return payload


def _artifact_sort_key(artifact: dict) -> str:
    return str(artifact.get("createdAt") or artifact.get("completedAt") or "")


def _apply_resource_feedback_plan_adjustment(user, extra: dict, effect_report: dict) -> None:
    adjustment = effect_report.get("planAdjustment") if isinstance(effect_report, dict) else {}
    if not isinstance(adjustment, dict):
        return
    strategy = str(adjustment.get("strategy") or "")
    if strategy not in {"increase_practice", "reduce_load", "reinforce_mastery", "keep_current_pace"}:
        return

    plan = extra.get("studyPlan")
    if not isinstance(plan, dict):
        plan = current_study_plan(user) or generate_study_plan(user)
    if not isinstance(plan, dict):
        return

    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    if not days:
        return

    today = timezone.localdate().isoformat()
    day = next((item for item in days if isinstance(item, dict) and item.get("date") == today), None)
    if day is None:
        day = next((item for item in days if isinstance(item, dict) and int(item.get("dayIndex") or 0) == 1), days[0])
    if not isinstance(day, dict):
        return

    evidence = adjustment.get("evidence") if isinstance(adjustment.get("evidence"), dict) else {}
    latest_goal = str(evidence.get("latestGoal") or "").strip() or "current goal"
    task_id = f"resource-feedback:{strategy}:{_feedback_task_slug(latest_goal)}"
    tasks = day.setdefault("tasks", [])
    existing = next((task for task in tasks if isinstance(task, dict) and task.get("id") == task_id), None)
    if existing is None:
        tasks.insert(0, _resource_feedback_task(task_id, strategy, latest_goal, evidence, adjustment))

    _refresh_feedback_day_progress(day)
    plan["overallProgress"] = _feedback_plan_progress(days)
    plan["lastResourceFeedbackAdjustment"] = {
        **adjustment,
        "taskId": task_id,
        "appliedAt": timezone.now().isoformat(),
    }
    _append_feedback_adjustment_event(plan, strategy, latest_goal, adjustment, task_id)
    extra["studyPlan"] = plan


def _resource_feedback_task(task_id: str, strategy: str, latest_goal: str, evidence: dict, adjustment: dict) -> dict:
    next_action = adjustment.get("nextAction") if isinstance(adjustment.get("nextAction"), dict) else {}
    if strategy == "increase_practice":
        return {
            "id": task_id,
            "type": "practice",
            "title": f"{latest_goal} 补救专项练习",
            "subtitle": "资源学习后的反馈分数低于 80，系统自动追加一组短练习来确认薄弱点。",
            "href": _feedback_practice_href(latest_goal),
            "estimatedMinutes": 15,
            "knowledgePointId": "",
            "status": "pending",
            "metadata": {
                "generatedBy": "resource_feedback_adjustment",
                "strategy": strategy,
                "evidence": evidence,
                "nextAction": next_action,
            },
        }
    if strategy == "reinforce_mastery":
        return {
            "id": task_id,
            "type": "summary",
            "title": f"{latest_goal} 掌握巩固复盘",
            "subtitle": "资源学习反馈较好，系统追加一次 5 分钟复盘，把有效资源沉淀为可复用知识卡和下一步练习入口。",
            "href": "/a3/today",
            "estimatedMinutes": 5,
            "knowledgePointId": "",
            "status": "pending",
            "metadata": {
                "generatedBy": "resource_feedback_adjustment",
                "strategy": strategy,
                "evidence": evidence,
                "nextAction": next_action,
            },
        }
    return {
        "id": task_id,
        "type": "review",
        "title": f"{latest_goal} 轻量复盘",
        "subtitle": "近期跳过资源较多，先用 8 分钟复盘恢复连续性，再进入后续任务。",
        "href": "/a3/today",
        "estimatedMinutes": 8,
        "knowledgePointId": "",
        "status": "pending",
        "metadata": {
            "generatedBy": "resource_feedback_adjustment",
            "strategy": strategy,
            "evidence": evidence,
            "nextAction": next_action,
        },
    }


def _append_feedback_adjustment_event(plan: dict, strategy: str, latest_goal: str, adjustment: dict, task_id: str) -> None:
    timeline = plan.get("adjustmentTimeline")
    if not isinstance(timeline, list):
        timeline = []
    if any(isinstance(item, dict) and item.get("id") == task_id for item in timeline):
        plan["adjustmentTimeline"] = timeline
        return
    if strategy == "increase_practice":
        title = "资源反馈追加补救练习"
    elif strategy == "reinforce_mastery":
        title = "资源反馈追加掌握巩固"
    elif strategy == "reduce_load":
        title = "资源反馈触发计划减负"
    else:
        title = "资源反馈保持当前节奏"
    detail = (
        f"《{latest_goal}》资源反馈分数偏低，已加入补救专项练习。"
        if strategy == "increase_practice"
        else f"《{latest_goal}》资源学习反馈较好，已加入掌握巩固复盘。"
        if strategy == "reinforce_mastery"
        else f"《{latest_goal}》近期跳过较多，已加入轻量复盘任务。"
        if strategy == "reduce_load"
        else f"《{latest_goal}》资源反馈已记录，当前节奏保持观察并加入轻量复盘。"
    )
    timeline.insert(0, {
        "id": task_id,
        "type": "resource_feedback",
        "title": title,
        "detail": detail,
        "reason": str(adjustment.get("reason") or ""),
        "createdAt": timezone.now().isoformat(),
    })
    plan["adjustmentTimeline"] = timeline[:12]
    explanation = plan.get("explanation")
    if isinstance(explanation, dict):
        adjustments = [item for item in plan["adjustmentTimeline"] if isinstance(item, dict)][:5]
        explanation["adjustments"] = adjustments
        explanation["currentChange"] = adjustments[0] if adjustments else {}


def _plan_adjustment_strategy(*, completed: int, skipped: int, favorited: int, average_score: float) -> str:
    if skipped > completed:
        return "reduce_load"
    if completed and average_score and average_score < 80:
        return "increase_practice"
    if (completed or favorited) and average_score >= 80:
        return "reinforce_mastery"
    return "keep_current_pace"


def _plan_adjustment_reason(strategy: str) -> str:
    if strategy == "increase_practice":
        return "资源已完成但反馈分数低于 80，后续计划应增加专项练习和错题复盘。"
    if strategy == "reduce_load":
        return "跳过资源多于完成资源，后续计划应降低负荷并优先推送更短资源。"
    if strategy == "reinforce_mastery":
        return "资源完成反馈较好，后续计划应追加轻量复盘，把有效学习沉淀为长期记忆。"
    return "资源反馈与计划执行暂未显示明显风险，保持当前节奏并继续观察。"


def _plan_adjustment_next_action(strategy: str, latest_goal: str) -> dict:
    goal = quote(latest_goal) if latest_goal else ""
    if strategy == "increase_practice":
        return {
            "label": "进入专项练习",
            "href": f"/a3/assessment?practice={goal}" if goal else "/a3/assessment",
            "reason": "用练习结果继续回流画像、错题本和推荐排序。",
        }
    if strategy == "reduce_load":
        return {
            "label": "调整今日任务",
            "href": "/a3/today",
            "reason": "先降低任务压力，再用短资源恢复学习连续性。",
        }
    if strategy == "reinforce_mastery":
        return {
            "label": "写入今日复盘",
            "href": "/a3/today",
            "reason": "用 5 分钟复盘把高效资源沉淀为知识卡、错题提醒和后续推荐信号。",
        }
    return {
        "label": "继续今日计划",
        "href": "/a3/today",
        "reason": "保持当前节奏，继续收集资源使用和测评反馈。",
    }


def _append_learning_event(extra: dict, event_type: str, summary: str, signals: dict) -> None:
    events = [item for item in extra.get("learningEvents", []) if isinstance(item, dict)]
    events.insert(0, {
        "eventType": event_type,
        "summary": summary,
        "signals": signals,
        "importance": 0.7,
        "createdAt": timezone.now().isoformat(),
    })
    extra["learningEvents"] = events[:100]


def _profile_snapshot(profile: LearnerProfile | None) -> dict:
    if not profile:
        return {}
    return {
        "id": str(profile.id),
        "grade": profile.grade,
        "majorDirection": profile.major_direction,
        "foundationLevel": profile.foundation_level,
        "dailyStudyTime": profile.daily_study_time,
        "pace": profile.pace,
        "learningGoals": list(profile.learning_goals or []),
        "weakPoints": list(profile.weak_points or []),
        "learningPreferences": dict(profile.learning_preferences or {}),
        "expectedResources": list(profile.expected_resources or []),
        "dimensionCount": _profile_dimension_count(profile),
    }


def compact_resource_pack_payload(pack: dict) -> dict:
    compacted = dict(pack)
    snapshot = pack.get("learnerProfileSnapshot")
    if isinstance(snapshot, dict):
        compacted["learnerProfileSnapshot"] = {
            field: snapshot[field]
            for field in RESOURCE_PACK_PROFILE_SNAPSHOT_FIELDS
            if field in snapshot
        }
    return compacted


def _profile_dimension_count(profile: LearnerProfile | None) -> int:
    if not profile:
        return 0
    values = [
        profile.grade,
        profile.major_direction,
        profile.foundation_level,
        profile.daily_study_time,
        profile.learning_goals,
        profile.weak_points,
        profile.learning_preferences,
        profile.expected_resources,
        (profile.extra_profile or {}).get("motivationRisk"),
    ]
    return len([value for value in values if value])


def _personalization_reason(profile: LearnerProfile | None, resource_type: str) -> str:
    if not profile:
        return "根据当前学习目标生成；画像不足时使用标准学习资源组合。"
    prefs = "、".join(profile.expected_resources or []) or "综合资源"
    weak = "、".join(profile.weak_points or []) or "当前路径节点"
    return (
        f"匹配画像：基础={profile.foundation_level or '未评估'}，"
        f"薄弱点={weak}，偏好资源={prefs}，资源类型={resource_type}。"
    )


def _profile_tags(profile: LearnerProfile | None) -> list[str]:
    if not profile:
        return []
    return [
        profile.foundation_level or "",
        *(profile.weak_points or [])[:3],
        *(profile.expected_resources or [])[:2],
    ]


def _content_text(content: dict) -> str:
    return str(content)


def _estimated_minutes(resource_type: str) -> int:
    return {
        "lecture_doc": 12,
        "knowledge_card": 5,
        "mind_map": 8,
        "practice_set": 18,
        "case_study": 15,
        "code_lab": 20,
        "micro_video_script": 6,
    }[resource_type]


def _plan_task_count(plan: dict | None) -> int:
    if not isinstance(plan, dict):
        return 0
    return sum(len(day.get("tasks") or []) for day in plan.get("days", []) if isinstance(day, dict))


def _completed_plan_task_count(plan: dict | None) -> int:
    if not isinstance(plan, dict):
        return 0
    return sum(
        len([task for task in day.get("tasks") or [] if isinstance(task, dict) and task.get("status") == "completed"])
        for day in plan.get("days", [])
        if isinstance(day, dict)
    )


def _feedback_practice_href(latest_goal: str) -> str:
    return f"/a3/assessment?practice={quote(latest_goal)}" if latest_goal else "/a3/assessment"


def _feedback_task_slug(value: str) -> str:
    return "-".join(str(value or "").strip().lower().split())[:80] or uuid4().hex


def _refresh_feedback_day_progress(day: dict) -> None:
    tasks = [task for task in day.get("tasks", []) if isinstance(task, dict)]
    if not tasks:
        day["progress"] = 0
        day["estimatedMinutes"] = 0
        return
    day["estimatedMinutes"] = sum(_safe_int(task.get("estimatedMinutes"), 0) for task in tasks)
    day["progress"] = round(sum(1 for task in tasks if task.get("status") == "completed") * 100 / len(tasks))


def _feedback_plan_progress(days: list[dict]) -> int:
    tasks = [
        task
        for day in days
        if isinstance(day, dict)
        for task in day.get("tasks", [])
        if isinstance(task, dict)
    ]
    if not tasks:
        return 0
    return round(sum(1 for task in tasks if task.get("status") == "completed") * 100 / len(tasks))


def _safe_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
