import json
import tempfile
from datetime import timedelta
from unittest.mock import patch
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from backend.apps.accounts.models import User, UserRole
from backend.apps.assessments.models import WrongQuestion
from backend.apps.compat.models import AgentRun, OpenMAICArtifact
from backend.apps.engagement.models import UserNotification
from backend.apps.knowledge_base.models import KnowledgeAsset, KnowledgeBlock, KnowledgePage, KnowledgeResource, ResourceStatus
from backend.apps.learning.models import Course, CourseTeachingAssignment, LearningPathStatus, PathItemStatus, ResourcePackLog
from backend.apps.learning.services import _repair_default_course_catalog, generate_learning_path, generate_study_plan
from backend.apps.profiles.models import LearnerProfile
from backend.domains.knowledge_base.retriever import KnowledgeBaseSearchResult


class LearningPathTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009999", password="TestPassword123")
        self.teacher = User.objects.create_user(
            phone="13800008888",
            password="TestPassword123",
            role=UserRole.TEACHER,
            display_name="教师用户",
        )
        LearnerProfile.objects.create(
            user=self.user,
            foundation_level="基础",
            weak_points=["进程调度"],
            learning_goals=["掌握操作系统"],
        )
        self.course = _repair_default_course_catalog()
        CourseTeachingAssignment.objects.create(teacher=self.teacher, course=self.course)
        self.client = Client()
        self.client.force_login(self.user)

    def test_generated_path_respects_all_prerequisites(self):
        path = generate_learning_path(self.user, self.course)
        positions = {item.knowledge_point_id: item.order for item in path.items.all()}
        for item in path.items.select_related("knowledge_point").prefetch_related("knowledge_point__prerequisite_edges"):
            for edge in item.knowledge_point.prerequisite_edges.all():
                self.assertLess(positions[edge.prerequisite_id], item.order)
        self.assertEqual(path.items.first().status, PathItemStatus.CURRENT)

    def test_force_replan_archives_previous_version(self):
        first = generate_learning_path(self.user, self.course)
        second = generate_learning_path(self.user, self.course, force=True)
        first.refresh_from_db()
        self.assertEqual(first.status, LearningPathStatus.ARCHIVED)
        self.assertEqual(second.version, 2)

    def test_learning_generate_path_uses_agent_kernel_trace(self):
        response = self.client.post(
            "/api/learning/paths/generate/",
            data=json.dumps({"courseId": str(self.course.id), "force": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("traceId", payload)
        self.assertGreater(len(payload["path"]["items"]), 0)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        step_names = [step.name for step in run.steps.all()]
        self.assertEqual(step_names, ["LearningStateAgent", "PlannerAgent", "GraphAgent", "StudyPlanAgent"])

    def test_completing_current_item_unlocks_next(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        response = self.client.patch(
            f"/api/learning/path-items/{current.id}/progress/",
            data=json.dumps({"progress": 100}), content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        current.refresh_from_db()
        next_item = path.items.filter(order__gt=current.order).first()
        self.assertEqual(current.status, PathItemStatus.COMPLETED)
        self.assertEqual(next_item.status, PathItemStatus.CURRENT)

    def test_locked_item_cannot_be_completed(self):
        path = generate_learning_path(self.user, self.course)
        locked = path.items.filter(status=PathItemStatus.LOCKED).first()
        response = self.client.patch(
            f"/api/learning/path-items/{locked.id}/progress/",
            data=json.dumps({"progress": 100}), content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_knowledge_graph_reflects_path_state(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        response = self.client.get("/api/learning/graph/")
        self.assertEqual(response.status_code, 200)
        graph = response.json()["graph"]
        self.assertEqual(graph["schemaVersion"], "a3.knowledge-graph.v1")
        self.assertEqual(graph["evidence"]["source"], "learning_graph_service")
        self.assertGreaterEqual(graph["evidence"]["prerequisiteEdgeCount"], 1)
        self.assertGreaterEqual(graph["summary"]["total"], 1)
        self.assertGreaterEqual(len(graph["edges"]), 1)
        edge = graph["edges"][0]
        self.assertEqual(edge["type"], "prerequisite")
        self.assertIn("label", edge)
        nodes = {node["id"]: node for node in graph["nodes"]}
        current_node = nodes[str(current.knowledge_point_id)]
        self.assertEqual(current_node["status"], "learning")
        self.assertEqual(current_node["pathBinding"]["pathItemId"], str(current.id))
        self.assertEqual(current_node["pathBinding"]["status"], "current")
        self.assertEqual(current_node["evidence"]["source"], "course_knowledge_point")
        self.assertIn("chapter", current_node["evidence"])

    def test_classroom_context_uses_current_path_target(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        response = self.client.get("/api/learning/classroom/")
        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        self.assertEqual(classroom["target"]["id"], str(current.knowledge_point_id))
        self.assertGreaterEqual(len(classroom["agents"]), 1)
        self.assertGreaterEqual(len(classroom["sources"]), 1)

    def test_classroom_recommendations_include_explicit_plan_task_binding(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        plan = generate_study_plan(self.user, duration_days=7, force=True)

        response = self.client.get("/api/learning/classroom/")

        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        recommendation = next(
            item
            for item in classroom["recommended"]
            if item["title"] == current.knowledge_point.title or current.knowledge_point.title in item["title"]
        )
        self.assertEqual(recommendation["planTask"]["dayIndex"], plan["days"][0]["dayIndex"])
        self.assertEqual(recommendation["planTask"]["taskId"], "d1-practice")
        self.assertFalse(recommendation["planTask"]["completed"])

    def test_classroom_context_uses_fast_course_source_without_blocking_retrieval(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)

        with patch("backend.apps.learning.services.search_lexical_knowledge_base") as lexical:
            response = self.client.get("/api/learning/classroom/")

        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        self.assertEqual(classroom["target"]["id"], str(current.knowledge_point_id))
        self.assertGreaterEqual(len(classroom["sources"]), 1)
        self.assertEqual(classroom["sources"][0]["title"], current.knowledge_point.title)
        lexical.assert_not_called()

    def test_classroom_context_shows_uploaded_resource_name_in_sources(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="teacher-root-locus.xlsx",
            stored_path="uploads/teacher-root-locus-abc.xlsx",
            file_type=".xlsx",
            status=ResourceStatus.INDEXED,
        )

        response = self.client.get("/api/learning/classroom/")

        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        self.assertEqual(classroom["target"]["id"], str(current.knowledge_point_id))
        # course-point is always at sources[0]; upload resource follows at sources[1]
        upload_source = next((s for s in classroom["sources"] if s["title"] == "teacher-root-locus.xlsx"), None)
        self.assertIsNotNone(upload_source, "uploaded resource should appear in sources")
        self.assertTrue(upload_source["location"])
        self.assertIn("teacher-root-locus.xlsx", upload_source["location"])
        self.assertNotIn("uploads/", upload_source["location"])
        self.assertNotIn(":\\", upload_source["location"])

    def test_classroom_history_persists_user_and_assistant_messages(self):
        response = self.client.post(
            "/api/learning/classroom/history/",
            data=json.dumps(
                {
                    "messages": [
                        {"id": "user-1", "role": "user", "content": "反馈控制是什么？"},
                        {
                            "id": "assistant-1",
                            "role": "assistant",
                            "content": "反馈控制会把输出信号回送并与输入比较。",
                            "verified": True,
                            "citations": [{"title": "反馈控制结构"}],
                        },
                    ]
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)

        history = self.client.get("/api/learning/classroom/history/")
        payload = history.json()

        self.assertTrue(payload["success"])
        self.assertEqual([item["id"] for item in payload["messages"][-2:]], ["user-1", "assistant-1"])
        self.assertEqual(payload["messages"][-1]["citations"][0]["title"], "反馈控制结构")

    def test_classroom_history_enriches_legacy_block_citations_with_preview_url(self):
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="frequency-response.pptx",
            stored_path="uploads/frequency-response.pptx",
            file_type=".pptx",
            status=ResourceStatus.INDEXED_WITH_WARNINGS,
        )
        page = KnowledgePage.objects.create(resource=resource, page_number=1, slide_number=1)
        asset = KnowledgeAsset.objects.create(
            resource=resource,
            page=page,
            kind="rendered_slide",
            storage_path="rendered/page-1.png",
            mime_type="image/png",
        )
        block = KnowledgeBlock.objects.create(
            resource=resource,
            page=page,
            modality="text",
            text="什么是频域响应法？",
        )
        self.client.post(
            "/api/learning/classroom/history/",
            data=json.dumps({
                "messages": [
                    {
                        "id": "assistant-preview",
                        "role": "assistant",
                        "content": "频域响应法解释。",
                        "verified": True,
                        "citations": [{"title": resource.original_name, "blockId": str(block.id)}],
                        "claims": [{"id": "c1", "text": "频域响应法可用于稳定性分析。", "verified": True, "citation": {"title": resource.original_name, "blockId": str(block.id)}}],
                    }
                ]
            }),
            content_type="application/json",
        )

        response = self.client.get("/api/learning/classroom/history/")

        self.assertEqual(response.status_code, 200)
        assistant = response.json()["messages"][-1]
        expected = f"/api/kb/assets/{asset.id}/preview/"
        self.assertEqual(assistant["citations"][0]["previewUrl"], expected)
        self.assertEqual(assistant["claims"][0]["citation"]["previewUrl"], expected)

    def test_classroom_history_can_start_new_session_without_deleting_previous_messages(self):
        self.client.post(
            "/api/learning/classroom/history/",
            data=json.dumps({"messages": [{"id": "user-1", "role": "user", "content": "restart me"}]}),
            content_type="application/json",
        )

        response = self.client.post(
            "/api/learning/classroom/history/",
            data=json.dumps({"startNew": True}),
            content_type="application/json",
        )
        history = self.client.get("/api/learning/classroom/history/")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertEqual(history.json()["messages"], [])
        self.assertEqual(history.json()["sessions"][0]["messages"][0]["content"], "restart me")

    def test_classroom_history_is_scoped_to_current_user(self):
        self.client.post(
            "/api/learning/classroom/history/",
            data=json.dumps({"messages": [{"id": "user-1", "role": "user", "content": "只属于当前用户"}]}),
            content_type="application/json",
        )
        other = User.objects.create_user(phone="13800007777", password="TestPassword123")
        LearnerProfile.objects.create(user=other)
        self.client.force_login(other)

        history = self.client.get("/api/learning/classroom/history/")

        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()["messages"], [])

    def test_classroom_context_merges_indexed_upload_sources_with_global_sources(self):
        path = generate_learning_path(self.user, self.course)
        stored_path = "uploads/teacher-stability-abc.xlsx"
        KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="teacher-stability.xlsx",
            stored_path=stored_path,
            file_type=".xlsx",
            status=ResourceStatus.INDEXED,
        )
        KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="global.xlsx",
            stored_path="data/global.xlsx",
            file_type=".xlsx",
            status=ResourceStatus.INDEXED,
        )

        response = self.client.get("/api/learning/classroom/")

        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        self.assertEqual(classroom["target"]["id"], str(path.items.get(status=PathItemStatus.CURRENT).knowledge_point_id))
        source_titles = [s["title"] for s in classroom["sources"]]
        self.assertIn("teacher-stability.xlsx", source_titles)
        self.assertIn("global.xlsx", source_titles)
        stability_source = next(s for s in classroom["sources"] if s["title"] == "teacher-stability.xlsx")
        global_source = next(s for s in classroom["sources"] if s["title"] == "global.xlsx")
        self.assertNotIn(stored_path, stability_source["location"])
        self.assertNotIn("data/global.xlsx", global_source["location"])

    def test_classroom_context_falls_back_to_recent_indexed_upload_source(self):
        generate_learning_path(self.user, self.course)
        stored_path = "uploads/recent-teacher-material.xlsx"
        KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="recent-teacher-material.xlsx",
            stored_path=stored_path,
            file_type=".xlsx",
            status=ResourceStatus.INDEXED,
            document_count=1,
            chunk_count=1,
        )

        response = self.client.get("/api/learning/classroom/")

        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        # course-point is always sources[0]; upload resource is appended after it
        upload_source = next((s for s in classroom["sources"] if s["title"] == "recent-teacher-material.xlsx"), None)
        self.assertIsNotNone(upload_source, "fallback upload source should appear in sources")
        self.assertEqual(upload_source["type"], "教师上传资料")
        self.assertIn("已索引", upload_source["snippet"])

    def test_classroom_context_excludes_other_student_personal_sources(self):
        generate_learning_path(self.user, self.course)
        other_student = User.objects.create_user(phone="13800007777", password="TestPassword123")
        KnowledgeResource.objects.create(
            owner=other_student,
            original_name="other-student-private-notes.pdf",
            stored_path="uploads/other-student-private-notes.pdf",
            file_type=".pdf",
            status=ResourceStatus.INDEXED,
            resource_scope="personal",
            document_count=1,
            chunk_count=1,
        )

        response = self.client.get("/api/learning/classroom/")

        self.assertEqual(response.status_code, 200)
        classroom = response.json()["classroom"]
        source_titles = [source["title"] for source in classroom["sources"]]
        self.assertNotIn("other-student-private-notes.pdf", source_titles)

    @patch.dict("os.environ", {"A3_KB_SYNC_INDEX_ON_UPLOAD": "1"})
    @patch("backend.apps.knowledge_base.tasks.close_old_connections")
    @patch("backend.domains.knowledge_base.index_manager.append_source_file", return_value=(2, 5, []))
    def test_teacher_upload_api_indexes_resource_and_student_classroom_cites_it(self, _append_source_file, _close_connections):
        generate_learning_path(self.user, self.course)
        upload = SimpleUploadedFile("phase-c-root-locus.pdf", b"fake-pdf", content_type="application/pdf")

        with tempfile.TemporaryDirectory() as temp_dir, override_settings(KNOWLEDGE_UPLOAD_ROOT=temp_dir):
            self.client.force_login(self.teacher)
            upload_response = self.client.post("/api/kb/resources/upload/", data={"files": [upload]})

            self.assertEqual(upload_response.status_code, 202)
            payload = upload_response.json()
            self.assertTrue(payload["success"])
            self.assertEqual(payload["job"]["status"], "succeeded")
            self.assertEqual(payload["resources"][0]["status"], ResourceStatus.INDEXED)

            self.client.force_login(self.user)
            classroom_response = self.client.get("/api/learning/classroom/")

        self.assertEqual(classroom_response.status_code, 200)
        classroom = classroom_response.json()["classroom"]
        source = next((item for item in classroom["sources"] if item["title"] == "phase-c-root-locus.pdf"), None)
        self.assertIsNotNone(source, "uploaded and indexed PDF should be visible as a classroom citation source")
        self.assertEqual(source["type"], "教师上传资料")
        self.assertIn("phase-c-root-locus.pdf", source["snippet"])

    def test_teacher_workbench_returns_real_aggregate(self):
        generate_learning_path(self.user, self.course)
        profile = self.user.learner_profile
        profile.extra_profile = {
            **(profile.extra_profile if isinstance(profile.extra_profile, dict) else {}),
            "resourcePackRuns": [
                {
                    "schemaVersion": "a3.resource-pack-run.v1",
                    "runId": "r1",
                    "taskId": "resource-pack:root-locus",
                    "learningGoal": "root locus",
                    "verifiedSourceCount": 3,
                    "confidence": "high",
                    "practiceHref": "/a3/assessment?practice=root%20locus",
                    "completedAt": "2999-01-01T00:00:00",
                }
            ],
        }
        profile.save(update_fields=["extra_profile", "updated_at"])
        self.client.force_login(self.teacher)
        response = self.client.get("/api/learning/teacher/workbench/")
        self.assertEqual(response.status_code, 200)
        workbench = response.json()["workbench"]
        self.assertGreaterEqual(len(workbench["metrics"]), 1)
        self.assertGreaterEqual(len(workbench["students"]), 1)
        self.assertIn("tasks", workbench)
        student = workbench["students"][0]
        self.assertIn("prescription", student)
        self.assertIn("interventionAction", student)
        self.assertTrue(student["interventionAction"]["href"].startswith("/a3/"))
        self.assertIn("riskReason", student)
        self.assertIsInstance(student["riskReason"], str)
        self.assertTrue(len(student["riskReason"]) > 0)
        self.assertEqual(workbench["resourcePackSummary"]["totalRuns"], 1)
        self.assertEqual(workbench["resourcePackSummary"]["completionRate"], 100)
        self.assertEqual(workbench["resourcePackSummary"]["verifiedSourceCount"], 3)
        self.assertEqual(student["resourcePack"]["totalRuns"], 1)
        self.assertEqual(student["resourcePack"]["latestGoal"], "root locus")

    def test_teacher_workbench_exposes_openmaic_artifact_effects(self):
        generate_learning_path(self.user, self.course)
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:artifact",
            task_title="Artifact resource pack",
            learning_goal="root locus",
            verified_source_count=2,
            confidence="high",
            practice_href="/a3/assessment?practice=root%20locus",
            source="resource_generation",
            payload={
                "resourcePackId": "pack-artifact-001",
                "goal": "root locus",
                "multimodalArtifacts": [
                    {
                        "type": "openmaic_classroom",
                        "jobId": "job-classroom-001",
                        "status": "succeeded",
                        "classroomUrl": "/classroom/classroom-001",
                        "scenesCount": 5,
                        "pptxExportable": True,
                        "provider": "openmaic-generate-classroom",
                    },
                    {
                        "type": "openmaic_video",
                        "status": "failed",
                        "provider": "seedance",
                        "resourceType": "micro_video_script",
                        "videoUrl": "",
                        "degradedReason": "No API key configured for video provider: seedance",
                    },
                    {
                        "type": "openmaic_pptx_export",
                        "jobId": "job-pptx-001",
                        "status": "succeeded",
                        "provider": "openmaic-pptx-export",
                        "classroomId": "classroom-001",
                        "fileName": "root-locus.pptx",
                        "slidesCount": 5,
                    },
                ],
            },
        )

        self.client.force_login(self.teacher)
        response = self.client.get("/api/learning/teacher/workbench/")

        self.assertEqual(response.status_code, 200)
        workbench = response.json()["workbench"]
        summary = workbench["resourcePackSummary"]
        self.assertEqual(summary["artifactCounts"]["classroom"], 1)
        self.assertEqual(summary["artifactCounts"]["classroomSucceeded"], 1)
        self.assertEqual(summary["artifactCounts"]["video"], 1)
        self.assertEqual(summary["artifactCounts"]["videoDegraded"], 1)
        self.assertEqual(summary["artifactCounts"]["pptxExport"], 1)
        self.assertEqual(summary["artifactCounts"]["pptxExportSucceeded"], 1)
        self.assertEqual(summary["latestArtifacts"][0]["type"], "openmaic_classroom")
        student = workbench["students"][0]
        self.assertEqual(student["resourcePack"]["artifactCounts"]["videoDegraded"], 1)
        self.assertEqual(student["resourcePack"]["artifactCounts"]["pptxExportSucceeded"], 1)
        self.assertEqual(student["resourcePack"]["latestArtifacts"][1]["degradedReason"], "No API key configured for video provider: seedance")

    def test_teacher_workbench_reads_openmaic_artifact_effects_from_audit_table(self):
        generate_learning_path(self.user, self.course)
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:audit-artifact",
            task_title="Artifact resource pack",
            learning_goal="frequency response",
            verified_source_count=2,
            confidence="high",
            practice_href="/a3/assessment?practice=frequency%20response",
            source="resource_generation",
            payload={
                "resourcePackId": "pack-audit-artifact-001",
                "goal": "frequency response",
            },
        )
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id="pack-audit-artifact-001",
            artifact_type="openmaic_classroom",
            job_id="job-audit-classroom",
            status="succeeded",
            provider="openmaic-generate-classroom",
            payload={
                "type": "openmaic_classroom",
                "jobId": "job-audit-classroom",
                "status": "succeeded",
                "classroomUrl": "/classroom/audit-classroom",
                "scenesCount": 5,
                "pptxExportable": True,
                "provider": "openmaic-generate-classroom",
                "createdAt": "2999-01-01T00:00:00+00:00",
            },
        )
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id="pack-audit-artifact-001",
            artifact_type="openmaic_video",
            job_id="",
            status="failed",
            provider="seedance",
            payload={
                "type": "openmaic_video",
                "status": "failed",
                "provider": "seedance",
                "resourceType": "micro_video_script",
                "degradedReason": "No API key configured for video provider: seedance",
                "createdAt": "2999-01-02T00:00:00+00:00",
            },
        )
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id="pack-audit-artifact-001",
            artifact_type="openmaic_pptx_export",
            job_id="job-audit-pptx",
            status="succeeded",
            provider="openmaic-pptx-export",
            payload={
                "type": "openmaic_pptx_export",
                "jobId": "job-audit-pptx",
                "status": "succeeded",
                "provider": "openmaic-pptx-export",
                "fileName": "frequency-response.pptx",
                "slidesCount": 6,
                "createdAt": "2999-01-03T00:00:00+00:00",
            },
        )

        self.client.force_login(self.teacher)
        response = self.client.get("/api/learning/teacher/workbench/")

        self.assertEqual(response.status_code, 200)
        summary = response.json()["workbench"]["resourcePackSummary"]
        self.assertEqual(summary["artifactCounts"]["classroomSucceeded"], 1)
        self.assertEqual(summary["artifactCounts"]["videoDegraded"], 1)
        self.assertEqual(summary["artifactCounts"]["pptxExportSucceeded"], 1)
        self.assertEqual(summary["latestArtifacts"][0]["type"], "openmaic_pptx_export")
        self.assertEqual(summary["latestArtifacts"][0]["resourcePackId"], "pack-audit-artifact-001")

    def test_teacher_task_execute_creates_student_notifications(self):
        generate_learning_path(self.user, self.course)
        self.client.force_login(self.teacher)
        response = self.client.post(
            "/api/learning/teacher/tasks/execute/",
            data=json.dumps({"type": "assessment"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertEqual(payload["result"]["createdNotifications"], 1)
        self.assertIn("traceId", payload)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "teacher_task_execute")
        step_names = [step.name for step in run.steps.all()]
        self.assertEqual(step_names, ["TeacherWorkbenchAgent", "NotificationAgent", "StudentFollowupAgent"])
        steps = {step.name: step for step in run.steps.all()}
        workbench_metadata = steps["TeacherWorkbenchAgent"].metadata
        notification_metadata = steps["NotificationAgent"].metadata
        followup_metadata = steps["StudentFollowupAgent"].metadata
        self.assertEqual(workbench_metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")
        self.assertEqual(workbench_metadata["evidence"]["taskType"], "assessment")
        self.assertGreaterEqual(workbench_metadata["evidence"]["studentCount"], 1)
        self.assertIn("riskStudentCount", workbench_metadata["evidence"])
        self.assertEqual(notification_metadata["evidence"]["createdNotifications"], 1)
        self.assertEqual(notification_metadata["evidence"]["writeBackTarget"], "UserNotification")
        self.assertEqual(notification_metadata["quality"]["notificationWritten"], True)
        self.assertEqual(followup_metadata["evidence"]["actionUrl"], "/a3/assessment")
        self.assertEqual(followup_metadata["quality"]["studentCanResume"], True)
        self.assertTrue(UserNotification.objects.filter(user=self.user, action_url="/a3/assessment").exists())

    def test_teacher_resource_pack_reminder_targets_only_unconverted_students(self):
        generate_learning_path(self.user, self.course)
        converted = User.objects.create_user(phone="13800007778", password="TestPassword123")
        LearnerProfile.objects.create(
            user=converted,
            extra_profile={
                "resourcePackRuns": [
                    {
                        "taskId": "resource-pack:root-locus",
                        "learningGoal": "root locus",
                        "verifiedSourceCount": 2,
                        "practiceHref": "/a3/assessment?practice=root%20locus",
                        "completedAt": timezone.now().isoformat(),
                    }
                ]
            },
        )
        generate_learning_path(converted, self.course)
        self.client.force_login(self.teacher)

        response = self.client.post(
            "/api/learning/teacher/tasks/execute/",
            data=json.dumps({"type": "resource_pack_reminder"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        result = response.json()["result"]
        self.assertEqual(result["taskType"], "resource_pack_reminder")
        self.assertEqual(result["createdNotifications"], 1)
        self.assertTrue(
            UserNotification.objects.filter(
                user=self.user,
                action_url="/a3/recommendations",
                payload__taskType="resource_pack_reminder",
            ).exists()
        )
        self.assertFalse(UserNotification.objects.filter(user=converted, payload__taskType="resource_pack_reminder").exists())

    def test_teacher_task_only_targets_assigned_course_students(self):
        outsider = User.objects.create_user(phone="13800007777", password="TestPassword123")
        self.client.force_login(self.teacher)
        generate_learning_path(self.user, self.course)
        response = self.client.post(
            "/api/learning/teacher/tasks/execute/",
            data=json.dumps({"type": "notification"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["result"]["createdNotifications"], 1)
        self.assertTrue(UserNotification.objects.filter(user=self.user).exists())
        self.assertFalse(UserNotification.objects.filter(user=outsider).exists())

    def test_teacher_can_send_targeted_intervention_to_assigned_student(self):
        generate_learning_path(self.user, self.course)
        self.client.force_login(self.teacher)

        response = self.client.post(
            "/api/learning/teacher/tasks/execute/",
            data=json.dumps(
                {
                    "type": "intervention",
                    "studentId": str(self.user.id),
                    "message": "请先完成错题复盘，再进入面对面辅导。",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        result = response.json()["result"]
        self.assertEqual(result["createdNotifications"], 1)
        self.assertEqual(result["targetStudentId"], str(self.user.id))
        notification = UserNotification.objects.get(user=self.user, payload__targetedByTeacher=True)
        self.assertEqual(notification.action_url, "/a3/wrong-notebook")
        self.assertIn("错题复盘", notification.detail)
        self.assertEqual(notification.payload["studentId"], str(self.user.id))

    def test_teacher_cannot_send_targeted_task_to_unassigned_student(self):
        outsider = User.objects.create_user(phone="13800007777", password="TestPassword123")
        generate_learning_path(self.user, self.course)
        self.client.force_login(self.teacher)

        response = self.client.post(
            "/api/learning/teacher/tasks/execute/",
            data=json.dumps(
                {
                    "type": "intervention",
                    "studentId": str(outsider.id),
                    "message": "请处理错题本。",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(UserNotification.objects.filter(user=outsider).exists())

    def test_teacher_without_course_assignment_sees_no_students(self):
        unassigned_teacher = User.objects.create_user(
            phone="13800006666",
            password="TestPassword123",
            role=UserRole.TEACHER,
        )
        generate_learning_path(self.user, self.course)
        self.client.force_login(unassigned_teacher)
        response = self.client.get("/api/learning/teacher/workbench/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["workbench"]["students"], [])

    def test_student_cannot_open_teacher_workbench(self):
        response = self.client.get("/api/learning/teacher/workbench/")
        self.assertEqual(response.status_code, 403)

    def test_student_cannot_execute_teacher_task(self):
        response = self.client.post(
            "/api/learning/teacher/tasks/execute/",
            data=json.dumps({"type": "assessment"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_study_plan_completion_updates_path_progress(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        learn_task = next(task for task in plan["days"][0]["tasks"] if task["type"] == "learn")

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": learn_task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        current.refresh_from_db()
        self.assertGreaterEqual(current.progress, 60)

    def test_study_plan_review_completion_updates_wrong_question(self):
        path = generate_learning_path(self.user, self.course)
        current = path.items.get(status=PathItemStatus.CURRENT)
        question = current.knowledge_point.questions.first()
        wrong = WrongQuestion.objects.create(user=self.user, question=question, wrong_count=2)
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        review_day = next(day for day in plan["days"] if any(task["type"] == "review" for task in day["tasks"]))
        review_task = next(task for task in review_day["tasks"] if task["type"] == "review")

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": review_day["dayIndex"], "taskId": review_task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        wrong.refresh_from_db()
        self.assertEqual(wrong.consecutive_correct, 1)
        self.assertIsNotNone(wrong.review_after)

    def test_admission_diagnostic_updates_profile_and_generates_plan(self):
        response = self.client.post(
            "/api/learning/admission-diagnostic/",
            data=json.dumps(
                {
                    "goal": "期末复习",
                    "dailyMinutes": 45,
                    "durationDays": 7,
                    "answers": [
                        {"questionId": "os-role", "selectedIndex": 0},
                        {"questionId": "process-thread", "selectedIndex": 1},
                        {"questionId": "cpu-scheduling", "selectedIndex": 0},
                        {"questionId": "sync", "selectedIndex": 2},
                        {"questionId": "virtual-memory", "selectedIndex": 0},
                    ],
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["diagnostic"]["score"], 60)
        self.assertEqual(payload["plan"]["durationDays"], 7)
        self.assertGreaterEqual(len(payload["plan"]["days"]), 7)
        self.assertGreaterEqual(len(payload["path"]["items"]), 1)
        evidence = payload["diagnostic"]["loopEvidence"]
        self.assertEqual(evidence["schemaVersion"], "a3.learning-loop-evidence.v1")
        self.assertEqual(evidence["trigger"], "admission_diagnostic")
        self.assertEqual(evidence["subject"]["diagnosticId"], payload["diagnostic"]["diagnosticId"])
        targets = {item["target"]: item for item in evidence["writeBacks"]}
        self.assertEqual(targets["learner_profile"]["status"], "updated")
        self.assertEqual(targets["learning_path"]["status"], "updated")
        self.assertEqual(targets["study_plan"]["status"], "updated")
        self.assertEqual(targets["report"]["status"], "derived")
        self.assertEqual(evidence["nextAction"]["href"], "/a3/today")
        self.assertIn("traceId", payload)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "admission_diagnostic")
        step_names = [step.name for step in run.steps.all()]
        self.assertEqual(step_names, ["DiagnosticAgent", "ProfileUpdateAgent", "PlannerAgent", "StudyPlanAgent"])
        steps = {step.name: step for step in run.steps.all()}
        diagnostic_metadata = steps["DiagnosticAgent"].metadata
        profile_metadata = steps["ProfileUpdateAgent"].metadata
        planner_metadata = steps["PlannerAgent"].metadata
        plan_metadata = steps["StudyPlanAgent"].metadata
        self.assertEqual(diagnostic_metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")
        self.assertEqual(diagnostic_metadata["evidence"]["questionCount"], 5)
        self.assertEqual(diagnostic_metadata["evidence"]["correctCount"], 3)
        self.assertEqual(diagnostic_metadata["evidence"]["weakPointCount"], 2)
        self.assertEqual(diagnostic_metadata["quality"]["levelAssigned"], True)
        self.assertEqual(profile_metadata["evidence"]["updateSource"], "admission_diagnostic")
        self.assertGreaterEqual(profile_metadata["evidence"]["weakPointCount"], 2)
        self.assertEqual(planner_metadata["evidence"]["plannerInput"], "diagnostic_profile")
        self.assertGreaterEqual(planner_metadata["evidence"]["pathItemCount"], 1)
        self.assertEqual(plan_metadata["evidence"]["plannerInput"], "diagnostic_path_and_profile")
        self.assertEqual(plan_metadata["evidence"]["dayCount"], 7)
        self.user.learner_profile.refresh_from_db()
        self.assertEqual(self.user.learner_profile.daily_study_time, 45)
        self.assertIn("同步互斥与信号量", self.user.learner_profile.weak_points)

    def test_admission_diagnostic_blueprint_uses_profile_to_order_questions(self):
        profile = self.user.learner_profile
        profile.foundation_level = "薄弱"
        profile.daily_study_time = 30
        profile.learning_goals = ["补齐虚拟内存和同步互斥"]
        profile.weak_points = ["虚拟内存与页面置换", "同步互斥与信号量"]
        profile.learning_preferences = ["图解流程", "练习题库"]
        profile.save(
            update_fields=[
                "foundation_level",
                "daily_study_time",
                "learning_goals",
                "weak_points",
                "learning_preferences",
                "updated_at",
            ]
        )

        response = self.client.get("/api/learning/admission-diagnostic/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["questions"][0]["id"], "virtual-memory")
        self.assertEqual(payload["questions"][0]["difficulty"], "foundation")
        self.assertIn("虚拟内存与页面置换", payload["questions"][0]["profileSignals"])
        self.assertIn("画像薄弱点", payload["questions"][0]["reason"])
        blueprint = payload["diagnosticBlueprint"]
        self.assertEqual(blueprint["schemaVersion"], "a3.admission-diagnostic-blueprint.v1")
        self.assertEqual(blueprint["agent"], "DiagnosticAgent")
        self.assertEqual(blueprint["degraded"], False)
        self.assertEqual(blueprint["profileInputs"]["foundationLevel"], "薄弱")
        self.assertIn("虚拟内存与页面置换", blueprint["profileInputs"]["weakPoints"])
        self.assertEqual(blueprint["selectionPolicy"]["primaryRule"], "profile_weak_points_first")

    def test_study_plan_get_rebuilds_legacy_course_content(self):
        generate_learning_path(self.user, self.course, force=True)
        profile = self.user.learner_profile
        profile.extra_profile = {
            "studyPlan": {
                "planId": "legacy-plan",
                "title": "自动控制原理 14 天学习计划",
                "course": {"id": str(self.course.id), "title": "操作系统"},
                "durationDays": 14,
                "dailyMinutes": 60,
                "days": [
                    {
                        "dayIndex": 1,
                        "date": timezone.localdate().isoformat(),
                        "title": "Day 1 · 旧课程",
                        "focus": "根轨迹基本规则",
                        "estimatedMinutes": 30,
                        "status": "today",
                        "progress": 0,
                        "tasks": [
                            {
                                "id": "legacy-task",
                                "type": "learn",
                                "title": "学习：根轨迹基本规则",
                                "subtitle": "旧自动控制内容",
                                "href": "/a3/classroom",
                                "estimatedMinutes": 30,
                                "status": "pending",
                            }
                        ],
                    }
                ],
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.get("/api/learning/study-plan/")

        self.assertEqual(response.status_code, 200)
        plan = response.json()["plan"]
        plan_text = json.dumps(plan, ensure_ascii=False)
        self.assertEqual(plan["course"]["title"], "操作系统")
        self.assertIn("操作系统", plan["title"])
        self.assertNotIn("根轨迹", plan_text)
        self.assertNotIn("自动控制", plan_text)
        self.assertIn("planContext", plan)
