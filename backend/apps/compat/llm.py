from __future__ import annotations

import json
import os
from typing import Any

import requests


DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen-plus"


class LLMUnavailable(RuntimeError):
    pass


def chat_completion(
    messages: list[dict],
    *,
    temperature: float = 0.2,
    max_tokens: int = 800,
    timeout_seconds: float | None = None,
    response_format: dict | None = None,
) -> dict:
    api_key = (
        os.getenv("A3_LLM_API_KEY")
        or os.getenv("DASHSCOPE_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or ""
    ).strip()
    if not api_key:
        raise LLMUnavailable("A3_LLM_API_KEY is not configured")
    base_url = (os.getenv("A3_LLM_BASE_URL") or os.getenv("DASHSCOPE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("A3_LLM_MODEL") or os.getenv("AI_MODEL") or DEFAULT_MODEL
    timeout = timeout_seconds if timeout_seconds is not None else float(os.getenv("A3_LLM_TIMEOUT_SECONDS", "12"))
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format:
        payload["response_format"] = response_format
    response = requests.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    choice = data.get("choices", [{}])[0] if isinstance(data.get("choices"), list) else {}
    content = str(choice.get("message", {}).get("content") or "").strip()
    if not content:
        raise LLMUnavailable("LLM returned empty content")
    return {
        "content": content,
        "provider": "dashscope",
        "model": model,
        "fallback": False,
        "finishReason": str(choice.get("finish_reason") or ""),
        "usage": data.get("usage") if isinstance(data.get("usage"), dict) else {},
    }


def generate_tutoring_answer(question: str, *, target: dict, sources: list[dict]) -> dict:
    evidence = _format_sources(sources)
    target_title = str(target.get("title") or "当前知识点")
    try:
        messages = [
                {
                    "role": "system",
                    "content": (
                        "你是 A3 智学引擎的面对面学习辅导 Agent，必须围绕当前学习目标和给定资料回答。"
                        "不要写死任何学科，不要编造教材、页码、实验数据或来源；资料不足时明确标注未验证。"
                        "如果命中的资料片段是目录、章节列表或概览页，只能说“当前命中的是目录/概览页，仍需正文证据”，"
                        "不得断言整份资料只有目录，也不得据此否定教材中不存在正文内容。"
                        "输出必须是严格 Markdown：可以使用三级标题、短段落和项目符号；"
                        "数学公式必须使用行内 $...$ 或块级 $$...$$，不要把公式放进代码块；"
                        "中文解释、标题、结论、表格文字不能包在 $$ 中，块级 $$...$$ 只能用于整块完全是公式的内容。"
                        "结构化对比、考查点说明或评分维度必须使用标准 Markdown 表格，"
                        "例如 | 列名 | 列名 |，下一行使用 | --- | --- |；每一行必须单独换行，不要把竖线表格写成普通段落。"
                        "推导题必须完整收尾：给出最终表达式、关键结论和下一步练习建议，不能在公式或等号处结束。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"当前学习目标：{target_title}\n"
                        f"学生问题：{question}\n"
                        f"可用资料：\n{evidence}\n"
                        "请用中文回答，优先给出可执行的讲解、例子和下一步练习。"
                        "若引用资料，请用 [1]、[2] 标注依据；若没有足够证据，请写明“未验证”。"
                        "如果涉及计算或推导，必须写完最后一步和结论后再结束。"
                    ),
                },
            ]
        result = chat_completion(
            messages,
            temperature=0.2,
            max_tokens=int(os.getenv("A3_TUTORING_LLM_MAX_TOKENS", "1400")),
            timeout_seconds=float(os.getenv("A3_TUTORING_LLM_TIMEOUT_SECONDS", "35")),
        )
        if _needs_tutoring_continuation(result):
            continuation = chat_completion(
                [
                    *messages,
                    {"role": "assistant", "content": result["content"]},
                    {
                        "role": "user",
                        "content": "上一条回答被截断了。请只从断点继续，补完剩余推导、结论和下一步练习建议；不要重复已经写过的内容。",
                    },
                ],
                temperature=0.2,
                max_tokens=int(os.getenv("A3_TUTORING_LLM_CONTINUATION_MAX_TOKENS", "700")),
                timeout_seconds=float(os.getenv("A3_TUTORING_LLM_TIMEOUT_SECONDS", "35")),
            )
            result = {
                **result,
                "content": _join_tutoring_continuation(result["content"], continuation["content"]),
                "finishReason": continuation.get("finishReason") or result.get("finishReason"),
                "continuationUsed": True,
            }
        return {"answer": result["content"], **_llm_meta(result)}
    except Exception as exc:
        return {
            "answer": _fallback_tutoring_answer(question, target_title, sources),
            "provider": "rules",
            "model": "",
            "fallback": True,
            "error": str(exc),
        }


def generate_planner_adjustment(*, profile: dict, path: dict, goal: str = "") -> dict:
    items = path.get("items") if isinstance(path.get("items"), list) else []
    path_titles = [
        str((item.get("knowledgePoint") or {}).get("title") or "").strip()
        for item in items[:6]
        if isinstance(item, dict)
    ]
    try:
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "你是学习路径规划审阅 Agent。只能给出解释和微调建议，不能改变已经落库的路径。"
                        "建议必须尊重先修关系、薄弱点优先和每日学习时间。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"目标：{goal or '个性化学习路径'}\n"
                        f"画像：{json.dumps(profile, ensure_ascii=False)}\n"
                        f"规则候选路径：{json.dumps(path_titles, ensure_ascii=False)}\n"
                        "请输出一段不超过 120 字的计划调整建议。"
                    ),
                },
            ],
            temperature=0.2,
            max_tokens=300,
        )
        return {"advice": result["content"], **_llm_meta(result)}
    except Exception as exc:
        return {
            "advice": _fallback_planner_advice(profile, path_titles),
            "provider": "rules",
            "model": "",
            "fallback": True,
            "error": str(exc),
        }


