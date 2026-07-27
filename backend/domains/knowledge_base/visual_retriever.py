from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import threading
from base64 import b64encode
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from backend.core.settings import FAISS_INDEX_DIR
from backend.core.settings import HF_CACHE_DIR
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult


DEFAULT_VISUAL_INDEX_PATH = FAISS_INDEX_DIR / "a3_visual_index.json"
DEFAULT_VISUAL_EMBED_MODEL = "clip-ViT-B-32"
DEFAULT_DASHSCOPE_VISUAL_EMBED_MODEL = "qwen3-vl-embedding"
DASHSCOPE_MULTIMODAL_EMBEDDING_PATH = "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
VISUAL_MODALITIES = {"image", "page_image", "slide_image"}


def upsert_visual_blocks(resource, index_path: Path = DEFAULT_VISUAL_INDEX_PATH) -> int:
    from backend.apps.knowledge_base.models import KnowledgeIndexEntry

    index_path = Path(index_path)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    payload = _load_visual_index(index_path)
    retained = [item for item in payload["items"] if item.get("resource_id") != str(resource.id)]
    indexed_count = 0
    for block in resource.blocks.select_related("asset", "page").filter(modality__in=VISUAL_MODALITIES):
        if not block.asset or not block.asset.storage_path:
            _mark_visual_entry(block, status="failed", error="visual block has no image asset")
            continue
        asset_path = Path(block.asset.storage_path)
        if not asset_path.exists():
            _mark_visual_entry(block, status="failed", error="visual asset file does not exist")
            continue
        try:
            embedding = _embed_image(asset_path)
        except Exception as exc:
            _mark_visual_entry(block, status="failed", error=f"visual embedding failed: {type(exc).__name__}: {exc}")
            continue
        retained.append(
            {
                "block_id": str(block.id),
                "asset_id": str(block.asset_id),
                "resource_id": str(resource.id),
                "source_path": str(Path(resource.stored_path).resolve()),
                "source_scope": resource.resource_scope,
                "resource_name": resource.original_name,
                "modality": block.modality,
                "text": block.text,
                "page": block.page.page_number if block.page else None,
                "slide": block.page.slide_number if block.page else None,
                "embedding": embedding,
            }
        )
        KnowledgeIndexEntry.objects.update_or_create(
            block=block,
            index_type="visual_vector",
            index_backend=_visual_backend_name(),
            defaults={"external_id": str(block.id), "status": "indexed", "error_message": ""},
        )
        indexed_count += 1
    payload["items"] = retained
    index_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return indexed_count


def remove_visual_resource_entries(
    resource_id: str,
    source_path: Path | str | None = None,
    index_path: Path = DEFAULT_VISUAL_INDEX_PATH,
) -> int:
    index_path = Path(index_path)
    if not index_path.exists():
        return 0
    payload = _load_visual_index(index_path)
    normalized_source_path = str(Path(source_path).resolve()) if source_path else ""
    retained = []
    removed = 0
    for item in payload["items"]:
        item_resource_id = str(item.get("resource_id") or "")
        item_source_path = str(Path(str(item.get("source_path") or "")).resolve()) if item.get("source_path") else ""
        if item_resource_id == str(resource_id) or (normalized_source_path and item_source_path == normalized_source_path):
            removed += 1
            continue
        retained.append(item)
    if removed:
        payload["items"] = retained
        index_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return removed


def search_visual_knowledge_base(
    query: str,
    top_k: int = 5,
    allowed_source_paths: set[str] | None = None,
    source_scope_by_path: dict[str, str] | None = None,
    index_path: Path = DEFAULT_VISUAL_INDEX_PATH,
    use_embedding: bool = True,
) -> list[KnowledgeBaseSearchResult]:
    payload = _load_visual_index(Path(index_path))
    if not payload["items"]:
        return []
    query_embedding = _embed_text(query) if use_embedding else []
    query_terms = _tokenize_query(query)
    normalized_allowed = {str(Path(path).resolve()) for path in allowed_source_paths or set()}
    normalized_scope_by_path = {str(Path(path).resolve()): str(scope) for path, scope in (source_scope_by_path or {}).items() if path and scope}
    ranked = []
    for item in payload["items"]:
        source_path = str(Path(str(item.get("source_path") or "")).resolve()) if item.get("source_path") else ""
        if normalized_allowed and source_path not in normalized_allowed:
            continue
        if use_embedding:
            score = _cosine_similarity(query_embedding, item.get("embedding") or [])
        else:
            score = _lexical_visual_score(query_terms, item)
        if score <= 0:
            continue
        ranked.append((score, item))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [
        KnowledgeBaseSearchResult(
            score=round(float(score), 4),
            text=str(item.get("text") or item.get("resource_name") or "")[:1200],
            metadata={
                "retriever": "visual_vector",
                "source_path": item.get("source_path") or "",
                "source_scope": item.get("source_scope") or normalized_scope_by_path.get(str(Path(str(item.get("source_path") or "")).resolve()), ""),
                "title": item.get("resource_name") or "",
                "block_id": item.get("block_id") or "",
                "asset_id": item.get("asset_id") or "",
                "modality": item.get("modality") or "",
                "page": item.get("page"),
                "slide": item.get("slide"),
            },
        )
        for score, item in ranked[:top_k]
    ]


