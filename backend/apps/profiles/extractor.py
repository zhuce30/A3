"""
LLM-powered profile extractor: 从对话文本中抽取结构化 LearnerProfile 字段。
使用 DashScope (Qwen) 兼容 OpenAI 接口。
"""
from __future__ import annotations

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

EXTRACTION_SYSTEM_PROMPT = """你是一个学习画像分析专家。请从学生的自我介绍或对话历史中，提取结构化的学习画像信息。

只返回 JSON 对象，不要任何其他文字。字段说明：
- grade: 年级，如"大一""大二""大三""大四""研究生""其他"，无法判断则返回 ""
- major_direction: 学科方向，如"计算机科学与技术""软件工程"等，无法判断则返回 ""
- foundation_level: 基础水平，只能是以下之一："基础较弱""基础一般""基础较好""基础扎实"，无法判断则返回 ""
- daily_study_time: 每日学习时长（分钟），整数，如 30/60/120/180，无法判断则返回 0
- pace: 学习节奏，只能是 "relaxed"（稳扎稳打）/"standard"（标准）/"intensive"（强化提升），无法判断则返回 ""
- learning_goals: 学习目标列表，字符串数组，最多6项
- weak_points: 薄弱知识点列表，字符串数组，最多8项
- learning_preferences: 学习偏好，如 {"style": "例题推导", "format": "视频课程"}，无法判断则返回 {}
- expected_resources: 期望资源列表，如 ["课件讲义", "练习题库"]，最多6项
- confidence: 整体提取置信度，0.0~1.0

示例输出：
{
  "grade": "大二",
  "major_direction": "计算机科学与技术",
  "foundation_level": "基础较弱",
  "daily_study_time": 60,
  "pace": "standard",
  "learning_goals": ["掌握操作系统", "应对课程考试"],
  "weak_points": ["处理机调度", "虚拟内存"],
  "learning_preferences": {"style": "例题推导"},
  "expected_resources": ["课件讲义", "练习题库"],
  "confidence": 0.85
}"""


def extract_profile_from_text(text: str, existing_profile: dict | None = None) -> dict:
    """
    从自由文本中抽取 LearnerProfile 字段。

    Args:
        text: 学生输入的自我介绍或对话文本
        existing_profile: 已有画像数据（可选），用于增量更新

    Returns:
        提取到的画像字段 dict，失败则返回 {}
    """
    if not text or not text.strip():
        return {}

    prompt_parts = [f"请分析以下学生输入，提取学习画像：\n\n{text.strip()}"]
    if existing_profile:
        prompt_parts.append(
            f"\n\n当前已有画像：{json.dumps(existing_profile, ensure_ascii=False)}\n"
            "请在此基础上更新（保留已有合理信息，覆盖或补充新信息）。"
        )

    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=os.getenv("AI_MODEL", "qwen-plus"),
            messages=[
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": "\n".join(prompt_parts)},
            ],
            max_tokens=800,
            temperature=0.2,
        )
        raw = response.choices[0].message.content.strip()
        # 去掉可能的 markdown 代码块包装
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.info("Profile extraction JSON parse fallback: %s", exc)
        return _rule_based_profile_fallback(text, existing_profile=existing_profile)
    except Exception as exc:
        logger.info("Profile extraction fallback used: %s", exc)
        return _rule_based_profile_fallback(text, existing_profile=existing_profile)


