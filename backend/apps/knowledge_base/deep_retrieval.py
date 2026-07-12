from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from django.db.models import Q, QuerySet

from backend.apps.knowledge_base.models import (
    KnowledgeConcept,
    KnowledgeDefinition,
    KnowledgeGraphEntity,
    KnowledgeGraphRelation,
    KnowledgeResource,
)
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult


@dataclass
class RetrievalPlan:
    intent: str
    requested_route: str
    route: str
    reason: str
    sub_questions: list[str] = field(default_factory=list)
    fallback: bool = False
    fallback_reason: str = ""


@dataclass
class DeepRetrievalResult:
    plan: RetrievalPlan
    wiki_evidence: list[dict] = field(default_factory=list)
    graph_evidence: list[dict] = field(default_factory=list)
    result_items: list[KnowledgeBaseSearchResult] = field(default_factory=list)


DEFINITION_MARKERS = ("是什么", "什么是", "定义", "概念", "含义", "meaning", "definition", "what is")
GRAPH_MARKERS = ("关系", "影响", "导致", "依赖", "关联", "如何", "为什么", "区别", "联系", "between", "affect", "influence")


def run_deep_retrieval_router(
    query: str,
    resources: QuerySet[KnowledgeResource] | Iterable[KnowledgeResource],
    *,
    top_k: int,
    requested_route: str | None = None,
) -> DeepRetrievalResult:
    resource_list = list(resources)
    resource_ids = [resource.id for resource in resource_list]
    plan = plan_retrieval_route(query)
    if requested_route in {"wiki", "graph", "composite", "vector"}:
        plan.requested_route = requested_route
        plan.route = requested_route
        plan.reason = f"用户在检索配置中指定 {requested_route} 路由。"
    wiki_evidence = _search_wiki(query, resource_ids, top_k=top_k) if plan.requested_route in {"wiki", "composite"} else []
    graph_evidence = _search_graph(query, resource_ids, top_k=top_k) if plan.requested_route in {"graph", "composite"} else []

    route = plan.requested_route
    fallback = False
    fallback_reason = ""
    if route == "wiki" and not wiki_evidence:
        route = "vector"
        fallback = True
        fallback_reason = "没有可用的结构化 Wiki 词条证据，已降级到向量/关键词检索"
    elif route == "graph" and not graph_evidence:
        route = "vector"
        fallback = True
        fallback_reason = "没有可用的资料知识图谱证据，已降级到向量/关键词检索"
    elif route == "composite" and not wiki_evidence and not graph_evidence:
        route = "vector"
        fallback = True
        fallback_reason = "没有可用的 Wiki 或图谱证据，已降级到向量/关键词检索"
    elif route == "composite" and graph_evidence:
        route = "graph"
    elif route == "composite" and wiki_evidence:
        route = "wiki"

    plan.route = route
    plan.fallback = fallback
    plan.fallback_reason = fallback_reason
    return DeepRetrievalResult(
        plan=plan,
        wiki_evidence=wiki_evidence,
        graph_evidence=graph_evidence,
        result_items=[
            *_wiki_result_items(wiki_evidence if route == "wiki" else []),
            *_graph_result_items(graph_evidence if route == "graph" else []),
        ],
    )


def serialize_retrieval_plan(plan: RetrievalPlan) -> dict:
    return {
        "schemaVersion": "a3.deep-retrieval-router.v1",
        "intent": plan.intent,
        "requestedRoute": plan.requested_route,
        "route": plan.route,
        "reason": plan.reason,
        "subQuestions": plan.sub_questions,
        "fallback": plan.fallback,
        "fallbackReason": plan.fallback_reason,
    }


