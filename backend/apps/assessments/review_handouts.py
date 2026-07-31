from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import uuid
from collections import defaultdict
from io import BytesIO
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Inches, Pt
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

from backend.apps.assessments.models import ReviewHandoutJob
from backend.apps.assessments.wrong_exports import (
    WrongExportRequestError,
    build_wrong_question_snapshot,
    select_wrong_questions,
)
from backend.domains.knowledge_base.retriever import search_knowledge_base


ACTIVE_JOB_STATUSES = {"queued", "running"}
TERMINAL_JOB_STATUSES = {"succeeded", "failed", "cancelled"}
logger = logging.getLogger(__name__)


class ReviewHandoutCancelled(Exception):
    pass


def create_snapshot(user, scope: str) -> dict:
    items = list(select_wrong_questions(user, scope))
    if not items:
        raise WrongExportRequestError("当前范围没有可生成讲义的错题")
    snapshot = build_wrong_question_snapshot(user, scope, items)
    profile = getattr(user, "learner_profile", None)
    weak_points = profile.weak_points if profile and isinstance(profile.weak_points, list) else []
    snapshot["profileWeakPoints"] = [str(item).strip()[:128] for item in weak_points if str(item).strip()][:20]
    return snapshot


def rank_weak_points(snapshot: dict) -> list[dict]:
    now = timezone.now()
    profile_points = set(snapshot.get("profileWeakPoints") or [])
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in snapshot.get("questions") or []:
        point = str(row.get("knowledgePoint") or "未分类")
        grouped[point].append(row)
    ranked = []
    for point, rows in grouped.items():
        active_count = sum(1 for row in rows if not row.get("mastered"))
        wrong_count = sum(max(0, int(row.get("wrongCount") or 0)) for row in rows)
        due_count = sum(1 for row in rows if _is_due(row.get("reviewAfter"), now))
        profile_matched = point in profile_points
        recency = max((_recency_score(row.get("lastWrongAt"), now) for row in rows), default=0)
        score = round(active_count * 20 + wrong_count * 8 + due_count * 15 + recency + (18 if profile_matched else 0), 2)
        ranked.append({
            "knowledgePoint": point,
            "activeCount": active_count,
            "wrongCount": wrong_count,
            "dueCount": due_count,
            "profileMatched": profile_matched,
            "score": score,
            "questionIds": [row.get("wrongQuestionId") for row in rows],
        })
    return sorted(ranked, key=lambda item: (-item["score"], item["knowledgePoint"]))[:12]


