from __future__ import annotations

from backend.apps.compat.resource_generation import list_resource_packs
from backend.apps.compat.tests.common import CompatApiTestCase
from backend.apps.learning.models import ResourcePackLog


class ResourcePackLogFallbackTests(CompatApiTestCase):
    def test_list_resource_packs_recovers_generation_payload_when_profile_cache_is_empty(self):
        pack = {
            "schemaVersion": "a3.resource-pack.v2",
            "resourcePackId": "pack-from-log",
            "traceId": "trace-from-log",
            "goal": "复习进程调度",
            "createdAt": "2026-07-13T00:00:00Z",
            "resources": [
                {
                    "type": "lecture_doc",
                    "title": "进程调度讲义",
                    "verified": True,
                    "citations": [],
                }
            ],
            "nextActions": [],
        }
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:pack-from-log",
            task_title="进程调度讲义",
            learning_goal="复习进程调度",
            source="resource_generation",
            payload=pack,
        )
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:plan-task",
            task_title="学习计划任务",
            learning_goal="完成今日任务",
            source="study_plan_completion",
            payload={"resourcePackId": "not-a-generated-pack"},
        )

        packs = list_resource_packs(self.user)

        self.assertEqual([item["resourcePackId"] for item in packs], ["pack-from-log"])
        self.assertEqual(packs[0]["resources"][0]["type"], "lecture_doc")