def plan_retrieval_route(query: str) -> RetrievalPlan:
    normalized = query.strip().lower()
    is_definition = any(marker in normalized for marker in DEFINITION_MARKERS)
    is_graph = any(marker in normalized for marker in GRAPH_MARKERS) or _looks_like_multi_entity_query(query)
    if is_definition and is_graph:
        return RetrievalPlan(
            intent="composite",
            requested_route="composite",
            route="composite",
            reason="问题同时包含定义和关系推理信号，优先组合 Wiki 与图谱证据。",
            sub_questions=_sub_questions(query),
        )
    if is_definition:
        return RetrievalPlan(
            intent="definition",
            requested_route="wiki",
            route="wiki",
            reason="问题在询问概念定义，优先检索结构化 Wiki 词条。",
            sub_questions=[],
        )
    if is_graph:
        return RetrievalPlan(
            intent="multi_hop",
            requested_route="graph",
            route="graph",
            reason="问题包含关系、多跳或影响分析信号，优先检索资料知识图谱。",
            sub_questions=_sub_questions(query),
        )
    return RetrievalPlan(
        intent="fact",
        requested_route="vector",
        route="vector",
        reason="问题是普通事实检索，优先使用向量/关键词证据。",
        sub_questions=[],
    )


def _looks_like_multi_entity_query(query: str) -> bool:
    if " 和 " in query or "与" in query or "->" in query:
        return True
    latin_terms = re.findall(r"[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*", query)
    return len([term for term in latin_terms if len(term.strip()) >= 2]) >= 2


def _sub_questions(query: str) -> list[str]:
    terms = _query_terms(query)
    if len(terms) >= 2:
        return [
            f"{terms[0]} 的来源证据是什么？",
            f"{terms[-1]} 的来源证据是什么？",
            f"{terms[0]} 和 {terms[-1]} 之间有什么关系？",
        ]
    return [f"{query.strip()} 的关键实体是什么？", f"{query.strip()} 是否有图谱关系证据？"]


def _search_wiki(query: str, resource_ids: list, *, top_k: int) -> list[dict]:
    terms = _query_terms(query)
    concept_filter = Q()
    for term in terms:
        concept_filter |= Q(preferred_label__icontains=term) | Q(normalized_label__icontains=_normalize_label(term)) | Q(summary__icontains=term)
    if not concept_filter:
        concept_filter = Q(preferred_label__icontains=query[:80]) | Q(summary__icontains=query[:80])
    concepts = (
        KnowledgeConcept.objects.filter(resource_id__in=resource_ids)
        .filter(concept_filter)
        .select_related("resource")
        .prefetch_related("definitions", "aliases", "summaries")
        .order_by("-confidence", "preferred_label")[:top_k]
    )
    return [_serialize_wiki_concept(concept) for concept in concepts]


def _search_graph(query: str, resource_ids: list, *, top_k: int) -> list[dict]:
    path_evidence = _search_graph_paths(query, resource_ids, top_k=top_k)
    if path_evidence:
        return path_evidence

    terms = _query_terms(query)
    relation_filter = Q()
    for term in terms:
        relation_filter |= (
            Q(source_entity__label__icontains=term)
            | Q(target_entity__label__icontains=term)
            | Q(label__icontains=term)
            | Q(evidence__icontains=term)
        )
    if not relation_filter:
        relation_filter = Q(label__icontains=query[:80]) | Q(evidence__icontains=query[:80])
    relations = (
        KnowledgeGraphRelation.objects.filter(resource_id__in=resource_ids)
        .filter(relation_filter)
        .select_related("resource", "source_entity", "target_entity")
        .order_by("-weight", "label")[:top_k]
    )
    return [_serialize_graph_relation(relation) for relation in relations]


