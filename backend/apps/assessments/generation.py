from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from django.db import transaction

from backend.apps.assessments.models import (
    Question,
    QuestionEvidence,
    QuestionGenerationJob,
    QuestionGenerationStatus,
    QuestionReviewStatus,
    QuestionSourceType,
    QuestionType,
)
from backend.apps.assessments.verification import verify_question
from backend.apps.compat.llm import LLMUnavailable, chat_completion
from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgeResource, ResourceScope
from backend.apps.knowledge_base.services import accessible_resources_for_user
from backend.apps.learning.models import KnowledgePoint


class QuestionGenerationRequestError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class EvidenceSnippet:
    resource: KnowledgeResource
    block_id: str
    page_number: int | None
    preview_url: str
    quote: str
    modality: str
    score: float


def create_question_generation_job(user, payload: dict) -> QuestionGenerationJob:
    scope = str(payload.get("scope") or ResourceScope.PERSONAL).strip() or ResourceScope.PERSONAL
    if not _is_teacher_or_admin(user) and scope != ResourceScope.PERSONAL:
        raise QuestionGenerationRequestError("学生只能生成我的资料练习题", status_code=403)
    if _is_teacher_or_admin(user) and scope not in {ResourceScope.TEACHER, ResourceScope.CLASS, ResourceScope.GLOBAL}:
        raise QuestionGenerationRequestError("教师只能生成教师、班级或全局题库", status_code=400)

    requested_count = _bounded_count(payload.get("count", payload.get("requestedCount", 5)))
    resource = _resolve_resource(user, payload.get("resourceId"))
    knowledge_point = _resolve_knowledge_point(payload.get("knowledgePointId"))
    if resource and scope == ResourceScope.PERSONAL and resource.owner_id != user.id:
        raise QuestionGenerationRequestError("不能基于其他用户的个人资料生成题目", status_code=403)
    return QuestionGenerationJob.objects.create(
        user=user,
        knowledge_point=knowledge_point,
        resource=resource,
        scope=scope,
        requested_count=requested_count,
    )


def run_question_generation_job(job: QuestionGenerationJob) -> QuestionGenerationJob:
    job.status = QuestionGenerationStatus.RUNNING
    job.error = ""
    job.save(update_fields=["status", "error", "updated_at"])
    if not _has_llm_key():
        return _fail_job(job, "未配置出题模型 API Key，请在后端 .env 配置 A3_LLM_API_KEY 或 DASHSCOPE_API_KEY")
    evidence = _collect_evidence(job)
    if not evidence:
        return _fail_job(job, "知识库中没有可用于出题的文本或视觉证据，请先完成多模态解析和索引")
    try:
        candidates = _call_question_llm(job, evidence)
    except Exception as exc:
        return _fail_job(job, f"出题模型调用失败：{exc}")
    generated = 0
    verified = 0
    rejected = 0
    with transaction.atomic():
        for candidate in candidates[: job.requested_count]:
            question = _create_candidate_question(job, candidate, evidence)
            generated += 1
            result = verify_question(question)
            if result.passed:
                verified += 1
            else:
                rejected += 1
        job.generated_count = generated
        job.verified_count = verified
        job.rejected_count = rejected
        job.status = QuestionGenerationStatus.SUCCEEDED if generated else QuestionGenerationStatus.FAILED
        if not generated:
            job.error = "模型没有返回可入库的题目"
        job.trace = {
            "evidenceCount": len(evidence),
            "verifiedCount": verified,
            "rejectedCount": rejected,
        }
        job.save(update_fields=[
            "generated_count",
            "verified_count",
            "rejected_count",
            "status",
            "error",
            "trace",
            "updated_at",
        ])
    return job


def serialize_question_generation_job(job: QuestionGenerationJob) -> dict:
    return {
        "id": str(job.id),
        "status": job.status,
        "scope": job.scope,
        "requestedCount": job.requested_count,
        "generatedCount": job.generated_count,
        "verifiedCount": job.verified_count,
        "rejectedCount": job.rejected_count,
        "error": job.error,
        "resourceId": str(job.resource_id) if job.resource_id else "",
        "knowledgePointId": str(job.knowledge_point_id) if job.knowledge_point_id else "",
        "createdAt": job.created_at.isoformat() if job.created_at else None,
        "updatedAt": job.updated_at.isoformat() if job.updated_at else None,
    }


def _bounded_count(value) -> int:
    try:
        return max(1, min(int(value), 20))
    except (TypeError, ValueError):
        raise QuestionGenerationRequestError("count 必须是 1 到 20 的整数", status_code=400)


def _resolve_resource(user, resource_id) -> KnowledgeResource | None:
    resource_id = str(resource_id or "").strip()
    if not resource_id:
        return None
    resource = accessible_resources_for_user(user).filter(id=resource_id).first()
    if not resource:
        raise QuestionGenerationRequestError("资源不存在或无权访问", status_code=404)
    return resource


def _resolve_knowledge_point(knowledge_point_id) -> KnowledgePoint | None:
    knowledge_point_id = str(knowledge_point_id or "").strip()
    if not knowledge_point_id:
        return None
    point = KnowledgePoint.objects.filter(id=knowledge_point_id).first()
    if not point:
        raise QuestionGenerationRequestError("知识点不存在", status_code=404)
    return point


