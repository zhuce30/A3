from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Callable

from django.conf import settings
from django.core.files.uploadedfile import UploadedFile
from django.db import models, transaction
from django.utils import timezone

from backend.apps.knowledge_base.display import safe_source_filename
from backend.apps.knowledge_base.models import (
    IndexJobStatus,
    IndexJobType,
    KnowledgeAsset,
    KnowledgeAlias,
    KnowledgeBlock,
    KnowledgeConcept,
    KnowledgeDefinition,
    KnowledgeIndexEntry,
    KnowledgeIndexJob,
    KnowledgePage,
    KnowledgeParseRun,
    KnowledgeResource,
    KnowledgeSummary,
    ResourceScope,
    ResourceStatus,
)
from backend.core.settings import DATA_ROOT, FAISS_INDEX_DIR, METADATA_DIR
from backend.domains.knowledge_base.document_loader import SUPPORTED_EXTENSIONS, iter_source_files
from backend.domains.knowledge_base.lexical_retriever import _load_lexical_documents
from backend.domains.knowledge_base.multimodal_parser import IMAGE_EXTENSIONS, MultimodalParseResult, parse_resource
from backend.domains.knowledge_base.visual_retriever import remove_visual_resource_entries


ProgressCallback = Callable[[dict], None]

STALE_INDEX_JOB_MESSAGE = "后台索引任务在服务重启或队列中断后停止，请点击“重新解析”继续。"
DELETE_CANCELLED_INDEX_JOB_MESSAGE = "用户删除资料时取消了未完成的索引任务。"


def serialize_resource(resource: KnowledgeResource) -> dict:
    return {
        "id": str(resource.id),
        "name": resource.original_name,
        "type": resource.file_type.lstrip(".").upper(),
        "size": resource.file_size,
        "status": resource.status,
        "documentCount": resource.document_count,
        "chunks": resource.chunk_count,
        "error": resource.error_message,
        "scope": resource.resource_scope,
        "scopeLabel": resource_scope_label(resource.resource_scope),
        "courseKey": resource.course_key,
        "ownerId": str(resource.owner_id),
        "multimodal": build_resource_multimodal_summary(resource),
        "wiki": build_resource_wiki_summary(resource),
        "createdAt": resource.created_at.isoformat(),
        "updatedAt": resource.updated_at.isoformat(),
        "jobId": str(resource.index_job_id) if resource.index_job_id else None,
    }


def resource_scope_label(scope: str) -> str:
    return {
        ResourceScope.PERSONAL: "我的资料",
        ResourceScope.TEACHER: "教师资料",
        ResourceScope.CLASS: "班级资料",
        ResourceScope.GLOBAL: "全局知识库",
    }.get(scope, "本地资料")


def build_resource_multimodal_summary(resource: KnowledgeResource) -> dict:
    latest_parse = resource.parse_runs.order_by("-created_at").first()
    blocks = KnowledgeBlock.objects.filter(resource=resource)
    warnings: list[str] = []
    if latest_parse:
        warnings.extend(str(item) for item in (latest_parse.warnings or []) if str(item).strip())
    for item in blocks.exclude(warnings=[]).values_list("warnings", flat=True):
        warnings.extend(str(warning) for warning in (item or []) if str(warning).strip())
    deduped_warnings = list(dict.fromkeys(warnings))
    text_indexed = KnowledgeIndexEntry.objects.filter(
        block__resource=resource,
        index_type__in=["text_vector", "lexical"],
        status="indexed",
    ).count()
    visual_indexed = KnowledgeIndexEntry.objects.filter(
        block__resource=resource,
        index_type="visual_vector",
        status="indexed",
    ).count()
    parse_result = latest_parse.result if latest_parse and isinstance(latest_parse.result, dict) else {}
    document_parse = parse_result.get("documentParse") if isinstance(parse_result.get("documentParse"), dict) else {}
    return {
        "parseStatus": latest_parse.status if latest_parse else "not_started",
        "parser": latest_parse.parser if latest_parse else "",
        "schemaVersion": document_parse.get("schemaVersion") or "a3.document-parse.v1",
        "pages": resource.pages.count(),
        "textBlocks": blocks.filter(modality="text").count(),
        "imageBlocks": blocks.filter(modality="image").count(),
        "tableBlocks": blocks.filter(modality="table").count(),
        "formulaBlocks": blocks.filter(modality="formula").count(),
        "pageImageBlocks": blocks.filter(modality__in=["page_image", "slide_image"]).count(),
        "ocrChars": latest_parse.ocr_chars if latest_parse else 0,
        "textIndexed": text_indexed,
        "visualIndexed": visual_indexed,
        "qualityScore": latest_parse.quality_score if latest_parse else 0,
        "textCoverage": document_parse.get("textCoverage", 0),
        "garbledRatio": document_parse.get("garbledRatio", 0),
        "layoutCoverage": document_parse.get("layoutCoverage", 0),
        "structuredBlockRate": document_parse.get("structuredBlockRate", 0),
        "visualCoverage": document_parse.get("visualCoverage", 0),
        "averageConfidence": document_parse.get("averageConfidence", 0),
        "citationReadiness": bool(document_parse.get("citationReadiness", False)),
        "providerChain": document_parse.get("providerChain") if isinstance(document_parse.get("providerChain"), list) else [],
        "fallbackBlocks": int(document_parse.get("fallbackBlocks") or 0),
        "ocrBlocks": int(document_parse.get("ocrBlocks") or 0),
        "warnings": deduped_warnings[:10],
    }


