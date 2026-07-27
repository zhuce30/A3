from __future__ import annotations

import logging

from celery import shared_task
from django.db import InterfaceError, OperationalError, close_old_connections
from django.utils import timezone

from backend.apps.compat.models import ResourceGenerationJob


logger = logging.getLogger(__name__)


def _user_facing_resource_generation_error(exc: Exception) -> str:
    if isinstance(exc, (InterfaceError, OperationalError)):
        return "数据库连接暂时中断，请重新生成资源。"
    return str(exc).strip() or "资源生成任务执行失败"


def _save_job_state(job: ResourceGenerationJob, **changes) -> None:
    for field, value in changes.items():
        setattr(job, field, value)
    update_fields = [*changes.keys(), "updated_at"]
    try:
        job.save(update_fields=update_fields)
    except (InterfaceError, OperationalError):
        close_old_connections()
        job.save(update_fields=update_fields)


@shared_task(
    bind=True,
    name="compat.run_resource_generation_job",
    acks_late=True,
    reject_on_worker_lost=False,
    soft_time_limit=1200,
    time_limit=1320,
)
def run_resource_generation_job(self, job_id: str) -> dict:
    close_old_connections()
    job = ResourceGenerationJob.objects.select_related("user").get(job_id=job_id)
    if job.status in {"succeeded", "failed"}:
        return job.result if isinstance(job.result, dict) else {}

    metadata = dict(job.metadata or {})
    metadata["celeryTaskId"] = self.request.id or metadata.get("celeryTaskId") or ""
    metadata["executionBackend"] = "celery"
    _save_job_state(
        job,
        status="running",
        stage="retrieval",
        progress=15,
        message="正在检索本地知识库和课程资料",
        error_message="",
        metadata=metadata,
        started_at=job.started_at or timezone.now(),
        finished_at=None,
    )

    try:
        _save_job_state(
            job,
            stage="synthesis",
            progress=20,
            message="正在启动 Agent 编排",
        )
        from backend.apps.compat import resource_generation

        # 逐 Agent 实时上报：Agent 阶段占 20%~85%，剩余留给写回。
        agent_progress: list[dict] = []

        def _handle_agent_step(event: dict) -> None:
            order = int(event.get("order") or 0)
            total = max(1, int(event.get("total") or 1))
            name = str(event.get("name") or "")
            label = resource_generation.RESOURCE_AGENT_LABELS.get(name, name)
            running = str(event.get("phase") or "") == "started"
            agent_progress[:] = [item for item in agent_progress if item.get("order") != order]
            agent_progress.append(
                {
                    "order": order,
                    "total": total,
                    "name": name,
                    "label": label,
                    "role": str(event.get("role") or ""),
                    "status": "running" if running else str(event.get("status") or ""),
                    "outputSummary": event.get("outputSummary") or {},
                }
            )
            agent_progress.sort(key=lambda item: item.get("order") or 0)
            done = sum(1 for item in agent_progress if item.get("status") != "running")
            # 完整流水线计划（含尚未执行的 Agent），让前端一开始就能列出全部步骤名。
            planned = [
                {
                    "order": index,
                    "name": str(agent_name),
                    "label": resource_generation.RESOURCE_AGENT_LABELS.get(str(agent_name), str(agent_name)),
                }
                for index, agent_name in enumerate(event.get("sequence") or [], start=1)
            ]
            next_metadata = {**metadata, "agentProgress": list(agent_progress)}
            if planned:
                next_metadata["agentPlan"] = planned
            _save_job_state(
                job,
                status="running",
                stage=f"agent:{name}" if name else "agents",
                progress=20 + round(65 * done / total),
                message=f"第 {order}/{total} 步 {label} " + ("正在执行" if running else "已完成"),
                metadata=next_metadata,
            )

        result = resource_generation.generate_resource_pack_v2(
            job.user,
            goal=job.goal,
            top_k=job.top_k,
            resource_type=job.resource_type,
            on_step=_handle_agent_step,
        )
        resource_pack = result.get("resourcePack") if isinstance(result, dict) else None
        if not isinstance(resource_pack, dict):
            raise RuntimeError("资源生成服务未返回有效资源包")

        _save_job_state(
            job,
            status="running",
            stage="writeback",
            progress=85,
            message="正在保存资源包和 Agent 证据",
        )
        trace_id = str(result.get("traceId") or resource_pack.get("traceId") or "")
        resource_pack_id = str(resource_pack.get("resourcePackId") or "")
        payload = {"resourcePack": resource_pack}
        _save_job_state(
            job,
            status="succeeded",
            stage="completed",
            progress=100,
            message="单项资源已生成，可以打开查看" if job.resource_type else "资源包已生成，可以选择资源查看",
            resource_pack_id=resource_pack_id,
            trace_id=trace_id,
            result=payload,
            error_message="",
            finished_at=timezone.now(),
        )
        return payload
    except Exception as exc:
        logger.exception(
            "Resource generation job failed",
            extra={"resource_generation_job_id": job.job_id},
        )
        error_message = _user_facing_resource_generation_error(exc)
        _save_job_state(
            job,
            status="failed",
            stage="failed",
            progress=100,
            message=error_message[:255],
            error_message=error_message[:4000],
            finished_at=timezone.now(),
        )
        return {"success": False, "error": error_message}
    finally:
        close_old_connections()


# Celery autodiscovery imports tasks.py; importing registers the durable video state-machine tasks.
from backend.apps.compat.video_tasks import advance_video_generation_job, poll_video_generation_segment  # noqa: E402,F401
from backend.apps.compat.video_composition_tasks import compose_final_video, generate_video_narration  # noqa: E402,F401
