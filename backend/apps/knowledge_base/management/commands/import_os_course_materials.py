from __future__ import annotations

import re
import shutil
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from backend.apps.accounts.models import UserRole
from backend.apps.knowledge_base.models import KnowledgeResource, ResourceScope, ResourceStatus
from backend.apps.learning.services import DEFAULT_COURSE_CODE, _repair_default_course_catalog
from backend.core.settings import DATA_ROOT


OS_MATERIAL_DISPLAY_NAMES = {
    1: "第1章 操作系统概述.pdf",
    2: "第2章 进程管理-进程描述与控制.pdf",
    3: "第3章 进程管理-调度与死锁.pptx",
    4: "第4章 进程管理-进程同步与互斥.pdf",
    5: "第5章 存储器管理.pdf",
    6: "第6章 虚拟内存管理.pdf",
    7: "第7章 设备管理.pdf",
    8: "第8章 文件管理.pdf",
    9: "第9章 磁盘存储器管理.pdf",
}
OS_TEXTBOOK_DISPLAY_NAME = "计算机操作系统 慕课版15133203.pdf"


class Command(BaseCommand):
    help = "Register local operating-system course PDFs/PPTX files as managed A3 course materials."

    def add_arguments(self, parser):
        parser.add_argument("--source-dir", default=str(DATA_ROOT / "操作系统"))
        parser.add_argument("--course-code", default=DEFAULT_COURSE_CODE)
        parser.add_argument("--owner-phone", default="13800000002")
        parser.add_argument("--no-copy", action="store_true", help="Register original files in place instead of copying to upload storage.")

    @transaction.atomic
    def handle(self, *args, **options):
        source_dir = Path(options["source_dir"]).resolve()
        if not source_dir.exists() or not source_dir.is_dir():
            raise CommandError(f"课程资料目录不存在：{source_dir}")

        course = _repair_default_course_catalog()
        if course.code != options["course_code"]:
            raise CommandError(f"当前默认课程不是 {options['course_code']}，请先确认课程配置。")

        owner = _material_owner(options["owner_phone"])
        target_root = Path(getattr(settings, "KNOWLEDGE_UPLOAD_ROOT", DATA_ROOT / "uploads")).resolve() / "course-materials" / course.code
        if not options["no_copy"]:
            target_root.mkdir(parents=True, exist_ok=True)

        files = sorted(path for path in source_dir.iterdir() if path.suffix.lower() in {".pdf", ".pptx"})
        imported = 0
        updated = 0
        for source_path in files:
            target_path = source_path if options["no_copy"] else target_root / source_path.name
            if not options["no_copy"] and (not target_path.exists() or target_path.stat().st_size != source_path.stat().st_size):
                shutil.copy2(source_path, target_path)

            chapter_order = _chapter_order(source_path.name)
            display_name = _display_name(source_path, chapter_order)
            metadata = {
                "source": "local_course_material_import",
                "courseCode": course.code,
                "chapterOrder": chapter_order,
                "materialRole": "courseware" if chapter_order else "textbook",
                "managedCopy": not options["no_copy"],
            }
            resource = KnowledgeResource.objects.filter(
                course_key=course.code,
                resource_scope=ResourceScope.GLOBAL,
                student_profile_snapshot__chapterOrder=chapter_order,
            ).first()
            if resource is None and chapter_order is None:
                resource = KnowledgeResource.objects.filter(
                    course_key=course.code,
                    resource_scope=ResourceScope.GLOBAL,
                    student_profile_snapshot__materialRole="textbook",
                ).first()
            defaults = {
                "owner": owner,
                "original_name": display_name,
                "stored_path": str(target_path.resolve()),
                "file_type": source_path.suffix.lower(),
                "file_size": source_path.stat().st_size,
                "visibility": "shared",
                "student_profile_snapshot": metadata,
            }
            if resource:
                for key, value in defaults.items():
                    setattr(resource, key, value)
                resource.save(update_fields=[*defaults.keys(), "updated_at"])
                updated += 1
            else:
                KnowledgeResource.objects.create(
                    **defaults,
                    course_key=course.code,
                    resource_scope=ResourceScope.GLOBAL,
                    status=ResourceStatus.UPLOADED,
                )
                imported += 1

        self.stdout.write(self.style.SUCCESS(f"操作系统课程资料已注册：新增 {imported}，更新 {updated}，共 {len(files)} 个文件。"))


def _material_owner(phone: str):
    User = get_user_model()
    owner, _ = User.objects.get_or_create(
        phone=phone,
        defaults={
            "role": UserRole.TEACHER,
            "display_name": "课程资料管理员",
            "school": "A3 智学引擎",
            "privacy_accepted": True,
            "profile_completed": True,
            "onboarding_step": "complete",
        },
    )
    if owner.role not in {UserRole.TEACHER, UserRole.ADMIN}:
        owner.role = UserRole.TEACHER
        owner.save(update_fields=["role", "updated_at"])
    return owner


def _chapter_order(filename: str) -> int | None:
    chapter_match = re.search(r"第\s*(\d+)\s*章", filename)
    if chapter_match:
        return int(chapter_match.group(1))
    prefix_match = re.match(r"\s*(\d+)\D", filename)
    if prefix_match:
        return int(prefix_match.group(1))
    return None


def _display_name(source_path: Path, chapter_order: int | None) -> str:
    if chapter_order in OS_MATERIAL_DISPLAY_NAMES:
        return OS_MATERIAL_DISPLAY_NAMES[chapter_order]
    if source_path.suffix.lower() == ".pdf":
        return OS_TEXTBOOK_DISPLAY_NAME
    return source_path.name
