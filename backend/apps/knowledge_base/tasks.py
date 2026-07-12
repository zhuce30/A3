from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from celery import shared_task
from django.db import close_old_connections
from django.utils import timezone

from backend.apps.knowledge_base.models import (
    IndexJobStatus,
    IndexJobType,
    KnowledgeIndexJob,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.knowledge_base.personal_agent import PersonalMaterialAgent
from backend.domains.knowledge_base.multimodal_parser import IMAGE_EXTENSIONS
from backend.core.settings import DATA_ROOT, DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR, METADATA_DIR


@shared_task(bind=True, name="knowledge_base.run_index_job")
def run_index_job(self, job_id: str):
    close_old_connections()
    job = KnowledgeIndexJob.objects.get(id=job_id)
    job.celery_task_id = self.request.id or job.celery_task_id
    job.status = IndexJobStatus.RUNNING
    job.started_at = timezone.now()
    job.progress = 1
    job.error_message = ""
    job.progress_detail = {
        "schemaVersion": "a3.kb-progress.v1",
        "phase": "queued",
        "phaseLabel": "任务已启动，正在准备处理",
        "metrics": {"pagesParsed": 0, "blocksCreated": 0, "visualAssets": 0, "warnings": 0},
        "recentEvents": [{"time": timezone.now().isoformat(), "phase": "queued", "message": "任务已启动"}],
    }
    job.save(update_fields=["celery_task_id", "status", "started_at", "progress", "progress_detail", "error_message", "updated_at"])
    try:
        if job.job_type == IndexJobType.REBUILD:
            result = _run_full_rebuild(job)
        elif job.job_type == IndexJobType.WIKI:
            result = _run_wiki_rebuild_job(job)
        elif job.job_type == IndexJobType.PARSE:
            result = _run_parse_job(job)
        else:
            result = _run_incremental_upload(job)
        job.status = IndexJobStatus.SUCCEEDED
        job.progress = 100
        job.result = result
    except Exception as exc:
        job.status = IndexJobStatus.FAILED
        job.error_message = str(exc)[:4000]
        _update_job_progress_detail(job, {
            "phase": "failed",
            "phaseLabel": "任务失败",
            "event": job.error_message,
        })
    job.finished_at = timezone.now()
    job.current_file = ""
    if job.status == IndexJobStatus.SUCCEEDED:
        _update_job_progress_detail(job, {
            "phase": "done",
            "phaseLabel": "任务完成",
            "event": "知识库任务完成",
        }, progress=100)
    job.save(update_fields=["status", "progress", "result", "error_message", "finished_at", "current_file", "progress_detail", "updated_at"])
    close_old_connections()
    return job.result


def _job_progress_callback(job: KnowledgeIndexJob, resource, file_position: int, file_total: int):
    def report(detail: dict) -> None:
        phase_progress = _bounded_int(detail.get("phaseProgress"), fallback=job.progress)
        progress = min(94, int(((file_position - 1) + phase_progress / 100) / max(file_total, 1) * 95))
        _update_job_progress_detail(
            job,
            detail,
            resource=resource,
            file_position=file_position,
            file_total=file_total,
            progress=max(job.progress, progress),
        )
    return report


def _update_job_progress_detail(
    job: KnowledgeIndexJob,
    detail: dict[str, Any],
    *,
    resource=None,
    file_position: int | None = None,
    file_total: int | None = None,
    progress: int | None = None,
) -> None:
    existing = job.progress_detail if isinstance(job.progress_detail, dict) else {}
    phase = str(detail.get("phase") or existing.get("phase") or "running")
    phase_label = str(detail.get("phaseLabel") or existing.get("phaseLabel") or "正在处理任务")
    metrics = dict(existing.get("metrics") if isinstance(existing.get("metrics"), dict) else {})
    metrics.update(detail.get("metrics") if isinstance(detail.get("metrics"), dict) else {})
    recent_events = list(existing.get("recentEvents") if isinstance(existing.get("recentEvents"), list) else [])
    event_message = str(detail.get("event") or phase_label).strip()
    if event_message:
        recent_events.append({"time": timezone.now().isoformat(), "phase": phase, "message": event_message[:240]})
    resource_id = str(getattr(resource, "id", "") or detail.get("resourceId") or existing.get("resourceId") or "")
    resource_name = str(getattr(resource, "original_name", "") or detail.get("resourceName") or existing.get("resourceName") or "")
    job.progress_detail = {
        "schemaVersion": "a3.kb-progress.v1",
        "phase": phase,
        "phaseLabel": phase_label,
        "resourceId": resource_id,
        "resourceName": resource_name,
        "file": detail.get("file") if isinstance(detail.get("file"), dict) else (
            {"current": file_position, "total": file_total} if file_position and file_total else existing.get("file")
        ),
        "page": detail.get("page") if isinstance(detail.get("page"), dict) else existing.get("page"),
        "block": detail.get("block") if isinstance(detail.get("block"), dict) else existing.get("block"),
        "chunk": detail.get("chunk") if isinstance(detail.get("chunk"), dict) else existing.get("chunk"),
        "metrics": metrics,
        "recentEvents": recent_events[-8:],
    }
    if progress is not None:
        job.progress = _bounded_int(progress, fallback=job.progress)
    job.save(update_fields=["progress", "progress_detail", "updated_at"])


def _bounded_int(value: Any, *, fallback: int = 0) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return max(0, min(100, int(fallback or 0)))
    return max(0, min(100, number))


def _run_parse_job(job: KnowledgeIndexJob) -> dict:
    from backend.apps.knowledge_base.services import mark_text_blocks_indexed, reparse_resource
    from backend.apps.knowledge_base.wiki_builder import safe_rebuild_resource_wiki

    resources = list(job.resources.order_by("created_at"))
    parsed = 0
    failures = []
    for position, resource in enumerate(resources, start=1):
        job.current_file = resource.original_name
        job.processed_files = position - 1
        job.progress = max(1, int((position - 1) / max(len(resources), 1) * 95))
        job.save(update_fields=["current_file", "processed_files", "progress", "updated_at"])
        resource.status = ResourceStatus.INDEXING
        resource.error_message = ""
        resource.save(update_fields=["status", "error_message", "updated_at"])
        try:
            result = reparse_resource(resource, progress_callback=_job_progress_callback(job, resource, position, len(resources)))
            resource.refresh_from_db()
            if result.has_searchable_text:
                _update_job_progress_detail(job, {
                    "phase": "text_embedding",
                    "phaseLabel": f"正在写入文本向量 {resource.blocks.filter(modality__in=['text', 'table', 'formula']).count()} 块",
                    "event": "开始写入文本向量和关键词索引",
                    "metrics": {"blocksCreated": resource.blocks.count(), "warnings": len(result.warnings)},
                }, resource=resource, file_position=position, file_total=len(resources), progress=min(94, job.progress + 2))
                mark_text_blocks_indexed(resource)
            if result.status == "failed":
                resource.status = ResourceStatus.FAILED
                resource.error_message = "; ".join(result.warnings)[:2000]
                failures.append({"resourceId": str(resource.id), "name": resource.original_name, "error": resource.error_message})
            else:
                resource.status = ResourceStatus.INDEXED_WITH_WARNINGS if result.warnings else ResourceStatus.INDEXED
                resource.document_count = max(resource.document_count, len(result.pages))
                resource.chunk_count = max(resource.chunk_count, resource.blocks.count())
                parsed += 1
        except Exception as exc:
            resource.status = ResourceStatus.FAILED
            resource.error_message = f"{type(exc).__name__}: {exc}"[:2000]
            failures.append({"resourceId": str(resource.id), "name": resource.original_name, "error": resource.error_message})
        resource.save(update_fields=["status", "document_count", "chunk_count", "error_message", "updated_at"])
        if resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}:
            _update_job_progress_detail(job, {
                "phase": "wiki",
                "phaseLabel": "正在构建资料 Wiki",
                "event": "开始构建资料 Wiki",
                "metrics": {"pagesParsed": resource.document_count, "blocksCreated": resource.chunk_count},
            }, resource=resource, file_position=position, file_total=len(resources), progress=min(95, job.progress + 1))
            safe_rebuild_resource_wiki(resource)
        _update_job_progress_detail(job, {
            "phase": "personal_agent",
            "phaseLabel": "正在更新学习画像",
            "event": "开始执行个人资料 Agent",
            "metrics": {"pagesParsed": resource.document_count, "blocksCreated": resource.chunk_count},
        }, resource=resource, file_position=position, file_total=len(resources), progress=min(95, job.progress + 1))
        _run_personal_material_agent(resource)
        job.processed_files = position
        job.progress = min(95, int(position / max(len(resources), 1) * 95))
        job.save(update_fields=["processed_files", "progress", "updated_at"])
    return {"parsed": parsed, "failed": failures}


