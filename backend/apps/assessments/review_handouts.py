from __future__ import annotations

import hashlib
import json
from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from backend.apps.assessments.models import ReviewHandoutJob
from backend.apps.assessments.wrong_exports import (
    WrongExportRequestError,
    build_wrong_question_snapshot,
    select_wrong_questions,
)


ACTIVE_JOB_STATUSES = {"queued", "running"}


def create_snapshot(user, scope: str) -> dict:
    items = list(select_wrong_questions(user, scope))
    if not items:
        raise WrongExportRequestError("当前范围没有可生成讲义的错题")
    snapshot = build_wrong_question_snapshot(user, scope, items)
    profile = getattr(user, "learner_profile", None)
    weak_points = profile.weak_points if profile and isinstance(profile.weak_points, list) else []
    snapshot["profileWeakPoints"] = [str(item).strip()[:128] for item in weak_points if str(item).strip()][:20]
    return snapshot


def rank_weak_points(snapshot: dict) -> list[dict]:
    now = timezone.now()
    profile_points = set(snapshot.get("profileWeakPoints") or [])
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in snapshot.get("questions") or []:
        point = str(row.get("knowledgePoint") or "未分类")
        grouped[point].append(row)
    ranked = []
    for point, rows in grouped.items():
        active_count = sum(1 for row in rows if not row.get("mastered"))
        wrong_count = sum(max(0, int(row.get("wrongCount") or 0)) for row in rows)
        due_count = sum(1 for row in rows if _is_due(row.get("reviewAfter"), now))
        profile_matched = point in profile_points
        recency = max((_recency_score(row.get("lastWrongAt"), now) for row in rows), default=0)
        score = round(active_count * 20 + wrong_count * 8 + due_count * 15 + recency + (18 if profile_matched else 0), 2)
        ranked.append({
            "knowledgePoint": point,
            "activeCount": active_count,
            "wrongCount": wrong_count,
            "dueCount": due_count,
            "profileMatched": profile_matched,
            "score": score,
            "questionIds": [row.get("wrongQuestionId") for row in rows],
        })
    return sorted(ranked, key=lambda item: (-item["score"], item["knowledgePoint"]))[:12]


@transaction.atomic
def create_review_handout_job(user, scope: str) -> tuple[ReviewHandoutJob, bool]:
    snapshot = create_snapshot(user, scope)
    digest_payload = {key: value for key, value in snapshot.items() if key != "generatedAt"}
    snapshot_hash = hashlib.sha256(
        json.dumps(digest_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    existing = ReviewHandoutJob.objects.select_for_update().filter(
        user=user,
        scope=snapshot["scope"],
        snapshot_hash=snapshot_hash,
        status__in=ACTIVE_JOB_STATUSES,
    ).first()
    if existing:
        return existing, False
    job = ReviewHandoutJob.objects.create(
        user=user,
        scope=snapshot["scope"],
        snapshot_hash=snapshot_hash,
        snapshot=snapshot,
        ranked_weak_points=rank_weak_points(snapshot),
        status="queued",
        stage="queued",
        message="复习讲义已进入生成队列",
    )
    return job, True


def serialize_review_handout_job(job: ReviewHandoutJob) -> dict:
    base = f"/api/assessments/wrong-questions/review-handouts/{job.id}"
    payload = {
        "jobId": str(job.id),
        "scope": job.scope,
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "message": job.message,
        "snapshotId": job.snapshot_hash[:16],
        "traceId": job.trace_id,
        "citations": job.citations if isinstance(job.citations, list) else [],
        "verified": job.verified,
        "degraded": job.degraded,
        "error": job.error_message if job.status == "failed" else "",
        "createdAt": job.created_at.isoformat(),
        "updatedAt": job.updated_at.isoformat(),
    }
    if job.status == "succeeded" and job.docx_path:
        payload["docxDownloadUrl"] = f"{base}/download/docx/"
    if job.status == "succeeded" and job.pdf_path:
        payload["pdfDownloadUrl"] = f"{base}/download/pdf/"
    return payload


def _is_due(value, now) -> bool:
    if not value:
        return True
    try:
        return timezone.datetime.fromisoformat(str(value)) <= now
    except ValueError:
        return True


def _recency_score(value, now) -> float:
    if not value:
        return 0
    try:
        occurred = timezone.datetime.fromisoformat(str(value))
    except ValueError:
        return 0
    days = max(0.0, (now - occurred).total_seconds() / 86400)
    return max(0.0, 10.0 - min(days, 10.0))
