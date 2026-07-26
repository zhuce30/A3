from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
import re
from uuid import UUID, uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Max
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_datetime
from django.utils import timezone

from backend.apps.assessments.models import WrongQuestion
from backend.apps.compat.models import OpenMAICArtifact
from backend.apps.engagement.models import NotificationType, UserNotification
from backend.apps.engagement.services import create_notification, ensure_learning_reminders
from backend.apps.knowledge_base.display import format_source_display_location, format_source_type_label, source_origin_label
from backend.apps.knowledge_base.services import accessible_resources_for_user
from backend.apps.knowledge_base.models import IndexJobStatus, KnowledgeAsset, KnowledgeBlock, KnowledgeIndexJob, KnowledgeResource, ResourceScope, ResourceStatus
from backend.core.settings import FAISS_INDEX_DIR
from backend.domains.knowledge_base.lexical_retriever import search_lexical_knowledge_base
from backend.domains.knowledge_base.retriever import search_knowledge_base
from backend.apps.learning.effect_events import record_learning_event
from backend.apps.learning.models import CoachingMessage, CoachingMessageRole, CoachingSession, CoachingSessionStatus, Course, CourseEnrollment, CourseTeachingAssignment, Chapter, KnowledgePoint, KnowledgePrerequisite, LearningPath, LearningPathItem, LearningPathStatus, PathItemStatus, ResourcePackLog
from backend.apps.learning.tutor_personas import (
    public_tutor_persona,
    resolve_tutor_persona,
    resolve_user_tutor_preference,
    tutor_persona_configuration_fallback_used,
)
from backend.apps.profiles.models import LearnerProfile, LearningPace


DEFAULT_COURSE_CODE = "OS-001"


def _safe_record_learning_event(user, **kwargs):
    try:
        return record_learning_event(user, **kwargs)
    except Exception:
        return None

DEFAULT_COURSE_CATALOG = {
    "course": {
        "title": "操作系统",
        "description": "面向计算机专业核心课程，覆盖操作系统概述、进程管理、处理机调度、同步互斥、死锁、存储管理、虚拟内存、设备管理、文件系统和磁盘管理。",
        "edition": "A3 演示版",
    },
    "chapters": {
        1: ("操作系统概述", "理解操作系统的目标、功能、结构和用户态/内核态边界。"),
        2: ("进程描述与控制", "掌握进程、线程、PCB、进程状态转换和系统调用。"),
        3: ("处理机调度与死锁", "理解调度目标、典型调度算法、死锁条件、检测、避免和解除。"),
        4: ("进程同步与互斥", "掌握临界区、信号量、管程和经典同步问题。"),
        5: ("存储器管理", "理解连续分配、分页、分段、地址转换和内存保护。"),
        6: ("虚拟内存管理", "掌握请求分页、缺页中断、页面置换算法和抖动。"),
        7: ("设备管理", "理解 I/O 控制方式、缓冲、设备分配和中断处理。"),
        8: ("文件管理", "掌握文件逻辑结构、目录、外存分配和文件系统实现。"),
        9: ("磁盘存储器管理", "理解磁盘结构、磁盘调度算法和存储可靠性。"),
    },
    "points": {
        "OS-INTRO": ("操作系统功能与结构", "理解操作系统作为资源管理者和扩展机器的核心职责。"),
        "OS-PROCESS": ("进程与 PCB", "掌握进程定义、进程控制块、状态转换和上下文切换。"),
        "OS-THREAD": ("线程与并发执行", "区分进程和线程，理解用户级线程与内核级线程。"),
        "OS-SCHEDULING": ("处理机调度算法", "比较 FCFS、SJF、优先级、时间片轮转和多级反馈队列。"),
        "OS-DEADLOCK": ("死锁条件与处理", "掌握死锁四个必要条件、预防、避免、检测和解除。"),
        "OS-SYNC": ("同步互斥与信号量", "理解临界区、PV 操作、管程和经典同步问题。"),
        "OS-MEMORY": ("分页分段与地址转换", "掌握页表、段表、逻辑地址到物理地址的转换过程。"),
        "OS-VIRTUAL-MEMORY": ("虚拟内存与页面置换", "理解缺页中断、工作集、FIFO、LRU 和 OPT 页面置换算法。"),
        "OS-DEVICE": ("设备管理与 I/O", "掌握中断、DMA、缓冲、设备分配和 SPOOLing。"),
        "OS-FILE": ("文件系统与目录", "理解文件逻辑结构、目录组织、权限和外存分配方式。"),
        "OS-DISK": ("磁盘调度与存储管理", "比较 FCFS、SSTF、SCAN、C-SCAN 等磁盘调度算法。"),
    },
}

DEFAULT_COURSE_CHAPTER_SPECS = {
    1: ("操作系统概述", "理解操作系统的目标、功能、结构和用户态/内核态边界。", 90),
    2: ("进程描述与控制", "掌握进程、线程、PCB、进程状态转换和系统调用。", 120),
    3: ("处理机调度与死锁", "理解调度目标、典型调度算法、死锁条件、检测、避免和解除。", 150),
    4: ("进程同步与互斥", "掌握临界区、信号量、管程和经典同步问题。", 150),
    5: ("存储器管理", "理解连续分配、分页、分段、地址转换和内存保护。", 150),
    6: ("虚拟内存管理", "掌握请求分页、缺页中断、页面置换算法和抖动。", 150),
    7: ("设备管理", "理解 I/O 控制方式、缓冲、设备分配和中断处理。", 120),
    8: ("文件管理", "掌握文件逻辑结构、目录、外存分配和文件系统实现。", 120),
    9: ("磁盘存储器管理", "理解磁盘结构、磁盘调度算法和存储可靠性。", 120),
}

DEFAULT_COURSE_POINT_SPECS = {
    "OS-INTRO": (1, 1, "操作系统功能与结构", "理解操作系统作为资源管理者和扩展机器的核心职责。", 1, 35),
    "OS-PROCESS": (2, 1, "进程与 PCB", "掌握进程定义、进程控制块、状态转换和上下文切换。", 2, 45),
    "OS-THREAD": (2, 2, "线程与并发执行", "区分进程和线程，理解用户级线程与内核级线程。", 2, 40),
    "OS-SCHEDULING": (3, 1, "处理机调度算法", "比较 FCFS、SJF、优先级、时间片轮转和多级反馈队列。", 3, 55),
    "OS-DEADLOCK": (3, 2, "死锁条件与处理", "掌握死锁四个必要条件、预防、避免、检测和解除。", 4, 60),
    "OS-SYNC": (4, 1, "同步互斥与信号量", "理解临界区、PV 操作、管程和经典同步问题。", 4, 60),
    "OS-MEMORY": (5, 1, "分页分段与地址转换", "掌握页表、段表、逻辑地址到物理地址的转换过程。", 3, 55),
    "OS-VIRTUAL-MEMORY": (6, 1, "虚拟内存与页面置换", "理解缺页中断、工作集、FIFO、LRU 和 OPT 页面置换算法。", 4, 65),
    "OS-DEVICE": (7, 1, "设备管理与 I/O", "掌握中断、DMA、缓冲、设备分配和 SPOOLing。", 3, 45),
    "OS-FILE": (8, 1, "文件系统与目录", "理解文件逻辑结构、目录组织、权限和外存分配方式。", 3, 50),
    "OS-DISK": (9, 1, "磁盘调度与存储管理", "比较 FCFS、SSTF、SCAN、C-SCAN 等磁盘调度算法。", 3, 45),
}

DEFAULT_COURSE_EDGES = [
    ("OS-PROCESS", "OS-INTRO"),
    ("OS-THREAD", "OS-PROCESS"),
    ("OS-SCHEDULING", "OS-PROCESS"),
    ("OS-SYNC", "OS-PROCESS"),
    ("OS-DEADLOCK", "OS-SYNC"),
    ("OS-MEMORY", "OS-INTRO"),
    ("OS-VIRTUAL-MEMORY", "OS-MEMORY"),
    ("OS-DEVICE", "OS-INTRO"),
    ("OS-FILE", "OS-DEVICE"),
    ("OS-DISK", "OS-FILE"),
]

LEGACY_COURSE_TEXT_MARKERS = ("自动控制", "根轨迹", "传递函数", "频率响应", "反馈控制")


def default_course() -> Course | None:
    course = Course.objects.filter(code=DEFAULT_COURSE_CODE, is_active=True).first()
    if course:
        return _repair_default_course_catalog(course) or course
    return _repair_default_course_catalog()


def _repair_default_course_catalog(course: Course | None = None) -> Course | None:
    if course is not None and course.code != DEFAULT_COURSE_CODE:
        return course
    if course is None:
        course, _ = Course.objects.get_or_create(
            code=DEFAULT_COURSE_CODE,
            defaults={**DEFAULT_COURSE_CATALOG["course"], "is_active": True},
        )
    course_defaults = DEFAULT_COURSE_CATALOG["course"]
    changed = False
    for field, value in course_defaults.items():
        if getattr(course, field) != value:
            setattr(course, field, value)
            changed = True
    if changed:
        course.save(update_fields=[*course_defaults.keys(), "updated_at"])

    chapters = {}
    for order, (title, description, minutes) in DEFAULT_COURSE_CHAPTER_SPECS.items():
        chapter, _ = Chapter.objects.update_or_create(
            course=course,
            order=order,
            defaults={"title": title, "description": description, "estimated_minutes": minutes},
        )
        chapters[order] = chapter
    points = {}
    for code, (chapter_order, order, title, description, difficulty, minutes) in DEFAULT_COURSE_POINT_SPECS.items():
        point, _ = KnowledgePoint.objects.update_or_create(
            code=code,
            defaults={
                "chapter": chapters[chapter_order],
                "order": order,
                "title": title,
                "description": description,
                "difficulty": difficulty,
                "estimated_minutes": minutes,
            },
        )
        points[code] = point
    for point_code, prerequisite_code in DEFAULT_COURSE_EDGES:
        KnowledgePrerequisite.objects.get_or_create(
            knowledge_point=points[point_code],
            prerequisite=points[prerequisite_code],
        )
    from backend.apps.assessments.services import ensure_default_assessment_questions

    ensure_default_assessment_questions()
    return course


def serialize_course(course: Course, user=None, include_content: bool = False) -> dict:
    course = _repair_default_course_catalog(course) or course
    enrollment = CourseEnrollment.objects.filter(user=user, course=course).first() if user and user.is_authenticated else None
    payload = {
        "id": str(course.id), "code": course.code, "title": course.title,
        "description": course.description, "edition": course.edition, "cover": course.cover,
        "enrolled": enrollment is not None, "progress": enrollment.progress if enrollment else 0,
    }
    if include_content:
        payload["chapters"] = [{
            "id": str(chapter.id), "order": chapter.order, "title": chapter.title,
            "description": chapter.description, "estimatedMinutes": chapter.estimated_minutes,
            "knowledgePoints": [{
                "id": str(point.id), "code": point.code, "order": point.order, "title": point.title,
                "description": point.description, "difficulty": point.difficulty,
                "estimatedMinutes": point.estimated_minutes,
            } for point in chapter.knowledge_points.all()],
        } for chapter in course.chapters.all()]
    return payload


def course_materials(course: Course, user) -> dict:
    from backend.apps.knowledge_base.services import accessible_resources_for_user

    resources = list(
        accessible_resources_for_user(user)
        .filter(course_key=course.code, resource_scope__in=[ResourceScope.TEACHER, ResourceScope.CLASS, ResourceScope.GLOBAL])
        .order_by("original_name", "-updated_at")
    )
    chapters = list(course.chapters.prefetch_related("knowledge_points").all())
    grouped: dict[int, list[dict]] = {chapter.order: [] for chapter in chapters}
    course_wide: list[dict] = []

    for resource in resources:
        material = _serialize_course_material(resource)
        chapter_order = material["chapterOrder"]
        if chapter_order and chapter_order in grouped:
            grouped[chapter_order].append(material)
        else:
            course_wide.append(material)

    return {
        "schemaVersion": "a3.course-materials.v1",
        "course": {"id": str(course.id), "code": course.code, "title": course.title},
        "summary": {
            "total": len(resources),
            "chapterBound": sum(len(items) for items in grouped.values()),
            "courseWide": len(course_wide),
        },
        "chapters": [
            {
                "id": str(chapter.id),
                "order": chapter.order,
                "title": chapter.title,
                "materials": grouped.get(chapter.order, []),
            }
            for chapter in chapters
        ],
        "courseWideMaterials": course_wide,
        "evidence": {
            "source": "KnowledgeResource.course_key",
            "courseKey": course.code,
            "mapping": "优先使用资源元数据 chapterOrder，缺失时从文件名“第N章”推断。",
        },
    }


def _serialize_course_material(resource: KnowledgeResource) -> dict:
    metadata = resource.student_profile_snapshot if isinstance(resource.student_profile_snapshot, dict) else {}
    chapter_order = _material_chapter_order(resource, metadata)
    return {
        "id": str(resource.id),
        "name": resource.original_name,
        "type": resource.file_type.lstrip(".").upper(),
        "size": resource.file_size,
        "status": resource.status,
        "scope": resource.resource_scope,
        "chapterOrder": chapter_order,
        "role": str(metadata.get("materialRole") or ("courseware" if chapter_order else "textbook")),
        "source": str(metadata.get("source") or "course_material_import"),
        "downloadUrl": f"/api/kb/resources/{resource.id}/download/?disposition=inline",
        "parseUrl": f"/api/kb/resources/{resource.id}/parse/",
        "isIndexed": resource.status in {ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS},
        "isParsed": resource.pages.exists() or resource.blocks.exists(),
        "updatedAt": resource.updated_at.isoformat(),
    }


def _material_chapter_order(resource: KnowledgeResource, metadata: dict) -> int | None:
    raw = metadata.get("chapterOrder")
    try:
        if raw is not None and int(raw) > 0:
            return int(raw)
    except (TypeError, ValueError):
        pass
    match = re.search(r"第\s*(\d+)\s*章", resource.original_name)
    if match:
        return int(match.group(1))
    return None


def serialize_path_item(item: LearningPathItem) -> dict:
    point = item.knowledge_point
    return {
        "id": str(item.id), "order": item.order, "status": item.status, "progress": item.progress,
        "reason": item.reason, "estimatedMinutes": item.estimated_minutes,
        "completedAt": item.completed_at.isoformat() if item.completed_at else None,
        "knowledgePoint": {
            "id": str(point.id), "code": point.code, "title": point.title,
            "description": point.description, "difficulty": point.difficulty,
            "chapter": {"order": point.chapter.order, "title": point.chapter.title},
        },
    }


def serialize_path(path: LearningPath) -> dict:
    items = list(path.items.select_related("knowledge_point__chapter").all())
    completed = sum(item.status == PathItemStatus.COMPLETED for item in items)
    return {
        "id": str(path.id), "version": path.version, "status": path.status,
        "title": path.title, "rationale": path.rationale,
        "course": serialize_course(path.course),
        "progress": round(completed * 100 / len(items)) if items else 0,
        "items": [serialize_path_item(item) for item in items],
        "createdAt": path.created_at.isoformat(), "updatedAt": path.updated_at.isoformat(),
    }


def _profile_snapshot(user) -> dict:
    profile = getattr(user, "learner_profile", None)
    if not profile:
        return {"foundationLevel": "", "pace": "standard", "weakPoints": [], "learningGoals": []}
    return {
        "foundationLevel": profile.foundation_level, "pace": profile.pace,
        "dailyStudyTime": profile.daily_study_time,
        "weakPoints": profile.weak_points if isinstance(profile.weak_points, list) else [],
        "learningGoals": profile.learning_goals if isinstance(profile.learning_goals, list) else [],
    }


def _ordered_points(course: Course, profile: dict) -> list[KnowledgePoint]:
    points = list(KnowledgePoint.objects.filter(chapter__course=course).select_related("chapter").prefetch_related("prerequisite_edges__prerequisite"))
    by_id = {point.id: point for point in points}
    indegree = {point.id: 0 for point in points}
    dependents = defaultdict(list)
    for point in points:
        for edge in point.prerequisite_edges.all():
            if edge.prerequisite_id in by_id:
                indegree[point.id] += 1
                dependents[edge.prerequisite_id].append(point.id)
    weak_text = " ".join(str(value).lower() for value in profile.get("weakPoints", []))
    beginner = str(profile.get("foundationLevel", "")).lower() in {"beginner", "basic", "基础", "基础较弱", "薄弱"}

    def priority(point):
        weak_rank = 0 if point.title.lower() in weak_text or point.code.lower() in weak_text else 1
        return weak_rank, point.difficulty if beginner else 0, point.chapter.order, point.order, point.code

    available = sorted((by_id[node_id] for node_id, degree in indegree.items() if degree == 0), key=priority)
    result = []
    while available:
        point = available.pop(0)
        result.append(point)
        for dependent_id in dependents[point.id]:
            indegree[dependent_id] -= 1
            if indegree[dependent_id] == 0:
                available.append(by_id[dependent_id])
        available.sort(key=priority)
    if len(result) != len(points):
        raise ValueError("知识点先修关系存在循环，无法生成学习路径")
    return result


@transaction.atomic
def generate_learning_path(user, course: Course | None = None, force: bool = False) -> LearningPath:
    course = course or default_course()
    if not course:
        raise ValueError("暂无可用课程")
    course = _repair_default_course_catalog(course) or course
    CourseEnrollment.objects.get_or_create(user=user, course=course)
    existing = LearningPath.objects.filter(user=user, course=course, status=LearningPathStatus.ACTIVE).first()
    if existing and not force:
        return existing
    if existing:
        existing.status = LearningPathStatus.ARCHIVED
        existing.save(update_fields=["status", "updated_at"])
    version = (LearningPath.objects.filter(user=user, course=course).aggregate(Max("version"))["version__max"] or 0) + 1
    profile = _profile_snapshot(user)
    path = LearningPath.objects.create(
        user=user, course=course, version=version, title=f"{course.title}个性化学习路径",
        rationale={**profile, "strategy": "先修关系优先，同层节点按薄弱点和基础水平排序"},
    )
    weak_text = " ".join(str(value) for value in profile.get("weakPoints", []))
    LearningPathItem.objects.bulk_create([
        LearningPathItem(
            path=path, knowledge_point=point, order=index,
            status=PathItemStatus.CURRENT if index == 1 else PathItemStatus.LOCKED,
            reason="画像薄弱点优先强化" if point.title in weak_text else "依据知识点先修关系安排",
            estimated_minutes=point.estimated_minutes,
        ) for index, point in enumerate(_ordered_points(course, profile), start=1)
    ])
    return path


@transaction.atomic
def update_path_item_progress(user, item: LearningPathItem, progress: int) -> LearningPath:
    if item.path.user_id != user.id:
        raise PermissionError("无权修改该学习路径")
    if item.status == PathItemStatus.LOCKED:
        raise ValueError("请先完成前置学习节点")
    progress = max(0, min(100, int(progress)))
    item.progress = progress
    item.status = PathItemStatus.COMPLETED if progress == 100 else PathItemStatus.CURRENT
    item.completed_at = timezone.now() if progress == 100 else None
    item.save(update_fields=["progress", "status", "completed_at"])
    if progress == 100:
        next_item = item.path.items.filter(order__gt=item.order).order_by("order").first()
        if next_item and next_item.status == PathItemStatus.LOCKED:
            next_item.status = PathItemStatus.CURRENT
            next_item.save(update_fields=["status"])
    items = list(item.path.items.all())
    enrollment, _ = CourseEnrollment.objects.get_or_create(user=user, course=item.path.course)
    enrollment.progress = round(sum(path_item.progress for path_item in items) / len(items)) if items else 0
    enrollment.last_studied_at = timezone.now()
    enrollment.save(update_fields=["progress", "last_studied_at"])
    return item.path


