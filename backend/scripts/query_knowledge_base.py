from __future__ import annotations

import argparse
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

from backend.core.settings import DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR
from backend.domains.knowledge_base.retriever import search_knowledge_base


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query A3 local knowledge base.")
    parser.add_argument("query")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--persist-dir", type=Path, default=FAISS_INDEX_DIR)
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    results = search_knowledge_base(
        args.query,
        top_k=args.top_k,
        persist_dir=args.persist_dir,
        embed_model_name=args.embed_model,
    )
    for idx, result in enumerate(results, start=1):
        metadata = result.metadata
        print(f"\n[{idx}] score={result.score}")
        print(f"title={metadata.get('title')} source={metadata.get('source_path')}")
        print(result.text)


if __name__ == "__main__":
    main()
