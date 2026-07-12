from __future__ import annotations

import re
from collections import Counter

from backend.apps.knowledge_base.models import KnowledgeResource, ResourceScope
from backend.apps.profiles.models import LearnerProfile


PERSONAL_MATERIAL_SCHEMA_VERSION = "a3.personal-material.v1"


class PersonalMaterialAgent:
    def analyze(self, resource: KnowledgeResource) -> dict:
        text = _resource_text(resource)
        knowledge_points = _extract_knowledge_points(resource.original_name, text)
        material_type = _infer_material_type(resource, text)
        summary = _build_summary(resource, material_type, knowledge_points, text)
        weak_points = knowledge_points[:4]
        return {
            "schemaVersion": PERSONAL_MATERIAL_SCHEMA_VERSION,
            "resourceId": str(resource.id),
            "resourceName": resource.original_name,
            "materialType": material_type,
            "summary": summary,
            "knowledgePoints": knowledge_points,
            "weakPointSignals": weak_points,
            "recommendedTasks": [
                {
                    "title": f"复习：{point}",
                    "reason": f"来自你上传的资料《{resource.original_name}》，建议优先梳理该知识点。",
                    "sourceResourceId": str(resource.id),
                    "sourceScope": resource.resource_scope,
                }
                for point in knowledge_points[:3]
            ],
            "writeback": {
                "profileUpdated": False,
            },
        }

    def analyze_and_writeback(self, resource: KnowledgeResource) -> dict:
        result = self.analyze(resource)
        resource.student_profile_snapshot = result
        resource.save(update_fields=["student_profile_snapshot", "updated_at"])
        if resource.resource_scope != ResourceScope.PERSONAL:
            return result

        profile, _ = LearnerProfile.objects.get_or_create(user=resource.owner)
        profile.weak_points = _merge_unique(
            [*result["weakPointSignals"], *(profile.weak_points if isinstance(profile.weak_points, list) else [])],
            limit=10,
        )
        extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        materials = extra.get("personalMaterials") if isinstance(extra.get("personalMaterials"), list) else []
        compact = {
            "schemaVersion": result["schemaVersion"],
            "resourceId": result["resourceId"],
            "resourceName": result["resourceName"],
            "materialType": result["materialType"],
            "summary": result["summary"],
            "knowledgePoints": result["knowledgePoints"][:8],
            "recommendedTasks": result["recommendedTasks"][:3],
        }
        materials = [item for item in materials if not isinstance(item, dict) or item.get("resourceId") != result["resourceId"]]
        extra["personalMaterials"] = [compact, *materials][:12]
        profile.extra_profile = extra
        profile.save(update_fields=["weak_points", "extra_profile", "updated_at"])
        result["writeback"]["profileUpdated"] = True
        resource.student_profile_snapshot = result
        resource.save(update_fields=["student_profile_snapshot", "updated_at"])
        return result


def _resource_text(resource: KnowledgeResource) -> str:
    chunks = [
        block.text
        for block in resource.blocks.order_by("created_at")[:80]
        if isinstance(block.text, str) and block.text.strip()
    ]
    return "\n".join(chunks)[:8000]


def _infer_material_type(resource: KnowledgeResource, text: str) -> str:
    name = resource.original_name.lower()
    body = text.lower()
    if any(token in name or token in body for token in ["错题", "wrong question", "订正"]):
        return "wrong_question"
    if any(token in name or token in body for token in ["作业", "homework", "习题"]):
        return "homework"
    if any(token in name or token in body for token in ["笔记", "note"]):
        return "note"
    if any(token in name or token in body for token in ["教材", "textbook"]):
        return "textbook"
    if resource.file_type.lower() in {".pptx", ".pdf"}:
        return "courseware"
    return "note"


def _extract_knowledge_points(name: str, text: str) -> list[str]:
    candidates = []
    normalized = f"{name}\n{text}"
    domain_suffixes = (
        "条件",
        "应力",
        "系数",
        "截面",
        "算法",
        "定理",
        "原理",
        "方法",
        "模型",
        "公式",
        "概念",
        "调度",
        "管理",
        "同步",
        "置换",
        "系统",
    )
    suffix_pattern = "|".join(re.escape(suffix) for suffix in domain_suffixes)
    candidates.extend(re.findall(rf"[\u4e00-\u9fff]{{2}}(?:{suffix_pattern})", normalized))
    phrase_patterns = [
        "操作系统",
        "进程管理",
        "进程调度",
        "处理机调度",
        "进程同步",
        "互斥",
        "信号量",
        "死锁",
        "银行家算法",
        "存储器管理",
        "虚拟内存",
        "页面置换",
        "文件系统",
        "磁盘调度",
    ]
    for phrase in phrase_patterns:
        if phrase in normalized:
            candidates.append(phrase)
    cjk_terms = re.findall(r"[\u4e00-\u9fff]{2,8}", normalized)
    stop_words = {"上传资料", "本地资料", "知识库", "课件", "材料", "学习", "进行", "包括", "通过", "判断"}
    counts = Counter(term for term in cjk_terms if term not in stop_words)
    for term, _count in counts.most_common(12):
        if len(term) >= 2:
            candidates.append(term)
    return _merge_unique(candidates, limit=8) or ["资料复习"]


def _build_summary(resource: KnowledgeResource, material_type: str, knowledge_points: list[str], text: str) -> str:
    points = "、".join(knowledge_points[:4])
    if text.strip():
        return f"这份{_material_type_label(material_type)}《{resource.original_name}》主要涉及{points}，可用于生成个人复习任务和课堂追问。"
    return f"这份{_material_type_label(material_type)}《{resource.original_name}》已入库，建议结合渲染图和 OCR 结果继续复习。"


def _material_type_label(material_type: str) -> str:
    return {
        "courseware": "课件",
        "note": "笔记",
        "homework": "作业",
        "wrong_question": "错题资料",
        "textbook": "教材",
    }.get(material_type, "资料")


def _merge_unique(values: list[str], *, limit: int) -> list[str]:
    merged = []
    seen = set()
    for value in values:
        text = str(value).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        merged.append(text)
        if len(merged) >= limit:
            break
    return merged
