from __future__ import annotations

from pydantic import BaseModel, Field


class BuildKnowledgeBaseReport(BaseModel):
    data_root: str
    persist_dir: str
    embed_model: str
    embedding_dimensions: int
    source_files_seen: int
    documents_loaded: int
    skipped: list[dict] = Field(default_factory=list)


class KnowledgeBaseSearchResult(BaseModel):
    score: float | None
    text: str
    metadata: dict
