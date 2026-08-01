from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from backend.apps.assessments.content_enhancer import EnhancementCancelled, enhance_wrong_export
from backend.apps.assessments.models import WrongQuestionExportJob
from backend.apps.assessments.wrong_exports import (
    WRONG_EXPORT_FORMATS,
    WRONG_EXPORT_SCOPES,
    ExportArtifact,
    WrongExportRequestError,
    build_wrong_question_snapshot,
    select_wrong_questions,
)
from backend.domains.knowledge_base.retriever import search_knowledge_base


ACTIVE_JOB_STATUSES = {"queued", "running"}
logger = logging.getLogger(__name__)


class WrongExportCancelled(Exception):
    pass


@transaction.atomic
def create_wrong_export_job(user, scope: str, export_format: str) -> tuple[WrongQuestionExportJob, bool]:
    normalized_scope = str(scope or "active").strip().lower()
    normalized_format = str(export_format or "").strip().lower()
    if normalized_scope not in WRONG_EXPORT_SCOPES:
        raise WrongExportRequestError("导出范围必须是 active、due、mastered 或 all")
    if normalized_format not in WRONG_EXPORT_FORMATS:
        raise WrongExportRequestError("导出格式必须是 docx、xlsx 或 pdf")
    items = list(select_wrong_questions(user, normalized_scope))
    if not items:
        raise WrongExportRequestError("当前范围没有可导出的错题")
    snapshot = build_wrong_question_snapshot(user, normalized_scope, items)
    snapshot_hash = _snapshot_hash(snapshot)
    existing = WrongQuestionExportJob.objects.select_for_update().filter(
        user=user,
        scope=normalized_scope,
        format=normalized_format,
        snapshot_hash=snapshot_hash,
        status__in=ACTIVE_JOB_STATUSES,
    ).first()
    if existing:
        return existing, False
    return WrongQuestionExportJob.objects.create(
        user=user,
        scope=normalized_scope,
        format=normalized_format,
        snapshot_hash=snapshot_hash,
        snapshot=snapshot,
        status="queued",
        stage="queued",
        message="错题导出已进入生成队列",
    ), True


def retry_wrong_export_job(job: WrongQuestionExportJob) -> WrongQuestionExportJob:
    if job.status not in {"failed", "cancelled"}:
        raise WrongExportRequestError("只有失败或已取消的导出任务可以重试")
    return WrongQuestionExportJob.objects.create(
        user=job.user,
        scope=job.scope,
        format=job.format,
        snapshot_hash=job.snapshot_hash,
        snapshot=job.snapshot,
        status="queued",
        stage="queued",
        message="错题导出已重新进入生成队列",
    )


def serialize_wrong_export_job(job: WrongQuestionExportJob) -> dict[str, Any]:
    payload = {
        "jobId": str(job.id),
        "scope": job.scope,
        "format": job.format,
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "message": job.message,
        "snapshotId": job.snapshot_hash[:16],
        "traceId": job.trace_id,
        "verified": job.verified,
        "degraded": job.degraded,
        "degradedReasons": job.degraded_reasons if isinstance(job.degraded_reasons, list) else [],
        "promptVersion": str((job.llm_audit or {}).get("promptVersion") or ""),
        "model": str((job.llm_audit or {}).get("model") or ""),
        "attempts": int((job.llm_audit or {}).get("attempts") or 0),
        "error": job.error_message if job.status == "failed" else "",
        "createdAt": job.created_at.isoformat(),
        "updatedAt": job.updated_at.isoformat(),
    }
    if job.status == "succeeded" and job.artifact_path:
        payload["downloadUrl"] = f"/api/assessments/wrong-questions/exports/{job.id}/download/"
    return payload


def generate_wrong_export_job(job_id: str) -> dict[str, Any]:
    job = WrongQuestionExportJob.objects.select_related("user").get(id=job_id)
    if job.status == "cancelled":
        return {"success": False, "cancelled": True}
    if job.status == "succeeded":
        return {"success": True, "jobId": str(job.id)}
    artifact_dir = _artifact_directory(job)
    try:
        _save_job(
            job,
            status="running",
            progress=10,
            stage="retrieval",
            message="正在检索本地课程资料",
            started_at=job.started_at or timezone.now(),
            trace_id=job.trace_id or uuid.uuid4().hex,
        )
        evidence_by_point = _retrieve_evidence(job.snapshot)
        _save_job(job, progress=35, stage="enhancing", message="正在生成并校验 AI 学习诊断")
        result = enhance_wrong_export(
            job.snapshot,
            evidence_by_point,
            cancel_check=lambda: _is_cancelled(job.pk),
        )
        _save_job(
            job,
            progress=70,
            stage="rendering",
            message="正在生成导出文件",
            enhancement=result.content,
            citations=result.citations,
            llm_audit=result.audit,
            verified=result.verified,
            degraded=result.degraded,
            degraded_reasons=result.degraded_reasons,
        )
        artifact = _render_export(
            job.snapshot,
            job.format,
            enhancement=result.content,
            citations=result.citations,
            degraded_reasons=result.degraded_reasons,
        )
        _raise_if_cancelled(job.pk)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        path = artifact_dir / artifact.filename
        _atomic_write(path, artifact.content)
        _save_job(
            job,
            status="succeeded",
            progress=100,
            stage="completed",
            message="错题导出已生成（基础版）" if result.degraded else "错题导出已完成 AI 增强与引用核验",
            artifact_path=str(path),
            content_type=artifact.content_type,
            filename=artifact.filename,
            error_message="",
            finished_at=timezone.now(),
        )
        return {"success": True, "jobId": str(job.id)}
    except (WrongExportCancelled, EnhancementCancelled):
        shutil.rmtree(artifact_dir, ignore_errors=True)
        return {"success": False, "cancelled": True}
    except Exception:
        logger.exception("Wrong export generation failed", extra={"wrong_export_job_id": str(job.id)})
        shutil.rmtree(artifact_dir, ignore_errors=True)
        message = "错题导出生成失败，请稍后重试。"
        try:
            _save_job(
                job,
                status="failed",
                progress=100,
                stage="failed",
                message=message,
                error_message=message,
                finished_at=timezone.now(),
            )
        except WrongExportCancelled:
            return {"success": False, "cancelled": True}
        return {"success": False, "error": message}