def build_resource_wiki_summary(resource: KnowledgeResource) -> dict:
    concepts = KnowledgeConcept.objects.filter(resource=resource)
    concept_count = concepts.count()
    definition_count = KnowledgeDefinition.objects.filter(resource=resource).count()
    alias_count = KnowledgeAlias.objects.filter(concept__resource=resource).count()
    summary_count = KnowledgeSummary.objects.filter(resource=resource).count()
    latest_concept = concepts.order_by("-updated_at").first()
    if concept_count:
        status = "ready"
        reason = "Wiki 词条已构建，可用于定义、别名和结构化解释检索。"
    elif resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}:
        status = "not_built"
        reason = "资料已索引，但尚未生成 Wiki 词条。"
    elif resource.status == ResourceStatus.INDEXING:
        status = "pending"
        reason = "资料仍在解析或索引中，完成后才能构建 Wiki。"
    elif resource.status == ResourceStatus.FAILED:
        status = "blocked"
        reason = "资料解析或索引失败，暂时不能构建 Wiki。"
    else:
        status = "not_ready"
        reason = "资料尚未完成索引，暂时不能构建 Wiki。"
    return {
        "status": status,
        "conceptCount": concept_count,
        "definitionCount": definition_count,
        "aliasCount": alias_count,
        "summaryCount": summary_count,
        "lastBuiltAt": latest_concept.updated_at.isoformat() if latest_concept else None,
        "reason": reason,
    }


def serialize_index_job(job: KnowledgeIndexJob) -> dict:
    resources = list(job.resources.order_by("created_at"))
    result = job.result if isinstance(job.result, dict) else {}
    failed_result = result.get("failed") if isinstance(result.get("failed"), list) else []
    parsed_result = result.get("parsed")
    indexed_result = result.get("indexed")
    parsed_count = int(parsed_result) if isinstance(parsed_result, int) else sum(
        1 for resource in resources
        if resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}
        and resource.parse_runs.exists()
    )
    indexed_count = int(indexed_result) if isinstance(indexed_result, int) else sum(
        1 for resource in resources if resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}
    )
    failed_count = len(failed_result) if failed_result else sum(1 for resource in resources if resource.status == ResourceStatus.FAILED)
    summary = {
        "indexed": indexed_count,
        "failed": failed_count,
    }
    if job.job_type == IndexJobType.WIKI:
        rebuilt_result = result.get("rebuilt")
        rebuilt_count = int(rebuilt_result) if isinstance(rebuilt_result, int) else 0
        summary = {
            "rebuilt": rebuilt_count,
            "indexed": indexed_count,
            "failed": failed_count,
        }
    if job.job_type == IndexJobType.PARSE:
        summary = {
            "parsed": parsed_count,
            **summary,
        }
    return {
        "id": str(job.id),
        "type": job.job_type,
        "status": job.status,
        "progress": job.progress,
        "totalFiles": job.total_files,
        "processedFiles": job.processed_files,
        "currentFile": job.current_file,
        "progressDetail": job.progress_detail if isinstance(job.progress_detail, dict) else {},
        "result": result,
        "summary": summary,
        "resources": [
            {
                "id": str(resource.id),
                "name": resource.original_name,
                "status": resource.status,
                "documentCount": resource.document_count,
                "chunks": resource.chunk_count,
                "error": resource.error_message,
            }
            for resource in resources
        ],
        "error": job.error_message,
        "createdAt": job.created_at.isoformat(),
        "startedAt": job.started_at.isoformat() if job.started_at else None,
        "finishedAt": job.finished_at.isoformat() if job.finished_at else None,
    }


def serialize_resource_parse_detail(resource: KnowledgeResource) -> dict:
    return {
        "success": True,
        "resource": {
            "id": str(resource.id),
            "name": resource.original_name,
            "type": resource.file_type.lstrip(".").upper(),
            "status": resource.status,
        },
        "multimodal": build_resource_multimodal_summary(resource),
        "pages": [
            {
                "id": str(page.id),
                "pageNumber": page.page_number,
                "slideNumber": page.slide_number,
                "summary": page.summary,
                "qualityScore": page.quality_score,
                "warnings": page.warnings,
                "assets": [
                    {
                        "id": str(asset.id),
                        "kind": asset.kind,
                        "mimeType": asset.mime_type,
                        "width": asset.width,
                        "height": asset.height,
                        "previewUrl": f"/api/kb/assets/{asset.id}/preview/",
                    }
                    for asset in page.assets.order_by("created_at")
                ],
                "assetCount": page.assets.count(),
                "blockCount": page.blocks.count(),
            }
            for page in resource.pages.order_by("page_number", "slide_number", "created_at")
        ],
        "blocks": [
            {
                "id": str(block.id),
                "pageId": str(block.page_id) if block.page_id else None,
                "assetId": str(block.asset_id) if block.asset_id else None,
                "previewUrl": f"/api/kb/assets/{block.asset_id}/preview/" if block.asset_id else "",
                "modality": block.modality,
                "text": block.text[:1200],
                "confidence": block.confidence,
                "warnings": block.warnings,
                "metadata": block.metadata,
            }
            for block in resource.blocks.select_related("page", "asset").order_by("created_at")
        ],
    }


