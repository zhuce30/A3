from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone

from backend.apps.compat.llm import LLMUnavailable, chat_completion
from backend.apps.knowledge_base.graph_input_adapter import MaterialBlock, iter_material_blocks
from backend.apps.knowledge_base.models import (
    KnowledgeGraphClaim,
    KnowledgeGraphEntity,
    KnowledgeGraphRelation,
    KnowledgeParseRun,
    KnowledgeResource,
)
from backend.domains.knowledge_base.markdown_normalizer import normalize_material_markdown


SCHEMA_VERSION = "a3.material-knowledge-graph.v1"
METHOD = "rule_fallback"
LLM_METHOD = "llm_graph"
LLM_GRAPH_BLOCK_BATCH_SIZE = 24
LLM_GRAPH_TEXT_CHARS_PER_BLOCK = 1200
GRAPH_API_DEFAULT_LIMIT = 120
GRAPH_API_MAX_LIMIT = 500
GRAPH_ENTITY_TYPES = ("concept", "method", "formula", "metric", "process", "system", "visual", "person", "organization", "resource")
GRAPH_RELATION_TYPES = ("defines", "part_of", "contains", "depends_on", "causes", "influences", "used_for", "measures", "contrasts_with", "prerequisite_of", "co_occurs")

STOP_TERMS = {
    "这个",
    "这些",
    "一种",
    "通过",
    "进行",
    "用于",
    "包括",
    "以及",
    "可以",
    "需要",
    "学生",
    "学习",
    "知识",
    "资料",
}

RELATION_PATTERNS = [
    (re.compile(r"(?P<a>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})\s*(?:是|为|属于)\s*(?P<b>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})"), "defines", "定义"),
    (re.compile(r"(?P<a>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})\s*(?:用于|用来|可用于)\s*(?P<b>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})"), "used_for", "用于"),
    (re.compile(r"(?P<a>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})\s*(?:依赖|基于|取决于)\s*(?P<b>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})"), "depends_on", "依赖"),
    (re.compile(r"(?P<a>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})\s*(?:包含|包括|由)\s*(?P<b>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})"), "contains", "包含"),
    (re.compile(r"(?P<a>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})\s*(?:影响|决定|导致)\s*(?P<b>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,24})"), "influences", "影响"),
]


@dataclass
class GraphBuildResult:
    status: str
    entity_count: int = 0
    relation_count: int = 0
    claim_count: int = 0
    degraded: bool = True
    reason: str = ""
    trace_id: str = ""
    workflow: str = "material_knowledge_graph"
    workflow_schema_version: str = "a3.agent-workflow.v1"
    method: str = METHOD
    quality: dict[str, Any] | None = None


def rebuild_resource_graph(resource: KnowledgeResource) -> GraphBuildResult:
    blocks = iter_material_blocks(resource)
    with transaction.atomic():
        _delete_resource_graph(resource)
        if not blocks:
            result = GraphBuildResult(status="empty", reason="没有可抽取的多模态解析块")
            _write_build_metadata(resource, result)
            return result
        workflow_result = run_material_knowledge_graph_workflow(resource, blocks)
        material_graph = workflow_result.output.get("materialGraph") if isinstance(workflow_result.output, dict) else {}
        if not workflow_result.success or not isinstance(material_graph, dict):
            result = GraphBuildResult(status="empty", reason="解析块中没有稳定概念候选")
            _write_build_metadata(resource, result)
            return result

        result = GraphBuildResult(
            status=str(material_graph.get("status") or "ready"),
            entity_count=int(material_graph.get("entityCount") or 0),
            relation_count=int(material_graph.get("relationCount") or 0),
            claim_count=int(material_graph.get("claimCount") or 0),
            degraded=bool(material_graph.get("degraded", True)),
            reason=str(material_graph.get("reason") or "当前使用 AgentKernel 规则抽取生成降级图谱；所有节点和关系均绑定上传资料证据。"),
            trace_id=str(workflow_result.trace.get("traceId") or workflow_result.output.get("traceId") or ""),
            method=str(material_graph.get("method") or METHOD),
            quality=material_graph.get("quality") if isinstance(material_graph.get("quality"), dict) else {},
        )
        _write_build_metadata(resource, result)
        from backend.apps.knowledge_base.wiki_builder import safe_rebuild_resource_wiki

        safe_rebuild_resource_wiki(resource)
        return result


