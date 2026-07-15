from __future__ import annotations

import re
from dataclasses import replace
from typing import Iterable


SCHEMA_VERSION = "a3.document-parse.v2"
BLOCK_SCHEMA_VERSION = "a3.document-block.v2"

STRUCTURED_MODALITIES = {"table", "formula", "image", "page_image", "slide_image"}
VISUAL_MODALITIES = {"image", "page_image", "slide_image"}
MOJIBAKE_RE = re.compile(r"[�锟璧勬枡鐭ヨ瘑涓诲垪]")


def finalize_parse_result(result):
    pages = []
    all_warnings = list(result.warnings or [])
    for page_index, page in enumerate(result.pages, start=1):
        pages.append(_finalize_page(page, page_index))
    metrics = evaluate_parse_quality(pages)
    warnings = list(dict.fromkeys([*all_warnings, *metrics.get("warnings", [])]))
    base_result = dict(result.result or {})
    base_result["documentParse"] = {
        "schemaVersion": SCHEMA_VERSION,
        **metrics,
    }
    status = result.status
    if pages and status == "completed" and metrics["overallQuality"] < 0.72:
        status = "completed_with_warnings"
    return replace(
        result,
        pages=pages,
        warnings=warnings,
        status=status,
        quality_score=metrics["overallQuality"],
        result=base_result,
    )


def evaluate_parse_quality(pages: Iterable) -> dict:
    pages = list(pages)
    if not pages:
        return {
            "overallQuality": 0,
            "textCoverage": 0,
            "garbledRatio": 0,
            "layoutCoverage": 0,
            "structuredBlockRate": 0,
            "visualCoverage": 0,
            "averageConfidence": 0,
            "citationReadiness": False,
            "providerChain": ["native"],
            "fallbackBlocks": 0,
            "ocrBlocks": 0,
            "warnings": ["document has no parsed pages."],
        }
    blocks = [block for page in pages for block in page.blocks]
    text_blocks = [block for block in blocks if str(block.text or "").strip()]
    structured_blocks = [block for block in blocks if block.modality in STRUCTURED_MODALITIES]
    visual_blocks = [block for block in blocks if block.modality in VISUAL_MODALITIES]
    ocr_blocks = [block for block in blocks if bool((block.metadata or {}).get("ocr"))]
    fallback_blocks = [block for block in blocks if str((block.metadata or {}).get("fallbackReason") or "").strip()]
    page_count = len(pages)
    text_page_count = sum(1 for page in pages if any(str(block.text or "").strip() for block in page.blocks))
    chars = "".join(str(block.text or "") for block in text_blocks)
    garbled_ratio = _garbled_ratio(chars)
    avg_confidence = _average(block.confidence for block in blocks)
    text_coverage = round(text_page_count / page_count, 3) if page_count else 0
    structured_block_rate = round(len(structured_blocks) / len(blocks), 3) if blocks else 0
    visual_coverage = round(len(visual_blocks) / page_count, 3) if page_count else 0
    citation_readiness = (
        text_coverage >= 0.7
        and garbled_ratio <= 0.08
        and avg_confidence >= 0.55
        and bool(text_blocks)
    )
    overall = (
        0.34 * text_coverage
        + 0.22 * avg_confidence
        + 0.18 * min(1.0, structured_block_rate * 2)
        + 0.16 * (1 - min(1.0, garbled_ratio * 4))
        + 0.10 * min(1.0, visual_coverage)
    )
    warnings: list[str] = []
    if page_count and text_coverage < 0.5:
        warnings.append("text coverage is low; enhanced OCR/layout parsing is recommended.")
    if garbled_ratio > 0.08:
        warnings.append("garbled text ratio is high; OCR/provider fallback should be retried.")
    if avg_confidence < 0.55:
        warnings.append("average block confidence is low.")
    if not citation_readiness:
        warnings.append("resource is not fully citation-ready for verified RAG.")
    return {
        "overallQuality": round(max(0.0, min(1.0, overall)), 3),
        "textCoverage": text_coverage,
        "garbledRatio": round(garbled_ratio, 3),
        "layoutCoverage": round(min(1.0, len(blocks) / max(1, page_count * 3)), 3) if page_count else 0,
        "structuredBlockRate": structured_block_rate,
        "visualCoverage": visual_coverage,
        "averageConfidence": round(avg_confidence, 3),
        "citationReadiness": citation_readiness,
        "providerChain": _provider_chain(blocks),
        "fallbackBlocks": len(fallback_blocks),
        "ocrBlocks": len(ocr_blocks),
        "warnings": warnings,
    }