def knowledge_base_stats(owner) -> dict:
    resources = KnowledgeResource.objects.filter(owner=owner)
    build_report_path = METADATA_DIR / "build_report.json"
    build_report = {}
    if build_report_path.exists():
        try:
            build_report = json.loads(build_report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            build_report = {}
    supported_files = iter_source_files(DATA_ROOT)
    supported_count = sum(1 for path in supported_files if path.suffix.lower() in SUPPORTED_EXTENSIONS)
    skipped_items = _build_report_skipped_items(build_report.get("skipped"))
    global_indexed_files = int(build_report.get("source_files_seen") or 0)
    global_indexed_documents = int(build_report.get("documents_loaded") or 0)
    upload_indexed_documents = sum(resources.values_list("document_count", flat=True))
    return {
        "corpusFiles": supported_count,
        "globalIndexedFiles": global_indexed_files,
        "globalIndexedDocuments": global_indexed_documents,
        "skippedFiles": len(skipped_items),
        "skippedItems": skipped_items,
        "managedFiles": resources.count(),
        "indexedFiles": resources.filter(status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS]).count(),
        "failedFiles": resources.filter(status=ResourceStatus.FAILED).count(),
        "legacyPptFiles": 0,
        "indexedDocuments": global_indexed_documents,
        "uploadIndexedDocuments": upload_indexed_documents,
        "embedModel": build_report.get("embed_model", ""),
    }


def _build_report_skipped_items(raw_skipped) -> list[dict]:
    if isinstance(raw_skipped, int):
        return [{"name": "skipped", "reason": ""} for _ in range(max(0, raw_skipped))]
    if not isinstance(raw_skipped, list):
        return []
    items: list[dict] = []
    for item in raw_skipped:
        if isinstance(item, dict):
            name = safe_source_filename(item.get("file") or item.get("path") or item.get("source") or item.get("name"))
            reason = str(item.get("reason") or item.get("error") or "").strip()
        else:
            name = safe_source_filename(item)
            reason = ""
        items.append({"name": name or "skipped", "reason": reason[:200]})
    return items


def accessible_resources_for_user(user):
    queryset = KnowledgeResource.objects.exclude(visibility="offline")
    published_visibility = {"shared", "teacher", "course", "class", "global", "public"}
    if getattr(user, "role", "") in {"teacher", "admin"}:
        return queryset.filter(
            models.Q(owner=user) & ~models.Q(resource_scope=ResourceScope.PERSONAL)
            | models.Q(resource_scope=ResourceScope.GLOBAL)
            | models.Q(
                resource_scope__in=[ResourceScope.CLASS, "course"],
                visibility__in=published_visibility,
            )
        )
    return queryset.filter(
        models.Q(owner=user, resource_scope=ResourceScope.PERSONAL)
        | models.Q(resource_scope=ResourceScope.GLOBAL)
        | models.Q(
            resource_scope__in=[ResourceScope.TEACHER, ResourceScope.CLASS, "course"],
            visibility__in=published_visibility,
        )
    )


def indexed_resource_paths(owner) -> set[str]:
    return set(indexed_resource_scope_by_path(owner).keys())


def indexed_resource_scope_by_path(owner, *, include_global: bool = False) -> dict[str, str]:
    resources = accessible_resources_for_user(owner).filter(
        status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS],
    )
    scope_by_path = {
        str(Path(resource.stored_path).resolve()): resource.resource_scope
        for resource in resources
        if resource.stored_path
    }
    if include_global:
        for path in _global_corpus_paths():
            scope_by_path.setdefault(path, ResourceScope.GLOBAL)
    return scope_by_path


def _global_corpus_paths() -> set[str]:
    upload_root = Path(getattr(settings, "KNOWLEDGE_UPLOAD_ROOT", DATA_ROOT / "uploads")).resolve()
    managed_paths = {
        str(Path(path).resolve())
        for path in KnowledgeResource.objects.exclude(stored_path="").values_list("stored_path", flat=True)
        if path
    }
    global_paths: set[str] = set()
    for path in iter_source_files(DATA_ROOT):
        resolved = path.resolve()
        resolved_text = str(resolved)
        if resolved_text in managed_paths:
            continue
        if _is_relative_to(resolved, upload_root):
            continue
        global_paths.add(resolved_text)
    return global_paths


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def save_upload(owner, upload: UploadedFile, *, resource_scope: str | None = None, course_key: str = "", visibility: str = "owner") -> KnowledgeResource:
    original_name = Path(upload.name).name
    suffix = Path(original_name).suffix.lower()
    if suffix == ".ppt":
        raise ValueError("旧版 .ppt 不能直接入库，请先转换为 .pptx")
    if suffix not in SUPPORTED_EXTENSIONS and suffix not in IMAGE_EXTENSIONS:
        raise ValueError("仅支持 DOCX、PDF、PPTX、XLSX、PNG、JPG、JPEG、WEBP 文件")
    max_size = int(getattr(settings, "KNOWLEDGE_UPLOAD_MAX_BYTES", 200 * 1024 * 1024))
    if upload.size > max_size:
        raise ValueError("单个文件不能超过 200MB")

    upload_root = Path(getattr(settings, "KNOWLEDGE_UPLOAD_ROOT", DATA_ROOT / "uploads"))
    upload_root.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{original_name}"
    stored_path = (upload_root / stored_name).resolve()
    with stored_path.open("wb") as destination:
        for chunk in upload.chunks():
            destination.write(chunk)

    scope = resource_scope or ResourceScope.TEACHER
    return KnowledgeResource.objects.create(
        owner=owner,
        original_name=original_name,
        stored_path=str(stored_path),
        file_type=suffix,
        file_size=upload.size,
        resource_scope=scope,
        course_key=course_key[:128],
        visibility=visibility[:32] or "owner",
        status=ResourceStatus.UPLOADED,
    )


