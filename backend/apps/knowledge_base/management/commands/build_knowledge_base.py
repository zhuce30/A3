from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand

from backend.core.settings import DATA_ROOT, DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR
from backend.domains.knowledge_base.index_builder import build_knowledge_base_index


class Command(BaseCommand):
    help = "Build the A3 LlamaIndex + FAISS knowledge base."

    def add_arguments(self, parser):
        parser.add_argument("--data-root", type=Path, default=DATA_ROOT)
        parser.add_argument("--persist-dir", type=Path, default=FAISS_INDEX_DIR)
        parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL)
        parser.add_argument("--limit-files", type=int, default=None)

    def handle(self, *args, **options):
        report = build_knowledge_base_index(
            data_root=options["data_root"],
            persist_dir=options["persist_dir"],
            embed_model_name=options["embed_model"],
            limit_files=options["limit_files"],
        )
        self.stdout.write(self.style.SUCCESS("Knowledge base index built."))
        for key, value in report.model_dump().items():
            if key == "skipped":
                self.stdout.write(f"{key}: {len(value)}")
            else:
                self.stdout.write(f"{key}: {value}")