def run_material_knowledge_graph_workflow(resource: KnowledgeResource, blocks: list[MaterialBlock]):
    from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

    class GraphInputAgent(BaseAgent):
        name = "GraphInputAgent"
        role = "material graph input"
        detail = "Normalize persisted multimodal blocks into graph extraction input."
        output_schema_version = "a3.material-graph-input-agent.v1"
        output_schema = {
            "type": "object",
            "properties": {"materialGraphInput": {"type": "object"}},
            "required": ["materialGraphInput"],
        }

        def run(self, context: AgentContext) -> AgentResult:
            return AgentResult(
                output={
                    "materialGraphInput": {
                        "resourceId": str(resource.id),
                        "resourceTitle": resource.original_name,
                        "blockCount": len(blocks),
                        "degradedEvidenceCount": sum(1 for block in blocks if block.degraded),
                    }
                },
                state_patch={"materialBlocks": blocks},
                input_summary={"resourceId": str(resource.id), "fileType": resource.file_type},
                output_summary={"blockCount": len(blocks)},
                state_diff={"materialBlocks": len(blocks)},
                evidence={"source": "KnowledgeBlock", "blockCount": len(blocks)},
                quality={"hasBlocks": bool(blocks)},
            )

    class GraphExtractionAgent(BaseAgent):
        name = "GraphExtractionAgent"
        role = "entity relation extraction"
        detail = "Extract material graph candidates with deterministic fallback rules."
        output_schema_version = "a3.material-graph-extraction-agent.v1"
        output_schema = {
            "type": "object",
            "properties": {"graphCandidates": {"type": "object"}},
            "required": ["graphCandidates"],
        }

        def run(self, context: AgentContext) -> AgentResult:
            material_blocks = context.state.get("materialBlocks") or []
            entities_by_label = _extract_entities(material_blocks)
            if not entities_by_label:
                raise ValueError("no stable graph entities extracted")
            entity_keys = list(entities_by_label)
            relation_candidates = _extract_relation_candidates(material_blocks, entity_keys)
            claim_candidates = _extract_claim_candidates(material_blocks, entity_keys)
            return AgentResult(
                output={
                    "graphCandidates": {
                        "schemaVersion": SCHEMA_VERSION,
                        "entityCount": len(entities_by_label),
                        "relationCount": len(relation_candidates),
                        "claimCount": len(claim_candidates),
                        "degraded": True,
                        "method": METHOD,
                    }
                },
                state_patch={
                    "entitiesByLabel": entities_by_label,
                    "relationCandidates": relation_candidates,
                    "claimCandidates": claim_candidates,
                },
                input_summary={"blockCount": len(material_blocks)},
                output_summary={"entities": len(entities_by_label), "relations": len(relation_candidates), "claims": len(claim_candidates)},
                evidence={"extractionMethod": METHOD, "sourceBound": True},
                quality={"degraded": True, "hasEntities": bool(entities_by_label)},
                detail="Use deterministic fallback extraction before optional LLM extraction is configured.",
            )

    class GraphPersistenceAgent(BaseAgent):
        name = "GraphPersistenceAgent"
        role = "graph persistence"
        detail = "Persist graph entities, relations, claims, and source evidence."
        output_schema_version = "a3.material-graph-persistence-agent.v1"
        output_schema = {
            "type": "object",
            "properties": {"materialGraph": {"type": "object"}},
            "required": ["materialGraph"],
        }

        def run(self, context: AgentContext) -> AgentResult:
            entities_by_label = context.state.get("entitiesByLabel") or {}
            graph_candidates = context.state.get("graphCandidates") if isinstance(context.state.get("graphCandidates"), dict) else {}
            method = str(graph_candidates.get("method") or METHOD)
            degraded = bool(graph_candidates.get("degraded", True))
            saved_entities = _save_entities(resource, entities_by_label)
            relation_candidates = context.state.get("relationCandidates") or []
            claim_candidates = context.state.get("claimCandidates") or []
            saved_relation_count = _save_relations(resource, relation_candidates)
            saved_claim_count = _save_claims_with_entities(resource, claim_candidates, saved_entities)
            graph_quality = _graph_quality_metrics(saved_entities, relation_candidates, claim_candidates, saved_relation_count, saved_claim_count, graph_candidates)
            graph_payload = {
                "schemaVersion": SCHEMA_VERSION,
                "status": "ready",
                "entityCount": len(saved_entities),
                "relationCount": saved_relation_count,
                "claimCount": saved_claim_count,
                "degraded": degraded,
                "method": method,
                "quality": graph_quality,
                "reason": str(
                    graph_candidates.get("reason")
                    or (
                        "LLMGraphExtractionAgent generated source-bound graph candidates."
                        if method == LLM_METHOD
                        else "AgentKernel workflow used deterministic fallback extraction with source-bound evidence."
                    )
                ),
            }
            return AgentResult(
                output={"materialGraph": graph_payload},
                state_patch={"materialGraph": graph_payload},
                input_summary={"entities": len(entities_by_label), "relations": len(relation_candidates), "claims": len(claim_candidates)},
                output_summary=graph_payload,
                state_diff={"KnowledgeGraphEntity": len(saved_entities), "KnowledgeGraphRelation": saved_relation_count, "KnowledgeGraphClaim": saved_claim_count},
                evidence={"resourceId": str(resource.id), "schemaVersion": SCHEMA_VERSION, "method": method},
                quality={"persisted": True, "sourceEvidenceRequired": True, "degraded": degraded, **graph_quality},
            )

    class LLMGraphExtractionAgent(BaseAgent):
        name = "LLMGraphExtractionAgent"
        role = "llm graph extraction"
        detail = "Use a configured LLM to extract source-bound graph candidates; fall back to rule candidates when unavailable."
        output_schema_version = "a3.material-graph-llm-agent.v1"
        output_schema = {
            "type": "object",
            "properties": {"graphCandidates": {"type": "object"}},
            "required": ["graphCandidates"],
        }

        def run(self, context: AgentContext) -> AgentResult:
            if not _graph_llm_configured():
                raise LLMUnavailable("A3_LLM_API_KEY/DASHSCOPE_API_KEY/OPENAI_API_KEY is not configured")
            material_blocks = context.state.get("materialBlocks") or []
            candidates = _extract_llm_graph_candidates(material_blocks)
            entities_by_label = candidates["entitiesByLabel"]
            if not entities_by_label:
                raise ValueError("LLM returned no usable graph entities")
            relation_candidates = candidates["relationCandidates"]
            claim_candidates = candidates["claimCandidates"]
            graph_candidates = {
                "schemaVersion": SCHEMA_VERSION,
                "entityCount": len(entities_by_label),
                "relationCount": len(relation_candidates),
                "claimCount": len(claim_candidates),
                "degraded": False,
                "method": LLM_METHOD,
                "reason": "LLMGraphExtractionAgent generated source-bound graph candidates.",
                "provider": candidates.get("provider", ""),
                "model": candidates.get("model", ""),
                "quality": {
                    "aliasMergeCount": candidates.get("aliasMergeCount", 0),
                    "gleaningRounds": candidates.get("gleaningRounds", 0),
                    "processedBatchCount": candidates.get("processedBatchCount", 0),
                    "successfulBatchCount": candidates.get("successfulBatchCount", 0),
                    "failedBatchCount": candidates.get("failedBatchCount", 0),
                    "failedBatchErrors": candidates.get("failedBatchErrors", []),
                },
            }
            return AgentResult(
                output={"graphCandidates": graph_candidates},
                state_patch={
                    "graphCandidates": graph_candidates,
                    "entitiesByLabel": entities_by_label,
                    "relationCandidates": relation_candidates,
                    "claimCandidates": claim_candidates,
                },
                input_summary={"blockCount": len(material_blocks)},
                output_summary={"entities": len(entities_by_label), "relations": len(relation_candidates), "claims": len(claim_candidates)},
                evidence={"extractionMethod": LLM_METHOD, "provider": candidates.get("provider", ""), "model": candidates.get("model", "")},
                quality={"degraded": False, "hasEntities": bool(entities_by_label), "sourceBound": True},
            )

        def fallback(self, context: AgentContext, error: Exception) -> AgentResult | None:
            graph_candidates = context.state.get("graphCandidates") if isinstance(context.state.get("graphCandidates"), dict) else {}
            fallback_candidates = {
                **graph_candidates,
                "schemaVersion": SCHEMA_VERSION,
                "degraded": True,
                "method": METHOD,
                "reason": f"LLM graph extraction unavailable; using deterministic fallback. {type(error).__name__}: {error}",
            }
            return AgentResult(
                output={"graphCandidates": fallback_candidates},
                state_patch={"graphCandidates": fallback_candidates},
                input_summary={"fallbackFrom": "LLMGraphExtractionAgent"},
                output_summary=fallback_candidates,
                evidence={"extractionMethod": METHOD, "llmError": str(error)[:240]},
                quality={"degraded": True, "sourceBound": True},
                detail="LLM graph extraction was unavailable; deterministic graph candidates were preserved.",
            )

    kernel = AgentKernel()
    for agent in (GraphInputAgent(), GraphExtractionAgent(), LLMGraphExtractionAgent(), GraphPersistenceAgent()):
        kernel.register(agent)
    return kernel.run(
        AgentContext(
            user=resource.owner,
            workflow="material_knowledge_graph",
            goal=f"build material knowledge graph for {resource.original_name}",
            payload={"resourceId": str(resource.id), "resourceTitle": resource.original_name},
        ),
        ["GraphInputAgent", "GraphExtractionAgent", "LLMGraphExtractionAgent", "GraphPersistenceAgent"],
    )


def safe_rebuild_resource_graph(resource: KnowledgeResource) -> GraphBuildResult:
    try:
        return rebuild_resource_graph(resource)
    except Exception as exc:
        result = GraphBuildResult(status="failed", degraded=True, reason=f"{type(exc).__name__}: {exc}"[:500])
        _write_build_metadata(resource, result)
        return result