def create_upload_index_job(owner, resources: list[KnowledgeResource]) -> KnowledgeIndexJob:
    if not resources:
        raise ValueError("没有可入库的资源")
    job = KnowledgeIndexJob.objects.create(
        owner=owner,
        job_type=IndexJobType.UPLOAD,
        total_files=len(resources),
    )
    for resource in resources:
        resource.index_job = job
    KnowledgeResource.objects.bulk_update(resources, ["index_job"])
    return dispatch_index_job(job)


def create_parse_job(owner, resources: list[KnowledgeResource]) -> KnowledgeIndexJob:
    if not resources:
        raise ValueError("没有可解析的资源")
    job = KnowledgeIndexJob.objects.create(
        owner=owner,
        job_type=IndexJobType.PARSE,
        total_files=len(resources),
    )
    for resource in resources:
        resource.index_job = job
        resource.status = ResourceStatus.INDEXING
        resource.error_message = ""
    KnowledgeResource.objects.bulk_update(resources, ["index_job", "status", "error_message"])
    return dispatch_index_job(job)


def create_rebuild_job(owner) -> KnowledgeIndexJob:
    active = KnowledgeIndexJob.objects.filter(
        job_type=IndexJobType.REBUILD,
        status__in=[IndexJobStatus.QUEUED, IndexJobStatus.RUNNING],
    ).first()
    if active:
        raise ValueError("已有全量重建任务正在执行")
    total_files = len(iter_source_files(DATA_ROOT))
    job = KnowledgeIndexJob.objects.create(
        owner=owner,
        job_type=IndexJobType.REBUILD,
        total_files=total_files,
    )
    return dispatch_index_job(job)


def create_wiki_rebuild_job(owner, resources: list[KnowledgeResource]) -> KnowledgeIndexJob:
    ready_resources = [
        resource
        for resource in resources
        if resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}
    ]
    if not ready_resources:
        raise ValueError("没有可重建 Wiki 的已索引资源")
    job = KnowledgeIndexJob.objects.create(
        owner=owner,
        job_type=IndexJobType.WIKI,
        total_files=len(ready_resources),
    )
    for resource in ready_resources:
        resource.index_job = job
    KnowledgeResource.objects.bulk_update(ready_resources, ["index_job"])
    return dispatch_index_job(job)


def dispatch_index_job(job: KnowledgeIndexJob) -> KnowledgeIndexJob:
    from backend.apps.knowledge_base.tasks import run_index_job

    if _should_run_upload_index_synchronously(job):
        run_index_job.run(str(job.id))
        job.refresh_from_db()
        return job

    try:
        async_result = run_index_job.delay(str(job.id))
        job.celery_task_id = async_result.id or ""
        job.save(update_fields=["celery_task_id", "updated_at"])
    except Exception as exc:
        if getattr(settings, "DEBUG", False) and job.job_type in {IndexJobType.UPLOAD, IndexJobType.PARSE, IndexJobType.WIKI}:
            run_index_job.run(str(job.id))
            job.refresh_from_db()
            return job
        job.status = IndexJobStatus.FAILED
        job.error_message = f"任务队列不可用：{exc}"
        job.save(update_fields=["status", "error_message", "updated_at"])
    return job


def _should_run_upload_index_synchronously(job: KnowledgeIndexJob) -> bool:
    if job.job_type not in {IndexJobType.UPLOAD, IndexJobType.PARSE, IndexJobType.WIKI}:
        return False
    if job.job_type == IndexJobType.PARSE:
        return os.getenv("A3_KB_SYNC_PARSE", "").lower() in {"1", "true", "yes", "on"}
    if job.job_type == IndexJobType.WIKI:
        return os.getenv("A3_KB_SYNC_WIKI", "").lower() in {"1", "true", "yes", "on"}
    return os.getenv("A3_KB_SYNC_INDEX_ON_UPLOAD", "").lower() in {"1", "true", "yes", "on"}


def retry_index_job(job: KnowledgeIndexJob) -> KnowledgeIndexJob:
    if job.status != IndexJobStatus.FAILED:
        raise ValueError("只有失败任务可以重试")
    job.status = IndexJobStatus.QUEUED
    job.progress = 0
    job.processed_files = 0
    job.current_file = ""
    job.progress_detail = {}
    job.result = {}
    job.error_message = ""
    job.started_at = None
    job.finished_at = None
    job.save(update_fields=[
        "status", "progress", "processed_files", "current_file", "progress_detail", "result",
        "error_message", "started_at", "finished_at", "updated_at",
    ])
    if job.job_type in {IndexJobType.UPLOAD, IndexJobType.PARSE}:
        job.resources.filter(status=ResourceStatus.FAILED).update(
            status=ResourceStatus.UPLOADED,
            error_message="",
        )
    return dispatch_index_job(job)