def _run_incremental_upload(job: KnowledgeIndexJob) -> dict:
    from backend.domains.knowledge_base.index_manager import append_source_file
    from backend.apps.knowledge_base.services import mark_text_blocks_indexed, persist_multimodal_parse
    from backend.apps.knowledge_base.wiki_builder import safe_rebuild_resource_wiki

    resources = list(job.resources.order_by("created_at"))
    failures = []
    indexed = 0
    for position, resource in enumerate(resources, start=1):
        job.current_file = resource.original_name
        job.processed_files = position - 1
        job.progress = max(1, int((position - 1) / max(len(resources), 1) * 95))
        job.save(update_fields=["current_file", "processed_files", "progress", "updated_at"])
        resource.status = ResourceStatus.INDEXING
        resource.error_message = ""
        resource.save(update_fields=["status", "error_message", "updated_at"])
        parse_result = None
        try:
            parse_result = persist_multimodal_parse(resource, progress_callback=_job_progress_callback(job, resource, position, len(resources)))
            if resource.file_type.lower() in IMAGE_EXTENSIONS:
                raise ValueError("Image resources require OCR/visual indexing before text-vector insertion.")
            _update_job_progress_detail(job, {
                "phase": "text_embedding",
                "phaseLabel": "正在写入文本向量索引",
                "event": "开始写入文本向量和关键词索引",
                "metrics": {"pagesParsed": len(parse_result.pages), "blocksCreated": resource.blocks.count(), "warnings": len(parse_result.warnings)},
            }, resource=resource, file_position=position, file_total=len(resources), progress=min(94, job.progress + 2))
            document_count, chunk_count, _ = append_source_file(
                Path(resource.stored_path),
                metadata={
                    "resource_id": str(resource.id),
                    "owner_id": str(resource.owner_id),
                    "original_name": resource.original_name,
                },
            )
            mark_text_blocks_indexed(resource)
            resource.status = ResourceStatus.INDEXED if chunk_count > 0 else ResourceStatus.INDEXED_WITH_WARNINGS
            resource.document_count = document_count
            resource.chunk_count = chunk_count
            indexed += 1
        except Exception as exc:
            if parse_result and parse_result.has_visual_evidence:
                if parse_result.has_searchable_text:
                    mark_text_blocks_indexed(resource)
                resource.status = ResourceStatus.INDEXED_WITH_WARNINGS
                resource.document_count = max(resource.document_count, len(parse_result.pages))
                resource.chunk_count = max(resource.chunk_count, resource.blocks.count())
                resource.error_message = str(exc)[:2000]
                indexed += 1
            else:
                resource.status = ResourceStatus.FAILED
                resource.error_message = str(exc)[:2000]
                failures.append({"resourceId": str(resource.id), "name": resource.original_name, "error": resource.error_message})
        resource.save(update_fields=["status", "document_count", "chunk_count", "error_message", "updated_at"])
        if resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}:
            _update_job_progress_detail(job, {
                "phase": "wiki",
                "phaseLabel": "正在构建资料 Wiki",
                "event": "开始构建资料 Wiki",
                "metrics": {"pagesParsed": resource.document_count, "blocksCreated": resource.chunk_count},
            }, resource=resource, file_position=position, file_total=len(resources), progress=min(95, job.progress + 1))
            safe_rebuild_resource_wiki(resource)
        _update_job_progress_detail(job, {
            "phase": "personal_agent",
            "phaseLabel": "正在更新学习画像",
            "event": "开始执行个人资料 Agent",
            "metrics": {"pagesParsed": resource.document_count, "blocksCreated": resource.chunk_count},
        }, resource=resource, file_position=position, file_total=len(resources), progress=min(95, job.progress + 1))
        _run_personal_material_agent(resource)
        job.processed_files = position
        job.progress = min(95, int(position / max(len(resources), 1) * 95))
        job.save(update_fields=["processed_files", "progress", "updated_at"])
    return {"indexed": indexed, "failed": failures}


