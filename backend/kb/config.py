"""Compatibility exports for the previous `backend.kb` module path."""

from backend.core.settings import (
    DATA_ROOT as DEFAULT_DATA_ROOT,
    DEFAULT_EMBED_MODEL,
    EMBED_DIMENSIONS,
    FAISS_INDEX_DIR,
    HF_CACHE_DIR,
    METADATA_DIR,
)

__all__ = [
    "DEFAULT_DATA_ROOT",
    "DEFAULT_EMBED_MODEL",
    "EMBED_DIMENSIONS",
    "FAISS_INDEX_DIR",
    "HF_CACHE_DIR",
    "METADATA_DIR",
]
