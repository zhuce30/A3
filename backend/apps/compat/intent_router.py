"""通用意图识别层。

课堂等界面的自由文本输入先过这里，判断用户想做什么，再由前端分发到对应能力
（问答 / 生成资源 / 练习 / 概念讲解 / 导航 / 错题复习）。设计成 surface 无关、可复用：
任何界面传入 text + 轻量 context，拿回结构化 {intent, confidence, params}。

分类走两层：
1) 规则快判——高频、表达稳定的意图（如"生成一个讲解视频"）直接命中，0 成本 0 延迟。
2) LLM 兜底——规则命中不了时调 chat_completion 做分类；LLM 不可用或低置信一律回退
   到 ask_question，保证永不卡住用户（最坏情况就是走默认问答）。
"""

from __future__ import annotations

import json
import re

# 意图 taxonomy（初版）。ask_question 是默认兜底意图。
INTENTS = (
    "ask_question",
    "generate_resource",
    "start_practice",
    "explain_concept",
    "navigate",
    "review_wrong",
)

MIN_LLM_INTENT_CONFIDENCE = 0.6

# 7 种资源类型（与 resource_generation.RESOURCE_TYPES 对齐）及其中文触发词。
RESOURCE_TYPE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "micro_video_script": ("视频", "讲解视频", "短视频", "动画"),
    "lecture_doc": ("讲义", "讲解文档", "文档", "课件"),
    "knowledge_card": ("卡片", "速记卡", "记忆卡", "知识卡"),
    "mind_map": ("思维导图", "导图", "脑图"),
    "practice_set": ("练习", "习题", "题目", "做题", "练习题"),
    "case_study": ("案例", "实践案例", "工程案例"),
    "code_lab": ("代码", "实验", "代码实验", "编程"),
}

_GENERATE_VERBS = ("生成", "做一个", "做个", "来一个", "来个", "给我", "帮我做", "制作", "出一个", "出个", "创建", "画一个", "画个", "画张", "整理")
_PRACTICE_HINTS = ("出题", "出几道", "做几道", "练习", "习题", "测一下", "考考我")
_REVIEW_HINTS = ("错题", "复习错", "我做错")
_NAVIGATE_HINTS = ("打开", "跳转", "进入", "去看", "带我去")
_EXPLAIN_HINTS = ("讲讲", "详细讲", "解释", "什么是", "怎么理解", "深入讲")

# 导航目标：命中词 -> 前端路由。
_NAVIGATE_ROUTES: dict[str, str] = {
    "学习报告": "/a3/report",
    "报告": "/a3/report",
    "学习路径": "/a3/learning-path",
    "路径": "/a3/learning-path",
    "错题本": "/a3/wrong-notebook",
    "知识库": "/a3/knowledge-base",
    "今日任务": "/a3/today",
    "资源推荐": "/a3/recommendations",
}


def classify_intent(text: str, *, context: dict | None = None, allow_llm: bool = True) -> dict:
    """返回 {intent, confidence, params, source}。source 标注是 rule 还是 llm 还是 fallback。"""
    cleaned = str(text or "").strip()
    context = context or {}
    if not cleaned:
        return _result("ask_question", 0.0, {}, "fallback")

    rule = _rule_classify(cleaned, context)
    if rule is not None:
        return rule

    if allow_llm:
        llm = _llm_classify(cleaned, context)
        if llm is not None:
            return llm

    # 兜底：当作普通问答。
    return _result("ask_question", 0.3, {}, "fallback")


def _rule_classify(text: str, context: dict) -> dict | None:
    lowered = text

    # 错题复习
    if any(hint in lowered for hint in _REVIEW_HINTS):
        return _result("review_wrong", 0.8, {}, "rule")

    # 生成资源：需要「生成类动词」或明确资源名 + 生成语气
    resource_type = _match_resource_type(lowered)
    has_generate_verb = any(verb in lowered for verb in _GENERATE_VERBS)
    if resource_type and has_generate_verb:
        goal = _extract_goal(context)
        return _result("generate_resource", 0.9, {"resourceType": resource_type, "goal": goal}, "rule")

    # 练习（练习词但不一定带"生成"）
    if any(hint in lowered for hint in _PRACTICE_HINTS):
        goal = _extract_goal(context)
        return _result("start_practice", 0.8, {"topic": goal}, "rule")

    # 导航
    if any(hint in lowered for hint in _NAVIGATE_HINTS):
        for keyword, route in _NAVIGATE_ROUTES.items():
            if keyword in lowered:
                return _result("navigate", 0.85, {"route": route, "label": keyword}, "rule")

    # 概念讲解
    if any(hint in lowered for hint in _EXPLAIN_HINTS):
        return _result("explain_concept", 0.6, {"concept": _strip_explain_prefix(lowered)}, "rule")

    return None


def _match_resource_type(text: str) -> str | None:
    # 更具体的资源词优先（先长后短，避免"文档"抢在"讲解文档"前面之类）。
    for resource_type, keywords in RESOURCE_TYPE_KEYWORDS.items():
        for keyword in sorted(keywords, key=len, reverse=True):
            if keyword in text:
                return resource_type
    return None


def _extract_goal(context: dict) -> str:
    for key in ("goal", "target", "topic", "title"):
        value = context.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            title = value.get("title")
            if isinstance(title, str) and title.strip():
                return title.strip()
    return ""


def _strip_explain_prefix(text: str) -> str:
    for hint in _EXPLAIN_HINTS:
        text = text.replace(hint, "")
    return re.sub(r"[，。？?、]", " ", text).strip() or text


def _llm_classify(text: str, context: dict) -> dict | None:
    try:
        from backend.apps.compat.llm import LLMUnavailable, chat_completion
    except Exception:  # noqa: BLE001 - 导入失败按 LLM 不可用处理
        return None

    goal = _extract_goal(context)
    system = (
        "你是 A3 智学引擎的意图路由器。判断学生输入属于以下哪一类意图，只输出 JSON："
        f"{list(INTENTS)}。"
        "generate_resource 需要给出 resourceType，取值范围："
        f"{list(RESOURCE_TYPE_KEYWORDS.keys())}。"
        "输出格式：{\"intent\": ..., \"confidence\": 0~1, \"params\": {...}}。"
        "无法判断时 intent 用 ask_question。"
    )
    user = json.dumps({"text": text, "currentGoal": goal}, ensure_ascii=False)
    try:
        result = chat_completion(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.0,
            max_tokens=200,
            response_format={"type": "json_object"},
        )
    except LLMUnavailable:
        return None
    except Exception:  # noqa: BLE001 - 分类失败不应影响主流程
        return None

    try:
        payload = json.loads(result.get("content") or "{}")
    except (json.JSONDecodeError, AttributeError):
        return None

    intent = str(payload.get("intent") or "ask_question")
    if intent not in INTENTS:
        intent = "ask_question"
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    try:
        confidence = float(payload.get("confidence") or 0.5)
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    if confidence < MIN_LLM_INTENT_CONFIDENCE:
        return _result("ask_question", confidence, {}, "fallback")
    if intent == "generate_resource":
        resource_type = str(params.get("resourceType") or "")
        if resource_type not in RESOURCE_TYPE_KEYWORDS:
            # LLM 说要生成但没给合法类型 → 降级为问答，避免瞎生成。
            return _result("ask_question", 0.4, {}, "llm")
        params.setdefault("goal", goal)
    return _result(intent, confidence, params, "llm")


def _result(intent: str, confidence: float, params: dict, source: str) -> dict:
    return {"intent": intent, "confidence": round(float(confidence), 2), "params": params or {}, "source": source}