def serialize_material_graph(user, params: dict) -> dict:
    from backend.apps.knowledge_base.services import accessible_resources_for_user

    resources = accessible_resources_for_user(user)
    resource_id = str(params.get("resourceId") or "").strip()
    resource_type = str(params.get("resourceType") or "").strip().lower()
    entity_type = str(params.get("entityType") or "").strip()
    relation_type = str(params.get("relationType") or "").strip()
    block_type = str(params.get("blockType") or "").strip()
    query = str(params.get("q") or "").strip()
    center_id = str(params.get("centerId") or "").strip()
    depth = _normalize_graph_depth(params.get("depth"))
    limit = min(_int_param(params.get("limit"), GRAPH_API_DEFAULT_LIMIT), GRAPH_API_MAX_LIMIT)

    if resource_id:
        resources = resources.filter(id=resource_id)
    if resource_type:
        resources = resources.filter(file_type__iexact=f".{resource_type.lstrip('.')}")

    entities_qs = KnowledgeGraphEntity.objects.filter(resource__in=resources).select_related("resource")
    if entity_type:
        entities_qs = entities_qs.filter(entity_type=entity_type)
    if query:
        entities_qs = entities_qs.filter(Q(label__icontains=query) | Q(summary__icontains=query))
    all_entities = list(entities_qs.order_by("label"))
    all_entity_ids = {entity.id for entity in all_entities}

    relations_qs = KnowledgeGraphRelation.objects.filter(resource__in=resources).select_related("source_entity", "target_entity", "resource")
    if relation_type:
        relations_qs = relations_qs.filter(relation_type=relation_type)
    if block_type:
        relations_qs = relations_qs.filter(evidence__icontains=block_type)
    all_relations = [
        relation
        for relation in relations_qs.order_by("-weight", "label")
        if relation.source_entity_id in all_entity_ids and relation.target_entity_id in all_entity_ids
    ]

    focus_entity_ids, resolved_center_id, has_more = _focused_entity_ids(all_entities, all_relations, center_id, depth, limit)
    entities = [entity for entity in all_entities if entity.id in focus_entity_ids]
    entity_ids = {entity.id for entity in entities}
    relations = [
        relation
        for relation in all_relations
        if relation.source_entity_id in entity_ids and relation.target_entity_id in entity_ids
    ]

    claims = KnowledgeGraphClaim.objects.filter(resource__in=resources).select_related("resource").order_by("-created_at")[:limit]
    visible_ids = {str(entity.id) for entity in entities}
    claim_payloads = [
        _serialize_claim(claim)
        for claim in claims
        if not visible_ids or visible_ids.intersection({str(item) for item in (claim.entity_ids or [])})
    ]
    node_payloads = [_serialize_entity(entity) for entity in entities]
    edge_payloads = [_serialize_relation(relation) for relation in relations]
    latest_build = _latest_graph_build(resources)
    quality = latest_build.get("quality") if isinstance(latest_build.get("quality"), dict) else {}
    if not quality:
        quality = _visible_graph_quality(node_payloads, edge_payloads, claim_payloads)
    status = "ready" if entities else "empty"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": "knowledge_base_materials",
        "mode": "material_graph",
        "filters": {
            "resourceId": resource_id or None,
            "resourceType": resource_type or None,
            "entityType": entity_type or None,
            "relationType": relation_type or None,
            "blockType": block_type or None,
            "q": query or None,
            "centerId": center_id or None,
            "depth": depth,
            "limit": limit,
        },
        "focus": {
            "centerId": str(resolved_center_id) if resolved_center_id else None,
            "depth": depth,
            "limit": limit,
            "returnedNodeCount": len(node_payloads),
            "returnedEdgeCount": len(edge_payloads),
            "hasMore": has_more,
            "partial": depth != "all",
        },
        "nodes": node_payloads,
        "edges": edge_payloads,
        "claims": claim_payloads,
        "summary": {
            "resourceCount": resources.count(),
            "entityCount": len(all_entities),
            "relationCount": len(all_relations),
            "claimCount": KnowledgeGraphClaim.objects.filter(resource__in=resources).count(),
            "degradedCount": sum(1 for entity in all_entities if entity.degraded) + sum(1 for relation in all_relations if relation.degraded),
        },
        "quality": quality,
        "build": {
            "status": latest_build.get("status") or status,
            "lastBuiltAt": latest_build.get("lastBuiltAt"),
            "degraded": True if not entities else bool(latest_build.get("degraded", True)),
            "reason": latest_build.get("reason") or ("暂无资料图谱，请先上传并完成多模态解析。" if not entities else ""),
        },
        "nextAction": None if entities else {"label": "上传资料", "href": "/a3/knowledge-base"},
    }


def _normalize_graph_depth(value: Any) -> str:
    raw = str(value or "1").strip().lower()
    if raw in {"0", "none", "center"}:
        return "center"
    if raw in {"2", "two"}:
        return "two"
    if raw in {"all", "full"}:
        return "all"
    return "one"


def _focused_entity_ids(
    entities: list[KnowledgeGraphEntity],
    relations: list[KnowledgeGraphRelation],
    center_id: str,
    depth: str,
    limit: int,
) -> tuple[set[Any], Any | None, bool]:
    if not entities:
        return set(), None, False

    entity_ids = {entity.id for entity in entities}
    if depth == "all":
        limited = {entity.id for entity in entities[:limit]}
        return limited, None, len(entities) > len(limited)

    adjacency: dict[Any, set[Any]] = {entity.id: set() for entity in entities}
    degree: Counter[Any] = Counter()
    for relation in relations:
        if relation.source_entity_id not in entity_ids or relation.target_entity_id not in entity_ids:
            continue
        adjacency.setdefault(relation.source_entity_id, set()).add(relation.target_entity_id)
        adjacency.setdefault(relation.target_entity_id, set()).add(relation.source_entity_id)
        degree[relation.source_entity_id] += 1
        degree[relation.target_entity_id] += 1

    resolved_center = None
    if center_id:
        resolved_center = next((entity.id for entity in entities if str(entity.id) == center_id), None)
    if not resolved_center:
        resolved_center = max(entities, key=lambda entity: (degree[entity.id], entity.confidence, entity.label)).id

    max_hops = 0 if depth == "center" else 2 if depth == "two" else 1
    ordered_ids: list[Any] = [resolved_center]
    seen = {resolved_center}
    frontier = {resolved_center}
    for _ in range(max_hops):
        next_frontier: set[Any] = set()
        for item_id in sorted(frontier, key=lambda value: str(value)):
            next_frontier.update(adjacency.get(item_id, set()) - seen)
        for item_id in sorted(next_frontier, key=lambda value: (-degree[value], str(value))):
            if item_id not in seen:
                ordered_ids.append(item_id)
                seen.add(item_id)
        frontier = next_frontier

    limited_ids = set(ordered_ids[:limit])
    return limited_ids, resolved_center, len(ordered_ids) > len(limited_ids)


def _delete_resource_graph(resource: KnowledgeResource) -> None:
    KnowledgeGraphClaim.objects.filter(resource=resource).delete()
    KnowledgeGraphRelation.objects.filter(resource=resource).delete()
    KnowledgeGraphEntity.objects.filter(resource=resource).delete()


def _graph_llm_configured() -> bool:
    return bool(
        (
            os.getenv("A3_GRAPH_LLM_API_KEY")
            or os.getenv("A3_LLM_API_KEY")
            or os.getenv("DASHSCOPE_API_KEY")
            or os.getenv("OPENAI_API_KEY")
            or ""
        ).strip()
    )


