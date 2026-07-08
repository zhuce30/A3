from __future__ import annotations

import json
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import BaseCommand

from backend.apps.assessments.models import AssessmentSession, Question, QuestionGenerationJob
from backend.apps.compat.agent_kernel import (
    build_admission_diagnostic_kernel,
    build_assessment_kernel,
    build_path_generate_kernel,
    build_profile_kernel,
    build_profile_setup_kernel,
    build_question_bank_kernel,
    build_qa_kernel,
    build_recommendation_kernel,
    build_teacher_task_kernel,
    build_verify_answer_kernel,
    run_admission_diagnostic_workflow,
    run_assess_grade_workflow,
    run_path_generate_workflow,
    run_profile_extract_workflow,
    run_profile_setup_workflow,
    run_question_generation_workflow,
    run_qa_workflow,
    run_recommendation_workflow,
    run_teacher_task_workflow,
    run_verify_answer_workflow,
)
from backend.apps.compat.agent_workflows import describe_agent_workflows, summarize_workflow_readiness
from backend.apps.compat.models import AgentRun
from backend.apps.compat.profile_interview import confirm_profile_interview, run_profile_interview
from backend.apps.compat.resource_generation import (
    generate_resource_pack_v2,
    record_openmaic_classroom_artifact,
    record_openmaic_classroom_interaction,
    record_openmaic_pptx_export_artifact,
    record_openmaic_video_artifact,
    record_resource_feedback,
)
from backend.apps.knowledge_base.graph_builder import rebuild_resource_graph
from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgePage, KnowledgeParseRun, KnowledgeResource, ResourceScope
from backend.apps.learning.models import Course, KnowledgePoint


SCHEMA_VERSION = "a3.agent-workflow-eval.v1"

API_ENTRIES = {
    "profile_extract": "POST /api/profile/extract/",
    "profile_interview": "POST /api/profile/interview/",
    "profile_setup": "POST /api/profiles/learning-profile/",
    "admission_diagnostic": "POST /api/learning/admission-diagnostic/",
    "path_generate": "POST /api/path/generate/",
    "recommend": "POST /api/recommend/",
    "resource_generate": "POST /api/resources/generate/",
    "material_knowledge_graph": "GET /api/kb/graph/",
    "resource_feedback": "POST /api/resources/packs/<id>/feedback/",
    "question_bank_generate": "POST /api/assessments/questions/generate/",
    "openmaic_classroom_bridge": "POST /api/resources/packs/<id>/openmaic-classroom/",
    "openmaic_video_bridge": "POST /api/resources/packs/<id>/openmaic-video/",
    "openmaic_pptx_export_bridge": "POST /api/resources/packs/<id>/openmaic-pptx-export/",
    "openmaic_interaction_bridge": "POST /api/resources/packs/<id>/openmaic-interaction/",
    "qa_interact": "GET /api/v1/qa/interact/",
    "verify_answer": "POST /api/verify/answer/",
    "assess_grade": "POST /api/assess/grade/",
    "teacher_task_execute": "POST /api/learning/teacher/tasks/execute/",
}


