from __future__ import annotations

import json
from statistics import mean
from time import perf_counter

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.test.utils import CaptureQueriesContext

from backend.apps.accounts.models import User
from backend.apps.assessments.services import build_learning_report


SUPPORTED_PERIODS = {"7d", "30d", "term"}
MIN_REPEAT = 1
MAX_REPEAT = 20


class Command(BaseCommand):
    help = "Measure aggregate learning-report latency and query counts for one user ID."

    def add_arguments(self, parser):
        parser.add_argument("--user-id", required=True)
        parser.add_argument("--period", default="30d")
        parser.add_argument("--repeat", type=int, default=3)
        parser.add_argument("--json", action="store_true", dest="as_json")

    def handle(self, *args, **options):
        period = str(options.get("period") or "30d").strip()
        try:
            repeat = int(options.get("repeat") or 0)
        except (TypeError, ValueError) as exc:
            raise CommandError(f"Repeat must be between {MIN_REPEAT} and {MAX_REPEAT}") from exc
        if period not in SUPPORTED_PERIODS:
            raise CommandError("Period must be one of: 7d, 30d, term")
        if not MIN_REPEAT <= repeat <= MAX_REPEAT:
            raise CommandError(f"Repeat must be between {MIN_REPEAT} and {MAX_REPEAT}")

        user = self._load_user(str(options.get("user_id") or "").strip())
        user_id = user.pk
        elapsed_values: list[float] = []
        query_counts: list[int] = []

        for _ in range(repeat):
            measured_user = User.objects.get(pk=user_id)
            with CaptureQueriesContext(connection) as captured:
                started = perf_counter()
                build_learning_report(measured_user, period=period)
                elapsed_values.append((perf_counter() - started) * 1000)
            query_counts.append(len(captured))

        payload = {
            "success": True,
            "period": period,
            "repeat": repeat,
            "elapsedMs": _summary(elapsed_values, digits=3),
            "queryCount": _summary(query_counts, digits=2),
        }
        if options.get("as_json"):
            self.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
            return

        elapsed = payload["elapsedMs"]
        queries = payload["queryCount"]
        self.stdout.write(
            " ".join(
                [
                    "success=true",
                    f"period={period}",
                    f"repeat={repeat}",
                    "elapsedMs="
                    f"min:{elapsed['min']},average:{elapsed['average']},max:{elapsed['max']}",
                    "queryCount="
                    f"min:{queries['min']},average:{queries['average']},max:{queries['max']}",
                ]
            )
        )

    @staticmethod
    def _load_user(user_id: str) -> User:
        if not user_id:
            raise CommandError("User not found")
        try:
            user = User.objects.filter(pk=user_id).first()
        except (TypeError, ValueError, ValidationError):
            user = None
        if user is None:
            raise CommandError("User not found")
        return user


def _summary(values: list[float] | list[int], *, digits: int) -> dict[str, float | int]:
    minimum = min(values)
    maximum = max(values)
    average = mean(values)
    if all(isinstance(value, int) for value in values):
        return {
            "min": int(minimum),
            "average": round(float(average), digits),
            "max": int(maximum),
        }
    return {
        "min": round(float(minimum), digits),
        "average": round(float(average), digits),
        "max": round(float(maximum), digits),
    }