def _extract_llm_graph_candidates(blocks: list[MaterialBlock]) -> dict:
    all_block_rows = _llm_block_rows(blocks)
    parsed: dict = {"entities": [], "relations": [], "claims": []}
    provider = ""
    model = ""
    processed_batch_count = 0
    successful_batch_count = 0
    failed_batch_errors: list[str] = []
    total_batches = max(1, (len(all_block_rows) + LLM_GRAPH_BLOCK_BATCH_SIZE - 1) // LLM_GRAPH_BLOCK_BATCH_SIZE)
    for batch_index, block_rows in enumerate(_chunk_list(all_block_rows, LLM_GRAPH_BLOCK_BATCH_SIZE), start=1):
        processed_batch_count += 1
        try:
            batch_payload, result = _extract_llm_graph_batch(
                block_rows,
                batch_index=batch_index,
                total_batches=total_batches,
            )
        except Exception as exc:
            failed_batch_errors.append(f"batch {batch_index}: {type(exc).__name__}: {str(exc)[:160]}")
            continue
        parsed = _merge_graph_extraction_payload(parsed, batch_payload)
        provider = provider or str(result.get("provider") or "")
        model = model or str(result.get("model") or "")
        successful_batch_count += 1

    if not _graph_payload_has_items(parsed):
        detail = "; ".join(failed_batch_errors[:3])
        suffix = f": {detail}" if detail else ""
        raise ValueError(f"LLM graph response is not valid JSON{suffix}")
    gleaning_rounds = _graph_llm_gleaning_rounds()
    completed_gleaning_rounds = 0
    for round_index in range(gleaning_rounds):
        round_added = False
        for block_rows in _chunk_list(all_block_rows, LLM_GRAPH_BLOCK_BATCH_SIZE):
            try:
                gleaned = _extract_llm_graph_gleaning(parsed, block_rows, round_index=round_index + 1)
            except Exception:
                gleaned = {}
            if _graph_payload_has_items(gleaned):
                parsed = _merge_graph_extraction_payload(parsed, gleaned)
                round_added = True
        if round_added:
            completed_gleaning_rounds += 1
    block_by_id = _llm_block_lookup(blocks)
    fallback_block = blocks[0] if blocks else None
    entities_by_label: dict[str, dict] = {}
    raw_entity_count = 0
    for item in _dict_items(parsed.get("entities")):
        label = str(item.get("label") or "").strip()
        normalized = normalize_label(label)
        if not normalized or not _valid_term(label):
            continue
        raw_entity_count += 1
        aliases = _clean_aliases(_coerce_str_list(item.get("aliases")), label)
        canonical = _resolve_llm_canonical_key(item, normalized, aliases, entities_by_label)
        evidence = _evidence_for_llm_item(item, block_by_id, fallback_block, label)
        _merge_llm_entity(
            entities_by_label,
            canonical,
            {
                "label": str(item.get("canonicalLabel") or label).strip()[:160],
                "normalized_label": canonical,
                "entity_type": str(item.get("type") or item.get("entityType") or _entity_type(canonical))[:32],
                "summary": str(item.get("summary") or _summary_from_evidence(evidence))[:500],
                "confidence": _coerce_confidence(item.get("confidence"), default=0.82),
                "source_locations": evidence,
                "aliases": aliases + ([label] if canonical != normalized else []),
                "degraded": False,
                "extraction_method": LLM_METHOD,
            },
        )
    relation_candidates: list[dict] = []
    for item in _dict_items(parsed.get("relations")):
        source = _resolve_llm_entity_reference(str(item.get("source") or ""), entities_by_label)
        target = _resolve_llm_entity_reference(str(item.get("target") or ""), entities_by_label)
        if not source or not target or source == target:
            continue
        evidence = _evidence_for_llm_item(item, block_by_id, fallback_block, f"{source} {target}")
        relation_candidates.append(
            {
                "source": source,
                "target": target,
                "relation_type": str(item.get("type") or item.get("relationType") or "related_to")[:32],
                "label": str(item.get("label") or item.get("type") or "related")[:80],
                "weight": _coerce_confidence(item.get("confidence"), default=0.78),
                "evidence": evidence,
                "degraded": False,
                "extraction_method": LLM_METHOD,
            }
        )
    if entities_by_label and not relation_candidates:
        relation_candidates = _extract_relation_candidates(blocks, list(entities_by_label))
        for relation in relation_candidates:
            relation["degraded"] = True
            relation["extraction_method"] = METHOD
    claim_candidates: list[dict] = []
    for item in _dict_items(parsed.get("claims")):
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        entity_labels = [
            label
            for raw in _coerce_str_list(item.get("entities") or item.get("entityLabels"))
            if (label := _resolve_llm_entity_reference(raw, entities_by_label))
        ][:6]
        evidence = _evidence_for_llm_item(item, block_by_id, fallback_block, text)
        claim_candidates.append(
            {
                "text": text[:500],
                "entity_labels": entity_labels,
                "evidence": evidence,
                "degraded": False,
                "extraction_method": LLM_METHOD,
            }
        )
    return {
        "entitiesByLabel": entities_by_label,
        "relationCandidates": relation_candidates,
        "claimCandidates": claim_candidates,
        "provider": provider,
        "model": model,
        "aliasMergeCount": max(0, raw_entity_count - len(entities_by_label)),
        "gleaningRounds": completed_gleaning_rounds,
        "processedBatchCount": processed_batch_count,
        "successfulBatchCount": successful_batch_count,
        "failedBatchCount": len(failed_batch_errors),
        "failedBatchErrors": failed_batch_errors[:5],
    }


def _extract_llm_graph_batch(block_rows: list[dict], *, batch_index: int, total_batches: int) -> tuple[dict, dict]:
    messages = [
            {
                "role": "system",
                "content": (
                    "You are LLMGraphExtractionAgent for a source-grounded learning knowledge graph. "
                    "Follow a LightRAG-style chunk-first extraction process: extract entities and relationships "
                    "from the provided chunks only, then merge equivalent names into canonical entities. "
                    "Return one strict JSON object only, with no markdown fences, no comments, no explanation, and no trailing text. "
                    "Use exactly the top-level keys entities, relations, and claims. "
                    "Do not invent entities that are not supported by the provided chunks."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Extract material knowledge graph facts from batch {batch_index}/{total_batches} of parsed teaching-material chunks.\n"
                    f"Allowed entity_types: {', '.join(GRAPH_ENTITY_TYPES)}.\n"
                    f"Allowed relation_types: {', '.join(GRAPH_RELATION_TYPES)}.\n"
                    "Rules:\n"
                    "1. Every entity, relation, and claim must include evidenceBlockIds using the supplied blockId, chunkId, or chunkIndex.\n"
                    "2. Merge aliases and abbreviations into one canonical entity. Put alternate names in aliases and, when needed, canonicalLabel.\n"
                    "3. A relation must be grounded in the same or adjacent source blocks; otherwise omit it.\n"
                    "4. Prefer domain concepts, methods, formulas, metrics, systems, and prerequisite relations. Avoid generic words.\n"
                    "5. Keep summaries source-grounded and short.\n"
                    "6. Extract all source-grounded entities and relations you can find in this batch; do not keep only a tiny representative sample.\n"
                    "7. If two domain entities have an explicit definition, composition, scheduling, dependency, prerequisite, influence, or usage statement, include a relation.\n"
                    "8. Output must start with { and end with }. Do not output ```json, bullet lists, prose, or partial JSON.\n"
                    "9. If unsure, return empty arrays for that section, but keep valid JSON.\n"
                    "JSON schema: {\"entities\":[{\"label\":string,\"canonicalLabel\":string,\"aliases\":string[],\"type\":string,\"summary\":string,"
                    "\"confidence\":number,\"evidenceBlockIds\":string[]}],"
                    "\"relations\":[{\"source\":string,\"target\":string,\"type\":string,\"label\":string,"
                    "\"confidence\":number,\"evidenceBlockIds\":string[]}],"
                    "\"claims\":[{\"text\":string,\"entities\":string[],\"evidenceBlockIds\":string[]}]}.\n"
                    f"Blocks: {json.dumps(block_rows, ensure_ascii=False)}"
                ),
            },
        ]
    result = _graph_chat_completion(
        messages,
        temperature=0,
        max_tokens=int(os.getenv("A3_GRAPH_LLM_MAX_TOKENS", "4096")),
        timeout_seconds=float(os.getenv("A3_GRAPH_LLM_TIMEOUT_SECONDS", "3600")),
        response_format={"type": "json_object"},
    )
    content = str(result.get("content") or "")
    parsed = _normalize_graph_payload(_parse_json_object_from_model_text(content))
    if not parsed:
        repaired = _repair_graph_json_response(content, block_rows)
        result = {**result, **{key: repaired.get(key) for key in ("provider", "model") if repaired.get(key)}}
        parsed = _normalize_graph_payload(_parse_json_object_from_model_text(str(repaired.get("content") or "")))
    if not parsed:
        raise ValueError("LLM graph response is not valid JSON")
    return parsed, result


def _graph_llm_gleaning_rounds() -> int:
    try:
        raw = os.getenv("A3_GRAPH_LLM_GLEANING_ROUNDS")
        return max(0, min(int(raw), 2)) if raw not in {None, ""} else 2
    except ValueError:
        return 2


def _extract_llm_graph_gleaning(current_payload: dict, block_rows: list[dict], *, round_index: int) -> dict:
    result = _graph_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "You are LLMGraphExtractionAgent running a gleaning pass. "
                    "Find only missing source-grounded entities, relations, or claims from the same chunks. "
                    "Return strict JSON only and preserve evidenceBlockIds."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Gleaning round {round_index}: inspect the chunks again and add only missing graph facts. "
                    "Do not repeat existing rows unless adding aliases or evidence. "
                    "Use the same JSON schema with entities, relations, and claims.\n"
                    f"Current graph: {json.dumps(current_payload, ensure_ascii=False)[:6000]}\n"
                    f"Source chunks: {json.dumps(block_rows, ensure_ascii=False)}"
                ),
            },
        ],
        temperature=0,
        max_tokens=int(os.getenv("A3_GRAPH_LLM_GLEANING_MAX_TOKENS", "4096")),
        timeout_seconds=float(os.getenv("A3_GRAPH_LLM_TIMEOUT_SECONDS", "3600")),
        response_format={"type": "json_object"},
    )
    return _normalize_graph_payload(_parse_json_object_from_model_text(str(result.get("content") or "")))


