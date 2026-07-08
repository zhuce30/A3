from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from backend.apps.accounts.models import User
from backend.apps.learning.optimization_policy import evaluate_policy_decision_history_outcomes
from backend.apps.profiles.models import LearnerProfile


class Command(BaseCommand):
    help = "Evaluate 7-day outcomes for pending A3 optimization policy decisions."

    def add_arguments(self, parser):
        parser.add_argument("--user-phone", default="", help="Only evaluate one learner by phone.")
        parser.add_argument("--days", type=int, default=7, help="Outcome evaluation window in days.")

    def handle(self, *args, **options):
        phone = str(options.get("user_phone") or "").strip()
        days = int(options.get("days") or 7)
        queryset = User.objects.all()
        if phone:
            queryset = queryset.filter(phone=phone)
            if not queryset.exists():
                raise CommandError(f"user not found: {phone}")
        else:
            learner_ids = LearnerProfile.objects.filter(extra_profile__has_key="optimizationPolicyDecisions").values_list("user_id", flat=True)
            queryset = queryset.filter(id__in=list(learner_ids))
        total_updated = 0
        user_count = 0
        for user in queryset:
            result = evaluate_policy_decision_history_outcomes(user, days=days)
            updated = int(result.get("updated") or 0)
            total_updated += updated
            user_count += 1
            self.stdout.write(f"user={getattr(user, 'phone', user.id)} updated={updated}")
        self.stdout.write(f"updated={total_updated} users={user_count} days={days}")
