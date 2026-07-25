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
        "name": "结构讲解",
        "shortDescription": "先搭框架，再分步骤讲清概念",
        "teachingStyle": "structured",
        "avatarAssetId": "teacher-default-v1",
        "voiceProfileId": "voice-clear-guide",
        "allowedWorkflows": ["coaching", "classroom", "explain", "review", "plan"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "遵循受控教学流程：先确认学习目标，再按框架分步讲解；只基于已验证资料回答，遇到不确定内容明确说明并引导复核。",
        "voice": {
            "openaiVoice": "alloy",
            "dashscopeVoice": "longxiaochun",
        },
    },
    "socratic-guide": {
        "id": "socratic-guide",
        "name": "启发追问",
        "shortDescription": "通过关键问题，引导你自己找到答案",
        "teachingStyle": "socratic",
        "avatarAssetId": "teacher-default-v1",
        "voiceProfileId": "voice-curious-guide",
        "allowedWorkflows": ["coaching", "classroom", "coach", "explain", "review"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "遵循受控启发流程：一次只提出一个关键问题，先了解当前理解，再逐步提示；不直接代答，不编造资料，无法确认时明确说明。",
        "voice": {
            "openaiVoice": "sage",
            "dashscopeVoice": "longwan",
        },
    },
    "practice-coach": {
        "id": "practice-coach",
        "name": "例题实战",
        "shortDescription": "用例题、步骤和即时反馈巩固薄弱点",
        "teachingStyle": "practice",
        "avatarAssetId": "teacher-default-v1",
        "voiceProfileId": "voice-energetic-coach",
        "allowedWorkflows": ["coaching", "classroom", "practice", "assessment", "review"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "遵循受控练习流程：围绕当前薄弱点给出一题一练，先让学习者作答，再反馈正误、错因和下一步；不泄露未完成测评答案。",
        "voice": {
            "openaiVoice": "coral",
            "dashscopeVoice": "longshuo",
        },
    },
    "foundation-coach": {
        "id": "foundation-coach",
        "name": "基础补强",
        "shortDescription": "从先修概念开始，用短句和小步讲解",
        "teachingStyle": "foundation",
        "avatarAssetId": "teacher-default-v1",
        "voiceProfileId": "voice-patient-coach",
        "allowedWorkflows": ["coaching", "classroom", "explain", "practice", "review", "plan"],
        "schemaVersion": TUTOR_PERSONA_SCHEMA_VERSION,
        "instruction": "遵循受控补强流程：从已确认的先修概念开始，用短句和小步讲解；每步检查理解，只基于可靠资料回答，不确定时明确标注。",
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
