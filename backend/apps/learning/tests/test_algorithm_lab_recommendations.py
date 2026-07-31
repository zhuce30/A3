from django.test import TestCase

from backend.apps.learning import algorithm_labs
from backend.apps.accounts.models import User
from backend.apps.compat.recommendations import build_recommendation_payload
from backend.apps.compat.resource_generation import _build_resource_item
from backend.apps.learning.models import Chapter, Course, KnowledgePoint, LearningPath, LearningPathItem
from backend.apps.learning.services import (
    complete_study_plan_task,
    generate_study_plan,
    serialize_path_item,
)
from backend.apps.profiles.models import LearnerProfile


class AlgorithmLabRecommendationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007771", password="TestPassword123")
        self.profile = LearnerProfile.objects.create(
            user=self.user,
            foundation_level="基础",
            daily_study_time=60,
            weak_points=["处理机调度算法"],
        )
        self.course = Course.objects.create(code="OS-LAB-ENTRY", title="操作系统")
        self.chapter = Chapter.objects.create(course=self.course, order=1, title="处理机管理")
        self.cpu_point = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="OS.CPU.SCHEDULING",
            order=1,
            title="处理机调度算法",
            difficulty=2,
            estimated_minutes=25,
        )
        self.other_point = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="OS.PROCESS.PCB",
            order=2,
            title="进程与 PCB",
            difficulty=2,
            estimated_minutes=20,
        )
        self.path = LearningPath.objects.create(
            user=self.user,
            course=self.course,
            title="操作系统个性化路径",
        )
        self.cpu_item = LearningPathItem.objects.create(
            path=self.path,
            knowledge_point=self.cpu_point,
            order=1,
            status="current",
            estimated_minutes=25,
        )
        self.other_item = LearningPathItem.objects.create(
            path=self.path,
            knowledge_point=self.other_point,
            order=2,
            status="locked",
            estimated_minutes=20,
        )

    def test_mapper_resolves_cpu_and_page_replacement_weak_points(self):
        mapper = getattr(algorithm_labs, "recommend_algorithm_lab", None)
        self.assertTrue(callable(mapper), "algorithm_labs must expose the shared mapper")
        cpu = mapper("处理机调度算法")
        page = mapper("存储管理", ["虚拟内存与缺页处理"])

        self.assertEqual(cpu["labId"], "cpu-scheduling")
        self.assertEqual(cpu["presetId"], "cpu-misconception")
        self.assertEqual(cpu["href"], "/a3/labs/cpu-scheduling")
        self.assertEqual(page["labId"], "page-replacement")
        self.assertEqual(page["presetId"], "page-misconception")
        self.assertEqual(page["href"], "/a3/labs/page-replacement")

    def test_mapper_leaves_unrelated_knowledge_points_unchanged(self):
        mapper = getattr(algorithm_labs, "recommend_algorithm_lab", None)
        self.assertTrue(callable(mapper), "algorithm_labs must expose the shared mapper")
        self.assertIsNone(mapper("进程与 PCB", ["同步互斥与信号量"]))

    def test_recommendation_uses_interactive_lab_action_for_cpu_weakness(self):
        payload = build_recommendation_payload(self.user, top_k=6)
        recommendation = next(
            item for item in payload["recommendations"] if item["title"] == "处理机调度算法 专项学习包"
        )

        self.assertIn("action", recommendation)
        self.assertEqual(
            recommendation.get("action"),
            {
                "kind": "interactive_lab",
                "label": "进入 CPU 调度实验",
                "href": "/a3/labs/cpu-scheduling",
                "labId": "cpu-scheduling",
                "presetId": "cpu-misconception",
                "reason": "对比调度策略，定位等待与周转差异。",
            },
        )

    def test_unrelated_recommendation_preserves_existing_classroom_action(self):
        self.profile.weak_points = ["进程与 PCB"]
        self.profile.save(update_fields=["weak_points", "updated_at"])

        payload = build_recommendation_payload(self.user, top_k=6)
        recommendation = next(
            item for item in payload["recommendations"] if item["title"] == "进程与 PCB 专项学习包"
        )

        self.assertEqual(recommendation["href"], "/a3/classroom")
        self.assertNotIn("action", recommendation)

    def test_path_only_adds_secondary_related_lab_for_matching_point(self):
        cpu = serialize_path_item(self.cpu_item)
        unrelated = serialize_path_item(self.other_item)

        self.assertIn("relatedLab", cpu)
        self.assertEqual(cpu.get("relatedLab", {}).get("labId"), "cpu-scheduling")
        self.assertEqual(cpu.get("relatedLab", {}).get("kind"), "interactive_lab")
        self.assertNotIn("relatedLab", unrelated)

    def test_today_lab_task_keeps_task_identity_status_and_completion_api(self):
        plan = generate_study_plan(self.user, duration_days=7, force=True)
        task = plan["days"][0]["tasks"][0]

        self.assertEqual(task["id"], "d1-learn")
        self.assertEqual(task["status"], "pending")
        self.assertEqual(task["type"], "interactive_lab")
        self.assertEqual(task["href"], "/a3/labs/cpu-scheduling")
        self.assertEqual(task["relatedLab"]["presetId"], "cpu-misconception")

        result = complete_study_plan_task(self.user, day_index=1, task_id=task["id"])
        completed = next(item for item in result["plan"]["days"][0]["tasks"] if item["id"] == task["id"])
        self.assertEqual(completed["id"], "d1-learn")
        self.assertEqual(completed["status"], "completed")
        self.cpu_item.refresh_from_db()
        self.assertGreaterEqual(self.cpu_item.progress, 60)

    def test_code_lab_resource_gets_a_deterministic_related_lab_action(self):
        resource = _build_resource_item(
            "code_lab",
            "CPU 璋冨害绠楁硶",
            self.profile,
            [{"id": "S1", "title": "CPU 璋冨害", "snippet": "CPU 璋冨害绛栫暐瀵规瘮", "type": "RAG"}],
            allow_llm=False,
        )

        self.assertEqual(resource["relatedLab"]["labId"], "cpu-scheduling")
        self.assertEqual(resource["relatedLab"]["kind"], "interactive_lab")

    def test_unrelated_code_lab_resource_does_not_fabricate_a_lab_action(self):
        resource = _build_resource_item(
            "code_lab",
            "杩涚▼鎺у埗鍧?PCB",
            None,
            [{"id": "S1", "title": "PCB", "snippet": "PCB 璁板綍杩涚▼鐘舵€?", "type": "RAG"}],
            allow_llm=False,
        )

        self.assertNotIn("relatedLab", resource)