def _search_graph_paths(query: str, resource_ids: list, *, top_k: int) -> list[dict]:
    relations = list(
        KnowledgeGraphRelation.objects.filter(resource_id__in=resource_ids)
        .select_related("resource", "source_entity", "target_entity")
        .order_by("-weight", "label")[:500]
    )
    if not relations:
        return []

    query_norm = _normalize_label(query)
    anchors = _rank_query_entities(query_norm, relations)
    if not anchors:
        return []
    anchor_ids = [entity.id for entity, score in anchors if score > 0]
    paths = _candidate_graph_paths(relations, anchor_ids)
    if not paths:
        return []

    scored = []
    anchor_scores = {entity.id: score for entity, score in anchors}
    for path in paths:
        nodes = _path_nodes(path)
        start_score = anchor_scores.get(nodes[0].id, 0.0)
        end_score = anchor_scores.get(nodes[-1].id, 0.0)
        if not start_score or not end_score:
            continue
        relation_weight = sum(max(relation.weight or 0.0, 0.0) for relation, _forward in path) / len(path)
        entity_confidence = sum(max(node.confidence or 0.0, 0.0) for node in nodes) / len(nodes)
        evidence_coverage = _path_evidence_coverage(path)
        bridge_bonus = 0.35 if len(path) > 1 else 0.0
        order_bonus = 0.5 if _entity_query_position(nodes[0], query_norm) <= _entity_query_position(nodes[-1], query_norm) else -0.5
        score = start_score + end_score + relation_weight + entity_confidence + evidence_coverage + bridge_bonus + order_bonus
        scored.append((score, path))

    scored.sort(key=lambda item: (-item[0], len(item[1])))
    return [_serialize_graph_path(path, score) for score, path in scored[:top_k]]


def _rank_query_entities(query_norm: str, relations: list[KnowledgeGraphRelation]) -> list[tuple[KnowledgeGraphEntity, float]]:
    entities: dict[str, KnowledgeGraphEntity] = {}
    for relation in relations:
        entities[str(relation.source_entity_id)] = relation.source_entity
        entities[str(relation.target_entity_id)] = relation.target_entity

    ranked: list[tuple[KnowledgeGraphEntity, float]] = []
    for entity in entities.values():
        score = _entity_query_score(entity, query_norm)
        if score > 0:
            ranked.append((entity, score))
    ranked.sort(key=lambda item: (-item[1], -item[0].confidence, item[0].label))
    return ranked[:8]


def _entity_query_score(entity: KnowledgeGraphEntity, query_norm: str) -> float:
    label = _normalize_label(entity.label)
    if not label:
        return 0.0
    aliases = [_normalize_label(str(alias)) for alias in (entity.aliases or []) if str(alias).strip()]
    names = [label, *aliases]
    for name in names:
        if name and name in query_norm:
            return 3.0 + min(max(entity.confidence or 0.0, 0.0), 1.0)
    label_tokens = [token for token in re.split(r"\s+", label) if len(token) >= 2]
    if label_tokens and all(token in query_norm for token in label_tokens):
        return 2.0 + min(max(entity.confidence or 0.0, 0.0), 1.0)
    if any(len(token) >= 4 and token in query_norm for token in label_tokens):
        return 0.75 + min(max(entity.confidence or 0.0, 0.0), 1.0) * 0.5
    return 0.0


def _entity_query_position(entity: KnowledgeGraphEntity, query_norm: str) -> int:
    positions = []
    for name in [_normalize_label(entity.label), *[_normalize_label(str(alias)) for alias in (entity.aliases or [])]]:
        if name:
            position = query_norm.find(name)
            if position >= 0:
                positions.append(position)
    return min(positions) if positions else len(query_norm) + 1


def _candidate_graph_paths(
    relations: list[KnowledgeGraphRelation],
    anchor_ids: list,
) -> list[list[tuple[KnowledgeGraphRelation, bool]]]:
    adjacency: dict[str, list[tuple[KnowledgeGraphRelation, bool, str]]] = {}
    for relation in relations:
        source_id = str(relation.source_entity_id)
        target_id = str(relation.target_entity_id)
        adjacency.setdefault(source_id, []).append((relation, True, target_id))
        adjacency.setdefault(target_id, []).append((relation, False, source_id))

    paths: list[list[tuple[KnowledgeGraphRelation, bool]]] = []
    anchor_keys = [str(entity_id) for entity_id in anchor_ids]
    anchor_key_set = set(anchor_keys)
    for start_id in anchor_keys:
        for relation, forward, next_id in adjacency.get(start_id, []):
            if next_id in anchor_key_set and next_id != start_id:
                paths.append([(relation, forward)])
            for second_relation, second_forward, end_id in adjacency.get(next_id, []):
                if end_id == start_id or end_id not in anchor_key_set:
                    continue
                if str(second_relation.id) == str(relation.id):
                    continue
                paths.append([(relation, forward), (second_relation, second_forward)])
    return _dedupe_paths(paths)


