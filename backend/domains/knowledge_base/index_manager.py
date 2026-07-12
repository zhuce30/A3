from __future__ import annotations

from pathlib import Path
from threading import RLock

from backend.core.runtime import configure_huggingface_runtime

configure_huggingface_runtime()

from backend.core.settings import DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR
from backend.core.settings import EMBED_DIMENSIONS
from backend.domains.knowledge_base.document_loader import load_documents
from backend.domains.knowledge_base.lexical_retriever import _load_lexical_documents
from backend.domains.knowledge_base.retriever import _index_cache, _load_knowledge_base_index


_INDEX_WRITE_LOCK = RLock()


def append_source_file(
    source_path: Path,
    persist_dir: Path = FAISS_INDEX_DIR,
    embed_model_name: str = DEFAULT_EMBED_MODEL,
    metadata: dict | None = None,
) -> tuple[int, int, list[dict]]:
    source_path = source_path.resolve()
    documents, skipped = load_documents([source_path])
    if not documents:
        reason = skipped[0]["reason"] if skipped else "文件中没有可索引文本"
        raise ValueError(reason)

    try:
        from llama_index.core import Settings
        from llama_index.core.node_parser import SentenceSplitter
    except ModuleNotFoundError as exc:
        _load_lexical_documents.cache_clear()
        return len(documents), len(documents), [
            *skipped,
            {
                "path": str(source_path),
                "reason": (
                    "llama_index is unavailable; uploaded resource was registered for "
                    "lexical knowledge-base retrieval only."
                ),
            },
        ]

    with _INDEX_WRITE_LOCK:
        Settings.node_parser = SentenceSplitter(chunk_size=512, chunk_overlap=80)
        try:
            index = _load_knowledge_base_index(
                persist_dir=persist_dir,
                embed_model_name=embed_model_name,
            )
        except FileNotFoundError:
            for document in documents:
                if metadata:
                    document.metadata.update(metadata)
            index = _build_new_index(documents, persist_dir, embed_model_name)
            index.storage_context.persist(persist_dir=str(persist_dir.resolve()))
            _index_cache.pop((str(persist_dir.resolve()), embed_model_name), None)
            _load_lexical_documents.cache_clear()
            return len(documents), len(index.docstore.docs), skipped
        before = len(index.docstore.docs)
        for document in documents:
            if metadata:
                document.metadata.update(metadata)
            index.insert(document)
        index.storage_context.persist(persist_dir=str(persist_dir.resolve()))
        after = len(index.docstore.docs)

    _load_lexical_documents.cache_clear()
    return len(documents), max(0, after - before), skipped


def _build_new_index(documents, persist_dir: Path, embed_model_name: str):
    import faiss
    from llama_index.core import Settings, StorageContext, VectorStoreIndex
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    from llama_index.vector_stores.faiss import FaissVectorStore

    persist_dir.mkdir(parents=True, exist_ok=True)
    Settings.embed_model = HuggingFaceEmbedding(model_name=embed_model_name)
    dimensions = EMBED_DIMENSIONS.get(embed_model_name)
    if dimensions is None:
        dimensions = len(Settings.embed_model.get_text_embedding("dimension probe"))
    vector_store = FaissVectorStore(faiss_index=faiss.IndexFlatL2(dimensions))
    storage_context = StorageContext.from_defaults(vector_store=vector_store)
    return VectorStoreIndex.from_documents(documents, storage_context=storage_context)
