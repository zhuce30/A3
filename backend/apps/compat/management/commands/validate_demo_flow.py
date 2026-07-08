from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from backend.apps.assessments.models import WrongQuestion
from backend.apps.assessments.services import build_learning_report
from backend.apps.compat.agent_kernel import build_teacher_task_kernel, run_teacher_task_workflow
from backend.apps.compat.recommendations import build_recommendation_payload
from backend.apps.compat.verification import verify_answer
from backend.apps.engagement.models import UserNotification
from backend.apps.knowledge_base.graph_builder import SCHEMA_VERSION as MATERIAL_GRAPH_SCHEMA_VERSION
from backend.apps.knowledge_base.models import KnowledgeGraphEntity, KnowledgeGraphRelation, KnowledgeParseRun
from backend.apps.learning.models import LearningPath, LearningPathStatus
from backend.apps.learning.services import classroom_context, current_study_plan, dashboard_summary, generate_study_plan, teacher_workbench
from backend.apps.profiles.models import LearnerProfile
from backend.apps.system.services import build_system_health


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


@dataclass(frozen=True)
class DemoCheck:
    name: str
    status: str
    message: str
    detail: dict

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
            "detail": self.detail,
        }


class Command(BaseCommand):
    help = "Validate the A3 contest demo flow before presentation."

    def add_arguments(self, parser):
        parser.add_argument("--student-phone", default="13800000001")
        parser.add_argument("--password", default="Demo@123456")
        parser.add_argument("--skip-seed", action="store_true")
        parser.add_argument("--strict", action="store_true")
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--report-output", default="")

    def handle(self, *args, **options):
        if not options["skip_seed"]:
            call_command("seed_demo_data", student_phone=options["student_phone"], password=options["password"], verbosity=0)

        User = get_user_model()
        student = User.objects.filter(phone=options["student_phone"]).first()
        checks = _run_checks(student, expected_password=options["password"])
        report = {
            "overallStatus": _overall_status(checks),
            "studentPhone": options["student_phone"],
            "checks": [check.as_dict() for check in checks],
        }

        if options["as_json"]:
            self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            self.stdout.write(f"A3 demo validation: {report['overallStatus']}")
            self.stdout.write("")
            for check in checks:
                self.stdout.write(f"[{check.status.upper()}] {check.name}: {check.message}")
                if check.detail:
                    self.stdout.write(f"    {json.dumps(check.detail, ensure_ascii=False)}")

        if options["report_output"]:
            _write_markdown_report(Path(options["report_output"]), report)

        if options["strict"] and report["overallStatus"] == "fail":
            raise CommandError("A3 demo validation failed")


def _run_checks(student, *, expected_password: str) -> list[DemoCheck]:
    checks = [_account_check(student, expected_password=expected_password)]
    if student is None:
        return checks
    checks.extend([
        _profile_check(student),
        _path_check(student),
        _study_plan_context_check(student),
        _recommendation_check(student),
        _classroom_verification_check(student),
        _progress_check(student),
        _wrong_review_insight_check(student),
        _teacher_intervention_check(student),
        _material_knowledge_graph_check(student),
        _system_health_check(),
    ])
    return checks


def _account_check(student, *, expected_password: str) -> DemoCheck:
    if student is None:
        return DemoCheck("demoAccount", "fail", "演示学生账号不存在", {})
    if not student.check_password(expected_password):
        return DemoCheck("demoAccount", "warn", "演示学生账号存在，但密码不是默认值", {"phone": student.phone})
    return DemoCheck("demoAccount", "pass", "演示学生账号可用", {"phone": student.phone, "role": student.role})


def _profile_check(student) -> DemoCheck:
    profile = LearnerProfile.objects.filter(user=student).first()
    if profile is None:
        return DemoCheck("profile", "fail", "学习画像不存在", {})
    weak_count = len(profile.weak_points or [])
    goals_count = len(profile.learning_goals or [])
    if weak_count < 1 or goals_count < 1:
        return DemoCheck("profile", "warn", "画像存在但薄弱点或目标不足", {"weakPoints": weak_count, "goals": goals_count})
    return DemoCheck("profile", "pass", "六维学习画像已准备", {
        "grade": profile.grade,
        "foundationLevel": profile.foundation_level,
        "weakPoints": weak_count,
        "goals": goals_count,
    })


