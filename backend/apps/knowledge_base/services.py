from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from django.conf import settings
from django.core.files.uploadedfile import UploadedFile
from django.db import models

from backend.apps.knowledge_base.display import safe_source_filename
from backend.apps.knowledge_base.models import (
    IndexJobStatus,
    IndexJobType,
    KnowledgeAsset,
    KnowledgeBlock,
    KnowledgeIndexEntry,
    KnowledgeIndexJob,
    KnowledgePage,
    KnowledgeParseRun,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.core.settings import DATA_ROOT, METADATA_DIR
from backend.domains.knowledge_base.document_loader import SUPPORTED_EXTENSIONS, iter_source_files
from backend.domains.knowledge_base.lexical_retriever import _load_lexical_documents
from backend.domains.knowledge_base.multimodal_parser import IMAGE_EXTENSIONS, MultimodalParseResult, parse_resource
from backend.domains.knowledge_base.visual_retriever import remove_visual_resource_entries


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
    global_indexed_files = int(build_report.get("source_files_seen") or supported_count or 0)
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
    queryset = KnowledgeResource.objects.all()
    if getattr(user, "role", "") in {"teacher", "admin"}:
        return queryset.filter(
            models.Q(owner=user) & ~models.Q(resource_scope=ResourceScope.PERSONAL)
            | models.Q(resource_scope__in=[ResourceScope.CLASS, ResourceScope.GLOBAL])
        )
    return queryset.filter(
        models.Q(owner=user, resource_scope=ResourceScope.PERSONAL)
        | models.Q(resource_scope__in=[ResourceScope.TEACHER, ResourceScope.CLASS, ResourceScope.GLOBAL])
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
        raise ValueError("鏃х増 .ppt 涓嶈兘鐩存帴鍏ュ簱锛岃鍏堣浆鎹负 .pptx")
    if suffix not in SUPPORTED_EXTENSIONS and suffix not in IMAGE_EXTENSIONS:
        raise ValueError("浠呮敮鎸?PDF銆丳PTX銆乆LSX銆丳NG銆丣PG銆丣PEG銆乄EBP 鏂囦欢")
    max_size = int(getattr(settings, "KNOWLEDGE_UPLOAD_MAX_BYTES", 200 * 1024 * 1024))
    if upload.size > max_size:
        raise ValueError("鍗曚釜鏂囦欢涓嶈兘瓒呰繃 200MB")

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
        if getattr(settings, "DEBUG", False) and job.job_type in {IndexJobType.UPLOAD, IndexJobType.PARSE}:
            run_index_job.run(str(job.id))
            job.refresh_from_db()
            return job
        job.status = IndexJobStatus.FAILED
        job.error_message = f"任务队列不可用：{exc}"
        job.save(update_fields=["status", "error_message", "updated_at"])
    return job


def _should_run_upload_index_synchronously(job: KnowledgeIndexJob) -> bool:
    if job.job_type not in {IndexJobType.UPLOAD, IndexJobType.PARSE}:
        return False
    if job.job_type == IndexJobType.PARSE:
        return os.getenv("A3_KB_SYNC_PARSE", "").lower() in {"1", "true", "yes", "on"}
    return os.getenv("A3_KB_SYNC_INDEX_ON_UPLOAD", "").lower() in {"1", "true", "yes", "on"}


def retry_index_job(job: KnowledgeIndexJob) -> KnowledgeIndexJob:
    if job.status != IndexJobStatus.FAILED:
        raise ValueError("只有失败任务可以重试")
    job.status = IndexJobStatus.QUEUED
    job.progress = 0
    job.processed_files = 0
    job.current_file = ""
    job.result = {}
    job.error_message = ""
    job.started_at = None
    job.finished_at = None
    job.save(update_fields=[
        "status", "progress", "processed_files", "current_file", "result",
        "error_message", "started_at", "finished_at", "updated_at",
    ])
    if job.job_type in {IndexJobType.UPLOAD, IndexJobType.PARSE}:
        job.resources.filter(status=ResourceStatus.FAILED).update(
            status=ResourceStatus.UPLOADED,
            error_message="",
        )
    return dispatch_index_job(job)


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


def reparse_resource(resource: KnowledgeResource) -> MultimodalParseResult:
    result = persist_multimodal_parse(resource)
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


def persist_multimodal_parse(resource: KnowledgeResource) -> MultimodalParseResult:
    from backend.domains.knowledge_base.visual_retriever import upsert_visual_blocks
    from backend.apps.knowledge_base.graph_builder import safe_rebuild_resource_graph

    resource.graph_claims.all().delete()
    resource.graph_relations.all().delete()
    resource.graph_entities.all().delete()
    resource.blocks.all().delete()
    resource.assets.all().delete()
    resource.pages.all().delete()
    resource.parse_runs.all().delete()
    result = parse_resource(Path(resource.stored_path))
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
    for parsed_page in result.pages:
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
    upsert_visual_blocks(resource)
    safe_rebuild_resource_graph(resource)
    return result


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
