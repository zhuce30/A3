from __future__ import annotations

import os

from backend.core.settings import HF_CACHE_DIR


def configure_huggingface_runtime() -> None:
    """Keep HuggingFace cache inside the project and avoid Xet permission issues."""

    HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(HF_CACHE_DIR))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