def dashboard_summary(user) -> dict:
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).select_related("course").first()
    if not path:
        motivation = _motivation_summary(user, None)
        motivation["newReminders"] = len(ensure_learning_reminders(user, plan=current_study_plan(user), motivation=motivation))
        return {"path": None, "currentItem": None, "motivation": motivation}
    current = path.items.filter(status=PathItemStatus.CURRENT).select_related("knowledge_point__chapter").first()
    plan = current_study_plan(user)
    motivation = _motivation_summary(user, path)
    motivation["newReminders"] = len(ensure_learning_reminders(user, plan=plan, motivation=motivation))
    return {"path": serialize_path(path), "currentItem": serialize_path_item(current) if current else None, "motivation": motivation}


def _motivation_summary(user, path: LearningPath | None) -> dict:
    profile = getattr(user, "learner_profile", None)
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    plan = current_study_plan(user)
    today = timezone.localdate()
    active_dates = set()
    if path:
        for item in path.items.filter(completed_at__isnull=False):
            active_dates.add(item.completed_at.date().isoformat())
    reflections = extra_profile.get("dailyReflections") if isinstance(extra_profile.get("dailyReflections"), list) else []
    active_dates.update(str(item.get("date")) for item in reflections if isinstance(item, dict) and item.get("date"))
    tasks = []
    weekly_completed_tasks = 0
    if isinstance(plan, dict):
        today_day = next((day for day in plan.get("days", []) if isinstance(day, dict) and day.get("date") == today.isoformat()), None)
        tasks = today_day.get("tasks", []) if isinstance(today_day, dict) and isinstance(today_day.get("tasks"), list) else []
        week_start = today - timedelta(days=today.weekday())
        week_end = week_start + timedelta(days=6)
        for day in plan.get("days", []):
            if not isinstance(day, dict):
                continue
            try:
                plan_date = date.fromisoformat(str(day.get("date")))
            except ValueError:
                continue
            if week_start <= plan_date <= week_end:
                weekly_completed_tasks += sum(
                    1
                    for task in day.get("tasks", [])
                    if isinstance(task, dict) and task.get("status") == "completed"
                )
    completed_today = [task for task in tasks if isinstance(task, dict) and task.get("status") == "completed"]
    remaining_minutes = sum(int(task.get("estimatedMinutes") or 0) for task in tasks if isinstance(task, dict) and task.get("status") != "completed")
    streak_days = _streak_days(active_dates, today)
    badges = _motivation_badges(streak_days, len(completed_today), len(reflections), plan)
    weekly_current = min(5, weekly_completed_tasks)
    weekly_target = {
        "label": "完成 5 个学习任务",
        "current": weekly_current,
        "target": 5,
        "progress": round(weekly_current * 100 / 5),
    }
    return {
        "streakDays": streak_days,
        "todayRemainingMinutes": remaining_minutes,
        "todayCompletedTasks": len(completed_today),
        "todayTotalTasks": len(tasks),
        "weeklyCompletedTasks": weekly_completed_tasks,
        "weeklyTarget": weekly_target,
        "badges": badges,
        "nudge": _motivation_nudge(streak_days, remaining_minutes, len(completed_today), len(tasks)),
        "primaryAction": _motivation_primary_action(tasks, remaining_minutes, len(completed_today), len(reflections)),
    }


def _streak_days(active_dates: set[str], today) -> int:
    streak = 0
    cursor = today
    while cursor.isoformat() in active_dates:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _motivation_badges(streak_days: int, completed_today: int, reflection_count: int, plan: dict | None) -> list[dict]:
    badges = []
    if streak_days >= 3:
        badges.append({"id": "streak-3", "title": "连续学习者", "detail": f"已连续学习 {streak_days} 天", "earned": True})
    if completed_today >= 3:
        badges.append({"id": "daily-clear", "title": "今日清单推进", "detail": "今日至少完成 3 个任务", "earned": True})
    if reflection_count >= 1:
        badges.append({"id": "reflective-learner", "title": "会复盘的学习者", "detail": "已记录每日复盘", "earned": True})
    if isinstance(plan, dict) and int(plan.get("overallProgress") or 0) >= 50:
        badges.append({"id": "plan-half", "title": "计划过半", "detail": "学习计划完成度超过 50%", "earned": True})
    if not badges:
        badges.append({"id": "first-step", "title": "今日起步", "detail": "完成一个任务即可点亮", "earned": False})
    return badges[:4]


def _motivation_nudge(streak_days: int, remaining_minutes: int, completed_today: int, total_today: int) -> str:
    if total_today and completed_today == total_today:
        return "今日任务已完成，建议写一句复盘巩固记忆。"
    if remaining_minutes <= 15 and remaining_minutes > 0:
        return "还差一小步，完成剩余任务即可收尾。"
    if streak_days >= 3:
        return "连续学习节奏不错，今天保持轻量完成即可。"
    return "先完成一个最小任务，系统会继续更新你的学习节奏。"


def _motivation_primary_action(tasks: list[dict], remaining_minutes: int, completed_today: int, reflection_count: int) -> dict:
    next_task = next((task for task in tasks if isinstance(task, dict) and task.get("status") != "completed"), None)
    if next_task:
        return {
            "label": "继续今日任务",
            "href": str(next_task.get("href") or "/a3/today"),
            "reason": f"还剩约 {remaining_minutes} 分钟，先完成《{next_task.get('title', '下一项任务')}》能保持今日学习链路不断。",
        }
    if tasks and completed_today == len(tasks):
        return {
            "label": "写今日复盘",
            "href": "/a3/today#daily-reflection-form",
            "reason": "今日任务已完成，补一条复盘能让系统更准确地调整明天计划。",
        }
    if reflection_count == 0:
        return {
            "label": "完成入学诊断",
            "href": "/a3/admission-diagnostic",
            "reason": "先完成诊断，系统才能生成可执行的今日任务和学习计划。",
        }
    return {
        "label": "查看学习报告",
        "href": "/a3/report",
        "reason": "当前暂无待办任务，先查看报告里的薄弱点和下一步建议。",
    }


DIAGNOSTIC_QUESTIONS = [
    {
        "id": "os-role",
        "title": "操作系统功能",
        "prompt": "操作系统最核心的职责可以概括为什么？",
        "options": [
            "管理计算机硬件资源并为应用提供统一抽象",
            "只负责把高级语言编译成机器指令",
            "只负责设计数据库表结构",
            "只负责显示器图像渲染",
        ],
        "answerIndex": 0,
        "knowledgePoint": "操作系统功能与结构",
        "baseDifficulty": "foundation",
        "keywords": ["操作系统", "功能", "结构", "资源管理", "硬件资源", "抽象", "operating system", "os", "resource management"],
    },
    {
        "id": "process-thread",
        "title": "进程与线程",
        "prompt": "进程控制块 PCB 的主要作用是什么？",
        "options": [
            "保存进程标识、状态、上下文和资源信息",
            "保存显示器分辨率和主题颜色",
            "保存 SQL 查询执行计划",
            "保存浏览器缓存图片",
        ],
        "answerIndex": 0,
        "knowledgePoint": "进程与 PCB",
        "baseDifficulty": "foundation",
        "keywords": ["进程", "线程", "PCB", "进程控制块", "上下文", "状态", "process", "thread", "process control block"],
    },
    {
        "id": "cpu-scheduling",
        "title": "处理机调度",
        "prompt": "时间片轮转调度算法最主要面向哪类系统目标？",
        "options": [
            "让多个交互进程较公平地轮流获得 CPU",
            "让一个批处理作业永远独占 CPU",
            "只优化磁盘寻道距离",
            "只减少文件目录层级",
        ],
        "answerIndex": 0,
        "knowledgePoint": "处理机调度算法",
        "baseDifficulty": "standard",
        "keywords": ["处理机调度", "进程调度", "CPU 调度", "时间片", "轮转", "调度算法", "process scheduling", "cpu scheduling", "round robin"],
    },
    {
        "id": "sync",
        "title": "同步互斥",
        "prompt": "信号量 P/V 操作通常用于解决什么问题？",
        "options": [
            "进程同步与临界资源互斥访问",
            "提高显示器刷新率",
            "压缩文件体积",
            "修改 CPU 指令集",
        ],
        "answerIndex": 0,
        "knowledgePoint": "同步互斥与信号量",
        "baseDifficulty": "standard",
        "keywords": ["同步", "互斥", "信号量", "P/V", "临界资源", "临界区", "semaphore", "synchronization", "semaphore synchronization", "mutual exclusion"],
    },
    {
        "id": "virtual-memory",
        "title": "虚拟内存",
        "prompt": "发生缺页中断通常说明什么？",
        "options": [
            "进程访问的页当前不在内存，需要从外存调入",
            "CPU 算术逻辑单元永久损坏",
            "文件名一定重复",
            "网络连接一定断开",
        ],
        "answerIndex": 0,
        "knowledgePoint": "虚拟内存与页面置换",
        "baseDifficulty": "standard",
        "keywords": ["虚拟内存", "页面置换", "缺页", "缺页中断", "地址转换", "页表", "virtual memory", "page replacement", "page fault"],
    },
]


def admission_diagnostic_blueprint(user) -> dict:
    profile = getattr(user, "learner_profile", None)
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    current = extra_profile.get("admissionDiagnostic")
    questions, blueprint = _personalized_diagnostic_questions(profile)
    return {
        "current": current if isinstance(current, dict) else None,
        "questions": questions,
        "diagnosticBlueprint": blueprint,
        "suggestedDurations": [7, 14, 30],
        "goals": ["期末复习", "补齐基础", "考研预备", "竞赛冲刺", "课堂同步"],
        "dailyMinutes": [20, 30, 45, 60, 90],
    }


def _personalized_diagnostic_questions(profile) -> tuple[list[dict], dict]:
    profile_inputs = _diagnostic_profile_inputs(profile)
    weak_points = profile_inputs["weakPoints"]
    goals = profile_inputs["learningGoals"]
    scored = []
    for index, question in enumerate(DIAGNOSTIC_QUESTIONS):
        score, matched_signals = _diagnostic_question_match_score(question, weak_points, goals)
        difficulty = _diagnostic_question_difficulty(question, profile_inputs["foundationLevel"])
        scored.append(
            (
                -score,
                index,
                {
                    **_public_diagnostic_question(question),
                    "difficulty": difficulty,
                    "reason": _diagnostic_question_reason(question, matched_signals, score),
                    "profileSignals": matched_signals,
                    "source": "profile_adaptive_rule",
                },
            )
        )
    questions = [item for _, _, item in sorted(scored, key=lambda row: (row[0], row[1]))]
    degraded = not any(profile_inputs[key] for key in ("foundationLevel", "weakPoints", "learningGoals"))
    blueprint = {
        "schemaVersion": "a3.admission-diagnostic-blueprint.v1",
        "agent": "DiagnosticAgent",
        "workflow": "admission_diagnostic",
        "profileInputs": profile_inputs,
        "selectionPolicy": {
            "primaryRule": "profile_weak_points_first",
            "secondaryRule": "course_core_coverage",
            "difficultyRule": "foundation_level_adjusted",
        },
        "coverage": [
            {
                "knowledgePoint": question["knowledgePoint"],
                "difficulty": question["difficulty"],
                "reason": question["reason"],
            }
            for question in questions
        ],
        "degraded": degraded,
        "degradationReason": "画像字段不足，使用课程核心题库顺序。" if degraded else "",
    }
    return questions, blueprint


def _diagnostic_profile_inputs(profile) -> dict:
    if profile is None:
        return {
            "foundationLevel": "",
            "dailyStudyTime": 0,
            "learningGoals": [],
            "weakPoints": [],
            "learningPreferences": [],
        }
    return {
        "foundationLevel": str(getattr(profile, "foundation_level", "") or ""),
        "dailyStudyTime": int(getattr(profile, "daily_study_time", 0) or 0),
        "learningGoals": _diagnostic_list_field(getattr(profile, "learning_goals", [])),
        "weakPoints": _diagnostic_list_field(getattr(profile, "weak_points", [])),
        "learningPreferences": _diagnostic_list_field(getattr(profile, "learning_preferences", [])),
    }


def _diagnostic_list_field(value) -> list[str]:
    if isinstance(value, list):
        source = value
    elif isinstance(value, dict):
        source = value.values()
    else:
        source = []
    return _merge_unique([str(item).strip() for item in source if str(item).strip()], limit=8)


def _diagnostic_question_match_score(question: dict, weak_points: list[str], goals: list[str]) -> tuple[int, list[str]]:
    score = 0
    matched = []
    haystacks = [question.get("knowledgePoint", ""), question.get("title", ""), *question.get("keywords", [])]
    for signal_index, signal in enumerate(weak_points):
        if _diagnostic_text_matches(signal, haystacks):
            score += 120 - signal_index
            matched.append(signal)
    for signal in goals:
        if _diagnostic_text_matches(signal, haystacks):
            score += 25
            matched.append(signal)
    return score, _merge_unique(matched, limit=4)


def _diagnostic_text_matches(signal: str, haystacks: list[str]) -> bool:
    normalized_signal = signal.replace(" ", "").lower()
    if not normalized_signal:
        return False
    signal_has_cjk = any("\u4e00" <= char <= "\u9fff" for char in signal)
    for haystack in haystacks:
        normalized_haystack = str(haystack).replace(" ", "").lower()
        if normalized_signal in normalized_haystack:
            return True
        if signal_has_cjk and normalized_haystack in normalized_signal:
            return True
    return False


def _diagnostic_question_difficulty(question: dict, foundation_level: str) -> str:
    base = str(question.get("baseDifficulty") or "standard")
    if foundation_level in {"薄弱", "基础薄弱", "basic", "基础较弱"}:
        return "foundation"
    if foundation_level in {"进阶", "基础扎实", "advanced", "intensive"} and base == "standard":
        return "challenge"
    return base


def _diagnostic_question_reason(question: dict, matched_signals: list[str], score: int) -> str:
    if matched_signals:
        return f"画像薄弱点命中：{'、'.join(matched_signals)}，优先检测《{question['knowledgePoint']}》。"
    if score > 0:
        return f"学习目标关联《{question['knowledgePoint']}》，用于校准路径起点。"
    return f"课程核心知识点《{question['knowledgePoint']}》，用于保证入学诊断覆盖完整。"


def submit_admission_diagnostic(user, payload: dict) -> dict:
    validate_admission_diagnostic_payload(payload)
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    answers = payload.get("answers") if isinstance(payload.get("answers"), list) else []
    answer_map = {str(item.get("questionId")): item for item in answers if isinstance(item, dict)}
    scored_answers = []
    weak_points = []
    correct_count = 0
    for question in DIAGNOSTIC_QUESTIONS:
        selected = _safe_int(answer_map.get(question["id"], {}).get("selectedIndex"), -1)
        correct = selected == int(question["answerIndex"])
        if correct:
            correct_count += 1
        else:
            weak_points.append(question["knowledgePoint"])
        scored_answers.append(
            {
                "questionId": question["id"],
                "title": question["title"],
                "knowledgePoint": question["knowledgePoint"],
                "selectedIndex": selected,
                "correctIndex": question["answerIndex"],
                "correct": correct,
            }
        )

    total = len(DIAGNOSTIC_QUESTIONS)
    score = round(correct_count * 100 / total) if total else 0
    level = _diagnostic_level_from_score(score)
    goal = str(payload.get("goal") or "补齐基础").strip()[:40]
    exam_date = str(payload.get("examDate") or "").strip()[:20]
    duration_days = max(7, min(_safe_int(payload.get("durationDays"), 14), 30))
    daily_minutes = max(20, min(_safe_int(payload.get("dailyMinutes"), profile.daily_study_time or 60), 180))
    foundation_level = str(payload.get("foundationLevel") or level["foundationLevel"]).strip()[:64]
    requested_pace = str(payload.get("pace") or "").strip()
    pace = requested_pace or profile.pace
    if pace not in LearningPace.values:
        pace = _diagnostic_pace_from_schedule(duration_days, daily_minutes)

    merged_weak_points = _merge_unique(weak_points + (profile.weak_points if isinstance(profile.weak_points, list) else []), limit=8)
    try:
        from backend.apps.profiles.profile_updates import create_profile_update_candidates_from_event

        create_profile_update_candidates_from_event(
            profile,
            event_type="admission_diagnostic",
            source="admission_diagnostic",
            signals={"foundationLevel": foundation_level, "weakPoints": merged_weak_points, "score": score, "level": level},
            evidence={"score": score, "correctCount": correct_count, "totalCount": total},
            raw_preview=goal,
            save=False,
        )
    except Exception:
        pass
    profile.foundation_level = foundation_level
    profile.daily_study_time = daily_minutes
    profile.pace = pace
    profile.learning_goals = _merge_unique([goal] + (profile.learning_goals if isinstance(profile.learning_goals, list) else []), limit=6)
    profile.weak_points = merged_weak_points
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    diagnostic = {
        "diagnosticId": uuid4().hex,
        "submittedAt": timezone.now().isoformat(),
        "goal": goal,
        "examDate": exam_date,
        "durationDays": duration_days,
        "dailyMinutes": daily_minutes,
        "score": score,
        "correctCount": correct_count,
        "totalCount": total,
        "level": level,
        "weakPoints": weak_points,
        "answers": scored_answers,
        "nextAction": "已根据诊断结果刷新学习路径和每日计划",
    }
    extra_profile["admissionDiagnostic"] = diagnostic
    profile.extra_profile = extra_profile
    profile.save(
        update_fields=[
            "foundation_level",
            "daily_study_time",
            "pace",
            "learning_goals",
            "weak_points",
            "extra_profile",
            "updated_at",
        ]
    )
    from backend.apps.profiles.dynamic_profile import append_learning_event

    append_learning_event(
        profile,
        event_type="admission_diagnostic",
        summary=f"入学诊断得分 {score}，刷新基础水平和薄弱点",
        source="admission_diagnostic",
        importance=0.85,
        signals={
            "score": score,
            "level": level,
            "weakPoints": weak_points,
            "learningGoals": [goal],
            "dailyMinutes": daily_minutes,
        },
        raw_preview=goal,
        save=True,
    )

    path = generate_learning_path(user, force=True)
    plan = generate_study_plan(user, duration_days=duration_days, force=True)
    path_payload = serialize_path(path)
    diagnostic["loopEvidence"] = _admission_diagnostic_loop_evidence(diagnostic, path_payload, plan)
    profile.refresh_from_db(fields=["extra_profile"])
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    extra_profile["admissionDiagnostic"] = diagnostic
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {"diagnostic": diagnostic, "path": path_payload, "plan": plan}


def _public_diagnostic_question(question: dict) -> dict:
    return {
        "id": question["id"],
        "title": question["title"],
        "prompt": question["prompt"],
        "options": question["options"],
        "knowledgePoint": question["knowledgePoint"],
    }


def _diagnostic_level_from_score(score: int) -> dict:
    if score >= 85:
        return {"code": "L4", "label": "综合应用", "foundationLevel": "进阶", "description": "基础扎实，可以进入综合题、跨章节应用和提速训练。"}
    if score >= 65:
        return {"code": "L3", "label": "会做基础题", "foundationLevel": "中等", "description": "概念可用，但需要通过典型题巩固稳定性和解题步骤。"}
    if score >= 40:
        return {"code": "L2", "label": "概念可理解", "foundationLevel": "基础", "description": "建议先补关键概念，再进入小题组练习。"}
    return {"code": "L1", "label": "基础薄弱", "foundationLevel": "薄弱", "description": "需要降低负荷，从先修概念、例题讲解和错因复述开始。"}


def _diagnostic_pace_from_schedule(duration_days: int, daily_minutes: int) -> str:
    if daily_minutes >= 90 or (duration_days <= 7 and daily_minutes >= 60):
        return LearningPace.INTENSIVE
    if daily_minutes <= 30 or duration_days >= 30:
        return LearningPace.RELAXED
    return LearningPace.STANDARD


def validate_admission_diagnostic_payload(payload: dict) -> None:
    requested_pace = str(payload.get("pace") or "").strip()
    if requested_pace and requested_pace not in LearningPace.values:
        raise ValueError("学习节奏选项无效")


def _safe_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _merge_unique(values, *, limit: int) -> list[str]:
    rows = []
    for value in values:
        text = str(value).strip()
        if text and text not in rows:
            rows.append(text)
    return rows[:limit]


