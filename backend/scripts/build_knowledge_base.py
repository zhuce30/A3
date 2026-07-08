from __future__ import annotations

import argparse
from pathlib import Path

from backend.core.settings import DATA_ROOT, DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR
from backend.domains.knowledge_base.index_builder import build_knowledge_base_index


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build A3 LlamaIndex + FAISS knowledge base.")
    parser.add_argument("--data-root", type=Path, default=DATA_ROOT)
    parser.add_argument("--persist-dir", type=Path, default=FAISS_INDEX_DIR)
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL)
    parser.add_argument("--limit-files", type=int, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_knowledge_base_index(
        data_root=args.data_root,
        persist_dir=args.persist_dir,
        embed_model_name=args.embed_model,
        limit_files=args.limit_files,
    )
    print("Knowledge base index built.")
    for key, value in report.model_dump().items():
        if key == "skipped":
            print(f"{key}: {len(value)}")
        else:
            print(f"{key}: {value}")


if __name__ == "__main__":
    main()
