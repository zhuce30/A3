from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from backend.apps.accounts.models import UserRole
from backend.apps.assessments.models import AssessmentAnswer, AssessmentSession, Question, SessionStatus, WrongQuestion
from backend.apps.engagement.models import FavoriteType, NotificationType, UserFavorite
from backend.apps.engagement.services import create_notification
from backend.apps.knowledge_base.graph_builder import safe_rebuild_resource_graph
from backend.apps.knowledge_base.models import (
    KnowledgeBlock,
    KnowledgeIndexJob,
    KnowledgePage,
    KnowledgeParseRun,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.learning.models import Course, CourseEnrollment, CourseTeachingAssignment, LearningPathStatus, PathItemStatus
from backend.apps.learning.services import _repair_default_course_catalog, generate_learning_path, update_path_item_progress
from backend.apps.profiles.models import LearnerProfile


STUDENT_PHONE = "13800000001"
TEACHER_PHONE = "13800000002"
DEMO_PASSWORD = "Demo@123456"
GLOBAL_KB_FILE_NAME = "教学问答数据集.xlsx"


class Command(BaseCommand):
    help = "Seed stable A3 demo accounts and learning data for contest presentation."

    def add_arguments(self, parser):
        parser.add_argument("--student-phone", default=STUDENT_PHONE)
        parser.add_argument("--teacher-phone", default=TEACHER_PHONE)
        parser.add_argument("--password", default=DEMO_PASSWORD)

    @transaction.atomic
    def handle(self, *args, **options):
        student_phone = options["student_phone"]
        teacher_phone = options["teacher_phone"]
        password = options["password"]
        User = get_user_model()

        student = _upsert_user(
            User,
            phone=student_phone,
            password=password,
            role=UserRole.STUDENT,
            display_name="演示学生",
            school="智能制造学院",
        )
        teacher = _upsert_user(
            User,
            phone=teacher_phone,
            password=password,
            role=UserRole.TEACHER,
            display_name="演示教师",
            school="计算机教研室",
        )

        course = _repair_default_course_catalog()
        CourseTeachingAssignment.objects.get_or_create(teacher=teacher, course=course)
        CourseEnrollment.objects.get_or_create(user=student, course=course)

        profile, _ = LearnerProfile.objects.get_or_create(user=student)
        profile.grade = "大二"
        profile.major_direction = "计算机科学与技术"
        profile.foundation_level = "基础较弱"
        profile.daily_study_time = 60
        profile.pace = "standard"
        profile.learning_goals = ["掌握操作系统", "应对课程考试", "补齐进程调度和虚拟内存薄弱点"]
        profile.weak_points = ["处理机调度算法", "同步互斥与信号量", "虚拟内存与页面置换"]
        profile.learning_preferences = {"style": "图解流程+例题推导", "format": "课件讲义+练习题库+代码实验"}
        profile.expected_resources = ["课件讲义", "练习题库", "知识卡片"]
        profile.extra_profile = {"demo": True, "scenario": "A3 contest full-loop demo"}
        profile.save()

        student.profile_completed = True
        student.privacy_accepted = True
        student.onboarding_step = "complete"
        student.save(update_fields=["profile_completed", "privacy_accepted", "onboarding_step", "updated_at"])

        path = generate_learning_path(student, course=course, force=True)
        _mark_first_items_completed(student, path)
        _seed_wrong_questions(student)
        _seed_completed_assessment(student, path)
        _seed_engagement(student)
        _cleanup_e2e_knowledge_resources()
        _seed_material_knowledge_graph(student)
        _seed_global_kb_marker(teacher)
        _repair_global_kb_marker(teacher)

        self.stdout.write(self.style.SUCCESS("A3 demo data seeded."))
        self.stdout.write(f"student: {student_phone} / {password}")
        self.stdout.write(f"teacher: {teacher_phone} / {password}")
        self.stdout.write(f"path: {path.title}")


def _upsert_user(User, *, phone: str, password: str, role: str, display_name: str, school: str):
    user, _ = User.objects.get_or_create(
        phone=phone,
        defaults={
            "role": role,
            "display_name": display_name,
            "school": school,
            "privacy_accepted": True,
            "profile_completed": True,
            "onboarding_step": "complete",
        },
    )
    user.role = role
    user.display_name = display_name
    user.school = school
    user.privacy_accepted = True
    user.profile_completed = True
    user.onboarding_step = "complete"
    user.is_active = True
    user.set_password(password)
    user.save()
    return user


def _mark_first_items_completed(student, path):
    for _ in range(2):
        item = path.items.filter(status=PathItemStatus.CURRENT).order_by("order").first()
        if item is None:
            break
        if item.status != PathItemStatus.COMPLETED:
            update_path_item_progress(student, item, 100)
    current = path.items.filter(status=PathItemStatus.CURRENT).order_by("order").first()
    if current:
        current.progress = max(current.progress, 35)
        current.save(update_fields=["progress"])


def _seed_wrong_questions(student):
    # review_after is in the past for the first two so the demo shows due wrong questions
    wrong_specs = [
        ("OS-SCHEDULING", "B", 3, -1),
        ("OS-SYNC", "A", 2, -1),
        ("OS-VIRTUAL-MEMORY", "B", 1, 2),
    ]
    for code, answer, count, review_delta in wrong_specs:
        question = Question.objects.filter(knowledge_point__code=code).first()
        if not question:
            continue
        wrong, _ = WrongQuestion.objects.get_or_create(user=student, question=question)
        wrong.wrong_count = count
        wrong.consecutive_correct = 0
        wrong.mastered = False
        wrong.last_wrong_answer = answer
        wrong.review_after = timezone.now() + timedelta(days=review_delta)
        wrong.save()


def _seed_completed_assessment(student, path):
    questions = list(
        Question.objects.filter(knowledge_point__chapter__course=path.course, is_active=True)
        .select_related("knowledge_point")
        .order_by("difficulty")[:6]
    )
    if not questions:
        return
    session, _ = AssessmentSession.objects.update_or_create(
        user=student,
        learning_path=path,
        status=SessionStatus.COMPLETED,
        defaults={
            "question_ids": [str(question.id) for question in questions],
            "current_index": len(questions),
            "score": 67,
            "completed_at": timezone.now(),
        },
    )
    session.answers.all().delete()
    for index, question in enumerate(questions):
        correct = index % 3 != 0
        AssessmentAnswer.objects.create(
            session=session,
            question=question,
            selected_answer=question.correct_answer if correct else "A",
            is_correct=correct,
            is_skipped=False,
        )


def _seed_engagement(student):
    UserFavorite.objects.update_or_create(
        user=student,
        title="处理机调度算法复习卡",
        resource_type=FavoriteType.KNOWLEDGE_CARD,
        source="演示知识库",
        defaults={
            "url": "/a3/recommendations",
            "group": "竞赛演示",
            "metadata": {"demo": True, "score": 96},
        },
    )
    for title, detail, notification_type, action_url in [
        ("今日学习任务已生成", "系统已根据画像生成操作系统专项学习路径。", NotificationType.LEARNING_TASK, "/a3/today"),
        ("错题复盘提醒", "进程调度与虚拟内存相关错题需要在 2 天内完成复盘。", NotificationType.ASSESSMENT, "/a3/wrong-notebook"),
        ("知识库引用可用", "操作系统课程资料已经可用于推荐、课堂引用和防幻觉溯源。", NotificationType.KNOWLEDGE_BASE, "/a3/recommendations"),
    ]:
        notification = student.notifications.filter(title=title).first()
        if notification:
            notification.detail = detail
            notification.notification_type = notification_type
            notification.action_url = action_url
            notification.payload = {"demo": True}
            notification.unread = True
            notification.read_at = None
            notification.save(update_fields=["detail", "notification_type", "action_url", "payload", "unread", "read_at"])
        else:
            create_notification(
                user=student,
                title=title,
                detail=detail,
                notification_type=notification_type,
                action_url=action_url,
                payload={"demo": True},
            )


def _cleanup_e2e_knowledge_resources():
    resources = KnowledgeResource.objects.filter(original_name__startswith="a3-e2e-os-")
    job_ids = set(resources.exclude(index_job_id__isnull=True).values_list("index_job_id", flat=True))
    for resource in resources:
        path = Path(resource.stored_path)
        if path.exists():
            path.unlink()
        resource.delete()
    if job_ids:
        KnowledgeIndexJob.objects.filter(id__in=job_ids).delete()


def _seed_material_knowledge_graph(student):
    text = (
        "Process scheduling decides which ready process gets CPU time. "
        "Semaphore operations protect critical sections and coordinate process synchronization. "
        "Virtual memory uses page replacement algorithms such as FIFO and LRU after page faults."
    )
    resource, _ = KnowledgeResource.objects.update_or_create(
        owner=student,
        original_name="a3-demo-material-graph-operating-system.txt",
        defaults={
            "stored_path": str((Path("data") / "a3-demo-material-graph-operating-system.txt").resolve()),
            "file_type": ".txt",
            "file_size": len(text.encode("utf-8")),
            "resource_scope": ResourceScope.PERSONAL,
            "status": ResourceStatus.INDEXED,
            "document_count": 1,
            "chunk_count": 1,
        },
    )
    KnowledgeParseRun.objects.filter(resource=resource).delete()
    KnowledgePage.objects.filter(resource=resource).delete()
    KnowledgeParseRun.objects.create(
        resource=resource,
        status="completed",
        parser="native",
        pages=1,
        result={"source": "seed_demo_data"},
    )
    page = KnowledgePage.objects.create(resource=resource, page_number=1, summary="Operating system material graph demo")
    KnowledgeBlock.objects.create(
        resource=resource,
        page=page,
        modality="text",
        text=text,
        confidence=0.88,
        metadata={"blockType": "text_box", "seed": "a3_demo_material_graph"},
    )
    safe_rebuild_resource_graph(resource)


def _repair_global_kb_marker(teacher):
    source_path = (Path("data") / GLOBAL_KB_FILE_NAME).resolve()
    KnowledgeResource.objects.filter(
        owner=teacher,
        file_type=".xlsx",
        file_size=0,
        document_count=3115,
        chunk_count=3115,
    ).update(original_name=GLOBAL_KB_FILE_NAME, stored_path=str(source_path))


def _seed_global_kb_marker(teacher):
    source_path = (Path("data") / GLOBAL_KB_FILE_NAME).resolve()
    KnowledgeResource.objects.update_or_create(
        owner=teacher,
        original_name=GLOBAL_KB_FILE_NAME,
        defaults={
            "stored_path": str(source_path),
            "file_type": ".xlsx",
            "file_size": 0,
            "status": ResourceStatus.INDEXED,
            "document_count": 3115,
            "chunk_count": 3115,
        },
    )
