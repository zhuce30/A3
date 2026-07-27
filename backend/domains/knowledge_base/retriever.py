from __future__ import annotations

from pathlib import Path
from typing import Any
import os

from backend.core.runtime import configure_huggingface_runtime

configure_huggingface_runtime()

from backend.core.settings import DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR, HF_CACHE_DIR
from backend.domains.knowledge_base.lexical_retriever import search_lexical_knowledge_base
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult
from backend.domains.knowledge_base.text_vector_retriever import (
    search_text_vector_knowledge_base,
    text_vector_index_available,
)
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
    retrieval_mode: str = "auto",
    similarity_threshold: float = 0.0,
    bm25_candidate_count: int | None = None,
    vector_weight: float = 0.7,
    bm25_weight: float = 0.3,
) -> list[KnowledgeBaseSearchResult]:
    normalized_scope_by_path = _normalize_source_scope_by_path(source_scope_by_path)
    retrieval_mode = retrieval_mode if retrieval_mode in {"auto", "hybrid", "vector", "bm25"} else "auto"
    apply_weights = retrieval_mode in {"hybrid", "vector", "bm25"}
    lexical_top_k = min(max(int(bm25_candidate_count or 0), top_k), 200) if bm25_candidate_count else min(max(top_k * max(1, int(candidate_multiplier)), top_k), 200)
    if force_lexical or retrieval_mode == "bm25" or not _embedding_model_available_locally(embed_model_name):
        text_results: list[KnowledgeBaseSearchResult] = []
        semantic_query_failed = False
        # 本地 HF 嵌入模型不可用时，优先用 DashScope 建好的文本语义索引，
        # 而不是直接退化成 BM25 关键词检索。两者分数量纲不同（BM25 无上界、
        # 余弦是 0~1），混排会让弱相关的 BM25 结果压住更相关的语义结果，
        # 所以这里语义索引可用时就把它作为文本检索主力。
        use_semantic_text = not force_lexical and retrieval_mode != "bm25"
        if use_semantic_text:
            try:
                if text_vector_index_available():
                    text_results = search_text_vector_knowledge_base(
                        query=query,
                        top_k=lexical_top_k,
                        allowed_source_paths=allowed_source_paths,
                        source_scope_by_path=normalized_scope_by_path,
                    )
            except Exception:
                text_results = []
                semantic_query_failed = True
        if not text_results:
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
            visual_use_embedding=visual_use_embedding and not semantic_query_failed,
            similarity_threshold=similarity_threshold,
            vector_weight=vector_weight,
            bm25_weight=bm25_weight,
            apply_weights=apply_weights,
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
            similarity_threshold=similarity_threshold,
            vector_weight=vector_weight,
            bm25_weight=bm25_weight,
            apply_weights=apply_weights,
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
        metadata.setdefault("retriever", "vector")
        results.append(
            KnowledgeBaseSearchResult(
                score=float(item.score) if item.score is not None else None,
                text=node.get_content()[:1200],
                metadata=metadata,
            )
        )
    if retrieval_mode == "hybrid":
        results.extend(
            search_lexical_knowledge_base(
                query=query,
                top_k=lexical_top_k,
                allowed_source_paths=allowed_source_paths,
                course=course,
            )
        )
    return _merge_visual_results(
        query,
        results,
        top_k,
        allowed_source_paths,
        source_scope_by_path=normalized_scope_by_path,
        visual_use_embedding=visual_use_embedding,
        similarity_threshold=similarity_threshold,
        vector_weight=vector_weight,
        bm25_weight=bm25_weight,
        apply_weights=apply_weights,
    )


def _merge_visual_results(
    query: str,
    text_results: list[KnowledgeBaseSearchResult],
    top_k: int,
    allowed_source_paths: set[str] | None,
    source_scope_by_path: dict[str, str] | None = None,
    visual_use_embedding: bool = True,
    similarity_threshold: float = 0.0,
    vector_weight: float = 0.7,
    bm25_weight: float = 0.3,
    apply_weights: bool = False,
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
    if apply_weights:
        scoped_results = [
            _apply_retrieval_weight(
                item,
                vector_weight=vector_weight,
                bm25_weight=bm25_weight,
            )
            for item in scoped_results
        ]
    for item in sorted(scoped_results, key=lambda result: result.score or 0, reverse=True):
        if similarity_threshold and (item.score or 0) < similarity_threshold:
            continue
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


def _apply_retrieval_weight(
    result: KnowledgeBaseSearchResult,
    *,
    vector_weight: float,
    bm25_weight: float,
) -> KnowledgeBaseSearchResult:
    metadata = dict(result.metadata or {})
    retriever = str(metadata.get("retriever") or "").lower()
    original_score = float(result.score or 0)
    if retriever in {"bm25", "keyword"}:
        weight = bm25_weight
    elif retriever in {"vector", "visual_vector"}:
        weight = vector_weight
    else:
        weight = 1.0
    metadata.setdefault("pre_weight_score", round(original_score, 4))
    metadata["retrieval_weight"] = round(weight, 4)
    metadata["weighted_score"] = round(original_score * weight, 4)
    return KnowledgeBaseSearchResult(
        score=round(original_score * weight, 4) if result.score is not None else None,
        text=result.text,
        metadata=metadata,
    )


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
    required_files = (
        faiss_path,
        persist_dir / "docstore.json",
        persist_dir / "index_store.json",
    )
    if not persist_dir.exists() or any(not path.exists() for path in required_files):
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
