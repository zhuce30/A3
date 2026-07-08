from __future__ import annotations

from uuid import uuid4

from django.db import migrations
from django.utils import timezone
from django.utils.dateparse import parse_datetime


def _created_at(value):
    parsed = parse_datetime(str(value or ""))
    if parsed is None:
        return timezone.now()
    return parsed if timezone.is_aware(parsed) else timezone.make_aware(parsed)


def backfill_coaching_sessions(apps, schema_editor):
    LearnerProfile = apps.get_model("profiles", "LearnerProfile")
    CoachingSession = apps.get_model("learning", "CoachingSession")
    CoachingMessage = apps.get_model("learning", "CoachingMessage")

    for profile in LearnerProfile.objects.exclude(extra_profile=None).iterator():
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        legacy = extra_profile.get("coachingSession") if isinstance(extra_profile.get("coachingSession"), dict) else {}
        raw_messages = legacy.get("messages") if isinstance(legacy.get("messages"), list) else []
        if not raw_messages:
            continue
        if CoachingSession.objects.filter(user_id=profile.user_id).exists():
            continue

        session = CoachingSession.objects.create(
            user_id=profile.user_id,
            status="ended",
            topic_title=str(legacy.get("topicTitle") or "")[:160],
            summary=str(legacy.get("summary") or "")[:1000],
            metadata={
                "legacyExtraProfileImport": True,
                "legacyUpdatedAt": str(legacy.get("updatedAt") or ""),
            },
            ended_at=timezone.now(),
        )
        rows = []
        for item in raw_messages[:60]:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip()
            if role not in {"user", "assistant"}:
                role = "assistant"
            content = str(item.get("content") or "").strip()[:4000]
            if not content:
                continue
            rows.append(
                CoachingMessage(
                    id=uuid4(),
                    session_id=session.id,
                    role=role,
                    content=content,
                    verified=bool(item.get("verified")) if role == "assistant" else False,
                    citations=item.get("citations") if isinstance(item.get("citations"), list) else [],
                    claims=item.get("claims") if isinstance(item.get("claims"), list) else [],
                    safety=item.get("safety") if isinstance(item.get("safety"), dict) else {},
                    refusal_reason=str(item.get("refusalReason") or "")[:500],
                    degraded=bool(item.get("degraded")),
                    metadata={"clientId": str(item.get("id") or "")},
                    created_at=_created_at(item.get("createdAt")),
                )
            )
        CoachingMessage.objects.bulk_create(rows)


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("profiles", "0001_initial"),
        ("learning", "0008_coachingsession_coachingmessage_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill_coaching_sessions, noop_reverse),
    ]
