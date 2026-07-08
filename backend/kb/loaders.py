"""Compatibility exports for the previous `backend.kb.loaders` module path."""

from backend.domains.knowledge_base.document_loader import (
    SKIPPED_EXTENSIONS,
    SUPPORTED_EXTENSIONS,
    iter_source_files,
    load_documents,
    write_build_report,
)

__all__ = [
    "SKIPPED_EXTENSIONS",
    "SUPPORTED_EXTENSIONS",
    "iter_source_files",
    "load_documents",
    "write_build_report",
]