def _dedupe_paths(paths: list[list[tuple[KnowledgeGraphRelation, bool]]]) -> list[list[tuple[KnowledgeGraphRelation, bool]]]:
    deduped: list[list[tuple[KnowledgeGraphRelation, bool]]] = []
    seen: set[tuple[str, ...]] = set()
    for path in paths:
        nodes = _path_nodes(path)
        key = tuple(str(node.id) for node in nodes)
        reverse_key = tuple(reversed(key))
        relation_key = tuple(str(relation.id) for relation, _forward in path)
        full_key = (*key, *relation_key)
        if full_key in seen or (*reverse_key, *reversed(relation_key)) in seen:
            continue
        seen.add(full_key)
        deduped.append(path)
    return deduped


def _path_nodes(path: list[tuple[KnowledgeGraphRelation, bool]]) -> list[KnowledgeGraphEntity]:
    nodes: list[KnowledgeGraphEntity] = []
    for index, (relation, forward) in enumerate(path):
        source = relation.source_entity if forward else relation.target_entity
        target = relation.target_entity if forward else relation.source_entity
        if index == 0:
            nodes.append(source)
        nodes.append(target)
    return nodes


def _path_evidence_coverage(path: list[tuple[KnowledgeGraphRelation, bool]]) -> float:
    if not path:
        return 0.0
    evidence_edges = sum(1 for relation, _forward in path if relation.evidence)
    return evidence_edges / len(path)


def _serialize_graph_path(path: list[tuple[KnowledgeGraphRelation, bool]], score: float) -> dict:
    nodes = _path_nodes(path)
    relations = [_serialize_oriented_graph_relation(relation, forward) for relation, forward in path]
    evidence = _dedupe_evidence([evidence for item in relations for evidence in item.get("evidence", [])])
    first_relation = path[0][0]
    return {
        "id": "path:" + ":".join(str(relation.id) for relation, _forward in path),
        "sourceId": str(nodes[0].id),
        "targetId": str(nodes[-1].id),
        "sourceLabel": nodes[0].label,
        "targetLabel": nodes[-1].label,
        "relationType": "path" if len(path) > 1 else relations[0]["relationType"],
        "label": " -> ".join(item["label"] for item in relations),
        "weight": score,
        "pathScore": score,
        "hops": len(path),
        "pathLabels": [node.label for node in nodes],
        "path": [{"id": str(node.id), "label": node.label, "type": node.entity_type} for node in nodes],
        "relations": relations,
        "evidence": evidence,
        "evidenceCoverage": _path_evidence_coverage(path),
        "resourceId": str(first_relation.resource_id),
        "resourceTitle": first_relation.resource.original_name,
        "degraded": any(relation.degraded for relation, _forward in path),
    }


def _serialize_oriented_graph_relation(relation: KnowledgeGraphRelation, forward: bool) -> dict:
    item = _serialize_graph_relation(relation)
    if forward:
        return item
    return {
        **item,
        "sourceId": item["targetId"],
        "targetId": item["sourceId"],
        "sourceLabel": item["targetLabel"],
        "targetLabel": item["sourceLabel"],
    }