def _load_visual_index(index_path: Path) -> dict:
    if not index_path.exists():
        return {"version": 1, "backend": _visual_backend_name(), "items": []}
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "backend": _visual_backend_name(), "items": []}
    items = payload.get("items")
    return {"version": 1, "backend": payload.get("backend") or _visual_backend_name(), "items": items if isinstance(items, list) else []}


def _mark_visual_entry(block, *, status: str, error: str) -> None:
    from backend.apps.knowledge_base.models import KnowledgeIndexEntry

    KnowledgeIndexEntry.objects.update_or_create(
        block=block,
        index_type="visual_vector",
        index_backend=_visual_backend_name(),
        defaults={"external_id": str(block.id), "status": status, "error_message": error[:2000]},
    )


def _embed_image(path: Path) -> list[float]:
    if _visual_embed_provider() == "dashscope":
        return _dashscope_embed({"image": _image_to_data_uri(path)})

    from PIL import Image

    with Image.open(path) as image:
        vector = _get_visual_model().encode([image.convert("RGB")], normalize_embeddings=True)[0]
    return [float(value) for value in vector]


def _embed_text(text: str) -> list[float]:
    """把查询文本向量化。

    一次检索里文本语义索引和视觉索引会各自embed同一个查询，走 DashScope 时
    等于两次网络往返（每次约 4s）。这里对查询做小容量缓存，让同一查询只embed一次。
    """
    cached = _embed_text_cached(text)
    # 返回副本，避免调用方就地修改污染缓存。
    return list(cached)


@lru_cache(maxsize=256)
def _embed_text_cached(text: str) -> tuple[float, ...]:
    if _visual_embed_provider() == "dashscope":
        # 查询期用更短的超时：这条调用挡在用户等待路径上，
        # 宁可快速失败退回关键词检索，也不要吊死几十秒。
        deadline = _query_embed_timeout()
        return tuple(
            _call_with_deadline(
                lambda: _dashscope_embed({"text": text}, timeout=deadline),
                deadline,
                label="query text embedding",
            )
        )

    vector = _get_visual_model().encode([text], normalize_embeddings=True)[0]
    return tuple(float(value) for value in vector)


@lru_cache(maxsize=1)
def _get_visual_model():
    model_name = os.getenv("A3_VISUAL_EMBED_MODEL", DEFAULT_VISUAL_EMBED_MODEL)
    allow_online = os.getenv("A3_ALLOW_ONLINE_VISUAL_EMBEDDING", "").strip().lower() in {"1", "true", "yes", "on"}
    if not allow_online and not _visual_model_available_locally(model_name):
        raise RuntimeError(
            f"Visual embedding model is not available locally: {model_name}. "
            "Set A3_ALLOW_ONLINE_VISUAL_EMBEDDING=1 to allow download, or pre-cache the model."
        )
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name, local_files_only=not allow_online)


def _visual_backend_name() -> str:
    provider = _visual_embed_provider()
    if provider == "dashscope":
        return f"dashscope:{_visual_embed_model()}"
    return f"sentence-transformers:{os.getenv('A3_VISUAL_EMBED_MODEL', DEFAULT_VISUAL_EMBED_MODEL)}"


def _visual_embed_provider() -> str:
    return os.getenv("A3_VISUAL_EMBED_PROVIDER", "local").strip().lower() or "local"


def _visual_embed_model() -> str:
    default_model = DEFAULT_DASHSCOPE_VISUAL_EMBED_MODEL if _visual_embed_provider() == "dashscope" else DEFAULT_VISUAL_EMBED_MODEL
    return os.getenv("A3_VISUAL_EMBED_MODEL", default_model).strip() or default_model


