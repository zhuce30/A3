from __future__ import annotations

from uuid import uuid4

from django.utils import timezone


SUPPORTED_STRATEGIES = {
    "add_remedial_practice",
    "add_spaced_review",
    "reduce_new_content",
    "increase_challenge",
    "recommend_coaching",
}


def build_plan_adjustment_from_analysis(analysis: dict, effect_report: dict) -> dict:
    intervention = analysis.get("nextIntervention") if isinstance(analysis.get("nextIntervention"), dict) else {}
    raw_strategy = str(intervention.get("type") or "add_spaced_review").strip()
    strategy = raw_strategy if raw_strategy in SUPPORTED_STRATEGIES else "add_spaced_review"
    point_id = str(intervention.get("targetKnowledgePointId") or "")
    point_name = _knowledge_point_name(effect_report, point_id)
    reason = str(intervention.get("reason") or analysis.get("summary") or "根据学习效果评估调整后续任务。")[:300]
    task = _task_for_strategy(strategy, point_id, point_name, reason)
    return {
        "schemaVersion": "a3.plan-adjustment.v2",
        "strategy": strategy,
        "action": {
            "type": "add_task" if strategy != "reduce_new_content" else "reduce_load",
            "taskType": task["type"],
            "title": task["title"],
            "knowledgePointId": point_id,
            "estimatedMinutes": task["estimatedMinutes"],
        },
        "reason": reason,
        "evidence": {
            "effectScore": effect_report.get("overallEffectScore", 0),
            "confidence": effect_report.get("confidence", "low"),
            "riskLevel": analysis.get("riskLevel", "medium"),
            "targetKnowledgePointId": point_id,
        },
        "expectedImpact": _expected_impact(strategy, point_name),
        "risk": _strategy_risk(strategy),
        "expiresAt": (timezone.now() + timezone.timedelta(days=7)).isoformat(),
        "rollbackCondition": "连续两天未完成新增任务时撤销或减负。",
        "task": task,
        "createdAt": timezone.now().isoformat(),
    }


def apply_plan_adjustment_to_study_plan(plan: dict, adjustment: dict) -> dict:
    if not isinstance(plan, dict):
        return plan
    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    if not days:
        plan["lastLearningEffectAdjustment"] = {**adjustment, "applied": False, "appliedAt": ""}
        return plan
    today = timezone.localdate().isoformat()
    day = next((item for item in days if isinstance(item, dict) and item.get("date") == today), None)
    if day is None:
        day = next((item for item in days if isinstance(item, dict) and int(item.get("dayIndex") or 0) == 1), days[0])
    tasks = day.setdefault("tasks", [])
    task_payload = adjustment.get("task") if isinstance(adjustment.get("task"), dict) else {}
    task_id = str(task_payload.get("id") or f"learning-effect:{uuid4().hex[:12]}")
    if task_payload and not any(isinstance(task, dict) and task.get("id") == task_id for task in tasks):
        tasks.insert(0, task_payload)
    _refresh_day_progress(day)
    plan["overallProgress"] = _plan_progress(days)
    persisted = {key: value for key, value in adjustment.items() if key != "task"}
    persisted["taskId"] = task_id
    persisted["applied"] = bool(task_payload)
    persisted["appliedAt"] = timezone.now().isoformat()
    plan["lastLearningEffectAdjustment"] = persisted
    _append_learning_effect_timeline(plan, persisted)
    return plan


def _task_for_strategy(strategy: str, point_id: str, point_name: str, reason: str) -> dict:
    title_prefix = point_name or "当前知识点"
    if strategy == "add_remedial_practice":
        task_type, title, href, minutes = "practice", f"{title_prefix} 补救练习", "/a3/assessment", 15
    elif strategy == "increase_challenge":
        task_type, title, href, minutes = "practice", f"{title_prefix} 迁移挑战", "/a3/assessment", 20
    elif strategy == "recommend_coaching":
        task_type, title, href, minutes = "coaching", f"{title_prefix} 面对面辅导", "/a3/coaching", 12
    elif strategy == "reduce_new_content":
        task_type, title, href, minutes = "review", f"{title_prefix} 轻量复盘", "/a3/today", 8
    else:
        task_type, title, href, minutes = "review", f"{title_prefix} 间隔复习", "/a3/wrong-notebook", 10
    return {
        "id": f"learning-effect:{strategy}:{_stable_slug(point_id or title_prefix)}",
        "type": task_type,
        "title": title,
        "subtitle": reason,
        "href": href if not point_name else f"{href}?practice={point_name}" if href == "/a3/assessment" else href,
        "estimatedMinutes": minutes,
        "knowledgePointId": point_id,
        "status": "pending",
        "metadata": {
            "generatedBy": "learning_effect_adjustment",
            "strategy": strategy,
            "reason": reason,
        },
    }


