from __future__ import annotations

from celery import shared_task
from django.contrib.auth import get_user_model
from django.db import close_old_connections

from backend.apps.assessments.services import refill_personal_question_pool
from backend.apps.learning.models import KnowledgePoint


@shared_task(name="assessments.refill_personal_question_pool")
def refill_personal_question_pool_task(user_id: str, knowledge_point_id: str, *, target_size: int = 12) -> dict:
    close_old_connections()
    try:
        user = get_user_model().objects.get(id=user_id)
        point = KnowledgePoint.objects.get(id=knowledge_point_id)
        return refill_personal_question_pool(user, point, target_size=target_size)
    finally:
        close_old_connections()


@shared_task(
    bind=True,
    name="assessments.generate_review_handout",
    acks_late=True,
    reject_on_worker_lost=False,
    soft_time_limit=1200,
    time_limit=1320,
)
def generate_review_handout_task(self, job_id: str) -> dict:
    from backend.apps.assessments.models import ReviewHandoutJob
    from backend.apps.assessments.review_handouts import generate_review_handout

    close_old_connections()
    try:
        ReviewHandoutJob.objects.filter(id=job_id, status="queued").update(celery_task_id=self.request.id or "")
        return generate_review_handout(job_id)
    finally:
        close_old_connections()
