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
            progress=45,
            message="正在结合画像、薄弱点和学习目标生成资源内容",
        )
        from backend.apps.compat import resource_generation

        result = resource_generation.generate_resource_pack_v2(
            job.user,
            goal=job.goal,
            top_k=job.top_k,
            resource_type=job.resource_type,
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
