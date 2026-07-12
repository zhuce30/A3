from __future__ import annotations

from collections import Counter
from datetime import datetime, time
import json
import os
import re
from typing import Any

from django.db import transaction
from django.utils import timezone

from backend.apps.assessments.models import WrongQuestion
from backend.apps.assessments.services import build_learning_report
from backend.apps.compat.llm import chat_completion
from backend.apps.learning.effect_events import record_learning_event
from backend.apps.learning.models import CoachingSession, LearningEvent, LearningSummaryDocument
from backend.apps.learning.services import current_study_plan


SUMMARY_SCHEMA_VERSION = "a3.learning-summary-document.v1"


def list_learning_summary_documents(user, *, limit: int = 20) -> list[dict]:
    safe_limit = max(1, min(_safe_int(limit, 20), 50))
    documents = LearningSummaryDocument.objects.filter(user=user).order_by("-created_at", "-id")[:safe_limit]
    return [serialize_learning_summary_document(document) for document in documents]


def get_learning_summary_document(user, document_id) -> dict | None:
    document = LearningSummaryDocument.objects.filter(user=user, id=document_id).first()
    return serialize_learning_summary_document(document) if document else None


@transaction.atomic
def create_learning_summary_document(user, *, prompt: str = "") -> dict:
    normalized_prompt = _normalize_prompt(prompt)
    summary_date = timezone.localdate()
    title = _title_from_prompt(normalized_prompt)
    source_snapshot = _build_source_snapshot(user, summary_date=summary_date)
    file_name = _next_file_name(user, summary_date=summary_date, title=title)
    generated = _generate_summary_markdown(
        title=title,
        prompt=normalized_prompt,
        summary_date=summary_date,
        snapshot=source_snapshot,
    )
    content_md = generated["contentMd"]
    source_snapshot["generation"] = generated["generation"]
    document = LearningSummaryDocument.objects.create(
        user=user,
        title=title,
        file_name=file_name,
        prompt=normalized_prompt,
        content_md=content_md,
        summary_date=summary_date,
        source_snapshot=source_snapshot,
        schema_version=SUMMARY_SCHEMA_VERSION,
    )
    try:
        record_learning_event(
            user,
            event_type="report_summary_created",
            target_type="learning_summary_document",
            target_id=str(document.id),
            metadata={"fileName": document.file_name, "prompt": normalized_prompt},
        )
    except Exception:
        pass
    return serialize_learning_summary_document(document)


def serialize_learning_summary_document(document: LearningSummaryDocument) -> dict:
    return {
        "id": str(document.id),
        "schemaVersion": document.schema_version or SUMMARY_SCHEMA_VERSION,
        "title": document.title,
        "fileName": document.file_name,
        "prompt": document.prompt,
        "contentMd": document.content_md,
        "summaryDate": document.summary_date.isoformat() if document.summary_date else "",
        "sourceSnapshot": document.source_snapshot if isinstance(document.source_snapshot, dict) else {},
        "createdAt": document.created_at.isoformat() if document.created_at else "",
        "updatedAt": document.updated_at.isoformat() if document.updated_at else "",
    }


def _build_source_snapshot(user, *, summary_date) -> dict:
    started_at = timezone.make_aware(datetime.combine(summary_date, time.min), timezone.get_current_timezone())
    ended_at = timezone.now()
    events = list(LearningEvent.objects.filter(user=user, created_at__gte=started_at).order_by("-created_at", "-id")[:80])
    event_counts = Counter(event.event_type for event in events)
    plan = _safe_current_study_plan(user)
    today_plan = _today_plan_day(plan, summary_date.isoformat())
    report = _safe_learning_report(user)
    profile = getattr(user, "learner_profile", None)
    weak_points = profile.weak_points if profile and isinstance(profile.weak_points, list) else []
    goals = profile.learning_goals if profile and isinstance(profile.learning_goals, list) else []
    active_wrong = WrongQuestion.objects.filter(user=user, mastered=False).select_related("question__knowledge_point").order_by("-last_wrong_at")[:5]
    coaching = list(CoachingSession.objects.filter(user=user).order_by("-updated_at", "-created_at")[:3])
    return {
        "schemaVersion": "a3.learning-summary-source-snapshot.v1",
        "timeWindow": {"startedAt": started_at.isoformat(), "endedAt": ended_at.isoformat()},
        "eventCounts": dict(event_counts),
        "events": [_event_snapshot(event) for event in events[:12]],
        "todayPlan": today_plan,
        "reportMetrics": _report_metrics_snapshot(report),
        "weakPoints": [str(item) for item in weak_points[:8]],
        "learningGoals": [str(item) for item in goals[:5]],
        "wrongQuestions": [_wrong_question_snapshot(item) for item in active_wrong],
        "coachingSessions": [_coaching_snapshot(item) for item in coaching],
    }


