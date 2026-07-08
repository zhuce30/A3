from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from backend.apps.knowledge_base.models import KnowledgeResource
from backend.apps.knowledge_base.services import reparse_resource


class Command(BaseCommand):
    help = "Backfill multimodal parse evidence for existing A3 knowledge-base resources."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=0)
        parser.add_argument("--force", action="store_true")
        parser.add_argument("--json", action="store_true", dest="as_json")

    def handle(self, *args, **options):
        limit = max(0, int(options["limit"]))
        force = bool(options["force"])
        queryset = KnowledgeResource.objects.order_by("created_at")
        if not force:
            queryset = queryset.filter(parse_runs__isnull=True)
        if limit:
            queryset = queryset[:limit]

        parsed = 0
        failed = []
        for resource in queryset:
            result = reparse_resource(resource)
            if result.status == "failed":
                failed.append({"resourceId": str(resource.id), "name": resource.original_name, "warnings": result.warnings})
            else:
                parsed += 1

        payload = {
            "parsedResources": parsed,
            "failedResources": len(failed),
            "failed": failed,
            "force": force,
            "limit": limit,
        }
        if options["as_json"]:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return
        self.stdout.write("A3 multimodal RAG backfill")
        self.stdout.write(f"parsedResources: {parsed}")
        self.stdout.write(f"failedResources: {len(failed)}")
