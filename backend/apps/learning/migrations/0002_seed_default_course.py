from django.db import migrations


def seed_default_course(apps, schema_editor):
    Course = apps.get_model("learning", "Course")
    Chapter = apps.get_model("learning", "Chapter")
    KnowledgePoint = apps.get_model("learning", "KnowledgePoint")
    KnowledgePrerequisite = apps.get_model("learning", "KnowledgePrerequisite")

    course, _ = Course.objects.get_or_create(
        code="OS-001",
        defaults={
            "title": "操作系统",
            "description": "面向计算机专业核心课程，覆盖进程管理、调度与死锁、同步互斥、存储管理、虚拟内存、设备管理、文件系统和磁盘管理。",
            "edition": "A3 操作系统课程包",
        },
    )
    chapter_specs = [
        (1, "操作系统概述", 90),
        (2, "进程描述与控制", 120),
        (3, "处理机调度与死锁", 150),
        (4, "进程同步与互斥", 150),
        (5, "存储器管理", 150),
        (6, "虚拟内存管理", 150),
        (7, "设备管理", 120),
        (8, "文件管理", 120),
        (9, "磁盘存储器管理", 120),
    ]
    chapters = {}
    for order, title, minutes in chapter_specs:
        chapters[order], _ = Chapter.objects.get_or_create(
            course=course,
            order=order,
            defaults={"title": title, "estimated_minutes": minutes},
        )

    point_specs = [
        ("OS-INTRO", 1, 1, "操作系统功能与结构", 1, 35),
        ("OS-PROCESS", 2, 1, "进程与 PCB", 2, 45),
        ("OS-THREAD", 2, 2, "线程与并发执行", 2, 40),
        ("OS-SCHEDULING", 3, 1, "处理机调度算法", 3, 55),
        ("OS-DEADLOCK", 3, 2, "死锁条件与处理", 4, 60),
        ("OS-SYNC", 4, 1, "同步互斥与信号量", 4, 60),
        ("OS-MEMORY", 5, 1, "分页分段与地址转换", 3, 55),
        ("OS-VIRTUAL-MEMORY", 6, 1, "虚拟内存与页面置换", 4, 65),
        ("OS-DEVICE", 7, 1, "设备管理与 I/O", 3, 45),
        ("OS-FILE", 8, 1, "文件系统与目录", 3, 50),
        ("OS-DISK", 9, 1, "磁盘调度与存储管理", 3, 45),
    ]
    points = {}
    for code, chapter_order, order, title, difficulty, minutes in point_specs:
        points[code], _ = KnowledgePoint.objects.get_or_create(
            code=code,
            defaults={
                "chapter": chapters[chapter_order],
                "order": order,
                "title": title,
                "difficulty": difficulty,
                "estimated_minutes": minutes,
            },
        )

    edges = [
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
    for point_code, prerequisite_code in edges:
        KnowledgePrerequisite.objects.get_or_create(
            knowledge_point=points[point_code],
            prerequisite=points[prerequisite_code],
        )


class Migration(migrations.Migration):
    dependencies = [("learning", "0001_initial")]
    operations = [migrations.RunPython(seed_default_course, migrations.RunPython.noop)]
