from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from django.db import transaction

from backend.apps.compat.llm import LLMUnavailable, chat_completion
from backend.apps.knowledge_base.models import (
    KnowledgeAlias,
    KnowledgeBlock,
    KnowledgeConcept,
    KnowledgeDefinition,
    KnowledgeGraphEntity,
    KnowledgeResource,
    KnowledgeSummary,
)


SCHEMA_VERSION = "a3.knowledge-wiki.v1"
RULE_METHOD = "rule_wiki"
LLM_METHOD = "llm_wiki"


@dataclass
class WikiBuildResult:
    status: str
    concept_count: int = 0
    definition_count: int = 0
    alias_count: int = 0
    summary_count: int = 0
    reason: str = ""


def rebuild_resource_wiki(resource: KnowledgeResource) -> WikiBuildResult:
    blocks = list(KnowledgeBlock.objects.filter(resource=resource).select_related("page").order_by("created_at"))
    entities = list(KnowledgeGraphEntity.objects.filter(resource=resource).order_by("-confidence", "label"))
    with transaction.atomic():
        _delete_resource_wiki(resource)
        candidates, build_reason, build_method = _build_concept_candidates(resource, blocks, entities)
        if not candidates:
            return WikiBuildResult(status="empty", reason="没有可沉淀为 Wiki 词条的概念证据")
        concepts: list[KnowledgeConcept] = []
        definition_count = 0
        alias_count = 0
        summary_count = 0
        for candidate in candidates[:80]:
            concept = KnowledgeConcept.objects.create(
                owner=resource.owner,
                resource=resource,
                preferred_label=candidate["label"],
                normalized_label=_normalize_label(candidate["label"]),
                concept_type=candidate.get("type") or "concept",
                summary=candidate.get("summary") or "",
                source_count=len(candidate.get("evidence") or []),
                evidence=candidate.get("evidence") or [],
                confidence=float(candidate.get("confidence") or 0.6),
                schema_version=SCHEMA_VERSION,
            )
            concepts.append(concept)
            definition = str(candidate.get("definition") or candidate.get("summary") or "").strip()
            if definition:
                KnowledgeDefinition.objects.create(
                    owner=resource.owner,
                    concept=concept,
                    resource=resource,
                    source_block=candidate.get("source_block"),
                    definition=definition[:2000],
                    evidence=candidate.get("evidence") or [],
                    confidence=float(candidate.get("confidence") or 0.6),
                )
                definition_count += 1
            aliases = [*_coerce_str_list(candidate.get("aliases")), *_aliases_for_label(candidate["label"])]
            seen_aliases: set[str] = set()
            for alias in aliases:
                normalized_alias = _normalize_label(alias)
                if not normalized_alias or normalized_alias in seen_aliases:
                    continue
                seen_aliases.add(normalized_alias)
                KnowledgeAlias.objects.create(
                    owner=resource.owner,
                    concept=concept,
                    alias=alias,
                    normalized_alias=normalized_alias,
                    evidence=candidate.get("evidence") or [],
                    confidence=float(candidate.get("confidence") or 0.65) if build_method == LLM_METHOD else 0.65,
                )
                alias_count += 1
            if candidate.get("summary"):
                KnowledgeSummary.objects.create(
                    owner=resource.owner,
                    concept=concept,
                    resource=resource,
                    title=f"{candidate['label']} 摘要",
                    summary=str(candidate["summary"])[:2000],
                    summary_type="concept",
                    evidence=candidate.get("evidence") or [],
                    confidence=float(candidate.get("confidence") or 0.6),
                )
                summary_count += 1
        return WikiBuildResult(
            status="ready",
            concept_count=len(concepts),
            definition_count=definition_count,
            alias_count=alias_count,
            summary_count=summary_count,
            reason=build_reason,
        )


def safe_rebuild_resource_wiki(resource: KnowledgeResource) -> WikiBuildResult:
    try:
        return rebuild_resource_wiki(resource)
    except Exception as exc:
        return WikiBuildResult(status="failed", reason=f"{type(exc).__name__}: {exc}"[:500])


def _delete_resource_wiki(resource: KnowledgeResource) -> None:
    KnowledgeAlias.objects.filter(concept__resource=resource).delete()
    KnowledgeDefinition.objects.filter(resource=resource).delete()
    KnowledgeSummary.objects.filter(resource=resource).delete()
    KnowledgeConcept.objects.filter(resource=resource).delete()


