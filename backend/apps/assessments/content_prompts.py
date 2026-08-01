import json
import re
from typing import Any


WRONG_EXPORT_PROMPT_VERSION = "wrong-export-v1"
REVIEW_HANDOUT_PROMPT_VERSION = "review-handout-v1"

_PROFILE_FIELDS = (
    "grade",
    "majorDirection",
    "foundationLevel",
    "learningGoal",
    "preferences",
    "weakPoints",
)
_QUESTION_FIELDS = (
    "questionId",
    "knowledgePoint",
    "stem",
    "options",
    "correctAnswer",
    "studentAnswer",
    "errorCause",
    "explanation",
)
_SOURCE_FIELDS = ("sourceId", "title", "location", "snippet")
_WEAKNESS_FIELDS = (
    "knowledgePoint",
    "score",
    "dueCount",
    "errorCount",
    "adjacentSections",
)

_COMMON_SYSTEM_RULES = """你是“智学引擎 A3”的学习诊断内容生成 Agent，只能使用输入中的错题事实和证据。
不得修改或质疑 correctAnswer，不得重写题干、选项、学生原答案和原始解析。
不得伪造教材名称、页码、实验结果、统计数据或引用。
引用只能使用提供的 sourceId；没有适用证据时，citationIds 必须为空，并设置 evidenceStatus 为 unverified。
只输出一个 JSON 对象，不得包含 Markdown 围栏、解释性前言或额外字段。
内容面向学生，使用正常中文和可执行步骤，避免空泛鼓励与重复题干。
迁移练习必须保持原知识点一致但不得复制原题，答案与解析必须内部一致。
如果输入不足，请明确写“不足以判断”，不得补造事实。"""

_WRONG_EXPORT_CONTRACT = """输出对象必须包含 knowledgePoint、groupDiagnosis、prerequisiteGaps、confusions、questionAnalyses、transferPractice、evidenceStatus。
questionAnalyses 中每项必须使用输入中的 questionId，并包含 deepErrorDiagnosis、solutionSteps、selfCheck、reviewAdvice、citationIds。
transferPractice 中每项包含 prompt、answer、explanation、difficulty、citationIds；difficulty 只能是“基础”或“进阶”。
evidenceStatus 只能是 verified、partial 或 unverified。"""

_HANDOUT_CONTRACT = """输出对象必须包含 knowledgePoint、learningDiagnosis、coreConcept、prerequisites、commonErrorPatterns、method、workedExample、tieredPractice、reviewActions、citationIds、evidenceStatus。
tieredPractice 必须提供基础、巩固、迁移三种分层练习，每项包含 level、prompt、answer、explanation。
workedExample 必须包含 prompt、steps、answer。evidenceStatus 只能是 verified、partial 或 unverified。"""


_WINDOWS_PATH = re.compile(r"(?i)(?<![\w])(?:[a-z]:[\\/])[^\s\"'，。；;]+")
_UNC_PATH = re.compile(r"(?<![\w])\\\\[^\s\"'，。；;]+")
_UNIX_PATH = re.compile(r"(?<![\w:])/(?:[^\s/\"'，。；;]+/)*[^\s\"'，。；;]+")
_FILE_URI = re.compile(r"(?i)file:(?:/{1,3})?[^\s\"'，。；;]+")
_KEY_LIKE_VALUE = re.compile(
    r"(?i)(?:sk|rk|pk|api[_-]?key|dashscope|qwen)[_-][A-Za-z0-9_-]{12,}"
)
_SENSITIVE_KEY = re.compile(
    r"(?i)(?:api[_-]?key|authorization|cookie|pass(?:word|wd)?|secret|session|token)"
)
_REDACTED = "[已移除敏感信息]"


def sanitize_prompt_value(value: Any) -> Any:
    """Recursively redact local paths and credential-like values from prompt data."""
    if isinstance(value, dict):
        return {
            key: _REDACTED if _SENSITIVE_KEY.search(str(key)) else sanitize_prompt_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_prompt_value(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_prompt_value(item) for item in value]
    if not isinstance(value, str):
        return value
    sanitized = value
    for pattern in (_FILE_URI, _WINDOWS_PATH, _UNC_PATH, _UNIX_PATH, _KEY_LIKE_VALUE):
        if pattern is _UNIX_PATH and re.search(r"https?://", sanitized, re.IGNORECASE):
            continue
        sanitized = pattern.sub(_REDACTED, sanitized)
    return sanitized


def _pick_fields(value: Any, allowed_fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return sanitize_prompt_value({field: value[field] for field in allowed_fields if field in value})


def _serialize_user_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def build_wrong_export_messages(
    profile: dict[str, Any],
    questions: list[dict[str, Any]],
    sources: list[dict[str, Any]],
) -> list[dict[str, str]]:
    payload = {
        "profile": _pick_fields(profile, _PROFILE_FIELDS),
        "questions": [_pick_fields(item, _QUESTION_FIELDS) for item in questions],
        "sources": [_pick_fields(item, _SOURCE_FIELDS) for item in sources],
    }
    return [
        {"role": "system", "content": f"{_COMMON_SYSTEM_RULES}\n{_WRONG_EXPORT_CONTRACT}"},
        {"role": "user", "content": _serialize_user_payload(payload)},
    ]


def build_review_handout_messages(
    profile: dict[str, Any],
    weakness: dict[str, Any],
    questions: list[dict[str, Any]],
    sources: list[dict[str, Any]],
) -> list[dict[str, str]]:
    payload = {
        "profile": _pick_fields(profile, _PROFILE_FIELDS),
        "weakness": _pick_fields(weakness, _WEAKNESS_FIELDS),
        "questions": [_pick_fields(item, _QUESTION_FIELDS) for item in questions],
        "sources": [_pick_fields(item, _SOURCE_FIELDS) for item in sources],
    }
    return [
        {"role": "system", "content": f"{_COMMON_SYSTEM_RULES}\n{_HANDOUT_CONTRACT}"},
        {"role": "user", "content": _serialize_user_payload(payload)},
    ]