def _merge_graph_extraction_payload(base: dict, addition: dict) -> dict:
    merged = {
        "entities": [*_dict_items(base.get("entities")), *_dict_items(addition.get("entities"))],
        "relations": [*_dict_items(base.get("relations")), *_dict_items(addition.get("relations"))],
        "claims": [*_dict_items(base.get("claims")), *_dict_items(addition.get("claims"))],
    }
    return merged


def _graph_payload_has_items(payload: dict) -> bool:
    return bool(_dict_items(payload.get("entities")) or _dict_items(payload.get("relations")) or _dict_items(payload.get("claims")))


def _normalize_graph_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {}
    graph = payload.get("graph") if isinstance(payload.get("graph"), dict) else payload
    entities = _dict_items(graph.get("entities") or graph.get("nodes") or graph.get("entityList") or graph.get("concepts"))
    relations = _dict_items(graph.get("relations") or graph.get("edges") or graph.get("relationList") or graph.get("relationships"))
    claims = _dict_items(graph.get("claims") or graph.get("facts") or graph.get("claimList"))
    if not entities and not relations and not claims:
        return payload
    return {
        "entities": [_normalize_graph_entity(item) for item in entities],
        "relations": [_normalize_graph_relation(item) for item in relations],
        "claims": [_normalize_graph_claim(item) for item in claims],
    }


def _normalize_graph_entity(item: dict) -> dict:
    label = item.get("label") or item.get("name") or item.get("title") or item.get("entity")
    summary = item.get("summary") or item.get("description") or item.get("definition") or item.get("text")
    canonical_label = item.get("canonicalLabel") or item.get("canonical") or item.get("canonicalName")
    return {
        **item,
        "label": label,
        "canonicalLabel": canonical_label,
        "aliases": item.get("aliases") or item.get("alias") or item.get("alternateNames") or [],
        "type": item.get("type") or item.get("entityType") or item.get("category") or "concept",
        "summary": summary or "",
        "confidence": item.get("confidence") or item.get("score") or 0.82,
        "evidenceBlockIds": item.get("evidenceBlockIds") or item.get("blockIds") or item.get("evidence") or item.get("sourceBlockIds") or [],
    }


def _normalize_graph_relation(item: dict) -> dict:
    label = item.get("label") or item.get("description") or item.get("relation") or item.get("relationType") or item.get("type")
    return {
        **item,
        "source": item.get("source") or item.get("from") or item.get("sourceEntity") or item.get("head") or item.get("subject"),
        "target": item.get("target") or item.get("to") or item.get("targetEntity") or item.get("tail") or item.get("object"),
        "type": item.get("type") or item.get("relationType") or item.get("relation") or "co_occurs",
        "label": label or "相关",
        "confidence": item.get("confidence") or item.get("weight") or item.get("score") or 0.78,
        "evidenceBlockIds": item.get("evidenceBlockIds") or item.get("blockIds") or item.get("evidence") or item.get("sourceBlockIds") or [],
    }


def _normalize_graph_claim(item: dict) -> dict:
    return {
        **item,
        "text": item.get("text") or item.get("claim") or item.get("fact") or item.get("description") or "",
        "entities": item.get("entities") or item.get("entityLabels") or item.get("entityNames") or [],
        "evidenceBlockIds": item.get("evidenceBlockIds") or item.get("blockIds") or item.get("evidence") or item.get("sourceBlockIds") or [],
    }


def _llm_block_rows(blocks: list[MaterialBlock]) -> list[dict]:
    return [
        {
            "chunkIndex": index + 1,
            "chunkId": f"chunk-{index + 1}",
            "blockId": block.block_id,
            "blockType": block.block_type,
            "location": block.location,
            "text": block.text[:LLM_GRAPH_TEXT_CHARS_PER_BLOCK],
            "confidence": block.confidence,
        }
        for index, block in enumerate(blocks)
    ]


def _chunk_list(items: list[dict], size: int) -> list[list[dict]]:
    if size <= 0:
        return [items]
    return [items[index : index + size] for index in range(0, len(items), size)] or [[]]