def _build_concept_candidates(
    resource: KnowledgeResource,
    blocks: list[KnowledgeBlock],
    entities: list[KnowledgeGraphEntity],
) -> tuple[list[dict], str, str]:
    if _wiki_llm_configured():
        try:
            candidates = _llm_concept_candidates(resource, blocks)
            if not candidates:
                raise ValueError("LLM returned no usable Wiki concepts")
            return candidates, "LLM Wiki extraction generated source-bound concept entries.", LLM_METHOD
        except Exception as exc:
            return (
                _concept_candidates(resource, blocks, entities),
                f"LLM Wiki extraction unavailable; using graph/rule fallback. {type(exc).__name__}: {exc}",
                RULE_METHOD,
            )
    return _concept_candidates(resource, blocks, entities), "已从资料图谱实体和解析文本沉淀结构化 Wiki 词条", RULE_METHOD


def _wiki_llm_configured() -> bool:
    return bool(
        (
            os.getenv("A3_WIKI_LLM_API_KEY")
            or os.getenv("A3_LLM_API_KEY")
            or os.getenv("DASHSCOPE_API_KEY")
            or os.getenv("OPENAI_API_KEY")
            or ""
        ).strip()
    )


def _llm_concept_candidates(resource: KnowledgeResource, blocks: list[KnowledgeBlock]) -> list[dict]:
    if not blocks:
        raise LLMUnavailable("no parsed blocks available for Wiki extraction")
    block_rows = [
        {
            "blockId": str(block.id),
            "location": _block_evidence(resource, block)["location"],
            "text": (block.text or block.markdown or "")[:1200],
            "confidence": block.confidence,
        }
        for block in blocks[:24]
        if (block.text or block.markdown or "").strip()
    ]
    if not block_rows:
        raise LLMUnavailable("no text blocks available for Wiki extraction")
    result = _wiki_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "You are A3 WikiExtractionAgent. Return strict JSON only. "
                    "Extract maintainable wiki concepts from the provided learning-material blocks. "
                    "Every concept must be grounded in source block ids; do not invent unsupported terms."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Extract concepts, definitions, aliases, disambiguation-ready summaries, and evidence.\n"
                    "JSON schema: {\"concepts\":[{\"label\":string,\"type\":string,\"definition\":string,"
                    "\"summary\":string,\"aliases\":string[],\"confidence\":number,\"evidenceBlockIds\":string[]}]}.\n"
                    f"Resource title: {resource.original_name}\n"
                    f"Blocks: {json.dumps(block_rows, ensure_ascii=False)}"
                ),
            },
        ],
        temperature=0,
        max_tokens=1600,
        timeout_seconds=float(os.getenv("A3_WIKI_LLM_TIMEOUT_SECONDS", "3600")),
        response_format={"type": "json_object"},
    )
    parsed = _parse_json_object_from_model_text(str(result.get("content") or ""))
    if not parsed:
        raise ValueError("LLM Wiki response is not valid JSON")
    block_by_id = {str(block.id): block for block in blocks}
    fallback_block = blocks[0]
    candidates: list[dict] = []
    seen: set[str] = set()
    for item in _dict_items(parsed.get("concepts"))[:80]:
        label = str(item.get("label") or "").strip()
        normalized = _normalize_label(label)
        if not normalized or normalized in seen or not _valid_label(label):
            continue
        evidence, source_block = _llm_evidence_for_item(resource, item, block_by_id, fallback_block)
        definition = str(item.get("definition") or "").strip()
        summary = str(item.get("summary") or definition).strip()
        if not definition and not summary:
            continue
        seen.add(normalized)
        candidates.append(
            {
                "label": label[:80],
                "type": str(item.get("type") or "concept")[:32],
                "definition": definition[:2000],
                "summary": summary[:2000],
                "aliases": _coerce_str_list(item.get("aliases"))[:12],
                "evidence": evidence,
                "confidence": _coerce_confidence(item.get("confidence"), default=0.82),
                "source_block": source_block,
            }
        )
    return candidates


