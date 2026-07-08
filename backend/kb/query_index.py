"""Compatibility wrapper.

Prefer `python -m backend.scripts.query_knowledge_base`.
"""

from backend.domains.knowledge_base.retriever import search_knowledge_base as search_index
from backend.scripts.query_knowledge_base import main

__all__ = ["search_index", "main"]


if __name__ == "__main__":
    main()