def _generate_summary_markdown(*, title: str, prompt: str, summary_date, snapshot: dict) -> dict:
    fallback = _build_summary_markdown(title=title, prompt=prompt, summary_date=summary_date, snapshot=snapshot)
    try:
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "你是 A3 智学引擎的 LearningSummaryAgent。只能根据用户学习数据快照写总结，"
                        "不得编造课程来源、测评分数、页码、教师反馈或未记录的学习行为。"
                        "输出必须是 Markdown，包含：# 标题、## 今天学了什么、## 证据、## 薄弱点、## 下一步建议。"
                        "如果证据不足，明确写出证据不足和下一步应补齐的学习动作。不要输出代码围栏。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "title": title,
                            "date": summary_date.isoformat(),
                            "userPrompt": prompt,
                            "learningDataSnapshot": _llm_snapshot(snapshot),
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0.2,
            max_tokens=int(os.getenv("A3_REPORT_SUMMARY_LLM_MAX_TOKENS", "1200")),
            timeout_seconds=float(os.getenv("A3_REPORT_SUMMARY_LLM_TIMEOUT_SECONDS", "18")),
        )
        content = _normalize_llm_markdown(str(result.get("content") or ""), fallback=fallback, title=title)
        return {
            "contentMd": content,
            "generation": {
                "source": "llm",
                "provider": str(result.get("provider") or ""),
                "model": str(result.get("model") or ""),
                "finishReason": str(result.get("finishReason") or ""),
                "usage": result.get("usage") if isinstance(result.get("usage"), dict) else {},
                "degraded": False,
                "degradedReason": "",
            },
        }
    except Exception as exc:
        return {
            "contentMd": fallback,
            "generation": {
                "source": "rules_fallback",
                "provider": "rules",
                "model": "",
                "finishReason": "",
                "usage": {},
                "degraded": True,
                "degradedReason": str(exc)[:240],
            },
        }


