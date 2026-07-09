from __future__ import annotations

from datetime import timedelta
from hashlib import sha1
from typing import Any

from django.utils import timezone

from backend.apps.compat.resource_generation import build_learning_effect_report
from backend.apps.learning.effect_events import aggregate_learning_events
from backend.apps.learning.resource_attribution import build_resource_effect_attribution
from backend.apps.profiles.models import LearnerProfile


POLICY_VERSION = "a3.policy-engine.v1"
REPORT_SCHEMA_VERSION = "a3.continuous-optimization-policy.v1"

POLICY_STRATEGIES = [
    "add_remedial_practice",
    "add_spaced_review",
    "add_diagnostic_practice",
    "reduce_new_content",
    "increase_challenge",
    "recommend_coaching",
]


def build_continuous_optimization_policy_report(user, *, days: int = 30, effect_report: dict | None = None) -> dict:
    safe_days = max(1, min(_safe_int(days, 30), 365))
    effect = effect_report if isinstance(effect_report, dict) else build_learning_effect_report(user, include_persisted_analysis=False)
    degraded_reasons: list[str] = []
    try:
        attribution = build_resource_effect_attribution(user, days=safe_days)
    except Exception as exc:
        degraded_reasons.append(f"resource attribution unavailable: {str(exc)[:180]}")
        attribution = _degraded_attribution_report(safe_days, str(exc))
    candidates = build_policy_candidates(effect, attribution)
    selected = max(candidates, key=lambda item: item["decisionScore"]) if candidates else _empty_candidate()
    missing = list(effect.get("missingEvidence") if isinstance(effect.get("missingEvidence"), list) else [])
    try:
        event_summary = aggregate_learning_events(user, days=safe_days)
    except Exception as exc:
        degraded_reasons.append(f"event stream unavailable: {str(exc)[:180]}")
        event_summary = {"totalEvents": 0, "degraded": True, "degradedReason": str(exc)[:240]}
        missing = [*missing, "策略引擎事件流暂不可用，已按低置信度降级评估"]
    try:
        outcome_metrics = build_policy_outcome_metrics(user, effect, days=7)
    except Exception as exc:
        degraded_reasons.append(f"outcome metrics unavailable: {str(exc)[:180]}")
        outcome_metrics = _degraded_policy_outcome_metrics(str(exc))
    outcome = evaluate_policy_outcome(effect, event_summary, missing, outcome_metrics=outcome_metrics)
    decision_id = _decision_id(user, selected["strategy"], effect, safe_days)
    now = timezone.now()
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "policyVersion": POLICY_VERSION,
        "decisionId": decision_id,
        "decisionAt": now.isoformat(),
        "evaluationWindow": {
            "days": 7,
            "startedAt": now.isoformat(),
            "endedAt": (now + timedelta(days=7)).isoformat(),
        },
        "selectedStrategy": selected["strategy"],
        "selectedCandidate": selected,
        "candidates": candidates,
        "successCriteria": _success_criteria(selected["strategy"]),
        "baseline": {
            "type": "self_history",
            "effectScore": _safe_float(effect.get("overallEffectScore"), 0),
            "taskCompletionRate": _safe_float((effect.get("behavior") or {}).get("taskCompletionRate"), 0),
            "correctRate": _safe_float((effect.get("assessment") or {}).get("correctRate"), 0),
            "resourceEffectiveness": _safe_float(effect.get("resourceEffectiveness"), 0),
        },
        "expectedMetricDelta": selected.get("expectedMetricDelta", {}),
        "observedMetricDelta": outcome["observedMetricDelta"],
        "outcomeMetrics": outcome_metrics,
        "outcomeStatus": outcome["outcomeStatus"],
        "missingEvidence": missing,
        "degraded": bool(degraded_reasons),
        "degradedReasons": degraded_reasons,
        "attribution": {
            "schemaVersion": attribution.get("schemaVersion"),
            "summary": attribution.get("summary", {}),
            "topResourceTypes": (attribution.get("resourceTypes") or [])[:3],
        },
        "explorationMode": bool(selected.get("explorationMode")),
        "rollbackTriggered": outcome["outcomeStatus"] == "failed",
        "rollbackReason": outcome.get("rollbackReason", ""),
    }