def _learning_loop_evidence(*, trigger: str, subject: dict, write_backs: list[dict], next_action: dict) -> dict:
    return {
        "schemaVersion": "a3.learning-loop-evidence.v1",
        "trigger": trigger,
        "subject": subject,
        "writeBacks": write_backs,
        "nextAction": next_action,
        "generatedAt": timezone.now().isoformat(),
    }


def _admission_diagnostic_loop_evidence(diagnostic: dict, path_payload: dict, plan: dict) -> dict:
    weak_points = diagnostic.get("weakPoints") if isinstance(diagnostic.get("weakPoints"), list) else []
    plan_context = plan.get("planContext") if isinstance(plan.get("planContext"), dict) else {}
    learning_path = plan_context.get("learningPath") if isinstance(plan_context.get("learningPath"), dict) else {}
    return _learning_loop_evidence(
        trigger="admission_diagnostic",
        subject={
            "diagnosticId": str(diagnostic.get("diagnosticId") or ""),
            "score": diagnostic.get("score", 0),
            "weakPointCount": len(weak_points),
            "goal": diagnostic.get("goal", ""),
        },
        write_backs=[
            {
                "target": "learner_profile",
                "status": "updated",
                "summary": "基础水平、每日时间、学习目标和薄弱点已写入学习画像。",
                "metrics": {
                    "foundationLevel": diagnostic.get("level", {}).get("foundationLevel", ""),
                    "dailyMinutes": diagnostic.get("dailyMinutes", 0),
                    "weakPointCount": len(weak_points),
                },
            },
            {
                "target": "learning_path",
                "status": "updated",
                "id": str(path_payload.get("id") or learning_path.get("id") or ""),
                "summary": "学习路径已按诊断薄弱点和先修关系重新生成。",
                "metrics": {
                    "totalItems": len(path_payload.get("items", [])) if isinstance(path_payload.get("items"), list) else learning_path.get("totalItems", 0),
                    "progress": path_payload.get("progress", learning_path.get("progress", 0)),
                },
            },
            {
                "target": "study_plan",
                "status": "updated",
                "id": str(plan.get("planId") or ""),
                "summary": "周期计划和今日任务已按诊断结果生成。",
                "metrics": {
                    "durationDays": plan.get("durationDays", 0),
                    "dailyMinutes": plan.get("dailyMinutes", 0),
                    "todayTaskCount": len((plan.get("days") or [{}])[0].get("tasks", [])) if isinstance(plan.get("days"), list) and plan.get("days") else 0,
                },
            },
            {
                "target": "report",
                "status": "derived",
                "summary": "学习报告会在打开时按新的画像、路径和计划实时计算下一步建议。",
            },
        ],
        next_action={
            "label": "开始今日学习",
            "href": "/a3/today",
            "reason": "诊断已经生成路径和计划，下一步应执行今天的具体任务。",
        },
    )


def current_study_plan(user) -> dict | None:
    profile = getattr(user, "learner_profile", None)
    if profile is None:
        return None
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan")
    if not isinstance(plan, dict):
        return None
    if _study_plan_needs_course_rebuild(user, plan):
        return generate_study_plan(user, duration_days=_safe_int(plan.get("durationDays"), 14), force=True)
    changed = _rollover_missed_tasks(plan)
    context_changed = _sync_study_plan_context(user, plan)
    if changed or context_changed:
        plan["overallProgress"] = _plan_progress(plan.get("days", []))
        extra_profile["studyPlan"] = plan
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])
    return plan


def _study_plan_needs_course_rebuild(user, plan: dict) -> bool:
    course = default_course()
    if course is None:
        return False
    plan_course = plan.get("course") if isinstance(plan.get("course"), dict) else {}
    if str(plan_course.get("id") or "") and str(plan_course.get("id")) != str(course.id):
        return True
    if _contains_legacy_course_text(plan):
        return True
    active_path = LearningPath.objects.filter(user=user, course=course, status=LearningPathStatus.ACTIVE).first()
    return active_path is None or _learning_path_needs_course_rebuild(active_path)


def _learning_path_needs_course_rebuild(path: LearningPath) -> bool:
    expected_titles = {title for _, _, title, _, _, _ in DEFAULT_COURSE_POINT_SPECS.values()}
    expected_codes = set(DEFAULT_COURSE_POINT_SPECS.keys())
    items = list(path.items.select_related("knowledge_point__chapter").all())
    if not items:
        return True
    for item in items:
        point = item.knowledge_point
        if point.code not in expected_codes:
            return True
        if point.title not in expected_titles:
            return True
        if _contains_legacy_course_text({"title": point.title, "description": point.description, "chapter": point.chapter.title}):
            return True
    return False


def _wrong_question_matches_current_catalog(wrong: WrongQuestion) -> bool:
    point = wrong.question.knowledge_point
    return point.code in DEFAULT_COURSE_POINT_SPECS and not _contains_legacy_course_text({
        "title": point.title,
        "description": point.description,
        "question": wrong.question.stem,
    })


def _contains_legacy_course_text(value) -> bool:
    if isinstance(value, dict):
        return any(_contains_legacy_course_text(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_legacy_course_text(item) for item in value)
    if isinstance(value, str):
        return any(marker in value for marker in LEGACY_COURSE_TEXT_MARKERS)
    return False


def generate_study_plan(user, *, duration_days: int = 14, force: bool = False) -> dict:
    duration_days = max(7, min(int(duration_days or 14), 30))
    existing = current_study_plan(user) if not force else None
    if existing and not force:
        return existing

    path = (
        LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE)
        .select_related("course")
        .order_by("-created_at")
        .first()
    )
    course = path.course if path else default_course()
    if course is None:
        raise ValueError("暂无可用课程")
    if not path or (course.code == DEFAULT_COURSE_CODE and _learning_path_needs_course_rebuild(path)):
        path = generate_learning_path(user, course=course, force=True)
    elif course.code == DEFAULT_COURSE_CODE:
        _repair_default_course_catalog(path.course)
    items = list(path.items.select_related("knowledge_point__chapter").order_by("order"))
    wrong_items = list(
        WrongQuestion.objects.filter(user=user, mastered=False)
        .filter(question__knowledge_point__chapter__course=path.course)
        .select_related("question__knowledge_point__chapter")
        .order_by("-wrong_count", "-last_wrong_at")[:20]
    )
    if path.course.code == DEFAULT_COURSE_CODE:
        wrong_items = [item for item in wrong_items if _wrong_question_matches_current_catalog(item)]
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    daily_minutes = max(20, int(profile.daily_study_time or 60))
    level = _diagnostic_level(items, wrong_items, profile)
    adaptive_policy = _adaptive_policy(level, wrong_items, daily_minutes)
    mastery = _knowledge_mastery(items, wrong_items)
    days = _build_plan_days(items, wrong_items, duration_days, adaptive_policy["dailyMinutes"], mastery, adaptive_policy)
    personal_material_tasks = _inject_personal_material_tasks(days, profile)
    review_queue = _review_queue(wrong_items)
    adjustment_timeline = _adjustment_timeline(adaptive_policy, mastery, review_queue)
    if personal_material_tasks:
        adjustment_timeline.insert(0, _personal_material_adjustment_event(personal_material_tasks))
    plan = {
        "planId": uuid4().hex,
        "title": f"{path.course.title} {duration_days} 天学习计划",
        "course": {"id": str(path.course.id), "title": path.course.title},
        "durationDays": duration_days,
        "dailyMinutes": adaptive_policy["dailyMinutes"],
        "level": level,
        "adaptivePolicy": adaptive_policy,
        "generatedAt": timezone.now().isoformat(),
        "targetDate": (timezone.localdate() + timedelta(days=duration_days - 1)).isoformat(),
        "overallProgress": _plan_progress(days),
        "mastery": mastery,
        "reviewQueue": review_queue,
        "adjustmentTimeline": adjustment_timeline,
        "explanation": _study_plan_explanation(profile, level, adaptive_policy, mastery, review_queue, adjustment_timeline),
        "coachTip": _coach_tip(level, wrong_items),
        "days": days,
    }
    _sync_study_plan_context(user, plan, path=path)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    extra_profile["studyPlan"] = plan
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return plan


def complete_study_plan_task(user, *, day_index: int, task_id: str) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan")
    if not isinstance(plan, dict):
        plan = generate_study_plan(user)
    _rollover_missed_tasks(plan)
    changed = False
    completed_task = None
    completed_day = None
    for day in plan.get("days", []):
        if int(day.get("dayIndex", 0)) != int(day_index):
            continue
        for task in day.get("tasks", []):
            if str(task.get("id")) == str(task_id):
                task["status"] = "completed"
                task["completedAt"] = timezone.now().isoformat()
                _apply_plan_task_side_effects(user, task)
                completed_task = task
                completed_day = day
                changed = True
        _refresh_day_progress(day)
    if not changed:
        raise ValueError("计划任务不存在")
    plan["overallProgress"] = _plan_progress(plan.get("days", []))
    feedback = _task_completion_feedback(user, completed_task or {}, completed_day or {}, plan)
    plan["lastTaskFeedback"] = feedback
    _sync_study_plan_context(user, plan)
    _create_task_completion_notification(user, feedback)
    extra_profile["studyPlan"] = plan
    _record_resource_pack_run(user, extra_profile, feedback)
    _safe_record_learning_event(
        user,
        event_type="task_completed",
        target_type="study_plan_task",
        target_id=str(completed_task.get("id") or task_id) if isinstance(completed_task, dict) else str(task_id),
        knowledge_point_id=str(completed_task.get("knowledgePointId") or "") if isinstance(completed_task, dict) else "",
        duration_sec=max(0, int(completed_task.get("estimatedMinutes") or 0)) * 60 if isinstance(completed_task, dict) else 0,
        score=feedback.get("masteryAfter") if isinstance(feedback, dict) else None,
        metadata={
            "taskType": str(completed_task.get("type") or "") if isinstance(completed_task, dict) else "",
            "dayIndex": completed_day.get("dayIndex") if isinstance(completed_day, dict) else day_index,
            "planId": str(plan.get("planId") or ""),
            "dayProgress": feedback.get("dayProgress") if isinstance(feedback, dict) else None,
        },
    )
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {"plan": plan, "feedback": feedback}


def assign_resource_pack_to_today(user, resource_pack: dict) -> dict:
    if not isinstance(resource_pack, dict):
        raise ValueError("resourcePack 必须是对象")
    title = str(resource_pack.get("title") or "").strip()
    learning_goal = str(resource_pack.get("learningGoal") or title).strip()
    if not title or not learning_goal:
        raise ValueError("resourcePack 缺少 title 或 learningGoal")

    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan")
    if not isinstance(plan, dict):
        plan = generate_study_plan(user)
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    _rollover_missed_tasks(plan)

    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    if not days:
        plan = generate_study_plan(user, force=True)
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        days = plan.get("days") if isinstance(plan.get("days"), list) else []
    if not days:
        raise ValueError("当前学习计划不可用")

    today = timezone.localdate().isoformat()
    day = next((item for item in days if isinstance(item, dict) and item.get("date") == today), None)
    if day is None:
        day = next((item for item in days if isinstance(item, dict) and int(item.get("dayIndex") or 0) == 1), days[0])
    tasks = day.setdefault("tasks", [])
    task_id = f"resource-pack:{_stable_task_slug(learning_goal)}"
    existing = next((task for task in tasks if isinstance(task, dict) and task.get("id") == task_id), None)
    created = existing is None
    if existing is None:
        practice = resource_pack.get("practice") if isinstance(resource_pack.get("practice"), dict) else {}
        next_action = resource_pack.get("nextAction") if isinstance(resource_pack.get("nextAction"), dict) else {}
        evidence = resource_pack.get("evidence") if isinstance(resource_pack.get("evidence"), dict) else {}
        minutes = max(10, min(int(resource_pack.get("estimatedMinutes") or 30), 120))
        existing = {
            **_plan_task(
                task_id,
                "resource_pack",
                title[:80],
                str(next_action.get("reason") or "来自资源推荐页的一键学习包，完成后进入专项练习和复习。"),
                str(practice.get("href") or next_action.get("href") or "/a3/recommendations"),
                minutes,
                None,
            ),
            "metadata": {
                "generatedBy": "resource_pack",
                "resourcePack": resource_pack,
                "confidence": evidence.get("confidence", "medium"),
                "verifiedSourceCount": evidence.get("verifiedSourceCount", 0),
            },
        }
        tasks.insert(0, existing)
    _refresh_day_progress(day)
    plan["overallProgress"] = _plan_progress(days)
    _append_adjustment_event(
        plan,
        {
            "id": f"resource-pack:{task_id}",
            "type": "resource_pack",
            "title": "资源包加入今日任务",
            "detail": f"已将《{title[:40]}》加入今日任务，推荐、练习和复习可以连续执行。",
            "reason": "用户从资源推荐页主动加入，系统将推荐结果回流到学习计划。",
            "createdAt": timezone.now().isoformat(),
        },
    )
    _sync_study_plan_context(user, plan)
    extra_profile["studyPlan"] = plan
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {"plan": plan, "task": existing, "created": created}


def _stable_task_slug(value: str) -> str:
    return "-".join(str(value or "").strip().lower().split())[:80] or uuid4().hex


def submit_daily_reflection(user, payload: dict) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    summary = str(payload.get("summary") or "").strip()
    confusion = str(payload.get("confusion") or "").strip()
    confidence = _safe_int(payload.get("confidence"), 3)
    confidence = max(1, min(confidence, 5))
    if not summary and not confusion:
        raise ValueError("请至少填写今日总结或困惑。")

    plan = current_study_plan(user)
    today = timezone.localdate().isoformat()
    today_day = None
    if isinstance(plan, dict):
        today_day = next((day for day in plan.get("days", []) if isinstance(day, dict) and day.get("date") == today), None)
    reflection = {
        "reflectionId": uuid4().hex,
        "date": today,
        "summary": summary[:300],
        "confusion": confusion[:300],
        "confidence": confidence,
        "planId": plan.get("planId") if isinstance(plan, dict) else "",
        "todayProgress": today_day.get("progress", 0) if isinstance(today_day, dict) else 0,
        "createdAt": timezone.now().isoformat(),
    }
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    reflections = extra_profile.get("dailyReflections") if isinstance(extra_profile.get("dailyReflections"), list) else []
    reflections = [reflection] + [item for item in reflections if isinstance(item, dict) and item.get("date") != today]
    extra_profile["dailyReflections"] = reflections[:30]
    _safe_record_learning_event(
        user,
        event_type="reflection_submitted",
        target_type="daily_reflection",
        target_id=reflection["reflectionId"],
        score=confidence,
        metadata={
            "summary": reflection["summary"],
            "confusion": reflection["confusion"],
            "planId": reflection["planId"],
            "todayProgress": reflection["todayProgress"],
        },
    )
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {"reflection": reflection, "recent": extra_profile["dailyReflections"][:7]}


def _apply_plan_task_side_effects(user, task: dict) -> None:
    point_id = str(task.get("knowledgePointId") or "")
    task_type = str(task.get("type") or "")
    if not point_id:
        return
    path_item = (
        LearningPathItem.objects.filter(path__user=user, path__status=LearningPathStatus.ACTIVE, knowledge_point_id=point_id)
        .select_related("path__course")
        .first()
    )
    if path_item and path_item.status != PathItemStatus.LOCKED:
        if task_type == "learn":
            update_path_item_progress(user, path_item, max(path_item.progress, 60))
        elif task_type == "practice":
            update_path_item_progress(user, path_item, 100)
    if task_type == "review":
        next_review = timezone.now() + timedelta(days=3)
        wrong_items = WrongQuestion.objects.filter(user=user, question__knowledge_point_id=point_id, mastered=False)
        for wrong in wrong_items:
            wrong.consecutive_correct = min(2, wrong.consecutive_correct + 1)
            wrong.mastered = wrong.consecutive_correct >= 2
            wrong.review_after = None if wrong.mastered else next_review
            wrong.save(update_fields=["consecutive_correct", "mastered", "review_after"])


def _task_completion_feedback(user, task: dict, day: dict, plan: dict) -> dict:
    task_type = str(task.get("type") or "")
    point_id = str(task.get("knowledgePointId") or "")
    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    resource_pack = metadata.get("resourcePack") if isinstance(metadata.get("resourcePack"), dict) else {}
    path_item = None
    if point_id:
        path_item = (
            LearningPathItem.objects.filter(path__user=user, path__status=LearningPathStatus.ACTIVE, knowledge_point_id=point_id)
            .select_related("knowledge_point")
            .first()
        )
    point_title = path_item.knowledge_point.title if path_item else _clean_task_title(str(task.get("title") or ""))
    mastery_after = path_item.progress if path_item else _mastery_score_from_plan(plan, point_id)
    if task_type == "learn":
        headline = "讲解已完成，当前知识点进入可练习状态。"
        next_action = {"label": "去做对应练习", "href": "/a3/assessment"}
        next_step_reason = "刚完成概念讲解，马上做 1 组练习最容易把理解转成可测掌握度。"
        delta = "+60%"
    elif task_type == "practice":
        headline = "练习已完成，学习路径已推进。"
        next_action = {"label": "查看下一步任务", "href": "/a3/today"}
        next_step_reason = "练习结果已回流到路径，继续处理今日清单可以维持学习节奏。"
        delta = "+100%"
    elif task_type == "review":
        headline = "复习已记录，错题间隔复习状态已更新。"
        next_action = {"label": "继续看错题本", "href": "/a3/wrong-notebook"}
        next_step_reason = "错题复习需要短间隔重复，继续处理错题本能降低同类错误复发。"
        delta = "+1 次巩固"
    elif task_type == "resource_pack":
        practice = resource_pack.get("practice") if isinstance(resource_pack.get("practice"), dict) else {}
        evidence = resource_pack.get("evidence") if isinstance(resource_pack.get("evidence"), dict) else {}
        goal = str(resource_pack.get("learningGoal") or point_title).strip()
        headline = f"资源包《{goal}》已完成，建议马上进入专项练习验证掌握度。"
        next_action = {"label": "开始资源包专项练习", "href": str(practice.get("href") or "/a3/assessment")}
        next_step_reason = "资源包已完成输入阶段，立刻练习能把推荐内容转成错题、画像和计划调整信号。"
        delta = f"+{int(evidence.get('verifiedSourceCount') or 0)} 条证据学习"
    else:
        headline = "复盘已完成，今日学习记录已更新。"
        next_action = {"label": "查看学习报告", "href": "/a3/report"}
        next_step_reason = "复盘内容会进入报告和计划调整，查看报告能看到下一阶段处方。"
        delta = "已记录"
    tasks = day.get("tasks", []) if isinstance(day.get("tasks"), list) else []
    done = sum(1 for row in tasks if isinstance(row, dict) and row.get("status") == "completed")
    remaining_tasks = max(0, len(tasks) - done)
    daily_closed = bool(tasks and done == len(tasks))
    if tasks and done == len(tasks) and task_type != "resource_pack":
        headline = "今日任务已全部完成，建议立刻写一句复盘并查看学习报告。"
        next_action = {"label": "查看学习报告", "href": "/a3/report"}
        next_step_reason = "今日学习闭环已完成，报告会把任务、错题和复盘串成下一步建议。"
    reward = _task_completion_reward(task_type, done, len(tasks), daily_closed)
    feedback = {
        "taskId": task.get("id"),
        "taskType": task_type,
        "title": task.get("title") or point_title,
        "knowledgePoint": point_title,
        "headline": headline,
        "celebration": _task_completion_celebration(done, len(tasks), daily_closed),
        "reward": reward,
        "masteryAfter": mastery_after,
        "delta": delta,
        "dayProgress": day.get("progress", 0),
        "completedTasks": done,
        "totalTasks": len(tasks),
        "remainingTasks": remaining_tasks,
        "dailyClosed": daily_closed,
        "nextAction": next_action,
        "nextStepReason": next_step_reason,
        "motivators": _task_completion_motivators(task_type, remaining_tasks, mastery_after, reward),
        "generatedAt": timezone.now().isoformat(),
    }
    feedback["loopEvidence"] = _task_completion_loop_evidence(
        task=task,
        day=day,
        plan=plan,
        path_item=path_item,
        feedback=feedback,
    )
    if task_type == "resource_pack":
        evidence = resource_pack.get("evidence") if isinstance(resource_pack.get("evidence"), dict) else {}
        feedback["resourcePack"] = {
            "learningGoal": resource_pack.get("learningGoal") or point_title,
            "verifiedSourceCount": int(evidence.get("verifiedSourceCount") or metadata.get("verifiedSourceCount") or 0),
            "confidence": evidence.get("confidence") or metadata.get("confidence") or "medium",
            "practiceHref": next_action["href"],
        }
    return feedback


