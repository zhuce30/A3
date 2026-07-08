"""Compatibility wrapper.

Prefer `python -m backend.scripts.build_knowledge_base`.
"""

from backend.domains.knowledge_base.index_builder import (
    build_knowledge_base_index as build_index,
)
from backend.scripts.build_knowledge_base import main

__all__ = ["build_index", "main"]


if __name__ == "__main__":
    main()
