from __future__ import annotations

from dataclasses import dataclass
import json
import os

import requests


@dataclass(frozen=True)
class SafetyResult:
    safe: bool
    category: str
    reason: str

    def as_dict(self) -> dict:
        return {
            "safe": self.safe,
            "category": self.category,
            "reason": self.reason,
        }


_BLOCKED_PATTERNS: tuple[tuple[str, tuple[str, ...], str], ...] = (
    ("privacy", ("身份证", "手机号", "家庭住址", "个人隐私", "个人信息", "同学的个人信息", "泄露", "盗取账号", "密码"), "涉及个人隐私或账号安全"),
    ("academic_misconduct", ("代写", "替考", "作弊", "考试答案", "直接给我答案", "伪造", "抄袭", "直接提交", "绕过学校", "绕过检测", "学习平台检测", "考试监控", "躲避监控"), "涉及学术不端"),
    ("harmful", ("自残", "自杀", "伤害他人", "爆炸物", "投毒", "违法"), "涉及危险或违法内容"),
    ("out_of_scope", ("彩票", "股票内幕", "医疗诊断", "法律意见"), "超出教育学习助手能力边界"),
)


def check_learning_safety(text: str) -> SafetyResult:
    normalized = str(text or "").strip().lower()
    if not normalized:
        return SafetyResult(False, "empty", "输入内容为空")
    for category, keywords, reason in _BLOCKED_PATTERNS:
        if any(keyword.lower() in normalized for keyword in keywords):
            return SafetyResult(False, category, reason)
    llm_result = _optional_llm_safety_check(str(text or ""))
    if llm_result is not None:
        return llm_result
    return SafetyResult(True, "learning", "符合课程学习问答范围")


def _optional_llm_safety_check(text: str) -> SafetyResult | None:
    api_key = os.getenv("A3_SAFETY_LLM_API_KEY", "").strip()
    if not api_key:
        return None
    base_url = os.getenv("A3_SAFETY_LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
    model = os.getenv("A3_SAFETY_LLM_MODEL", "qwen-plus")
    try:
        response = requests.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "temperature": 0,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是教育学习系统的安全分类器。只输出 JSON："
                            "{\"safe\": boolean, \"category\": string, \"reason\": string}。"
                            "拦截隐私、学术不端、危险违法、医疗法律金融等越界建议。"
                        ),
                    },
                    {"role": "user", "content": text[:2000]},
                ],
            },
            timeout=8,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
        return SafetyResult(
            safe=bool(data.get("safe")),
            category=str(data.get("category") or "llm_review"),
            reason=str(data.get("reason") or "LLM safety review"),
        )
    except Exception:
        return None