def _build_summary_markdown(*, title: str, prompt: str, summary_date, snapshot: dict) -> str:
    events = snapshot.get("events") if isinstance(snapshot.get("events"), list) else []
    event_counts = snapshot.get("eventCounts") if isinstance(snapshot.get("eventCounts"), dict) else {}
    today_plan = snapshot.get("todayPlan") if isinstance(snapshot.get("todayPlan"), dict) else {}
    tasks = today_plan.get("tasks") if isinstance(today_plan.get("tasks"), list) else []
    completed_tasks = [task for task in tasks if str(task.get("status") or "") == "completed"]
    weak_points = snapshot.get("weakPoints") if isinstance(snapshot.get("weakPoints"), list) else []
    wrong_questions = snapshot.get("wrongQuestions") if isinstance(snapshot.get("wrongQuestions"), list) else []
    coaching = snapshot.get("coachingSessions") if isinstance(snapshot.get("coachingSessions"), list) else []
    metrics = snapshot.get("reportMetrics") if isinstance(snapshot.get("reportMetrics"), dict) else {}

    learned_items = _learned_items(events, completed_tasks)
    next_actions = _next_actions(weak_points, wrong_questions, tasks, metrics)
    lines = [
        f"# {title}",
        "",
        f"- 日期：{summary_date.isoformat()}",
        f"- 生成依据：{prompt or '总结今天学习情况'}",
        f"- 今日事件：{sum(_safe_int(value, 0) for value in event_counts.values())} 条",
        "",
        "## 今天学了什么",
    ]
    if learned_items:
        lines.extend([f"- {item}" for item in learned_items[:6]])
    else:
        lines.append("- 今天暂未记录明确的学习事件，建议先完成一个今日任务或提交一次复盘。")

    lines.extend(["", "## 任务和测评证据"])
    if tasks:
        lines.append(f"- 今日计划任务：{len(tasks)} 项，已完成 {len(completed_tasks)} 项。")
        for task in tasks[:4]:
            title_text = str(task.get("title") or task.get("type") or "学习任务")
            status = "已完成" if str(task.get("status") or "") == "completed" else "待完成"
            lines.append(f"- {title_text}：{status}")
    else:
        lines.append("- 今日计划暂未生成或没有任务记录。")
    if metrics:
        lines.append(f"- 当前正确率：{metrics.get('accuracy', 0)}%，待巩固错题：{metrics.get('activeWrongQuestions', 0)} 道。")

    lines.extend(["", "## 薄弱点和错题"])
    if weak_points:
        lines.append("- 画像薄弱点：" + "、".join(str(item) for item in weak_points[:5]))
    if wrong_questions:
        for item in wrong_questions[:3]:
            lines.append(f"- {item.get('knowledgePoint') or '未标注知识点'}：{item.get('wrongCount', 0)} 次错误，建议复盘错因。")
    if not weak_points and not wrong_questions:
        lines.append("- 暂无新的薄弱点或活跃错题。")

    lines.extend(["", "## 辅导记录"])
    if coaching:
        for item in coaching:
            summary = item.get("summary") or "已记录一次辅导。"
            lines.append(f"- {item.get('topicTitle') or 'AI 辅导'}：{summary}")
    else:
        lines.append("- 今天暂未形成新的 AI 辅导总结。")

    lines.extend(["", "## 下一步建议"])
    lines.extend([f"- {item}" for item in next_actions])
    return "\n".join(lines).strip() + "\n"


def _llm_snapshot(snapshot: dict) -> dict:
    return {
        "timeWindow": snapshot.get("timeWindow") if isinstance(snapshot.get("timeWindow"), dict) else {},
        "eventCounts": snapshot.get("eventCounts") if isinstance(snapshot.get("eventCounts"), dict) else {},
        "events": (snapshot.get("events") if isinstance(snapshot.get("events"), list) else [])[:12],
        "todayPlan": snapshot.get("todayPlan") if isinstance(snapshot.get("todayPlan"), dict) else {},
        "reportMetrics": snapshot.get("reportMetrics") if isinstance(snapshot.get("reportMetrics"), dict) else {},
        "weakPoints": (snapshot.get("weakPoints") if isinstance(snapshot.get("weakPoints"), list) else [])[:8],
        "learningGoals": (snapshot.get("learningGoals") if isinstance(snapshot.get("learningGoals"), list) else [])[:5],
        "wrongQuestions": (snapshot.get("wrongQuestions") if isinstance(snapshot.get("wrongQuestions"), list) else [])[:5],
        "coachingSessions": (snapshot.get("coachingSessions") if isinstance(snapshot.get("coachingSessions"), list) else [])[:3],
    }


