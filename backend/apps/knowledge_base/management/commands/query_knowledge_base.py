from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand

from backend.core.settings import DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR
from backend.domains.knowledge_base.retriever import search_knowledge_base


class Command(BaseCommand):
    help = "Query the A3 local knowledge base."

    def add_arguments(self, parser):
        parser.add_argument("query")
        parser.add_argument("--top-k", type=int, default=5)
        parser.add_argument("--persist-dir", type=Path, default=FAISS_INDEX_DIR)
        parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL)

    def handle(self, *args, **options):
        results = search_knowledge_base(
            options["query"],
            top_k=options["top_k"],
            persist_dir=options["persist_dir"],
            embed_model_name=options["embed_model"],
        )
        for idx, result in enumerate(results, start=1):
            metadata = result.metadata
            self.stdout.write(f"\n[{idx}] score={result.score}")
            self.stdout.write(f"title={metadata.get('title')} source={metadata.get('source_path')}")
            self.stdout.write(result.text)