def _is_teacher_or_admin(user) -> bool:
    return getattr(user, "role", "") in {"teacher", "admin"}


def _has_llm_key() -> bool:
    return bool((os.getenv("A3_LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip())


def _collect_evidence(job: QuestionGenerationJob) -> list[EvidenceSnippet]:
    if not job.resource_id:
        return []
    blocks = (
        KnowledgeBlock.objects.filter(resource=job.resource)
        .select_related("resource", "page", "asset")
        .exclude(text="")
        .order_by("-confidence", "created_at")[:8]
    )
    evidence: list[EvidenceSnippet] = []
    for block in blocks:
        text = str(block.text or block.markdown or "").strip()
        if not text:
            continue
        asset = block.asset or (block.page.assets.order_by("created_at").first() if block.page_id else None)
        preview_url = f"/api/kb/assets/{asset.id}/preview/" if asset else ""
        evidence.append(
            EvidenceSnippet(
                resource=block.resource,
                block_id=str(block.id),
                page_number=block.page.page_number if block.page else None,
                preview_url=preview_url,
                quote=text[:500],
                modality=block.modality,
                score=float(block.confidence or 0.5),
            )
        )
    return evidence


def _call_question_llm(job: QuestionGenerationJob, evidence: list[EvidenceSnippet]) -> list[dict]:
    point_title = job.knowledge_point.title if job.knowledge_point_id else "当前资料核心知识点"
    evidence_text = "\n\n".join(
        f"[{index}] {item.resource.original_name} p.{item.page_number or '-'} {item.modality}\n{item.quote}"
        for index, item in enumerate(evidence[:6], start=1)
    )
    result = chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "你是 A3 智学引擎的题库生成 Agent。只能基于给定证据出题，不能编造教材、页码或事实。"
                    "输出必须是 JSON，格式为 {\"questions\": [...]}。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"知识点：{point_title}\n"
                    f"题目数量：{job.requested_count}\n"
                    f"证据：\n{evidence_text}\n\n"
                    "请生成单选题。每题字段：stem, options([{key,text}]), correctAnswer, explanation, difficulty。"
                    "difficulty 为 1 到 5；explanation 必须说明答案依据。"
                ),
            },
        ],
        temperature=0.15,
        max_tokens=1800,
        timeout_seconds=20,
    )
    return _parse_question_json(str(result.get("content") or ""))


def _parse_question_json(content: str) -> list[dict]:
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMUnavailable("题目模型没有返回合法 JSON") from exc
    questions = data.get("questions") if isinstance(data, dict) else data
    if not isinstance(questions, list):
        raise LLMUnavailable("题目 JSON 缺少 questions 数组")
    return [item for item in questions if isinstance(item, dict)]


def _create_candidate_question(job: QuestionGenerationJob, candidate: dict, evidence: list[EvidenceSnippet]) -> Question:
    source_type = QuestionSourceType.PERSONAL_GENERATED if job.scope == ResourceScope.PERSONAL else QuestionSourceType.KB_GENERATED
    question = Question.objects.create(
        knowledge_point=job.knowledge_point or _fallback_knowledge_point(),
        stem=str(candidate.get("stem") or "").strip(),
        options=candidate.get("options") if isinstance(candidate.get("options"), list) else [],
        correct_answer=str(candidate.get("correctAnswer") or candidate.get("correct_answer") or "").strip().upper(),
        explanation=str(candidate.get("explanation") or "").strip(),
        difficulty=max(1, min(int(candidate.get("difficulty") or 2), 5)),
        question_type=QuestionType.SINGLE_CHOICE,
        source_type=source_type,
        review_status=QuestionReviewStatus.DRAFT,
        scope=job.scope,
        owner=job.user if job.scope == ResourceScope.PERSONAL else None,
        source_resource=job.resource,
        source_block_id=evidence[0].block_id if evidence else "",
        evidence_summary=evidence[0].quote[:500] if evidence else "",
        generation_job=job,
        is_active=False,
    )
    for item in evidence[:3]:
        QuestionEvidence.objects.create(
            question=question,
            resource=item.resource,
            block_id=item.block_id,
            page_number=item.page_number,
            preview_url=item.preview_url,
            quote=item.quote,
            modality=item.modality,
            score=item.score,
        )
    return question


def _fallback_knowledge_point() -> KnowledgePoint:
    point = KnowledgePoint.objects.order_by("chapter__order", "order").first()
    if not point:
        raise QuestionGenerationRequestError("系统中没有可绑定的知识点", status_code=400)
    return point


def _fail_job(job: QuestionGenerationJob, error: str) -> QuestionGenerationJob:
    job.status = QuestionGenerationStatus.FAILED
    job.error = error[:255]
    job.generated_count = 0
    job.verified_count = 0
    job.rejected_count = 0
    job.trace = {"error": job.error}
    job.save(update_fields=[
        "status",
        "error",
        "generated_count",
        "verified_count",
        "rejected_count",
        "trace",
        "updated_at",
    ])
    return job
