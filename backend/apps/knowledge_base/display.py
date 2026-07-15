from __future__ import annotations

from pathlib import PurePath, PureWindowsPath


def safe_source_filename(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    normalized = raw.replace("\\", "/").rstrip("/")
    if not normalized:
        return ""
    if "/" in normalized or ":" in normalized:
        windows_name = PureWindowsPath(raw).name
        posix_name = PurePath(normalized).name
        return windows_name or posix_name or raw
    return normalized


def format_source_display_location(metadata: dict | None, *, fallback: str = "本地知识库") -> str:
    metadata = metadata or {}
    parts: list[str] = []
    if metadata.get("page_label"):
        parts.append(f"page {metadata['page_label']}")
    elif metadata.get("page"):
        parts.append(f"page {metadata['page']}")
    if metadata.get("slide"):
        parts.append(f"slide {metadata['slide']}")
    if metadata.get("row"):
        parts.append(f"row {metadata['row']}")

    name = (
        metadata.get("original_name")
        or metadata.get("file_name")
        or metadata.get("source_name")
        or metadata.get("title")
        or safe_source_filename(metadata.get("source_path") or metadata.get("file_path") or metadata.get("location"))
    )
    safe_name = safe_source_filename(name)
    if safe_name and safe_name not in parts:
        parts.append(safe_name)
    return " · ".join(parts) if parts else fallback


def format_source_type_label(metadata: dict | None, *, fallback: str = "本地资料") -> str:
    metadata = metadata or {}
    source_type = str(metadata.get("source_type") or metadata.get("resource_type") or metadata.get("type") or "").lower()
    if "pptx" in source_type or "ppt" in source_type or "courseware" in source_type:
        return "PPTX 课件"
    if "pdf" in source_type or "document" in source_type:
        return "PDF 课件"
    if "docx" in source_type:
        return "Word 文档"
    if "qa" in source_type or "question" in source_type or "bank" in source_type:
        return "问答题库"
    file_name = safe_source_filename(metadata.get("original_name") or metadata.get("file_name") or metadata.get("source_path") or "")
    suffix = PurePath(file_name).suffix.lower()
    if suffix == ".pptx":
        return "PPTX 课件"
    if suffix == ".pdf":
        return "PDF 课件"
    if suffix == ".docx":
        return "Word 文档"
    if suffix == ".xlsx":
        return "问答题库"
    return fallback


def source_origin_label(metadata: dict | None) -> str:
    metadata = metadata or {}
    scope = str(metadata.get("source_scope") or metadata.get("sourceScope") or "").strip()
    if scope == "personal":
        return "我的资料"
    if scope == "teacher":
        return "教师资料"
    if scope == "class":
        return "班级资料"
    if scope == "global":
        return "全局知识库"
    if metadata.get("owner_id") or metadata.get("resource_id"):
        return "教师上传索引"
    return "全量知识库索引"