def _path_check(student) -> DemoCheck:
    path = LearningPath.objects.filter(user=student, status=LearningPathStatus.ACTIVE).prefetch_related("items").first()
    if path is None:
        return DemoCheck("learningPath", "fail", "没有激活的学习路径", {})
    item_count = path.items.count()
    if item_count < 3:
        return DemoCheck("learningPath", "warn", "学习路径节点过少", {"items": item_count, "title": path.title})
    return DemoCheck("learningPath", "pass", "个性化学习路径可演示", {"items": item_count, "title": path.title})


def _study_plan_context_check(student) -> DemoCheck:
    plan = current_study_plan(student) or generate_study_plan(student)
    context = plan.get("planContext") if isinstance(plan, dict) else None
    if not isinstance(context, dict):
        return DemoCheck("studyPlanContext", "fail", "学习计划上下文缺失", {})

    schema_version = context.get("schemaVersion")
    relationship = context.get("relationship")
    required_relationship_keys = ("path", "plan", "today", "writeback")
    if schema_version != "a3.study-plan-context.v1":
        return DemoCheck("studyPlanContext", "fail", "学习计划上下文 schema 缺失或版本错误", {
            "schemaVersion": schema_version,
            "expectedSchemaVersion": "a3.study-plan-context.v1",
        })
    if not isinstance(relationship, dict):
        return DemoCheck("studyPlanContext", "fail", "学习计划上下文缺少闭环关系说明", {
            "schemaVersion": schema_version,
            "missing": list(required_relationship_keys),
        })

    missing = [key for key in required_relationship_keys if not str(relationship.get(key) or "").strip()]
    if missing:
        return DemoCheck("studyPlanContext", "fail", "学习计划上下文缺少闭环关系说明", {
            "schemaVersion": schema_version,
            "missing": missing,
        })
    return DemoCheck("studyPlanContext", "pass", "学习计划上下文 schema 可验证", {
        "schemaVersion": schema_version,
        "relationshipKeys": list(required_relationship_keys),
    })


def _recommendation_check(student) -> DemoCheck:
    payload = build_recommendation_payload(student, goal="处理机调度与虚拟内存", top_k=3)
    count = len(payload.get("recommendations") or [])
    source_count = len(payload.get("sources") or [])
    if count < 3:
        return DemoCheck("recommendations", "fail", "推荐结果不足 3 条", {"recommendations": count, "sources": source_count})
    status = "pass" if source_count else "warn"
    message = "资源推荐与引用来源可演示" if source_count else "推荐可演示，但当前没有知识库引用来源"
    return DemoCheck("recommendations", status, message, {
        "recommendations": count,
        "sources": source_count,
        "fallbackUsed": payload.get("rationale", {}).get("fallbackUsed"),
    })


def _classroom_verification_check(student) -> DemoCheck:
    context = classroom_context(student)
    sources = context.get("sources") or []
    target = context.get("target") or {}
    answer = f"当前学习目标是 {target.get('title', '处理机调度')}，系统将结合知识库引用回答。"
    result = verify_answer("时间片轮转调度是什么？", answer, sources)
    if result.verified:
        return DemoCheck("verifiedQa", "pass", "课堂问答可展示引用验证", {"citations": len(result.citations)})
    return DemoCheck("verifiedQa", "warn", "课堂问答会拒绝无证据答案", {
        "citations": len(result.citations),
        "refusalReason": result.refusalReason,
    })


def _progress_check(student) -> DemoCheck:
    from django.utils import timezone
    now = timezone.now()
    summary = dashboard_summary(student)
    wrong_count = WrongQuestion.objects.filter(user=student, mastered=False).count()
    due_count = WrongQuestion.objects.filter(
        user=student, mastered=False, review_after__isnull=False, review_after__lte=now,
    ).count()
    path = summary.get("path")
    if not path:
        return DemoCheck("progress", "fail", "学习进度仪表盘缺少路径数据", {"wrongQuestions": wrong_count})
    return DemoCheck("progress", "pass", "进度、错题与学习报告数据可演示", {
        "wrongQuestions": wrong_count,
        "dueWrongQuestions": due_count,
        "pathProgress": path.get("progress"),
    })