def build_policy_candidates(effect_report: dict, attribution_report: dict) -> list[dict]:
    return [
        score_policy_candidate(strategy, effect_report, attribution_report)
        for strategy in POLICY_STRATEGIES
    ]


def score_policy_candidate(strategy: str, effect_report: dict, attribution_report: dict) -> dict:
    score = 35.0
    ranking_basis: list[str] = []
    confidence = str(effect_report.get("confidence") or "low")
    effect_score = _safe_float(effect_report.get("overallEffectScore"), 0)
    assessment = effect_report.get("assessment") if isinstance(effect_report.get("assessment"), dict) else {}
    behavior = effect_report.get("behavior") if isinstance(effect_report.get("behavior"), dict) else {}
    resource = _top_resource_effect(attribution_report)
    if confidence == "high":
        score += 12
        ranking_basis.append("high confidence learning-effect evidence")
    elif confidence == "medium":
        score += 6
        ranking_basis.append("medium confidence learning-effect evidence")
    else:
        ranking_basis.append("low confidence evidence")

    if strategy == "add_remedial_practice":
        if effect_score < 70:
            score += 18
            ranking_basis.append("effect score below mastery target")
        if resource and resource.get("resourceType") == "practice_set":
            score += _resource_bonus(resource, ranking_basis)
    elif strategy == "add_diagnostic_practice":
        if _safe_int(assessment.get("attemptCount"), 0) < 3:
            score += 22
            ranking_basis.append("assessment evidence is below minimum sample")
        if confidence == "low":
            score += 10
            ranking_basis.append("diagnostic action preferred for low evidence")
    elif strategy == "add_spaced_review":
        wrong = _safe_int(assessment.get("wrongQuestionCount"), 0)
        if wrong:
            score += min(18, wrong * 4)
            ranking_basis.append(f"{wrong} wrong-question signals need spaced review")
    elif strategy == "reduce_new_content":
        completion = _safe_float(behavior.get("taskCompletionRate"), 0)
        if completion < 0.5:
            score += 20
            ranking_basis.append("task completion rate is below 50%")
    elif strategy == "increase_challenge":
        correct_rate = _safe_float(assessment.get("correctRate"), 0)
        if effect_score >= 75 and correct_rate >= 0.8:
            score += 24
            ranking_basis.append("high score and correct rate support challenge")
    elif strategy == "recommend_coaching":
        if confidence == "low" or effect_score < 50:
            score += 12
            ranking_basis.append("coach intervention can clarify persistent uncertainty")

    exploration = False
    if resource and bool(resource.get("explorationRecommended")):
        exploration = True
        if strategy in {"add_diagnostic_practice", "add_spaced_review"}:
            score += 5
            ranking_basis.append(f"{resource.get('resourceType')} needs exploration due to low attribution confidence")

    return {
        "strategy": strategy,
        "decisionScore": round(min(100, max(0, score)), 1),
        "rankingBasis": ranking_basis or ["default policy candidate"],
        "expectedMetricDelta": _expected_delta(strategy),
        "explorationMode": exploration,
        "successCriteria": _success_criteria(strategy),
    }


