from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand

from backend.apps.knowledge_base.models import KnowledgeResource
from backend.apps.knowledge_base.services import build_resource_multimodal_summary, create_parse_job


class Command(BaseCommand):
    help = "Evaluate document parsing quality for course materials."

    def add_arguments(self, parser):
        parser.add_argument("--course-key", default="OS-001")
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--output", default="")
        parser.add_argument("--parse-missing", action="store_true")

    def handle(self, *args, **options):
        course_key = options["course_key"]
        resources = list(KnowledgeResource.objects.filter(course_key=course_key).order_by("original_name"))
        if options["parse_missing"]:
            missing = [resource for resource in resources if not resource.parse_runs.exists()]
            missing_by_owner: dict[int, list[KnowledgeResource]] = {}
            for resource in missing:
                missing_by_owner.setdefault(resource.owner_id, []).append(resource)
            for owner_resources in missing_by_owner.values():
                job = create_parse_job(owner_resources[0].owner, owner_resources)
                self.stdout.write(f"parse job queued: {job.id} ({len(owner_resources)} resources)")

        rows = [_resource_metrics(resource) for resource in resources]
        summary = _summary(rows)
        payload = {
            "schemaVersion": "a3.document-parse-eval.v1",
            "courseKey": course_key,
            "summary": summary,
            "resources": rows,
        }
        if options["output"]:
            output_path = Path(options["output"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        if options["as_json"]:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return
        self.stdout.write(f"Document parsing evaluation for {course_key}")
        self.stdout.write(f"resources: {summary['resources']}")
        self.stdout.write(f"parsed: {summary['parsedResources']}")
        self.stdout.write(f"avgQuality: {summary['averageQuality']}")
        self.stdout.write(f"avgGarbledRatio: {summary['averageGarbledRatio']}")
        self.stdout.write(f"citationReadyRate: {summary['citationReadyRate']}")
        self.stdout.write(f"tableBlocks: {summary['tableBlocks']}, formulaBlocks: {summary['formulaBlocks']}")


def _resource_metrics(resource: KnowledgeResource) -> dict:
    multimodal = build_resource_multimodal_summary(resource)
    return {
        "resourceId": str(resource.id),
        "name": resource.original_name,
        "type": resource.file_type.lstrip(".").upper(),
        "status": resource.status,
        "parseStatus": multimodal["parseStatus"],
        "schemaVersion": multimodal["schemaVersion"],
        "pages": multimodal["pages"],
        "textBlocks": multimodal["textBlocks"],
        "tableBlocks": multimodal["tableBlocks"],
        "formulaBlocks": multimodal["formulaBlocks"],
        "qualityScore": multimodal["qualityScore"],
        "textCoverage": multimodal["textCoverage"],
        "garbledRatio": multimodal["garbledRatio"],
        "citationReadiness": multimodal["citationReadiness"],
        "providerChain": multimodal["providerChain"],
        "warnings": multimodal["warnings"],
    }


def _summary(rows: list[dict]) -> dict:
    parsed = [row for row in rows if row["parseStatus"] != "not_started"]
    citation_ready = [row for row in rows if row["citationReadiness"]]
    return {
        "resources": len(rows),
        "parsedResources": len(parsed),
        "averageQuality": _avg(row["qualityScore"] for row in parsed),
        "averageTextCoverage": _avg(row["textCoverage"] for row in parsed),
        "averageGarbledRatio": _avg(row["garbledRatio"] for row in parsed),
        "citationReadyRate": round(len(citation_ready) / len(rows), 3) if rows else 0,
        "tableBlocks": sum(int(row["tableBlocks"]) for row in rows),
        "formulaBlocks": sum(int(row["formulaBlocks"]) for row in rows),
        "needsEnhancedParsing": [
            {
                "resourceId": row["resourceId"],
                "name": row["name"],
                "reason": _reason(row),
            }
            for row in rows
            if row["parseStatus"] == "not_started" or not row["citationReadiness"] or row["garbledRatio"] > 0.08
        ],
    }


def _reason(row: dict) -> str:
    if row["parseStatus"] == "not_started":
        return "not_parsed"
    if row["garbledRatio"] > 0.08:
        return "high_garbled_ratio"
    if not row["citationReadiness"]:
        return "not_citation_ready"
    return "quality_below_threshold"


def _avg(values) -> float:
    values = [float(value or 0) for value in values]
    return round(sum(values) / len(values), 3) if values else 0