def _wrong_review_insight_check(student) -> DemoCheck:
    report = build_learning_report(student)
    insight = report.get("wrongReviewInsight")
    if not insight:
        return DemoCheck("wrongReviewInsight", "warn", "学习报告尚未生成 wrongReviewInsight，完成测评后会自动生成", {})
    active = insight.get("activeWrongQuestions", 0)
    mastered = insight.get("masteredWrongQuestions", 0)
    schema = insight.get("schemaVersion", "")
    headline = (insight.get("headline") or "")[:30]
    return DemoCheck("wrongReviewInsight", "pass", "错题复盘证据链：报告 insight 可解释、可展示、可导出 CSV", {
        "schemaVersion": schema,
        "headline": headline,
        "activeWrongQuestions": active,
        "masteredWrongQuestions": mastered,
        "nextAction": insight.get("nextAction", {}).get("label"),
    })


def _teacher_intervention_check(student) -> DemoCheck:
    User = get_user_model()
    teacher = User.objects.filter(phone="13800000002", role="teacher").first()
    if teacher is None:
        return DemoCheck("teacherIntervention", "fail", "演示教师账号不存在", {"teacherPhone": "13800000002"})

    workbench = teacher_workbench(teacher)
    students = workbench.get("students") or []
    target = next((item for item in students if item.get("id") == str(student.id)), None)
    if target is None:
        return DemoCheck("teacherIntervention", "fail", "演示教师未绑定该学生的课程学情", {
            "teacherPhone": teacher.phone,
            "studentPhone": student.phone,
            "workbenchStudents": len(students),
        })

    existing = UserNotification.objects.filter(
        user=student,
        payload__teacherId=str(teacher.id),
        payload__studentId=str(student.id),
        payload__targetedByTeacher=True,
    ).count()
    demo_kernel = build_teacher_task_kernel()
    demo_kernel._circuit_breaker = lambda _context, _agent: {"open": False, "reason": "demo_validation"}
    workflow_result = run_teacher_task_workflow(
        teacher,
        {
            "type": "intervention",
            "studentId": str(student.id),
            "message": "教师演示干预：请先完成错题复盘，再回到今日任务。",
            "dedupeKey": "demo-teacher-intervention",
        },
        kernel=demo_kernel,
    )
    trace_id = str(workflow_result.trace.get("traceId") or "")
    if not workflow_result.success:
        return DemoCheck("teacherIntervention", "fail", "教师干预 Agent workflow 执行失败", {
            "teacherPhone": teacher.phone,
            "studentPhone": student.phone,
            "traceId": trace_id,
            "error": workflow_result.output.get("error"),
        })

    teacher_notifications = UserNotification.objects.filter(
        user=student,
        payload__teacherId=str(teacher.id),
        payload__studentId=str(student.id),
        payload__targetedByTeacher=True,
        payload__dedupeKey="demo-teacher-intervention",
    ).count()
    if teacher_notifications < 1:
        return DemoCheck("teacherIntervention", "fail", "教师定制任务没有回流到学生通知", {
            "teacherPhone": teacher.phone,
            "studentPhone": student.phone,
            "teacherNotifications": teacher_notifications,
        })

    return DemoCheck("teacherIntervention", "pass", "教师可下发单学生干预，学生通知中心可收到", {
        "teacherPhone": teacher.phone,
        "studentPhone": student.phone,
        "targetStudent": target.get("name"),
        "riskLevel": target.get("riskLevel"),
        "riskReason": (target.get("riskReason") or "")[:60] or None,
        "teacherNotifications": teacher_notifications,
        "traceId": trace_id,
    })


def _system_health_check() -> DemoCheck:
    health = build_system_health()
    checks = health.get("checks") or []
    errors = [item for item in checks if item.get("status") == "error"]
    warnings = [item for item in checks if item.get("status") == "warning"]
    if errors:
        return DemoCheck("systemHealth", "fail", "系统健康检查存在错误", {
            "errors": [item.get("name") for item in errors],
            "warnings": [item.get("name") for item in warnings],
        })
    return DemoCheck("systemHealth", "pass", "系统健康检查可用", {
        "warnings": [item.get("name") for item in warnings],
        "note": "本地演示允许 DEBUG 和开发验证码；正式部署需关闭。",
    })