def _dedupe_evidence(items: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("resourceId") or item.get("resource_id") or ""),
            str(item.get("blockId") or item.get("block_id") or ""),
            str(item.get("snippet") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _query_terms(query: str) -> list[str]:
    cleaned = query.strip()
    latin_terms = [term.strip() for term in re.findall(r"[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*)*", cleaned)]
    cjk_terms = [
        term.strip()
        for term in re.split(r"[，。？！、\s]+|是什么|什么是|定义|概念|含义|关系|影响|如何|为什么|之间|和|与", cleaned)
        if 2 <= len(term.strip()) <= 30 and not re.search(r"[A-Za-z]", term)
    ]
    seen: set[str] = set()
    terms: list[str] = []
    for term in [*latin_terms, *cjk_terms]:
        key = _normalize_label(term)
        if key and key not in seen:
            seen.add(key)
            terms.append(term)
    return terms[:6]


def _normalize_label(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _serialize_wiki_concept(concept: KnowledgeConcept) -> dict:
    definitions = [
        {
            "id": str(item.id),
            "definition": item.definition,
            "blockId": str(item.source_block_id) if item.source_block_id else "",
            "confidence": item.confidence,
            "evidence": item.evidence or [],
        }
        for item in concept.definitions.all()[:3]
    ]
    aliases = [item.alias for item in concept.aliases.all()[:8]]
    summaries = [
        {"id": str(item.id), "title": item.title, "summary": item.summary, "type": item.summary_type}
        for item in concept.summaries.all()[:3]
    ]
    evidence = concept.evidence or (definitions[0]["evidence"] if definitions else [])
    return {
        "id": str(concept.id),
        "schemaVersion": concept.schema_version,
        "preferredLabel": concept.preferred_label,
        "normalizedLabel": concept.normalized_label,
        "type": concept.concept_type,
        "summary": concept.summary,
        "aliases": aliases,
        "definitions": definitions,
        "summaries": summaries,
        "evidence": evidence,
        "resourceId": str(concept.resource_id),
        "resourceTitle": concept.resource.original_name,
        "confidence": concept.confidence,
    }


def _serialize_graph_relation(relation: KnowledgeGraphRelation) -> dict:
    evidence = relation.evidence or []
    return {
        "id": str(relation.id),
        "sourceId": str(relation.source_entity_id),
        "targetId": str(relation.target_entity_id),
        "sourceLabel": relation.source_entity.label,
        "targetLabel": relation.target_entity.label,
        "relationType": relation.relation_type,
        "label": relation.label,
        "weight": relation.weight,
        "evidence": evidence,
        "resourceId": str(relation.resource_id),
        "resourceTitle": relation.resource.original_name,
        "degraded": relation.degraded,
    }


def _wiki_result_items(items: list[dict]) -> list[KnowledgeBaseSearchResult]:
    results: list[KnowledgeBaseSearchResult] = []
    for item in items:
        definition = item["definitions"][0]["definition"] if item.get("definitions") else item.get("summary", "")
        evidence = _first_evidence(item.get("evidence") or [])
        metadata = _evidence_metadata(item, evidence, retriever="wiki")
        metadata["title"] = item["preferredLabel"]
        metadata["wiki_concept_id"] = item["id"]
        results.append(KnowledgeBaseSearchResult(score=item.get("confidence") or 0.0, text=definition, metadata=metadata))
    return results


def _graph_result_items(items: list[dict]) -> list[KnowledgeBaseSearchResult]:
    results: list[KnowledgeBaseSearchResult] = []
    for item in items:
        evidence = _first_evidence(item.get("evidence") or [])
        text = f"{item['sourceLabel']} {item['label']} {item['targetLabel']}"
        if evidence.get("snippet"):
            text = f"{text}。{evidence['snippet']}"
        metadata = _evidence_metadata(item, evidence, retriever="graph")
        metadata["title"] = f"{item['sourceLabel']} -> {item['targetLabel']}"
        metadata["graph_relation_id"] = item["id"]
        results.append(KnowledgeBaseSearchResult(score=item.get("weight") or 0.0, text=text, metadata=metadata))
    return results


def _first_evidence(evidence: list[dict]) -> dict:
    return evidence[0] if evidence and isinstance(evidence[0], dict) else {}


def _evidence_metadata(item: dict, evidence: dict, *, retriever: str) -> dict:
    metadata = {
        "retriever": retriever,
        "resource_id": item.get("resourceId") or evidence.get("resourceId") or "",
        "original_name": item.get("resourceTitle") or evidence.get("resourceTitle") or "",
        "block_id": evidence.get("blockId") or "",
        "location": evidence.get("location") or "",
        "source_scope": evidence.get("sourceScope") or "",
    }
    source_path = evidence.get("sourcePath") or evidence.get("source_path") or ""
    if source_path:
        metadata["source_path"] = str(Path(source_path).resolve())
    return metadata