@transaction.atomic
def create_review_handout_job(user, scope: str) -> tuple[ReviewHandoutJob, bool]:
    snapshot = create_snapshot(user, scope)
    digest_payload = {key: value for key, value in snapshot.items() if key != "generatedAt"}
    snapshot_hash = hashlib.sha256(
        json.dumps(digest_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    existing = ReviewHandoutJob.objects.select_for_update().filter(
        user=user,
        scope=snapshot["scope"],
        snapshot_hash=snapshot_hash,
        status__in=ACTIVE_JOB_STATUSES,
    ).first()
    if existing:
        return existing, False
    job = ReviewHandoutJob.objects.create(
        user=user,
        scope=snapshot["scope"],
        snapshot_hash=snapshot_hash,
        snapshot=snapshot,
        ranked_weak_points=rank_weak_points(snapshot),
        status="queued",
        stage="queued",
        message="复习讲义已进入生成队列",
    )
    return job, True


def serialize_review_handout_job(job: ReviewHandoutJob) -> dict:
    base = f"/api/assessments/wrong-questions/review-handouts/{job.id}"
    payload = {
        "jobId": str(job.id),
        "scope": job.scope,
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "message": job.message,
        "snapshotId": job.snapshot_hash[:16],
        "traceId": job.trace_id,
        "citations": job.citations if isinstance(job.citations, list) else [],
        "verified": job.verified,
        "degraded": job.degraded,
        "error": job.error_message if job.status == "failed" else "",
        "createdAt": job.created_at.isoformat(),
        "updatedAt": job.updated_at.isoformat(),
    }
    if job.status == "succeeded" and job.docx_path:
        payload["docxDownloadUrl"] = f"{base}/download/docx/"
    if job.status == "succeeded" and job.pdf_path:
        payload["pdfDownloadUrl"] = f"{base}/download/pdf/"
    return payload


def generate_review_handout(job_id: str) -> dict:
    job = ReviewHandoutJob.objects.select_related("user").get(id=job_id)
    if job.status == "cancelled":
        return {"success": False, "cancelled": True}
    if job.status == "succeeded":
        return {"success": True, "jobId": str(job.id)}
    artifact_dir = _artifact_directory(job)
    try:
        _save_job(job, status="running", progress=10, stage="retrieval", message="正在检索本地课程资料", started_at=job.started_at or timezone.now())
        chapters, citations, degraded = _build_handout_chapters(job)
        _save_job(job, progress=55, stage="document", message="正在整理讲义章节与练习")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        docx_path = artifact_dir / "review-handout.docx"
        pdf_path = artifact_dir / "review-handout.pdf"
        _atomic_write(docx_path, _build_handout_docx(job.snapshot, chapters, citations, degraded))
        _atomic_write(pdf_path, _build_handout_pdf(job.snapshot, chapters, citations, degraded))
        _save_job(
            job,
            status="succeeded",
            progress=100,
            stage="completed",
            message="资料检索暂不可用，已根据可信题目解析生成复习提纲" if degraded else "复习讲义已生成并完成引用核验",
            citations=citations,
            verified=bool(citations) and not degraded,
            degraded=degraded,
            docx_path=str(docx_path),
            pdf_path=str(pdf_path),
            trace_id=job.trace_id or uuid.uuid4().hex,
            error_message="",
            finished_at=timezone.now(),
        )
        return {"success": True, "jobId": str(job.id)}
    except ReviewHandoutCancelled:
        shutil.rmtree(artifact_dir, ignore_errors=True)
        return {"success": False, "cancelled": True}
    except Exception as exc:
        logger.exception("Review handout generation failed", extra={"review_handout_job_id": str(job.id)})
        shutil.rmtree(artifact_dir, ignore_errors=True)
        message = "复习讲义生成失败，请稍后重试。"
        try:
            _save_job(job, status="failed", progress=100, stage="failed", message=message, error_message=message, finished_at=timezone.now())
        except ReviewHandoutCancelled:
            return {"success": False, "cancelled": True}
        return {"success": False, "error": message}


def _build_handout_chapters(job: ReviewHandoutJob) -> tuple[list[dict], list[dict], bool]:
    rows_by_point = defaultdict(list)
    for row in job.snapshot.get("questions") or []:
        rows_by_point[str(row.get("knowledgePoint") or "未分类")].append(row)
    citations = []
    chapters = []
    retrieval_failed = False
    for weakness in job.ranked_weak_points[:8]:
        point = weakness["knowledgePoint"]
        evidence = []
        try:
            results = search_knowledge_base(query=f"{point} 核心概念 常见错误", top_k=3)
            for result in results[:3]:
                metadata = result.metadata if isinstance(result.metadata, dict) else {}
                citation = {
                    "knowledgePoint": point,
                    "title": str(metadata.get("title") or metadata.get("source_name") or "课程资料")[:255],
                    "location": _citation_location(metadata),
                    "snippet": str(result.text or "").strip()[:600],
                    "score": round(float(result.score or 0), 4),
                    "verified": bool(str(result.text or "").strip()),
                }
                if citation["snippet"]:
                    evidence.append(citation)
                    citations.append(citation)
        except Exception:
            retrieval_failed = True
        questions = rows_by_point[point]
        core = evidence[0]["snippet"] if evidence else "；".join(row["explanation"] for row in questions[:3])
        chapters.append({
            "knowledgePoint": point,
            "score": weakness["score"],
            "coreConcept": core or f"围绕{point}复习定义、适用条件与判断步骤。",
            "prerequisites": f"先确认{point}涉及的基本定义、条件与符号含义。",
            "errorPatterns": [row["errorCause"] for row in questions[:5]],
            "questions": questions[:8],
            "checklist": ["先识别题目考查的核心概念", "逐项核对适用条件", "作答后反向检查结论"],
            "variants": [_variant_for(row, index) for index, row in enumerate(questions[:3], start=1)],
            "advice": f"优先重练{len(questions)}道关联错题；完成后在错题本连续答对两次。",
            "citations": evidence,
        })
    degraded = retrieval_failed or not citations
    return chapters, citations[:24], degraded


def _variant_for(row: dict, index: int) -> dict:
    return {
        "prompt": f"变式 {index}：改变题目情境后，重新判断下列问题：{row['stem']}",
        "answer": row["correctAnswer"],
        "explanation": row["explanation"],
    }


def _build_handout_docx(snapshot: dict, chapters: list[dict], citations: list[dict], degraded: bool) -> bytes:
    document = Document()
    section = document.sections[0]
    section.top_margin = Inches(0.65)
    section.bottom_margin = Inches(0.65)
    for name, size in (("Normal", 10.5), ("Heading 1", 16), ("Heading 2", 12)):
        style = document.styles[name]
        style.font.name = "Microsoft YaHei"
        style.font.size = Pt(size)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    title = document.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title.add_run("个性化复习讲义")
    title_run.bold = True
    title_run.font.size = Pt(22)
    document.add_paragraph(f"学生：{snapshot['studentName']}　范围：{snapshot['scope']}　薄弱点：{'、'.join(item['knowledgePoint'] for item in chapters)}")
    if degraded:
        document.add_paragraph("说明：本地资料检索暂不可用，本讲义根据可信错题记录和题目解析生成，资料引用不足。")
    for chapter in chapters:
        document.add_heading(chapter["knowledgePoint"], level=1)
        _docx_section(document, "核心概念", chapter["coreConcept"])
        _docx_section(document, "先修知识", chapter["prerequisites"])
        _docx_section(document, "错因归纳", "；".join(chapter["errorPatterns"]))
        _docx_section(document, "解题检查清单", "\n".join(f"- {item}" for item in chapter["checklist"]))
        document.add_heading("关联错题", level=2)
        for row in chapter["questions"]:
            document.add_paragraph(row["stem"])
        document.add_heading("变式练习", level=2)
        for variant in chapter["variants"]:
            document.add_paragraph(variant["prompt"])
        _docx_section(document, "复习建议", chapter["advice"])
        document.add_heading("资料引用", level=2)
        if chapter["citations"]:
            for item in chapter["citations"]:
                document.add_paragraph(f"{item['title']} · {item['location']} · {item['snippet']}")
        else:
            document.add_paragraph("未检索到可核验的本地资料引用。")
    document.add_heading("答案与解析", level=1)
    for chapter in chapters:
        document.add_heading(chapter["knowledgePoint"], level=2)
        for variant in chapter["variants"]:
            document.add_paragraph(f"{variant['prompt']}\n答案：{variant['answer']}\n解析：{variant['explanation']}")
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def _docx_section(document, title: str, content: str) -> None:
    document.add_heading(title, level=2)
    document.add_paragraph(content or "暂无")


def _build_handout_pdf(snapshot: dict, chapters: list[dict], citations: list[dict], degraded: bool) -> bytes:
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    output = BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm, title="智学引擎个性化复习讲义", author="智学引擎")
    styles = getSampleStyleSheet()
    title = ParagraphStyle("HTitle", parent=styles["Title"], fontName="STSong-Light", fontSize=20, leading=26, alignment=TA_CENTER, textColor=colors.HexColor("#0F172A"))
    h1 = ParagraphStyle("HH1", parent=styles["Heading1"], fontName="STSong-Light", fontSize=15, leading=21, textColor=colors.HexColor("#1F4E78"), spaceBefore=10)
    h2 = ParagraphStyle("HH2", parent=styles["Heading2"], fontName="STSong-Light", fontSize=11, leading=16, textColor=colors.HexColor("#334155"), spaceBefore=6)
    body = ParagraphStyle("HBody", parent=styles["BodyText"], fontName="STSong-Light", fontSize=9.5, leading=15, spaceAfter=4)
    story = [Paragraph("个性化复习讲义", title), Paragraph(_xml(f"学生：{snapshot['studentName']}　薄弱点：{'、'.join(item['knowledgePoint'] for item in chapters)}"), body)]
    if degraded:
        story.append(Paragraph("本地资料检索暂不可用，本讲义根据可信错题记录和题目解析生成。", body))
    for chapter in chapters:
        story.append(Paragraph(_xml(chapter["knowledgePoint"]), h1))
        for label, content in (("核心概念", chapter["coreConcept"]), ("先修知识", chapter["prerequisites"]), ("错因归纳", "；".join(chapter["errorPatterns"])), ("解题检查清单", "；".join(chapter["checklist"])), ("复习建议", chapter["advice"])):
            story.extend([Paragraph(label, h2), Paragraph(_xml(content), body)])
        story.append(Paragraph("变式练习", h2))
        for variant in chapter["variants"]:
            story.append(Paragraph(_xml(variant["prompt"]), body))
        story.append(Paragraph("资料引用", h2))
        for item in chapter["citations"]:
            story.append(Paragraph(_xml(f"{item['title']} · {item['location']} · {item['snippet']}"), body))
    story.append(Paragraph("答案与解析", h1))
    for chapter in chapters:
        story.append(Paragraph(_xml(chapter["knowledgePoint"]), h2))
        for variant in chapter["variants"]:
            story.append(Paragraph(_xml(f"{variant['prompt']}　答案：{variant['answer']}　解析：{variant['explanation']}"), body))
    doc.build(story)
    return output.getvalue()


def _save_job(job: ReviewHandoutJob, **changes) -> None:
    with transaction.atomic():
        current = ReviewHandoutJob.objects.select_for_update().get(pk=job.pk)
        if current.status == "cancelled" and changes.get("status") != "cancelled":
            raise ReviewHandoutCancelled
        for field, value in changes.items():
            setattr(current, field, value)
            setattr(job, field, value)
        current.save(update_fields=[*changes.keys(), "updated_at"])


def _artifact_directory(job: ReviewHandoutJob) -> Path:
    root = Path(getattr(settings, "A3_REVIEW_HANDOUT_ROOT", settings.BASE_DIR / "tmp" / "review-handouts"))
    return root / str(job.user_id) / str(job.id)


def _atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def _citation_location(metadata: dict) -> str:
    page = metadata.get("page_number") or metadata.get("pageNumber")
    block = metadata.get("block_id") or metadata.get("blockId")
    if page:
        return f"第 {page} 页"
    if block:
        return f"位置 {str(block)[:80]}"
    return "资料正文"


def _xml(value) -> str:
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _is_due(value, now) -> bool:
    if not value:
        return True
    try:
        return timezone.datetime.fromisoformat(str(value)) <= now
    except ValueError:
        return True


def _recency_score(value, now) -> float:
    if not value:
        return 0
    try:
        occurred = timezone.datetime.fromisoformat(str(value))
    except ValueError:
        return 0
    days = max(0.0, (now - occurred).total_seconds() / 86400)
    return max(0.0, 10.0 - min(days, 10.0))