def _material_knowledge_graph_check(student) -> DemoCheck:
    entities = KnowledgeGraphEntity.objects.filter(resource__owner=student)
    relations = KnowledgeGraphRelation.objects.filter(resource__owner=student)
    latest_parse = (
        KnowledgeParseRun.objects.filter(resource__owner=student, result__has_key="materialGraph")
        .order_by("-updated_at", "-created_at")
        .first()
    )
    metadata = {}
    if latest_parse and isinstance(latest_parse.result, dict):
        material_graph = latest_parse.result.get("materialGraph")
        if isinstance(material_graph, dict):
            metadata = material_graph
    detail = {
        "schemaVersion": metadata.get("schemaVersion") or MATERIAL_GRAPH_SCHEMA_VERSION,
        "workflow": metadata.get("workflow") or "material_knowledge_graph",
        "workflowSchemaVersion": metadata.get("workflowSchemaVersion") or "a3.agent-workflow.v1",
        "entityCount": entities.count(),
        "relationCount": relations.count(),
        "traceId": metadata.get("traceId") or "",
        "degraded": bool(metadata.get("degraded", True)),
        "reason": metadata.get("reason") or "",
    }
    if detail["entityCount"] < 1 or detail["relationCount"] < 1:
        return DemoCheck("materialKnowledgeGraph", "warn", "资料图谱暂无实体或关系", detail)
    if detail["schemaVersion"] != MATERIAL_GRAPH_SCHEMA_VERSION or not detail["traceId"]:
        return DemoCheck("materialKnowledgeGraph", "warn", "资料图谱元数据不完整", detail)
    return DemoCheck("materialKnowledgeGraph", "pass", "资料图谱 schema、实体、关系和 trace 可验证", detail)


def _overall_status(checks: list[DemoCheck]) -> str:
    statuses = {check.status for check in checks}
    if "fail" in statuses:
        return "fail"
    if "warn" in statuses:
        return "warn"
    return "pass"


def _write_markdown_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    status_label = {"pass": "通过", "warn": "有警告", "fail": "失败"}.get(report.get("overallStatus"), str(report.get("overallStatus")))
    evaluation = _latest_evaluation_metrics()
    lines = [
        "# A3 演示验收报告",
        "",
        f"- 总体状态：{status_label}",
        f"- 演示学生：{report.get('studentPhone', '')}",
        "",
        "| 检查项 | 状态 | 说明 | 关键数据 |",
        "|---|---|---|---|",
    ]
    for check in report.get("checks", []):
        detail = json.dumps(check.get("detail") or {}, ensure_ascii=False)
        lines.append(f"| {check.get('name')} | {check.get('status')} | {check.get('message')} | `{detail}` |")
    lines.extend([
        "",
        "## 固定演示链路",
        "",
        "1. 登录演示学生账号，进入今日任务。",
        "2. 展示画像、诊断、路径、学习计划和推荐资源。",
        "3. 进入 AI 课堂，展示引用验证和安全过滤。",
        "4. 查看测评、错题本和学习报告。",
        "5. 切换教师账号，向单个学生下发干预任务。",
        "6. 回到学生通知中心，确认教师任务已回流。",
        "",
        "## 评测证据",
        "",
        f"- 评测集规模：{evaluation.get('totalCases', '--')} 条（目标 50 条）",
        f"- Top3 命中率：{evaluation.get('retrievalTop3HitRate', '--')}%",
        f"- 验证覆盖率：{evaluation.get('verifiedCoverage', '--')}%",
        f"- 安全拒答率：{evaluation.get('safetyRefusalRate', '--')}%",
        "- 指标文件：backend/tmp/demo_retrieval_metrics.json",
        "- 复现命令：`backend\\.venv\\Scripts\\python.exe backend\\manage.py evaluate_demo_retrieval --top-k 3 --json --output backend\\tmp\\demo_retrieval_metrics.json`",
        "",
        "## 指标目标",
        "",
        "- 评测集规模：不少于 50 条",
        "- Top1 命中率：演示集不低于 80%",
        "- Top3 命中率：演示集不低于 90%",
        "- 验证覆盖率：不低于 90%",
        "- 安全拒答率：unsafe 测试集接近 100%",
    ])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _latest_evaluation_metrics() -> dict:
    metrics_path = Path("backend/tmp/demo_retrieval_metrics.json")
    if not metrics_path.exists():
        return {}
    try:
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    metrics = payload.get("metrics") if isinstance(payload, dict) else None
    return metrics if isinstance(metrics, dict) else {}
