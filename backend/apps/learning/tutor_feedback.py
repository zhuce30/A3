from __future__ import annotations

from django.db import transaction

from backend.apps.learning.models import (
    CoachingSession,
    CoachingSessionStatus,
    TutorPersonaFeedback,
)


TUTOR_FEEDBACK_TAGS = (
    "讲解清楚",
    "节奏合适",
    "帮助理解",
    "仍然困惑",
)


class TutorFeedbackError(ValueError):
    status_code = 400


class TutorFeedbackNotFoundError(TutorFeedbackError):
    status_code = 404


class TutorFeedbackPermissionError(TutorFeedbackError):
    status_code = 403


def get_tutor_feedback(user, session_id) -> dict | None:
    session = _feedback_session(user, session_id)
    _session_persona_id(session)
    feedback = TutorPersonaFeedback.objects.filter(user=user, session=session).first()
    return serialize_tutor_feedback(feedback) if feedback else None


@transaction.atomic
def upsert_tutor_feedback(user, session_id, payload: dict) -> tuple[dict, bool]:
    session = _feedback_session(user, session_id, lock=True)
    persona_id = _session_persona_id(session)
    rating, tags = _validated_feedback(payload)
    feedback, created = TutorPersonaFeedback.objects.update_or_create(
        user=user,
        session=session,
        defaults={
            "persona_id": persona_id,
            "rating": rating,
            "tags": tags,
        },
    )
    return serialize_tutor_feedback(feedback), created


def serialize_tutor_feedback(feedback: TutorPersonaFeedback) -> dict:
    return {
        "rating": feedback.rating,
        "tags": list(feedback.tags) if isinstance(feedback.tags, list) else [],
        "personaId": feedback.persona_id,
        "createdAt": feedback.created_at.isoformat(),
        "updatedAt": feedback.updated_at.isoformat(),
    }


def _feedback_session(user, session_id, *, lock: bool = False) -> CoachingSession:
    sessions = CoachingSession.objects
    if lock:
        sessions = sessions.select_for_update()
    try:
        session = sessions.get(id=session_id)
    except CoachingSession.DoesNotExist as exc:
        raise TutorFeedbackNotFoundError("辅导会话不存在") from exc
    if session.user_id != user.id:
        raise TutorFeedbackPermissionError("无权访问该辅导会话反馈")
    if session.status != CoachingSessionStatus.ENDED:
        raise TutorFeedbackError("请先结束辅导会话，再提交反馈")
    return session


def _session_persona_id(session: CoachingSession) -> str:
    metadata = session.metadata if isinstance(session.metadata, dict) else {}
    snapshot = metadata.get("tutorPersona")
    persona_id = snapshot.get("id") if isinstance(snapshot, dict) else None
    if not isinstance(persona_id, str) or not persona_id.strip():
        raise TutorFeedbackError("该辅导会话缺少辅导人格快照，暂时无法提交反馈")
    normalized = persona_id.strip()
    if len(normalized) > 64:
        raise TutorFeedbackError("辅导人格快照无效，暂时无法提交反馈")
    return normalized


def _validated_feedback(payload: dict) -> tuple[int, list[str]]:
    if not isinstance(payload, dict):
        raise TutorFeedbackError("请求数据必须是 JSON 对象")
    rating = payload.get("rating")
    if isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 5:
        raise TutorFeedbackError("评分必须是 1 到 5 的整数")
    raw_tags = payload.get("tags")
    if not isinstance(raw_tags, list):
        raise TutorFeedbackError("反馈标签必须是数组")
    if any(not isinstance(tag, str) or tag not in TUTOR_FEEDBACK_TAGS for tag in raw_tags):
        raise TutorFeedbackError("反馈标签只能从固定选项中选择")
    selected = set(raw_tags)
    tags = [tag for tag in TUTOR_FEEDBACK_TAGS if tag in selected]
    if len(tags) > 4:
        raise TutorFeedbackError("反馈标签最多选择四项")
    return rating, tags