def _repair_graph_json_response(content: str, block_rows: list[dict]) -> dict:
    return _graph_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "You repair graph extraction output into one strict JSON object only. "
                    "Return no markdown, no comments, no explanation, and no trailing text. "
                    "If the original is truncated, salvage only complete supported entities, relations, and claims, and drop incomplete rows."
                ),
            },
            {
                "role": "user",
                "content": (
                    "The previous graph extraction response was not valid JSON. Convert it into this exact JSON schema: "
                    "{\"entities\":[{\"label\":string,\"canonicalLabel\":string,\"aliases\":string[],\"type\":string,\"summary\":string,\"confidence\":number,"
                    "\"evidenceBlockIds\":string[]}],\"relations\":[{\"source\":string,\"target\":string,"
                    "\"type\":string,\"label\":string,\"confidence\":number,\"evidenceBlockIds\":string[]}],"
                    "\"claims\":[{\"text\":string,\"entities\":string[],\"evidenceBlockIds\":string[]}]}.\n"
                    "Map common alternatives like nodes->entities, edges->relations, facts->claims, name->label, from->source, to->target, evidence->evidenceBlockIds.\n"
                    "If a field is missing, infer only from the original response or source blocks. Do not invent unsupported graph facts.\n"
                    f"Original response: {content[:6000]}\n"
                    f"Source blocks: {json.dumps(block_rows, ensure_ascii=False)}"
                ),
            },
        ],
        temperature=0,
        max_tokens=int(os.getenv("A3_GRAPH_LLM_REPAIR_MAX_TOKENS", "4096")),
        timeout_seconds=float(os.getenv("A3_GRAPH_LLM_TIMEOUT_SECONDS", "3600")),
        response_format={"type": "json_object"},
    )


def _graph_chat_completion(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    timeout_seconds: float,
    response_format: dict | None = None,
) -> dict:
    graph_env = {
        "A3_LLM_API_KEY": os.getenv("A3_GRAPH_LLM_API_KEY", ""),
        "A3_LLM_BASE_URL": os.getenv("A3_GRAPH_LLM_BASE_URL", ""),
        "A3_LLM_MODEL": os.getenv("A3_GRAPH_LLM_MODEL", ""),
    }
    previous: dict[str, str | None] = {}
    changed: list[str] = []
    for key, value in graph_env.items():
        if value:
            previous[key] = os.environ.get(key)
            os.environ[key] = value
            changed.append(key)
    try:
        return chat_completion(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout_seconds=timeout_seconds,
            response_format=response_format,
        )
    finally:
        for key in changed:
            old_value = previous.get(key)
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value


def _llm_block_lookup(blocks: list[MaterialBlock]) -> dict[str, MaterialBlock]:
    lookup: dict[str, MaterialBlock] = {}
    for index, block in enumerate(blocks, start=1):
        lookup[block.block_id] = block
        lookup[str(index)] = block
        lookup[f"chunk-{index}"] = block
    return lookup


def _resolve_llm_canonical_key(item: dict, normalized: str, aliases: list[str], entities_by_label: dict[str, dict]) -> str:
    canonical = normalize_label(str(item.get("canonicalLabel") or item.get("canonical") or ""))
    if canonical:
        return canonical
    alias_keys = {normalize_label(alias) for alias in aliases if normalize_label(alias)}
    for existing_key, payload in entities_by_label.items():
        existing_aliases = {normalize_label(alias) for alias in payload.get("aliases", []) if normalize_label(alias)}
        if normalized == existing_key or normalized in existing_aliases or existing_key in alias_keys or existing_aliases.intersection(alias_keys):
            return existing_key
    return normalized


def _merge_llm_entity(entities_by_label: dict[str, dict], canonical: str, payload: dict) -> None:
    existing = entities_by_label.get(canonical)
    aliases = _clean_aliases(payload.get("aliases") or [], payload["label"])
    if not existing:
        payload["aliases"] = aliases
        payload["source_locations"] = _dedupe_evidence(payload.get("source_locations") or [])
        entities_by_label[canonical] = payload
        return
    existing["confidence"] = max(float(existing.get("confidence") or 0), float(payload.get("confidence") or 0))
    if len(str(payload.get("summary") or "")) > len(str(existing.get("summary") or "")):
        existing["summary"] = payload.get("summary") or existing.get("summary", "")
    existing["aliases"] = _merge_aliases(existing.get("aliases") or [], aliases, existing.get("label", ""))
    existing["source_locations"] = _dedupe_evidence([*(existing.get("source_locations") or []), *(payload.get("source_locations") or [])])


def _resolve_llm_entity_reference(value: str, entities_by_label: dict[str, dict]) -> str:
    normalized = normalize_label(value)
    if not normalized:
        return ""
    if normalized in entities_by_label:
        return normalized
    for canonical, payload in entities_by_label.items():
        aliases = [normalize_label(alias) for alias in payload.get("aliases", [])]
        if normalized in aliases:
            return canonical
    return _nearest_entity(normalized, list(entities_by_label))


def _clean_aliases(values: list[str], canonical_label: str) -> list[str]:
    canonical = normalize_label(canonical_label)
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        alias = str(value or "").strip()[:160]
        key = normalize_label(alias)
        if not alias or not key or key == canonical or key in seen:
            continue
        seen.add(key)
        cleaned.append(alias)
    return cleaned[:12]


def _merge_aliases(existing: list[str], incoming: list[str], canonical_label: str) -> list[str]:
    return _clean_aliases([*existing, *incoming], canonical_label)


def _dedupe_evidence(items: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        key = str(item.get("blockId") or item.get("location") or item.get("snippet") or "")
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:5]


def _extract_entities(blocks: list[MaterialBlock]) -> dict[str, dict]:
    evidence_by_label: dict[str, list[dict]] = defaultdict(list)
    confidence_by_label: dict[str, list[float]] = defaultdict(list)
    counter: Counter[str] = Counter()
    for block in blocks:
        for term in _candidate_terms(block.text):
            normalized = normalize_label(term)
            if not normalized:
                continue
            counter[normalized] += 1
            if len(evidence_by_label[normalized]) < 5:
                evidence_by_label[normalized].append(block.evidence)
            confidence_by_label[normalized].append(block.confidence or 0.65)
    common = counter.most_common()
    return {
        normalized: {
            "label": _best_label(normalized, evidence_by_label[normalized]),
            "normalized_label": normalized,
            "entity_type": _entity_type(normalized),
            "summary": _summary_from_evidence(evidence_by_label[normalized]),
            "confidence": min(0.9, max(0.35, sum(confidence_by_label[normalized]) / max(len(confidence_by_label[normalized]), 1))),
            "source_locations": evidence_by_label[normalized],
            "aliases": [],
            "degraded": True,
            "extraction_method": METHOD,
        }
        for normalized, _ in common
    }


def _save_entities(resource: KnowledgeResource, entities_by_label: dict[str, dict]) -> dict[str, KnowledgeGraphEntity]:
    saved: dict[str, KnowledgeGraphEntity] = {}
    for normalized, payload in entities_by_label.items():
        entity = KnowledgeGraphEntity.objects.create(
            owner=resource.owner,
            resource=resource,
            label=payload["label"],
            normalized_label=normalized,
            entity_type=payload["entity_type"],
            aliases=payload.get("aliases") or [],
            summary=payload["summary"],
            confidence=payload["confidence"],
            source_count=len(payload["source_locations"]),
            source_locations=payload["source_locations"],
            degraded=bool(payload.get("degraded", True)),
            extraction_method=str(payload.get("extraction_method") or METHOD),
            schema_version=SCHEMA_VERSION,
        )
        saved[normalized] = entity
    return saved