def _run_wiki_rebuild_job(job: KnowledgeIndexJob) -> dict:
    from backend.apps.knowledge_base.wiki_builder import safe_rebuild_resource_wiki

    resources = list(job.resources.order_by("created_at"))
    rebuilt = 0
    failures = []
    for position, resource in enumerate(resources, start=1):
        job.current_file = resource.original_name
        job.processed_files = position - 1
        job.progress = max(1, int((position - 1) / max(len(resources), 1) * 95))
        job.save(update_fields=["current_file", "processed_files", "progress", "updated_at"])
        if resource.status not in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}:
            failures.append({"resourceId": str(resource.id), "name": resource.original_name, "error": "resource is not indexed"})
        else:
            result = safe_rebuild_resource_wiki(resource)
            if result.status == "failed":
                failures.append({"resourceId": str(resource.id), "name": resource.original_name, "error": result.reason})
            else:
                rebuilt += 1
        job.processed_files = position
        job.progress = min(95, int(position / max(len(resources), 1) * 95))
        job.save(update_fields=["processed_files", "progress", "updated_at"])
    return {"rebuilt": rebuilt, "failed": failures}


def _run_personal_material_agent(resource) -> None:
    if resource.resource_scope != ResourceScope.PERSONAL:
        return
    if resource.status not in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}:
        return
    try:
        PersonalMaterialAgent().analyze_and_writeback(resource)
    except Exception as exc:
        snapshot = resource.student_profile_snapshot if isinstance(resource.student_profile_snapshot, dict) else {}
        snapshot["personalMaterialAgentError"] = f"{type(exc).__name__}: {exc}"[:500]
        resource.student_profile_snapshot = snapshot
        resource.save(update_fields=["student_profile_snapshot", "updated_at"])


