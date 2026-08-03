from __future__ import annotations

import uuid
from dataclasses import dataclass
from time import sleep
from typing import Any

from django.db import IntegrityError, OperationalError, transaction

from backend.apps.compat.agent_kernel import AgentContext, SafetyAgent, VerifierAgent
from backend.apps.compat.llm import generate_tutoring_answer
from backend.apps.notes.models import NoteAiMessage, NoteAiSession
from backend.apps.notes.services import context_service


MAX_MESSAGE_CHARACTERS = 4_000
MAX_ANSWER_CHARACTERS = 12_000
PARTIAL_WRITE_CHARACTERS = 512
MAX_CHAT_TRANSACTION_ATTEMPTS = 6
retrieve_course_evidence = context_service.retrieve_course_evidence


class AssistantServiceError(ValueError):
    def __init__(self, message: str, *, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class ChatSubmission:
    user_message: NoteAiMessage
    assistant_message: NoteAiMessage
    created: bool


def _public_scope_snapshot(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        return {}
    result: dict[str, Any] = {"type": str(snapshot.get("type") or "")}
    if snapshot.get("notebookId"):
        result["notebookId"] = str(snapshot["notebookId"])
    notes = []
    for item in snapshot.get("notes") if isinstance(snapshot.get("notes"), list) else []:
        if not isinstance(item, dict):
            continue
        note = {
            "id": str(item.get("id") or ""),
            "version": item.get("version"),
        }
        attachments = []
        for attachment in item.get("attachments") if isinstance(item.get("attachments"), list) else []:
            if not isinstance(attachment, dict):
                continue
            attachments.append(
                {
                    "id": str(attachment.get("id") or ""),
                    "parseGeneration": attachment.get("parseGeneration"),
                    "sha256": str(attachment.get("sha256") or ""),
                    "displayName": str(attachment.get("displayName") or ""),
                    "contentCharacters": attachment.get("contentCharacters"),
                }
            )
        if attachments:
            note["attachments"] = attachments
        notes.append(note)
    result["notes"] = notes
    return result


def _public_message_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    result: dict[str, Any] = {}
    trace_id = metadata.get("traceId")
    if isinstance(trace_id, str):
        result["traceId"] = trace_id[:128]
    for key in ("contextCharacters", "contextTokens"):
        value = metadata.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            result[key] = value
    if isinstance(metadata.get("includeCourseEvidence"), bool):
        result["includeCourseEvidence"] = metadata["includeCourseEvidence"]
    refusal_reason = metadata.get("refusalReason")
    if isinstance(refusal_reason, str):
        result["refusalReason"] = refusal_reason[:240]
    memory_ids = metadata.get("memoryIds")
    if isinstance(memory_ids, list):
        public_memory_ids = []
        for value in memory_ids[:16]:
            try:
                public_memory_ids.append(str(uuid.UUID(str(value))))
            except (ValueError, TypeError, AttributeError):
                continue
        if public_memory_ids:
            result["memoryIds"] = public_memory_ids
    return result


def serialize_session(session: NoteAiSession) -> dict[str, Any]:
    return {
        "id": str(session.id),
        "title": session.title,
        "scopeType": session.scope_type,
        "scopeSnapshot": _public_scope_snapshot(session.scope_snapshot),
        "status": session.status,
        "createdAt": session.created_at.isoformat(),
        "updatedAt": session.updated_at.isoformat(),
    }


def serialize_message(message: NoteAiMessage) -> dict[str, Any]:
    public_content = message.content
    if (
        message.role == NoteAiMessage.Role.ASSISTANT
        and message.status != NoteAiMessage.Status.SUCCEEDED
    ):
        public_content = ""
    return {
        "id": str(message.id),
        "sessionId": str(message.session_id),
        "role": message.role,
        "content": public_content,
        "status": message.status,
        "clientRequestId": str(message.client_request_id),
        "citations": message.citations,
        "verified": message.verified,
        "claims": message.claims,
        "safety": message.safety,
        "degraded": message.degraded,
        "errorCode": message.error_code,
        "errorMessage": message.error_message,
        "metadata": _public_message_metadata(message.metadata),
        "createdAt": message.created_at.isoformat(),
    }


def create_session(user, payload: dict[str, Any]) -> NoteAiSession:
    title = str(payload.get("title") or "").strip()
    if len(title) > 240:
        raise AssistantServiceError("会话标题不能超过 240 个字符", code="invalid_title")
    try:
        snapshot = context_service.create_scope_snapshot(user, payload.get("scope"))
    except context_service.ContextServiceError as exc:
        raise AssistantServiceError(str(exc), code=exc.code, status=exc.status) from exc
    return NoteAiSession.objects.create(
        user=user,
        title=title,
        scope_type=snapshot["type"],
        scope_snapshot=snapshot,
    )


def list_sessions(user):
    return NoteAiSession.objects.filter(user=user)


def get_owned_session(user, session_id) -> NoteAiSession:
    session = NoteAiSession.objects.filter(user=user, id=session_id).first()
    if session is None:
        raise AssistantServiceError("会话不存在", code="not_found", status=404)
    return session


def get_owned_message(user, message_id) -> NoteAiMessage:
    message = NoteAiMessage.objects.select_related("session").filter(
        session__user=user, id=message_id
    ).first()
    if message is None:
        raise AssistantServiceError("消息不存在", code="not_found", status=404)
    return message


def list_messages(user, session_id):
    session = get_owned_session(user, session_id)
    return session.messages.all()


def _uuid_field(value: Any, *, field: str, code: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise AssistantServiceError(
            f"{field} 必须是有效 UUID", code=code
        ) from exc


def _persist_chat(
    user,
    *,
    session_id: uuid.UUID,
    request_id: uuid.UUID,
    message_text: str,
    include_course: bool,
) -> ChatSubmission:
    with transaction.atomic():
        session = NoteAiSession.objects.select_for_update().filter(
            user=user, id=session_id, status=NoteAiSession.Status.ACTIVE
        ).first()
        if session is None:
            raise AssistantServiceError("会话不存在", code="not_found", status=404)
        existing = session.messages.filter(
            role=NoteAiMessage.Role.ASSISTANT, client_request_id=request_id
        ).first()
        if existing is not None:
            user_message = session.messages.filter(id=existing.metadata.get("userMessageId")).first()
            if user_message is None:
                raise AssistantServiceError("会话消息状态异常", code="message_pair_missing", status=409)
            return ChatSubmission(user_message, existing, False)
        user_request_id = uuid.uuid5(request_id, "personal-note-user-message")
        user_message = NoteAiMessage.objects.create(
            session=session,
            role=NoteAiMessage.Role.USER,
            content=message_text,
            status=NoteAiMessage.Status.QUEUED,
            client_request_id=user_request_id,
            metadata={"requestId": str(request_id), "includeCourseEvidence": include_course},
        )
        assistant_message = NoteAiMessage.objects.create(
            session=session,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.QUEUED,
            client_request_id=request_id,
            metadata={
                "userMessageId": str(user_message.id),
                "includeCourseEvidence": include_course,
            },
        )
    return ChatSubmission(user_message, assistant_message, True)


def submit_chat(user, payload: dict[str, Any]) -> ChatSubmission:
    session_id = _uuid_field(
        payload.get("sessionId"), field="sessionId", code="invalid_session_id"
    )
    request_id = _uuid_field(
        payload.get("clientRequestId"),
        field="clientRequestId",
        code="invalid_client_request_id",
    )
    message_text = str(payload.get("message") or "").strip()
    if not message_text or len(message_text) > MAX_MESSAGE_CHARACTERS:
        raise AssistantServiceError(
            f"消息必须是 1 至 {MAX_MESSAGE_CHARACTERS} 个字符", code="invalid_message"
        )
    include_course = payload.get("includeCourseEvidence") is True
    for attempt in range(MAX_CHAT_TRANSACTION_ATTEMPTS):
        try:
            return _persist_chat(
                user,
                session_id=session_id,
                request_id=request_id,
                message_text=message_text,
                include_course=include_course,
            )
        except (IntegrityError, OperationalError) as exc:
            if attempt + 1 >= MAX_CHAT_TRANSACTION_ATTEMPTS:
                raise AssistantServiceError(
                    "AI 会话请求繁忙，请重试",
                    code="assistant_transaction_busy",
                    status=503,
                ) from exc
            sleep(0.01 * (attempt + 1))
    raise AssertionError("unreachable")


def run_safety(user, question: str) -> dict[str, Any]:
    result = SafetyAgent().run(
        AgentContext(user=user, workflow="qa_interact", goal=question, payload={"question": question})
    )
    safety = result.output.get("safety") if isinstance(result.output, dict) else None
    return safety if isinstance(safety, dict) else {"safe": False, "category": "unknown", "reason": "safety_unavailable"}


def generate_note_answer(question: str, *, context_text: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
    memory_sources = [item for item in sources if item.get("sourceKind") == "personal_memory"]
    memory_instruction = (
        "只可使用本次上下文中明确列出的已确认个人记忆；候选、暂停、过期、已替换或已删除记忆一律不可使用。"
        if memory_sources
        else "当前没有可用的已确认个人记忆。涉及用户偏好、长期目标或历史习惯时必须明确不知道，不得自行推断。"
    )
    return generate_tutoring_answer(
        question,
        target={"title": "个人笔记"},
        sources=[
            {
                "title": item.get("title") or "个人笔记",
                "location": item.get("location") or "",
                "snippet": item.get("snippet") or "",
                "type": item.get("sourceKind") or "personal_note",
                "score": item.get("score") or 1.0,
            }
            for item in sources
        ] or [{"title": "个人笔记", "location": "", "snippet": context_text, "type": "personal_note", "score": 1.0}],
        tutor_persona={"instruction": memory_instruction},
    )


def run_verifier(user, question: str, answer: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
    result = VerifierAgent().run(
        AgentContext(
            user=user,
            workflow="verify_answer",
            goal=question,
            payload={"question": question, "answer": answer, "sources": sources},
        )
    )
    verification = result.output.get("verification") if isinstance(result.output, dict) else None
    return verification if isinstance(verification, dict) else result.output


def build_context_for_message(message: NoteAiMessage, question: str):
    include_course = message.metadata.get("includeCourseEvidence") is True
    personal_budget = context_service.DEFAULT_CONTEXT_CHARACTER_BUDGET
    personal_token_budget = context_service.DEFAULT_CONTEXT_TOKEN_BUDGET
    if include_course:
        personal_budget = personal_budget * 3 // 4
        personal_token_budget = personal_token_budget * 3 // 4
    context = context_service.build_note_context(
        user=message.session.user,
        scope=message.session.scope_snapshot,
        query=question,
        include_course_evidence=False,
        character_budget=personal_budget,
        token_budget=personal_token_budget,
    )
    if not include_course:
        return context
    course_text, course_citations = context_service.normalize_course_citations(
        retrieve_course_evidence(message.session.user, question),
        context_service.DEFAULT_CONTEXT_CHARACTER_BUDGET - len(context.text) - (2 if context.text else 0),
        context_service.DEFAULT_CONTEXT_TOKEN_BUDGET - context.token_count,
    )
    text = f"{context.text}\n\n{course_text}" if context.text and course_text else context.text or course_text
    citations = [*context.citations, *course_citations]
    return context_service.NoteContext(
        text=text,
        citations=citations,
        sources=[*citations, *context.memory_sources],
        character_count=len(text),
        token_count=context.token_count + sum(
            len(context_service._TERM_RE.findall(item["snippet"])) for item in course_citations
        ),
        memory_ids=context.memory_ids,
        memory_sources=context.memory_sources,
    )