def resolve_wrong_export_artifact(job: WrongQuestionExportJob) -> Path:
    if job.status != "succeeded" or not job.artifact_path:
        raise WrongExportRequestError("导出文件尚未生成")
    root = _artifact_root().resolve()
    path = Path(job.artifact_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise WrongExportRequestError("导出文件路径无效") from exc
    if not path.is_file() or path.suffix.lower() != f".{job.format}":
        raise WrongExportRequestError("导出文件不存在，请重新生成")
    return path


def _snapshot_hash(snapshot: dict[str, Any]) -> str:
    payload = {key: value for key, value in snapshot.items() if key != "generatedAt"}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _retrieve_evidence(snapshot: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    points = []
    for row in snapshot.get("questions") or []:
        point = str(row.get("knowledgePoint") or "未分类").strip() or "未分类"
        if point not in points:
            points.append(point)
    evidence_by_point: dict[str, list[dict[str, Any]]] = {}
    next_source = 1
    for point in points:
        evidence = []
        try:
            results = search_knowledge_base(query=f"{point} 核心概念 常见错误 解题方法", top_k=3)
        except Exception:
            results = []
        for result in results[:3]:
            metadata = result.metadata if isinstance(result.metadata, dict) else {}
            snippet = str(result.text or "").strip()[:600]
            if not snippet:
                continue
            evidence.append({
                "sourceId": f"S{next_source}",
                "title": str(metadata.get("title") or metadata.get("source_name") or "课程资料")[:255],
                "location": _citation_location(metadata),
                "snippet": snippet,
                "score": round(float(result.score or 0), 4),
            })
            next_source += 1
        evidence_by_point[point] = evidence
    return evidence_by_point


def _render_export(
    snapshot: dict[str, Any],
    export_format: str,
    *,
    enhancement: dict[str, Any],
    citations: list[dict[str, Any]],
    degraded_reasons: list[str],
) -> ExportArtifact:
    from backend.apps.assessments import wrong_exports

    render = getattr(wrong_exports, "render_wrong_export", None)
    if callable(render):
        return render(
            snapshot,
            export_format,
            enhancement=enhancement,
            citations=citations,
            degraded_reasons=degraded_reasons,
        )
    date_label = timezone.localdate().strftime("%Y%m%d")
    filename = f"wrong-questions-{snapshot['scope']}-{date_label}.{export_format}"
    if export_format == "docx":
        return ExportArtifact(wrong_exports._build_docx(snapshot), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename)
    if export_format == "xlsx":
        return ExportArtifact(wrong_exports._build_xlsx(snapshot), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename)
    return ExportArtifact(wrong_exports._build_pdf(snapshot), "application/pdf", filename)


def _save_job(job: WrongQuestionExportJob, **changes: Any) -> None:
    with transaction.atomic():
        current = WrongQuestionExportJob.objects.select_for_update().get(pk=job.pk)
        if current.status == "cancelled" and changes.get("status") != "cancelled":
            raise WrongExportCancelled
        for field, value in changes.items():
            setattr(current, field, value)
            setattr(job, field, value)
        current.save(update_fields=[*changes.keys(), "updated_at"])


def _is_cancelled(job_id) -> bool:
    return WrongQuestionExportJob.objects.filter(pk=job_id, status="cancelled").exists()


def _raise_if_cancelled(job_id) -> None:
    if _is_cancelled(job_id):
        raise WrongExportCancelled


def _artifact_root() -> Path:
    return Path(getattr(settings, "A3_WRONG_EXPORT_ROOT", settings.BASE_DIR / "tmp" / "wrong-exports"))


def _artifact_directory(job: WrongQuestionExportJob) -> Path:
    return _artifact_root() / str(job.user_id) / str(job.id)


def _atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def _citation_location(metadata: dict[str, Any]) -> str:
    page = metadata.get("page_number") or metadata.get("pageNumber")
    block = metadata.get("block_id") or metadata.get("blockId")
    if page:
        return f"第 {page} 页"
    if block:
        return f"位置 {str(block)[:80]}"
    return "资料正文"
