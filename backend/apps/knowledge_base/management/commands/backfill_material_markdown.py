from __future__ import annotations

from django.core.management.base import BaseCommand

from backend.apps.knowledge_base.models import KnowledgeBlock
from backend.domains.knowledge_base.markdown_normalizer import normalize_material_markdown


class Command(BaseCommand):
    help = "Backfill derived Markdown metadata for existing knowledge material blocks without changing raw text."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Scan blocks and report how many would be updated.")
        parser.add_argument("--limit", type=int, default=500, help="Maximum number of blocks to scan.")

    def handle(self, *args, **options):
        dry_run = bool(options["dry_run"])
        limit = max(1, int(options["limit"]))
        scanned = 0
        updated = 0
        queryset = KnowledgeBlock.objects.exclude(text="").order_by("created_at")[:limit]

        for block in queryset:
            scanned += 1
            metadata = dict(block.metadata or {})
            normalized = normalize_material_markdown(block.text)
            next_metadata = {
                **metadata,
                "markdownText": normalized.markdown,
                "contentFormat": normalized.content_format,
                "formatFeatures": normalized.features,
                "rawTextPreserved": True,
            }
            if next_metadata == metadata:
                continue
            if not dry_run:
                block.metadata = next_metadata
                block.save(update_fields=["metadata"])
            updated += 1

        if dry_run:
            updated = 0
        self.stdout.write(f"scanned={scanned} updated={updated} dryRun={dry_run}")
        self.stdout.write("Run rebuild graph from the knowledge-base page or targeted graph rebuild command after verifying the backfill.")