def fail_stale_index_jobs(owner=None, *, stale_after: timedelta | None = None) -> int:
    minutes = int(getattr(settings, "KNOWLEDGE_INDEX_JOB_STALE_MINUTES", 10) or 10)
    cutoff = timezone.now() - (stale_after or timedelta(minutes=max(minutes, 1)))
    queryset = KnowledgeIndexJob.objects.filter(
        status=IndexJobStatus.RUNNING,
        updated_at__lt=cutoff,
    ).prefetch_related("resources")
    if owner is not None:
        queryset = queryset.filter(owner=owner)

    stale_jobs = list(queryset)
    if any(job.celery_task_id for job in stale_jobs):
        active_task_ids = _active_celery_task_ids()
        stale_jobs = [
            job
            for job in stale_jobs
            if not job.celery_task_id
            or (active_task_ids is not None and job.celery_task_id not in active_task_ids)
        ]
    now = timezone.now()
    for job in stale_jobs:
        interrupted_resources = list(job.resources.filter(status=ResourceStatus.INDEXING))
        result = dict(job.result) if isinstance(job.result, dict) else {}
        failed = list(result.get("failed")) if isinstance(result.get("failed"), list) else []
        failed_resource_ids = {
            str(item.get("resourceId"))
            for item in failed
            if isinstance(item, dict) and item.get("resourceId")
        }
        for resource in interrupted_resources:
            resource_id = str(resource.id)
            if resource_id not in failed_resource_ids:
                failed.append({
                    "resourceId": resource_id,
                    "name": resource.original_name,
                    "error": STALE_INDEX_JOB_MESSAGE,
                })
        result["failed"] = failed
        result["interrupted"] = True

        progress_detail = dict(job.progress_detail) if isinstance(job.progress_detail, dict) else {}
        recent_events = list(progress_detail.get("recentEvents") if isinstance(progress_detail.get("recentEvents"), list) else [])
        recent_events.append({
            "time": now.isoformat(),
            "phase": "interrupted",
            "message": STALE_INDEX_JOB_MESSAGE,
        })
        progress_detail.update({
            "schemaVersion": "a3.kb-progress.v1",
            "phase": "interrupted",
            "phaseLabel": "任务已中断",
            "recentEvents": recent_events[-8:],
        })

        job.status = IndexJobStatus.FAILED
        job.error_message = STALE_INDEX_JOB_MESSAGE
        job.finished_at = now
        job.current_file = ""
        job.result = result
        job.progress_detail = progress_detail
        job.save(update_fields=[
            "status", "error_message", "finished_at", "current_file", "result",
            "progress_detail", "updated_at",
        ])

        if interrupted_resources:
            KnowledgeResource.objects.filter(
                id__in=[resource.id for resource in interrupted_resources],
                status=ResourceStatus.INDEXING,
            ).update(status=ResourceStatus.FAILED, error_message=STALE_INDEX_JOB_MESSAGE)
    return len(stale_jobs)


def _active_celery_task_ids() -> set[str] | None:
    from backend.config.celery import app

    timeout = float(getattr(settings, "KNOWLEDGE_CELERY_INSPECT_TIMEOUT_SECONDS", 2) or 2)
    try:
        workers = app.control.inspect(timeout=max(timeout, 0.1)).active()
    except Exception:
        return None
    if workers is None:
        return None

    task_ids: set[str] = set()
    for tasks in workers.values():
        for task in tasks or []:
            if not isinstance(task, dict):
                continue
            task_id = str(task.get("id") or (task.get("request") or {}).get("id") or "").strip()
            if task_id:
                task_ids.add(task_id)
    return task_ids


def save_and_index_upload(owner, upload: UploadedFile) -> KnowledgeResource:
    """Backward-compatible synchronous helper used by focused service tests."""
    resource = save_upload(owner, upload)
    from backend.domains.knowledge_base.index_manager import append_source_file

    resource.status = ResourceStatus.INDEXING
    parse_result = persist_multimodal_parse(resource)
    try:
        if resource.file_type.lower() in IMAGE_EXTENSIONS:
            raise ValueError("Image resources require OCR/visual indexing before text-vector insertion.")
        document_count, chunk_count, _ = append_source_file(
            Path(resource.stored_path),
            metadata={
                "resource_id": str(resource.id),
                "owner_id": str(owner.id),
                "original_name": resource.original_name,
            },
        )
        mark_text_blocks_indexed(resource)
        resource.status = ResourceStatus.INDEXED if chunk_count > 0 else ResourceStatus.INDEXED_WITH_WARNINGS
        resource.document_count = document_count
        resource.chunk_count = chunk_count
    except Exception as exc:
        if parse_result.has_visual_evidence:
            if parse_result.has_searchable_text:
                mark_text_blocks_indexed(resource)
            resource.status = ResourceStatus.INDEXED_WITH_WARNINGS
            resource.document_count = max(resource.document_count, len(parse_result.pages))
            resource.chunk_count = max(resource.chunk_count, resource.blocks.count())
            resource.error_message = str(exc)[:2000]
        else:
            resource.status = ResourceStatus.FAILED
            resource.error_message = str(exc)[:2000]
    resource.save(update_fields=["status", "document_count", "chunk_count", "error_message", "updated_at"])
    return resource