def _run_full_rebuild(job: KnowledgeIndexJob) -> dict:
    from backend.domains.knowledge_base.index_builder import build_knowledge_base_index

    active_dir = FAISS_INDEX_DIR.resolve()
    staging_dir = active_dir.parent / f"faiss_rebuild_{job.id.hex}"
    backup_dir = active_dir.parent / f"faiss_backup_{job.id.hex}"
    shutil.rmtree(staging_dir, ignore_errors=True)
    shutil.rmtree(backup_dir, ignore_errors=True)

    def report_progress(processed: int, total: int, current_file: str):
        job.processed_files = processed
        job.total_files = total
        job.current_file = current_file
        job.progress = min(60, int(processed / max(total, 1) * 60))
        job.save(update_fields=["processed_files", "total_files", "current_file", "progress", "updated_at"])

    report = build_knowledge_base_index(
        data_root=DATA_ROOT,
        persist_dir=staging_dir,
        embed_model_name=DEFAULT_EMBED_MODEL,
        progress_callback=report_progress,
    )
    job.progress = 90
    job.current_file = "正在切换新索引"
    job.save(update_fields=["progress", "current_file", "updated_at"])

    try:
        if active_dir.exists():
            active_dir.rename(backup_dir)
        staging_dir.rename(active_dir)
        shutil.rmtree(backup_dir, ignore_errors=True)
    except Exception:
        if not active_dir.exists() and backup_dir.exists():
            backup_dir.rename(active_dir)
        raise
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    report.persist_dir = str(active_dir)
    from backend.domains.knowledge_base.document_loader import write_build_report
    write_build_report(METADATA_DIR / "build_report.json", report.model_dump())
    return report.model_dump()