def _append_learning_effect_timeline(plan: dict, adjustment: dict) -> None:
    timeline = plan.get("adjustmentTimeline") if isinstance(plan.get("adjustmentTimeline"), list) else []
    task_id = str(adjustment.get("taskId") or "")
    if task_id and any(isinstance(item, dict) and item.get("id") == task_id for item in timeline):
        plan["adjustmentTimeline"] = timeline
        return
    timeline.insert(
        0,
        {
            "id": task_id or f"learning-effect:{uuid4().hex[:12]}",
            "type": "learning_effect",
            "title": _timeline_title(str(adjustment.get("strategy") or "")),
            "detail": str((adjustment.get("action") or {}).get("title") or adjustment.get("reason") or ""),
            "reason": str(adjustment.get("reason") or ""),
            "createdAt": timezone.now().isoformat(),
        },
    )
    plan["adjustmentTimeline"] = timeline[:12]
    explanation = plan.get("explanation")
    if isinstance(explanation, dict):
        adjustments = [item for item in plan["adjustmentTimeline"] if isinstance(item, dict)][:5]
        explanation["adjustments"] = adjustments
        explanation["currentChange"] = adjustments[0] if adjustments else {}


def _refresh_day_progress(day: dict) -> None:
    tasks = day.get("tasks") if isinstance(day.get("tasks"), list) else []
    if not tasks:
        day["progress"] = 0
        return
    completed = len([task for task in tasks if isinstance(task, dict) and task.get("status") == "completed"])
    day["progress"] = round(completed * 100 / len(tasks))


def _plan_progress(days: list) -> int:
    tasks = [task for day in days if isinstance(day, dict) for task in day.get("tasks", []) if isinstance(task, dict)]
    if not tasks:
        return 0
    completed = len([task for task in tasks if task.get("status") == "completed"])
    return round(completed * 100 / len(tasks))


def _knowledge_point_name(effect_report: dict, point_id: str) -> str:
    points = effect_report.get("knowledgePoints") if isinstance(effect_report.get("knowledgePoints"), list) else []
    for item in points:
        if isinstance(item, dict) and str(item.get("knowledgePointId") or "") == point_id:
            return str(item.get("name") or "")
    return ""


def _expected_impact(strategy: str, point_name: str) -> str:
    target = point_name or "目标知识点"
    if strategy == "add_remedial_practice":
        return f"降低{target}错题复发率，并补齐后测证据。"
    if strategy == "increase_challenge":
        return f"验证{target}迁移能力，避免停留在基础掌握。"
    if strategy == "reduce_new_content":
        return "降低当日负荷，恢复任务完成率。"
    if strategy == "recommend_coaching":
        return f"通过辅导澄清{target}的卡点。"
    return f"巩固{target}并降低遗忘风险。"


def _strategy_risk(strategy: str) -> str:
    if strategy in {"add_remedial_practice", "increase_challenge"}:
        return "可能增加今日任务负担。"
    if strategy == "reduce_new_content":
        return "新内容推进速度会暂时下降。"
    return "需要后续作答数据验证效果。"


def _timeline_title(strategy: str) -> str:
    return {
        "add_remedial_practice": "学习效果触发补救练习",
        "add_spaced_review": "学习效果触发间隔复习",
        "reduce_new_content": "学习效果触发计划减负",
        "increase_challenge": "学习效果触发迁移挑战",
        "recommend_coaching": "学习效果推荐面对面辅导",
    }.get(strategy, "学习效果触发计划调整")


def _stable_slug(value: str) -> str:
    return "-".join(str(value or "").strip().lower().split())[:80] or uuid4().hex[:12]
