import ipaddress
import json
import re
import socket
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


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
confusions 中每项包含 conceptA、conceptB、difference；没有明确易混概念时输出空数组，不得输出字符串数组。
questionAnalyses 中每项必须使用输入中的 questionId，并包含 deepErrorDiagnosis、solutionSteps、selfCheck、reviewAdvice、citationIds。
questionAnalyses 的 deepErrorDiagnosis、selfCheck、reviewAdvice 是文本，solutionSteps、citationIds 是文本数组。
transferPractice 中每项包含 prompt、answer、explanation、difficulty、citationIds；difficulty 只能是“基础”或“进阶”。
transferPractice 的 prompt、answer、explanation、difficulty 是文本，citationIds 是文本数组。
evidenceStatus 只能是 verified、partial 或 unverified。
严格使用以下 JSON 类型骨架，示例文字需替换为基于输入的内容：
{"knowledgePoint":"知识点","groupDiagnosis":"诊断文本","prerequisiteGaps":["缺口文本"],"confusions":[{"conceptA":"概念甲","conceptB":"概念乙","difference":"差异文本"}],"questionAnalyses":[{"questionId":"输入中的题目ID","deepErrorDiagnosis":"诊断文本","solutionSteps":["步骤文本"],"selfCheck":"检查文本","reviewAdvice":"建议文本","citationIds":[]}],"transferPractice":[{"prompt":"练习题干","answer":"练习答案","explanation":"练习解析","difficulty":"基础","citationIds":[]}],"evidenceStatus":"unverified"}"""

_HANDOUT_CONTRACT = """输出对象必须包含 knowledgePoint、learningDiagnosis、coreConcept、prerequisites、commonErrorPatterns、method、workedExample、tieredPractice、reviewActions、citationIds、evidenceStatus。
knowledgePoint、learningDiagnosis、coreConcept 是文本；prerequisites、commonErrorPatterns、method、reviewActions、citationIds 都是文本数组。
tieredPractice 必须提供基础、巩固、迁移三种分层练习，每项包含 level、prompt、answer、explanation。
tieredPractice 每项的 level、prompt、answer、explanation 都是文本。
workedExample 必须包含 prompt、steps、answer，其中 prompt、answer 是文本，workedExample.steps 是文本数组。
evidenceStatus 只能是 verified、partial 或 unverified。
严格使用以下 JSON 类型骨架，示例文字需替换为基于输入的内容：
{"knowledgePoint":"知识点","learningDiagnosis":"诊断文本","coreConcept":"概念文本","prerequisites":["先修文本"],"commonErrorPatterns":["错误文本"],"method":["方法步骤"],"workedExample":{"prompt":"例题题干","steps":["步骤文本"],"answer":"例题答案"},"tieredPractice":[{"level":"基础","prompt":"练习题干","answer":"练习答案","explanation":"练习解析"},{"level":"巩固","prompt":"练习题干","answer":"练习答案","explanation":"练习解析"},{"level":"迁移","prompt":"练习题干","answer":"练习答案","explanation":"练习解析"}],"reviewActions":["复习行动"],"citationIds":[],"evidenceStatus":"unverified"}"""


_WINDOWS_PATH = re.compile(r"(?i)(?<![\w])(?:[a-z]:[\\/])[^\s\"'，。；;]+")
_UNC_PATH = re.compile(r"(?<![\w])\\\\[^\s\"'，。；;]+")
_UNIX_PATH = re.compile(r"(?<![\w:])/(?:[^\s/\"'，。；;]+/)*[^\s\"'，。；;]+")
_FILE_URI = re.compile(r"(?i)file:(?:/{1,3})?[^\s\"'，。；;]+")
_KEY_LIKE_VALUE = re.compile(
    r"(?i)(?:sk|rk|pk|api[_-]?key|dashscope|qwen)[_-][A-Za-z0-9_-]{12,}"
)
_REDACTED = "[已移除敏感信息]"
_PUBLIC_URL = re.compile(r"(?i)https?://[^\s\"'，。；;]+")


def _is_sensitive_key(key: Any) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", str(key).casefold())
    return normalized in {
        "key",
        "apikey",
        "accesskey",
        "secretkey",
        "privatekey",
        "authorization",
        "cookie",
        "password",
        "passwd",
        "secret",
        "session",
        "sessionid",
        "token",
        "phone",
        "phonenumber",
        "mobile",
        "mobilenumber",
        "mobilephone",
        "signature",
        "sig",
        "sas",
        "credential",
        "xamzsignature",
        "xamzcredential",
        "xgoogsignature",
    } or normalized.endswith(("apikey", "privatekey", "password", "passwd", "secret", "token"))


def _sanitize_public_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url)
    hostname = (parsed.hostname or "").casefold().rstrip(".")
    if (
        not hostname
        or parsed.username is not None
        or parsed.password is not None
        or hostname == "localhost"
        or hostname.endswith((".localhost", ".local"))
    ):
        return _REDACTED
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if re.fullmatch(r"[0-9.]+", hostname):
            try:
                address = ipaddress.ip_address(socket.inet_ntoa(socket.inet_aton(hostname)))
            except (OSError, ValueError):
                return _REDACTED
        elif "." not in hostname:
            return _REDACTED
        else:
            address = None
    if address is not None and not address.is_global:
        return _REDACTED
    if _KEY_LIKE_VALUE.search(parsed.path) or _KEY_LIKE_VALUE.search(parsed.fragment):
        return _REDACTED
    sanitized_query = urlencode(
        [
            (key, _REDACTED if _is_sensitive_key(key) else sanitize_prompt_value(item))
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        ],
        doseq=True,
    )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, sanitized_query, parsed.fragment))


def sanitize_prompt_value(value: Any) -> Any:
    """Recursively redact local paths and credential-like values from prompt data."""
    if isinstance(value, dict):
        return {
            key: _REDACTED if _is_sensitive_key(key) else sanitize_prompt_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_prompt_value(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_prompt_value(item) for item in value]
    if not isinstance(value, str):
        return value
    public_urls: list[str] = []

    def protect_public_url(match: re.Match[str]) -> str:
        sanitized_url = _sanitize_public_url(match.group(0))
        if sanitized_url == _REDACTED:
            return _REDACTED
        public_urls.append(sanitized_url)
        return f"A3PUBLICURLPLACEHOLDER{len(public_urls) - 1}"

    sanitized = _PUBLIC_URL.sub(protect_public_url, value)
    for pattern in (_FILE_URI, _WINDOWS_PATH, _UNC_PATH, _UNIX_PATH, _KEY_LIKE_VALUE):
        sanitized = pattern.sub(_REDACTED, sanitized)
    for index, public_url in enumerate(public_urls):
        sanitized = sanitized.replace(f"A3PUBLICURLPLACEHOLDER{index}", public_url)
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