def reparse_resource(resource: KnowledgeResource, progress_callback: ProgressCallback | None = None) -> MultimodalParseResult:
    result = persist_multimodal_parse(resource, progress_callback=progress_callback)
    if result.has_searchable_text:
        mark_text_blocks_indexed(resource)
    if resource.status in {ResourceStatus.UPLOADED, ResourceStatus.INDEXING, ResourceStatus.FAILED}:
        if result.status == "failed":
            resource.status = ResourceStatus.FAILED
            resource.error_message = "; ".join(result.warnings)[:2000]
        elif result.has_visual_evidence and not result.has_searchable_text:
            resource.status = ResourceStatus.INDEXED_WITH_WARNINGS
            resource.document_count = max(resource.document_count, len(result.pages))
            resource.chunk_count = max(resource.chunk_count, resource.blocks.count())
        else:
            resource.status = ResourceStatus.INDEXED_WITH_WARNINGS if result.warnings else ResourceStatus.INDEXED
            resource.document_count = max(resource.document_count, len(result.pages))
            resource.chunk_count = max(resource.chunk_count, resource.blocks.count())
        resource.save(update_fields=["status", "document_count", "chunk_count", "error_message", "updated_at"])
    return result


def persist_multimodal_parse(
    resource: KnowledgeResource,
    progress_callback: ProgressCallback | None = None,
) -> MultimodalParseResult:
    from backend.domains.knowledge_base.visual_retriever import upsert_visual_blocks
    from backend.apps.knowledge_base.graph_builder import safe_rebuild_resource_graph

    _emit_parse_progress(progress_callback, {
        "phase": "cleanup",
        "phaseLabel": "正在清理旧解析结果",
        "metrics": {"pagesParsed": 0, "blocksCreated": 0, "visualAssets": 0, "warnings": 0},
        "event": "开始清理旧解析结果",
        "phaseProgress": 3,
    })
    resource.graph_claims.all().delete()
    resource.graph_relations.all().delete()
    resource.graph_entities.all().delete()
    resource.blocks.all().delete()
    resource.assets.all().delete()
    resource.pages.all().delete()
    resource.parse_runs.all().delete()
    _emit_parse_progress(progress_callback, {
        "phase": "parse",
        "phaseLabel": "正在解析资料结构",
        "event": "开始多模态解析",
        "phaseProgress": 8,
    })
    result = parse_resource(Path(resource.stored_path), progress_callback=progress_callback)
    total_blocks = sum(len(page.blocks) for page in result.pages)
    total_assets = sum(len(page.assets) for page in result.pages)
    _emit_parse_progress(progress_callback, {
        "phase": "persist",
        "phaseLabel": f"正在写入解析结果 0/{max(len(result.pages), 1)} 页",
        "page": {"current": 0, "total": len(result.pages)},
        "block": {"current": 0, "total": total_blocks},
        "metrics": {
            "pagesParsed": len(result.pages),
            "blocksCreated": total_blocks,
            "visualAssets": total_assets,
            "warnings": len(result.warnings),
        },
        "event": f"解析完成，准备写入 {len(result.pages)} 页、{total_blocks} 个知识块",
        "phaseProgress": 58,
    })
    parse_run = KnowledgeParseRun.objects.create(
        resource=resource,
        status=result.status,
        parser=result.parser,
        pages=len(result.pages),
        text_blocks=sum(1 for page in result.pages for block in page.blocks if block.modality == "text"),
        image_blocks=sum(1 for page in result.pages for block in page.blocks if block.modality in {"image", "page_image", "slide_image"}),
        table_blocks=sum(1 for page in result.pages for block in page.blocks if block.modality == "table"),
        formula_blocks=sum(1 for page in result.pages for block in page.blocks if block.modality == "formula"),
        ocr_chars=sum(len(page.ocr_text or "") for page in result.pages),
        quality_score=result.quality_score,
        warnings=result.warnings,
        result=result.result,
    )
    created_blocks = 0
    for page_position, parsed_page in enumerate(result.pages, start=1):
        page = KnowledgePage.objects.create(
            resource=resource,
            parse_run=parse_run,
            page_number=parsed_page.page_number,
            slide_number=parsed_page.slide_number,
            ocr_text=parsed_page.ocr_text,
            summary=parsed_page.summary,
            quality_score=parsed_page.quality_score,
            warnings=parsed_page.warnings,
            metadata=parsed_page.metadata,
        )
        default_asset = None
        for parsed_asset in parsed_page.assets:
            default_asset = KnowledgeAsset.objects.create(
                resource=resource,
                page=page,
                kind=parsed_asset.kind,
                mime_type=parsed_asset.mime_type,
                storage_path=parsed_asset.storage_path,
                sha256=parsed_asset.sha256,
                width=parsed_asset.width,
                height=parsed_asset.height,
                metadata=parsed_asset.metadata,
            )
        for parsed_block in parsed_page.blocks:
            block = KnowledgeBlock.objects.create(
                resource=resource,
                page=page,
                asset=default_asset if parsed_block.modality in {"image", "page_image", "slide_image"} else None,
                modality=parsed_block.modality,
                text=parsed_block.text,
                confidence=parsed_block.confidence,
                warnings=parsed_block.warnings,
                metadata=parsed_block.metadata,
            )
            created_blocks += 1
        _emit_parse_progress(progress_callback, {
            "phase": "persist",
            "phaseLabel": f"正在写入解析结果 {page_position}/{max(len(result.pages), 1)} 页",
            "page": {"current": page_position, "total": len(result.pages)},
            "block": {"current": created_blocks, "total": total_blocks},
            "metrics": {
                "pagesParsed": page_position,
                "blocksCreated": created_blocks,
                "visualAssets": total_assets,
                "warnings": len(result.warnings),
            },
            "event": f"已写入第 {page_position} 页，累计 {created_blocks} 个知识块",
            "phaseProgress": min(72, 58 + round(page_position / max(len(result.pages), 1) * 14)),
        })
    _emit_parse_progress(progress_callback, {
        "phase": "visual_embedding",
        "phaseLabel": f"正在写入视觉向量证据 {total_assets} 个",
        "metrics": {
            "pagesParsed": len(result.pages),
            "blocksCreated": total_blocks,
            "visualAssets": total_assets,
            "warnings": len(result.warnings),
        },
        "event": "开始更新视觉向量索引",
        "phaseProgress": 78,
    })
    upsert_visual_blocks(resource)
    _emit_parse_progress(progress_callback, {
        "phase": "graph",
        "phaseLabel": "正在构建知识图谱",
        "metrics": {
            "pagesParsed": len(result.pages),
            "blocksCreated": total_blocks,
            "visualAssets": total_assets,
            "warnings": len(result.warnings),
        },
        "event": "视觉证据索引完成，开始构建知识图谱",
        "phaseProgress": 86,
    })
    safe_rebuild_resource_graph(resource)
    _emit_parse_progress(progress_callback, {
        "phase": "parse_done",
        "phaseLabel": f"解析完成：{len(result.pages)} 页 / {total_blocks} 块",
        "page": {"current": len(result.pages), "total": len(result.pages)},
        "block": {"current": total_blocks, "total": total_blocks},
        "metrics": {
            "pagesParsed": len(result.pages),
            "blocksCreated": total_blocks,
            "visualAssets": total_assets,
            "warnings": len(result.warnings),
        },
        "event": f"多模态解析完成：{len(result.pages)} 页、{total_blocks} 块、{len(result.warnings)} 个 warning",
        "phaseProgress": 90,
    })
    return result


