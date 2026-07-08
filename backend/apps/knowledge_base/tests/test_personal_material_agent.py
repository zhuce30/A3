from __future__ import annotations

import tempfile
from pathlib import Path

from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgeResource, ResourceScope, ResourceStatus
from backend.apps.profiles.models import LearnerProfile


class PersonalMaterialAgentTests(TestCase):
    def setUp(self):
        self.student = User.objects.create_user(phone="13800139201", password="secure-pass-123")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def test_agent_analyzes_personal_pptx_and_writes_profile_snapshot(self):
        from backend.apps.knowledge_base.personal_agent import PersonalMaterialAgent

        path = Path(self.temp_dir.name) / "轴向拉伸压缩强度课件.pptx"
        path.write_bytes(b"pptx")
        resource = KnowledgeResource.objects.create(
            owner=self.student,
            original_name="轴向拉伸压缩强度课件.pptx",
            stored_path=str(path),
            file_type=".pptx",
            file_size=path.stat().st_size,
            resource_scope=ResourceScope.PERSONAL,
            status=ResourceStatus.INDEXED,
        )
        KnowledgeBlock.objects.create(
            resource=resource,
            modality="text",
            text="轴向拉伸和压缩的强度条件包括工作应力、许用应力、危险截面和安全系数。",
            confidence=0.9,
        )

        result = PersonalMaterialAgent().analyze_and_writeback(resource)

        resource.refresh_from_db()
        profile = LearnerProfile.objects.get(user=self.student)
        self.assertEqual(result["resourceId"], str(resource.id))
        self.assertEqual(result["materialType"], "courseware")
        self.assertIn("强度条件", result["knowledgePoints"])
        self.assertEqual(resource.student_profile_snapshot["schemaVersion"], "a3.personal-material.v1")
        self.assertIn("强度条件", profile.weak_points)
        self.assertEqual(profile.extra_profile["personalMaterials"][0]["resourceId"], str(resource.id))
        self.assertEqual(result["recommendedTasks"][0]["sourceResourceId"], str(resource.id))

    def test_agent_ignores_non_personal_resources_for_profile_writeback(self):
        from backend.apps.knowledge_base.personal_agent import PersonalMaterialAgent

        path = Path(self.temp_dir.name) / "teacher.pptx"
        path.write_bytes(b"pptx")
        resource = KnowledgeResource.objects.create(
            owner=self.student,
            original_name="teacher.pptx",
            stored_path=str(path),
            file_type=".pptx",
            file_size=path.stat().st_size,
            resource_scope=ResourceScope.TEACHER,
            status=ResourceStatus.INDEXED,
        )

        result = PersonalMaterialAgent().analyze_and_writeback(resource)

        self.assertEqual(result["writeback"]["profileUpdated"], False)
        self.assertFalse(LearnerProfile.objects.filter(user=self.student).exists())