def _task_completion_loop_evidence(*, task: dict, day: dict, plan: dict, path_item: LearningPathItem | None, feedback: dict) -> dict:
    task_type = str(task.get("type") or "")
    review_queue = plan.get("reviewQueue") if isinstance(plan.get("reviewQueue"), list) else []
    next_action = feedback.get("nextAction") if isinstance(feedback.get("nextAction"), dict) else {"label": "查看今日任务", "href": "/a3/today"}
    write_backs = [
        {
            "target": "study_plan",
            "status": "updated",
            "id": str(plan.get("planId") or ""),
            "summary": "任务状态、今日进度和 lastTaskFeedback 已写回学习计划。",
            "metrics": {
                "dayIndex": day.get("dayIndex"),
                "dayProgress": day.get("progress", 0),
                "overallProgress": plan.get("overallProgress", 0),
                "completedTasks": feedback.get("completedTasks", 0),
                "totalTasks": feedback.get("totalTasks", 0),
            },
        },
        {
            "target": "learning_path",
            "status": "updated" if path_item else "not_applicable",
            "id": str(path_item.path_id) if path_item else "",
            "summary": "相关路径节点掌握度已同步。" if path_item else "该任务没有绑定路径节点，只更新计划进度。",
            "metrics": {
                "pathItemId": str(path_item.id) if path_item else "",
                "knowledgePointId": str(task.get("knowledgePointId") or ""),
                "progress": path_item.progress if path_item else 0,
            },
        },
        {
            "target": "review_queue",
            "status": "updated" if task_type == "review" else "checked",
            "summary": "错题复习任务会更新间隔复习状态。" if task_type == "review" else "本次任务未直接改动错题复习队列。",
            "metrics": {"reviewQueueCount": len(review_queue)},
        },
        {
            "target": "report",
            "status": "derived",
            "summary": "学习报告会按最新计划进度、路径进度和错题状态实时计算。",
        },
        {
            "target": "notifications",
            "status": "created",
            "summary": "系统已创建下一步提醒，通知中心可继续打开。",
            "metrics": {"nextActionHref": next_action.get("href", "/a3/today")},
        },
    ]
    if task_type == "resource_pack":
        write_backs.append(
            {
                "target": "resource_pack_log",
                "status": "updated",
                "summary": "资源包学习记录会写入使用日志，用于报告和转化分析。",
            }
        )
    return _learning_loop_evidence(
        trigger="today_task_complete",
        subject={
            "taskId": str(task.get("id") or ""),
            "taskType": task_type,
            "title": str(task.get("title") or ""),
            "knowledgePointId": str(task.get("knowledgePointId") or ""),
        },
        write_backs=write_backs,
        next_action={
            "label": str(next_action.get("label") or "查看今日任务"),
            "href": str(next_action.get("href") or "/a3/today"),
            "reason": str(feedback.get("nextStepReason") or "继续执行当前学习闭环。"),
        },
    )


def _task_completion_reward(task_type: str, completed_tasks: int, total_tasks: int, daily_closed: bool) -> dict:
    if task_type == "resource_pack":
        return {"label": "资源包闭环", "value": "+1", "earned": True}
    if daily_closed:
        return {"label": "今日闭环", "value": "+1", "earned": True}
    if completed_tasks == 1:
        return {"label": "启动奖励", "value": "+1", "earned": True}
    if task_type == "review":
        return {"label": "错题巩固", "value": "+1", "earned": True}
    return {"label": "任务推进", "value": f"{completed_tasks}/{total_tasks or 1}", "earned": True}


def _task_completion_celebration(completed_tasks: int, total_tasks: int, daily_closed: bool) -> str:
    if daily_closed:
        return "今日学习闭环已完成，任务、反馈和报告已经串起来。"
    if completed_tasks <= 1:
        return "已经迈出第一步，继续完成下一项能形成稳定节奏。"
    return f"今日已完成 {completed_tasks}/{total_tasks} 项，距离收尾更近了。"


def _task_completion_motivators(task_type: str, remaining_tasks: int, mastery_after: int, reward: dict) -> list[dict]:
    motivators = [
        {"label": str(reward.get("label") or "任务推进"), "detail": f"本次获得 {reward.get('value', '+1')}", "tone": "green"},
        {"label": "掌握度同步", "detail": f"当前知识点掌握度 {mastery_after}%", "tone": "blue"},
    ]
    if remaining_tasks > 0:
        motivators.append({"label": "不断链", "detail": f"还剩 {remaining_tasks} 个任务，建议继续完成下一步。", "tone": "orange"})
    else:
        motivators.append({"label": "闭环完成", "detail": "建议写复盘，让明天计划更准确。", "tone": "violet"})
    if task_type == "review":
        motivators.append({"label": "间隔复习", "detail": "错题状态已进入下一轮复习节奏。", "tone": "orange"})
    if task_type == "resource_pack":
        motivators.append({"label": "推荐回流", "detail": "资源包已进入今日任务，下一步练习会继续更新画像。", "tone": "violet"})
    return motivators[:4]


def _create_task_completion_notification(user, feedback: dict) -> None:
    task_id = str(feedback.get("taskId") or "")
    if not task_id:
        return
    if user.notifications.filter(payload__generatedBy="study_plan_completion", payload__taskId=task_id).exists():
        return
    next_action = feedback.get("nextAction") if isinstance(feedback.get("nextAction"), dict) else {}
    action_label = str(next_action.get("label") or "查看下一步")
    action_url = str(next_action.get("href") or "/a3/today")
    create_notification(
        user=user,
        title="学习任务已完成",
        detail=f"{feedback.get('headline', '任务已完成')} 下一步：{action_label}。",
        notification_type=NotificationType.LEARNING_TASK,
        action_url=action_url,
        payload={
            "generatedBy": "study_plan_completion",
            "taskId": task_id,
            "taskType": feedback.get("taskType"),
            "knowledgePoint": feedback.get("knowledgePoint"),
            "nextAction": next_action,
            "nextStepReason": feedback.get("nextStepReason"),
            "reward": feedback.get("reward"),
            "dailyClosed": feedback.get("dailyClosed"),
            "actionKind": _completion_action_kind(action_url),
        },
    )
    if str(feedback.get("taskType") or "") == "resource_pack":
        _create_resource_pack_completion_notification(user, feedback, task_id, action_url)
    if int(feedback.get("totalTasks") or 0) > 0 and int(feedback.get("completedTasks") or 0) >= int(feedback.get("totalTasks") or 0):
        _create_daily_completion_notification(user, feedback)


def _record_resource_pack_run(user, extra_profile: dict, feedback: dict) -> None:
    if str(feedback.get("taskType") or "") != "resource_pack":
        return
    resource_pack = feedback.get("resourcePack") if isinstance(feedback.get("resourcePack"), dict) else {}
    task_id = str(feedback.get("taskId") or "")
    if not task_id:
        return
    run = _resource_pack_run_payload(task_id, feedback, resource_pack)
    completed_at = _parse_resource_pack_completed_at(run.get("completedAt"))
    ResourcePackLog.objects.update_or_create(
        user=user,
        task_id=task_id,
        defaults={
            "task_title": str(run.get("taskTitle") or "")[:160],
            "learning_goal": str(run.get("learningGoal") or "")[:160],
            "verified_source_count": int(run.get("verifiedSourceCount") or 0),
            "confidence": str(run.get("confidence") or "medium")[:32],
            "practice_href": str(run.get("practiceHref") or "/a3/assessment")[:255],
            "source": str(run.get("source") or "study_plan_completion")[:64],
            "next_step_reason": str(run.get("nextStepReason") or ""),
            "payload": run,
            "completed_at": completed_at,
        },
    )
    runs = extra_profile.get("resourcePackRuns") if isinstance(extra_profile.get("resourcePackRuns"), list) else []
    runs = [item for item in runs if not (isinstance(item, dict) and item.get("taskId") == task_id)]
    runs.insert(0, run)
    extra_profile["resourcePackRuns"] = runs[:30]


def _resource_pack_run_payload(task_id: str, feedback: dict, resource_pack: dict) -> dict:
    return {
        "schemaVersion": "a3.resource-pack-run.v1",
        "runId": uuid4().hex,
        "taskId": task_id,
        "taskTitle": feedback.get("title") or "",
        "learningGoal": resource_pack.get("learningGoal") or feedback.get("knowledgePoint") or "",
        "verifiedSourceCount": int(resource_pack.get("verifiedSourceCount") or 0),
        "confidence": resource_pack.get("confidence") or "medium",
        "practiceHref": resource_pack.get("practiceHref") or (feedback.get("nextAction") or {}).get("href") or "/a3/assessment",
        "source": "study_plan_completion",
        "completedAt": feedback.get("generatedAt") or timezone.now().isoformat(),
        "nextStepReason": feedback.get("nextStepReason") or "",
    }


def _parse_resource_pack_completed_at(value):
    if not value:
        return timezone.now()
    try:
        parsed = timezone.datetime.fromisoformat(str(value))
    except ValueError:
        return timezone.now()
    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _create_resource_pack_completion_notification(user, feedback: dict, task_id: str, action_url: str) -> None:
    if user.notifications.filter(payload__generatedBy="resource_pack_completion", payload__taskId=task_id).exists():
        return
    resource_pack = feedback.get("resourcePack") if isinstance(feedback.get("resourcePack"), dict) else {}
    learning_goal = str(resource_pack.get("learningGoal") or feedback.get("knowledgePoint") or "专项资源包")
    create_notification(
        user=user,
        title="资源包专项练习待完成",
        detail=f"《{learning_goal[:40]}》资源包已完成，建议马上进入专项练习，把学习结果回流到画像和错题本。",
        notification_type=NotificationType.ASSESSMENT,
        action_url=action_url or str(resource_pack.get("practiceHref") or "/a3/assessment"),
        payload={
            "generatedBy": "resource_pack_completion",
            "taskId": task_id,
            "taskType": "resource_pack",
            "knowledgePoint": feedback.get("knowledgePoint"),
            "resourcePack": {
                "learningGoal": learning_goal,
                "verifiedSourceCount": int(resource_pack.get("verifiedSourceCount") or 0),
                "confidence": resource_pack.get("confidence") or "medium",
                "practiceHref": resource_pack.get("practiceHref") or action_url or "/a3/assessment",
            },
            "nextAction": feedback.get("nextAction"),
            "nextStepReason": feedback.get("nextStepReason"),
            "actionKind": "assessment",
        },
    )


def _create_daily_completion_notification(user, feedback: dict) -> None:
    today = timezone.localdate().isoformat()
    if user.notifications.filter(payload__generatedBy="daily_completion", payload__date=today).exists():
        return
    create_notification(
        user=user,
        title="今日学习闭环已完成",
        detail="今日任务已完成。建议写下复盘，并查看学习报告中的下周处方。",
        notification_type=NotificationType.LEARNING_TASK,
        action_url="/a3/report",
        payload={
            "generatedBy": "daily_completion",
            "date": today,
            "completedTasks": feedback.get("completedTasks"),
            "totalTasks": feedback.get("totalTasks"),
            "actionKind": "report",
        },
    )


def _completion_action_kind(action_url: str) -> str:
    if "wrong-notebook" in action_url:
        return "review"
    if "assessment" in action_url:
        return "assessment"
    if "report" in action_url:
        return "report"
    if "study-plan" in action_url or "learning-path" in action_url:
        return "plan"
    return "today"


def _clean_task_title(title: str) -> str:
    for prefix in ("学习：", "练习：", "复习："):
        title = title.replace(prefix, "")
    return title


def _mastery_score_from_plan(plan: dict, point_id: str) -> int:
    for row in plan.get("mastery", []):
        if isinstance(row, dict) and str(row.get("knowledgePointId")) == point_id:
            return int(row.get("score") or 0)
    return 0


def _diagnostic_level(items: list[LearningPathItem], wrong_items: list[WrongQuestion], profile: LearnerProfile) -> dict:
    progress = round(sum(item.progress for item in items) / len(items)) if items else 0
    wrong_pressure = sum(item.wrong_count for item in wrong_items[:8])
    foundation = str(profile.foundation_level or "")
    if progress >= 70 and wrong_pressure <= 2:
        code, label, description = "L4", "综合应用", "可以进入综合题和跨章节应用训练。"
    elif progress >= 45:
        code, label, description = "L3", "会做基础题", "适合加强典型题型和错因纠正。"
    elif "弱" in foundation or "薄弱" in foundation or wrong_pressure >= 5:
        code, label, description = "L1", "基础薄弱", "需要降低负荷，优先补概念和前置知识。"
    else:
        code, label, description = "L2", "概念可理解", "适合按路径推进并配合少量练习。"
    return {"code": code, "label": label, "description": description, "pathProgress": progress, "wrongPressure": wrong_pressure}


def _adaptive_policy(level: dict, wrong_items: list[WrongQuestion], daily_minutes: int) -> dict:
    wrong_pressure = int(level.get("wrongPressure") or 0)
    level_code = str(level.get("code") or "L2")
    if wrong_pressure >= 6 or level_code == "L1":
        mode = "reduced_load"
        adjusted_minutes = max(20, min(daily_minutes, 45))
        max_tasks = 2
        reason = "错题压力较高，今日优先降低负荷并安排复习。"
    elif wrong_pressure <= 1 and level_code in {"L3", "L4"}:
        mode = "accelerated"
        adjusted_minutes = min(max(daily_minutes, 45), 90)
        max_tasks = 3
        reason = "掌握度较稳定，可以保持讲解、练习和复盘的完整节奏。"
    else:
        mode = "standard"
        adjusted_minutes = daily_minutes
        max_tasks = 3
        reason = "按标准节奏推进，兼顾新知识和必要复习。"
    return {
        "mode": mode,
        "dailyMinutes": adjusted_minutes,
        "maxTasksPerDay": max_tasks,
        "rolloverEnabled": True,
        "reason": reason,
    }


def _knowledge_mastery(items: list[LearningPathItem], wrong_items: list[WrongQuestion]) -> list[dict]:
    wrong_by_point = defaultdict(int)
    for wrong in wrong_items:
        wrong_by_point[wrong.question.knowledge_point_id] += wrong.wrong_count
    rows = []
    for item in items:
        point = item.knowledge_point
        wrong_count = int(wrong_by_point.get(point.id, 0))
        score = max(0, min(100, item.progress + (10 if item.status == PathItemStatus.COMPLETED else 0) - wrong_count * 12))
        rows.append({
            "knowledgePointId": str(point.id),
            "title": point.title,
            "chapter": point.chapter.title,
            "score": score,
            "wrongCount": wrong_count,
            "status": "mastered" if score >= 80 else "weak" if wrong_count or score < 50 else "learning",
        })
    return rows


