from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"
DATA_ROOT = PROJECT_ROOT / "data"
KNOWLEDGE_BASE_ROOT = BACKEND_ROOT / "knowledge_base"
FAISS_INDEX_DIR = KNOWLEDGE_BASE_ROOT / "faiss_index"
METADATA_DIR = KNOWLEDGE_BASE_ROOT / "metadata"
HF_CACHE_DIR = BACKEND_ROOT / ".cache" / "huggingface"

DEFAULT_EMBED_MODEL = "BAAI/bge-small-zh-v1.5"
EMBED_DIMENSIONS = {
    "BAAI/bge-small-zh-v1.5": 512,
    "BAAI/bge-base-zh-v1.5": 768,
    "BAAI/bge-large-zh-v1.5": 1024,
    "BAAI/bge-m3": 1024,
}
