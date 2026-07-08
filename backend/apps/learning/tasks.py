from __future__ import annotations

from celery import shared_task

from backend.apps.accounts.models import User
from backend.apps.learning.optimization_policy import evaluate_policy_decision_history_outcomes
from backend.apps.profiles.models import LearnerProfile


@shared_task(name="learning.evaluate_optimization_policy_outcomes")
def evaluate_optimization_policy_outcomes_task(days: int = 7, user_phone: str = "") -> dict:
    phone = str(user_phone or "").strip()
    queryset = User.objects.all()
    if phone:
        queryset = queryset.filter(phone=phone)
    else:
        learner_ids = LearnerProfile.objects.filter(extra_profile__has_key="optimizationPolicyDecisions").values_list("user_id", flat=True)
        queryset = queryset.filter(id__in=list(learner_ids))

    total_updated = 0
    user_count = 0
    details = []
    for user in queryset:
        result = evaluate_policy_decision_history_outcomes(user, days=days)
        updated = int(result.get("updated") or 0)
        total_updated += updated
        user_count += 1
        details.append({"userId": str(user.id), "phone": getattr(user, "phone", ""), "updated": updated})
    return {"updated": total_updated, "users": user_count, "days": days, "details": details}
