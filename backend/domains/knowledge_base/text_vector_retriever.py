"""文本块语义检索（text_vector）。

背景：默认的文本向量检索走 llama-index + 本地 HuggingFace 嵌入模型
（BAAI/bge-small-zh-v1.5）。但在本项目的运行环境里该模型没有本地缓存、
huggingface.co 也不可达，于是 `_embedding_model_available_locally()` 恒为 False，
文本向量检索被整条跳过——999 个块里只有 218 个（页面/幻灯片截图）有语义向量，
其余 767 个文本块只能靠 BM25 关键词命中。

这里复用视觉检索已经验证可用的那套方案（DashScope 多模态 embedding + JSON 存储 +
余弦相似度），为文本块补上语义检索这条腿。分数与视觉检索同为 0~1 余弦，天然可比。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from backend.core.settings import FAISS_INDEX_DIR
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult
from backend.domains.knowledge_base.visual_retriever import (
    _cosine_similarity,
    _dashscope_multimodal_embedding_url,
    _embed_text,
    _resolve_env_reference,
    _visual_embed_dimensions,
    _visual_embed_model,
    _visual_embed_provider,
    _visual_embed_timeout,
)

DEFAULT_TEXT_INDEX_PATH = FAISS_INDEX_DIR / "a3_text_index.json"
TEXT_INDEX_MODALITIES = ("text", "table", "formula")
# 嵌入接口按条计费/限长，超长文本截断即可满足检索用途。
MAX_EMBED_CHARS = 2000
# 实测单条与 5 条批量耗时接近（约 4s），说明瓶颈是网络往返，批量收益明显。
DEFAULT_BATCH_SIZE = 10


def text_vector_index_available(index_path: Path = DEFAULT_TEXT_INDEX_PATH) -> bool:
    """索引是否存在且非空——决定 search_knowledge_base 是否启用这条腿。"""
    return bool(_load_text_index(Path(index_path)).get("items"))


def search_text_vector_knowledge_base(
    query: str,
    top_k: int = 5,
    allowed_source_paths: set[str] | None = None,
    source_scope_by_path: dict[str, str] | None = None,
    index_path: Path = DEFAULT_TEXT_INDEX_PATH,
) -> list[KnowledgeBaseSearchResult]:
    payload = _load_text_index(Path(index_path))
    items = payload.get("items") or []
    if not items:
        return []
    query_embedding = _embed_text(query)
    if not query_embedding:
        return []
    normalized_allowed = {str(Path(path).resolve()) for path in allowed_source_paths or set()}
    normalized_scope_by_path = {
        str(Path(path).resolve()): str(scope)
        for path, scope in (source_scope_by_path or {}).items()
        if path and scope
    }
    scores = _score_items(Path(index_path), query_embedding)
    ranked: list[tuple[float, dict]] = []
    for item, score in zip(items, scores):
        if score <= 0:
            continue
        raw_path = str(item.get("source_path") or "")
        source_path = str(Path(raw_path).resolve()) if raw_path else ""
        if normalized_allowed and source_path not in normalized_allowed:
            continue
        ranked.append((float(score), item))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [
        KnowledgeBaseSearchResult(
            score=round(float(score), 4),
            text=str(item.get("text") or "")[:1200],
            metadata={
                "retriever": "text_vector",
                "source_path": item.get("source_path") or "",
                "source_scope": item.get("source_scope")
                or normalized_scope_by_path.get(
                    str(Path(str(item.get("source_path") or "")).resolve()), ""
                ),
                "title": item.get("resource_name") or "",
                "block_id": item.get("block_id") or "",
                "modality": item.get("modality") or "",
                "page": item.get("page"),
                "slide": item.get("slide"),
            },
        )
        for score, item in ranked[:top_k]
    ]


def _score_items(index_path: Path, query_embedding: list[float]) -> list[float]:
    """一次矩阵乘算完所有块的余弦相似度。

    纯 Python 逐条算 cosine 在 771 个块 × 1024 维下要数秒（每条要三次遍历向量），
    是检索耗时的主要来源；这里把归一化后的向量矩阵缓存下来，用 numpy 一次算完。
    """
    matrix = _embedding_matrix(index_path)
    if matrix is None:
        payload = _load_text_index(index_path)
        return [
            _cosine_similarity(query_embedding, item.get("embedding") or [])
            for item in payload.get("items") or []
        ]
    import numpy as np

    query = np.asarray(query_embedding, dtype="float32")
    norm = float(np.linalg.norm(query))
    if norm == 0.0:
        return [0.0] * matrix.shape[0]
    return (matrix @ (query / norm)).tolist()


_matrix_cache: dict[str, tuple[float, int, object]] = {}
_index_payload_cache: dict[str, tuple[float, int, dict]] = {}


def _embedding_matrix(index_path: Path):
    """返回按行归一化的向量矩阵（随索引文件 mtime 失效）。"""
    try:
        import numpy as np
    except ImportError:  # pragma: no cover - numpy 是既有依赖，缺失时退回纯 Python
        return None
    path = Path(index_path)
    try:
        stat = path.stat()
    except OSError:
        return None
    key = str(path.resolve())
    cached = _matrix_cache.get(key)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    items = _load_text_index(path).get("items") or []
    if not items:
        return None
    raw = np.asarray([item.get("embedding") or [] for item in items], dtype="float32")
    if raw.ndim != 2 or raw.size == 0:
        return None
    norms = np.linalg.norm(raw, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    matrix = raw / norms
    _matrix_cache[key] = (stat.st_mtime, stat.st_size, matrix)
    return matrix


def build_text_vector_index(
    *,
    index_path: Path = DEFAULT_TEXT_INDEX_PATH,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
    progress=None,
) -> dict:
    """全量重建文本语义索引，返回统计信息。"""
    from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgeIndexEntry

    blocks = list(
        KnowledgeBlock.objects.filter(modality__in=TEXT_INDEX_MODALITIES)
        .select_related("resource", "page")
        .order_by("created_at")
    )
    pending = [block for block in blocks if str(block.text or "").strip()]
    if limit:
        pending = pending[:limit]

    items: list[dict] = []
    failed = 0
    for start in range(0, len(pending), max(1, batch_size)):
        batch = pending[start : start + max(1, batch_size)]
        texts = [str(block.text or "").strip()[:MAX_EMBED_CHARS] for block in batch]
        try:
            embeddings = embed_texts(texts)
            if len(embeddings) != len(batch):
                raise RuntimeError(
                    f"embedding response count mismatch: expected {len(batch)}, got {len(embeddings)}"
                )
        except Exception as exc:  # noqa: BLE001 - 单批失败不应中断整体重建
            failed += len(batch)
            for block in batch:
                KnowledgeIndexEntry.objects.update_or_create(
                    block=block,
                    index_type="text_vector",
                    index_backend=text_vector_backend_name(),
                    defaults={
                        "external_id": str(block.id),
                        "status": "failed",
                        "error_message": f"text embedding failed: {type(exc).__name__}: {exc}"[:500],
                    },
                )
            if progress:
                progress({"done": start + len(batch), "total": len(pending), "failed": failed, "error": str(exc)[:120]})
            continue

        for block, embedding in zip(batch, embeddings):
            if not embedding:
                failed += 1
                continue
            resource = block.resource
            items.append(
                {
                    "block_id": str(block.id),
                    "resource_id": str(resource.id) if resource else "",
                    "source_path": str(Path(resource.stored_path).resolve()) if resource and resource.stored_path else "",
                    "source_scope": getattr(resource, "resource_scope", "") or "",
                    "resource_name": getattr(resource, "original_name", "") or "",
                    "modality": block.modality,
                    "text": str(block.text or "")[:1200],
                    "page": block.page.page_number if block.page else None,
                    "slide": block.page.slide_number if block.page else None,
                    "embedding": embedding,
                }
            )
            KnowledgeIndexEntry.objects.update_or_create(
                block=block,
                index_type="text_vector",
                index_backend=text_vector_backend_name(),
                defaults={"external_id": str(block.id), "status": "indexed", "error_message": ""},
            )
        if progress:
            progress({"done": start + len(batch), "total": len(pending), "failed": failed})

    index_path = Path(index_path)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "backend": text_vector_backend_name(),
        "dimensions": _visual_embed_dimensions(),
        "items": items,
    }
    temporary_path = index_path.with_suffix(f"{index_path.suffix}.tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary_path.replace(index_path)
    cache_key = str(index_path.resolve())
    _index_payload_cache.pop(cache_key, None)
    _matrix_cache.pop(cache_key, None)
    return {"indexed": len(items), "failed": failed, "candidates": len(pending), "indexPath": str(index_path)}


def embed_texts(texts: list[str]) -> list[list[float]]:
    """批量文本向量化。DashScope 多模态 embedding 单次可传多个 content。"""
    cleaned = [text for text in texts if str(text).strip()]
    if not cleaned:
        return []
    if _visual_embed_provider() != "dashscope":
        # 非 DashScope provider 时退化为逐条调用，保持行为一致。
        return [_embed_text(text) for text in cleaned]

    from urllib.request import Request, urlopen

    api_key = _resolve_env_reference(os.getenv("A3_VISUAL_EMBED_API_KEY")) or _resolve_env_reference(
        os.getenv("DASHSCOPE_API_KEY")
    )
    if not api_key:
        raise RuntimeError("DashScope embedding API key is not configured")
    payload: dict = {
        "model": _visual_embed_model(),
        "input": {"contents": [{"text": text} for text in cleaned]},
    }
    dimensions = _visual_embed_dimensions()
    if dimensions:
        payload["parameters"] = {"dimension": dimensions}
    request = Request(
        _dashscope_multimodal_embedding_url(),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=_visual_embed_timeout()) as response:
        response_payload = json.loads(response.read().decode("utf-8"))
    embeddings = ((response_payload.get("output") or {}).get("embeddings")) or []
    # 接口按 index 标注顺序，显式排序避免顺序错位导致向量与文本错配。
    ordered = sorted(embeddings, key=lambda entry: int(entry.get("index") or 0))
    if len(ordered) != len(cleaned):
        raise RuntimeError(
            f"DashScope embedding response count mismatch: expected {len(cleaned)}, got {len(ordered)}"
        )
    vectors = [[float(value) for value in (entry.get("embedding") or [])] for entry in ordered]
    if any(not vector for vector in vectors):
        raise RuntimeError("DashScope embedding response contains an empty vector")
    return vectors


def text_vector_backend_name() -> str:
    return "dashscope" if _visual_embed_provider() == "dashscope" else "sentence-transformers"


def _load_text_index(index_path: Path) -> dict:
    path = Path(index_path)
    try:
        stat = path.stat()
    except OSError:
        return {"version": 1, "backend": text_vector_backend_name(), "items": []}
    cache_key = str(path.resolve())
    cached = _index_payload_cache.get(cache_key)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "backend": text_vector_backend_name(), "items": []}
    items = payload.get("items")
    normalized = {
        "version": 1,
        "backend": payload.get("backend") or text_vector_backend_name(),
        "items": items if isinstance(items, list) else [],
    }
    _index_payload_cache[cache_key] = (stat.st_mtime, stat.st_size, normalized)
    return normalized


__all__ = [
    "DEFAULT_TEXT_INDEX_PATH",
    "build_text_vector_index",
    "embed_texts",
    "search_text_vector_knowledge_base",
    "text_vector_index_available",
]