def _emit_parse_progress(progress_callback: ProgressCallback | None, detail: dict) -> None:
    if progress_callback is None:
        return
    progress_callback(detail)


def mark_text_blocks_indexed(resource: KnowledgeResource) -> None:
    for block in resource.blocks.filter(modality__in=["text", "table", "formula"]):
        KnowledgeIndexEntry.objects.get_or_create(
            block=block,
            index_type="text_vector",
            index_backend="faiss",
            defaults={"external_id": str(block.id), "status": "indexed"},
        )
        KnowledgeIndexEntry.objects.get_or_create(
            block=block,
            index_type="lexical",
            index_backend="bm25",
            defaults={"external_id": str(block.id), "status": "indexed"},
        )


def delete_resource(resource: KnowledgeResource) -> None:
    resource_id = str(resource.id)
    path = Path(resource.stored_path)
    asset_paths = [Path(storage_path) for storage_path in resource.assets.values_list("storage_path", flat=True) if storage_path]
    remove_visual_resource_entries(resource_id, path)
    if path.exists():
        path.unlink()
    for asset_path in asset_paths:
        if asset_path.exists() and asset_path.is_file():
            asset_path.unlink()
    resource.delete()
    _load_lexical_documents.cache_clear()


def cancel_resource_indexing_for_delete(resource: KnowledgeResource) -> bool:
    job = resource.index_job
    if not job or job.status not in {IndexJobStatus.QUEUED, IndexJobStatus.RUNNING}:
        return False

    now = timezone.now()
    result = dict(job.result) if isinstance(job.result, dict) else {}
    failed = list(result.get("failed")) if isinstance(result.get("failed"), list) else []
    failed_resource_ids = {
        str(item.get("resourceId"))
        for item in failed
        if isinstance(item, dict) and item.get("resourceId")
    }
    resource_id = str(resource.id)
    if resource_id not in failed_resource_ids:
        failed.append({
            "resourceId": resource_id,
            "name": resource.original_name,
            "error": DELETE_CANCELLED_INDEX_JOB_MESSAGE,
        })
    result["failed"] = failed
    result["cancelledByDelete"] = True

    progress_detail = dict(job.progress_detail) if isinstance(job.progress_detail, dict) else {}
    recent_events = list(progress_detail.get("recentEvents") if isinstance(progress_detail.get("recentEvents"), list) else [])
    recent_events.append({
        "time": now.isoformat(),
        "phase": "cancelled",
        "message": DELETE_CANCELLED_INDEX_JOB_MESSAGE,
    })
    progress_detail.update({
        "schemaVersion": "a3.kb-progress.v1",
        "phase": "cancelled",
        "phaseLabel": "任务已取消",
        "resourceId": resource_id,
        "resourceName": resource.original_name,
        "recentEvents": recent_events[-8:],
    })

    remaining_active_resources = job.resources.exclude(id=resource.id).filter(
        status=ResourceStatus.INDEXING,
    ).exists()
    if not remaining_active_resources:
        job.status = IndexJobStatus.FAILED
        job.error_message = DELETE_CANCELLED_INDEX_JOB_MESSAGE
        job.finished_at = now
        job.current_file = ""
    job.result = result
    job.progress_detail = progress_detail
    job.save(update_fields=[
        "status", "error_message", "finished_at", "current_file", "result",
        "progress_detail", "updated_at",
    ])
    resource.status = ResourceStatus.FAILED
    resource.error_message = DELETE_CANCELLED_INDEX_JOB_MESSAGE
    resource.index_job = None
    resource.save(update_fields=["status", "error_message", "index_job", "updated_at"])
    return True


