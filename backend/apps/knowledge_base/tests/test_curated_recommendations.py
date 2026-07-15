from __future__ import annotations

from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.assessments.models import Question, WrongQuestion
from backend.apps.knowledge_base.models import (
    CuratedLearningResource,
    CuratedResourceDeliveryMode,
    CuratedResourceDifficulty,
    CuratedResourceType,
    CuratedResourceVerificationStatus,
    KnowledgeBlock,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.learning.effect_events import record_learning_event
from backend.apps.learning.models import Chapter, Course, KnowledgePoint, LearningPath, LearningPathItem
from backend.apps.profiles.models import LearnerProfile


class CuratedResourceLibraryApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800139301", password="secure-pass-123")
        self.owner = User.objects.create_user(phone="13800139302", password="secure-pass-123")
        self.client = Client()
        self.client.force_login(self.user)
        self.course = Course.objects.create(code="OS-LIBRARY", title="操作系统")
        self.chapter = Chapter.objects.create(course=self.course, order=1, title="进程管理")
        self.process = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="OS-LIB-PROCESS",
            order=1,
            title="进程与线程",
            difficulty=2,
            estimated_minutes=35,
        )
        self.scheduling = KnowledgePoint.objects.create(
            chapter=self.chapter,
            code="OS-LIB-SCHEDULING",
            order=2,
            title="CPU 调度",
            difficulty=2,
            estimated_minutes=30,
        )
        LearnerProfile.objects.create(
            user=self.user,
            foundation_level="基础较弱",
            daily_study_time=25,
            learning_goals=["掌握进程调度"],
            weak_points=["CPU 调度", "进程状态转换"],
            expected_resources=["实操案例", "视频"],
        )
        path = LearningPath.objects.create(user=self.user, course=self.course, title="操作系统学习路径")
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=self.scheduling,
            order=1,
            status="current",
            estimated_minutes=30,
        )
        question = Question.objects.create(
            knowledge_point=self.scheduling,
            stem="时间片轮转调度的关键参数是什么？",
            options=[{"key": "A", "text": "时间片"}, {"key": "B", "text": "页大小"}],
            correct_answer="A",
            explanation="时间片决定轮转频率。",
        )
        WrongQuestion.objects.create(user=self.user, question=question, wrong_count=3, mastered=False)

        self.scheduling_lab = self._create_internal_resource(
            code="OS-LAB-MATCH",
            title="Linux 进程调度观察实验",
            resource_type=CuratedResourceType.CODE_LAB,
            point=self.scheduling,
            difficulty=CuratedResourceDifficulty.FOUNDATION,
            minutes=25,
            triggers=["CPU 调度", "时间片轮转"],
        )
        self.process_doc = self._create_internal_resource(
            code="OS-DOC-GENERAL",
            title="进程与线程基础讲解",
            resource_type=CuratedResourceType.LECTURE_DOC,
            point=self.process,
            difficulty=CuratedResourceDifficulty.INTERMEDIATE,
            minutes=45,
            triggers=["进程与线程"],
        )
        self.video = CuratedLearningResource.objects.create(
            resource_code="OS-VIDEO-MATCH",
            course=self.course,
            resource_type=CuratedResourceType.VIDEO,
            delivery_mode=CuratedResourceDeliveryMode.EXTERNAL_LINK,
            title="CPU 调度算法动画讲解",
            summary="对比 FCFS、RR 与优先级调度。",
            external_url="https://www.bilibili.com/video/BVTEST",
            provider="哔哩哔哩",
            difficulty=CuratedResourceDifficulty.FOUNDATION,
            estimated_minutes=18,
            weakness_triggers=["CPU 调度"],
            learning_objectives=["区分常见调度算法"],
            completion_criteria=["能说明 RR 的时间片作用"],
            verification_status=CuratedResourceVerificationStatus.VERIFIED,
        )
        self.video.knowledge_points.add(self.scheduling)
        self._create_internal_resource(
            code="OS-DOC-INACTIVE",
            title="已停用资料",
            resource_type=CuratedResourceType.LECTURE_DOC,
            point=self.scheduling,
            difficulty=CuratedResourceDifficulty.FOUNDATION,
            minutes=10,
            triggers=["CPU 调度"],
            is_active=False,
        )
        self._create_internal_resource(
            code="OS-DOC-UNVERIFIED",
            title="待复核资料",
            resource_type=CuratedResourceType.LECTURE_DOC,
            point=self.scheduling,
            difficulty=CuratedResourceDifficulty.FOUNDATION,
            minutes=10,
            triggers=["CPU 调度"],
            verification_status=CuratedResourceVerificationStatus.NEEDS_REVIEW,
        )

    def _create_internal_resource(
        self,
        *,
        code: str,
        title: str,
        resource_type: str,
        point: KnowledgePoint,
        difficulty: str,
        minutes: int,
        triggers: list[str],
        is_active: bool = True,
        verification_status: str = CuratedResourceVerificationStatus.VERIFIED,
    ) -> CuratedLearningResource:
        knowledge_resource = KnowledgeResource.objects.create(
            owner=self.owner,
            original_name=f"{title}.docx",
            stored_path=f"D:/private/catalog/{code}.docx",
            file_type=".docx",
            file_size=1024,
            resource_scope=ResourceScope.GLOBAL,
            course_key=self.course.code,
            visibility="shared",
            status=ResourceStatus.INDEXED,
            chunk_count=2,
        )
        KnowledgeBlock.objects.create(
            resource=knowledge_resource,
            modality="text",
            text=f"{title}正文：时间片轮转会让就绪进程依次获得 CPU。",
            markdown=f"## {title}\n\n时间片轮转会让就绪进程依次获得 CPU。",
            confidence=0.95,
        )
        resource = CuratedLearningResource.objects.create(
            resource_code=code,
            course=self.course,
            knowledge_resource=knowledge_resource,
            resource_type=resource_type,
            delivery_mode=CuratedResourceDeliveryMode.INTERNAL_DOCUMENT,
            title=title,
            summary=f"{title}的系统学习资料。",
            difficulty=difficulty,
            estimated_minutes=minutes,
            weakness_triggers=triggers,
            learning_objectives=["掌握核心概念"],
            completion_criteria=["完成文档中的自测任务"],
            verification_status=verification_status,
            is_active=is_active,
        )
        resource.knowledge_points.add(point)
        return resource

    def test_library_ranks_resources_from_path_wrong_questions_profile_and_time(self):
        response = self.client.get("/api/kb/library/?recommended=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["recommended"][0]["resourceCode"], "OS-LAB-MATCH")
        personalization = payload["recommended"][0]["personalization"]
        self.assertGreater(personalization["score"], 0)
        self.assertIn("CPU 调度", personalization["matchedKnowledgePoints"])
        self.assertIn("current_path", personalization["matchedTriggers"])
        self.assertIn("wrong_question", personalization["matchedTriggers"])
        self.assertIn("profile_weak_point", personalization["matchedTriggers"])
        self.assertIn("daily_time_fit", personalization["matchedTriggers"])
        self.assertTrue(personalization["reason"])
        self.assertTrue(personalization["rankingBasis"])

    def test_library_excludes_unavailable_resources_filters_types_and_hides_storage_paths(self):
        response = self.client.get("/api/kb/library/?type=video")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([item["resourceCode"] for item in payload["resources"]], ["OS-VIDEO-MATCH"])
        self.assertEqual(payload["summary"], {"total": 3, "documents": 2, "videos": 1})
        serialized = str(payload)
        self.assertNotIn("stored_path", serialized)
        self.assertNotIn("D:/private", serialized)
        self.assertNotIn("OS-DOC-INACTIVE", serialized)
        self.assertNotIn("OS-DOC-UNVERIFIED", serialized)

    def test_recent_completion_and_repeated_skips_reduce_personalized_score(self):
        baseline = self.client.get("/api/kb/library/?recommended=3").json()["recommended"]
        baseline_scores = {item["resourceCode"]: item["personalization"]["score"] for item in baseline}
        record_learning_event(
            self.user,
            event_type="resource_completed",
            target_type="curated_resource",
            target_id=self.scheduling_lab.resource_code,
            resource_type=self.scheduling_lab.resource_type,
        )
        for _ in range(2):
            record_learning_event(
                self.user,
                event_type="resource_skipped",
                target_type="curated_resource",
                target_id=self.video.resource_code,
                resource_type=self.video.resource_type,
            )

        updated = self.client.get("/api/kb/library/?recommended=3").json()["recommended"]
        updated_scores = {item["resourceCode"]: item["personalization"]["score"] for item in updated}

        self.assertLess(updated_scores[self.scheduling_lab.resource_code], baseline_scores[self.scheduling_lab.resource_code])
        self.assertLess(updated_scores[self.video.resource_code], baseline_scores[self.video.resource_code])

    def test_internal_detail_returns_safe_rag_preview_and_video_is_not_a_verified_citation(self):
        document_response = self.client.get(f"/api/kb/library/{self.scheduling_lab.resource_code}/")
        video_response = self.client.get(f"/api/kb/library/{self.video.resource_code}/")

        self.assertEqual(document_response.status_code, 200)
        document = document_response.json()["resource"]
        self.assertEqual(document["action"]["href"], f"/api/kb/library/{self.scheduling_lab.resource_code}/content/")
        self.assertIn("时间片轮转", document["contentPreview"][0]["markdown"])
        self.assertEqual(document["verification"]["citationEligible"], True)
        self.assertNotIn("stored_path", str(document))

        self.assertEqual(video_response.status_code, 200)
        video = video_response.json()["resource"]
        self.assertEqual(video["action"]["href"], self.video.external_url)
        self.assertEqual(video["verification"]["catalogVerified"], True)
        self.assertEqual(video["verification"]["citationEligible"], False)
        self.assertIn("字幕", video["verification"]["note"])

    def test_library_requires_login(self):
        anonymous = Client().get("/api/kb/library/")

        self.assertIn(anonymous.status_code, {401, 403})

    def test_existing_recommendation_workflow_includes_curated_resource_evidence(self):
        response = self.client.post("/api/recommend/", data='{"topK": 8}', content_type="application/json")

        self.assertEqual(response.status_code, 200)
        recommendations = response.json()["recommendations"]
        curated = next(item for item in recommendations if item["href"] == "/a3/library/OS-LAB-MATCH")
        self.assertEqual(curated["evidence"]["curatedResource"]["resourceCode"], "OS-LAB-MATCH")
        self.assertIn("CPU 调度", curated["reason"])