def _extract_relations(blocks: list[MaterialBlock], entities: dict[str, KnowledgeGraphEntity]) -> list[dict]:
    return _extract_relation_candidates(blocks, list(entities))


def _extract_relation_candidates(blocks: list[MaterialBlock], labels: list[str]) -> list[dict]:
    rows: dict[tuple[str, str, str], dict] = {}
    for block in blocks:
        block_text = block.text
        for pattern, relation_type, label in RELATION_PATTERNS:
            for match in pattern.finditer(block_text):
                source = _nearest_entity(normalize_label(match.group("a")), labels)
                target = _nearest_entity(normalize_label(match.group("b")), labels)
                if source and target and source != target:
                    _add_relation(rows, source, target, relation_type, label, block)
        present = [label for label in labels if label in normalize_label(block_text)]
        for source, target in zip(present, present[1:4]):
            if source != target:
                _add_relation(rows, source, target, "co_occurs", "同块共现", block, weight=0.52)
    return list(rows.values())


def _add_relation(rows: dict, source: str, target: str, relation_type: str, label: str, block: MaterialBlock, *, weight: float = 0.72) -> None:
    key = (source, target, relation_type)
    row = rows.setdefault(
        key,
        {
            "source": source,
            "target": target,
            "relation_type": relation_type,
            "label": label,
            "weight": weight,
            "evidence": [],
        },
    )
    row["weight"] = min(0.95, max(float(row["weight"]), weight + len(row["evidence"]) * 0.04))
    if len(row["evidence"]) < 4:
        row["evidence"].append(block.evidence)


def _save_relations(resource: KnowledgeResource, relations: list[dict]) -> int:
    count = 0
    seen: set[tuple[str, str, str]] = set()
    entities = {entity.normalized_label: entity for entity in KnowledgeGraphEntity.objects.filter(resource=resource)}
    for relation in relations:
        source = entities.get(relation["source"])
        target = entities.get(relation["target"])
        if not source or not target:
            continue
        key = (str(source.id), str(target.id), str(relation["relation_type"]))
        if key in seen:
            continue
        seen.add(key)
        KnowledgeGraphRelation.objects.create(
            owner=resource.owner,
            resource=resource,
            source_entity=source,
            target_entity=target,
            relation_type=relation["relation_type"],
            label=relation["label"],
            weight=relation["weight"],
            evidence=relation["evidence"],
            degraded=bool(relation.get("degraded", True)),
            extraction_method=str(relation.get("extraction_method") or METHOD),
            schema_version=SCHEMA_VERSION,
        )
        count += 1
    return count


def _extract_claims(blocks: list[MaterialBlock], entities: dict[str, KnowledgeGraphEntity]) -> list[dict]:
    labels = list(entities)
    claims = _extract_claim_candidates(blocks, labels)
    return [
        {
            **claim,
            "entity_ids": [str(entities[label].id) for label in claim.get("entity_labels", []) if label in entities],
        }
        for claim in claims
    ]


def _extract_claim_candidates(blocks: list[MaterialBlock], labels: list[str]) -> list[dict]:
    rows: list[dict] = []
    for block in blocks:
        for sentence in _sentences(block.text):
            normalized_sentence = normalize_label(sentence)
            linked = [label for label in labels if label in normalized_sentence]
            if linked and _looks_like_claim(sentence):
                rows.append({"text": sentence[:500], "entity_labels": linked[:6], "evidence": [block.evidence]})
            if len(rows) >= 60:
                return rows
    return rows


def _save_claims_with_entities(resource: KnowledgeResource, claims: list[dict], entities: dict[str, KnowledgeGraphEntity]) -> int:
    resolved = [
        {
            **claim,
            "entity_ids": [str(entities[label].id) for label in claim.get("entity_labels", []) if label in entities],
        }
        for claim in claims
    ]
    return _save_claims(resource, resolved)


def _save_claims(resource: KnowledgeResource, claims: list[dict]) -> int:
    count = 0
    seen: set[str] = set()
    for claim in claims:
        normalized = normalize_label(claim["text"])
        if normalized in seen:
            continue
        seen.add(normalized)
        KnowledgeGraphClaim.objects.create(
            owner=resource.owner,
            resource=resource,
            text=claim["text"],
            entity_ids=claim["entity_ids"],
            verified=True,
            evidence=claim["evidence"],
            degraded=bool(claim.get("degraded", True)),
            extraction_method=str(claim.get("extraction_method") or METHOD),
            schema_version=SCHEMA_VERSION,
        )
        count += 1
    return count


def _graph_quality_metrics(
    saved_entities: dict[str, KnowledgeGraphEntity],
    relation_candidates: list[dict],
    claim_candidates: list[dict],
    saved_relation_count: int,
    saved_claim_count: int,
    graph_candidates: dict,
) -> dict:
    entity_count = len(saved_entities)
    connected_labels = {
        label
        for relation in relation_candidates
        for label in (relation.get("source"), relation.get("target"))
        if label in saved_entities
    }
    isolated_count = max(0, entity_count - len(connected_labels))
    evidence_total = entity_count + saved_relation_count + saved_claim_count
    evidence_bound = sum(1 for payload in saved_entities.values() if payload.source_locations)
    evidence_bound += sum(1 for relation in relation_candidates[:saved_relation_count] if relation.get("evidence"))
    evidence_bound += sum(1 for claim in claim_candidates[:saved_claim_count] if claim.get("evidence"))
    max_directed_edges = entity_count * (entity_count - 1)
    upstream_quality = graph_candidates.get("quality") if isinstance(graph_candidates.get("quality"), dict) else {}
    return {
        "isolatedEntityRate": _ratio(isolated_count, entity_count),
        "evidenceCoverage": _ratio(evidence_bound, evidence_total),
        "aliasMergeCount": int(upstream_quality.get("aliasMergeCount") or 0),
        "relationDensity": _ratio(saved_relation_count, max_directed_edges),
        "gleaningRounds": int(upstream_quality.get("gleaningRounds") or 0),
        "processedBatchCount": int(upstream_quality.get("processedBatchCount") or 0),
        "successfulBatchCount": int(upstream_quality.get("successfulBatchCount") or 0),
        "failedBatchCount": int(upstream_quality.get("failedBatchCount") or 0),
        "failedBatchErrors": _coerce_str_list(upstream_quality.get("failedBatchErrors"))[:5],
    }


def _ratio(value: int, total: int) -> float:
    return round(value / total, 4) if total else 0.0


def _visible_graph_quality(nodes: list[dict], edges: list[dict], claims: list[dict]) -> dict:
    entity_ids = {str(node.get("id")) for node in nodes if node.get("id")}
    connected_ids = {
        str(value)
        for edge in edges
        for value in (edge.get("source"), edge.get("target"))
        if value
    }
    evidence_total = len(nodes) + len(edges) + len(claims)
    evidence_bound = sum(1 for node in nodes if node.get("evidence"))
    evidence_bound += sum(1 for edge in edges if edge.get("evidence"))
    evidence_bound += sum(1 for claim in claims if claim.get("evidence"))
    max_directed_edges = len(nodes) * (len(nodes) - 1)
    return {
        "isolatedEntityRate": _ratio(len(entity_ids - connected_ids), len(entity_ids)),
        "evidenceCoverage": _ratio(evidence_bound, evidence_total),
        "aliasMergeCount": 0,
        "relationDensity": _ratio(len(edges), max_directed_edges),
        "gleaningRounds": 0,
    }


