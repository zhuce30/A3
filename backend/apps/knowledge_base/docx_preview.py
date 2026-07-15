from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from django.conf import settings

from backend.apps.knowledge_base.models import CuratedLearningResource


class DocxPreviewUnsupported(Exception):
    pass


class DocxPreviewSourceUnavailable(Exception):
    pass


class DocxPreviewUnavailable(Exception):
    pass


_LOCKS_GUARD = threading.Lock()
_TARGET_LOCKS: dict[str, threading.Lock] = {}


def get_or_create_docx_preview(resource: CuratedLearningResource) -> Path:
    source = _validated_source(resource)
    cache_root = Path(settings.KNOWLEDGE_UPLOAD_ROOT).resolve() / "previews" / "curated"
    cache_root.mkdir(parents=True, exist_ok=True)
    target = cache_root / f"{_safe_code(resource.resource_code)}-{_content_hash(resource, source)}.pdf"
    if _is_pdf(target):
        return target

    lock = _target_lock(target)
    with lock:
        if _is_pdf(target):
            return target
        _convert_docx(source, target, cache_root)
    return target


def _validated_source(resource: CuratedLearningResource) -> Path:
    knowledge_resource = getattr(resource, "knowledge_resource", None)
    stored_path = getattr(knowledge_resource, "stored_path", "")
    source = Path(str(stored_path))
    if source.suffix.lower() != ".docx":
        raise DocxPreviewUnsupported("该资料不是可预览的 Word 文档")
    if not source.is_file():
        raise DocxPreviewSourceUnavailable("资料原文件暂时不可用")
    max_bytes = int(getattr(settings, "KNOWLEDGE_UPLOAD_MAX_BYTES", 200 * 1024 * 1024))
    if source.stat().st_size > max_bytes:
        raise DocxPreviewUnavailable("Word 在线预览暂时不可用，可下载原文档")
    return source


def _content_hash(resource: CuratedLearningResource, source: Path) -> str:
    configured = str(getattr(resource, "content_hash", "") or "").strip().lower()
    if configured and re.fullmatch(r"[a-f0-9]{6,64}", configured):
        return configured
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_code(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-._")
    return safe or "resource"


def _target_lock(target: Path) -> threading.Lock:
    key = str(target)
    with _LOCKS_GUARD:
        return _TARGET_LOCKS.setdefault(key, threading.Lock())


def _convert_docx(source: Path, target: Path, cache_root: Path) -> None:
    timeout = max(1, int(getattr(settings, "A3_DOCX_PREVIEW_TIMEOUT_SECONDS", 60)))
    soffice = str(getattr(settings, "A3_SOFFICE_PATH", "soffice") or "soffice")
    try:
        with tempfile.TemporaryDirectory(prefix=".docx-preview-", dir=cache_root) as temp_dir:
            work_dir = Path(temp_dir)
            converted_source = work_dir / "source.docx"
            shutil.copyfile(source, converted_source)
            profile_uri = (work_dir / "libreoffice-profile").resolve().as_uri()
            command = [
                soffice,
                "--headless",
                f"-env:UserInstallation={profile_uri}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(work_dir),
                str(converted_source),
            ]
            completed = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=timeout,
            )
            converted = work_dir / "source.pdf"
            if completed.returncode != 0 or not _is_pdf(converted):
                raise DocxPreviewUnavailable("Word 在线预览暂时不可用，可下载原文档")
            os.replace(converted, target)
    except DocxPreviewUnavailable:
        raise
    except (FileNotFoundError, OSError, subprocess.SubprocessError) as exc:
        raise DocxPreviewUnavailable("Word 在线预览暂时不可用，可下载原文档") from exc


def _is_pdf(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 5:
        return False
    with path.open("rb") as stream:
        return stream.read(5) == b"%PDF-"