def _llm_meta(result: dict[str, Any]) -> dict:
    return {
        "provider": str(result.get("provider") or "dashscope"),
        "model": str(result.get("model") or DEFAULT_MODEL),
        "fallback": bool(result.get("fallback")),
        "finishReason": str(result.get("finishReason") or ""),
        "continuationUsed": bool(result.get("continuationUsed")),
    }


def _needs_tutoring_continuation(result: dict[str, Any]) -> bool:
    content = str(result.get("content") or "").strip()
    finish_reason = str(result.get("finishReason") or "").strip().lower()
    if finish_reason in {"length", "max_tokens"}:
        return True
    if not content:
        return False
    unfinished_tails = ("=", "+", "-", "：", ":", "，", ",", "、", "；", ";", "$", "\\")
    if content.endswith(unfinished_tails):
        return True
    tail = content[-80:]
    return tail.count("$") % 2 == 1 or tail.count("$$") % 2 == 1


def _join_tutoring_continuation(first: str, continuation: str) -> str:
    left = str(first or "").rstrip()
    right = str(continuation or "").lstrip()
    if not right:
        return left
    return f"{left}\n\n{right}"


def _format_sources(sources: list[dict]) -> str:
    if not sources:
        return "无可用资料"
    rows = []
    for index, source in enumerate(sources[:5], start=1):
        title = str(source.get("title") or f"资料 {index}")
        location = str(source.get("location") or "")
        snippet = str(source.get("snippet") or "")[:500]
        rows.append(f"[{index}] {title} {location}\n{snippet}")
    return "\n\n".join(rows)


def _fallback_tutoring_answer(question: str, target_title: str, sources: list[dict]) -> str:
    citation = sources[0] if sources else {}
    source_title = citation.get("title") or "当前资料"
    return (
        "### 暂时使用规则降级回答\n\n"
        f"- 你的问题是：{question}\n"
        f"- 当前目标是：{target_title}\n"
        f"- 可参考来源：{source_title}\n\n"
        "建议先把该知识点拆成“定义、关键条件、典型例题、易错点”四部分。"
        "如果需要更精确的结论，请继续上传教材片段或课堂资料，系统会重新进行 RAG 检索和引用验证。"
    )


def _fallback_planner_advice(profile: dict, path_titles: list[str]) -> str:
    weak_points = profile.get("weakPoints") if isinstance(profile.get("weakPoints"), list) else []
    daily = profile.get("dailyStudyTime") or profile.get("dailyMinutes") or ""
    first = path_titles[0] if path_titles else "当前路径首个知识点"
    return f"规则路径已优先安排“{first}”；建议结合薄弱点{weak_points[:2]}和每日 {daily} 分钟节奏推进。"