def _finalize_page(page, page_index: int):
    blocks = []
    for order, block in enumerate(page.blocks, start=1):
        metadata = _block_metadata(block, page, page_index, order)
        blocks.append(replace(block, metadata=metadata))
    page_metadata = {
        "schemaVersion": SCHEMA_VERSION,
        "pageIndex": page_index,
        "blockCount": len(blocks),
        "hasVisualAsset": bool(page.assets),
        **(page.metadata or {}),
    }
    return replace(page, metadata=page_metadata, blocks=blocks)


def _block_metadata(block, page, page_index: int, order: int) -> dict:
    metadata = dict(block.metadata or {})
    block_type = str(metadata.get("blockType") or _block_type_from_modality(block.modality))
    provider = _infer_provider(metadata)
    fallback_reason = _fallback_reason(block, metadata)
    metadata.update(
        {
            "schemaVersion": BLOCK_SCHEMA_VERSION,
            "documentParseSchemaVersion": SCHEMA_VERSION,
            "blockType": block_type,
            "provider": provider,
            "readingOrderIndex": order,
            "pageIndex": page_index,
            "page": metadata.get("page") or page.page_number,
            "slide": metadata.get("slide") or page.slide_number,
            "confidenceBand": _confidence_band(block.confidence),
            "fallbackReason": fallback_reason,
            "citationReady": bool(str(block.text or "").strip()) and block.confidence >= 0.55 and not fallback_reason,
        }
    )
    return metadata


def _block_type_from_modality(modality: str) -> str:
    return {
        "text": "paragraph",
        "table": "table",
        "formula": "formula",
        "image": "figure_caption",
        "page_image": "page_image",
        "slide_image": "slide_image",
    }.get(modality, modality or "unknown")


def _infer_provider(metadata: dict) -> str:
    if metadata.get("provider"):
        return str(metadata["provider"])
    if metadata.get("ocr") and metadata.get("vlm"):
        return "local_ocr+vlm"
    if metadata.get("ocr"):
        return "local_ocr"
    if metadata.get("vlm"):
        return "vlm"
    if metadata.get("sourceType") in {"docx", "pptx", "pdf", "xlsx"}:
        return f"native_{metadata['sourceType']}"
    return "native"


def _fallback_reason(block, metadata: dict) -> str:
    if metadata.get("fallbackReason"):
        return str(metadata["fallbackReason"])
    warnings = " ".join(str(item) for item in (block.warnings or []))
    if "no extractable text" in warnings.lower():
        return "no_extractable_text"
    if "OCR" in warnings and not metadata.get("ocr"):
        return "ocr_unavailable"
    if block.confidence and block.confidence < 0.45:
        return "low_confidence"
    return ""


def _confidence_band(confidence: float) -> str:
    if confidence >= 0.8:
        return "high"
    if confidence >= 0.55:
        return "medium"
    return "low"


def _provider_chain(blocks: list) -> list[str]:
    providers = []
    for block in blocks:
        provider = str((block.metadata or {}).get("provider") or "").strip()
        if provider and provider not in providers:
            providers.append(provider)
    return providers or ["native"]


def _garbled_ratio(text: str) -> float:
    if not text:
        return 0
    suspicious = len(MOJIBAKE_RE.findall(text))
    return suspicious / max(1, len(text))


def _average(values) -> float:
    values = [float(value or 0) for value in values]
    return sum(values) / len(values) if values else 0