def evaluate_policy_outcome(effect_report: dict, event_summary: dict, missing_evidence: list[str], *, outcome_metrics: dict | None = None) -> dict:
    metrics = outcome_metrics if isinstance(outcome_metrics, dict) else {}
    resource_gain = metrics.get("resourceTypeGain7d") if isinstance(metrics.get("resourceTypeGain7d"), list) else []
    top_resource_gain = _safe_float(resource_gain[0].get("postAssessmentGain7d"), 0) if resource_gain and isinstance(resource_gain[0], dict) else 0
    total_events = _safe_int(event_summary.get("totalEvents"), 0)
    if missing_evidence or total_events < 3:
        return {
            "outcomeStatus": "insufficient_evidence",
            "observedMetricDelta": {
                "effectScoreDelta": 0,
                "taskCompletionRateDelta": 0,
                "correctRateDelta": 0,
                "topResourceTypeGain7d": top_resource_gain,
            },
            "rollbackReason": "",
        }
    trends = effect_report.get("trends") if isinstance(effect_report.get("trends"), dict) else {}
    seven = trends.get("sevenDay") if isinstance(trends.get("sevenDay"), dict) else {}
    thirty = trends.get("thirtyDay") if isinstance(trends.get("thirtyDay"), dict) else {}
    seven_assessment = seven.get("assessment") if isinstance(seven.get("assessment"), dict) else {}
    thirty_assessment = thirty.get("assessment") if isinstance(thirty.get("assessment"), dict) else {}
    seven_behavior = seven.get("behavior") if isinstance(seven.get("behavior"), dict) else {}
    thirty_behavior = thirty.get("behavior") if isinstance(thirty.get("behavior"), dict) else {}
    correct_delta = round(_safe_float(seven_assessment.get("correctRate"), 0) - _safe_float(thirty_assessment.get("correctRate"), 0), 3)
    completion_delta = round(_safe_float(seven_behavior.get("taskCompletionRate"), 0) - _safe_float(thirty_behavior.get("taskCompletionRate"), 0), 3)
    effect_delta = round(correct_delta * 100 * 0.6 + completion_delta * 100 * 0.4, 1)
    status = "succeeded" if effect_delta >= 5 else "failed" if effect_delta <= -5 else "pending"
    return {
        "outcomeStatus": status,
        "observedMetricDelta": {
            "effectScoreDelta": effect_delta,
            "taskCompletionRateDelta": completion_delta,
            "correctRateDelta": correct_delta,
            "topResourceTypeGain7d": top_resource_gain,
        },
        "rollbackReason": "observed effect declined below rollback threshold" if status == "failed" else "",
    }


def build_policy_outcome_metrics(user, effect_report: dict, *, days: int = 7) -> dict:
    safe_days = max(1, min(_safe_int(days, 7), 30))
    window_attribution = build_resource_effect_attribution(user, days=safe_days)
    baseline_attribution = build_resource_effect_attribution(user, days=max(30, safe_days))
    baseline_by_type = _resource_effect_by_type(baseline_attribution)
    resource_types = window_attribution.get("resourceTypes") if isinstance(window_attribution.get("resourceTypes"), list) else []
    serialized = []
    for item in resource_types:
        if not isinstance(item, dict):
            continue
        resource_type = str(item.get("resourceType") or "unknown")
        baseline = baseline_by_type.get(resource_type, {})
        serialized.append(
            {
                "resourceType": resource_type,
                "knowledgePointId": str(item.get("knowledgePointId") or ""),
                "completed7d": _safe_int(item.get("completed"), 0),
                "opened7d": _safe_int(item.get("opened"), 0),
                "postAssessmentGain7d": _safe_float(baseline.get("postAssessmentGain"), _safe_float(item.get("postAssessmentGain"), 0)),
                "practiceConversionRate7d": _safe_float(item.get("practiceConversionRate"), 0),
                "historicalEffectiveness7d": _safe_float(item.get("historicalEffectiveness"), 0),
                "confidence": str(baseline.get("effectConfidence") or item.get("effectConfidence") or "low"),
                "explorationRecommended": bool(item.get("explorationRecommended")),
            }
        )
    serialized = sorted(serialized, key=lambda item: (item["postAssessmentGain7d"], item["historicalEffectiveness7d"]), reverse=True)
    return {
        "schemaVersion": "a3.policy-outcome-metrics.v1",
        "windowDays": safe_days,
        "resourceTypeGain7d": serialized[:5],
        "summary": {
            "resourceTypeCount": len(serialized),
            "topResourceTypeGain7d": _safe_float(serialized[0].get("postAssessmentGain7d"), 0) if serialized else 0,
            "effectScore": _safe_float(effect_report.get("overallEffectScore"), 0),
        },
    }


def _degraded_attribution_report(days: int, reason: str) -> dict:
    return {
        "schemaVersion": "a3.resource-effect-attribution.v1",
        "windowDays": days,
        "status": "degraded",
        "degraded": True,
        "degradedReason": reason[:240],
        "summary": {
            "resourceTypeCount": 0,
            "averageEffectiveness": 0,
            "confidence": "low",
        },
        "resourceTypes": [],
    }


