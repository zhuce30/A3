from __future__ import annotations

from dataclasses import dataclass

from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgeResource


PPT_BLOCK_LABELS = {
    "slide_title": "标题",
    "text_box": "文本框",
    "bullet": "项目符号",
    "table": "表格",
    "chart": "图表",
    "image": "图片",
    "formula": "公式",
    "speaker_note": "演讲者备注",
    "ocr_text": "OCR 文本",
    "image_caption": "图片说明",
    "slide_image": "整页截图",
    "text": "文本",
}


@dataclass(frozen=True)
class MaterialBlock:
    resource_id: str
    resource_title: str
    resource_type: str
    block_id: str
    block_type: str
    page_number: int | None
    slide_index: int | None
    location: str
    text: str
    confidence: float
    degraded: bool
    warnings: list[str]
    metadata: dict

    @property
    def evidence(self) -> dict:
        payload = {
            "resourceId": self.resource_id,
            "resourceTitle": self.resource_title,
            "resourceType": self.resource_type,
            "blockId": self.block_id,
            "blockType": self.block_type,
            "pageNumber": self.page_number,
            "slideIndex": self.slide_index,
            "location": self.location,
            "snippet": _shorten(self.text, 220),
            "markdownSnippet": _shorten(str(self.metadata.get("markdownText") or self.text), 600),
            "contentFormat": str(self.metadata.get("contentFormat") or "plain"),
            "formatFeatures": list(self.metadata.get("formatFeatures") or []),
            "confidence": self.confidence,
            "degraded": self.degraded,
            "warnings": self.warnings[:5],
        }
        for key in ("captionMethod", "captionConfidence", "captionProvider", "vlm", "keywords", "figures"):
            if key in self.metadata:
                payload[key] = self.metadata.get(key)
        return payload


def iter_material_blocks(resource: KnowledgeResource) -> list[MaterialBlock]:
    rows = (
        KnowledgeBlock.objects.filter(resource=resource)
        .select_related("page", "asset")
        .order_by("page__page_number", "page__slide_number", "created_at")
    )
    blocks: list[MaterialBlock] = []
    for block in rows:
        text = _block_text(block)
        if not text:
            continue
        block_type = _block_type(block)
        confidence = float(block.confidence or 0)
        warnings = [str(item) for item in (block.warnings or []) if str(item).strip()]
        metadata = block.metadata if isinstance(block.metadata, dict) else {}
        blocks.append(
            MaterialBlock(
                resource_id=str(resource.id),
                resource_title=resource.original_name,
                resource_type=resource.file_type.lstrip(".").lower(),
                block_id=str(block.id),
                block_type=block_type,
                page_number=block.page.page_number if block.page else None,
                slide_index=block.page.slide_number if block.page else None,
                location=_location(resource, block, block_type),
                text=text,
                confidence=confidence,
                degraded=bool(warnings) or confidence < 0.6 or block.modality in {"image", "page_image", "slide_image"},
                warnings=warnings,
                metadata=metadata,
            )
        )
    return blocks


def _block_text(block: KnowledgeBlock) -> str:
    metadata = block.metadata if isinstance(block.metadata, dict) else {}
    parts = [
        str(metadata.get("title") or ""),
        block.markdown or "",
        block.text or "",
        block.html or "",
    ]
    if block.page:
        parts.extend([block.page.summary or "", block.page.ocr_text or ""])
    text = "\n".join(part.strip() for part in parts if part and part.strip())
    return _shorten(text, 3000)


def _block_type(block: KnowledgeBlock) -> str:
    metadata = block.metadata if isinstance(block.metadata, dict) else {}
    raw = str(metadata.get("blockType") or metadata.get("block_type") or metadata.get("kind") or block.modality or "chunk").strip()
    return raw or "chunk"


def _location(resource: KnowledgeResource, block: KnowledgeBlock, block_type: str) -> str:
    page = block.page
    is_ppt = resource.file_type.lower() in {".pptx", ".ppt"} or bool(page and page.slide_number)
    if is_ppt and page and page.slide_number:
        label = PPT_BLOCK_LABELS.get(block_type, PPT_BLOCK_LABELS.get(block.modality, block_type))
        return f"PPT 第 {page.slide_number} 页 · {label}"
    if page and page.page_number:
        return f"第 {page.page_number} 页 · {PPT_BLOCK_LABELS.get(block_type, block_type)}"
    return f"资料块 · {PPT_BLOCK_LABELS.get(block_type, block_type)}"


def _shorten(value: str, limit: int) -> str:
    normalized = " ".join(str(value or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 1]}…"