class Command(BaseCommand):
    help = "Evaluate A3 Agent workflow contract, trace, evidence, and API-entry coverage."

    def add_arguments(self, parser):
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--recent", type=int, default=80)
        parser.add_argument("--generate-demo-traces", action="store_true")
        parser.add_argument("--output", default="", help="Optional path for the JSON metrics artifact.")

    def handle(self, *args, **options):
        recent = max(1, int(options["recent"]))
        generated = []
        if options["generate_demo_traces"]:
            generated = generate_demo_agent_traces()
        payload = evaluate_agent_workflow_coverage(
            recent=recent,
            performance_trace_ids=generated if generated else None,
        )
        payload["generatedTraceIds"] = generated
        if options["output"]:
            output_path = Path(options["output"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        if options["as_json"]:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return
        self.stdout.write(f"A3 Agent workflow evaluation: {payload['overallStatus']}")
        for item in payload["workflows"]:
            self.stdout.write(
                f"[{item['status'].upper()}] {item['workflow']}: "
                f"contract={item['hasContract']} trace={item['hasRecentTrace']} "
                f"evidence={item['hasEvidenceSchema']} api={item['hasApiEntry']}"
            )


def evaluate_agent_workflow_coverage(*, recent: int = 80, performance_trace_ids: list[str] | None = None) -> dict:
    workflow_names = [item["workflow"] for item in describe_agent_workflows()]
    runs = []
    for workflow in workflow_names:
        run = (
            AgentRun.objects.prefetch_related("steps")
            .filter(workflow=workflow)
            .order_by("-started_at")
            .first()
        )
        if run is not None:
            runs.append(run)
    if recent > len(runs):
        known_trace_ids = {run.trace_id for run in runs}
        extra_runs = (
            AgentRun.objects.prefetch_related("steps")
            .exclude(trace_id__in=known_trace_ids)
            .order_by("-started_at")[: max(0, recent - len(runs))]
        )
        runs.extend(extra_runs)
    trace_payloads = [_trace_payload(run) for run in runs]
    performance_trace_id_set = {str(trace_id) for trace_id in performance_trace_ids or [] if str(trace_id)}
    if performance_trace_id_set:
        performance_runs = (
            AgentRun.objects.prefetch_related("steps")
            .filter(trace_id__in=performance_trace_id_set)
            .order_by("-started_at")
        )
        performance_trace_payloads = [_trace_payload(run) for run in performance_runs]
    else:
        performance_trace_payloads = trace_payloads
    readiness = summarize_workflow_readiness(trace_payloads)
    contracts = {item["workflow"]: item for item in describe_agent_workflows()}
    workflows = []
    for item in readiness:
        workflow = item["workflow"]
        latest_run = next((run for run in runs if run.workflow == workflow), None)
        has_evidence_schema = _run_has_evidence_schema(latest_run)
        has_api_entry = bool(API_ENTRIES.get(workflow))
        missing = []
        if workflow not in contracts:
            missing.append("contract")
        if latest_run is None:
            missing.append("trace")
        if not has_evidence_schema:
            missing.append("evidenceSchema")
        if not has_api_entry:
            missing.append("apiEntry")
        workflows.append({
            "workflow": workflow,
            "title": item.get("title", workflow),
            "status": "ready" if not missing and item.get("ready") else "incomplete",
            "hasContract": workflow in contracts,
            "hasRecentTrace": latest_run is not None,
            "hasEvidenceSchema": has_evidence_schema,
            "hasApiEntry": has_api_entry,
            "apiEntry": API_ENTRIES.get(workflow, ""),
            "latestTraceId": item.get("latestTraceId"),
            "latestStatus": item.get("latestStatus"),
            "missing": missing,
            "requiredSteps": item.get("requiredSteps", []),
            "missingRequiredSteps": item.get("missingRequiredSteps", []),
        })
    total = len(workflows) or 1
    metrics = {
        "workflowCount": len(workflows),
        "contractCoverage": _percent(sum(1 for item in workflows if item["hasContract"]), total),
        "traceCoverage": _percent(sum(1 for item in workflows if item["hasRecentTrace"]), total),
        "evidenceSchemaCoverage": _percent(sum(1 for item in workflows if item["hasEvidenceSchema"]), total),
        "apiEntryCoverage": _percent(sum(1 for item in workflows if item["hasApiEntry"]), total),
        "readyCoverage": _percent(sum(1 for item in workflows if item["status"] == "ready"), total),
    }
    performance = _evaluate_runtime_performance(performance_trace_payloads)
    metrics.update({
        "slowStepCount": performance["slowStepCount"],
        "budgetBreaches": performance["budgetBreaches"],
        "timedOutSteps": performance["timedOutSteps"],
    })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "overallStatus": "pass" if metrics["readyCoverage"] == 100 else "warn",
        "metrics": metrics,
        "performance": performance,
        "workflows": workflows,
    }


def _trace_payload(run: AgentRun) -> dict:
    steps = []
    for step in run.steps.all().order_by("order"):
        steps.append({
            "name": step.name,
            "status": step.status,
            "metadata": step.metadata,
        })
    return {
        "traceId": run.trace_id,
        "workflow": run.workflow,
        "status": run.status,
        "fallbackStrategy": run.fallback_strategy,
        "latencyMs": run.latency_ms,
        "steps": steps,
    }


def _run_has_evidence_schema(run: AgentRun | None) -> bool:
    if run is None:
        return False
    for step in run.steps.all():
        metadata = step.metadata if isinstance(step.metadata, dict) else {}
        if metadata.get("a3EvidenceSchemaVersion") == "a3.agent-step-evidence.v1":
            return True
    return False


def _percent(count: int, total: int) -> int:
    return round(count * 100 / total) if total else 0


def _evaluate_runtime_performance(trace_payloads: list[dict]) -> dict:
    slow_steps = []
    budget_breaches = 0
    timed_out_steps = 0
    for trace in trace_payloads:
        workflow = str(trace.get("workflow") or "")
        trace_id = str(trace.get("traceId") or "")
        steps = trace.get("steps") if isinstance(trace.get("steps"), list) else []
        for step in steps:
            if not isinstance(step, dict):
                continue
            metadata = step.get("metadata") if isinstance(step.get("metadata"), dict) else {}
            policy = metadata.get("runtimePolicy") if isinstance(metadata.get("runtimePolicy"), dict) else None
            if not policy:
                continue
            timeout_ms = policy.get("timeoutMs")
            if timeout_ms is None:
                continue
            timeout_ms = int(timeout_ms or 0)
            elapsed_ms = int(policy.get("elapsedMs") or 0)
            if timeout_ms <= 0:
                continue
            ratio = round(elapsed_ms / timeout_ms, 3)
            timed_out = bool(policy.get("timedOut"))
            breached = timed_out or elapsed_ms > timeout_ms
            if timed_out:
                timed_out_steps += 1
            if breached:
                budget_breaches += 1
            if ratio >= 0.8 or breached:
                slow_steps.append({
                    "traceId": trace_id,
                    "workflow": workflow,
                    "agent": str(step.get("name") or ""),
                    "status": "timeout" if timed_out else "breach" if breached else "slow",
                    "elapsedMs": elapsed_ms,
                    "timeoutMs": timeout_ms,
                    "budgetRatio": ratio,
                })
    slow_steps.sort(key=lambda item: (-item["budgetRatio"], -item["elapsedMs"], item["workflow"], item["agent"]))
    return {
        "slowStepCount": len(slow_steps),
        "budgetBreaches": budget_breaches,
        "timedOutSteps": timed_out_steps,
        "slowSteps": slow_steps[:12],
    }


def generate_demo_agent_traces() -> list[str]:
    call_command("seed_demo_data", verbosity=0)
    User = get_user_model()
    student = User.objects.get(phone="13800000001")
    teacher = User.objects.get(phone="13800000002")
    course = Course.objects.get(code="OS-001")
    point = KnowledgePoint.objects.filter(chapter__course=course).order_by("chapter__order", "order").first()
    if point is None:
        raise RuntimeError("Demo course has no knowledge points")

    generated: list[str] = []

    def fresh(kernel):
        kernel._circuit_breaker = lambda _context, _agent: {"open": False, "reason": "demo_trace_generation"}
        return kernel

    results = [
        run_profile_extract_workflow(
            student,
            {"text": "I am a sophomore computer science student. CPU scheduling, semaphores, and virtual memory are weak for me. I can study 45 minutes daily."},
            kernel=fresh(build_profile_kernel()),
        ),
        run_profile_setup_workflow(
            student,
            {
                "displayName": "演示学生",
                "majorDirection": "计算机科学与技术",
                "grade": "大二",
                "foundationLevel": "基础较弱",
                "dailyStudyTime": "60",
                "pace": "standard",
                "learningGoals": ["掌握操作系统"],
                "learningPreferences": ["图解流程", "例题推导"],
                "expectedResources": ["练习题库", "代码实验"],
                "weakPoints": ["处理机调度算法", "虚拟内存与页面置换"],
            },
            kernel=fresh(build_profile_setup_kernel()),
        ),
        run_admission_diagnostic_workflow(
            student,
            {
                "goal": "补齐基础",
                "dailyMinutes": 45,
                "durationDays": 7,
                "answers": [
                    {"questionId": "os-role", "selectedIndex": 0},
                    {"questionId": "process-thread", "selectedIndex": 1},
                    {"questionId": "cpu-scheduling", "selectedIndex": 0},
                    {"questionId": "sync", "selectedIndex": 2},
                    {"questionId": "virtual-memory", "selectedIndex": 0},
                ],
            },
            kernel=fresh(build_admission_diagnostic_kernel()),
        ),
        run_path_generate_workflow(
            student,
            {"course": course, "force": True},
            kernel=fresh(build_path_generate_kernel()),
        ),
        run_recommendation_workflow(
            student,
            {"goal": "CPU scheduling and virtual memory", "topK": 3},
            kernel=fresh(build_recommendation_kernel()),
        ),
        run_qa_workflow(
            student,
            {"question": "时间片轮转调度是什么？"},
            kernel=fresh(build_qa_kernel()),
        ),
        run_verify_answer_workflow(
            student,
            {
                "question": "时间片轮转调度是什么？",
                "answer": "时间片轮转调度让多个就绪进程按时间片轮流获得 CPU，适合分时系统提高响应性。",
                "sources": [{"title": "操作系统知识库", "snippet": "时间片轮转通过周期性分配 CPU 时间，让多个交互进程获得较公平的响应。", "score": 0.9}],
            },
            kernel=fresh(build_verify_answer_kernel()),
        ),
    ]
    interview_result = run_profile_interview(
        student,
        "computer science sophomore, operating systems average, preparing for final exam, 40 minutes daily, prefer animations and coding labs, weak at CPU scheduling and virtual memory",
    )
    interview_trace_id = str(interview_result.get("traceId") or "")
    if interview_trace_id:
        generated.append(interview_trace_id)
    confirm_result = confirm_profile_interview(student)
    confirm_trace_id = str(confirm_result.get("traceId") or "")
    if confirm_trace_id:
        generated.append(confirm_trace_id)

    resource_result = generate_resource_pack_v2(student, goal="CPU scheduling and virtual memory remediation", top_k=3)
    resource_trace_id = str(resource_result.get("traceId") or "")
    if resource_trace_id:
        generated.append(resource_trace_id)
    resource_pack = resource_result.get("resourcePack") if isinstance(resource_result, dict) else {}
    resource_pack_id = str(resource_pack.get("resourcePackId") or "")
    if resource_pack_id:
        classroom_result = record_openmaic_classroom_artifact(
            student,
            resource_pack_id,
            {
                "jobId": "agent-workflow-classroom-demo",
                "status": "succeeded",
                "classroomId": "agent-workflow-classroom",
                "classroomUrl": "/openmaic/classroom/agent-workflow-classroom",
                "scenesCount": 5,
                "pptxExportable": True,
                "elapsedMs": 1200,
            },
        )
        classroom_trace_id = str(classroom_result.get("traceId") or "")
        if classroom_trace_id:
            generated.append(classroom_trace_id)
        video_result = record_openmaic_video_artifact(
            student,
            resource_pack_id,
            {
                "status": "failed",
                "provider": "seedance",
                "resourceType": "micro_video_script",
                "degradedReason": "demo provider key not configured",
                "elapsedMs": 600,
            },
        )
        video_trace_id = str(video_result.get("traceId") or "")
        if video_trace_id:
            generated.append(video_trace_id)
        pptx_result = record_openmaic_pptx_export_artifact(
            student,
            resource_pack_id,
            {
                "jobId": "agent-workflow-pptx-demo",
                "status": "succeeded",
                "classroomId": "agent-workflow-classroom",
                "fileName": "agent-workflow-demo.pptx",
                "slidesCount": 8,
                "elapsedMs": 900,
            },
        )
        pptx_trace_id = str(pptx_result.get("traceId") or "")
        if pptx_trace_id:
            generated.append(pptx_trace_id)
        interaction_result = record_openmaic_classroom_interaction(
            student,
            resource_pack_id,
            {
                "eventType": "scene_complete",
                "classroomId": "agent-workflow-classroom",
                "classroomJobId": "agent-workflow-classroom-demo",
                "sceneId": "scene-1",
                "sceneTitle": "CPU scheduling introduction",
                "actionType": "complete_scene",
                "actionId": "complete-scene-1",
                "progress": 0.6,
                "elapsedMs": 300,
            },
        )
        interaction_trace_id = str(interaction_result.get("traceId") or "")
        if interaction_trace_id:
            generated.append(interaction_trace_id)
        feedback_result = record_resource_feedback(
            student,
            resource_pack_id,
            {"action": "completed", "resourceType": "practice_set", "score": 72},
        )
        feedback_trace_id = str(feedback_result.get("traceId") or "")
        if feedback_trace_id:
            generated.append(feedback_trace_id)

    graph_resource = KnowledgeResource.objects.create(
        owner=student,
        original_name="agent-workflow-material-graph-demo.pdf",
        stored_path="tmp/agent-workflow-material-graph-demo.pdf",
        file_type=".pdf",
        file_size=1024,
        resource_scope=ResourceScope.PERSONAL,
    )
    KnowledgeParseRun.objects.create(resource=graph_resource, status="completed", parser="native", pages=1)
    graph_page = KnowledgePage.objects.create(resource=graph_resource, page_number=1, summary="Operating system material graph demo")
    KnowledgeBlock.objects.create(
        resource=graph_resource,
        page=graph_page,
        modality="text",
        text="CPU scheduling selects ready processes for execution. Semaphores coordinate process synchronization. Virtual memory handles page faults with replacement algorithms.",
        confidence=0.82,
    )
    graph_build = rebuild_resource_graph(graph_resource)
    if graph_build.trace_id:
        generated.append(graph_build.trace_id)

    question = Question.objects.create(
        knowledge_point=point,
        stem="Time-slice round-robin scheduling is mainly used to let interactive processes take turns using CPU time.",
        options=[
            {"key": "A", "text": "Fair CPU sharing among ready processes"},
            {"key": "B", "text": "Only sensor noise"},
            {"key": "C", "text": "Database indexing"},
            {"key": "D", "text": "Image compression"},
        ],
        correct_answer="A",
        explanation="Round-robin scheduling assigns a time slice to each ready process in turn, improving response in time-sharing systems.",
        error_cause="Confused CPU scheduling purpose with unrelated engineering tasks.",
        is_active=True,
    )
    session = AssessmentSession.objects.create(user=student, question_ids=[str(question.id)])
    question_resource = KnowledgeResource.objects.create(
        owner=teacher,
        original_name="agent-workflow-question-bank-demo.pdf",
        stored_path="tmp/agent-workflow-question-bank-demo.pdf",
        file_type="pdf",
        file_size=1024,
        resource_scope=ResourceScope.TEACHER,
    )
    question_job = QuestionGenerationJob.objects.create(
        user=teacher,
        knowledge_point=point,
        resource=question_resource,
        scope=ResourceScope.TEACHER,
        requested_count=2,
    )
    results.append(
        run_question_generation_workflow(
            teacher,
            {"job": question_job},
            kernel=fresh(build_question_bank_kernel()),
        )
    )
    results.append(
        run_assess_grade_workflow(
            student,
            {"session": session, "selectedAnswer": "B", "skipped": False},
            kernel=fresh(build_assessment_kernel()),
        )
    )
    results.append(
        run_teacher_task_workflow(
            teacher,
            {
                "type": "intervention",
                "studentId": str(student.id),
                "message": "Agent 演示干预：请先完成错题复盘，再回到今日任务。",
                "dedupeKey": "agent-workflow-eval-demo",
            },
            kernel=fresh(build_teacher_task_kernel()),
        )
    )

    for result in results:
        if result.trace.get("traceId"):
            generated.append(str(result.trace["traceId"]))
    return generated