def _degraded_policy_outcome_metrics(reason: str) -> dict:
    return {
        "schemaVersion": "a3.policy-outcome-metrics.v1",
        "status": "degraded",
        "degraded": True,
        "degradedReason": reason[:240],
        "windowDays": 7,
        "resourceTypeGain7d": [],
        "summary": {
            "resourceTypeCount": 0,
            "topResourceTypeGain7d": 0,
            "effectScore": 0,
        },
    }


def _resource_effect_by_type(attribution_report: dict) -> dict[str, dict]:
    items = attribution_report.get("resourceTypes") if isinstance(attribution_report.get("resourceTypes"), list) else []
    return {
        str(item.get("resourceType") or ""): item
        for item in items
        if isinstance(item, dict) and item.get("resourceType")
    }


def decorate_adjustment_with_policy_decision(adjustment: dict, policy_report: dict) -> dict:
    if not isinstance(adjustment, dict) or not isinstance(policy_report, dict):
        return adjustment
    selected = policy_report.get("selectedCandidate") if isinstance(policy_report.get("selectedCandidate"), dict) else {}
    return {
        **adjustment,
        "policyDecisionId": policy_report.get("decisionId", ""),
        "policyVersion": policy_report.get("policyVersion", POLICY_VERSION),
        "decisionScore": selected.get("decisionScore", 0),
        "successCriteria": policy_report.get("successCriteria", []),
        "evaluationWindow": policy_report.get("evaluationWindow", {}),
        "outcomeStatus": policy_report.get("outcomeStatus", "pending"),
        "rankingBasis": selected.get("rankingBasis", []),
        "expectedMetricDelta": selected.get("expectedMetricDelta", {}),
        "observedMetricDelta": policy_report.get("observedMetricDelta", {}),
        "outcomeMetrics": policy_report.get("outcomeMetrics", {}),
    }


def append_policy_decision_history(user, policy_report: dict, *, limit: int = 12) -> list[dict]:
    if not isinstance(policy_report, dict) or not policy_report.get("decisionId"):
        return []
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    existing = [item for item in extra.get("optimizationPolicyDecisions", []) if isinstance(item, dict)]
    decision_id = str(policy_report.get("decisionId") or "")
    without_same = [item for item in existing if str(item.get("decisionId") or "") != decision_id]
    history = [_history_decision(policy_report), *without_same]
    history = sorted(history, key=lambda item: str(item.get("decisionAt") or ""), reverse=True)[: max(1, limit)]
    extra["optimizationPolicyDecisions"] = history
    extra["continuousOptimizationPolicyReport"] = policy_report
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return history


def evaluate_policy_decision_history_outcomes(user, *, days: int = 7) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = dict(profile.extra_profile or {})
    history = [item for item in extra.get("optimizationPolicyDecisions", []) if isinstance(item, dict)]
    if not history:
        return {"updated": 0, "decisions": []}
    effect = build_learning_effect_report(user, include_persisted_analysis=False)
    event_summary = aggregate_learning_events(user, days=days)
    missing = effect.get("missingEvidence") if isinstance(effect.get("missingEvidence"), list) else []
    updated_history = []
    updated_count = 0
    for decision in history:
        if str(decision.get("outcomeStatus") or "") not in {"pending", ""}:
            updated_history.append(decision)
            continue
        outcome_metrics = build_policy_outcome_metrics(user, effect, days=days)
        outcome = evaluate_policy_outcome(effect, event_summary, missing, outcome_metrics=outcome_metrics)
        updated = {
            **decision,
            "outcomeStatus": outcome["outcomeStatus"],
            "observedMetricDelta": outcome["observedMetricDelta"],
            "outcomeMetrics": outcome_metrics,
            "rollbackTriggered": outcome["outcomeStatus"] == "failed",
            "rollbackReason": outcome.get("rollbackReason", ""),
            "evaluatedAt": timezone.now().isoformat(),
        }
        updated_history.append(updated)
        updated_count += 1
    extra["optimizationPolicyDecisions"] = updated_history[:12]
    if updated_history:
        extra["continuousOptimizationPolicyReport"] = {
            **(extra.get("continuousOptimizationPolicyReport") if isinstance(extra.get("continuousOptimizationPolicyReport"), dict) else {}),
            "latestOutcomeEvaluation": updated_history[0],
        }
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {"updated": updated_count, "decisions": updated_history[:12]}


