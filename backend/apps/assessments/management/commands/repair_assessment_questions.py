from __future__ import annotations

from django.core.management.base import BaseCommand

from backend.apps.assessments.models import Question
from backend.apps.learning.models import KnowledgePoint

QUESTION_SPECS = [
    (
        "OS-INTRO",
        "操作系统最核心的职责是什么？",
        [("A", "管理硬件资源并提供统一抽象"), ("B", "只负责网页排版"), ("C", "只负责数据库建模"), ("D", "只负责应用层加密")],
        "A",
        "操作系统负责管理处理机、内存、设备和文件等资源，并向应用提供系统调用和抽象接口。",
        "没有抓住操作系统的资源管理与抽象职责",
        1,
    ),
    (
        "OS-PROCESS",
        "进程控制块 PCB 中通常保存什么？",
        [("A", "进程状态和上下文信息"), ("B", "显示器亮度"), ("C", "网页 CSS 样式"), ("D", "用户头像文件")],
        "A",
        "PCB 保存进程标识、状态、寄存器上下文、调度信息和资源信息，是进程存在的标志。",
        "未理解 PCB 与进程管理的关系",
        2,
    ),
    (
        "OS-THREAD",
        "线程相比进程更强调什么？",
        [("A", "同一进程内更轻量的执行流"), ("B", "独立的外存分区"), ("C", "固定的磁盘柱面"), ("D", "不可共享的地址空间")],
        "A",
        "线程是进程内的执行流，通常共享进程资源，创建和切换开销低于进程。",
        "混淆进程和线程的资源边界",
        2,
    ),
    (
        "OS-SCHEDULING",
        "时间片轮转调度主要适合哪类场景？",
        [("A", "分时系统中的交互进程"), ("B", "只允许一个作业运行的批处理"), ("C", "磁盘坏道修复"), ("D", "文件权限校验")],
        "A",
        "时间片轮转通过周期性分配 CPU 时间，让多个交互进程获得较公平的响应。",
        "未理解时间片轮转的公平性和响应性目标",
        3,
    ),
    (
        "OS-DEADLOCK",
        "死锁产生的四个必要条件不包括哪一项？",
        [("A", "互斥"), ("B", "请求并保持"), ("C", "不可剥夺"), ("D", "优先级必然最高")],
        "D",
        "死锁四个必要条件是互斥、请求并保持、不可剥夺和循环等待。",
        "把调度优先级误认为死锁必要条件",
        3,
    ),
    (
        "OS-SYNC",
        "信号量 P/V 操作主要用于什么？",
        [("A", "同步互斥控制"), ("B", "磁盘低级格式化"), ("C", "页面颜色渲染"), ("D", "网卡驱动卸载")],
        "A",
        "信号量通过 P/V 操作协调进程同步并保护临界资源。",
        "未建立信号量与临界区互斥的联系",
        3,
    ),
    (
        "OS-MEMORY",
        "分页管理中页表的作用是什么？",
        [("A", "完成页号到物理块号的映射"), ("B", "保存文件扩展名"), ("C", "记录显示器刷新率"), ("D", "保存 SQL 索引")],
        "A",
        "页表记录逻辑页到物理内存块的映射，是地址转换的关键结构。",
        "混淆逻辑地址和物理地址转换过程",
        3,
    ),
    (
        "OS-VIRTUAL-MEMORY",
        "缺页中断通常表示什么？",
        [("A", "访问页不在内存，需要调入"), ("B", "CPU 永久损坏"), ("C", "文件名非法"), ("D", "键盘缓冲区为空")],
        "A",
        "请求分页系统访问不在内存中的页时会触发缺页中断，由操作系统调入页面。",
        "未理解虚拟内存的按需调页机制",
        4,
    ),
    (
        "OS-DEVICE",
        "DMA 的主要价值是什么？",
        [("A", "减少 CPU 参与大块数据传输的开销"), ("B", "替代所有文件系统"), ("C", "删除进程 PCB"), ("D", "关闭中断机制")],
        "A",
        "DMA 允许设备和内存之间直接传输数据，降低 CPU 逐字节搬运开销。",
        "未理解 DMA 与 I/O 效率的关系",
        3,
    ),
    (
        "OS-FILE",
        "文件目录的核心作用是什么？",
        [("A", "建立文件名到文件控制信息的映射"), ("B", "决定 CPU 调度顺序"), ("C", "执行页面置换"), ("D", "计算磁盘旋转速度")],
        "A",
        "目录用于组织文件并定位文件控制块或索引节点等元数据。",
        "混淆文件目录和处理机调度",
        3,
    ),
    (
        "OS-DISK",
        "SSTF 磁盘调度优先选择什么请求？",
        [("A", "与当前磁头位置距离最近的请求"), ("B", "文件名最长的请求"), ("C", "进程优先级最低的请求"), ("D", "页号最大的请求")],
        "A",
        "SSTF 即最短寻道时间优先，选择距离当前磁头最近的磁道请求。",
        "未理解磁盘调度的寻道距离目标",
        3,
    ),
]


class Command(BaseCommand):
    help = "Repair the default A3 operating-system assessment question bank."

    def handle(self, *args, **options):
        created = 0
        updated = 0
        for code, stem, raw_options, answer, explanation, cause, difficulty in QUESTION_SPECS:
            point = KnowledgePoint.objects.filter(code=code).first()
            if not point:
                self.stdout.write(self.style.WARNING(f"Skip missing knowledge point: {code}"))
                continue
            question, was_created = Question.objects.update_or_create(
                knowledge_point=point,
                stem=stem,
                defaults={
                    "options": [{"key": key, "text": text} for key, text in raw_options],
                    "correct_answer": answer,
                    "explanation": explanation,
                    "error_cause": cause,
                    "difficulty": difficulty,
                    "is_active": True,
                },
            )
            if was_created:
                created += 1
            else:
                updated += 1
        self.stdout.write(self.style.SUCCESS(f"Assessment questions repaired. created={created}, updated={updated}"))
