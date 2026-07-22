from datetime import timedelta
import uuid

from celery import current_app
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from backend.apps.compat.models import VideoGenerationJob


class Command(BaseCommand):
    help = "重新派发长时间未推进的持久化视频任务。"

    def add_arguments(self, parser):
        parser.add_argument(
            "--stale-minutes",
            type=int,
            default=5,
            help="仅恢复超过该分钟数未推进的任务，默认 5 分钟。",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=100,
            help="单次最多扫描的活动任务数，默认 100。",
        )

    def handle(self, *args, **options):
        stale_minutes = options["stale_minutes"]
        limit = options["limit"]
        if stale_minutes < 1:
            raise CommandError("--stale-minutes 必须大于或等于 1")
        if limit < 1:
            raise CommandError("--limit 必须大于或等于 1")

        cutoff = timezone.now() - timedelta(minutes=stale_minutes)
        candidate_ids = list(
            VideoGenerationJob.objects.filter(
                status__in=["queued", "running"],
                updated_at__lte=cutoff,
            )
            .order_by("updated_at", "id")
            .values_list("id", flat=True)[:limit]
        )
        recovered = 0
        failed = 0

        for job_id in candidate_ids:
            try:
                with transaction.atomic():
                    job = VideoGenerationJob.objects.select_for_update().get(id=job_id)
                    active_segment = (
                        job.segments.exclude(status__in=["succeeded", "failed"])
                        .order_by("index", "id")
                        .first()
                    )
                    latest_segment = active_segment or job.segments.order_by("-updated_at", "-id").first()
                    if latest_segment is None:
                        continue

                    activity_times = [job.updated_at, latest_segment.updated_at]
                    if latest_segment.last_polled_at:
                        activity_times.append(latest_segment.last_polled_at)
                    if max(activity_times) > cutoff:
                        continue

                    if active_segment and active_segment.provider_task_id:
                        task_name = "compat.poll_video_generation_segment"
                        task_args = [job.job_id, active_segment.index]
                    else:
                        task_name = "compat.advance_video_generation_job"
                        task_args = [job.job_id]

                    celery_task_id = uuid.uuid4().hex
                    if active_segment:
                        active_segment.celery_task_id = celery_task_id
                        active_segment.save(update_fields=["celery_task_id", "updated_at"])
                    job.celery_task_id = celery_task_id
                    job.message = "视频任务已由恢复命令重新派发。"
                    job.save(update_fields=["celery_task_id", "message", "updated_at"])
                current_app.send_task(task_name, args=task_args, task_id=celery_task_id)
                recovered += 1
            except Exception as exc:
                failed += 1
                self.stderr.write(
                    self.style.WARNING(f"视频任务 {job_id} 恢复派发失败：{str(exc)[:200]}")
                )

        summary = f"恢复派发 {recovered} 个视频任务"
        if failed:
            summary += f"，{failed} 个失败"
        self.stdout.write(self.style.SUCCESS(summary))