def _top_resource_effect(attribution_report: dict) -> dict:
    items = attribution_report.get("resourceTypes") if isinstance(attribution_report.get("resourceTypes"), list) else []
    return next((item for item in items if isinstance(item, dict)), {})


def _history_decision(policy_report: dict) -> dict:
    selected = policy_report.get("selectedCandidate") if isinstance(policy_report.get("selectedCandidate"), dict) else {}
    return {
        "schemaVersion": policy_report.get("schemaVersion", REPORT_SCHEMA_VERSION),
        "policyVersion": policy_report.get("policyVersion", POLICY_VERSION),
        "decisionId": policy_report.get("decisionId", ""),
        "decisionAt": policy_report.get("decisionAt", ""),
        "selectedStrategy": policy_report.get("selectedStrategy", ""),
        "decisionScore": selected.get("decisionScore", 0),
        "rankingBasis": selected.get("rankingBasis", []),
        "successCriteria": policy_report.get("successCriteria", []),
        "evaluationWindow": policy_report.get("evaluationWindow", {}),
        "expectedMetricDelta": policy_report.get("expectedMetricDelta", {}),
        "observedMetricDelta": policy_report.get("observedMetricDelta", {}),
        "outcomeMetrics": policy_report.get("outcomeMetrics", {}),
        "outcomeStatus": policy_report.get("outcomeStatus", "pending"),
        "missingEvidence": policy_report.get("missingEvidence", []),
        "explorationMode": bool(policy_report.get("explorationMode")),
    }


def _resource_bonus(resource: dict, ranking_basis: list[str]) -> float:
    effectiveness = _safe_float(resource.get("historicalEffectiveness"), 0)
    confidence = str(resource.get("effectConfidence") or "low")
    bonus = min(15, effectiveness / 8)
    if confidence == "high":
        bonus += 8
    elif confidence == "medium":
        bonus += 4
    ranking_basis.append(f"{resource.get('resourceType')} historical effectiveness {effectiveness} with {confidence} confidence")
    return bonus


def _success_criteria(strategy: str) -> list[dict]:
    base = [
        {"metric": "taskCompletionRate", "targetDelta": 0.1, "windowDays": 7},
        {"metric": "correctRate", "targetDelta": 0.08, "windowDays": 7},
    ]
    if strategy == "reduce_new_content":
        return [{"metric": "taskCompletionRate", "targetDelta": 0.15, "windowDays": 7}]
    if strategy == "increase_challenge":
        return [{"metric": "challengeCorrectRate", "target": 0.7, "windowDays": 7}]
    if strategy == "recommend_coaching":
        return [{"metric": "coachMessageCount", "target": 1, "windowDays": 7}, *base[:1]]
    return base


def _expected_delta(strategy: str) -> dict:
    return {
        "add_remedial_practice": {"correctRateDelta": 0.12, "effectScoreDelta": 8},
        "add_spaced_review": {"wrongQuestionRepeatRateDelta": -0.1, "effectScoreDelta": 5},
        "add_diagnostic_practice": {"confidenceDelta": 0.2, "missingEvidenceDelta": -1},
        "reduce_new_content": {"taskCompletionRateDelta": 0.15, "loadDeltaMinutes": -10},
        "increase_challenge": {"transferAccuracyDelta": 0.08, "effectScoreDelta": 6},
        "recommend_coaching": {"confusionResolutionDelta": 0.15, "coachMessageCountDelta": 1},
    }.get(strategy, {})


def _empty_candidate() -> dict:
    return {
        "strategy": "add_spaced_review",
        "decisionScore": 0,
        "rankingBasis": ["no candidate generated"],
        "expectedMetricDelta": {},
        "explorationMode": False,
        "successCriteria": [],
    }


def _decision_id(user, strategy: str, effect_report: dict, days: int) -> str:
    source = f"{getattr(user, 'id', '')}:{strategy}:{effect_report.get('updatedAt', '')}:{days}"
    return f"policy:{sha1(source.encode('utf-8')).hexdigest()[:16]}"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
