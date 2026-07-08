from .common import *
from backend.apps.learning.models import CoachingMessage, CoachingMessageRole, CoachingSession
from backend.apps.knowledge_base.models import KnowledgeAsset, KnowledgeBlock, KnowledgeIndexEntry, KnowledgePage


class CompatApiTests(CompatApiTestCase):
    def test_demo_status_exposes_realtime_coaching_metrics(self):
        session = CoachingSession.objects.create(
            user=self.user,
            topic_title="实时根轨迹辅导",
            metadata={
                "latency": {"averageMs": 920},
                "fallback": {"count": 1},
            },
        )
        CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="根轨迹渐近线怎么算？")
        CoachingMessage.objects.create(
            session=session,
            role=CoachingMessageRole.ASSISTANT,
            content="先判断极点和零点数量差。",
            verified=True,
            citations=[{"title": "根轨迹课件", "previewUrl": "/api/kb/assets/a1/preview/"}],
            metadata={
                "realtime": {"provider": "dashscope_qwen_omni_realtime"},
                "visualEvidence": {"source": "screen"},
            },
        )

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        metrics = response.json()["realtimeCoaching"]
        self.assertEqual(metrics["schemaVersion"], "a3.realtime-coaching-metrics.v1")
        self.assertTrue(metrics["available"])
        self.assertEqual(metrics["sessionCount"], 1)
        self.assertEqual(metrics["latestProvider"], "dashscope_qwen_omni_realtime")
        self.assertEqual(metrics["averageLatencyMs"], 920)
        self.assertEqual(metrics["visualFrameCount"], 1)
        self.assertEqual(metrics["verifiedAnswerRate"], 1.0)
        self.assertEqual(metrics["fallbackCount"], 1)

    def test_demo_status_handles_list_learning_preferences(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        profile.grade = "大二"
        profile.major_direction = "自动化专业"
        profile.foundation_level = "基础一般"
        profile.daily_study_time = 60
        profile.learning_goals = ["掌握自动控制原理"]
        profile.weak_points = ["根轨迹"]
        profile.expected_resources = ["课件讲义"]
        profile.learning_preferences = ["例题推导", "动画演示"]
        profile.extra_profile = {"profileInterviewSession": {"turnCount": 1, "messages": []}}
        profile.save()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("profileInterview", payload)

    def test_demo_status_returns_capability_matrix(self):
        cache.clear()
        with tempfile.TemporaryDirectory() as tmp_dir:
            backend_root = Path(tmp_dir)
            metrics_path = backend_root / "tmp" / "demo_retrieval_metrics.json"
            metrics_path.parent.mkdir(parents=True, exist_ok=True)
            metrics_path.write_text(
                json.dumps(
                    {
                        "topK": 3,
                        "metrics": {
                            "retrievalTop1HitRate": 85.0,
                            "retrievalTop3HitRate": 95.0,
                            "verifiedCoverage": 92.0,
                            "safetyRefusalRate": 100.0,
                            "missingEvidenceRefusalRate": 100.0,
                        },
                        "cases": [{"id": "case-1"}, {"id": "case-2"}],
                    }
                ),
                encoding="utf-8",
            )
            agent_metrics_path = backend_root / "tmp" / "agent_workflow_metrics.json"
            agent_metrics_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "a3.agent-workflow-eval.v1",
                        "overallStatus": "pass",
                        "metrics": {
                            "workflowCount": 12,
                            "contractCoverage": 100,
                            "traceCoverage": 100,
                            "evidenceSchemaCoverage": 100,
                            "apiEntryCoverage": 100,
                            "readyCoverage": 100,
                        },
                        "workflows": [
                            {
                                "workflow": "recommend",
                                "status": "ready",
                                "latestTraceId": "trace-agent-eval",
                            },
                            {
                                "workflow": "resource_feedback",
                                "status": "ready",
                                "latestTraceId": "trace-resource-feedback",
                            }
                        ],
                        "generatedTraceIds": ["trace-agent-eval", "trace-resource-feedback"],
                    }
                ),
                encoding="utf-8",
            )
            with patch("backend.apps.compat.views.BACKEND_ROOT", backend_root):
                response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("summary", payload)
        self.assertIn("apis", payload)
        self.assertIn("evaluation", payload)
        self.assertIn("metrics", payload["evaluation"])
        metrics = payload["evaluation"]["metrics"]
        self.assertTrue(metrics["available"])
        self.assertEqual(metrics["path"], "backend/tmp/demo_retrieval_metrics.json")
        self.assertEqual(metrics["caseCount"], 2)
        self.assertEqual(metrics["topK"], 3)
        self.assertIn("updatedAt", metrics)
        self.assertIn("missingEvidenceCases", payload["evaluation"])
        self.assertIn("productReadiness", payload)
        self.assertIn("checks", payload["productReadiness"])
        self.assertGreaterEqual(payload["productReadiness"]["total"], 8)
        self.assertIn("agentWorkflowMetrics", payload)
        agent_metrics = payload["agentWorkflowMetrics"]
        self.assertTrue(agent_metrics["available"])
        self.assertEqual(agent_metrics["path"], "backend/tmp/agent_workflow_metrics.json")
        self.assertEqual(agent_metrics["schemaVersion"], "a3.agent-workflow-eval.v1")
        self.assertEqual(agent_metrics["overallStatus"], "pass")
        self.assertEqual(agent_metrics["workflowCount"], 12)
        self.assertEqual(agent_metrics["readyCoverage"], 100)
        self.assertEqual(agent_metrics["generatedTraceCount"], 2)
        self.assertIn("trace-resource-feedback", agent_metrics["latestTraceIds"])
        evidence_keys = {item["key"] for item in payload["evidenceBoard"]}
        self.assertIn("evaluate_agent_workflows", evidence_keys)
        agent_evidence = next(item for item in payload["evidenceBoard"] if item["key"] == "evaluate_agent_workflows")
        self.assertEqual(agent_evidence["detail"], "Agent workflows: 12; readyCoverage: 100%; evidenceSchemaCoverage: 100%.")
        self.assertNotIn("\ufffd", agent_evidence["detail"])
        paths = {item["path"] for item in payload["apis"]}
        self.assertIn("/api/verify/answer/", paths)
        self.assertIn("/api/auth/token/", paths)
        self.assertIn("/api/demo/agent-runs/<traceId>/", paths)
        self.assertIn("/api/demo/agent-runs/<traceId>/export/", paths)
        self.assertIn("/api/demo/validate/", paths)
        self.assertIn("/api/demo/evaluate/", paths)
        self.assertIn("/api/learning/teacher/workbench/", paths)
        self.assertIn("/api/learning/teacher/tasks/execute/", paths)
        groups = {item["group"] for item in payload["apis"]}
        self.assertIn("认证", groups)
        self.assertIn("教师", groups)
        readiness_titles = {item["title"] for item in payload["productReadiness"]["checks"]}
        self.assertIn("学习画像", readiness_titles)
        self.assertIn("每日学习计划", readiness_titles)


    def test_demo_status_exposes_multimodal_rag_metrics_and_visual_index_status(self):
        cache.clear()
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="root-locus-slide.png",
            file_type="png",
            stored_path="data/test/root-locus-slide.png",
            status="indexed",
        )
        page = KnowledgePage.objects.create(resource=resource, page_number=1, width=640, height=480)
        asset = KnowledgeAsset.objects.create(
            resource=resource,
            page=page,
            kind="rendered_slide",
            mime_type="image/png",
            storage_path="data/test/root-locus-slide.png",
        )
        block = KnowledgeBlock.objects.create(
            resource=resource,
            page=page,
            asset=asset,
            modality="slide_image",
            text="root locus diagram",
        )
        KnowledgeIndexEntry.objects.create(
            block=block,
            index_type="visual_vector",
            index_backend="sentence-transformers:clip-ViT-B-32",
            external_id=str(block.id),
            status="indexed",
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            backend_root = Path(tmp_dir)
            metrics_path = backend_root / "tmp" / "multimodal_rag_metrics.json"
            metrics_path.parent.mkdir(parents=True, exist_ok=True)
            metrics_path.write_text(
                json.dumps(
                    {
                        "topK": 3,
                        "metrics": {
                            "resources": 4,
                            "visualIndexedEntries": 1,
                            "parseSuccessRate": 0.75,
                            "hybridReadyRate": 0.5,
                        },
                    }
                ),
                encoding="utf-8",
            )
            with patch("backend.apps.compat.views.BACKEND_ROOT", backend_root):
                response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        multimodal = response.json()["multimodalRag"]
        self.assertTrue(multimodal["metrics"]["available"])
        self.assertEqual(multimodal["metrics"]["path"], "backend/tmp/multimodal_rag_metrics.json")
        self.assertEqual(multimodal["metrics"]["topK"], 3)
        self.assertEqual(multimodal["metrics"]["visualIndexedEntries"], 1)
        self.assertEqual(multimodal["visualIndex"]["indexedEntries"], 1)
        self.assertEqual(multimodal["visualIndex"]["latestStatus"], "indexed")
        self.assertEqual(multimodal["visualIndex"]["backend"], "sentence-transformers:clip-ViT-B-32")

    def test_demo_status_reuses_short_lived_snapshot_for_expensive_derivations(self):
        from backend.apps.compat import views as compat_views

        cache.clear()
        with (
            patch.object(compat_views, "build_recommendation_payload", wraps=compat_views.build_recommendation_payload) as recommendation_mock,
            patch.object(compat_views, "classroom_context", wraps=compat_views.classroom_context) as classroom_mock,
            patch.object(compat_views, "verify_answer", wraps=compat_views.verify_answer) as verify_mock,
            patch.object(compat_views, "build_learning_report", wraps=compat_views.build_learning_report) as report_mock,
        ):
            first = self.client.get("/api/demo/status/")
            second = self.client.get("/api/demo/status/")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertTrue(first.json()["success"])
        self.assertTrue(second.json()["success"])
        self.assertEqual(recommendation_mock.call_count, 1)
        self.assertEqual(classroom_mock.call_count, 1)
        self.assertEqual(verify_mock.call_count, 2)
        self.assertEqual(report_mock.call_count, 1)


    def test_demo_status_exposes_resource_pack_conversion_metrics(self):
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:root-locus",
            task_title="Root locus resource pack",
            learning_goal="root locus",
            verified_source_count=3,
            confidence="high",
            practice_href="/a3/assessment?practice=root%20locus",
            source="study_plan_completion",
            next_step_reason="Practice immediately.",
        )

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("resourcePackMetrics", payload)
        metrics = payload["resourcePackMetrics"]
        self.assertEqual(metrics["schemaVersion"], "a3.resource-pack-metrics.v1")
        self.assertEqual(metrics["totalRuns"], 1)
        self.assertEqual(metrics["conversionRate"], 100)
        self.assertEqual(metrics["verifiedSourceCount"], 3)
        self.assertEqual(metrics["practiceStartedCount"], 1)
        self.assertEqual(metrics["latestGoal"], "root locus")
        self.assertEqual(metrics["nextAction"]["href"], "/a3/assessment?practice=root%20locus")

    def test_demo_status_exposes_openmaic_classroom_artifact_metrics(self):
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:root-locus",
            task_title="Root locus resource pack",
            learning_goal="root locus",
            verified_source_count=3,
            confidence="high",
            practice_href="/a3/assessment?practice=root%20locus",
            source="resource_generation",
            payload={
                "resourcePackId": "pack-openmaic-001",
                "goal": "root locus",
                "multimodalArtifacts": [
                    {
                        "type": "openmaic_classroom",
                        "jobId": "job-openmaic-001",
                        "status": "succeeded",
                        "classroomId": "classroom-001",
                        "classroomUrl": "/classroom/classroom-001",
                        "scenesCount": 5,
                        "pptxExportable": True,
                        "provider": "openmaic-generate-classroom",
                        "elapsedMs": 1234,
                    }
                ],
            },
        )

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        metrics = response.json()["resourcePackMetrics"]
        artifact = metrics["openmaicClassroom"]
        self.assertEqual(artifact["status"], "succeeded")
        self.assertEqual(artifact["jobId"], "job-openmaic-001")
        self.assertEqual(artifact["classroomUrl"], "/classroom/classroom-001")
        self.assertEqual(artifact["scenesCount"], 5)
        self.assertTrue(artifact["pptxExportable"])

    def test_demo_status_exposes_openmaic_video_artifact_metrics(self):
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:video",
            task_title="Video resource pack",
            learning_goal="root locus",
            verified_source_count=2,
            confidence="medium",
            source="resource_generation",
            payload={
                "resourcePackId": "pack-video-001",
                "goal": "root locus",
                "multimodalArtifacts": [
                    {
                        "type": "openmaic_video",
                        "status": "failed",
                        "provider": "seedance",
                        "resourceType": "micro_video_script",
                        "videoUrl": "",
                        "duration": 0,
                        "width": 0,
                        "height": 0,
                        "elapsedMs": 320,
                        "degradedReason": "video provider 未配置",
                    }
                ],
            },
        )

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        metrics = response.json()["resourcePackMetrics"]
        artifact = metrics["openmaicVideo"]
        self.assertEqual(artifact["status"], "failed")
        self.assertEqual(artifact["provider"], "seedance")
        self.assertEqual(artifact["resourceType"], "micro_video_script")
        self.assertEqual(artifact["degradedReason"], "video provider 未配置")

    def test_demo_status_exposes_openmaic_artifact_audit_table_metrics(self):
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id="pack-audit-001",
            artifact_type="openmaic_classroom",
            job_id="job-audit-classroom",
            status="succeeded",
            provider="openmaic-generate-classroom",
            payload={
                "type": "openmaic_classroom",
                "jobId": "job-audit-classroom",
                "status": "succeeded",
                "classroomId": "classroom-audit",
                "classroomUrl": "/classroom/classroom-audit",
                "scenesCount": 5,
                "pptxExportable": True,
                "provider": "openmaic-generate-classroom",
                "createdAt": "2999-01-01T00:00:00+00:00",
            },
        )
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id="pack-audit-001",
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
            resource_pack_id="pack-audit-001",
            artifact_type="openmaic_pptx_export",
            job_id="job-audit-pptx",
            status="succeeded",
            provider="openmaic-pptx-export",
            payload={
                "type": "openmaic_pptx_export",
                "jobId": "job-audit-pptx",
                "status": "succeeded",
                "provider": "openmaic-pptx-export",
                "fileName": "audit.pptx",
                "slidesCount": 5,
                "createdAt": "2999-01-03T00:00:00+00:00",
            },
        )

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        metrics = response.json()["resourcePackMetrics"]
        audit = metrics["artifactAudit"]
        self.assertEqual(audit["schemaVersion"], "a3.openmaic-artifact-audit.v1")
        self.assertEqual(audit["total"], 3)
        self.assertEqual(audit["classroom"], 1)
        self.assertEqual(audit["classroomSucceeded"], 1)
        self.assertEqual(audit["video"], 1)
        self.assertEqual(audit["videoDegraded"], 1)
        self.assertEqual(audit["pptxExport"], 1)
        self.assertEqual(audit["pptxExportSucceeded"], 1)
        self.assertEqual(audit["latestArtifacts"][0]["type"], "openmaic_pptx_export")
        self.assertEqual(metrics["openmaicClassroom"]["jobId"], "job-audit-classroom")
        self.assertEqual(metrics["openmaicVideo"]["provider"], "seedance")

    def test_demo_status_exposes_profile_interview_evidence(self):
        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "I am an automation sophomore with average foundation and 40 minutes daily"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        interview_payload = response.json()

        status_response = self.client.get("/api/demo/status/")

        self.assertEqual(status_response.status_code, 200)
        payload = status_response.json()
        self.assertIn("profileInterview", payload)
        evidence = payload["profileInterview"]
        self.assertEqual(evidence["schemaVersion"], "a3.profile-interview-session.v1")
        self.assertEqual(evidence["latestTraceId"], interview_payload["traceId"])
        self.assertGreaterEqual(evidence["turnCount"], 1)
        self.assertEqual([item["field"] for item in evidence["askFields"]], ["learningGoals", "weakPoints"])
        self.assertEqual(evidence["askStrategy"]["name"], "plan_critical_priority")
        self.assertEqual(evidence["status"], "collecting")

    def test_demo_status_exposes_committed_profile_interview_outcome(self):
        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps(
                {
                    "message": (
                        "I am an automation sophomore. My control theory foundation is average, "
                        "I can study 40 minutes daily, I want postgraduate entrance exam preparation, "
                        "my weak points are root locus and frequency response, and I prefer animation, examples, and engineering cases."
                    )
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        confirm_response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"action": "confirm"}),
            content_type="application/json",
        )
        self.assertEqual(confirm_response.status_code, 200)

        status_response = self.client.get("/api/demo/status/")

        self.assertEqual(status_response.status_code, 200)
        evidence = status_response.json()["profileInterview"]
        self.assertEqual(evidence["status"], "complete")
        self.assertTrue(evidence["profileCommitted"])
        self.assertTrue(evidence["pathAndPlanRefreshed"])
        self.assertTrue(evidence["generated"]["path"])
        self.assertTrue(evidence["generated"]["studyPlan"])
        self.assertIn("画像已确认", evidence["detail"])


    def test_demo_status_market_readiness_scores_resource_pack_conversion(self):
        ResourcePackLog.objects.create(
            user=self.user,
            task_id="resource-pack:root-locus",
            task_title="Root locus resource pack",
            learning_goal="root locus",
            verified_source_count=2,
            confidence="high",
            practice_href="/a3/assessment?practice=root%20locus",
            source="study_plan_completion",
            next_step_reason="Practice immediately.",
        )

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        conversion = next(item for item in payload["marketReadiness"] if item["key"] == "resourcePackConversion")
        self.assertEqual(conversion["status"], "ready")
        self.assertEqual(conversion["score"], 100)
        self.assertIn("1/1", conversion["evidence"])
        self.assertEqual(conversion["nextAction"]["href"], "/a3/recommendations")


    def test_demo_status_returns_enterprise_agent_trace_schema(self):
        run = RuntimeAgentRun(self.user, "verify_answer", "楠岃瘉璇惧爞鍥炵瓟")
        run.step("SafetyAgent", "瀹夊叏杩囨护", "璇嗗埆璇锋眰鏄惁鍚堣", metadata={"safe": True})
        run.step("VerifierAgent", "寮曠敤楠岃瘉", "妫€鏌ョ煡璇嗗簱璇佹嵁", metadata={"verified": True})
        run.complete()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        trace = payload["agentRuns"][0]
        self.assertEqual(trace["traceId"], run.trace_id)
        self.assertEqual(trace["schemaVersion"], "a3.agent-run.v1")
        self.assertEqual(trace["fallbackStrategy"], "none")
        self.assertEqual(trace["workflow"], "verify_answer")
        self.assertEqual(trace["status"], "completed")
        self.assertEqual(trace["detailUrl"], f"/api/demo/agent-runs/{run.trace_id}/")
        self.assertEqual(trace["exportJsonUrl"], f"/api/demo/agent-runs/{run.trace_id}/export/?format=json")
        self.assertEqual(trace["exportMarkdownUrl"], f"/api/demo/agent-runs/{run.trace_id}/export/?format=markdown")
        self.assertGreaterEqual(trace["latencyMs"], 1)
        self.assertEqual(len(trace["steps"]), 2)
        self.assertEqual(trace["steps"][0]["name"], "SafetyAgent")
        self.assertEqual(trace["steps"][0]["order"], 1)
        self.assertEqual(trace["steps"][1]["name"], "VerifierAgent")
        self.assertEqual(trace["steps"][1]["order"], 2)


    def test_demo_status_returns_lightweight_agent_trace_summary(self):
        run = RuntimeAgentRun(self.user, "qa_interact", "status summary payload")
        run.step(
            "RetrieverAgent",
            "knowledge retrieval",
            "retrieved sources",
            metadata={"runtimePolicy": {"maxRetries": 1, "timeoutMs": 3000, "attempts": 1, "errors": [], "timedOut": False}},
            input_summary={"query": "root locus"},
            output_summary={"sources": 3},
            state_diff={"sources": 3},
            evidence={"snippets": ["large evidence block"]},
            quality={"verified": True},
        )
        run.complete()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        trace = response.json()["agentRuns"][0]
        metadata = trace["steps"][0]["metadata"]
        self.assertEqual(trace["traceId"], run.trace_id)
        self.assertEqual(metadata["runtimePolicy"]["timeoutMs"], 3000)
        self.assertNotIn("inputSummary", metadata)
        self.assertNotIn("outputSummary", metadata)
        self.assertNotIn("stateDiff", metadata)
        self.assertNotIn("evidence", metadata)
        self.assertNotIn("quality", metadata)


    def test_demo_agent_run_detail_returns_owned_trace(self):
        run = RuntimeAgentRun(self.user, "recommend", "audit personalized recommendation")
        run.step(
            "RetrieverAgent",
            "knowledge retrieval",
            "retrieved path-aligned resources",
            metadata={
                "runtimePolicy": {"maxRetries": 1, "timeoutMs": 3000, "attempts": 1},
                "quality": {"citations": 2, "verified": True},
                "debugPrompt": "raw prompt must not be exposed",
            },
        )
        run.complete()

        response = self.client.get(f"/api/demo/agent-runs/{run.trace_id}/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["trace"]["traceId"], run.trace_id)
        self.assertEqual(payload["trace"]["workflow"], "recommend")
        self.assertEqual(payload["trace"]["status"], "completed")
        self.assertEqual(payload["trace"]["owner"]["id"], self.user.id)
        self.assertEqual(payload["trace"]["access"]["viewerRole"], self.user.role)
        self.assertEqual(payload["trace"]["steps"][0]["name"], "RetrieverAgent")
        self.assertEqual(payload["trace"]["steps"][0]["metadata"]["runtimePolicy"]["timeoutMs"], 3000)
        self.assertEqual(payload["trace"]["steps"][0]["metadata"]["quality"]["verified"], True)
        self.assertNotIn("debugPrompt", payload["trace"]["steps"][0]["metadata"])


    def test_demo_agent_run_detail_hides_other_student_trace(self):
        other_user = User.objects.create_user(phone="13800139901", password="secure-pass-123")
        run = RuntimeAgentRun(other_user, "qa_interact", "private tutoring trace")
        run.step("TeacherAgent", "grounded tutoring", "generated answer")
        run.complete()

        response = self.client.get(f"/api/demo/agent-runs/{run.trace_id}/")

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.json()["success"])


    def test_demo_agent_run_detail_allows_teacher_to_view_student_trace(self):
        teacher = User.objects.create_user(phone="13800139902", password="secure-pass-123", role="teacher")
        run = RuntimeAgentRun(self.user, "verify_answer", "teacher audit trace")
        run.step("VerifierAgent", "citation verification", "checked cited evidence", metadata={"verified": True})
        run.complete()

        self.client.force_login(teacher)
        response = self.client.get(f"/api/demo/agent-runs/{run.trace_id}/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["trace"]["traceId"], run.trace_id)
        self.assertEqual(payload["trace"]["owner"]["id"], self.user.id)
        self.assertEqual(payload["trace"]["access"]["viewerRole"], "teacher")


    def test_demo_agent_run_export_returns_sanitized_json_trace(self):
        run = RuntimeAgentRun(self.user, "qa_interact", "export tutoring trace")
        run.step(
            "TeacherAgent",
            "grounded tutoring",
            "generated answer with evidence",
            metadata={
                "quality": {"verified": True},
                "rawPrompt": "private prompt must not be exported",
            },
        )
        run.complete()

        response = self.client.get(f"/api/demo/agent-runs/{run.trace_id}/export/?format=json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertIn(f"agent-trace-{run.trace_id}.json", response["Content-Disposition"])
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["trace"]["traceId"], run.trace_id)
        self.assertEqual(payload["export"]["format"], "json")
        self.assertEqual(payload["trace"]["steps"][0]["metadata"]["quality"]["verified"], True)
        self.assertNotIn("rawPrompt", payload["trace"]["steps"][0]["metadata"])


    def test_demo_agent_run_export_returns_markdown_evidence(self):
        run = RuntimeAgentRun(self.user, "verify_answer", "export verification trace")
        run.step(
            "VerifierAgent",
            "citation verification",
            "checked cited evidence",
            metadata={
                "runtimePolicy": {"maxRetries": 1, "timeoutMs": 3000, "attempts": 1, "errors": [], "timedOut": False},
                "quality": {"verified": True, "claimSupportRate": 1.0},
                "evidence": {"citations": 2, "sourceTitles": ["root-locus.pdf"]},
                "safety": {"safe": True, "category": "education"},
                "contract": {"schemaVersion": "a3.verify-answer.v1", "satisfied": True},
            },
        )
        run.complete()

        response = self.client.get(f"/api/demo/agent-runs/{run.trace_id}/export/?format=markdown")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/markdown; charset=utf-8")
        self.assertIn(f"agent-trace-{run.trace_id}.md", response["Content-Disposition"])
        content = response.content.decode("utf-8")
        self.assertIn("# Agent Trace Audit", content)
        self.assertIn("## Executive Summary", content)
        self.assertIn("## Runtime Governance", content)
        self.assertIn("## Evidence And Verification", content)
        self.assertIn("## Safety And Contract", content)
        self.assertIn("- Verified evidence steps: `1`", content)
        self.assertIn("- Safety gated steps: `1`", content)
        self.assertIn("- Contract checked steps: `1`", content)
        self.assertIn(f"Trace ID: `{run.trace_id}`", content)
        self.assertIn("| 1 | VerifierAgent | citation verification | completed |", content)
        self.assertIn("| VerifierAgent | 1 | 3000ms | no |", content)
        self.assertIn("root-locus.pdf", content)
        self.assertIn("a3.verify-answer.v1", content)
        self.assertNotIn("rawPrompt", content)


    def test_demo_agent_run_export_hides_other_student_trace(self):
        other_user = User.objects.create_user(phone="13800139903", password="secure-pass-123")
        run = RuntimeAgentRun(other_user, "recommend", "private export trace")
        run.step("RetrieverAgent", "retrieval", "retrieved resources")
        run.complete()

        response = self.client.get(f"/api/demo/agent-runs/{run.trace_id}/export/?format=json")

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.json()["success"])


    def test_demo_status_exposes_agent_runtime_policy_summary(self):
        completed = RuntimeAgentRun(self.user, "recommend", "runtime policy summary")
        completed.step(
            "RetrieverAgent",
            "retrieval",
            "retrieve learning resources",
            metadata={
                "runtimePolicy": {
                    "maxRetries": 1,
                    "timeoutMs": 3000,
                    "attempts": 2,
                    "errors": ["temporary outage"],
                    "timedOut": False,
                    "elapsedMs": 12,
                }
            },
        )
        completed.complete()
        failed = RuntimeAgentRun(self.user, "recommend", "contract violation summary")
        failed.fallback_strategy = "contract_violation"
        failed.step(
            "ContractAgent",
            "workflow contract",
            "Workflow recommend contract violation",
            status="failed",
            metadata={"quality": {"contractSatisfied": False}},
        )
        failed.status = "failed"
        failed.persist()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        runtime = response.json()["agentRuntime"]
        self.assertGreaterEqual(runtime["recentRuns"], 2)
        self.assertGreaterEqual(runtime["failedRuns"], 1)
        self.assertGreaterEqual(runtime["contractViolations"], 1)
        self.assertGreaterEqual(runtime["retryPolicies"], 1)
        self.assertGreaterEqual(runtime["retryAttempts"], 1)
        self.assertIn("contract_violation", runtime["fallbackStrategies"])


    def test_demo_status_exposes_agent_runtime_budget_breaches(self):
        slow = RuntimeAgentRun(self.user, "recommend", "slow retrieval summary")
        slow.step(
            "RetrieverAgent",
            "retrieval",
            "retrieval is close to budget",
            metadata={
                "runtimePolicy": {
                    "maxRetries": 1,
                    "timeoutMs": 1000,
                    "attempts": 1,
                    "errors": [],
                    "timedOut": False,
                    "elapsedMs": 850,
                }
            },
        )
        slow.complete()
        timed_out = RuntimeAgentRun(self.user, "qa_interact", "timeout tutoring summary")
        timed_out.step(
            "TeacherAgent",
            "grounded tutoring",
            "teacher model exceeded budget",
            status="failed",
            metadata={
                "runtimePolicy": {
                    "maxRetries": 1,
                    "timeoutMs": 1000,
                    "attempts": 2,
                    "errors": ["timeout"],
                    "timedOut": True,
                    "elapsedMs": 1300,
                }
            },
        )
        timed_out.status = "failed"
        timed_out.persist()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        runtime = response.json()["agentRuntime"]
        self.assertGreaterEqual(runtime["budgetBreaches"], 1)
        self.assertIn("slowSteps", runtime)
        slow_step = next(item for item in runtime["slowSteps"] if item["agent"] == "RetrieverAgent")
        self.assertEqual(slow_step["workflow"], "recommend")
        self.assertEqual(slow_step["elapsedMs"], 850)
        timeout_step = next(item for item in runtime["slowSteps"] if item["agent"] == "TeacherAgent")
        self.assertEqual(timeout_step["status"], "timeout")


    def test_demo_status_exposes_agent_failure_rates_and_circuit_breakers(self):
        for index in range(3):
            failed = RuntimeAgentRun(self.user, "qa_interact", f"failed tutoring run {index}")
            failed.fallback_strategy = "fallback_result"
            failed.step(
                "TeacherAgent",
                "grounded tutoring",
                "teacher model unavailable",
                status="failed",
                metadata={"runtimePolicy": {"attempts": 2, "errors": ["model timeout"], "timedOut": True}},
            )
            failed.status = "failed"
            failed.persist()

        completed = RuntimeAgentRun(self.user, "qa_interact", "completed tutoring run")
        completed.step("TeacherAgent", "grounded tutoring", "draft answer")
        completed.complete()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        runtime = response.json()["agentRuntime"]
        self.assertIn("failureRates", runtime)
        self.assertIn("circuitBreakers", runtime)
        qa_rate = next(item for item in runtime["failureRates"] if item["workflow"] == "qa_interact")
        self.assertEqual(qa_rate["runs"], 4)
        self.assertEqual(qa_rate["failedRuns"], 3)
        self.assertEqual(qa_rate["failureRate"], 0.75)
        breaker = next(item for item in runtime["circuitBreakers"] if item["workflow"] == "qa_interact")
        self.assertEqual(breaker["status"], "open")
        self.assertEqual(breaker["reason"], "failure_rate")


    def test_demo_status_exposes_step_level_agent_failure_rates(self):
        for index in range(2):
            failed = RuntimeAgentRun(self.user, "qa_interact", f"failed teacher step {index}")
            failed.step("RetrieverAgent", "retrieval", "retrieved sources", status="completed")
            failed.step("TeacherAgent", "grounded tutoring", "teacher model timeout", status="failed")
            failed.status = "failed"
            failed.persist()

        completed = RuntimeAgentRun(self.user, "qa_interact", "completed teacher step")
        completed.step("RetrieverAgent", "retrieval", "retrieved sources", status="completed")
        completed.step("TeacherAgent", "grounded tutoring", "draft answer", status="completed")
        completed.complete()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        runtime = response.json()["agentRuntime"]
        self.assertIn("agentFailureRates", runtime)
        teacher_rate = next(
            item
            for item in runtime["agentFailureRates"]
            if item["workflow"] == "qa_interact" and item["agent"] == "TeacherAgent"
        )
        self.assertEqual(teacher_rate["steps"], 3)
        self.assertEqual(teacher_rate["failedSteps"], 2)
        self.assertEqual(teacher_rate["failureRate"], 0.667)
        retriever_rate = next(
            item
            for item in runtime["agentFailureRates"]
            if item["workflow"] == "qa_interact" and item["agent"] == "RetrieverAgent"
        )
        self.assertEqual(retriever_rate["failureRate"], 0.0)
        breaker = next(
            item
            for item in runtime["circuitBreakers"]
            if item.get("agent") == "TeacherAgent"
        )
        self.assertEqual(breaker["status"], "open")
        self.assertEqual(breaker["reason"], "agent_failure_rate")


    def test_demo_status_exposes_agent_workflow_readiness(self):
        run = RuntimeAgentRun(self.user, "recommend", "personalized recommendation")
        run.step("RetrievalAgent", "retrieval", "retrieve learning resources")
        run.complete()

        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("agentWorkflows", payload)
        workflow = next(item for item in payload["agentWorkflows"] if item["workflow"] == "recommend")
        self.assertFalse(workflow["ready"])
        self.assertEqual(
            workflow["missingRequiredSteps"],
            ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
        )
        self.assertEqual(workflow["unknownSteps"], ["RetrievalAgent"])
        self.assertEqual(workflow["latestTraceId"], run.trace_id)


    @patch("backend.apps.compat.views.call_command")
    def test_demo_validate_runs_validation_command(self, call):
        def fake_validate(*args, **kwargs):
            kwargs["stdout"].write(json.dumps({"overallStatus": "pass", "checks": []}))
            if "--report-output" in args:
                output_path = Path(args[args.index("--report-output") + 1])
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text("# A3 婕旂ず楠屾敹鎶ュ憡\n\n婕旂ず瀛︾敓璐﹀彿鍙敤\n", encoding="utf-8")

        call.side_effect = fake_validate

        with tempfile.TemporaryDirectory() as tmp_dir:
            report_path = Path(tmp_dir) / "demo_validation_report.md"
            with override_settings(A3_DEMO_REPORT_PATH=str(report_path)):
                response = self.client.post("/api/demo/validate/", data="{}", content_type="application/json")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["validation"]["overallStatus"], "pass")
        self.assertEqual(payload["reportPath"], "backend/tmp/demo_validation_report.md")
        self.assertIn("A3 婕旂ず楠屾敹鎶ュ憡", payload["reportMarkdown"])


    def test_demo_report_returns_latest_markdown(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            report_path = Path(tmp_dir) / "demo_validation_report.md"
            report_path.write_text("# A3 涓存椂楠屾敹鎶ュ憡\n\n娴嬭瘯闅旂璺緞鍞竴鍐呭\n", encoding="utf-8")

            with override_settings(A3_DEMO_REPORT_PATH=str(report_path)):
                response = self.client.get("/api/demo/report/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["reportPath"], "backend/tmp/demo_validation_report.md")
        self.assertIn("娴嬭瘯闅旂璺緞鍞竴鍐呭", payload["reportMarkdown"])


    @patch("backend.apps.compat.views.call_command")
    def test_demo_evaluate_runs_evaluation_command(self, call):
        call.side_effect = lambda *args, **kwargs: kwargs["stdout"].write(json.dumps({
            "metrics": {"retrievalTop3HitRate": 100.0},
            "cases": [],
        }))

        response = self.client.post("/api/demo/evaluate/", data=json.dumps({"topK": 3}), content_type="application/json")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["evaluation"]["metrics"]["retrievalTop3HitRate"], 100.0)


    @patch("backend.apps.compat.views.call_command")
    def test_demo_evaluate_can_refresh_agent_workflow_metrics(self, call):
        def fake_call(command_name, *args, **kwargs):
            if command_name == "evaluate_demo_retrieval":
                kwargs["stdout"].write(json.dumps({
                    "metrics": {"retrievalTop3HitRate": 100.0},
                    "cases": [],
                }))
                return
            if command_name == "evaluate_agent_workflows":
                kwargs["stdout"].write(json.dumps({
                    "schemaVersion": "a3.agent-workflow-eval.v1",
                    "overallStatus": "pass",
                    "metrics": {"workflowCount": 8, "readyCoverage": 100},
                    "workflows": [],
                    "generatedTraceIds": ["trace-1"],
                }))
                return
            raise AssertionError(f"Unexpected command: {command_name}")

        call.side_effect = fake_call

        response = self.client.post(
            "/api/demo/evaluate/",
            data=json.dumps({"topK": 3, "includeAgentWorkflows": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["agentWorkflowEvaluation"]["overallStatus"], "pass")
        self.assertEqual(payload["agentWorkflowEvaluation"]["metrics"]["workflowCount"], 8)
        called_commands = [item.args[0] for item in call.call_args_list]
        self.assertEqual(called_commands, ["evaluate_demo_retrieval", "evaluate_agent_workflows"])
        agent_call_args = call.call_args_list[1].args
        self.assertIn("--generate-demo-traces", agent_call_args)
        self.assertIn("--output", agent_call_args)
