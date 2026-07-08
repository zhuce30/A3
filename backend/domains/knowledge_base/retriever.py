from __future__ import annotations

from pathlib import Path
from typing import Any
import os

from backend.core.runtime import configure_huggingface_runtime

configure_huggingface_runtime()

from backend.core.settings import DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR, HF_CACHE_DIR
from backend.domains.knowledge_base.lexical_retriever import search_lexical_knowledge_base
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult
from backend.domains.knowledge_base.visual_retriever import search_visual_knowledge_base

_index_cache: dict[tuple[str, str], Any] = {}


def search_knowledge_base(
    query: str,
    top_k: int = 5,
    allowed_source_paths: set[str] | None = None,
    source_scope_by_path: dict[str, str] | None = None,
    course: str | None = None,
    persist_dir: Path = FAISS_INDEX_DIR,
    embed_model_name: str = DEFAULT_EMBED_MODEL,
    candidate_multiplier: int = 20,
    force_lexical: bool = False,
    visual_use_embedding: bool = True,
) -> list[KnowledgeBaseSearchResult]:
    normalized_scope_by_path = _normalize_source_scope_by_path(source_scope_by_path)
    lexical_top_k = min(max(top_k * max(1, int(candidate_multiplier)), top_k), 200)
    if force_lexical or not _embedding_model_available_locally(embed_model_name):
        text_results = search_lexical_knowledge_base(
            query=query,
            top_k=lexical_top_k,
            allowed_source_paths=allowed_source_paths,
            course=course,
        )
        return _merge_visual_results(
            query,
            text_results,
            top_k,
            allowed_source_paths,
            source_scope_by_path=normalized_scope_by_path,
            visual_use_embedding=visual_use_embedding,
        )
    try:
        index = _load_knowledge_base_index(persist_dir=persist_dir, embed_model_name=embed_model_name)
        candidate_multiplier = max(1, int(candidate_multiplier))
        retriever = index.as_retriever(similarity_top_k=min(max(top_k * candidate_multiplier, top_k), 200))
        nodes = retriever.retrieve(query)
    except Exception:
        text_results = search_lexical_knowledge_base(
            query=query,
            top_k=lexical_top_k,
            allowed_source_paths=allowed_source_paths,
            course=course,
        )
        return _merge_visual_results(
            query,
            text_results,
            top_k,
            allowed_source_paths,
            source_scope_by_path=normalized_scope_by_path,
            visual_use_embedding=visual_use_embedding,
        )

    results: list[KnowledgeBaseSearchResult] = []
    normalized_allowed_paths = {str(Path(path).resolve()) for path in allowed_source_paths or set()}
    normalized_course = course.strip().lower() if course else ""
    for item in nodes:
        node = item.node
        metadata = dict(node.metadata)
        source_path = str(metadata.get("source_path", "")).strip()
        resolved_source_path = str(Path(source_path).resolve()) if source_path else ""
        if resolved_source_path and not Path(resolved_source_path).exists():
            continue
        if normalized_allowed_paths and resolved_source_path not in normalized_allowed_paths:
            continue
        if normalized_course and str(metadata.get("course", "")).strip().lower() != normalized_course:
            continue
        results.append(
            KnowledgeBaseSearchResult(
                score=float(item.score) if item.score is not None else None,
                text=node.get_content()[:1200],
                metadata=metadata,
            )
        )
    return _merge_visual_results(
        query,
        results,
        top_k,
        allowed_source_paths,
        source_scope_by_path=normalized_scope_by_path,
        visual_use_embedding=visual_use_embedding,
    )