def _normalize_llm_markdown(content: str, *, fallback: str, title: str) -> str:
    text = content.strip()
    fenced = re.search(r"```(?:markdown|md)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    if len(text) < 40 or not text.startswith("#"):
        return fallback
    if "##" not in text:
        text = f"# {title}\n\n{text.lstrip('#').strip()}"
    return text + ("" if text.endswith("\n") else "\n")


def _normalize_prompt(prompt: str) -> str:
    text = str(prompt or "").strip()
    if len(text) > 200:
        raise ValueError("总结要求不能超过 200 个字符")
    return text or "总结我今天学了什么"


def _title_from_prompt(prompt: str) -> str:
    if "错题" in prompt or "复盘" in prompt:
        return "错题复盘总结"
    if "计划" in prompt or "任务" in prompt:
        return "学习计划总结"
    return "今日学习总结"


def _next_file_name(user, *, summary_date, title: str) -> str:
    date_prefix = summary_date.isoformat()
    base = f"{date_prefix}-{title}"
    existing = set(
        LearningSummaryDocument.objects.filter(user=user, summary_date=summary_date, file_name__startswith=base)
        .values_list("file_name", flat=True)
    )
    first = f"{base}.md"
    if first not in existing:
        return first
    index = 2
    while True:
        candidate = f"{base}-{index:02d}.md"
        if candidate not in existing:
            return candidate
        index += 1


def _safe_current_study_plan(user) -> dict:
    try:
        plan = current_study_plan(user)
        return plan if isinstance(plan, dict) else {}
    except Exception:
        return {}


def _safe_learning_report(user) -> dict:
    try:
        report = build_learning_report(user)
        return report if isinstance(report, dict) else {}
    except Exception:
        return {}


def _today_plan_day(plan: dict, today: str) -> dict:
    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    for item in days:
        if isinstance(item, dict) and str(item.get("date") or "") == today:
            return item
    return {}


def _report_metrics_snapshot(report: dict) -> dict:
    metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
    return {
        "accuracy": _safe_int(metrics.get("accuracy"), 0),
        "answeredQuestions": _safe_int(metrics.get("answeredQuestions"), 0),
        "activeWrongQuestions": _safe_int(metrics.get("activeWrongQuestions"), 0),
        "pathProgress": _safe_int(metrics.get("pathProgress"), 0),
        "studyMinutes": _safe_int(metrics.get("studyMinutes"), 0),
    }


def _event_snapshot(event: LearningEvent) -> dict:
    metadata = event.metadata if isinstance(event.metadata, dict) else {}
    return {
        "eventType": event.event_type,
        "targetType": event.target_type,
        "targetId": event.target_id,
        "title": str(metadata.get("title") or metadata.get("taskTitle") or metadata.get("goal") or "")[:120],
        "score": event.score,
        "durationSec": event.duration_sec,
        "createdAt": event.created_at.isoformat(),
    }


def _wrong_question_snapshot(wrong: WrongQuestion) -> dict:
    question = wrong.question
    point = question.knowledge_point if question and question.knowledge_point_id else None
    return {
        "id": str(wrong.id),
        "knowledgePoint": point.title if point else "",
        "wrongCount": wrong.wrong_count,
        "lastWrongAt": wrong.last_wrong_at.isoformat() if wrong.last_wrong_at else "",
    }


def _coaching_snapshot(session: CoachingSession) -> dict:
    return {
        "id": str(session.id),
        "topicTitle": session.topic_title,
        "summary": session.summary,
        "updatedAt": session.updated_at.isoformat() if session.updated_at else "",
    }


def _learned_items(events: list[dict], completed_tasks: list[dict]) -> list[str]:
    items = []
    for task in completed_tasks:
        title = str(task.get("title") or "").strip()
        if title:
            items.append(f"完成任务：{title}")
    for event in events:
        title = str(event.get("title") or "").strip()
        event_type = str(event.get("eventType") or "")
        if title and title not in " ".join(items):
            items.append(f"{_event_type_label(event_type)}：{title}")
        elif event_type == "question_answered":
            score = event.get("score")
            items.append(f"完成一道测评题，得分 {score if score is not None else '--'}")
    return items


def _next_actions(weak_points: list, wrong_questions: list, tasks: list[dict], metrics: dict) -> list[str]:
    actions = []
    pending = [task for task in tasks if str(task.get("status") or "") != "completed"]
    if wrong_questions or _safe_int(metrics.get("activeWrongQuestions"), 0) > 0:
        actions.append("先进入错题本，复盘最高频错因。")
    if weak_points:
        actions.append(f"围绕 {weak_points[0]} 做一次专项练习或 AI 辅导。")
    if pending:
        actions.append(f"回到今日任务，完成「{pending[0].get('title') or '待完成任务'}」。")
    if not actions:
        actions.append("保持当前节奏，明天继续完成一个最小学习闭环。")
    return actions[:3]


def _event_type_label(event_type: str) -> str:
    labels = {
        "task_completed": "完成任务",
        "resource_completed": "完成资源",
        "resource_opened": "打开资源",
        "reflection_submitted": "提交复盘",
        "assessment_submitted": "完成测评",
        "coach_message_sent": "AI 辅导",
    }
    return labels.get(event_type, "学习记录")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