def _llm_evidence_for_item(
    resource: KnowledgeResource,
    item: dict,
    block_by_id: dict[str, KnowledgeBlock],
    fallback_block: KnowledgeBlock,
) -> tuple[list[dict], KnowledgeBlock]:
    evidence_block_ids = _coerce_str_list(item.get("evidenceBlockIds") or item.get("evidence_block_ids"))
    evidence_blocks = [block_by_id[block_id] for block_id in evidence_block_ids if block_id in block_by_id]
    if not evidence_blocks:
        evidence_blocks = [fallback_block]
    return [_block_evidence(resource, block) for block in evidence_blocks[:5]], evidence_blocks[0]


def _wiki_chat_completion(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    timeout_seconds: float,
    response_format: dict | None = None,
) -> dict:
    wiki_env = {
        "A3_LLM_API_KEY": os.getenv("A3_WIKI_LLM_API_KEY", ""),
        "A3_LLM_BASE_URL": os.getenv("A3_WIKI_LLM_BASE_URL", ""),
        "A3_LLM_MODEL": os.getenv("A3_WIKI_LLM_MODEL", ""),
    }
    previous: dict[str, str | None] = {}
    changed: list[str] = []
    for key, value in wiki_env.items():
        if value and not os.getenv(key):
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


def _concept_candidates(resource: KnowledgeResource, blocks: list[KnowledgeBlock], entities: list[KnowledgeGraphEntity]) -> list[dict]:
    candidates: dict[str, dict] = {}
    for entity in entities:
        label = entity.label.strip()
        if not _valid_label(label):
            continue
        evidence = entity.source_locations or []
        candidates[_normalize_label(label)] = {
            "label": label,
            "type": entity.entity_type or "concept",
            "summary": entity.summary,
            "definition": entity.summary,
            "evidence": evidence,
            "confidence": entity.confidence or 0.6,
            "source_block": _block_from_evidence(resource, evidence),
        }
    for block in blocks:
        for item in _definition_candidates_from_block(resource, block):
            key = _normalize_label(item["label"])
            if not key or key in candidates:
                continue
            candidates[key] = item
    return list(candidates.values())


def _definition_candidates_from_block(resource: KnowledgeResource, block: KnowledgeBlock) -> list[dict]:
    text = (block.text or block.markdown or "").strip()
    if not text:
        return []
    rows: list[dict] = []
    patterns = [
        re.compile(r"(?P<label>[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,4})\s+(?:is|refers to|means)\s+(?P<definition>[^.。]{8,240})", re.I),
        re.compile(r"(?P<label>[\u4e00-\u9fa5A-Za-z0-9_\- ]{2,32})\s*(?:是|指|表示|定义为)\s*(?P<definition>[^。.\n]{8,240})"),
    ]
    for pattern in patterns:
        for match in pattern.finditer(text[:4000]):
            label = match.group("label").strip(" ：:，,。.")
            definition = f"{label} 是 {match.group('definition').strip(' ：:，,。.')}"
            if not _valid_label(label):
                continue
            evidence = [_block_evidence(resource, block)]
            rows.append(
                {
                    "label": label,
                    "type": "concept",
                    "summary": definition,
                    "definition": definition,
                    "evidence": evidence,
                    "confidence": max(block.confidence or 0.0, 0.65),
                    "source_block": block,
                }
            )
    return rows


def _block_evidence(resource: KnowledgeResource, block: KnowledgeBlock) -> dict:
    page = block.page
    if page and page.slide_number:
        location = f"PPT 第 {page.slide_number} 页"
    elif page and page.page_number:
        location = f"第 {page.page_number} 页"
    else:
        location = resource.original_name
    return {
        "resourceId": str(resource.id),
        "resourceTitle": resource.original_name,
        "blockId": str(block.id),
        "location": location,
        "snippet": (block.text or block.markdown or "")[:500],
        "confidence": block.confidence,
    }


def _block_from_evidence(resource: KnowledgeResource, evidence: list[dict]) -> KnowledgeBlock | None:
    if not evidence:
        return None
    block_id = str(evidence[0].get("blockId") or evidence[0].get("block_id") or "").strip()
    if not block_id:
        return None
    return KnowledgeBlock.objects.filter(resource=resource, id=block_id).first()


def _aliases_for_label(label: str) -> list[str]:
    if " " not in label:
        return []
    acronym = "".join(part[0].upper() for part in label.split() if part)
    return [acronym] if 2 <= len(acronym) <= 8 and acronym != label else []


def _valid_label(label: str) -> bool:
    if not 2 <= len(label) <= 80:
        return False
    return bool(re.search(r"[A-Za-z\u4e00-\u9fa5]", label))


def _normalize_label(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


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