def clear_text_index_storage() -> None:
    if FAISS_INDEX_DIR.exists():
        shutil.rmtree(FAISS_INDEX_DIR)
    build_report_path = METADATA_DIR / "build_report.json"
    if build_report_path.exists():
        build_report_path.unlink()
    try:
        from backend.domains.knowledge_base.retriever import _index_cache

        _index_cache.clear()
    except Exception:
        pass
    _load_lexical_documents.cache_clear()


def reset_derived_resources(resources: list[KnowledgeResource]) -> dict:
    built_resources = [resource for resource in resources if _resource_has_derived_data(resource)]
    if not built_resources:
        raise ValueError("没有已构建的知识库资料可清理")
    _reject_active_resources(built_resources)
    with transaction.atomic():
        report = _derived_cleanup_report(built_resources)
        clear_text_index_storage()
        for resource in built_resources:
            _delete_resource_derived_data(resource)
            resource.status = ResourceStatus.UPLOADED
            resource.document_count = 0
            resource.chunk_count = 0
            resource.error_message = ""
            resource.index_job = None
            resource.save(update_fields=["status", "document_count", "chunk_count", "error_message", "index_job", "updated_at"])
    return report


def clear_knowledge_resources(owner, resources: list[KnowledgeResource], *, confirm_text: str) -> dict:
    if confirm_text != "清空知识库":
        raise ValueError("请输入“清空知识库”确认危险操作")
    if not resources:
        return _empty_cleanup_report()
    _reject_active_resources(resources)
    with transaction.atomic():
        report = _derived_cleanup_report(resources)
        report["resources"] = len(resources)
        clear_text_index_storage()
        for resource in resources:
            delete_resource(resource)
        job_count = KnowledgeIndexJob.objects.filter(owner=owner).count()
        KnowledgeIndexJob.objects.filter(owner=owner).delete()
        report["jobs"] = job_count
    return report


def _reject_active_resources(resources: list[KnowledgeResource]) -> None:
    for resource in resources:
        if resource.status == ResourceStatus.INDEXING or (
            resource.index_job_id
            and resource.index_job
            and resource.index_job.status in {IndexJobStatus.QUEUED, IndexJobStatus.RUNNING}
        ):
            raise ValueError("有资料正在解析或索引，请等待任务结束后再清理")


def _resource_has_derived_data(resource: KnowledgeResource) -> bool:
    if resource.document_count > 0 or resource.chunk_count > 0:
        return True
    if resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS, ResourceStatus.FAILED}:
        return True
    return (
        resource.parse_runs.exists()
        or resource.pages.exists()
        or resource.assets.exists()
        or resource.blocks.exists()
        or resource.graph_entities.exists()
        or resource.graph_relations.exists()
        or resource.graph_claims.exists()
        or resource.concepts.exists()
        or resource.definitions.exists()
        or resource.summaries.exists()
    )


def _empty_cleanup_report() -> dict:
    return {
        "resources": 0,
        "parseRuns": 0,
        "pages": 0,
        "assets": 0,
        "blocks": 0,
        "indexEntries": 0,
        "graphEntities": 0,
        "graphRelations": 0,
        "graphClaims": 0,
        "concepts": 0,
        "definitions": 0,
        "aliases": 0,
        "summaries": 0,
        "jobs": 0,
    }


def _derived_cleanup_report(resources: list[KnowledgeResource]) -> dict:
    ids = [resource.id for resource in resources]
    concepts = KnowledgeConcept.objects.filter(resource_id__in=ids)
    blocks = KnowledgeBlock.objects.filter(resource_id__in=ids)
    return {
        "resources": 0,
        "parseRuns": KnowledgeParseRun.objects.filter(resource_id__in=ids).count(),
        "pages": KnowledgePage.objects.filter(resource_id__in=ids).count(),
        "assets": KnowledgeAsset.objects.filter(resource_id__in=ids).count(),
        "blocks": blocks.count(),
        "indexEntries": KnowledgeIndexEntry.objects.filter(block__resource_id__in=ids).count(),
        "graphEntities": sum(resource.graph_entities.count() for resource in resources),
        "graphRelations": sum(resource.graph_relations.count() for resource in resources),
        "graphClaims": sum(resource.graph_claims.count() for resource in resources),
        "concepts": concepts.count(),
        "definitions": KnowledgeDefinition.objects.filter(resource_id__in=ids).count(),
        "aliases": KnowledgeAlias.objects.filter(concept__in=concepts).count(),
        "summaries": KnowledgeSummary.objects.filter(resource_id__in=ids).count(),
        "jobs": 0,
    }


def _delete_resource_derived_data(resource: KnowledgeResource) -> None:
    asset_paths = [Path(storage_path) for storage_path in resource.assets.values_list("storage_path", flat=True) if storage_path]
    remove_visual_resource_entries(str(resource.id), Path(resource.stored_path))
    resource.graph_claims.all().delete()
    resource.graph_relations.all().delete()
    resource.graph_entities.all().delete()
    resource.summaries.all().delete()
    resource.definitions.all().delete()
    resource.concepts.all().delete()
    resource.blocks.all().delete()
    resource.assets.all().delete()
    resource.pages.all().delete()
    resource.parse_runs.all().delete()
    for asset_path in asset_paths:
        if asset_path.exists() and asset_path.is_file():
            asset_path.unlink()
    _load_lexical_documents.cache_clear()
