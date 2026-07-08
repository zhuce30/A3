from django.db import migrations
from django.utils import timezone


def backfill_resource_pack_logs(apps, schema_editor):
    LearnerProfile = apps.get_model("profiles", "LearnerProfile")
    ResourcePackLog = apps.get_model("learning", "ResourcePackLog")
    for profile in LearnerProfile.objects.exclude(extra_profile=None).iterator():
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        runs = extra_profile.get("resourcePackRuns") if isinstance(extra_profile.get("resourcePackRuns"), list) else []
        for run in runs:
            if not isinstance(run, dict):
                continue
            task_id = str(run.get("taskId") or "").strip()
            learning_goal = str(run.get("learningGoal") or "").strip()
            if not task_id or not learning_goal:
                continue
            completed_at = _parse_completed_at(run.get("completedAt"))
            ResourcePackLog.objects.update_or_create(
                user_id=profile.user_id,
                task_id=task_id[:160],
                defaults={
                    "task_title": str(run.get("taskTitle") or "")[:160],
                    "learning_goal": learning_goal[:160],
                    "verified_source_count": _safe_int(run.get("verifiedSourceCount")),
                    "confidence": str(run.get("confidence") or "medium")[:32],
                    "practice_href": str(run.get("practiceHref") or "/a3/assessment")[:255],
                    "source": str(run.get("source") or "legacy_profile")[:64],
                    "next_step_reason": str(run.get("nextStepReason") or ""),
                    "payload": run,
                    "completed_at": completed_at,
                },
            )


def _safe_int(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _parse_completed_at(value):
    if not value:
        return timezone.now()
    try:
        parsed = timezone.datetime.fromisoformat(str(value))
    except ValueError:
        return timezone.now()
    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


class Migration(migrations.Migration):
    dependencies = [
        ("learning", "0005_resource_pack_log"),
        ("profiles", "0001_initial"),
    ]

    operations = [migrations.RunPython(backfill_resource_pack_logs, migrations.RunPython.noop)]
