from __future__ import annotations

from dataclasses import dataclass
import re

from backend.apps.compat.safety import check_learning_safety


@dataclass(frozen=True)
class VerificationResult:
    answer: str
    citations: list[dict]
    verified: bool
    safety: dict
    refusalReason: str
    claims: list[dict]

    def as_dict(self) -> dict:
        return {
            "answer": self.answer,
            "citations": self.citations,
            "verified": self.verified,
            "safety": self.safety,
            "refusalReason": self.refusalReason,
            "claims": self.claims,
        }


def evidence_sources(sources: list[dict]) -> list[dict]:
    verified_sources = []
    for source in sources:
        source_type = str(source.get("type", "")).upper()
        has_evidence_text = any(str(source.get(field, "")).strip() for field in ("title", "snippet", "location"))
        display_type = str(source.get("type", ""))
        source_origin = str(source.get("sourceOrigin", ""))
        indexed_origin = any(label in source_origin for label in ("知识库索引", "教师上传索引", "全量知识库索引"))
        if source.get("score") is not None or source_type == "RAG" or (display_type.startswith("教师上传") and has_evidence_text) or (indexed_origin and has_evidence_text):
            verified_sources.append(source)
    return verified_sources


def verify_answer(question: str, answer: str, sources: list[dict]) -> VerificationResult:
    safety = check_learning_safety(f"{question}\n{answer}")
    if not safety.safe:
        return VerificationResult(
            answer="该问题触发学习安全策略，系统暂不提供回答。建议改为课程概念、例题解析或学习路径相关问题。",
            citations=[],
            verified=False,
            safety=safety.as_dict(),
            refusalReason=safety.reason,
            claims=[],
        )

    citations = evidence_sources(sources)
    if not citations:
        return VerificationResult(
            answer="当前没有可引用的知识库片段，系统暂不生成无来源答案。",
            citations=[],
            verified=False,
            safety=safety.as_dict(),
            refusalReason="missing_evidence",
            claims=_claim_verdicts(answer, []),
        )

    claims = _claim_verdicts(answer, citations)
    verified = all(claim["verified"] for claim in claims) if claims else True
    return VerificationResult(
        answer=answer,
        citations=citations,
        verified=verified,
        safety=safety.as_dict(),
        refusalReason="" if verified else "claim_not_supported",
        claims=claims,
    )


def _claim_verdicts(answer: str, citations: list[dict]) -> list[dict]:
    claims = _split_claims(answer)
    return [_verify_claim(claim, citations, index) for index, claim in enumerate(claims, start=1)]


def _split_claims(answer: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", str(answer or "")).strip()
    if not normalized:
        return []
    parts = re.split(r"(?<=[。！？!?；;])\s*", normalized)
    claims = [part.strip() for part in parts if part.strip()]
    return claims[:8]


def _verify_claim(claim: str, citations: list[dict], index: int) -> dict:
    claim_tokens = _tokens(claim)
    best = None
    best_overlap = 0
    for citation in citations:
        snippet = " ".join(str(citation.get(field, "")) for field in ("title", "snippet", "location"))
        overlap = len(claim_tokens.intersection(_tokens(snippet)))
        if overlap > best_overlap:
            best = citation
            best_overlap = overlap
    verified = bool(best and best_overlap >= 1)
    return {
        "id": f"claim-{index}",
        "text": claim,
        "verified": verified,
        "citation": best if verified else None,
        "overlap": best_overlap,
    }


def _tokens(text: str) -> set[str]:
    value = str(text or "").lower()
    tokens = set(re.findall(r"[a-z0-9]+", value))
    for chunk in re.findall(r"[\u4e00-\u9fff]{2,}", value):
        for size in range(2, min(4, len(chunk)) + 1):
            tokens.update(chunk[index:index + size] for index in range(0, len(chunk) - size + 1))
    return {token for token in tokens if len(token) >= 2}
