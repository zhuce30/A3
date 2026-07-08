from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand

from backend.apps.assessments.models import Question, QuestionGenerationJob, QuestionQualityCheck, QuestionReviewStatus, QuestionSourceType


class Command(BaseCommand):
    help = "Evaluate A3 adaptive question bank generation, review, and evidence coverage."

    def add_arguments(self, parser):
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--output", default="")

    def handle(self, *args, **options):
        payload = build_question_bank_metrics()
        if options.get("output"):
            output_path = Path(options["output"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        if options.get("as_json"):
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return
        self.stdout.write("A3 question bank evaluation")
        self.stdout.write(f"questionCount: {payload['questionCount']}")
        self.stdout.write(f"approvedCount: {payload['approvedCount']}")
        self.stdout.write(f"autoVerifiedCount: {payload['autoVerifiedCount']}")
        self.stdout.write(f"generatedCount: {payload['generatedCount']}")
        self.stdout.write(f"evidenceCoverage: {payload['evidenceCoverage']}%")
        self.stdout.write(f"verificationPassRate: {payload['verificationPassRate']}%")
        self.stdout.write(f"formalAssessmentSafe: {payload['formalAssessmentSafe']}")


def build_question_bank_metrics() -> dict:
    questions = Question.objects.filter(is_active=True)
    total = questions.count()
    generated = questions.filter(source_type__in=[
        QuestionSourceType.KB_GENERATED,
        QuestionSourceType.PERSONAL_GENERATED,
        QuestionSourceType.VARIANT,
    ])
    generated_count = generated.count()
    evidenced = generated.filter(evidence_items__isnull=False).distinct().count()
    checks = QuestionQualityCheck.objects.all()
    passed_checks = checks.filter(passed=True).count()
    unsafe_formal_count = questions.exclude(review_status=QuestionReviewStatus.APPROVED).exclude(scope="personal").count()
    latest_job = QuestionGenerationJob.objects.order_by("-created_at").first()
    return {
        "schemaVersion": "a3.question-bank-metrics.v1",
        "available": True,
        "path": "backend/tmp/question_bank_metrics.json",
        "questionCount": total,
        "approvedCount": questions.filter(review_status=QuestionReviewStatus.APPROVED).count(),
        "autoVerifiedCount": questions.filter(review_status=QuestionReviewStatus.AUTO_VERIFIED).count(),
        "rejectedCount": Question.objects.filter(review_status=QuestionReviewStatus.REJECTED).count(),
        "generatedCount": generated_count,
        "personalQuestionCount": questions.filter(source_type=QuestionSourceType.PERSONAL_GENERATED).count(),
        "evidenceCoverage": round(evidenced * 100 / generated_count, 1) if generated_count else 100.0,
        "verificationPassRate": round(passed_checks * 100 / checks.count(), 1) if checks.exists() else 100.0,
        "formalAssessmentSafe": unsafe_formal_count == 0,
        "latestJob": {
            "id": str(latest_job.id),
            "status": latest_job.status,
            "requestedCount": latest_job.requested_count,
            "generatedCount": latest_job.generated_count,
            "verifiedCount": latest_job.verified_count,
            "rejectedCount": latest_job.rejected_count,
            "error": latest_job.error,
            "updatedAt": latest_job.updated_at.isoformat() if latest_job.updated_at else None,
        } if latest_job else None,
    }