def _build_plan_days(items: list[LearningPathItem], wrong_items: list[WrongQuestion], duration_days: int, daily_minutes: int, mastery: list[dict], adaptive_policy: dict | None = None) -> list[dict]:
    today = timezone.localdate()
    active_items = [item for item in items if item.status != PathItemStatus.COMPLETED] or items
    weak_titles = {row["title"] for row in mastery if row["status"] == "weak"}
    days = []
    for offset in range(duration_days):
        date = today + timedelta(days=offset)
        point_item = active_items[offset % len(active_items)] if active_items else None
        wrong = wrong_items[offset % len(wrong_items)] if wrong_items else None
        focus = wrong.question.knowledge_point.title if wrong and offset % 3 == 1 else point_item.knowledge_point.title if point_item else "课程复盘"
        tasks = []
        if point_item:
            point = point_item.knowledge_point
            tasks.append(_plan_task(f"d{offset + 1}-learn", "learn", f"学习：{point.title}", point.description or point_item.reason, "/a3/classroom", min(30, daily_minutes), point.id))
            tasks.append(_plan_task(f"d{offset + 1}-practice", "practice", f"练习：{point.title}", "完成 3-5 道对应题目，提交后自动更新掌握度。", "/a3/assessment", min(20, max(10, daily_minutes // 3)), point.id))
        if wrong:
            point = wrong.question.knowledge_point
            review_day = "明日复习" if offset == 0 else "间隔复习"
            error_cause = wrong.question.error_cause or "概念理解不稳"
            tasks.append(_plan_task(f"d{offset + 1}-review", "review", f"{review_day}：{point.title}", f"错题 {wrong.wrong_count} 次，优先处理错因：{error_cause}。", "/a3/wrong-notebook", min(15, daily_minutes // 4), point.id))
        if not tasks:
            tasks.append(_plan_task(f"d{offset + 1}-summary", "summary", "复盘今日学习", "总结一个知识点、一类错因和下一步问题。", "/a3/report", 10, None))
        status = "today" if offset == 0 else "pending"
        title = f"Day {offset + 1} · 薄弱点突破" if focus in weak_titles else f"Day {offset + 1} · 路径推进"
        max_tasks = int((adaptive_policy or {}).get("maxTasksPerDay") or 3)
        selected_tasks = _select_daily_tasks(tasks, max_tasks)
        days.append({
            "dayIndex": offset + 1,
            "date": date.isoformat(),
            "title": title,
            "focus": focus,
            "estimatedMinutes": sum(task["estimatedMinutes"] for task in selected_tasks),
            "status": status,
            "progress": 0,
            "tasks": selected_tasks,
        })
    return days


def _inject_personal_material_tasks(days: list[dict], profile: LearnerProfile) -> list[dict]:
    if not days:
        return []
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    materials = extra_profile.get("personalMaterials") if isinstance(extra_profile.get("personalMaterials"), list) else []
    if not materials:
        return []
    today_tasks = days[0].setdefault("tasks", [])
    existing_resource_ids = {str(task.get("sourceResourceId") or "") for task in today_tasks if isinstance(task, dict)}
    injected: list[dict] = []
    for material in materials:
        if not isinstance(material, dict):
            continue
        resource_id = str(material.get("resourceId") or "")
        if not resource_id or resource_id in existing_resource_ids:
            continue
        recommended = material.get("recommendedTasks") if isinstance(material.get("recommendedTasks"), list) else []
        first_task = next((task for task in recommended if isinstance(task, dict)), None)
        title = str((first_task or {}).get("title") or f"复习上传资料：{material.get('resourceName') or '我的资料'}")[:80]
        reason = str((first_task or {}).get("reason") or material.get("summary") or "来自你上传的个人资料，建议安排一次针对性复习。")
        task = _plan_task(
            f"personal-material-{resource_id[:8]}",
            "review",
            title,
            reason,
            "/a3/classroom",
            12,
            None,
        )
        task.update({
            "source": "personal_material",
            "sourceResourceId": resource_id,
            "sourceResourceName": str(material.get("resourceName") or ""),
            "sourceScope": "personal",
            "reason": reason,
        })
        today_tasks.append(task)
        existing_resource_ids.add(resource_id)
        injected.append(task)
        if len(injected) >= 2:
            break
    if injected:
        days[0]["estimatedMinutes"] = sum(int(task.get("estimatedMinutes") or 0) for task in today_tasks if isinstance(task, dict))
    return injected


def _personal_material_adjustment_event(tasks: list[dict]) -> dict:
    first_name = str(tasks[0].get("sourceResourceName") or "我的资料") if tasks else "我的资料"
    return {
        "id": f"personal-material-{timezone.now().strftime('%Y%m%d%H%M%S')}",
        "type": "resource_feedback",
        "title": "已加入个人资料复习任务",
        "reason": f"PersonalMaterialAgent 从《{first_name}》提取了复习信号，计划已追加到今日任务末尾。",
        "impact": f"今日新增 {len(tasks)} 个个人资料复习任务",
        "detail": "来源为学生本人上传资料，默认不进入其他学生或教师的个人计划。",
        "createdAt": timezone.now().isoformat(),
    }


def _select_daily_tasks(tasks: list[dict], max_tasks: int) -> list[dict]:
    if len(tasks) <= max_tasks:
        return tasks
    selected = tasks[:max_tasks]
    review_tasks = [task for task in tasks if task.get("type") == "review"]
    if review_tasks and not any(task.get("type") == "review" for task in selected):
        selected[-1] = review_tasks[0]
    return selected
def _rollover_missed_tasks(plan: dict) -> bool:
    days = plan.get("days")
    if not isinstance(days, list) or not days:
        return False
    if not plan.get("adaptivePolicy"):
        plan["adaptivePolicy"] = {
            "mode": "standard",
            "dailyMinutes": plan.get("dailyMinutes") or 60,
            "maxTasksPerDay": 3,
            "rolloverEnabled": True,
            "reason": "按标准节奏推进，兼顾新知识和必要复习。",
        }
    if plan.get("adaptivePolicy", {}).get("rolloverEnabled") is False:
        return False

    today = timezone.localdate()
    today_day = _today_plan_day(days, today)
    if today_day is None:
        return False

    changed = False
    existing_ids = {str(task.get("id")) for task in today_day.get("tasks", []) if isinstance(task, dict)}
    for day in days:
        if day is today_day:
            continue
        try:
            day_date = timezone.datetime.fromisoformat(str(day.get("date"))).date()
        except (TypeError, ValueError):
            continue
        if day_date >= today:
            continue
        rollover_tasks = []
        for task in day.get("tasks", []):
            if not isinstance(task, dict) or task.get("status") == "completed":
                continue
            rollover_id = f"rollover-{day.get('dayIndex')}-{task.get('id')}"
            if rollover_id in existing_ids:
                continue
            copied = {**task, "id": rollover_id, "status": "pending", "rolledOverFrom": {"dayIndex": day.get("dayIndex"), "date": day.get("date")}}
            copied.pop("completedAt", None)
            rollover_tasks.append(copied)
            existing_ids.add(rollover_id)
        if rollover_tasks:
            today_day.setdefault("tasks", [])
            today_day["tasks"] = rollover_tasks + today_day["tasks"]
            day["status"] = "rolled_over"
            _append_adjustment_event(
                plan,
                {
                    "id": f"rollover-{day.get('dayIndex')}-{today.isoformat()}",
                    "type": "rollover",
                    "title": "未完成任务已顺延",
                    "reason": f"{len(rollover_tasks)} 个任务从 {day.get('date')} 顺延到今天，优先处理避免计划断链。",
                    "impact": f"今日新增 {len(rollover_tasks)} 个待完成任务",
                    "createdAt": timezone.now().isoformat(),
                },
            )
            changed = True
    if changed:
        for day in days:
            _refresh_day_progress(day)
    return changed


def _today_plan_day(days: list, today) -> dict | None:
    for day in days:
        if not isinstance(day, dict):
            continue
        try:
            if timezone.datetime.fromisoformat(str(day.get("date"))).date() == today:
                day["status"] = "today" if day.get("status") != "completed" else "completed"
                return day
        except (TypeError, ValueError):
            continue
    first = days[0] if isinstance(days[0], dict) else None
    if first:
        first["date"] = today.isoformat()
        first["status"] = "today"
    return first


def _refresh_day_progress(day: dict) -> None:
    tasks = [task for task in day.get("tasks", []) if isinstance(task, dict)]
    done = sum(1 for task in tasks if task.get("status") == "completed")
    day["estimatedMinutes"] = sum(int(task.get("estimatedMinutes") or 0) for task in tasks)
    day["progress"] = round(done * 100 / len(tasks)) if tasks else 0
    if tasks and done == len(tasks):
        day["status"] = "completed"
    elif day.get("status") != "rolled_over" and done:
        day["status"] = "in_progress"


def _adjustment_timeline(adaptive_policy: dict, mastery: list[dict], review_queue: list[dict]) -> list[dict]:
    now = timezone.now().isoformat()
    events = [
        {
            "id": "policy-current",
            "type": "policy",
            "title": _policy_title(str(adaptive_policy.get("mode") or "standard")),
            "reason": adaptive_policy.get("reason") or "按当前画像和学习记录生成计划。",
            "impact": f"每日 {adaptive_policy.get('dailyMinutes')} 分钟，最多 {adaptive_policy.get('maxTasksPerDay')} 个任务",
            "createdAt": now,
        }
    ]
    weak_points = [item for item in mastery if item.get("status") == "weak"]
    if weak_points:
        events.append(
            {
                "id": "weak-focus",
                "type": "mastery",
                "title": "薄弱点优先插队",
                "reason": f"检测到 {len(weak_points)} 个薄弱知识点，计划会优先安排讲解和练习。",
                "impact": "今日任务会优先覆盖低掌握度知识点",
                "createdAt": now,
            }
        )
    if review_queue:
        events.append(
            {
                "id": "review-queue",
                "type": "review",
                "title": "错题进入间隔复习",
                "reason": f"{len(review_queue)} 个错题知识点已进入复习队列。",
                "impact": "复习任务会穿插到每日计划中",
                "createdAt": now,
            }
        )
    return events


def _study_plan_explanation(profile: LearnerProfile, level: dict, adaptive_policy: dict, mastery: list[dict], review_queue: list[dict], adjustment_timeline: list[dict]) -> dict:
    weak_points = [item for item in mastery if item.get("status") == "weak"]
    current_change = adjustment_timeline[0] if adjustment_timeline else {}
    return {
        "profileSignals": {
            "foundationLevel": profile.foundation_level or "",
            "dailyStudyTime": profile.daily_study_time,
            "pace": profile.pace,
            "learningGoals": profile.learning_goals if isinstance(profile.learning_goals, list) else [],
            "weakPoints": profile.weak_points if isinstance(profile.weak_points, list) else [],
            "level": level,
        },
        "loadPolicy": {
            "mode": adaptive_policy.get("mode"),
            "dailyMinutes": adaptive_policy.get("dailyMinutes"),
            "maxTasksPerDay": adaptive_policy.get("maxTasksPerDay"),
            "reason": adaptive_policy.get("reason"),
        },
        "weakPointPolicy": {
            "count": len(weak_points),
            "items": [{"title": item.get("title"), "score": item.get("score"), "wrongCount": item.get("wrongCount")} for item in weak_points[:5]],
            "reason": "薄弱知识点会优先进入讲解、练习和复盘任务。" if weak_points else "当前没有明显薄弱点，计划按路径正常推进。",
        },
        "reviewPolicy": {
            "count": len(review_queue),
            "items": review_queue[:5],
            "reason": "错题复习会穿插到每日任务，避免只学新内容不复盘。" if review_queue else "暂无待复习错题，后续测评会自动进入复习队列。",
        },
        "adjustments": adjustment_timeline[:5],
        "currentChange": current_change,
        "nextAction": _study_plan_change_next_action(current_change),
    }


def _policy_title(mode: str) -> str:
    if mode == "reduced_load":
        return "计划已降负荷"
    if mode == "accelerated":
        return "计划已加速推进"
    return "计划按标准节奏推进"


def _append_adjustment_event(plan: dict, event: dict) -> None:
    timeline = plan.get("adjustmentTimeline")
    if not isinstance(timeline, list):
        timeline = []
    event_id = str(event.get("id") or "")
    if event_id and any(isinstance(item, dict) and str(item.get("id")) == event_id for item in timeline):
        plan["adjustmentTimeline"] = timeline
        _sync_study_plan_explanation(plan)
        return
    timeline.insert(0, event)
    plan["adjustmentTimeline"] = timeline[:12]
    _sync_study_plan_explanation(plan)


def _sync_study_plan_explanation(plan: dict) -> None:
    explanation = plan.get("explanation")
    if not isinstance(explanation, dict):
        return
    timeline = plan.get("adjustmentTimeline") if isinstance(plan.get("adjustmentTimeline"), list) else []
    adjustments = [item for item in timeline if isinstance(item, dict)][:5]
    current_change = adjustments[0] if adjustments else {}
    explanation["adjustments"] = adjustments
    explanation["currentChange"] = current_change
    explanation["nextAction"] = _study_plan_change_next_action(current_change)


def _study_plan_change_next_action(change: dict) -> dict:
    change_type = str(change.get("type") or "")
    if change_type == "review":
        return {
            "label": "去复习错题",
            "href": "/a3/wrong-notebook",
            "reason": "最近计划变化来自错题复习队列，先处理到期错题能让后续任务更准确。",
        }
    if change_type == "mastery":
        return {
            "label": "查看今日强化任务",
            "href": "/a3/today",
            "reason": "最近计划变化来自薄弱点识别，今日任务会优先安排对应讲解和练习。",
        }
    if change_type == "rollover":
        return {
            "label": "处理顺延任务",
            "href": "/a3/today",
            "reason": "最近计划变化来自未完成任务顺延，先完成今日清单可以避免计划断链。",
        }
    if change_type == "resource_pack":
        return {
            "label": "查看今日资源包任务",
            "href": "/a3/today",
            "reason": "最近计划变化来自推荐资源包加入，完成今日任务后会继续回流到画像和练习。",
        }
    return {
        "label": "查看今日任务",
        "href": "/a3/today",
        "reason": "计划会根据画像、错题和完成情况调整，今日任务是当前最直接的执行入口。",
    }


def _sync_study_plan_context(user, plan: dict, *, path: LearningPath | None = None) -> bool:
    context = _study_plan_context(user, plan, path=path)
    if plan.get("planContext") == context:
        return False
    plan["planContext"] = context
    return True


def _study_plan_context(user, plan: dict, *, path: LearningPath | None = None) -> dict:
    path = path or LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).select_related("course").first()
    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    today_day = _plan_today_day(days)
    tasks = today_day.get("tasks", []) if isinstance(today_day, dict) and isinstance(today_day.get("tasks"), list) else []
    duration_days = _safe_int(plan.get("durationDays"), 14)
    daily_minutes = _safe_int(plan.get("dailyMinutes"), 45)
    remaining_path_minutes = 0
    path_payload = {
        "source": "missing_active_learning_path",
        "id": "",
        "version": 0,
        "progress": 0,
        "totalItems": 0,
        "completedItems": 0,
        "currentItem": None,
    }
    today_bindings = [_unbound_plan_task_binding(task) for task in tasks if isinstance(task, dict)]

    if path:
        items = list(path.items.select_related("knowledge_point__chapter").order_by("order"))
        item_by_point = {str(item.knowledge_point_id): item for item in items}
        completed_items = sum(1 for item in items if item.status == PathItemStatus.COMPLETED)
        current_item = next((item for item in items if item.status == PathItemStatus.CURRENT), None)
        if current_item is None:
            current_item = next((item for item in items if item.status != PathItemStatus.COMPLETED), None)
        if current_item is None and items:
            current_item = items[-1]
        remaining_path_minutes = sum(int(item.estimated_minutes or 0) for item in items if item.status != PathItemStatus.COMPLETED)
        if remaining_path_minutes <= 0:
            remaining_path_minutes = sum(int(item.estimated_minutes or 0) for item in items)
        path_payload = {
            "source": "active_learning_path",
            "id": str(path.id),
            "version": path.version,
            "progress": serialize_path(path)["progress"],
            "totalItems": len(items),
            "completedItems": completed_items,
            "currentItem": _plan_context_path_item(current_item) if current_item else None,
        }
        today_bindings = [
            _bound_plan_task_binding(task, item_by_point.get(str(task.get("knowledgePointId") or "")))
            for task in tasks
            if isinstance(task, dict)
        ]

    if remaining_path_minutes <= 0:
        remaining_path_minutes = sum(
            _safe_int(task.get("estimatedMinutes"), 0)
            for day in days
            if isinstance(day, dict)
            for task in day.get("tasks", [])
            if isinstance(task, dict) and task.get("status") != "completed"
        )
    return {
        "schemaVersion": "a3.study-plan-context.v1",
        "relationship": {
            "path": "学习路径决定知识点顺序和先修关系。",
            "plan": "学习计划把路径节点、错题复习和资源包排到具体日期。",
            "today": "今日学习只执行当前日期的计划任务。",
            "writeback": "任务完成后写回路径进度、错题复习、通知和报告指标。",
        },
        "learningPath": path_payload,
        "todayBindings": today_bindings,
        "durationOptions": _study_plan_duration_options(duration_days, daily_minutes, remaining_path_minutes),
        "agentRoles": _study_plan_agent_roles(),
    }


def _plan_today_day(days: list[dict]) -> dict | None:
    today = timezone.localdate().isoformat()
    for day in days:
        if isinstance(day, dict) and day.get("date") == today:
            return day
    for day in days:
        if isinstance(day, dict) and day.get("status") == "today":
            return day
    return days[0] if days else None


def _plan_context_path_item(item: LearningPathItem | None) -> dict | None:
    if item is None:
        return None
    point = item.knowledge_point
    return {
        "pathItemId": str(item.id),
        "knowledgePointId": str(point.id),
        "title": point.title,
        "chapter": point.chapter.title,
        "order": item.order,
        "status": item.status,
        "progress": item.progress,
        "estimatedMinutes": item.estimated_minutes,
        "reason": item.reason,
    }


def _unbound_plan_task_binding(task: dict) -> dict:
    return {
        "taskId": str(task.get("id") or ""),
        "taskType": str(task.get("type") or ""),
        "title": str(task.get("title") or ""),
        "knowledgePointId": str(task.get("knowledgePointId") or ""),
        "pathItemId": "",
        "pathStatus": "unbound",
        "pathProgress": 0,
        "writeback": _plan_task_writeback(str(task.get("type") or "")),
    }


def _bound_plan_task_binding(task: dict, item: LearningPathItem | None) -> dict:
    binding = _unbound_plan_task_binding(task)
    if item is None:
        return binding
    binding.update({
        "pathItemId": str(item.id),
        "pathStatus": item.status,
        "pathProgress": item.progress,
        "pathOrder": item.order,
        "chapter": item.knowledge_point.chapter.title,
    })
    return binding


def _plan_task_writeback(task_type: str) -> str:
    if task_type == "learn":
        return "完成后把路径节点推进到可练习状态。"
    if task_type == "practice":
        return "完成后把路径节点标记为掌握，并刷新报告指标。"
    if task_type == "review":
        return "完成后更新错题间隔复习状态。"
    if task_type == "resource_pack":
        return "完成后记录资源包使用证据，并进入专项练习。"
    return "完成后写回今日计划进度。"


def _study_plan_duration_options(selected_days: int, daily_minutes: int, remaining_minutes: int) -> list[dict]:
    options = []
    today = timezone.localdate()
    for days in (7, 14, 30):
        estimated_daily = max(10, round((remaining_minutes or daily_minutes * days) / days))
        if estimated_daily > daily_minutes * 1.15:
            load = "紧凑"
            reason = "周期较短，需要每天承担更多新知识和练习。"
        elif estimated_daily < daily_minutes * 0.65:
            load = "舒缓"
            reason = "周期较长，适合穿插更多复习和缓冲。"
        else:
            load = "均衡"
            reason = "与当前每日可用时间匹配，适合稳定推进。"
        options.append({
            "days": days,
            "selected": days == selected_days,
            "targetDate": (today + timedelta(days=days - 1)).isoformat(),
            "estimatedDailyMinutes": estimated_daily,
            "load": load,
            "reason": reason,
        })
    return options


def _study_plan_agent_roles() -> list[dict]:
    return [
        {
            "name": "DiagnosticAgent",
            "role": "定位起点",
            "input": "入学诊断答案和历史测评",
            "output": "level、weakPoints、nextAction",
        },
        {
            "name": "ProfileAgent",
            "role": "维护画像",
            "input": "专业方向、目标、每日时间、错题和复盘",
            "output": "foundationLevel、dailyStudyTime、learningGoals、weakPoints",
        },
        {
            "name": "PlannerAgent",
            "role": "生成路径",
            "input": "画像、诊断结果、知识点先修关系",
            "output": "active learning path 和当前路径节点",
        },
        {
            "name": "StudyPlanAgent",
            "role": "排程任务",
            "input": "学习路径、错题队列、每日时间和负荷策略",
            "output": "7/14/30 天计划、今日任务、复习队列",
        },
        {
            "name": "DailySessionAgent",
            "role": "执行写回",
            "input": "今日任务完成、课堂练习和资源包反馈",
            "output": "路径进度、通知、报告和下一步动作",
        },
    ]


def _plan_task(task_id: str, task_type: str, title: str, subtitle: str, href: str, minutes: int, point_id) -> dict:
    return {
        "id": task_id,
        "type": task_type,
        "title": title,
        "subtitle": subtitle[:140],
        "href": href,
        "estimatedMinutes": minutes,
        "knowledgePointId": str(point_id) if point_id else "",
        "status": "pending",
    }


def _review_queue(wrong_items: list[WrongQuestion]) -> list[dict]:
    rows = []
    now = timezone.now()
    for wrong in wrong_items[:8]:
        point = wrong.question.knowledge_point
        review_after = wrong.review_after or (now + timedelta(days=1))
        rows.append({
            "id": str(wrong.id),
            "wrongQuestionId": str(wrong.id),
            "title": point.title,
            "knowledgePoint": point.title,
            "wrongCount": wrong.wrong_count,
            "reviewAfter": review_after.isoformat(),
            "status": "due" if review_after <= now else "scheduled",
            "href": "/a3/wrong-notebook",
        })
    return rows


def _plan_progress(days: list[dict]) -> int:
    tasks = [task for day in days for task in day.get("tasks", [])]
    if not tasks:
        return 0
    return round(sum(1 for task in tasks if task.get("status") == "completed") * 100 / len(tasks))


def _coach_tip(level: dict, wrong_items: list[WrongQuestion]) -> str:
    if wrong_items:
        point = wrong_items[0].question.knowledge_point.title
        return f"今天优先处理《{point}》，不要急着刷题，先把错因讲清楚再练。"
    if level.get("code") in {"L1", "L2"}:
        return "先保证每天完成一个概念讲解和一组基础题，连续 3 天后再加速。"
    return "你的路径推进较稳定，可以把更多时间放在综合题和讲解复述上。"


def knowledge_graph(user, course: Course | None = None) -> dict:
    course = course or default_course()
    if not course:
        return {
            "schemaVersion": "a3.knowledge-graph.v1",
            "course": None,
            "pathId": None,
            "nodes": [],
            "edges": [],
            "summary": _empty_graph_summary(),
            "evidence": {
                "source": "learning_graph_service",
                "courseId": None,
                "knowledgePointCount": 0,
                "prerequisiteEdgeCount": 0,
                "activePathId": None,
            },
        }

    points = list(
        KnowledgePoint.objects.filter(chapter__course=course)
        .select_related("chapter")
        .order_by("chapter__order", "order")
    )
    active_path = (
        LearningPath.objects.filter(user=user, course=course, status=LearningPathStatus.ACTIVE)
        .prefetch_related("items__knowledge_point")
        .first()
    )
    path_items = {item.knowledge_point_id: item for item in active_path.items.all()} if active_path else {}
    wrong_counts = dict(
        WrongQuestion.objects.filter(user=user, question__knowledge_point__chapter__course=course, mastered=False)
        .values_list("question__knowledge_point_id", "wrong_count")
    )
    nodes = [_serialize_graph_node(point, path_items.get(point.id), int(wrong_counts.get(point.id, 0))) for point in points]
    edges = [
        {"from": str(edge.prerequisite_id), "to": str(edge.knowledge_point_id), "type": "prerequisite", "label": "先修"}
        for edge in KnowledgePrerequisite.objects.filter(knowledge_point__chapter__course=course)
    ]
    return {
        "schemaVersion": "a3.knowledge-graph.v1",
        "course": {"id": str(course.id), "code": course.code, "title": course.title, "edition": course.edition},
        "pathId": str(active_path.id) if active_path else None,
        "nodes": nodes,
        "edges": edges,
        "summary": _graph_summary(nodes),
        "evidence": {
            "source": "learning_graph_service",
            "courseId": str(course.id),
            "knowledgePointCount": len(nodes),
            "prerequisiteEdgeCount": len(edges),
            "activePathId": str(active_path.id) if active_path else None,
        },
    }


def _serialize_graph_node(point: KnowledgePoint, path_item: LearningPathItem | None, wrong_count: int) -> dict:
    progress = path_item.progress if path_item else 0
    status = "unstarted"
    if path_item:
        if path_item.status == PathItemStatus.COMPLETED:
            status = "mastered"
        elif wrong_count > 0:
            status = "weak"
        elif path_item.status == PathItemStatus.CURRENT:
            status = "learning"
        elif path_item.status == PathItemStatus.LOCKED:
            status = "locked"
    elif wrong_count > 0:
        status = "weak"
    return {
        "id": str(point.id),
        "code": point.code,
        "title": point.title,
        "description": point.description,
        "chapter": {"order": point.chapter.order, "title": point.chapter.title},
        "difficulty": point.difficulty,
        "estimatedMinutes": point.estimated_minutes,
        "status": status,
        "progress": progress,
        "wrongCount": wrong_count,
        "pathOrder": path_item.order if path_item else None,
        "reason": path_item.reason if path_item else "",
        "pathBinding": {
            "pathItemId": str(path_item.id) if path_item else None,
            "pathOrder": path_item.order if path_item else None,
            "status": path_item.status if path_item else "unbound",
            "reason": path_item.reason if path_item else "",
        },
        "evidence": {
            "source": "course_knowledge_point",
            "knowledgePointId": str(point.id),
            "chapter": point.chapter.title,
            "wrongCount": wrong_count,
            "progress": progress,
        },
    }


def _graph_summary(nodes: list[dict]) -> dict:
    summary = _empty_graph_summary()
    summary["total"] = len(nodes)
    for node in nodes:
        summary[node["status"]] = summary.get(node["status"], 0) + 1
    summary["masteryRate"] = round(summary["mastered"] * 100 / len(nodes)) if nodes else 0
    summary["nextCount"] = summary["learning"] + summary["weak"]
    return summary


def _empty_graph_summary() -> dict:
    return {
        "total": 0,
        "mastered": 0,
        "learning": 0,
        "weak": 0,
        "locked": 0,
        "unstarted": 0,
        "masteryRate": 0,
        "nextCount": 0,
    }


def classroom_context(user) -> dict:
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).select_related("course").first()
    if not path:
        course = default_course()
        if course:
            path = generate_learning_path(user, course=course)
    if not path:
        return {
            "course": None,
            "target": None,
            "agents": _classroom_agents(False),
            "sources": [],
            "recommended": [],
            "actions": [],
            "graphSummary": _empty_graph_summary(),
        }

    current = path.items.filter(status=PathItemStatus.CURRENT).select_related("knowledge_point__chapter").first()
    if not current:
        current = path.items.select_related("knowledge_point__chapter").order_by("order").last()
    point = current.knowledge_point if current else None
    graph = knowledge_graph(user, course=path.course)
    weak_nodes = [node for node in graph["nodes"] if node["status"] in {"weak", "learning"}][:4]
    sources = _knowledge_sources(user, point)
    wrong_count = 0
    if point:
        wrong_count = WrongQuestion.objects.filter(user=user, question__knowledge_point=point, mastered=False).count()
    return {
        "course": {"id": str(path.course.id), "title": path.course.title, "edition": path.course.edition},
        "path": {"id": str(path.id), "title": path.title, "progress": serialize_path(path)["progress"]},
        "target": _serialize_classroom_target(current, wrong_count) if current else None,
        "agents": _classroom_agents(bool(sources)),
        "sources": sources,
        "recommended": _classroom_recommendations(weak_nodes, point, _classroom_plan_task_bindings(user)),
        "actions": [
            {"title": "继续学习当前知识点", "href": "/a3/learning-path", "type": "path"},
            {"title": "生成随堂测评", "href": "/a3/assessment", "type": "assessment"},
            {"title": "查看相关错题", "href": "/a3/wrong-notebook", "type": "wrong"},
        ],
        "graphSummary": graph["summary"],
    }


def classroom_chat_history(user) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    messages = extra_profile.get("classroomChatHistory") if isinstance(extra_profile.get("classroomChatHistory"), list) else []
    sessions = _classroom_chat_sessions(extra_profile)
    return {
        "messages": [_serialize_classroom_chat_message(item) for item in messages if isinstance(item, dict)][-40:],
        "activeSessionId": str(extra_profile.get("classroomActiveChatId") or ""),
        "sessions": sessions,
        "updatedAt": extra_profile.get("classroomChatUpdatedAt") or "",
    }


def append_classroom_chat_messages(user, raw_messages: list) -> dict:
    if not isinstance(raw_messages, list) or not raw_messages:
        raise ValueError("请提供课堂问答消息")
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    current = extra_profile.get("classroomChatHistory") if isinstance(extra_profile.get("classroomChatHistory"), list) else []
    messages = [_serialize_classroom_chat_message(item) for item in current if isinstance(item, dict)]
    appended_messages = []
    for item in raw_messages[:6]:
        if not isinstance(item, dict):
            continue
        message = _serialize_classroom_chat_message(item)
        if message["content"]:
            messages.append(message)
            appended_messages.append(message)
    now = timezone.now().isoformat()
    messages = messages[-40:]
    extra_profile["classroomChatHistory"] = messages
    extra_profile["classroomChatUpdatedAt"] = now
    active_id = str(extra_profile.get("classroomActiveChatId") or uuid4())
    extra_profile["classroomActiveChatId"] = active_id
    extra_profile["classroomChatSessions"] = _upsert_classroom_chat_session(
        _classroom_chat_sessions(extra_profile),
        active_id,
        messages,
        now,
    )
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    for message in appended_messages:
        if message.get("role") != "user":
            continue
        _safe_record_learning_event(
            user,
            event_type="coach_message_sent",
            target_type="classroom_chat",
            target_id=str(message.get("id") or ""),
            metadata={
                "role": message.get("role"),
                "contentPreview": str(message.get("content") or "")[:200],
                "sessionId": active_id,
                "source": "classroom",
            },
        )
    from backend.apps.profiles.dynamic_profile import append_learning_event

    latest_user_messages = [item for item in messages[-6:] if item.get("role") == "user"]
    latest_assistant_messages = [item for item in messages[-6:] if item.get("role") == "assistant"]
    append_learning_event(
        profile,
        event_type="classroom_qa",
        summary="课堂问答记录已写入画像事件",
        source="classroom",
        importance=0.55,
        signals={
            "questionCount": len(latest_user_messages),
            "assistantReplyCount": len(latest_assistant_messages),
            "verified": any(bool(item.get("verified")) for item in latest_assistant_messages),
            "citations": [
                citation
                for item in latest_assistant_messages
                for citation in (item.get("citations") if isinstance(item.get("citations"), list) else [])
            ][:5],
        },
        raw_preview=(latest_user_messages[-1].get("content") if latest_user_messages else ""),
        save=True,
    )
    return {"messages": extra_profile["classroomChatHistory"], "updatedAt": now}


def clear_classroom_chat_messages(user) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    now = timezone.now().isoformat()
    current = extra_profile.get("classroomChatHistory") if isinstance(extra_profile.get("classroomChatHistory"), list) else []
    sessions = _classroom_chat_sessions(extra_profile)
    if current:
        active_id = str(extra_profile.get("classroomActiveChatId") or uuid4())
        sessions = _upsert_classroom_chat_session(sessions, active_id, current, now)
    extra_profile["classroomChatHistory"] = []
    extra_profile["classroomChatUpdatedAt"] = now
    extra_profile["classroomActiveChatId"] = str(uuid4())
    extra_profile["classroomChatSessions"] = sessions[:20]
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {"messages": [], "activeSessionId": extra_profile["classroomActiveChatId"], "sessions": sessions[:20], "updatedAt": now}


def _classroom_chat_sessions(extra_profile: dict) -> list[dict]:
    raw_sessions = extra_profile.get("classroomChatSessions") if isinstance(extra_profile.get("classroomChatSessions"), list) else []
    sessions = []
    for item in raw_sessions[:30]:
        if not isinstance(item, dict):
            continue
        messages = item.get("messages") if isinstance(item.get("messages"), list) else []
        serialized_messages = [_serialize_classroom_chat_message(message) for message in messages if isinstance(message, dict)][-40:]
        if not serialized_messages:
            continue
        sessions.append({
            "id": str(item.get("id") or uuid4()),
            "title": str(item.get("title") or _classroom_chat_session_title(serialized_messages))[:120],
            "summary": str(item.get("summary") or _classroom_chat_session_summary(serialized_messages))[:240],
            "messageCount": len(serialized_messages),
            "messages": serialized_messages,
            "startedAt": str(item.get("startedAt") or serialized_messages[0].get("createdAt") or timezone.now().isoformat()),
            "updatedAt": str(item.get("updatedAt") or serialized_messages[-1].get("createdAt") or timezone.now().isoformat()),
        })
    return sorted(sessions, key=lambda item: item.get("updatedAt") or "", reverse=True)[:20]


def _upsert_classroom_chat_session(sessions: list[dict], session_id: str, messages: list[dict], updated_at: str) -> list[dict]:
    serialized_messages = [_serialize_classroom_chat_message(item) for item in messages if isinstance(item, dict)][-40:]
    if not serialized_messages:
        return sessions
    next_session = {
        "id": session_id,
        "title": _classroom_chat_session_title(serialized_messages),
        "summary": _classroom_chat_session_summary(serialized_messages),
        "messageCount": len(serialized_messages),
        "messages": serialized_messages,
        "startedAt": serialized_messages[0].get("createdAt") or updated_at,
        "updatedAt": updated_at,
    }
    merged = [next_session] + [item for item in sessions if item.get("id") != session_id]
    return sorted(merged, key=lambda item: item.get("updatedAt") or "", reverse=True)[:20]


def _classroom_chat_session_title(messages: list[dict]) -> str:
    first_user = next((item for item in messages if item.get("role") == "user" and item.get("content")), None)
    if first_user:
        return str(first_user.get("content"))[:36]
    first_assistant = next((item for item in messages if item.get("content")), None)
    return str(first_assistant.get("content") or "课堂对话")[:36]


def _classroom_chat_session_summary(messages: list[dict]) -> str:
    user_count = len([item for item in messages if item.get("role") == "user"])
    assistant_count = len([item for item in messages if item.get("role") == "assistant"])
    return f"{user_count} 次提问，{assistant_count} 条回答"


def _serialize_classroom_chat_message(item: dict) -> dict:
    role = str(item.get("role") or "").strip()
    if role not in {"user", "assistant"}:
        role = "assistant"
    content = str(item.get("content") or "").strip()[:4000]
    citations = item.get("citations") if isinstance(item.get("citations"), list) else []
    claims = item.get("claims") if isinstance(item.get("claims"), list) else []
    if role == "assistant":
        citations = _enrich_classroom_citations(citations)
        claims = _enrich_classroom_claims(claims)
    return {
        "id": str(item.get("id") or uuid4()),
        "role": role,
        "content": content,
        "verified": bool(item.get("verified")) if role == "assistant" else False,
        "citations": citations,
        "claims": claims,
        "safety": item.get("safety") if isinstance(item.get("safety"), dict) else None,
        "refusalReason": str(item.get("refusalReason") or "")[:500],
        "retrievalMode": str(item.get("retrievalMode") or "")[:80] if role == "assistant" else "",
        "traceId": str(item.get("traceId") or "")[:80] if role == "assistant" else "",
        "createdAt": str(item.get("createdAt") or timezone.now().isoformat()),
    }


def _enrich_classroom_citations(citations: list) -> list[dict]:
    return [_enrich_classroom_citation(item) for item in citations if isinstance(item, dict)]


def _enrich_classroom_claims(claims: list) -> list[dict]:
    enriched = []
    for item in claims:
        if not isinstance(item, dict):
            continue
        claim = dict(item)
        if isinstance(claim.get("citation"), dict):
            claim["citation"] = _enrich_classroom_citation(claim["citation"])
        enriched.append(claim)
    return enriched


def _enrich_classroom_citation(citation: dict) -> dict:
    enriched = dict(citation)
    if enriched.get("previewUrl"):
        return enriched
    block_id = str(enriched.get("blockId") or enriched.get("block_id") or "").strip()
    if not block_id:
        return enriched
    try:
        block = KnowledgeBlock.objects.select_related("asset", "page").get(id=block_id)
    except (KnowledgeBlock.DoesNotExist, ValueError):
        return enriched
    asset = block.asset or _classroom_preview_asset_for_block(block)
    if not asset:
        return enriched
    preview_url = f"/api/kb/assets/{asset.id}/preview/"
    enriched["previewUrl"] = preview_url
    enriched["asset"] = {
        "assetId": str(asset.id),
        "kind": asset.kind,
        "previewUrl": preview_url,
    }
    return enriched


def _classroom_preview_asset_for_block(block: KnowledgeBlock) -> KnowledgeAsset | None:
    if not block.page_id:
        return None
    return (
        KnowledgeAsset.objects
        .filter(page_id=block.page_id, kind__in=["rendered_slide", "rendered_page", "original"])
        .order_by("created_at")
        .first()
        or KnowledgeAsset.objects.filter(page_id=block.page_id).order_by("created_at").first()
    )


def coaching_session(user) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    session = _latest_active_coaching_session(user)
    if session is None:
        session = _import_legacy_coaching_session(profile)
    if session is None:
        return {"session": _serialize_coaching_session_payload(None, [])}
    messages = list(session.messages.order_by("created_at", "id")[:60])
    return {"session": _serialize_coaching_session_payload(session, messages)}


def list_coaching_sessions(user, limit: int = 20) -> dict:
    limit = max(1, min(int(limit or 20), 50))
    sessions = (
        CoachingSession.objects
        .filter(user=user)
        .prefetch_related("messages")
        .order_by("-updated_at", "-created_at")[:limit]
    )
    return {"sessions": [_serialize_coaching_session_row(session) for session in sessions]}


def coaching_session_detail(user, session_id) -> dict:
    session = get_object_or_404(
        CoachingSession.objects.prefetch_related("messages"),
        id=session_id,
        user=user,
    )
    messages = list(session.messages.order_by("created_at", "id")[:60])
    return {"session": _serialize_coaching_session_payload(session, messages)}


@transaction.atomic
def summarize_coaching_session(user, session_id) -> dict:
    session = get_object_or_404(
        CoachingSession.objects.select_for_update().prefetch_related("messages"),
        id=session_id,
        user=user,
    )
    metadata = session.metadata if isinstance(session.metadata, dict) else {}
    existing_summary = metadata.get("summary") if isinstance(metadata.get("summary"), dict) else None
    if existing_summary is not None and metadata.get("summaryCompletedAt"):
        session.refresh_from_db()
        return {"summary": existing_summary, "session": _serialize_coaching_session_row(session)}
    if session.status == CoachingSessionStatus.ARCHIVED:
        raise ValueError("已归档的辅导会话不能重新生成总结")

    messages = list(session.messages.order_by("created_at", "id"))
    user_questions = [message for message in messages if message.role == CoachingMessageRole.USER]
    assistant_replies = [message for message in messages if message.role == CoachingMessageRole.ASSISTANT]
    verified_replies = [message for message in assistant_replies if message.verified]
    citation_count = sum(
        len(message.citations if isinstance(message.citations, list) else [])
        for message in assistant_replies
    )
    visual_evidence_count = sum(
        1
        for message in assistant_replies
        if isinstance(message.metadata, dict) and isinstance(message.metadata.get("visualEvidence"), dict)
    )
    latest_questions = [message.content for message in user_questions[-3:]]
    weak_point_signals = _coaching_weak_point_signals(latest_questions)
    next_action = _coaching_next_action(weak_point_signals, verified_replies, assistant_replies)
    summary = {
        "schemaVersion": "a3.coaching-summary.v1",
        "questionCount": len(user_questions),
        "assistantReplyCount": len(assistant_replies),
        "verifiedReplyCount": len(verified_replies),
        "unverifiedReplyCount": len(assistant_replies) - len(verified_replies),
        "citationCount": citation_count,
        "visualEvidenceCount": visual_evidence_count,
        "weakPoints": weak_point_signals,
        "masterySignals": {
            "verifiedReplyCount": len(verified_replies),
            "visualEvidenceCount": visual_evidence_count,
            "citationCount": citation_count,
        },
        "nextActions": [next_action],
        "recommendedReviewTasks": [
            {
                "title": f"复习{weak_point_signals[0]}相关例题" if weak_point_signals else "完成一次随堂测评",
                "href": next_action["href"],
                "reason": next_action["reason"],
            }
        ],
        "weakPointSignals": weak_point_signals,
        "latestQuestions": latest_questions,
        "nextAction": next_action,
        "generatedAt": timezone.now().isoformat(),
    }
    completed_at = timezone.now()
    session.summary = _coaching_summary_sentence(session.topic_title, summary)
    session.metadata = {
        **metadata,
        "summary": summary,
        "summaryCompletedAt": completed_at.isoformat(),
    }
    session.status = CoachingSessionStatus.ENDED
    session.ended_at = session.ended_at or completed_at
    session.save(update_fields=["summary", "metadata", "status", "ended_at", "updated_at"])
    create_notification(
        title="面对面辅导总结已生成",
        user=user,
        detail=session.summary,
        notification_type=NotificationType.SYSTEM,
        action_url=next_action["href"],
        payload={"coachingSessionId": str(session.id), "summary": summary},
    )
    session.refresh_from_db()
    return {"summary": summary, "session": _serialize_coaching_session_row(session)}


@transaction.atomic
def append_coaching_messages(
    user,
    raw_messages: list,
    summary: str = "",
    tutor_persona_id: str = "",
) -> dict:
    if not isinstance(raw_messages, list) or not raw_messages:
        raise ValueError("请提供面对面辅导消息")
    user = user.__class__.objects.select_for_update().get(pk=user.pk)
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    session = _latest_active_coaching_session(user, lock=True)
    session_metadata = session.metadata if session is not None and isinstance(session.metadata, dict) else {}
    stored_snapshot = _coaching_tutor_persona_snapshot(session)
    requested_id = tutor_persona_id.strip() if isinstance(tutor_persona_id, str) else ""
    explicit_request = bool(requested_id) or tutor_persona_id not in ("", None)

    if stored_snapshot is not None and (
        not explicit_request or requested_id == stored_snapshot.get("id")
    ):
        persona_snapshot = stored_snapshot
        fallback_used = bool(session_metadata.get("fallbackUsed"))
    else:
        tutor_persona, fallback_used = _resolve_coaching_tutor_persona(user, tutor_persona_id)
        persona_snapshot = public_tutor_persona(tutor_persona)
        if session is not None and stored_snapshot is not None and explicit_request:
            session.status = CoachingSessionStatus.ENDED
            session.ended_at = timezone.now()
            session.save(update_fields=["status", "ended_at", "updated_at"])
            session = None
    if session is None:
        session = _create_coaching_session(user)
    metadata = session.metadata if isinstance(session.metadata, dict) else {}
    if "tutorPersona" not in metadata:
        session.metadata = {
            **metadata,
            "tutorPersona": persona_snapshot,
            "fallbackUsed": fallback_used,
        }
        session.save(update_fields=["metadata", "updated_at"])
    created_messages = []
    saw_valid_message = False
    existing_client_ids = {
        str(item)
        for item in session.messages.exclude(metadata__clientId__isnull=True).values_list("metadata__clientId", flat=True)
    }
    batch_started_at = timezone.now()
    batch_index = 0
    for item in raw_messages[:8]:
        if not isinstance(item, dict):
            continue
        message = _serialize_coaching_message(item)
        if not item.get("createdAt"):
            message["createdAt"] = (batch_started_at + timedelta(microseconds=batch_index)).isoformat()
        batch_index += 1
        if message["content"]:
            saw_valid_message = True
        if message["id"] in existing_client_ids:
            continue
        if message["content"]:
            created_messages.append(_create_coaching_message(session, message))
            existing_client_ids.add(message["id"])
    if not saw_valid_message:
        raise ValueError("请提供有效的面对面辅导消息")
    if summary:
        session.summary = str(summary)[:1000]
    session.topic_title = session.topic_title or _infer_coaching_topic(user)
    session.save(update_fields=["summary", "topic_title", "updated_at"])
    for message in created_messages:
        if message.role != CoachingMessageRole.USER:
            continue
        metadata = message.metadata if isinstance(message.metadata, dict) else {}
        _safe_record_learning_event(
            user,
            event_type="coach_message_sent",
            target_type="coaching_message",
            target_id=str(message.id),
            knowledge_point_id=str(session.knowledge_point_id or ""),
            metadata={
                "role": message.role,
                "clientId": str(metadata.get("clientId") or ""),
                "contentPreview": message.content[:200],
                "sessionId": str(session.id),
                "source": "coaching",
            },
        )
    messages = list(session.messages.order_by("created_at", "id")[:60])
    persisted = _serialize_coaching_session_payload(session, messages)

    from backend.apps.profiles.dynamic_profile import append_learning_event

    latest_user_messages = [item for item in persisted["messages"][-8:] if item.get("role") == "user"]
    latest_assistant_messages = [item for item in persisted["messages"][-8:] if item.get("role") == "assistant"]
    append_learning_event(
        profile,
        event_type="coaching_qa",
        summary="面对面辅导记录已写入画像事件",
        source="coaching",
        importance=0.65,
        signals={
            "questionCount": len(latest_user_messages),
            "assistantReplyCount": len(latest_assistant_messages),
            "verified": any(bool(item.get("verified")) for item in latest_assistant_messages),
            "citations": [
                citation
                for item in latest_assistant_messages
                for citation in (item.get("citations") if isinstance(item.get("citations"), list) else [])
            ][:8],
        },
        raw_preview=(latest_user_messages[-1].get("content") if latest_user_messages else ""),
        save=True,
    )
    return {"session": persisted}


@transaction.atomic
def end_coaching_session(user) -> dict:
    session = _latest_active_coaching_session(user, lock=True)
    if session is None:
        return {"session": _serialize_coaching_session_payload(None, [])}
    session.status = CoachingSessionStatus.ENDED
    session.ended_at = timezone.now()
    session.save(update_fields=["status", "ended_at", "updated_at"])
    messages = list(session.messages.order_by("created_at", "id")[:60])
    return {"session": _serialize_coaching_session_payload(session, messages)}


def _latest_active_coaching_session(user, *, lock: bool = False) -> CoachingSession | None:
    sessions = CoachingSession.objects.select_for_update() if lock else CoachingSession.objects
    return (
        sessions.filter(user=user, status=CoachingSessionStatus.ACTIVE)
        .order_by("-updated_at", "-created_at")
        .first()
    )


def _create_coaching_session(user) -> CoachingSession:
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).select_related("course").first()
    current = None
    if path:
        current = path.items.filter(status=PathItemStatus.CURRENT).select_related("knowledge_point").first()
    point = current.knowledge_point if current else None
    return CoachingSession.objects.create(
        user=user,
        course=path.course if path else None,
        knowledge_point=point,
        topic_title=point.title if point else "",
    )


def _infer_coaching_topic(user) -> str:
    session = _latest_active_coaching_session(user)
    if session and session.topic_title:
        return session.topic_title
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
    if not path:
        return ""
    current = path.items.filter(status=PathItemStatus.CURRENT).select_related("knowledge_point").first()
    return current.knowledge_point.title if current else ""


def _import_legacy_coaching_session(profile: LearnerProfile) -> CoachingSession | None:
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    legacy = extra_profile.get("coachingSession") if isinstance(extra_profile.get("coachingSession"), dict) else {}
    raw_messages = legacy.get("messages") if isinstance(legacy.get("messages"), list) else []
    if not raw_messages:
        return None
    session = _create_coaching_session(profile.user)
    session.summary = str(legacy.get("summary") or "")[:1000]
    metadata = session.metadata if isinstance(session.metadata, dict) else {}
    metadata["legacyExtraProfileImport"] = True
    metadata["legacyUpdatedAt"] = str(legacy.get("updatedAt") or "")
    session.metadata = metadata
    session.save(update_fields=["summary", "metadata", "updated_at"])
    for item in raw_messages[:60]:
        if isinstance(item, dict):
            message = _serialize_coaching_message(item)
            if message["content"]:
                _create_coaching_message(session, message)
    return session


def _create_coaching_message(session: CoachingSession, message: dict) -> CoachingMessage:
    metadata = {"clientId": message["id"]}
    if isinstance(message.get("metadata"), dict):
        metadata.update(_coaching_message_metadata(message["metadata"]))
    created_at = _coaching_created_at(message.get("createdAt"))
    return CoachingMessage.objects.create(
        session=session,
        role=message["role"],
        content=message["content"],
        verified=bool(message.get("verified")) if message["role"] == "assistant" else False,
        citations=message.get("citations") if isinstance(message.get("citations"), list) else [],
        claims=message.get("claims") if isinstance(message.get("claims"), list) else [],
        safety=message.get("safety") if isinstance(message.get("safety"), dict) else {},
        refusal_reason=str(message.get("refusalReason") or "")[:500],
        degraded=bool(message.get("degraded")),
        metadata=metadata,
        created_at=created_at,
    )


def _serialize_coaching_session_payload(session: CoachingSession | None, messages: list[CoachingMessage]) -> dict:
    return {
        "schemaVersion": "a3.coaching-session.v1",
        "id": str(session.id) if session else "",
        "status": session.status if session else "active",
        "topicTitle": session.topic_title if session else "",
        "messages": [_serialize_coaching_message_record(item) for item in messages],
        "summary": session.summary if session else "",
        "tutorPersona": _coaching_tutor_persona_snapshot(session),
        "updatedAt": session.updated_at.isoformat() if session else "",
    }


def _serialize_coaching_session_row(session: CoachingSession) -> dict:
    prefetched = getattr(session, "_prefetched_objects_cache", {})
    messages = list(prefetched.get("messages", session.messages.all()))
    user_questions = [message for message in messages if message.role == CoachingMessageRole.USER]
    verified_replies = [
        message
        for message in messages
        if message.role == CoachingMessageRole.ASSISTANT and message.verified
    ]
    citation_count = sum(
        len(message.citations if isinstance(message.citations, list) else [])
        for message in messages
        if message.role == CoachingMessageRole.ASSISTANT
    )
    return {
        "id": str(session.id),
        "status": session.status,
        "topicTitle": session.topic_title,
        "summary": session.summary,
        "tutorPersona": _coaching_tutor_persona_snapshot(session),
        "questionCount": len(user_questions),
        "verifiedReplyCount": len(verified_replies),
        "citationCount": citation_count,
        "startedAt": session.started_at.isoformat(),
        "endedAt": session.ended_at.isoformat() if session.ended_at else None,
        "updatedAt": session.updated_at.isoformat(),
    }


def _resolve_coaching_tutor_persona(user, tutor_persona_id: str = "") -> tuple[dict, bool]:
    requested_id = tutor_persona_id.strip() if isinstance(tutor_persona_id, str) else ""
    if requested_id:
        tutor_persona = resolve_tutor_persona(requested_id)
        fallback_used = tutor_persona_configuration_fallback_used(tutor_persona)
    elif tutor_persona_id not in ("", None):
        tutor_persona = None
        fallback_used = False
    else:
        preference, preference_fallback_used = resolve_user_tutor_preference(user)
        tutor_persona = resolve_tutor_persona(preference["personaId"])
        fallback_used = (
            preference_fallback_used
            or tutor_persona_configuration_fallback_used(tutor_persona)
        )
    if tutor_persona is None or "coaching" not in tutor_persona.get("allowedWorkflows", []):
        raise ValueError("不支持该辅导风格")
    return tutor_persona, fallback_used


def _coaching_tutor_persona_snapshot(session: CoachingSession | None) -> dict | None:
    if session is None or not isinstance(session.metadata, dict):
        return None
    snapshot = session.metadata.get("tutorPersona")
    if not isinstance(snapshot, dict):
        return None
    try:
        return public_tutor_persona(snapshot)
    except KeyError:
        return None


def _coaching_weak_point_signals(questions: list[str]) -> list[str]:
    text = " ".join(questions)
    signals = []
    for keyword in ["进程", "线程", "调度", "死锁", "信号量", "虚拟内存", "页面置换", "文件系统", "磁盘调度"]:
        if keyword in text:
            signals.append(keyword)
    return signals[:5]


def _coaching_next_action(weak_point_signals: list[str], verified_replies: list[CoachingMessage], assistant_replies: list[CoachingMessage]) -> dict:
    if weak_point_signals:
        return {
            "label": "加入错题复盘",
            "href": "/a3/wrong-notebook",
            "reason": f"本次辅导暴露了 {weak_point_signals[0]} 相关薄弱点，建议安排复盘。",
        }
    if assistant_replies and len(verified_replies) < len(assistant_replies):
        return {
            "label": "补充知识库资料",
            "href": "/a3/knowledge-base",
            "reason": "本次存在未验证回答，补充资料后再追问能提升可信度。",
        }
    return {
        "label": "生成随堂测评",
        "href": "/a3/assessment",
        "reason": "本次回答已有引用证据，建议通过测评确认掌握度。",
    }


def _coaching_summary_sentence(topic_title: str, summary: dict) -> str:
    topic = topic_title or "面对面辅导"
    return f"{topic}：完成 {summary['questionCount']} 次提问，{summary['verifiedReplyCount']} 条回答已验证，下一步建议：{summary['nextAction']['label']}。"


def _serialize_coaching_message_record(message: CoachingMessage) -> dict:
    metadata = message.metadata if isinstance(message.metadata, dict) else {}
    return {
        "id": str(metadata.get("clientId") or message.id),
        "role": message.role,
        "content": message.content,
        "verified": message.verified if message.role == "assistant" else False,
        "citations": message.citations if isinstance(message.citations, list) else [],
        "claims": message.claims if isinstance(message.claims, list) else [],
        "safety": message.safety if isinstance(message.safety, dict) and message.safety else None,
        "refusalReason": message.refusal_reason,
        "degraded": message.degraded,
        "createdAt": message.created_at.isoformat(),
    }


def _coaching_created_at(value) -> timezone.datetime:
    parsed = parse_datetime(str(value or ""))
    if parsed is None:
        return timezone.now()
    return parsed if timezone.is_aware(parsed) else timezone.make_aware(parsed)


def _serialize_coaching_message(item: dict) -> dict:
    role = str(item.get("role") or "").strip()
    if role not in {"user", "assistant"}:
        role = "assistant"
    content = str(item.get("content") or "").strip()[:4000]
    return {
        "id": str(item.get("id") or uuid4()),
        "role": role,
        "content": content,
        "verified": bool(item.get("verified")) if role == "assistant" else False,
        "citations": item.get("citations") if isinstance(item.get("citations"), list) else [],
        "claims": item.get("claims") if isinstance(item.get("claims"), list) else [],
        "safety": item.get("safety") if isinstance(item.get("safety"), dict) else None,
        "refusalReason": str(item.get("refusalReason") or "")[:500],
        "degraded": bool(item.get("degraded")),
        "metadata": _coaching_message_metadata(item.get("metadata") if isinstance(item.get("metadata"), dict) else {}),
        "createdAt": str(item.get("createdAt") or timezone.now().isoformat()),
    }


def _coaching_message_metadata(metadata: dict) -> dict:
    allowed = {}
    for key in ("realtime", "audio", "visualEvidence", "evidence", "toolCall"):
        value = metadata.get(key)
        if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
            allowed[key] = value
    return allowed


def _serialize_classroom_target(item: LearningPathItem, wrong_count: int) -> dict:
    point = item.knowledge_point
    return {
        "id": str(point.id),
        "title": point.title,
        "description": point.description,
        "chapter": {"order": point.chapter.order, "title": point.chapter.title},
        "progress": item.progress,
        "status": item.status,
        "estimatedMinutes": item.estimated_minutes,
        "reason": item.reason,
        "wrongCount": wrong_count,
    }


def _knowledge_sources(user, point: KnowledgePoint | None) -> list[dict]:
    if not point:
        return []
    resource_names = _indexed_resource_names(user)
    sources: list[dict] = []
    sources.append({
        "id": "course-point",
        "title": point.title,
        "location": f"第 {point.chapter.order} 章 · {point.chapter.title}",
        "type": "课程知识点",
        "sourceTypeLabel": "课程知识点",
        "sourceOrigin": "学习路径",
        "score": None,
        "snippet": point.description or "当前知识点暂无知识库切片，建议先上传或重建本地知识库。",
    })
    sources = _append_recent_upload_sources(sources, resource_names)
    return sources


def _append_recent_upload_sources(sources: list[dict], resource_names: dict[str, str]) -> list[dict]:
    if not resource_names or len(sources) >= 3:
        return sources
    existing_titles = {str(source.get("title") or "") for source in sources}
    existing_locations = {str(source.get("location") or "") for source in sources}
    recent_resources = KnowledgeResource.objects.filter(
        status=ResourceStatus.INDEXED,
        stored_path__in=resource_names.keys(),
    ).order_by("-updated_at")[: 3 - len(sources)]
    for resource in recent_resources:
        display_location = format_source_display_location({"original_name": resource.original_name}, fallback="教师上传资料")
        if resource.original_name in existing_titles or display_location in existing_locations:
            continue
        sources.append({
            "id": f"source-{len(sources) + 1}",
            "title": resource.original_name,
            "location": display_location,
            "type": "教师上传资料",
            "sourceTypeLabel": format_source_type_label({"original_name": resource.original_name}, fallback="教师上传资料"),
            "sourceOrigin": source_origin_label({"resource_id": str(resource.id)}),
            "score": None,
            "snippet": f"教师上传资源已索引：{resource.original_name}。可用于课堂追问、知识库搜索和引用核验。",
        })
        existing_titles.add(resource.original_name)
        existing_locations.add(display_location)
        if len(sources) >= 3:
            break
    return sources


def _indexed_resource_names(user) -> dict[str, str]:
    return {
        stored_path: original_name
        for stored_path, original_name in accessible_resources_for_user(user).filter(
            status=ResourceStatus.INDEXED,
        ).values_list("stored_path", "original_name")
        if stored_path
    }


def _enrich_knowledge_metadata(metadata: dict, resource_names: dict[str, str]) -> dict:
    source_path = str(metadata.get("source_path") or metadata.get("file_path") or "")
    if source_path in resource_names:
        return {**metadata, "original_name": resource_names[source_path]}
    return metadata


def _knowledge_source_title(metadata: dict, point: KnowledgePoint) -> str:
    title = (
        metadata.get("original_name")
        or metadata.get("title")
        or metadata.get("file_name")
        or metadata.get("source")
        or point.title
    )
    return str(title)


def _knowledge_source_location(metadata: dict) -> str:
    return format_source_display_location(metadata)


def _classroom_plan_task_bindings(user) -> dict[str, dict]:
    plan = current_study_plan(user)
    bindings: dict[str, dict] = {}
    if not isinstance(plan, dict):
        return bindings

    for day in plan.get("days", []):
        if not isinstance(day, dict):
            continue
        day_index = int(day.get("dayIndex") or 0)
        for task in day.get("tasks", []):
            if not isinstance(task, dict):
                continue
            if task.get("type") not in {"practice", "review"}:
                continue
            point_id = str(task.get("knowledgePointId") or "").strip()
            task_id = str(task.get("id") or "").strip()
            if not point_id or not task_id:
                continue
            if point_id in bindings and bindings[point_id].get("status") != "completed":
                continue
            bindings[point_id] = {
                "dayIndex": day_index,
                "taskId": task_id,
                "completed": task.get("status") == "completed",
                "status": str(task.get("status") or "pending"),
            }
    return bindings


def _classroom_recommendations(nodes: list[dict], point: KnowledgePoint | None, plan_task_bindings: dict[str, dict] | None = None) -> list[dict]:
    plan_task_bindings = plan_task_bindings or {}
    recommendations = []
    for node in nodes:
        point_id = str(node.get("id") or "")
        recommendations.append({
            "title": node["title"],
            "meta": f"第 {node['chapter']['order']} 章 · {node['chapter']['title']} · 难度 {node['difficulty']}",
            "progress": node["progress"],
            "href": "/a3/learning-path",
            "planTask": plan_task_bindings.get(point_id),
        })
    if point and not recommendations:
        recommendations.append({
            "title": f"{point.title} 随堂巩固",
            "meta": f"预计 {point.estimated_minutes} 分钟 · 操作系统",
            "progress": 0,
            "href": "/a3/assessment",
            "planTask": plan_task_bindings.get(str(point.id)),
        })
    return recommendations


def _classroom_agents(has_sources: bool) -> list[dict]:
    return [
        {
            "id": "teacher",
            "name": "主讲教师 Agent",
            "role": "结构化讲解",
            "description": "根据当前学习目标拆解概念、公式和例题。",
            "status": "active",
            "color": "#2563eb",
        },
        {
            "id": "retriever",
            "name": "知识检索 Agent",
            "role": "本地知识库溯源",
            "description": "从课件、讲义和题库中检索依据，减少无来源回答。",
            "status": "active" if has_sources else "waiting",
            "color": "#0f766e",
        },
        {
            "id": "coach",
            "name": "练习诊断 Agent",
            "role": "错题与测评分析",
            "description": "结合错题记录和测评结果推荐下一步练习。",
            "status": "waiting",
            "color": "#7c3aed",
        },
    ]
def _teacher_courses(user) -> list[Course]:
    return list(
        Course.objects.filter(
            teaching_assignments__teacher=user,
            is_active=True,
        ).distinct()
    )


def _teacher_students(user, courses: list[Course] | None = None) -> list:
    User = get_user_model()
    courses = courses if courses is not None else _teacher_courses(user)
    if not courses:
        return []
    student_ids = (
        CourseEnrollment.objects.filter(course__in=courses, user__role="student", user__is_active=True)
        .values_list("user_id", flat=True)
        .distinct()
    )
    return list(
        User.objects.filter(id__in=student_ids)
        .prefetch_related("learner_profile", "learning_paths__items", "wrong_questions")
        .order_by("-created_at")[:80]
    )


def teacher_workbench(user) -> dict:
    courses = _teacher_courses(user)
    students = _teacher_students(user, courses)
    active_paths = list(
        LearningPath.objects.filter(user__in=students, course__in=courses, status=LearningPathStatus.ACTIVE)
        .select_related("user", "course")
        .prefetch_related("items__knowledge_point__chapter")
    )
    path_by_user = {path.user_id: path for path in active_paths}
    wrong_by_user = {
        item["user_id"]: item["total"]
        for item in WrongQuestion.objects.filter(user__in=students, mastered=False).values("user_id").annotate(total=Max("wrong_count"))
    }
    student_rows = [_teacher_student_row(student, path_by_user.get(student.id), int(wrong_by_user.get(student.id, 0))) for student in students[:12]]
    weak_points = _teacher_weak_points(students, courses)
    kb_stats = _teacher_kb_stats(user)
    resource_pack_summary = _teacher_resource_pack_summary(student_rows)
    coaching_summary = _teacher_coaching_summary(students, courses)
    total = len(students)
    avg_progress = round(sum(row["progress"] for row in student_rows) / len(student_rows)) if student_rows else 0
    at_risk = sum(1 for row in student_rows if row["riskLevel"] == "high")
    return {
        "metrics": [
            {"label": "学生数", "value": str(total), "delta": "已接入学习画像", "tone": "blue"},
            {"label": "平均进度", "value": f"{avg_progress}%", "delta": "来自当前学习路径", "tone": "green"},
            {"label": "待干预", "value": str(at_risk), "delta": "错题或进度风险", "tone": "orange" if at_risk else "green"},
            {"label": "知识库资源", "value": str(kb_stats["indexedFiles"]), "delta": f"{kb_stats['runningJobs']} 个任务处理中", "tone": "violet"},
        ],
        "students": student_rows,
        "weakPoints": weak_points,
        "knowledgeBase": kb_stats,
        "tasks": _teacher_tasks(at_risk, weak_points, kb_stats),
        "distribution": _teacher_distribution(student_rows),
        "resourcePackSummary": resource_pack_summary,
        "coachingSummary": coaching_summary,
    }


def _compute_risk_reason(risk: str, wrong_score: int, progress: int) -> str:
    if risk == "low":
        return "学习状态良好，按节奏推进中。"
    reasons = []
    if wrong_score >= 3:
        reasons.append(f"错题数量偏多（{wrong_score} 道），需要优先安排复盘")
    elif wrong_score >= 1:
        reasons.append(f"存在 {wrong_score} 道待巩固错题")
    if progress < 30:
        reasons.append(f"学习进度严重落后（{progress}%），建议教师介入辅导")
    elif progress < 60:
        reasons.append(f"学习进度偏低（{progress}%）")
    return "；".join(reasons) + "。" if reasons else "进度或错题指标偏低，建议关注。"


def _teacher_student_row(student, path: LearningPath | None, wrong_score: int) -> dict:
    items = list(path.items.all()) if path else []
    progress = round(sum(item.progress for item in items) / len(items)) if items else 0
    current = next((item for item in items if item.status == PathItemStatus.CURRENT), None)
    risk = "low"
    if wrong_score >= 3 or progress < 30:
        risk = "high"
    elif wrong_score >= 1 or progress < 60:
        risk = "medium"
    risk_reason = _compute_risk_reason(risk, wrong_score, progress)
    profile = getattr(student, "learner_profile", None)
    current_point = current.knowledge_point.title if current else "尚未开始"
    prescription = _student_prescription(risk, progress, wrong_score, current_point)
    resource_pack = _student_resource_pack_status(student)
    return {
        "id": str(student.id),
        "name": student.display_name,
        "grade": profile.grade if profile else "",
        "majorDirection": profile.major_direction if profile else student.school,
        "progress": progress,
        "currentPoint": current_point,
        "wrongSignal": wrong_score,
        "riskLevel": risk,
        "riskReason": risk_reason,
        "resourcePack": resource_pack,
        "prescription": prescription,
        "interventionAction": prescription["primaryAction"],
    }


def _student_resource_pack_status(student) -> dict:
    profile = getattr(student, "learner_profile", None)
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    runs = _resource_pack_log_payloads(student)
    if not runs:
        runs = [item for item in extra_profile.get("resourcePackRuns", []) if isinstance(item, dict)]
    latest = runs[0] if runs else None
    verified_source_count = sum(_safe_int(item.get("verifiedSourceCount"), 0) for item in runs)
    practice_count = sum(1 for item in runs if str(item.get("practiceHref") or "").startswith("/a3/assessment"))
    audit_artifacts = _openmaic_artifacts_for_user(student)
    if audit_artifacts:
        artifact_counts = _aggregate_artifact_counts([{"multimodalArtifacts": audit_artifacts}])
        latest_artifacts = audit_artifacts[:8]
    else:
        artifact_counts = _aggregate_artifact_counts(runs)
        latest_artifacts = _latest_artifacts_from_runs(runs)
    return {
        "totalRuns": len(runs),
        "verifiedSourceCount": verified_source_count,
        "practiceStartedCount": practice_count,
        "latestGoal": latest.get("learningGoal") if latest else "",
        "latestAt": latest.get("completedAt") if latest else "",
        "artifactCounts": artifact_counts,
        "latestArtifacts": latest_artifacts,
        "nextAction": {
            "label": "推送专项练习" if runs else "推送推荐资源",
            "href": latest.get("practiceHref") if latest else "/a3/recommendations",
            "type": "assessment" if runs else "notification",
        },
    }


def _resource_pack_log_payloads(user) -> list[dict]:
    return [
        _serialize_resource_pack_log(log)
        for log in ResourcePackLog.objects.filter(user=user).order_by("-completed_at", "-created_at")[:30]
    ]


def _serialize_resource_pack_log(log: ResourcePackLog) -> dict:
    payload = log.payload if isinstance(log.payload, dict) else {}
    return {
        "schemaVersion": payload.get("schemaVersion") or "a3.resource-pack-run.v1",
        "runId": payload.get("runId") or str(log.id),
        "resourcePackId": payload.get("resourcePackId") or "",
        "taskId": log.task_id,
        "taskTitle": log.task_title,
        "learningGoal": log.learning_goal,
        "verifiedSourceCount": log.verified_source_count,
        "confidence": log.confidence,
        "practiceHref": log.practice_href,
        "source": log.source,
        "completedAt": log.completed_at.isoformat(),
        "nextStepReason": log.next_step_reason,
        "multimodalArtifacts": _serialize_multimodal_artifacts(payload),
    }


def _teacher_resource_pack_summary(student_rows: list[dict]) -> dict:
    total_students = len(student_rows)
    completed_students = sum(1 for student in student_rows if int(student.get("resourcePack", {}).get("totalRuns") or 0) > 0)
    total_runs = sum(int(student.get("resourcePack", {}).get("totalRuns") or 0) for student in student_rows)
    verified_source_count = sum(int(student.get("resourcePack", {}).get("verifiedSourceCount") or 0) for student in student_rows)
    practice_started_count = sum(int(student.get("resourcePack", {}).get("practiceStartedCount") or 0) for student in student_rows)
    artifact_counts = _aggregate_artifact_counts([
        {"multimodalArtifacts": artifact}
        for student in student_rows
        for artifact in student.get("resourcePack", {}).get("latestArtifacts", [])
    ])
    latest_artifacts = [
        artifact
        for student in student_rows
        for artifact in student.get("resourcePack", {}).get("latestArtifacts", [])
    ][:8]
    needs_practice = [
        {"id": student["id"], "name": student["name"], "currentPoint": student["currentPoint"]}
        for student in student_rows
        if int(student.get("resourcePack", {}).get("totalRuns") or 0) == 0
    ][:5]
    return {
        "schemaVersion": "a3.teacher-resource-pack-summary.v1",
        "totalStudents": total_students,
        "completedStudents": completed_students,
        "completionRate": round(completed_students * 100 / total_students) if total_students else 0,
        "totalRuns": total_runs,
        "verifiedSourceCount": verified_source_count,
        "practiceStartedCount": practice_started_count,
        "artifactCounts": artifact_counts,
        "latestArtifacts": latest_artifacts,
        "needsPracticeStudents": needs_practice,
        "nextAction": {
            "label": "提醒未练习学生",
            "href": "/a3/teacher",
            "type": "notification",
        },
    }


def _teacher_coaching_summary(students: list, courses: list[Course] | None = None) -> dict:
    queryset = CoachingSession.objects.filter(user__in=students)
    if courses is not None:
        queryset = queryset.filter(course__in=courses)
    sessions = list(queryset.prefetch_related("messages").order_by("-updated_at", "-created_at")[:100])
    messages = [message for session in sessions for message in session.messages.all()]
    verified_reply_count = sum(1 for message in messages if message.role == CoachingMessageRole.ASSISTANT and message.verified)
    question_count = sum(1 for message in messages if message.role == CoachingMessageRole.USER)
    return {
        "schemaVersion": "a3.teacher-coaching-summary.v1",
        "totalSessions": len(sessions),
        "studentsUsedCoaching": len({session.user_id for session in sessions}),
        "questionCount": question_count,
        "verifiedReplyCount": verified_reply_count,
        "latestSessions": [_serialize_coaching_session_row(session) for session in sessions[:5]],
        "nextAction": {
            "label": "查看待干预学生",
            "href": "/a3/teacher",
            "type": "intervention",
        },
    }


def _serialize_multimodal_artifacts(payload: dict) -> list[dict]:
    artifacts = payload.get("multimodalArtifacts") if isinstance(payload.get("multimodalArtifacts"), list) else []
    rows = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        artifact_type = str(artifact.get("type") or "")
        if artifact_type not in {"openmaic_classroom", "openmaic_video", "openmaic_pptx_export"}:
            continue
        rows.append({
            "type": artifact_type,
            "status": str(artifact.get("status") or "unknown"),
            "provider": str(artifact.get("provider") or ""),
            "jobId": str(artifact.get("jobId") or ""),
            "classroomUrl": str(artifact.get("classroomUrl") or ""),
            "videoUrl": str(artifact.get("videoUrl") or ""),
            "resourceType": str(artifact.get("resourceType") or ""),
            "scenesCount": _safe_int(artifact.get("scenesCount"), 0),
            "pptxExportable": bool(artifact.get("pptxExportable")),
            "fileName": str(artifact.get("fileName") or ""),
            "slidesCount": _safe_int(artifact.get("slidesCount"), 0),
            "degradedReason": str(artifact.get("degradedReason") or ""),
        })
    return rows[:10]


def _aggregate_artifact_counts(runs: list[dict]) -> dict:
    artifacts = [
        artifact
        for run in runs
        for artifact in (
            run.get("multimodalArtifacts")
            if isinstance(run.get("multimodalArtifacts"), list)
            else [run.get("multimodalArtifacts")] if isinstance(run.get("multimodalArtifacts"), dict) else []
        )
        if isinstance(artifact, dict)
    ]
    classroom = [artifact for artifact in artifacts if artifact.get("type") == "openmaic_classroom"]
    video = [artifact for artifact in artifacts if artifact.get("type") == "openmaic_video"]
    pptx_export = [artifact for artifact in artifacts if artifact.get("type") == "openmaic_pptx_export"]
    return {
        "classroom": len(classroom),
        "classroomSucceeded": sum(1 for artifact in classroom if artifact.get("status") == "succeeded"),
        "video": len(video),
        "videoSucceeded": sum(1 for artifact in video if artifact.get("status") == "succeeded"),
        "videoDegraded": sum(1 for artifact in video if artifact.get("status") != "succeeded" or bool(artifact.get("degradedReason"))),
        "pptxExport": len(pptx_export),
        "pptxExportSucceeded": sum(1 for artifact in pptx_export if artifact.get("status") == "succeeded"),
    }


def _latest_artifacts_from_runs(runs: list[dict]) -> list[dict]:
    artifacts = []
    for run in runs:
        run_artifacts = run.get("multimodalArtifacts") if isinstance(run.get("multimodalArtifacts"), list) else []
        for artifact in run_artifacts:
            if not isinstance(artifact, dict):
                continue
            artifacts.append({
                **artifact,
                "resourcePackId": run.get("resourcePackId") or "",
                "learningGoal": run.get("learningGoal") or "",
                "completedAt": run.get("completedAt") or "",
            })
    return artifacts[:8]


def _openmaic_artifacts_for_user(user) -> list[dict]:
    logs = {
        str(payload.get("resourcePackId") or ""): payload
        for payload in _resource_pack_log_payloads(user)
        if payload.get("resourcePackId")
    }
    rows = []
    records = OpenMAICArtifact.objects.filter(user=user).order_by("-created_at", "-id")[:30]
    for record in records:
        payload = dict(record.payload or {})
        pack_log = logs.get(record.resource_pack_id, {})
        payload.setdefault("type", record.artifact_type)
        payload.setdefault("status", record.status)
        payload.setdefault("provider", record.provider)
        payload.setdefault("jobId", record.job_id)
        payload.setdefault("createdAt", record.created_at.isoformat())
        payload["resourcePackId"] = record.resource_pack_id
        payload["learningGoal"] = payload.get("learningGoal") or pack_log.get("learningGoal") or ""
        payload["completedAt"] = payload.get("completedAt") or payload.get("createdAt") or record.created_at.isoformat()
        rows.append(payload)
    return sorted(rows, key=lambda item: str(item.get("completedAt") or item.get("createdAt") or ""), reverse=True)


def _student_prescription(risk: str, progress: int, wrong_score: int, current_point: str) -> dict:
    if risk == "high":
        title = "需要教师干预"
        reason = f"进度 {progress}%，错题信号 {wrong_score}，建议先处理《{current_point}》的前置概念和错因。"
        primary = {"label": "推送干预提醒", "href": "/a3/teacher", "type": "intervention"}
        actions = [
            {"label": "错题复盘", "href": "/a3/wrong-notebook", "type": "review"},
            {"label": "面对面辅导", "href": "/a3/coaching", "type": "coaching"},
        ]
    elif risk == "medium":
        title = "需要跟进"
        reason = f"当前进度 {progress}%，建议督促完成今日任务并安排一次小测。"
        primary = {"label": "发布阶段测评", "href": "/a3/teacher", "type": "assessment"}
        actions = [
            {"label": "今日任务", "href": "/a3/today", "type": "today"},
            {"label": "阶段测评", "href": "/a3/assessment", "type": "assessment"},
        ]
    else:
        title = "保持节奏"
        reason = "学习节奏稳定，可继续推进学习路径并关注综合应用题。"
        primary = {"label": "推送路径提醒", "href": "/a3/teacher", "type": "notification"}
        actions = [
            {"label": "学习计划", "href": "/a3/study-plan", "type": "plan"},
            {"label": "学习报告", "href": "/a3/report", "type": "report"},
        ]
    return {
        "title": title,
        "reason": reason,
        "primaryAction": primary,
        "actions": actions,
    }


def _teacher_weak_points(students: list, courses: list[Course] | None = None) -> list[dict]:
    counters: dict[str, dict] = {}
    wrong_queryset = WrongQuestion.objects.filter(user__in=students, mastered=False)
    if courses is not None:
        wrong_queryset = wrong_queryset.filter(question__knowledge_point__chapter__course__in=courses)
    wrong_items = (
        wrong_queryset
        .select_related("question__knowledge_point__chapter")
        .order_by("-wrong_count")[:40]
    )
    for item in wrong_items:
        point = item.question.knowledge_point
        bucket = counters.setdefault(point.code, {"label": point.title, "chapter": point.chapter.title, "count": 0, "totalWrong": 0})
        bucket["count"] += 1
        bucket["totalWrong"] += item.wrong_count
    rows = sorted(counters.values(), key=lambda row: (row["count"], row["totalWrong"]), reverse=True)[:6]
    if not rows:
        rows = [
            {"label": "处理机调度算法", "chapter": "处理机调度与死锁", "count": 0, "totalWrong": 0},
            {"label": "虚拟内存与页面置换", "chapter": "虚拟内存管理", "count": 0, "totalWrong": 0},
        ]
    max_count = max((row["count"] for row in rows), default=1) or 1
    return [
        {
            "label": row["label"],
            "meta": row["chapter"],
            "value": row["count"],
            "progress": round(row["count"] * 100 / max_count),
            "tone": "red" if row["count"] >= 3 else "orange" if row["count"] else "blue",
        }
        for row in rows
    ]


def _teacher_kb_stats(user) -> dict:
    resources = KnowledgeResource.objects.filter(owner=user)
    jobs = KnowledgeIndexJob.objects.filter(owner=user)
    return {
        "totalFiles": resources.count(),
        "indexedFiles": resources.filter(status=ResourceStatus.INDEXED).count(),
        "failedFiles": resources.filter(status=ResourceStatus.FAILED).count(),
        "runningJobs": jobs.filter(status__in=[IndexJobStatus.QUEUED, IndexJobStatus.RUNNING]).count(),
    }


def _teacher_tasks(at_risk: int, weak_points: list[dict], kb_stats: dict) -> list[dict]:
    primary_weak = weak_points[0]["label"] if weak_points else "当前章节"
    tasks = [
        {"title": f"生成《{primary_weak}》专项练习", "type": "assessment", "status": "ready"},
        {"title": "推送本周学习路径提醒", "type": "notification", "status": "ready"},
        {"title": "生成班级阶段报告", "type": "report", "status": "ready"},
    ]
    if at_risk:
        tasks.insert(0, {"title": f"查看 {at_risk} 名待干预学生", "type": "intervention", "status": "warning"})
    if kb_stats["runningJobs"]:
        tasks.append({"title": "检查知识库索引任务", "type": "knowledge_base", "status": "running"})
    return tasks


def _teacher_distribution(students: list[dict]) -> list[dict]:
    buckets = [
        {"label": "优秀", "count": sum(1 for item in students if item["progress"] >= 85), "tone": "green"},
        {"label": "良好", "count": sum(1 for item in students if 60 <= item["progress"] < 85), "tone": "blue"},
        {"label": "待加强", "count": sum(1 for item in students if 30 <= item["progress"] < 60), "tone": "orange"},
        {"label": "薄弱", "count": sum(1 for item in students if item["progress"] < 30), "tone": "red"},
    ]
    total = sum(item["count"] for item in buckets) or 1
    for item in buckets:
        item["percent"] = round(item["count"] * 100 / total)
    return buckets


def execute_teacher_task(user, task_type: str, student_id: str = "", message: str = "", dedupe_key: str = "") -> dict:
    students = _teacher_students(user)[:200]
    if task_type == "assessment":
        title = "老师发布了新的阶段测评"
        detail = "请进入题库练习，完成当前学习路径对应的阶段测评。"
        action_url = "/a3/assessment"
        notification_type = NotificationType.ASSESSMENT
    elif task_type == "notification":
        title = "本周学习路径提醒"
        detail = "请按当前个性化学习路径完成今日节点，并及时处理薄弱知识点。"
        action_url = "/a3/learning-path"
        notification_type = NotificationType.LEARNING_TASK
    elif task_type == "report":
        title = "学习报告已更新"
        detail = "系统已更新阶段学习报告，请查看掌握情况和下一步建议。"
        action_url = "/a3/report"
        notification_type = NotificationType.SYSTEM
    elif task_type == "intervention":
        title = "老师发起了学习干预提醒"
        detail = "请优先处理错题本和当前薄弱知识点，必要时进入面对面辅导。"
        action_url = "/a3/wrong-notebook"
        notification_type = NotificationType.TEACHER
    elif task_type == "knowledge_base":
        title = "知识库资源处理提醒"
        detail = "老师已提醒检查本地知识库资源状态，请确认课件索引是否完成。"
        action_url = "/a3/knowledge-base"
        notification_type = NotificationType.KNOWLEDGE_BASE
    elif task_type == "resource_pack_reminder":
        title = "老师提醒你完成推荐资源包"
        detail = "请先进入个性化推荐页选择资源包，加入今日任务后完成专项练习，学习结果会回流到报告和错题本。"
        action_url = "/a3/recommendations"
        notification_type = NotificationType.LEARNING_TASK
        students = [student for student in students if _student_resource_pack_status(student)["totalRuns"] == 0]
    else:
        raise ValueError("不支持的教师任务类型")

    target_student = None
    if student_id:
        target_student = next((student for student in students if str(student.id) == student_id), None)
        if target_student is None:
            raise ValueError("只能给当前授课范围内的学生下发任务")
        students = [target_student]
        if message:
            detail = message[:240]

    created_notifications = 0
    existing_notifications = 0
    dedupe_key = str(dedupe_key or "").strip()[:120]
    for student in students:
        if dedupe_key and UserNotification.objects.filter(user=student, payload__dedupeKey=dedupe_key).exists():
            existing_notifications += 1
            continue
        create_notification(
            title=title,
            user=student,
            detail=detail,
            notification_type=notification_type,
            action_url=action_url,
            payload={
                "teacherId": str(user.id),
                "taskType": task_type,
                "studentId": str(student.id),
                "targetedByTeacher": bool(target_student),
                "actionKind": _teacher_action_kind(action_url),
                **({"dedupeKey": dedupe_key} if dedupe_key else {}),
            },
        )
        created_notifications += 1
    result = {
        "taskType": task_type,
        "createdNotifications": created_notifications,
        "existingNotifications": existing_notifications,
        "title": title,
    }
    if target_student is not None:
        result["targetStudentId"] = str(target_student.id)
        result["targetStudentName"] = target_student.display_name
        result["actionUrl"] = action_url
    return result


def _teacher_action_kind(action_url: str) -> str:
    if "wrong-notebook" in action_url:
        return "review"
    if "assessment" in action_url:
        return "assessment"
    if "report" in action_url:
        return "report"
    if "knowledge-base" in action_url:
        return "knowledge_base"
    return "plan"
