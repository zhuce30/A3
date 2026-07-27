from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import re

from backend.core.settings import DATA_ROOT
from backend.domains.knowledge_base.document_loader import iter_source_files, load_documents
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult


DEFAULT_LEXICAL_FILE_LIMIT = 1


# key -> (docs 元组对象, BM25 索引)；靠 docs 的对象身份做失效判定。
_bm25_cache: dict[tuple, tuple] = {}


def search_lexical_knowledge_base(
    query: str,
    top_k: int = 5,
    allowed_source_paths: set[str] | None = None,
    course: str | None = None,
    data_root: Path = DATA_ROOT,
    limit_files: int = DEFAULT_LEXICAL_FILE_LIMIT,
) -> list[KnowledgeBaseSearchResult]:
    normalized_allowed = {str(Path(path).resolve()) for path in allowed_source_paths or set()}
    docs = (
        _load_lexical_documents_for_paths(tuple(sorted(normalized_allowed)))
        if normalized_allowed
        else _load_lexical_documents(str(data_root.resolve()), limit_files)
    )
    if not docs:
        return []

    normalized_course = course.strip().lower() if course else ""
    candidates = []
    for doc in docs:
        source_path = str(doc["metadata"].get("source_path", ""))
        resolved_source_path = str(Path(source_path).resolve()) if source_path else ""
        if normalized_allowed and resolved_source_path not in normalized_allowed:
            continue
        if normalized_course and str(doc["metadata"].get("course", "")).strip().lower() != normalized_course:
            continue
        candidates.append(doc)

    if not candidates:
        return []

    try:
        from rank_bm25 import BM25Okapi
    except ModuleNotFoundError:
        return _simple_rank(candidates, query, top_k)

    # BM25Okapi 的构建代价随语料总词数增长，实测每次重建要 12~17s，
    # 而它只取决于候选集（= 缓存文档 + allowed_paths + course），与查询无关。
    # 这里按这三者缓存索引；统一通过 clear_lexical_retriever_cache() 失效。
    cache_key = (tuple(sorted(normalized_allowed)), normalized_course)
    cached = _bm25_cache.get(cache_key)
    if cached is not None and cached[0] is docs:
        bm25 = cached[1]
    else:
        bm25 = BM25Okapi([doc["tokens"] for doc in candidates])
        _bm25_cache[cache_key] = (docs, bm25)
    scores = bm25.get_scores(_tokenize(query))
    ranked = sorted(zip(candidates, scores), key=lambda item: float(item[1]), reverse=True)
    results = []
    for doc, score in ranked[:top_k]:
        if float(score) <= 0 and query.strip() not in doc["text"]:
            continue
        results.append(
            KnowledgeBaseSearchResult(
                score=round(float(score), 4),
                text=doc["text"][:1200],
                metadata={**doc["metadata"], "retriever": "bm25"},
            )
        )
    return results


@lru_cache(maxsize=8)
def _load_lexical_documents(data_root: str, limit_files: int) -> tuple[dict, ...]:
    source_files = iter_source_files(Path(data_root), limit_files=limit_files)
    return _documents_to_lexical_rows(source_files)


@lru_cache(maxsize=64)
def _load_lexical_documents_for_paths(source_paths: tuple[str, ...]) -> tuple[dict, ...]:
    source_files = [Path(path) for path in source_paths if Path(path).exists()]
    return _documents_to_lexical_rows(source_files)


def clear_lexical_retriever_cache() -> None:
    _load_lexical_documents.cache_clear()
    _load_lexical_documents_for_paths.cache_clear()
    _bm25_cache.clear()


def _documents_to_lexical_rows(source_files) -> tuple[dict, ...]:
    documents, _skipped = load_documents(source_files)
    loaded = []
    for document in documents:
        text = document.get_content().strip()
        if not text:
            continue
        loaded.append(
            {
                "text": text,
                "metadata": dict(document.metadata),
                "tokens": _tokenize(text),
            }
        )
    return tuple(loaded)


def _tokenize(text: str) -> list[str]:
    try:
        import jieba

        return [token.strip().lower() for token in jieba.lcut(text) if token.strip()]
    except Exception:
        ascii_tokens = re.findall(r"[A-Za-z0-9_]+", text.lower())
        cjk_tokens = re.findall(r"[\u4e00-\u9fff]{1,4}", text)
        chars = [char for char in text if "\u4e00" <= char <= "\u9fff"]
        return ascii_tokens + cjk_tokens + chars


def _simple_rank(candidates: list[dict], query: str, top_k: int) -> list[KnowledgeBaseSearchResult]:
    query_tokens = set(_tokenize(query))
    ranked = []
    for doc in candidates:
        doc_tokens = set(doc["tokens"])
        score = len(query_tokens & doc_tokens)
        if query.strip() in doc["text"]:
            score += 5
        if score > 0:
            ranked.append((doc, score))
    ranked.sort(key=lambda item: item[1], reverse=True)
    return [
        KnowledgeBaseSearchResult(
            score=float(score),
            text=doc["text"][:1200],
            metadata={**doc["metadata"], "retriever": "keyword"},
        )
        for doc, score in ranked[:top_k]
    ]