def _dashscope_embed(content: dict, *, timeout: float | None = None) -> list[float]:
    api_key = _resolve_env_reference(os.getenv("A3_VISUAL_EMBED_API_KEY")) or _resolve_env_reference(os.getenv("DASHSCOPE_API_KEY"))
    if not api_key:
        raise RuntimeError("DashScope visual embedding API key is not configured")

    payload: dict = {
        "model": _visual_embed_model(),
        "input": {"contents": [content]},
    }
    dimensions = _visual_embed_dimensions()
    if dimensions:
        payload["parameters"] = {"dimension": dimensions}

    request = Request(
        _dashscope_multimodal_embedding_url(),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    timeout = timeout if timeout is not None else _visual_embed_timeout()
    try:
        with urlopen(request, timeout=timeout) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        message = _read_http_error(exc)
        raise RuntimeError(f"DashScope visual embedding request failed: HTTP {exc.code} {message}") from exc
    except URLError as exc:
        raise RuntimeError(f"DashScope visual embedding request failed: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError("DashScope visual embedding response is not valid JSON") from exc

    embedding = _extract_dashscope_embedding(response_payload)
    return [float(value) for value in embedding]


def _dashscope_multimodal_embedding_url() -> str:
    base_url = (
        os.getenv("A3_VISUAL_EMBED_BASE_URL")
        or os.getenv("DASHSCOPE_BASE_URL")
        or "https://dashscope.aliyuncs.com"
    ).strip()
    base_url = re.sub(r"/compatible-mode/v1/?$", "", base_url.rstrip("/"))
    if base_url.endswith(DASHSCOPE_MULTIMODAL_EMBEDDING_PATH):
        return base_url
    return f"{base_url}{DASHSCOPE_MULTIMODAL_EMBEDDING_PATH}"


def _visual_embed_dimensions() -> int | None:
    raw = os.getenv("A3_VISUAL_EMBED_DIMENSIONS", "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _visual_embed_timeout() -> float:
    raw = os.getenv("A3_VISUAL_EMBED_TIMEOUT_SECONDS", "30").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 30.0


def _call_with_deadline(func, deadline: float, *, label: str):
    """在墙钟时限内执行 func，超时抛 TimeoutError。

    urlopen 的 timeout 只约束单次 socket 操作，不约束整次请求总时长——实测设 8s
    仍出现 9.3s 的调用。检索在用户等待路径上，需要的是"总时长有上界"，
    所以这里用守护线程 + join(timeout) 兜一层墙钟时限：超时后调用方立即拿回控制权，
    残留请求由 socket 超时自行收尾（守护线程不会阻塞进程退出）。
    """
    outcome: dict = {}

    def runner() -> None:
        try:
            outcome["value"] = func()
        except BaseException as exc:  # noqa: BLE001 - 原样带回调用线程
            outcome["error"] = exc

    worker = threading.Thread(target=runner, name="a3-embed-deadline", daemon=True)
    worker.start()
    worker.join(deadline)
    if worker.is_alive():
        raise TimeoutError(f"{label} exceeded {deadline}s wall-clock deadline")
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("value")


def _query_embed_timeout() -> float:
    """查询期向量化超时。

    建索引可以慢（离线批处理），但检索发生在用户等待路径上：实测正常 3~6s，
    偶发会卡到几十秒，而 RetrieverAgent 还会重试一次，等于把生成流程拖死。
    这里默认 8s 快速失败，让检索退回关键词命中而不是长时间无响应。
    """
    raw = os.getenv("A3_QUERY_EMBED_TIMEOUT_SECONDS", "8").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 8.0


def _extract_dashscope_embedding(payload: dict) -> list:
    output = payload.get("output") if isinstance(payload, dict) else None
    embeddings = output.get("embeddings") if isinstance(output, dict) else None
    if isinstance(embeddings, list) and embeddings:
        first = embeddings[0]
        if isinstance(first, dict) and isinstance(first.get("embedding"), list):
            return first["embedding"]
    raise RuntimeError("DashScope visual embedding response missing output.embeddings[0].embedding")


def _image_to_data_uri(path: Path) -> str:
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime_type};base64,{b64encode(path.read_bytes()).decode('ascii')}"


def _resolve_env_reference(value: str | None) -> str:
    if not value:
        return ""
    resolved = os.path.expandvars(value.strip())
    match = re.fullmatch(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", resolved)
    if match:
        resolved = os.getenv(match.group(1), "")
    return resolved.strip()


def _read_http_error(exc: HTTPError) -> str:
    try:
        detail = exc.read().decode("utf-8", errors="replace")
    except Exception:
        detail = ""
    return detail[:500] if detail else exc.reason


def _visual_model_available_locally(model_name: str) -> bool:
    if os.getenv("A3_ALLOW_ONLINE_VISUAL_EMBEDDING", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    model_dirs = ["models--" + model_name.replace("/", "--")]
    if "/" not in model_name:
        model_dirs.append("models--sentence-transformers--" + model_name)
    candidates = [
        root / model_dir
        for model_dir in model_dirs
        for root in [
            HF_CACHE_DIR / "hub",
            Path.home() / ".cache" / "huggingface" / "hub",
        ]
    ]
    return any(path.exists() for path in candidates)


def _tokenize_query(query: str) -> list[str]:
    normalized = "".join(ch.lower() if ch.isalnum() or "\u4e00" <= ch <= "\u9fff" else " " for ch in query)
    terms = [part for part in normalized.split() if part]
    chinese_terms = [ch for ch in normalized if "\u4e00" <= ch <= "\u9fff"]
    return [*terms, *chinese_terms]


def _lexical_visual_score(query_terms: list[str], item: dict) -> float:
    haystack = " ".join([
        str(item.get("resource_name") or ""),
        str(item.get("text") or ""),
        str(item.get("modality") or ""),
    ]).lower()
    if not haystack or not query_terms:
        return 0.0
    hits = sum(1 for term in query_terms if term and term in haystack)
    if hits <= 0:
        return 0.0
    return min(1.0, hits / max(3, len(set(query_terms))))


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    numerator = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return numerator / (left_norm * right_norm)
