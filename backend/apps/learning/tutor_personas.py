from __future__ import annotations

from copy import deepcopy

from django.db import transaction
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile


TUTOR_PERSONA_SCHEMA_VERSION = "a3.tutor-persona.v1"
TUTOR_PREFERENCE_SCHEMA_VERSION = "a3.tutor-preference.v1"

_PUBLIC_PERSONA_FIELDS = (
    "id",
    "name",
    "shortDescription",
    "teachingStyle",
    "avatarAssetId",
    "voiceProfileId",
    "allowedWorkflows",
    "schemaVersion",
)


_TUTOR_PERSONAS = {
    "structured-teacher": {
        "id": "structured-teacher",
        "name": "Structured Teacher",
        "shortDescription": "Organizes explanations into clear steps and summaries.",
        "teachingStyle": "structured",
        "avatarAssetId": "tutor-structured-teacher",
        "voiceProfileId": "voice-clear-guide",
        "allowedWorkflows": ["explain", "review", "plan"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "Teach in ordered steps, check understanding, and summarize the key takeaway.",
        "voice": {
            "openaiVoice": "alloy",
            "dashscopeVoice": "longxiaochun",
        },
    },
    "socratic-guide": {
        "id": "socratic-guide",
        "name": "Socratic Guide",
        "shortDescription": "Uses focused questions to help learners reason independently.",
        "teachingStyle": "socratic",
        "avatarAssetId": "tutor-socratic-guide",
        "voiceProfileId": "voice-curious-guide",
        "allowedWorkflows": ["coach", "explain", "review"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "Ask one useful question at a time and let the learner build the answer.",
        "voice": {
            "openaiVoice": "sage",
            "dashscopeVoice": "longwan",
        },
    },
    "practice-coach": {
        "id": "practice-coach",
        "name": "Practice Coach",
        "shortDescription": "Turns weak points into short practice loops with immediate feedback.",
        "teachingStyle": "practice",
        "avatarAssetId": "tutor-practice-coach",
        "voiceProfileId": "voice-energetic-coach",
        "allowedWorkflows": ["practice", "assessment", "review"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "Prioritize retrieval practice, give concise feedback, and revisit missed concepts.",
        "voice": {
            "openaiVoice": "coral",
            "dashscopeVoice": "longshuo",
        },
    },
    "foundation-coach": {
        "id": "foundation-coach",
        "name": "Foundation Coach",
        "shortDescription": "Builds missing prerequisites with patient explanations and small steps.",
        "teachingStyle": "foundational",
        "avatarAssetId": "tutor-foundation-coach",
        "voiceProfileId": "voice-patient-coach",
        "allowedWorkflows": ["explain", "practice", "review", "plan"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "Start from prerequisites, use concrete examples, and increase difficulty gradually.",
        "voice": {
            "openaiVoice": "shimmer",
            "dashscopeVoice": "longjing",
        },
    },
}


def list_public_tutor_personas() -> list[dict]:
    return [public_tutor_persona(persona) for persona in _TUTOR_PERSONAS.values()]


def resolve_tutor_persona(persona_id: str | None) -> dict | None:
    if not isinstance(persona_id, str):
        return None
    persona = _TUTOR_PERSONAS.get(persona_id.strip())
    return deepcopy(persona) if persona else None


def public_tutor_persona(persona: dict | str | None) -> dict | None:
    if isinstance(persona, str):
        persona = resolve_tutor_persona(persona)
    if not isinstance(persona, dict):
        return None
    return {field: deepcopy(persona[field]) for field in _PUBLIC_PERSONA_FIELDS}


def _is_weak_foundation(profile: LearnerProfile | None) -> bool:
    foundation_level = str(getattr(profile, "foundation_level", "") or "").lower()
    return any(marker in foundation_level for marker in ("weak", "薄弱", "较弱", "弱"))


def _preference(persona_id: str, source: str, updated_at: str = "") -> dict:
    return {
        "personaId": persona_id,
        "source": source,
        "schemaVersion": TUTOR_PREFERENCE_SCHEMA_VERSION,
        "updatedAt": updated_at,
    }


def get_user_tutor_preference(user: User) -> dict:
    profile = LearnerProfile.objects.filter(user=user).first()
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    saved = extra_profile.get("tutorPreference")
    if isinstance(saved, dict):
        saved_persona_id = saved.get("personaId")
        if resolve_tutor_persona(saved_persona_id):
            return _preference(
                saved_persona_id,
                "saved",
                str(saved.get("updatedAt") or ""),
            )

    if _is_weak_foundation(profile):
        return _preference("foundation-coach", "profile_recommendation")
    return _preference("structured-teacher", "default")


@transaction.atomic
def save_user_tutor_preference(user: User, persona_id: str) -> dict:
    persona = resolve_tutor_persona(persona_id)
    if persona is None:
        raise ValueError("personaId is not supported")

    profile, _created = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = deepcopy(profile.extra_profile) if isinstance(profile.extra_profile, dict) else {}
    updated_at = timezone.now().isoformat()
    extra_profile["tutorPreference"] = {
        "personaId": persona["id"],
        "schemaVersion": TUTOR_PREFERENCE_SCHEMA_VERSION,
        "updatedAt": updated_at,
    }
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return _preference(persona["id"], "saved", updated_at)