def _rule_based_profile_fallback(text: str, existing_profile: dict | None = None) -> dict:
    """Deterministic fallback for demo/offline profile extraction."""
    normalized = text.lower()
    existing_profile = existing_profile or {}
    extracted: dict = {}

    grade_rules = [
        (("大一", "freshman", "first year", "year 1"), "大一"),
        (("大二", "sophomore", "second year", "year 2"), "大二"),
        (("大三", "junior", "third year", "year 3"), "大三"),
        (("大四", "senior", "fourth year", "year 4"), "大四"),
        (("研究生", "graduate", "postgraduate", "master"), "研究生"),
    ]
    for keywords, value in grade_rules:
        if any(keyword in normalized or keyword in text for keyword in keywords):
            extracted["grade"] = value
            break

    major_rules = [
        (("computer science", "computer", "计算机", "计科"), "计算机科学与技术"),
        (("software", "软件"), "软件工程"),
        (("network", "网络"), "网络工程"),
        (("security", "信息安全", "网安"), "信息安全"),
        (("ai", "artificial intelligence", "人工智能"), "人工智能"),
    ]
    for keywords, value in major_rules:
        if any(keyword in normalized or keyword in text for keyword in keywords):
            extracted["major_direction"] = value
            break

    if any(keyword in normalized or keyword in text for keyword in ("weak", "poor foundation", "基础弱", "基础薄弱", "基础较弱")):
        extracted["foundation_level"] = "基础较弱"
    elif any(keyword in normalized or keyword in text for keyword in ("solid", "strong", "基础扎实", "基础较好")):
        extracted["foundation_level"] = "基础扎实"
    elif any(keyword in normalized or keyword in text for keyword in ("average", "一般", "中等")):
        extracted["foundation_level"] = "基础一般"

    minute_match = re.search(r"(\d{2,3})\s*(?:minutes?|mins?|分钟)", normalized)
    hour_match = re.search(r"(\d(?:\.\d+)?)\s*(?:hours?|小时)", normalized)
    if minute_match:
        extracted["daily_study_time"] = int(minute_match.group(1))
    elif hour_match:
        extracted["daily_study_time"] = int(float(hour_match.group(1)) * 60)

    if any(keyword in normalized or keyword in text for keyword in ("intensive", "冲刺", "强化")):
        extracted["pace"] = "intensive"
    elif any(keyword in normalized or keyword in text for keyword in ("relaxed", "轻松", "慢一点")):
        extracted["pace"] = "relaxed"

    weak_points = []
    weak_rules = [
        (("root locus", "根轨迹"), "根轨迹基本规则"),
        (("process scheduling", "cpu scheduling", "调度", "处理机调度"), "处理机调度算法"),
        (("process", "pcb", "进程"), "进程与 PCB"),
        (("thread", "线程"), "线程与并发执行"),
        (("semaphore", "mutex", "信号量", "互斥", "同步"), "同步互斥与信号量"),
        (("deadlock", "死锁"), "死锁条件与处理"),
        (("virtual memory", "page replacement", "虚拟内存", "页面置换"), "虚拟内存与页面置换"),
        (("file system", "文件系统", "目录"), "文件系统与目录"),
        (("disk scheduling", "磁盘调度"), "磁盘调度与存储管理"),
    ]
    for keywords, value in weak_rules:
        if any(keyword in normalized or keyword in text for keyword in keywords):
            weak_points.append(value)
    if weak_points:
        extracted["weak_points"] = weak_points[:8]

    goals = []
    if any(keyword in normalized or keyword in text for keyword in ("exam", "考试", "期末")):
        goals.append("应对课程考试")
    if any(keyword in normalized or keyword in text for keyword in ("operating system", "operating systems", "操作系统")):
        goals.append("掌握操作系统")
    if any(keyword in normalized or keyword in text for keyword in ("practice", "练习", "刷题")):
        goals.append("通过练习巩固薄弱点")
    if goals:
        extracted["learning_goals"] = goals[:6]

    resources = []
    if any(keyword in normalized or keyword in text for keyword in ("practice", "question", "练习", "题")):
        resources.append("练习题库")
    if any(keyword in normalized or keyword in text for keyword in ("example", "worked example", "例题")):
        resources.append("例题讲解")
    if any(keyword in normalized or keyword in text for keyword in ("video", "视频")):
        resources.append("视频课程")
    if resources:
        extracted["expected_resources"] = resources[:6]

    if any(keyword in normalized or keyword in text for keyword in ("example", "例题")):
        extracted["learning_preferences"] = {"style": "例题推导"}

    extracted["confidence"] = 0.55 if extracted else 0.0
    return extracted


def _get_client():
    """返回配置好的 OpenAI 兼容客户端（DashScope/Qwen）。"""
    try:
        from openai import OpenAI  # type: ignore
    except ImportError as exc:
        raise RuntimeError("openai 包未安装，请执行 pip install openai") from exc

    api_key = os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY", "")
    base_url = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    return OpenAI(api_key=api_key, base_url=base_url)


def map_extracted_to_profile_fields(extracted: dict) -> dict:
    """
    将 LLM 抽取结果映射为可直接写入 LearnerProfile 的字段 dict。
    过滤掉无效值，不返回 'confidence'。
    """
    valid_grades = {"大一", "大二", "大三", "大四", "研究生", "其他"}
    valid_foundation = {"基础较弱", "基础一般", "基础较好", "基础扎实"}
    valid_paces = {"relaxed", "standard", "intensive"}

    result: dict = {}

    grade = extracted.get("grade", "")
    if grade in valid_grades:
        result["grade"] = grade

    major = str(extracted.get("major_direction", "")).strip()
    if major:
        result["major_direction"] = major[:128]

    foundation = extracted.get("foundation_level", "")
    if foundation in valid_foundation:
        result["foundation_level"] = foundation

    daily = extracted.get("daily_study_time")
    if isinstance(daily, int) and 10 <= daily <= 480:
        result["daily_study_time"] = daily

    pace = extracted.get("pace", "")
    if pace in valid_paces:
        result["pace"] = pace

    goals = extracted.get("learning_goals")
    if isinstance(goals, list):
        result["learning_goals"] = [str(g).strip() for g in goals if str(g).strip()][:6]

    weak = extracted.get("weak_points")
    if isinstance(weak, list):
        result["weak_points"] = [str(w).strip() for w in weak if str(w).strip()][:8]

    prefs = extracted.get("learning_preferences")
    if isinstance(prefs, dict):
        result["learning_preferences"] = prefs

    resources = extracted.get("expected_resources")
    if isinstance(resources, list):
        result["expected_resources"] = [str(r).strip() for r in resources if str(r).strip()][:6]

    return result
