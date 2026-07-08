from __future__ import annotations

import shutil
from pathlib import Path

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
    job.save(update_fields=["celery_task_id", "status", "started_at", "progress", "error_message", "updated_at"])
    try:
        if job.job_type == IndexJobType.REBUILD:
            result = _run_full_rebuild(job)
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
    job.finished_at = timezone.now()
    job.current_file = ""
    job.save(update_fields=["status", "progress", "result", "error_message", "finished_at", "current_file", "updated_at"])
    close_old_connections()
    return job.result


def _run_parse_job(job: KnowledgeIndexJob) -> dict:
    from backend.apps.knowledge_base.services import mark_text_blocks_indexed, reparse_resource

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
            result = reparse_resource(resource)
            resource.refresh_from_db()
            if result.has_searchable_text:
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
        _run_personal_material_agent(resource)
        job.processed_files = position
        job.progress = min(95, int(position / max(len(resources), 1) * 95))
        job.save(update_fields=["processed_files", "progress", "updated_at"])
    return {"parsed": parsed, "failed": failures}


def _run_incremental_upload(job: KnowledgeIndexJob) -> dict:
    from backend.domains.knowledge_base.index_manager import append_source_file
    from backend.apps.knowledge_base.services import mark_text_blocks_indexed, persist_multimodal_parse

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
            parse_result = persist_multimodal_parse(resource)
            if resource.file_type.lower() in IMAGE_EXTENSIONS:
                raise ValueError("Image resources require OCR/visual indexing before text-vector insertion.")
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
        _run_personal_material_agent(resource)
        job.processed_files = position
        job.progress = min(95, int(position / max(len(resources), 1) * 95))
        job.save(update_fields=["processed_files", "progress", "updated_at"])
    return {"indexed": indexed, "failed": failures}


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