def _merge_visual_results(
    query: str,
    text_results: list[KnowledgeBaseSearchResult],
    top_k: int,
    allowed_source_paths: set[str] | None,
    source_scope_by_path: dict[str, str] | None = None,
    visual_use_embedding: bool = True,
) -> list[KnowledgeBaseSearchResult]:
    normalized_scope_by_path = _normalize_source_scope_by_path(source_scope_by_path)
    try:
        visual_results = search_visual_knowledge_base(
            query=query,
            top_k=top_k,
            allowed_source_paths=allowed_source_paths,
            source_scope_by_path=normalized_scope_by_path,
            use_embedding=visual_use_embedding,
        )
    except Exception:
        visual_results = []
    merged: list[KnowledgeBaseSearchResult] = []
    seen: set[tuple[str, str, str]] = set()
    scoped_results = [_apply_scope_metadata(item, normalized_scope_by_path) for item in [*text_results, *visual_results]]
    for item in sorted(scoped_results, key=lambda result: result.score or 0, reverse=True):
        metadata = item.metadata or {}
        key = (
            str(metadata.get("source_path") or ""),
            str(metadata.get("block_id") or ""),
            str(metadata.get("retriever") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
        if len(merged) >= top_k:
            break
    return merged


def _normalize_source_scope_by_path(source_scope_by_path: dict[str, str] | None) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for path, scope in (source_scope_by_path or {}).items():
        if not path or not scope:
            continue
        normalized[str(Path(path).resolve())] = str(scope)
    return normalized


def _apply_scope_metadata(
    result: KnowledgeBaseSearchResult,
    source_scope_by_path: dict[str, str] | None,
) -> KnowledgeBaseSearchResult:
    metadata = dict(result.metadata or {})
    source_path = str(metadata.get("source_path") or "")
    resolved_source_path = str(Path(source_path).resolve()) if source_path else ""
    scope = str(metadata.get("source_scope") or metadata.get("sourceScope") or "").strip()
    if not scope and resolved_source_path:
        scope = (source_scope_by_path or {}).get(resolved_source_path, "")
    original_score = float(result.score or 0)
    if scope:
        metadata["source_scope"] = scope
        metadata.setdefault("original_score", round(original_score, 4))
    boost = _scope_score_boost(scope)
    if boost:
        metadata["scope_boost"] = boost
        metadata["scope_adjusted_score"] = round(original_score + boost, 4)
    return KnowledgeBaseSearchResult(
        score=round(original_score + boost, 4) if result.score is not None else None,
        text=result.text,
        metadata=metadata,
    )


def _scope_score_boost(scope: str) -> float:
    if scope == "personal":
        return 0.15
    if scope in {"teacher", "class"}:
        return 0.08
    return 0.0


def _load_knowledge_base_index(
    persist_dir: Path = FAISS_INDEX_DIR,
    embed_model_name: str = DEFAULT_EMBED_MODEL,
):
    persist_dir = persist_dir.resolve()
    faiss_path = persist_dir / "default__vector_store.json"
    if not persist_dir.exists():
        raise FileNotFoundError(f"Knowledge base index not found: {persist_dir}")

    cache_key = (str(persist_dir), embed_model_name)
    if cache_key in _index_cache:
        return _index_cache[cache_key]

    try:
        from llama_index.core import Settings, StorageContext, load_index_from_storage
        from llama_index.embeddings.huggingface import HuggingFaceEmbedding
        from llama_index.vector_stores.faiss import FaissVectorStore
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "llama_index is required to query the knowledge-base vector index. "
            "Install backend requirements before using /api/kb/search/."
        ) from exc

    Settings.embed_model = HuggingFaceEmbedding(model_name=embed_model_name)
    vector_store = FaissVectorStore.from_persist_path(str(faiss_path))
    storage_context = StorageContext.from_defaults(
        vector_store=vector_store,
        persist_dir=str(persist_dir),
    )
    index = load_index_from_storage(storage_context=storage_context)
    _index_cache[cache_key] = index
    return index


def _embedding_model_available_locally(embed_model_name: str) -> bool:
    if os.getenv("A3_ALLOW_ONLINE_EMBEDDING", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    model_dir = "models--" + embed_model_name.replace("/", "--")
    candidates = [
        HF_CACHE_DIR / "hub" / model_dir,
        Path.home() / ".cache" / "huggingface" / "hub" / model_dir,
    ]
    return any(path.exists() for path in candidates)