def _parse_json_object_from_model_text(content: str) -> dict:
    text = str(content or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
        text = re.sub(r"\s*```$", "", text).strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
    return {}


def _dict_items(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _coerce_str_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _coerce_confidence(value, *, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    if parsed > 1:
        parsed = parsed / 100
    return min(0.98, max(0.35, parsed))


def _evidence_for_llm_item(item: dict, block_by_id: dict[str, MaterialBlock], fallback_block: MaterialBlock | None, text_hint: str) -> list[dict]:
    evidence: list[dict] = []
    for block_id in _coerce_str_list(item.get("evidenceBlockIds") or item.get("blockIds")):
        block = block_by_id.get(block_id)
        if block:
            evidence.append(block.evidence)
    if not evidence:
        normalized_hint = normalize_label(text_hint)
        for block in block_by_id.values():
            if normalized_hint and normalized_hint in normalize_label(block.text):
                evidence.append(block.evidence)
                break
    if not evidence and fallback_block:
        evidence.append(fallback_block.evidence)
    return evidence[:4]


def _candidate_terms(text: str) -> list[str]:
    terms: list[str] = []
    terms.extend(re.findall(r"[A-Za-z][A-Za-z0-9_\- ]{2,32}", text))
    terms.extend(re.findall(r"[\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:模型|算法|方法|函数|系统|图|表|公式|结构|关系|路径|矩阵|向量|节点|知识点|调度|死锁|信号量|页表|文件系统)", text))
    terms.extend(re.findall(r"(?:操作系统|进程|线程|PCB|处理机调度|时间片轮转|死锁|银行家算法|信号量|PV操作|临界区|分页|分段|页表|虚拟内存|缺页中断|页面置换|FIFO|LRU|设备管理|文件系统|磁盘调度|SSTF|SCAN|知识图谱)", text))
    return [term.strip(" ：:，,。.;；（）()[]【】") for term in terms if _valid_term(term)]


def _sentences(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"[。！？!?；;\n]", text) if 8 <= len(item.strip()) <= 240]


def _looks_like_claim(sentence: str) -> bool:
    return any(marker in sentence for marker in ["是", "用于", "包括", "依赖", "影响", "决定", "表示", "描述", "计算"])


def _valid_term(term: str) -> bool:
    stripped = normalize_label(term)
    if len(stripped) < 2 or len(stripped) > 40:
        return False
    if stripped in STOP_TERMS:
        return False
    if stripped.isdigit():
        return False
    return True


def normalize_label(label: str) -> str:
    return re.sub(r"\s+", " ", str(label or "").strip().lower().strip(" ：:，,。.;；（）()[]【】"))


def _best_label(normalized: str, evidence: list[dict]) -> str:
    for item in evidence:
        snippet = str(item.get("snippet") or "")
        for match in re.finditer(re.escape(normalized), snippet, flags=re.IGNORECASE):
            return snippet[match.start() : match.end()] or normalized
    return normalized


def _entity_type(normalized: str) -> str:
    if any(token in normalized for token in ["公式", "函数", "矩阵", "向量"]):
        return "formula"
    if any(token in normalized for token in ["算法", "方法", "路径"]):
        return "method"
    if any(token in normalized for token in ["图", "表"]):
        return "visual"
    return "concept"


def _summary_from_evidence(evidence: list[dict]) -> str:
    if not evidence:
        return ""
    return str(evidence[0].get("snippet") or "")[:260]


def _nearest_entity(value: str, labels: list[str]) -> str:
    if value in labels:
        return value
    for label in labels:
        if value and (value in label or label in value):
            return label
    return ""


def _serialize_entity(entity: KnowledgeGraphEntity) -> dict:
    return {
        "id": str(entity.id),
        "label": entity.label,
        "type": entity.entity_type,
        "aliases": entity.aliases or [],
        "summary": _repair_display_text(entity.summary),
        "confidence": entity.confidence,
        "resourceIds": [str(entity.resource_id)],
        "sourceCount": entity.source_count,
        "evidence": _repair_evidence_list(entity.source_locations or []),
        "degraded": entity.degraded,
        "schemaVersion": entity.schema_version,
    }


def _serialize_relation(relation: KnowledgeGraphRelation) -> dict:
    return {
        "id": str(relation.id),
        "source": str(relation.source_entity_id),
        "target": str(relation.target_entity_id),
        "type": relation.relation_type,
        "label": relation.label,
        "weight": relation.weight,
        "evidence": _repair_evidence_list(relation.evidence or []),
        "degraded": relation.degraded,
        "schemaVersion": relation.schema_version,
    }


def _serialize_claim(claim: KnowledgeGraphClaim) -> dict:
    return {
        "id": str(claim.id),
        "text": _repair_display_text(claim.text),
        "entityIds": claim.entity_ids or [],
        "verified": claim.verified,
        "evidence": _repair_evidence_list(claim.evidence or []),
        "degraded": claim.degraded,
        "schemaVersion": claim.schema_version,
    }


def _repair_evidence_list(items: list[dict]) -> list[dict]:
    repaired: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        payload = dict(item)
        if payload.get("snippet"):
            payload["snippet"] = _repair_display_text(str(payload["snippet"]))
        if payload.get("markdownSnippet"):
            payload["markdownSnippet"] = _repair_display_text(str(payload["markdownSnippet"]))
        repaired.append(payload)
    return repaired


def _repair_display_text(value: str) -> str:
    return normalize_material_markdown(value).markdown


def _write_build_metadata(resource: KnowledgeResource, result: GraphBuildResult) -> None:
    parse_run = KnowledgeParseRun.objects.filter(resource=resource).order_by("-created_at").first()
    if not parse_run:
        return
    payload = parse_run.result if isinstance(parse_run.result, dict) else {}
    payload["materialGraph"] = {
        "schemaVersion": SCHEMA_VERSION,
        "workflow": result.workflow,
        "workflowSchemaVersion": result.workflow_schema_version,
        "traceId": result.trace_id,
        "status": result.status,
        "entityCount": result.entity_count,
        "relationCount": result.relation_count,
        "claimCount": result.claim_count,
        "degraded": result.degraded,
        "method": result.method,
        "quality": result.quality or {},
        "reason": result.reason,
        "builtAt": timezone.now().isoformat(),
    }
    parse_run.result = payload
    parse_run.save(update_fields=["result", "updated_at"])


def _latest_graph_build(resources) -> dict:
    latest = (
        KnowledgeParseRun.objects.filter(resource__in=resources, result__has_key="materialGraph")
        .aggregate(last=Max("updated_at"))
        .get("last")
    )
    if not latest:
        return {}
    parse_run = KnowledgeParseRun.objects.filter(resource__in=resources, result__has_key="materialGraph", updated_at=latest).first()
    if not parse_run or not isinstance(parse_run.result, dict):
        return {}
    material_graph = parse_run.result.get("materialGraph")
    if not isinstance(material_graph, dict):
        return {}
    return {
        "status": material_graph.get("status"),
        "lastBuiltAt": material_graph.get("builtAt"),
        "degraded": material_graph.get("degraded"),
        "reason": material_graph.get("reason"),
        "quality": material_graph.get("quality") if isinstance(material_graph.get("quality"), dict) else {},
    }


def _int_param(value, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default
