from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand

from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgeIndexEntry, KnowledgeParseRun, KnowledgeResource, ResourceStatus


class Command(BaseCommand):
    help = "Evaluate A3 multimodal RAG ingestion readiness from current knowledge-base records."

    def add_arguments(self, parser):
        parser.add_argument("--top-k", type=int, default=3)
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--output", type=Path)

    def handle(self, *args, **options):
        metrics = build_metrics(top_k=max(1, int(options["top_k"])))
        if options["as_json"]:
            payload = json.dumps(metrics, ensure_ascii=False, indent=2)
        else:
            payload = "\n".join(
                [
                    "A3 multimodal RAG smoke metrics",
                    f"resources: {metrics['resources']}",
                    f"parsedResources: {metrics['parsedResources']}",
                    f"parseSuccessRate: {metrics['parseSuccessRate']:.4f}",
                    f"visualCoverage: {metrics['visualCoverage']:.4f}",
                    f"textCoverage: {metrics['textCoverage']:.4f}",
                    f"hybridReadyRate: {metrics['hybridReadyRate']:.4f}",
                    f"warningRate: {metrics['warningRate']:.4f}",
                    f"topK: {metrics['topK']}",
                ]
            )
        output_path = options.get("output")
        if output_path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(payload, encoding="utf-8")
        self.stdout.write(payload)


def build_metrics(top_k: int) -> dict:
    resources = KnowledgeResource.objects.all()
    total = resources.count()
    parse_runs = KnowledgeParseRun.objects.all()
    parsed_ids = set(parse_runs.values_list("resource_id", flat=True))
    successful_parsed_ids = set(
        parse_runs.exclude(status="failed").values_list("resource_id", flat=True)
    )
    parsed_count = len(parsed_ids)
    visual_resource_ids = set(
        KnowledgeBlock.objects.filter(modality__in=["image", "page_image", "slide_image"]).values_list("resource_id", flat=True)
    )
    text_resource_ids = set(
        KnowledgeBlock.objects.filter(modality__in=["text", "table", "formula"]).exclude(text="").values_list("resource_id", flat=True)
    )
    warning_count = resources.filter(status=ResourceStatus.INDEXED_WITH_WARNINGS).count()
    indexed_count = resources.filter(status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS]).count()
    visual_indexed = KnowledgeIndexEntry.objects.filter(index_type="visual_vector", status="indexed").count()
    text_indexed = KnowledgeIndexEntry.objects.filter(index_type__in=["text_vector", "lexical"], status="indexed").count()
    hybrid_ready_ids = visual_resource_ids | text_resource_ids
    return {
        "topK": top_k,
        "resources": total,
        "indexedResources": indexed_count,
        "parsedResources": parsed_count,
        "parseSucceededResources": len(successful_parsed_ids),
        "parseFailedResources": max(0, parsed_count - len(successful_parsed_ids)),
        "visualResources": len(visual_resource_ids),
        "textResources": len(text_resource_ids),
        "visualIndexedEntries": visual_indexed,
        "textIndexedEntries": text_indexed,
        "parseSuccessRate": _ratio(len(successful_parsed_ids), total),
        "visualCoverage": _ratio(len(visual_resource_ids), total),
        "textCoverage": _ratio(len(text_resource_ids), total),
        "hybridReadyRate": _ratio(len(hybrid_ready_ids), total),
        "warningRate": _ratio(warning_count, total),
    }


def _ratio(value: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round(value / total, 6)
