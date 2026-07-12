from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from backend.apps.knowledge_base.models import KnowledgeResource, ResourceStatus
from backend.apps.knowledge_base.wiki_builder import safe_rebuild_resource_wiki


READY_STATUSES = {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS}


class Command(BaseCommand):
    help = "Backfill structured Wiki concepts, definitions, aliases, and summaries for historical knowledge-base resources."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=0, help="Maximum number of resources to scan. 0 means no limit.")
        parser.add_argument("--resource-id", default="", help="Rebuild Wiki entries for one resource id.")
        parser.add_argument("--scope", default="", help="Filter by resource scope: personal, teacher, class, or global.")
        parser.add_argument("--force", action="store_true", help="Attempt rebuild even when the resource is not indexed.")
        parser.add_argument("--json", action="store_true", dest="as_json", help="Output machine-readable JSON.")

    def handle(self, *args, **options):
        limit = max(0, int(options["limit"]))
        resource_id = str(options["resource_id"] or "").strip()
        scope = str(options["scope"] or "").strip()
        force = bool(options["force"])

        queryset = KnowledgeResource.objects.order_by("created_at")
        if resource_id:
            queryset = queryset.filter(id=resource_id)
        if scope:
            queryset = queryset.filter(resource_scope=scope)
        if limit:
            queryset = queryset[:limit]

        rebuilt = 0
        skipped = []
        failed = []
        details = []
        for resource in queryset:
            if not force and resource.status not in READY_STATUSES:
                skipped.append({"resourceId": str(resource.id), "name": resource.original_name, "status": resource.status})
                continue
            result = safe_rebuild_resource_wiki(resource)
            row = {
                "resourceId": str(resource.id),
                "name": resource.original_name,
                "status": result.status,
                "conceptCount": result.concept_count,
                "definitionCount": result.definition_count,
                "aliasCount": result.alias_count,
                "summaryCount": result.summary_count,
                "reason": result.reason,
            }
            details.append(row)
            if result.status == "failed":
                failed.append(row)
            else:
                rebuilt += 1

        payload = {
            "rebuiltResources": rebuilt,
            "skippedResources": len(skipped),
            "failedResources": len(failed),
            "force": force,
            "limit": limit,
            "resourceId": resource_id,
            "scope": scope,
            "details": details,
            "skipped": skipped,
            "failed": failed,
        }
        if options["as_json"]:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        self.stdout.write("A3 knowledge Wiki backfill")
        self.stdout.write(f"rebuiltResources: {rebuilt}")
        self.stdout.write(f"skippedResources: {len(skipped)}")
        self.stdout.write(f"failedResources: {len(failed)}")
        for item in failed[:5]:
            self.stdout.write(f"failed: {item['name']} {item['reason']}")
