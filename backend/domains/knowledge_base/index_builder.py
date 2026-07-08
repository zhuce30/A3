from __future__ import annotations

from pathlib import Path
from collections.abc import Callable

from backend.core.runtime import configure_huggingface_runtime

configure_huggingface_runtime()

import faiss
from llama_index.core import Settings, StorageContext, VectorStoreIndex
from llama_index.core.node_parser import SentenceSplitter
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.vector_stores.faiss import FaissVectorStore

from backend.core.settings import (
    DATA_ROOT,
    DEFAULT_EMBED_MODEL,
    EMBED_DIMENSIONS,
    FAISS_INDEX_DIR,
    METADATA_DIR,
)
from backend.domains.knowledge_base.document_loader import (
    iter_source_files,
    load_documents,
    write_build_report,
)
from backend.domains.knowledge_base.schemas import BuildKnowledgeBaseReport


def build_knowledge_base_index(
    data_root: Path = DATA_ROOT,
    persist_dir: Path = FAISS_INDEX_DIR,
    embed_model_name: str = DEFAULT_EMBED_MODEL,
    limit_files: int | None = None,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> BuildKnowledgeBaseReport:
    data_root = data_root.resolve()
    persist_dir = persist_dir.resolve()
    persist_dir.mkdir(parents=True, exist_ok=True)
    METADATA_DIR.mkdir(parents=True, exist_ok=True)

    source_files = iter_source_files(data_root, limit_files=limit_files)
    documents = []
    skipped = []
    total_files = len(source_files)
    for position, source_file in enumerate(source_files, start=1):
        loaded, file_skipped = load_documents([source_file])
        documents.extend(loaded)
        skipped.extend(file_skipped)
        if progress_callback:
            progress_callback(position, total_files, source_file.name)
    if not documents:
        raise RuntimeError("No documents were loaded. Check data_root and supported file types.")

    Settings.embed_model = HuggingFaceEmbedding(model_name=embed_model_name)
    Settings.node_parser = SentenceSplitter(chunk_size=512, chunk_overlap=80)

    dimensions = EMBED_DIMENSIONS.get(embed_model_name)
    if dimensions is None:
        dimensions = len(Settings.embed_model.get_text_embedding("dimension probe"))

    faiss_index = faiss.IndexFlatL2(dimensions)
    vector_store = FaissVectorStore(faiss_index=faiss_index)
    storage_context = StorageContext.from_defaults(vector_store=vector_store)

    index = VectorStoreIndex.from_documents(documents, storage_context=storage_context)
    index.storage_context.persist(persist_dir=str(persist_dir))

    report = BuildKnowledgeBaseReport(
        data_root=str(data_root),
        persist_dir=str(persist_dir),
        embed_model=embed_model_name,
        embedding_dimensions=dimensions,
        source_files_seen=len(source_files),
        documents_loaded=len(documents),
        skipped=skipped,
    )
    write_build_report(METADATA_DIR / "build_report.json", report.model_dump())
    return report
