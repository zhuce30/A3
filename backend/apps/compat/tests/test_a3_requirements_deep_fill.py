from datetime import timedelta

from backend.apps.compat.models import ResourceGenerationJob

from .common import *


class A3RequirementsDeepFillTests(CompatApiTestCase):
    @patch("celery.current_app.send_task")
    def test_resource_generation_job_create_api_dispatches_celery_task(self, send_task):
        send_task.return_value.id = "celery-resource-generation-001"

        response = self.client.post(
            "/api/resources/jobs/",
            data=json.dumps(
                {
                    "jobId": "job-resource-generation-celery-001",
                    "workflow": "resource_generate",
                    "goal": "生成操作系统思维导图",
                    "topK": 3,
                    "resourceType": "mind_map",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        send_task.assert_called_once_with(
            "compat.run_resource_generation_job",
            args=["job-resource-generation-celery-001"],
            queue="resource-generation",
        )
        job = ResourceGenerationJob.objects.get(job_id="job-resource-generation-celery-001")
        self.assertEqual(job.metadata["celeryTaskId"], "celery-resource-generation-001")
        self.assertEqual(job.metadata["executionBackend"], "celery")

    @patch("celery.current_app.send_task")
    def test_resource_generation_job_create_api_persists_job(self, send_task):
        send_task.return_value.id = "celery-resource-generation-persist-001"
        long_goal = (
            "给我生成一套操作系统死锁学习资源，要求讲解清楚易懂；"
            "表格使用标准 Markdown 表格，公式和矩阵排版完整；"
            "每一节都要有小结，最后附知识点速记表和考试高频考点；"
        ) * 8
        response = self.client.post(
            "/api/resources/jobs/",
            data=json.dumps(
                {
                    "jobId": "job-resource-generation-api-001",
                    "workflow": "resource_generate",
                    "status": "queued",
                    "progress": 0,
                    "stage": "queued",
                    "message": "已创建资源包生成任务",
                    "goal": long_goal,
                    "topK": 3,
                    "resourceType": "lecture_doc",
                    "metadata": {"createdBy": "test"},
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["job"]["jobId"], "job-resource-generation-api-001")
        self.assertEqual(payload["job"]["resourceType"], "lecture_doc")
        self.assertEqual(payload["job"]["goal"], long_goal)

    @override_settings(RESOURCE_GENERATION_JOB_STALE_MINUTES=15)
    def test_resource_generation_jobs_api_marks_only_stale_running_jobs_failed(self):
        stale_job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-stale-001",
            user=self.user,
            status="running",
            progress=45,
            stage="synthesis",
            message="正在生成资源内容",
        )
        active_job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-active-001",
            user=self.user,
            status="running",
            progress=45,
            stage="synthesis",
            message="正在生成资源内容",
        )
        celery_job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-celery-active-001",
            user=self.user,
            status="queued",
            progress=0,
            stage="queued",
            message="等待 Celery 执行",
            metadata={"executionBackend": "celery", "celeryTaskId": "celery-active-001"},
        )
        stale_at = timezone.now() - timedelta(minutes=30)
        ResourceGenerationJob.objects.filter(id=stale_job.id).update(updated_at=stale_at)
        ResourceGenerationJob.objects.filter(id=celery_job.id).update(updated_at=stale_at)

        response = self.client.get("/api/resources/jobs/")

        self.assertEqual(response.status_code, 200)
        jobs = {item["jobId"]: item for item in response.json()["jobs"]}
        self.assertEqual(jobs[stale_job.job_id]["status"], "failed")
        self.assertEqual(jobs[stale_job.job_id]["stage"], "interrupted")
        self.assertEqual(jobs[stale_job.job_id]["progress"], 100)
        self.assertTrue(jobs[stale_job.job_id]["done"])
        self.assertIn("网络中断", jobs[stale_job.job_id]["error"])
        self.assertEqual(jobs[active_job.job_id]["status"], "running")
        self.assertEqual(jobs[celery_job.job_id]["status"], "queued")
        stale_job.refresh_from_db()
        self.assertIsNotNone(stale_job.finished_at)

    @patch("celery.current_app.control.revoke")
    def test_resource_generation_owner_can_cancel_queued_job(self, revoke):
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-owner-cancel",
            user=self.user,
            status="queued",
            progress=0,
            stage="queued",
            message="等待 Celery 执行",
            metadata={"executionBackend": "celery", "celeryTaskId": "owner-resource-task-id"},
        )

        response = self.client.post(
            f"/api/resources/jobs/{job.job_id}/cancel/",
            data=json.dumps({"reason": "不再需要该资源"}, ensure_ascii=False),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        job.refresh_from_db()
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.stage, "cancelled")
        self.assertEqual(job.progress, 100)
        self.assertIsNotNone(job.finished_at)
        revoke.assert_called_once_with("owner-resource-task-id", terminate=True)

    @patch("celery.current_app.control.revoke")
    def test_resource_generation_owner_can_cancel_legacy_job_without_celery_id(self, revoke):
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-owner-cancel-no-task-id",
            user=self.user,
            status="queued",
            stage="queued",
            metadata={"executionBackend": "celery"},
        )

        response = self.client.post(
            f"/api/resources/jobs/{job.job_id}/cancel/",
            data=json.dumps({"reason": "清理旧排队任务"}, ensure_ascii=False),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        job.refresh_from_db()
        self.assertEqual(job.status, "cancelled")
        self.assertFalse(response.json()["job"]["canCancel"])
        revoke.assert_not_called()

    def test_resource_generation_cancel_enforces_owner_and_terminal_state(self):
        other_user = User.objects.create_user(phone="13800139901", password="secure-pass-123")
        other_job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-other-owner",
            user=other_user,
            status="queued",
        )
        completed_job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-completed",
            user=self.user,
            status="succeeded",
            stage="completed",
            progress=100,
        )

        forbidden = self.client.post(
            f"/api/resources/jobs/{other_job.job_id}/cancel/",
            data="{}",
            content_type="application/json",
        )
        conflict = self.client.post(
            f"/api/resources/jobs/{completed_job.job_id}/cancel/",
            data="{}",
            content_type="application/json",
        )

        self.assertEqual(forbidden.status_code, 404)
        self.assertEqual(conflict.status_code, 409)
        other_job.refresh_from_db()
        completed_job.refresh_from_db()
        self.assertEqual(other_job.status, "queued")
        self.assertEqual(completed_job.status, "succeeded")

    @patch("celery.current_app.control.revoke")
    def test_resource_generation_cancel_is_idempotent(self, revoke):
        job = ResourceGenerationJob.objects.create(
            job_id="job-resource-generation-cancel-idempotent",
            user=self.user,
            status="cancelled",
            stage="cancelled",
            progress=100,
        )

        response = self.client.post(
            f"/api/resources/jobs/{job.job_id}/cancel/",
            data="{}",
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["job"]["status"], "cancelled")
        revoke.assert_not_called()

    def test_resource_generation_uses_dedicated_worker_queue(self):
        compose = Path("docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("--queues=resource-generation", compose)

    def test_resource_generation_has_single_kernel_entrypoint(self):
        source = Path("backend/apps/compat/resource_generation.py").read_text(encoding="utf-8")

        self.assertEqual(source.count("def generate_resource_pack_v2("), 1)
        self.assertIn("run_resource_generate_workflow", source)

    def test_profile_interview_prefers_llm_structured_extraction_and_records_provider(self):
        llm_payload = {
            "grade": "大三",
            "major_direction": "智能控制与机器人",
            "foundation_level": "基础较弱",
            "daily_study_time": 75,
            "pace": "intensive",
            "learning_goals": ["补齐现代控制基础", "准备课程项目"],
            "weak_points": ["状态空间", "稳定性"],
            "expected_resources": ["工程案例", "错题复盘"],
            "learning_preferences": {
                "cognitiveStyle": "先看结构图再做例题",
                "preferredFormats": ["工程案例", "错题复盘"],
            },
            "motivationRisk": "项目截止时间近，存在拖延风险",
            "learningHistory": "学过自动控制原理但状态空间掌握不稳",
            "mistakePatterns": ["符号方向混淆", "状态变量选取不稳定"],
        }
        with patch("backend.apps.compat.profile_interview._llm_extract_profile_dimensions") as chat:
            chat.return_value = {**llm_payload, "_llm": {"provider": "dashscope", "model": "qwen-plus", "fallback": False}}

            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": "我项目快截止了，状态空间和稳定性总错，希望用工程案例复习。"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertEqual(payload["profile"]["schemaVersion"], "a3.profile-interview.profile.v2")
        self.assertEqual(payload["profile"]["grade"], "大三")
        self.assertEqual(payload["profile"]["majorDirection"], "智能控制与机器人")
        self.assertIn("状态空间", payload["profile"]["weakPoints"])
        self.assertEqual(payload["profile"]["cognitiveStyle"], "先看结构图再做例题")
        self.assertEqual(payload["profile"]["learningHistory"], "学过自动控制原理但状态空间掌握不稳")
        refreshed = LearnerProfile.objects.get(user=self.user)
        dynamic_profile = refreshed.extra_profile["dynamicProfile"]
        self.assertEqual(dynamic_profile["schemaVersion"], "a3.dynamic-learner-profile.v1")
        self.assertEqual(dynamic_profile["llm"]["provider"], "dashscope")
        self.assertIn("符号方向混淆", dynamic_profile["mistakePatterns"])
        snapshot = refreshed.extra_profile["profileSnapshot"]
        self.assertEqual(snapshot["dimensions"]["cognitiveStyle"]["value"], "先看结构图再做例题")
        self.assertEqual(snapshot["dimensions"]["learningHistory"]["value"], "学过自动控制原理但状态空间掌握不稳")
        self.assertEqual(snapshot["dimensions"]["motivationRisk"]["value"], "项目截止时间近，存在拖延风险")
        self.assertIn("符号方向混淆", snapshot["dimensions"]["mistakePatterns"]["value"])

    def test_profile_interview_records_stable_dynamic_profile_schema(self):
        with patch("backend.apps.compat.profile_interview._llm_extract_profile_dimensions") as extract:
            extract.return_value = {
                "grade": "大二",
                "major_direction": "自动化",
                "foundation_level": "基础一般",
                "daily_study_time": 40,
                "learning_goals": ["考研复习"],
                "weak_points": ["根轨迹"],
                "expected_resources": ["工程案例"],
                "learning_preferences": {"cognitiveStyle": "图解与例题驱动"},
                "motivationRisk": "普通",
                "learningHistory": "学过自动控制原理",
                "mistakePatterns": ["概念迁移慢"],
                "_llm": {"provider": "dashscope", "model": "qwen-plus", "fallback": False},
            }
            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({
                    "message": "我是自动化大二，控制理论基础一般，想考研，每天40分钟，喜欢动画、例题和工程案例，根轨迹和频率响应比较弱。"
                }),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        refreshed = LearnerProfile.objects.get(user=self.user)
        dynamic_profile = refreshed.extra_profile.get("dynamicProfile")
        self.assertIsInstance(dynamic_profile, dict)
        for key in (
            "schemaVersion",
            "cognitiveStyle",
            "learningHistory",
            "mistakePatterns",
            "motivationRisk",
            "resourcePreferenceEvidence",
            "learningEventsSummary",
            "recentEvents",
            "dimensionCoverage",
            "updatedAt",
        ):
            self.assertIn(key, dynamic_profile)
        self.assertEqual(dynamic_profile["schemaVersion"], "a3.dynamic-learner-profile.v1")
        self.assertTrue(dynamic_profile["resourcePreferenceEvidence"])
        self.assertGreaterEqual(dynamic_profile["dimensionCoverage"]["ready"], 8)
        self.assertTrue(dynamic_profile["recentEvents"])

    def test_profile_interview_persists_six_dimensions_from_llm_extractor(self):
        with patch("backend.apps.compat.profile_interview._llm_extract_profile_dimensions") as extract:
            extract.return_value = {
                "grade": "大二",
                "major_direction": "软件工程",
                "daily_study_time": 40,
                "learning_goals": ["独立完成操作系统课程项目"],
                "expected_resources": ["视频讲解", "例题推导"],
                "learningHistory": "学过程序设计和数据结构",
                "_llm": {"provider": "dashscope", "model": "qwen-plus", "fallback": False},
            }

            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({
                    "message": "我是软件工程大二学生，学过程序设计和数据结构，想独立完成操作系统课程项目。每天能学40分钟，希望先看视频和例题。"
                }),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        profile = payload["profile"]
        self.assertGreaterEqual(payload["profileReadiness"]["dimensionCount"], 6)
        self.assertEqual(profile["grade"], "大二")
        self.assertEqual(profile["majorDirection"], "软件工程")
        self.assertEqual(profile["dailyMinutes"], 40)
        self.assertEqual(profile["learningGoals"], ["独立完成操作系统课程项目"])
        self.assertEqual(profile["learningHistory"], "学过程序设计和数据结构")
        self.assertEqual(profile["resourcePreferences"], ["视频讲解", "例题推导"])
        self.assertFalse(payload["generated"]["path"])
        self.assertFalse(payload["generated"]["studyPlan"])
        self.assertTrue(payload["planningDeferred"])
        self.assertEqual(payload["planningDeferredReason"], "awaiting_admission_diagnostic")
        self.assertTrue(payload["interviewSession"]["planningDeferred"])
        self.assertEqual(
            payload["interviewSession"]["planningDeferredReason"],
            "awaiting_admission_diagnostic",
        )
        self.assertFalse(LearningPath.objects.filter(user=self.user, status="active").exists())
        refreshed = LearnerProfile.objects.get(user=self.user)
        self.assertFalse(refreshed.extra_profile.get("studyPlan"))
        persisted_session = refreshed.extra_profile["profileInterviewSession"]
        self.assertTrue(persisted_session["planningDeferred"])
        self.assertEqual(persisted_session["planningDeferredReason"], "awaiting_admission_diagnostic")

    def test_profile_interview_rule_fallback_extracts_mistake_patterns(self):
        with patch("backend.apps.compat.profile_interview._llm_extract_profile_dimensions") as extract:
            extract.side_effect = ValueError("llm unavailable")
            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({
                    "message": "automation sophomore, control theory average, I confuse signs and formulas, weak at root locus, prefer examples, 40 minutes daily"
                }),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        refreshed = LearnerProfile.objects.get(user=self.user)
        dynamic_profile = refreshed.extra_profile["dynamicProfile"]
        self.assertIn("符号方向混淆", dynamic_profile["mistakePatterns"])
        self.assertIn("公式套用不稳", dynamic_profile["mistakePatterns"])

    def test_profile_interview_rule_fallback_accepts_short_motivation_follow_up(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        profile.grade = "大二"
        profile.major_direction = "计算机科学与技术"
        profile.foundation_level = "基础一般"
        profile.daily_study_time = 45
        profile.learning_goals = ["掌握操作系统核心知识"]
        profile.weak_points = ["虚拟内存"]
        profile.expected_resources = ["代码实验"]
        profile.learning_preferences = {"cognitiveStyle": "结合案例理解"}
        profile.extra_profile = {
            **dict(profile.extra_profile or {}),
            "learningHistory": "学过程序设计和数据结构",
            "motivationRisk": "",
        }
        profile.save()

        with patch(
            "backend.apps.compat.profile_interview._llm_extract_profile_dimensions",
            side_effect=RuntimeError("force deterministic rule fallback"),
        ):
            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": "遇到的困难是对基础知识的深入掌握"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        missing_fields = {item["field"] for item in payload["missingDimensions"]}
        self.assertEqual(payload["profile"]["motivationRisk"], "对基础知识的深入掌握")
        self.assertNotIn("motivationRisk", missing_fields)
        self.assertNotEqual(payload["nextQuestion"], "最近坚持学习时最容易遇到什么困难？")

    def test_learning_events_collect_profile_assessment_and_diagnostic_updates(self):
        self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "我是自动化大二，基础一般，每天40分钟，根轨迹薄弱，喜欢例题。"}),
            content_type="application/json",
        )
        course = Course.objects.create(code="EVENT-CONTROL", title="事件课程", is_active=True)
        chapter = Chapter.objects.create(course=course, order=1, title="事件章节")
        point = KnowledgePoint.objects.create(chapter=chapter, code="EVENT-KP", title="稳定性", order=1)
        option_rows = [
            {"key": "A", "text": "稳定"},
            {"key": "B", "text": "不稳定"},
            {"key": "C", "text": "临界稳定"},
            {"key": "D", "text": "无法判断"},
        ]
        question = Question.objects.create(
            knowledge_point=point,
            stem="稳定性判定",
            options=option_rows,
            correct_answer="A",
            explanation="看特征根",
            error_cause="忽略极点位置",
        )
        question_2 = Question.objects.create(
            knowledge_point=point,
            stem="稳定裕度判定",
            options=option_rows,
            correct_answer="A",
            explanation="看裕度",
            error_cause="混淆裕度定义",
        )
        question_3 = Question.objects.create(
            knowledge_point=point,
            stem="极点位置判定",
            options=option_rows,
            correct_answer="A",
            explanation="看左半平面",
            error_cause="忽略极点位置",
        )
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id), str(question_2.id), str(question_3.id)])

        assessment_response = self.client.post(
            f"/api/assessments/sessions/{session.id}/answer/",
            data=json.dumps({"questionId": str(question.id), "selectedAnswer": "B"}),
            content_type="application/json",
        )
        self.assertEqual(assessment_response.status_code, 200, assessment_response.content)
        self.client.post(
            "/api/learning/admission-diagnostic/",
            data=json.dumps({
                "goal": "补齐控制基础",
                "durationDays": 14,
                "dailyMinutes": 40,
                "answers": [],
            }),
            content_type="application/json",
        )

        refreshed = LearnerProfile.objects.get(user=self.user)
        events = refreshed.extra_profile.get("learningEvents")
        event_types = [item.get("eventType") for item in events]
        self.assertIn("profile_interview", event_types)
        self.assertIn("assessment_wrong_answer", event_types)
        self.assertIn("admission_diagnostic", event_types)
        dynamic_profile = refreshed.extra_profile["dynamicProfile"]
        self.assertGreaterEqual(dynamic_profile["learningEventsSummary"]["total"], 3)
        self.assertIn("忽略极点位置", dynamic_profile["mistakePatterns"])

    def test_profile_interview_extracts_eight_dimensions_and_persists_event(self):
        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({
                "message": "我是自动化大二，控制理论基础一般，想考研，每天40分钟，喜欢动画、例题和工程案例，根轨迹和频率响应比较弱。"
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("traceId", payload)
        profile = payload["profile"]
        for key in (
            "grade",
            "majorDirection",
            "foundationLevel",
            "dailyMinutes",
            "learningGoals",
            "weakPoints",
            "resourcePreferences",
            "motivationRisk",
        ):
            self.assertIn(key, profile)
        self.assertGreaterEqual(payload["profileReadiness"]["dimensionCount"], 8)
        self.assertIn("根轨迹", profile["weakPoints"])
        refreshed = LearnerProfile.objects.get(user=self.user)
        self.assertTrue(refreshed.extra_profile.get("learningEvents"))
        signals = refreshed.extra_profile.get("profileSignals")
        self.assertTrue(any(item.get("source") == "profile_interview" for item in signals))
        self.assertTrue(any(item.get("dimension") == "weakPoints" for item in signals))
        snapshot = refreshed.extra_profile.get("profileSnapshot")
        self.assertIsInstance(snapshot, dict)
        self.assertEqual(snapshot.get("schemaVersion"), "a3.profile-snapshot.v1")

    def test_profile_interview_persists_session_state_across_turns(self):
        first_response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "automation sophomore, control theory average, preparing for graduate exam"}),
            content_type="application/json",
        )
        second_response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "I can study 40 minutes daily and prefer animation, examples, and engineering cases"}),
            content_type="application/json",
        )

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        second_payload = second_response.json()
        refreshed = LearnerProfile.objects.get(user=self.user)
        session = refreshed.extra_profile.get("profileInterviewSession")
        self.assertIsNotNone(session)
        self.assertEqual(session["schemaVersion"], "a3.profile-interview-session.v1")
        self.assertGreaterEqual(session["turnCount"], 2)
        self.assertEqual(session["latestTraceId"], second_payload["traceId"])
        self.assertIn("missingDimensions", session)
        self.assertIn("nextQuestion", session)
        self.assertIn("interviewComplete", session)
        self.assertGreaterEqual(len(session["messages"]), 2)
        self.assertEqual(second_payload["interviewSession"]["turnCount"], session["turnCount"])

    def test_profile_interview_sparse_turns_preserve_and_extend_previous_answers(self):
        messages = (
            "我正在学习操作系统，基础一般，目标是补齐核心概念并能完成课程练习。每天大约40分钟，喜欢图解、例题、实验和错题复盘。",
            "我目前大三，想要在考研中对操作系统取得更好的成绩。",
            "薄弱点是一些概念基础知识，资源偏好是希望通过视频和代码案例来加深理解。",
        )

        with patch(
            "backend.apps.compat.profile_interview._llm_extract_profile_dimensions",
            side_effect=RuntimeError("force deterministic rule fallback"),
        ):
            payloads = []
            for message in messages:
                response = self.client.post(
                    "/api/profile/interview/",
                    data=json.dumps({"message": message}),
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 200, response.content)
                payloads.append(response.json())

        second_profile = payloads[1]["profile"]
        final_payload = payloads[2]
        final_profile = final_payload["profile"]
        final_missing = {
            item["field"] for item in final_payload["missingDimensions"]
        }

        self.assertEqual(second_profile["dailyMinutes"], 40)
        self.assertIn("掌握操作系统", second_profile["learningGoals"])
        self.assertIn("考研复习", second_profile["learningGoals"])
        self.assertIn("图解流程", second_profile["resourcePreferences"])
        self.assertIn("基础概念与知识边界", final_profile["weakPoints"])
        self.assertIn("视频讲解", final_profile["resourcePreferences"])
        self.assertIn("代码案例", final_profile["resourcePreferences"])
        self.assertNotIn("weakPoints", final_missing)
        self.assertNotIn("resourcePreferences", final_missing)
        self.assertEqual(final_payload["interviewSession"]["turnCount"], 3)
        self.assertEqual(
            final_payload["profileReadiness"]["dimensionCount"],
            10 - len(final_payload["missingDimensions"]),
        )

        refreshed = LearnerProfile.objects.get(user=self.user)
        preferred_formats = refreshed.learning_preferences.get("preferredFormats", [])
        self.assertIn("图解流程", preferred_formats)
        self.assertIn("视频讲解", preferred_formats)

    def test_profile_interview_rule_fallback_keeps_explicit_progressive_cognitive_style(self):
        message = (
            "我正在学习操作系统，我还没怎么学，学的一般，每天就学习30分钟，"
            "薄弱点在概念上不太清楚，资源偏好是一些优质课程导学。"
            "我认知风格上偏向于由浅入深认知，专业方向我是软件工程专业。"
        )

        with patch(
            "backend.apps.compat.profile_interview._llm_extract_profile_dimensions",
            side_effect=RuntimeError("force deterministic rule fallback"),
        ):
            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": message}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        missing_fields = {item["field"] for item in payload["missingDimensions"]}
        self.assertEqual(payload["profile"]["majorDirection"], "软件工程")
        self.assertEqual(payload["profile"]["cognitiveStyle"], "由浅入深")
        self.assertIn("课程导学", payload["profile"]["resourcePreferences"])
        self.assertNotIn("majorDirection", missing_fields)
        self.assertNotIn("cognitiveStyle", missing_fields)
        self.assertNotIn("resourcePreferences", missing_fields)
        self.assertNotIn("认知风格", payload["nextQuestion"])

    def test_profile_interview_llm_receives_persisted_profile_and_recent_turns(self):
        first_message = "我正在学习操作系统，基础一般，每天40分钟，喜欢图解和例题。"
        with patch(
            "backend.apps.compat.profile_interview._llm_extract_profile_dimensions",
            side_effect=RuntimeError("use rules for first turn"),
        ):
            first_response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": first_message}),
                content_type="application/json",
            )
        self.assertEqual(first_response.status_code, 200, first_response.content)

        with patch("backend.apps.compat.profile_interview.chat_completion") as chat:
            chat.return_value = {
                "content": "{}",
                "provider": "dashscope",
                "model": "qwen-plus",
                "fallback": False,
            }
            second_response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": "目标还是刚才说的课程，准备考研。"}),
                content_type="application/json",
            )

        self.assertEqual(second_response.status_code, 200, second_response.content)
        llm_messages = chat.call_args.args[0]
        context_payload = json.loads(llm_messages[-1]["content"])
        self.assertEqual(context_payload["currentProfile"]["dailyMinutes"], 40)
        self.assertEqual(context_payload["currentMessage"], "目标还是刚才说的课程，准备考研。")
        self.assertTrue(
            any(
                item.get("role") == "user" and item.get("content") == first_message
                for item in context_payload["recentConversation"]
            )
        )

    def test_profile_interview_session_api_restores_agent_follow_up(self):
        interview_response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "automation sophomore, weak at root locus, prefer examples"}),
            content_type="application/json",
        )

        self.assertEqual(interview_response.status_code, 200)
        session_response = self.client.get("/api/profile/interview/session/")

        self.assertEqual(session_response.status_code, 200)
        payload = session_response.json()
        self.assertTrue(payload["success"])
        session = payload["interviewSession"]
        self.assertEqual(session["schemaVersion"], "a3.profile-interview-session.v1")
        self.assertEqual(session["latestTraceId"], interview_response.json()["traceId"])
        self.assertGreaterEqual(len(session["messages"]), 2)
        self.assertTrue(any(item.get("role") == "user" for item in session["messages"]))
        self.assertTrue(any(item.get("role") == "agent" for item in session["messages"]))
        self.assertEqual(session["messages"][-1]["content"], session["nextQuestion"])
        self.assertTrue(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "awaiting_admission_diagnostic")

    def test_profile_interview_empty_session_defaults_to_deferred_planning(self):
        response = self.client.get("/api/profile/interview/session/")

        self.assertEqual(response.status_code, 200)
        session = response.json()["interviewSession"]
        self.assertEqual(session["turnCount"], 0)
        self.assertTrue(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "awaiting_admission_diagnostic")

    def test_profile_interview_uses_latest_student_turn_when_legacy_dialogue_is_posted(self):
        legacy_dialogue = "\n".join([
            "学生：我是自动化大二，控制理论基础一般，想考研，每天40分钟。",
            "画像访谈Agent：请补充你喜欢的资源形式和薄弱知识点。",
            "学生：最新补充：我喜欢工程案例，根轨迹和频率响应比较薄弱。",
        ])

        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": legacy_dialogue}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        session = response.json()["interviewSession"]
        latest_user_messages = [item for item in session["messages"] if item.get("role") == "user"]
        self.assertTrue(latest_user_messages)
        self.assertEqual(latest_user_messages[-1]["content"], "最新补充：我喜欢工程案例，根轨迹和频率响应比较薄弱。")
        self.assertNotIn("画像访谈Agent", latest_user_messages[-1]["content"])

    def test_profile_interview_session_api_cleans_legacy_replayed_dialogue_messages(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        legacy_dialogue = "\n".join([
            "学生：第一轮输入。",
            "画像访谈Agent：继续追问。",
            "学生：最新补充：我每天 40 分钟，喜欢动画和工程案例。",
        ])
        profile.extra_profile = {
            "profileInterviewSession": {
                "schemaVersion": "a3.profile-interview-session.v1",
                "turnCount": 1,
                "legacyMarker": "preserved",
                "messages": [
                    {"role": "user", "content": legacy_dialogue},
                    {"role": "agent", "content": "画像信息已经比较完整。"},
                ],
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.get("/api/profile/interview/session/")

        self.assertEqual(response.status_code, 200)
        session = response.json()["interviewSession"]
        messages = session["messages"]
        self.assertEqual(messages[0]["content"], "最新补充：我每天 40 分钟，喜欢动画和工程案例。")
        self.assertNotIn("画像访谈Agent", messages[0]["content"])
        self.assertEqual(session["legacyMarker"], "preserved")
        self.assertTrue(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "awaiting_admission_diagnostic")

    def test_profile_interview_session_api_preserves_legacy_generated_evidence(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        historical_generated = {
            "path": {"id": "legacy-path-001", "title": "历史学习路径"},
            "studyPlan": {"durationDays": 14, "status": "active"},
        }
        profile.extra_profile = {
            "profileInterviewSession": {
                "schemaVersion": "a3.profile-interview-session.v1",
                "turnCount": 2,
                "generated": historical_generated,
                "messages": [],
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.get("/api/profile/interview/session/")

        self.assertEqual(response.status_code, 200)
        session = response.json()["interviewSession"]
        self.assertEqual(session["generated"], historical_generated)
        self.assertFalse(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "")

    def test_profile_interview_message_preserves_legacy_generated_evidence(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        historical_generated = {
            "path": {"id": "legacy-path-001", "title": "Legacy learning path"},
            "studyPlan": {"durationDays": 14, "status": "active"},
        }
        profile.extra_profile = {
            "profileInterviewSession": {
                "schemaVersion": "a3.profile-interview-session.v1",
                "turnCount": 2,
                "profileCommitted": True,
                "generated": historical_generated,
                "planningDeferred": False,
                "planningDeferredReason": "",
                "legacyMarker": "preserved",
                "messages": [],
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        with patch(
            "backend.apps.compat.profile_interview._llm_extract_profile_dimensions",
            side_effect=RuntimeError("force deterministic rule fallback"),
        ):
            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": "I prefer examples and can study 40 minutes daily"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        session = payload["interviewSession"]
        self.assertEqual(payload["generated"], historical_generated)
        self.assertEqual(session["generated"], historical_generated)
        self.assertFalse(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "")
        self.assertTrue(session["profileCommitted"])
        self.assertEqual(session["legacyMarker"], "preserved")

    def test_profile_interview_confirm_preserves_legacy_generated_evidence(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        historical_generated = {
            "path": {"id": "legacy-path-001", "title": "Legacy learning path"},
            "studyPlan": {"durationDays": 14, "status": "active"},
        }
        profile.grade = "sophomore"
        profile.major_direction = "automation"
        profile.foundation_level = "average"
        profile.daily_study_time = 40
        profile.learning_goals = ["prepare for graduate study"]
        profile.weak_points = ["root locus"]
        profile.expected_resources = ["worked examples"]
        profile.learning_preferences = {"cognitiveStyle": "examples first"}
        profile.extra_profile = {
            "learningHistory": "studied introductory control theory",
            "motivationRisk": "limited time on weekdays",
            "profileInterviewSession": {
                "schemaVersion": "a3.profile-interview-session.v1",
                "turnCount": 2,
                "profileCommitted": True,
                "generated": historical_generated,
                "planningDeferred": False,
                "planningDeferredReason": "",
                "legacyMarker": "preserved",
                "messages": [],
            },
        }
        profile.save()

        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"action": "confirm"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        session = payload["interviewSession"]
        self.assertEqual(payload["generated"], historical_generated)
        self.assertEqual(session["generated"], historical_generated)
        self.assertFalse(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "")
        self.assertTrue(session["profileCommitted"])
        self.assertEqual(session["legacyMarker"], "preserved")

    def test_profile_interview_session_api_preserves_explicit_legacy_planning_state(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        profile.extra_profile = {
            "profileInterviewSession": {
                "schemaVersion": "a3.profile-interview-session.v1",
                "turnCount": 1,
                "generated": {"path": False, "studyPlan": False},
                "planningDeferred": False,
                "planningDeferredReason": "legacy_manual_state",
                "messages": [],
            }
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.get("/api/profile/interview/session/")

        self.assertEqual(response.status_code, 200)
        session = response.json()["interviewSession"]
        self.assertFalse(session["planningDeferred"])
        self.assertEqual(session["planningDeferredReason"], "legacy_manual_state")

    def test_profile_interview_focuses_follow_up_on_one_missing_dimension(self):
        with patch(
            "backend.apps.compat.profile_interview._llm_extract_profile_dimensions",
            side_effect=RuntimeError("force deterministic rule fallback"),
        ):
            response = self.client.post(
                "/api/profile/interview/",
                data=json.dumps({"message": "prefer examples and can study 40 minutes daily"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        missing = payload["missingDimensions"]
        ask_fields = payload["askFields"]
        session = payload["interviewSession"]
        self.assertGreaterEqual(len(missing), 1)
        self.assertEqual(len(ask_fields), 1)
        self.assertTrue(all(item in missing for item in ask_fields))
        self.assertEqual(session["askFields"], ask_fields)
        self.assertEqual(ask_fields[0]["field"], "weakPoints")
        self.assertTrue(payload["nextQuestion"])
        self.assertIn("卡住", payload["nextQuestion"])

    def test_profile_interview_prioritizes_plan_critical_missing_dimensions(self):
        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "I am an automation sophomore with average foundation and 40 minutes daily"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        ask_field_names = [item["field"] for item in payload["askFields"]]
        self.assertEqual(ask_field_names, ["learningGoals"])
        strategy = payload["interviewSession"]["askStrategy"]
        self.assertEqual(strategy["name"], "plan_critical_priority")
        self.assertEqual(strategy["priorityOrder"][:3], ["learningGoals", "weakPoints", "dailyMinutes"])
        self.assertTrue(strategy["reason"])
        self.assertIn("入学诊断", strategy["reason"])
        self.assertEqual(payload["askFields"][0]["field"], "learningGoals")
        self.assertTrue(payload["nextQuestion"])
        self.assertIn("最想", payload["nextQuestion"])

    def test_profile_interview_confirm_requires_complete_profile(self):
        self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "prefer examples and can study 40 minutes daily"}),
            content_type="application/json",
        )

        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"action": "confirm"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertIn("missingDimensions", payload)
        self.assertGreaterEqual(len(payload["missingDimensions"]), 1)
        self.assertEqual(payload["generated"], {"path": False, "studyPlan": False})
        self.assertEqual(payload["interviewSession"]["generated"], payload["generated"])
        self.assertTrue(payload["planningDeferred"])
        self.assertEqual(payload["planningDeferredReason"], "awaiting_admission_diagnostic")

    def test_profile_interview_confirm_commits_profile_and_defers_plan_until_diagnostic(self):
        interview_response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({
                "message": "automation sophomore, control theory average, preparing for graduate exam, 40 minutes daily, prefer animation examples and engineering cases, weak at root locus and frequency response"
            }),
            content_type="application/json",
        )
        self.assertEqual(interview_response.status_code, 200)

        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"action": "confirm"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertTrue(payload["profileCommitted"])
        self.assertTrue(payload["interviewSession"]["profileCommitted"])
        self.assertIn("confirmedAt", payload["interviewSession"])
        self.assertFalse(payload["generated"]["path"])
        self.assertFalse(payload["generated"]["studyPlan"])
        self.assertTrue(payload["planningDeferred"])
        self.assertEqual(payload["planningDeferredReason"], "awaiting_admission_diagnostic")
        self.assertEqual(payload["interviewSession"]["generated"], payload["generated"])
        self.assertTrue(payload["interviewSession"]["planningDeferred"])
        self.assertEqual(
            payload["interviewSession"]["planningDeferredReason"],
            "awaiting_admission_diagnostic",
        )
        self.user.refresh_from_db()
        self.assertTrue(self.user.profile_completed)
        self.assertEqual(self.user.onboarding_step, "complete")
        refreshed = LearnerProfile.objects.get(user=self.user)
        self.assertFalse(refreshed.extra_profile.get("studyPlan"))
        self.assertFalse(LearningPath.objects.filter(user=self.user, status="active").exists())
        persisted_session = refreshed.extra_profile["profileInterviewSession"]
        self.assertTrue(persisted_session["planningDeferred"])
        self.assertEqual(persisted_session["planningDeferredReason"], "awaiting_admission_diagnostic")
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "profile_interview")
        steps = list(run.steps.order_by("order"))
        self.assertEqual(
            [step.name for step in steps],
            ["SafetyAgent", "ProfileInterviewAgent", "LearnerModelAgent", "MemoryCommitAgent", "PlannerAgent"],
        )
        planner = steps[-1]
        self.assertTrue(planner.metadata["evidence"]["planningDeferred"])
        self.assertEqual(
            planner.metadata["evidence"]["planningDeferredReason"],
            "awaiting_admission_diagnostic",
        )
        self.assertNotIn("LearningPath", planner.metadata["stateDiff"])
        self.assertNotIn("StudyPlan", planner.metadata["stateDiff"])
        for step in steps:
            self.assertIn("runtimePolicy", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["mode"], "agent_output")
            self.assertEqual(step.metadata["degradation"]["status"], step.status)

    def test_resource_generation_returns_seven_verified_personalized_resource_types(self):
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "grade": "大二",
                "major_direction": "自动化",
                "foundation_level": "基础一般",
                "daily_study_time": 40,
                "learning_goals": ["考研复习"],
                "weak_points": ["根轨迹"],
                "expected_resources": ["动画演示", "例题推导", "工程案例"],
            },
        )

        with patch("backend.apps.compat.resource_generation.search_knowledge_base") as search:
            from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

            search.return_value = [
                KnowledgeBaseSearchResult(
                    score=0.91,
                    text="根轨迹描述闭环极点随系统参数变化在复平面上的运动轨迹，常用于分析稳定性。",
                    metadata={"title": "根轨迹讲义", "resource_type": "document", "source_path": "demo.xlsx"},
                )
            ]
            response = self.client.post(
                "/api/resources/generate/",
                data=json.dumps({"goal": "根轨迹基本概念", "topK": 3}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        pack = payload["resourcePack"]
        self.assertEqual(pack["schemaVersion"], "a3.resource-pack.v2")
        resource_types = {item["type"] for item in pack["resources"]}
        self.assertEqual(
            resource_types,
            {"lecture_doc", "knowledge_card", "mind_map", "practice_set", "case_study", "code_lab", "micro_video_script"},
        )
        code_lab = next(item for item in pack["resources"] if item["type"] == "code_lab")
        self.assertEqual(code_lab["content"]["language"], "Python")
        self.assertIn("starterCode", code_lab["content"])
        self.assertGreaterEqual(len(code_lab["content"].get("testCases", [])), 1)
        self.assertGreaterEqual(len(code_lab["content"]["checkpoints"]), 1)
        self.assertTrue(all(item["citations"] for item in pack["resources"]))
        self.assertTrue(all(item["verified"] for item in pack["resources"]))
        self.assertTrue(all(item["personalizationReason"] for item in pack["resources"]))
        self.assertEqual(ResourcePackLog.objects.filter(user=self.user, source="resource_generation").count(), 1)

    def test_resource_generation_builds_rich_grounded_student_resources(self):
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "grade": "大二",
                "major_direction": "计算机网络",
                "foundation_level": "基础一般",
                "daily_study_time": 45,
                "learning_goals": ["掌握网络核心协议"],
                "weak_points": ["拥塞控制", "滑动窗口"],
                "expected_resources": ["图解", "代码实验", "专项练习"],
            },
        )
        with patch("backend.apps.compat.resource_generation.search_knowledge_base") as search:
            from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

            search.return_value = [
                KnowledgeBaseSearchResult(
                    score=0.95,
                    text="TCP 拥塞控制通过慢启动、拥塞避免、快重传和快恢复调节拥塞窗口，避免网络过载。",
                    metadata={"title": "TCP 拥塞控制讲义", "source_path": "network/tcp.md"},
                ),
                KnowledgeBaseSearchResult(
                    score=0.88,
                    text="滑动窗口机制允许发送方在未收到确认前连续发送多个报文段，窗口大小受接收窗口和拥塞窗口共同影响。",
                    metadata={"title": "滑动窗口资料", "source_path": "network/window.md"},
                ),
                KnowledgeBaseSearchResult(
                    score=0.82,
                    text="丢包、超时和重复 ACK 会触发不同的 TCP 调整策略，题目分析时要先判断触发条件。",
                    metadata={"title": "TCP 例题解析", "source_path": "network/exercises.md"},
                ),
            ]
            response = self.client.post(
                "/api/resources/generate/",
                data=json.dumps({"goal": "TCP 拥塞控制", "topK": 3}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 201, response.content)
        pack = response.json()["resourcePack"]
        by_type = {item["type"]: item for item in pack["resources"]}
        self.assertGreaterEqual(search.call_args.kwargs["top_k"], 6)
        self.assertGreaterEqual(len(by_type["lecture_doc"]["content"]["sections"]), 6)
        self.assertGreaterEqual(len(by_type["mind_map"]["content"]["nodes"]), 5)
        self.assertGreaterEqual(len(by_type["practice_set"]["content"]["questions"]), 8)
        self.assertGreaterEqual(len(by_type["micro_video_script"]["content"]["shots"]), 7)
        visual_text = " ".join(str(shot.get("visual") or "") for shot in by_type["micro_video_script"]["content"]["shots"])
        for banned in ("标题 +", "本地资料摘录", "板书结构", "白板上写", "屏幕文字", "字幕显示", "公式展示", "密集小字", "随机英文"):
            self.assertNotIn(banned, visual_text)
        self.assertIn("不出现", visual_text)
        self.assertGreaterEqual(len(by_type["code_lab"]["content"]["steps"]), 5)
        self.assertGreaterEqual(len(by_type["code_lab"]["content"]["checkpoints"]), 4)
        self.assertIn("extension", by_type["code_lab"]["content"])
        self.assertGreaterEqual(len(by_type["knowledge_card"]["content"]["cards"]), 4)
        self.assertTrue(all(item["content"]["schemaVersion"] == "a3.resource-content.rich.v1" for item in pack["resources"]))
        self.assertTrue(all(len(item["citations"]) >= 3 for item in pack["resources"]))
        self.assertTrue(all(item["synthesis"]["mode"] in {"rules", "llm"} for item in pack["resources"]))

    def test_deadlock_lecture_doc_uses_topic_specific_explanation(self):
        from backend.apps.compat.resource_generation import _fallback_resource_content

        content = _fallback_resource_content(
            "lecture_doc",
            "操作系统中的死锁",
            [
                {
                    "id": "S1",
                    "title": "操作系统课件",
                    "snippet": "死锁是多个进程因竞争资源而造成的一种互相等待现象。",
                    "sourceId": "S1",
                },
                {
                    "id": "S2",
                    "title": "工程制图题库",
                    "snippet": "根据三视图判断点线面的投影关系。",
                    "sourceId": "S2",
                }
            ],
            None,
        )

        text = json.dumps(content, ensure_ascii=False)
        self.assertIn("互斥", text)
        self.assertIn("占有并等待", text)
        self.assertIn("不可剥夺", text)
        self.assertIn("循环等待", text)
        self.assertIn("资源分配图", text)
        self.assertIn("银行家算法", text)
        self.assertIn("不安全状态不一定已经死锁", text)
        self.assertNotIn("三视图", text)
        self.assertNotIn("对象、条件、过程、结果四部分", text)

    def test_deadlock_mind_map_uses_os_specific_exam_structure(self):
        response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "我要学操作系统死锁，画思维导图", "topK": 3, "resourceType": "mind_map"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201, response.content)
        pack = response.json()["resourcePack"]
        mind_map = pack["resources"][0]["content"]
        labels = [node["label"] for node in mind_map["nodes"]]
        all_text = json.dumps(mind_map, ensure_ascii=False)

        for expected in ("四个必要条件", "资源分配图", "银行家算法", "检测与解除", "题型路径"):
            self.assertIn(expected, labels)
        self.assertIn("markdown", mind_map)
        self.assertIn("mermaid", mind_map)
        self.assertIn("请求边", all_text)
        self.assertIn("安全序列", all_text)
        self.assertIn("sourceIds", mind_map["nodes"][0])

    def test_resource_specialist_prompts_define_professional_contracts(self):
        from backend.apps.compat.resource_generation import (
            _resource_llm_requirements,
            _resource_specialist_instructions,
        )

        practice = json.dumps(_resource_llm_requirements("practice_set"), ensure_ascii=False)
        case = json.dumps(_resource_llm_requirements("case_study"), ensure_ascii=False)
        code = json.dumps(_resource_llm_requirements("code_lab"), ensure_ascii=False)

        for field in ("knowledgePoint", "difficulty", "distractorAnalysis", "commonMistake", "evaluationRubric", "sourceIds"):
            self.assertIn(field, practice)
        for field in ("role", "constraints", "materials", "decisionPoints", "analysisSteps", "expertAnalysis", "rubric", "sourceIds"):
            self.assertIn(field, case)
        for field in ("Python", "concepts", "hints", "commonFailures", "testCases", "checkpoints", "sourceIds"):
            self.assertIn(field, code)

        self.assertIn("逐题反馈", _resource_specialist_instructions("practice_set"))
        self.assertIn("先判断", _resource_specialist_instructions("case_study"))
        self.assertIn("真实 runner", _resource_specialist_instructions("code_lab"))

    def test_all_resource_types_have_dedicated_specialist_persona(self):
        """锁住第 4 项：7 类资源都应有专属 Specialist 人设，不再回退到通用 default，
        且四个原本较弱的类型人设里显式要求围绕 weakPoints 组织内容。"""
        from backend.apps.compat.resource_generation import (
            RESOURCE_TYPES,
            _resource_specialist_instructions,
        )

        default_text = _resource_specialist_instructions("__nonexistent__")
        specialist_names = {
            "lecture_doc": "LectureDocSpecialist",
            "knowledge_card": "KnowledgeCardSpecialist",
            "mind_map": "MindMapSpecialist",
            "micro_video_script": "MicroVideoSpecialist",
            "practice_set": "PracticeSetSpecialist",
            "case_study": "CaseStudySpecialist",
            "code_lab": "CodeLabSpecialist",
        }
        for resource_type in RESOURCE_TYPES:
            persona = _resource_specialist_instructions(resource_type)
            self.assertNotEqual(persona, default_text, resource_type)
            self.assertIn(specialist_names[resource_type], persona)

        # 四个新补的弱类型人设必须显式引用 weakPoints，使个性化落到生成契约里。
        for resource_type in ("lecture_doc", "knowledge_card", "mind_map", "micro_video_script"):
            self.assertIn("weakPoints", _resource_specialist_instructions(resource_type), resource_type)

    def test_specialist_repair_completes_partial_resource_content(self):
        from backend.apps.compat.resource_generation import _repair_llm_resource_content

        sources = [
            {"id": "S1", "sourceId": "S1", "title": "进程调度课件", "snippet": "时间片轮转按固定时间片切换进程。"},
            {"id": "S2", "sourceId": "S2", "title": "调度算法实验", "snippet": "等待时间和周转时间用于比较调度效果。"},
        ]

        practice = _repair_llm_resource_content(
            "practice_set",
            {"questions": [{"type": "choice", "stem": "RR 的核心参数是什么？", "answer": "时间片"}]},
            "进程调度",
            sources,
            None,
        )
        case = _repair_llm_resource_content(
            "case_study",
            {"scenario": "服务器任务排队", "task": "选择调度策略"},
            "进程调度",
            sources,
            None,
        )
        code = _repair_llm_resource_content(
            "code_lab",
            {"starterCode": "print('ready')"},
            "进程调度",
            sources,
            None,
        )

        self.assertGreaterEqual(len(practice["questions"]), 8)
        self.assertTrue(all(question.get("knowledgePoint") for question in practice["questions"]))
        self.assertTrue(all(question.get("commonMistake") for question in practice["questions"]))
        self.assertTrue(all("sourceIds" in question for question in practice["questions"]))
        for field in ("role", "constraints", "materials", "decisionPoints", "analysisSteps", "expertAnalysis", "rubric"):
            self.assertTrue(case.get(field), field)
        self.assertEqual(code["language"], "Python")
        for field in ("objective", "environment", "concepts", "steps", "testCases", "hints", "commonFailures", "checkpoints", "extension"):
            self.assertTrue(code.get(field), field)

    def test_specialist_repair_rejects_malformed_collection_fields(self):
        from backend.apps.compat.resource_generation import _repair_llm_resource_content

        sources = [
            {"id": "S1", "sourceId": "S1", "title": "进程调度课件", "snippet": "时间片轮转按固定时间片切换进程。"},
            {"id": "S2", "sourceId": "S2", "title": "调度算法实验", "snippet": "等待时间和周转时间用于比较调度效果。"},
        ]

        practice = _repair_llm_resource_content(
            "practice_set",
            {
                "questions": [{
                    "type": "choice",
                    "stem": "RR 的核心参数是什么？",
                    "answer": "B",
                    "distractorAnalysis": "A 错在忽略时间片",
                    "evaluationRubric": 3,
                    "sourceIds": {"sourceId": "S1"},
                }],
                "sourceIds": "S1",
            },
            "进程调度",
            sources,
            None,
        )
        case = _repair_llm_resource_content(
            "case_study",
            {"constraints": "不能忽略约束", "materials": 2, "decisionPoints": {"first": "比较策略"}},
            "进程调度",
            sources,
            None,
        )
        code = _repair_llm_resource_content(
            "code_lab",
            {"concepts": "队列", "steps": 5, "hints": {"hint": "先运行"}, "sourceIds": "S1"},
            "进程调度",
            sources,
            None,
        )

        for field in ("distractorAnalysis", "evaluationRubric", "sourceIds"):
            self.assertIsInstance(practice["questions"][0][field], list)
        self.assertIsInstance(practice["sourceIds"], list)
        for field in ("constraints", "materials", "decisionPoints"):
            self.assertIsInstance(case[field], list)
        for field in ("concepts", "steps", "hints", "sourceIds"):
            self.assertIsInstance(code[field], list)

    def test_fallback_choice_answer_matches_option_letter_contract(self):
        from backend.apps.compat.resource_generation import _fallback_resource_content

        sources = [{"id": "S1", "sourceId": "S1", "title": "调度算法", "snippet": "先检查对象、条件和证据。"}]
        content = _fallback_resource_content("practice_set", "进程调度", sources, None)
        choice = next(question for question in content["questions"] if question["type"] == "choice")

        self.assertEqual(choice["answer"], "B")
        self.assertTrue(choice["options"][1].startswith("B."))

    def test_unscored_resource_completion_preserves_null_score(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "分析进程调度案例", "topK": 2, "resourceType": "case_study"}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201, pack_response.content)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        feedback_response = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "completed", "resourceType": "case_study", "score": None}),
            content_type="application/json",
        )

        self.assertEqual(feedback_response.status_code, 200, feedback_response.content)
        self.assertIsNone(feedback_response.json()["feedback"]["score"])
        profile = LearnerProfile.objects.get(user=self.user)
        self.assertIsNone(profile.extra_profile["resourceFeedback"][0]["score"])

    def test_specialist_quality_rejects_shallow_resource_content(self):
        from backend.apps.compat.resource_generation import _fallback_resource_content, _resource_content_quality

        sources = [
            {"id": "S1", "sourceId": "S1", "title": "进程调度课件", "snippet": "时间片轮转按固定时间片切换进程。"},
            {"id": "S2", "sourceId": "S2", "title": "调度算法实验", "snippet": "等待时间和周转时间用于比较调度效果。"},
        ]
        shallow = {
            "practice_set": {"questions": [{"stem": "什么是调度？", "answer": "调度"}]},
            "case_study": {"scenario": "一个案例", "steps": ["分析"], "analysis": "结论"},
            "code_lab": {"starterCode": "print(1)", "steps": ["运行"], "checkpoints": ["完成"]},
            # 以下 4 类原先走宽松 legacy 门禁，现已收紧为与专家类同构的严格门禁。
            "lecture_doc": {"sections": [{"heading": "目标", "body": "学会调度"}]},
            "knowledge_card": {"cards": [{"front": "什么是调度？", "back": "切换进程"}]},
            "mind_map": {"nodes": [{"label": "条件", "children": ["互斥"]}], "markdown": "# 调度"},
            "micro_video_script": {"shots": [{"scene": "开场", "narration": "讲调度"}]},
        }

        for resource_type, content in shallow.items():
            report = _resource_content_quality(resource_type, content)
            self.assertFalse(report["passed"], resource_type)
            self.assertLess(report["score"], 80)
            self.assertTrue(report["checks"])

            fallback = _fallback_resource_content(resource_type, "进程调度", sources, None)
            fallback_report = _resource_content_quality(resource_type, fallback)
            self.assertTrue(fallback_report["passed"], (resource_type, fallback_report))
            self.assertGreaterEqual(fallback_report["score"], 80)

    def test_specialist_quality_requires_grounding_and_runner_contracts(self):
        from backend.apps.compat.resource_generation import _fallback_resource_content, _resource_content_quality

        sources = [
            {"id": "S1", "sourceId": "S1", "title": "进程调度课件", "snippet": "时间片轮转按固定时间片切换进程。"},
            {"id": "S2", "sourceId": "S2", "title": "调度算法实验", "snippet": "等待时间和周转时间用于比较调度效果。"},
        ]
        required_fields = {
            "practice_set": "grounding",
            "case_study": "rubric_grounding",
            "code_lab": "test_contract",
            "lecture_doc": "grounding",
            "knowledge_card": "grounding",
            "mind_map": "grounding",
            "micro_video_script": "grounding",
        }

        def _strip_grounding(resource_type, content):
            """把 required 接地字段清空，验证门禁会因此拒绝（其余检查仍通过）。"""
            if resource_type == "practice_set":
                for question in content["questions"]:
                    question["sourceIds"] = []
            elif resource_type == "case_study":
                content["sourceIds"] = []
            elif resource_type == "code_lab":
                content["testCases"] = []
            elif resource_type == "lecture_doc":
                for section in content["sections"]:
                    section["sourceIds"] = []
            elif resource_type == "knowledge_card":
                for card in content["cards"]:
                    card["sourceIds"] = []
            elif resource_type == "mind_map":
                for node in content["nodes"]:
                    node["sourceIds"] = []
            elif resource_type == "micro_video_script":
                for shot in content["shots"]:
                    shot["sourceIds"] = []

        for resource_type, required_check in required_fields.items():
            content = _fallback_resource_content(resource_type, "进程调度", sources, None)
            _strip_grounding(resource_type, content)

            report = _resource_content_quality(resource_type, content)
            self.assertFalse(report["passed"], (resource_type, report))
            failed_names = {item["name"] for item in report["checks"] if not item["passed"]}
            # 只有 required 接地检查失败，其余检查仍应全部通过——证明是接地门禁而非整体浅薄导致拒绝。
            self.assertEqual(failed_names, {required_check}, (resource_type, report))

    def test_resource_verified_reflects_claim_grounding_not_mere_citation(self):
        """verified 必须反映内容是否真被证据支撑，而不是"挂了引用就为真"。

        锁住第 3 项修复。分两层验证：
        1) 端到端：相关证据下 7 类资源都应 verified=True 且至少 1 条 claim 被支撑。
        2) 判定函数 _resource_grounding：直接喂构造的 verification，验证三条核心分支
           （无引用→False、有引用但零 claim 支撑→False、有支撑→True），
           这样不受 verify_answer 的 token 重叠噪声干扰，干净地锁住"不再恒真"。
        """
        from backend.apps.compat.resource_generation import (
            RESOURCE_TYPES,
            _build_resource_item,
            _resource_grounding,
        )

        relevant = [
            {"id": "S1", "sourceId": "S1", "type": "RAG", "score": 0.9,
             "title": "根轨迹讲义", "location": "第1章",
             "snippet": "根轨迹描述闭环极点随系统参数变化在复平面上的运动轨迹，用于分析稳定性。"},
        ]
        for resource_type in RESOURCE_TYPES:
            grounded = _build_resource_item(resource_type, "根轨迹基本概念", None, relevant, allow_llm=False)
            self.assertTrue(grounded["verified"], (resource_type, grounded["grounding"]))
            self.assertGreaterEqual(grounded["grounding"]["supportedClaims"], 1, (resource_type, grounded["grounding"]))

        class _V:
            def __init__(self, claims, citations, verified):
                self.claims = claims
                self.citations = citations
                self.verified = verified

        cite = [{"title": "根轨迹讲义", "snippet": "根轨迹描述闭环极点轨迹。", "type": "RAG", "score": 0.9}]

        # 有引用 + 至少 1 条 claim 被支撑 → verified=True
        supported = _resource_grounding(_V(
            claims=[{"verified": True}, {"verified": False}, {"verified": False}],
            citations=cite, verified=True,
        ))
        self.assertTrue(supported["verified"])
        self.assertEqual(supported["supportedClaims"], 1)

        # 有引用但零 claim 被支撑 → verified=False（旧逻辑此处会因"有 citation"恒真）
        unsupported = _resource_grounding(_V(
            claims=[{"verified": False}, {"verified": False}],
            citations=cite, verified=True,
        ))
        self.assertFalse(unsupported["verified"])

        # 完全没有可引用证据 → verified=False
        no_citation = _resource_grounding(_V(
            claims=[{"verified": True}], citations=[], verified=True,
        ))
        self.assertFalse(no_citation["verified"])

        # 支撑率高 → confidence 升级为 high
        high_conf = _resource_grounding(_V(
            claims=[{"verified": True}, {"verified": True}, {"verified": True}, {"verified": False}],
            citations=cite, verified=True,
        ))
        self.assertEqual(high_conf["confidence"], "high")

    @patch.dict("os.environ", {"A3_RESOURCE_LLM_ENABLED": "1", "A3_LLM_API_KEY": "test-key"})
    def test_mind_map_llm_generation_has_explicit_schema_requirements(self):
        with patch("backend.apps.compat.resource_generation.chat_completion") as chat:
            chat.return_value = {
                "content": json.dumps(
                    {
                        "nodes": [
                            {"label": "四个必要条件", "children": ["互斥", "占有并等待", "不可抢占"], "sourceIds": ["S1"]},
                            {"label": "资源分配图", "children": ["请求边", "分配边", "有环判断"], "sourceIds": ["S1"]},
                            {"label": "银行家算法", "children": ["Need", "Available", "安全序列"], "sourceIds": ["S1"]},
                            {"label": "检测与解除", "children": ["检测", "撤销", "回滚"], "sourceIds": ["S1"]},
                            {"label": "题型路径", "children": ["概念题", "判断题", "算法题"], "sourceIds": ["S1"]},
                        ],
                        "markdown": "# 死锁\n## 四个必要条件\n- 互斥",
                        "mermaid": "mindmap\n  root((死锁))",
                    },
                    ensure_ascii=False,
                ),
                "provider": "dashscope",
                "model": "qwen-plus",
                "finishReason": "stop",
            }

            response = self.client.post(
                "/api/resources/generate/",
                data=json.dumps({"goal": "操作系统死锁思维导图", "topK": 3, "resourceType": "mind_map"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["resourcePack"]["resources"][0]["synthesis"]["mode"], "llm")
        llm_payload = json.loads(chat.call_args.args[0][1]["content"])
        self.assertEqual(llm_payload["resourceType"], "mind_map")
        self.assertIn("markdown", llm_payload["requirements"]["nodes"])
        self.assertIn("银行家算法", llm_payload["requirements"]["nodes"])

    @patch.dict("os.environ", {"A3_RESOURCE_LLM_ENABLED": "1", "A3_LLM_API_KEY": "test-key"})
    def test_mind_map_llm_output_is_repaired_instead_of_degraded_when_markdown_missing(self):
        with patch("backend.apps.compat.resource_generation.chat_completion") as chat:
            chat.return_value = {
                "content": json.dumps(
                    {
                        "root": "操作系统死锁",
                        "nodes": [
                            {"label": "四个必要条件", "children": ["互斥", "占有并等待", "不可抢占"], "sourceIds": ["S1"]},
                            {"label": "资源分配图", "children": ["请求边", "分配边", "有环判断"], "sourceIds": ["S1"]},
                            {"label": "银行家算法", "children": ["Need", "Available", "安全序列"], "sourceIds": ["S1"]},
                            {"label": "检测与解除", "children": ["检测", "撤销", "回滚"], "sourceIds": ["S1"]},
                            {"label": "题型路径", "children": ["概念题", "判断题", "算法题"], "sourceIds": ["S1"]},
                        ],
                    },
                    ensure_ascii=False,
                ),
                "provider": "dashscope",
                "model": "qwen-plus",
                "finishReason": "stop",
            }

            response = self.client.post(
                "/api/resources/generate/",
                data=json.dumps({"goal": "操作系统死锁思维导图", "topK": 3, "resourceType": "mind_map"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 201, response.content)
        resource = response.json()["resourcePack"]["resources"][0]
        self.assertEqual(resource["synthesis"]["mode"], "llm")
        self.assertFalse(resource["synthesis"]["degraded"])
        self.assertIn("markdown", resource["content"])
        self.assertIn("mermaid", resource["content"])

    @patch.dict("os.environ", {"A3_RESOURCE_LLM_ENABLED": "auto", "A3_RESOURCE_LLM_FULL_PACK_ENABLED": "0", "A3_LLM_API_KEY": "test-key"})
    def test_full_resource_pack_does_not_call_llm_by_default(self):
        with patch("backend.apps.compat.resource_generation.chat_completion") as chat:
            response = self.client.post(
                "/api/resources/generate/",
                data=json.dumps({"goal": "TCP 拥塞控制", "topK": 3}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 201, response.content)
        chat.assert_not_called()
        pack = response.json()["resourcePack"]
        self.assertEqual(pack["generationMode"], "full")
        self.assertTrue(all(item["synthesis"]["mode"] == "rules" for item in pack["resources"]))

    def test_resource_generation_runtime_failure_returns_readable_json(self):
        with patch("backend.apps.compat.views.generate_resource_pack_v2", side_effect=RuntimeError("workflow timeout")):
            response = self.client.post(
                "/api/resources/generate/",
                data=json.dumps({"goal": "计算机网络拥塞控制", "topK": 3}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 500)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertIn("资源包生成失败", payload["error"])
        self.assertIn("workflow timeout", payload["error"])

    def test_resource_generation_can_generate_single_resource_type(self):
        response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "TCP 拥塞控制", "topK": 3, "resourceType": "mind_map"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201, response.content)
        payload = response.json()
        self.assertTrue(payload["success"])
        pack = payload["resourcePack"]
        self.assertEqual(pack["generationMode"], "single")
        self.assertEqual(pack["requestedResourceType"], "mind_map")
        self.assertEqual([item["type"] for item in pack["resources"]], ["mind_map"])
        self.assertEqual(pack["resourceStrategy"]["resourceTypes"], ["mind_map"])
        self.assertEqual(ResourcePackLog.objects.filter(user=self.user, source="resource_generation").count(), 1)

    def test_resource_generation_runs_as_agent_kernel_workflow_with_schema_evidence(self):
        response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus kernel workflow", "topK": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201, response.content)
        payload = response.json()
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "resource_generate")
        self.assertEqual(run.status, "completed")
        steps = list(run.steps.order_by("order"))
        self.assertEqual(
            [step.name for step in steps],
            [
                "RetrieverAgent",
                "PedagogyAgent",
                "ResourceSynthesisAgent",
                "PracticeGenerationAgent",
                "VerifierAgent",
                "ResourcePackCommitAgent",
            ],
        )
        for step in steps:
            self.assertIn("runtimePolicy", step.metadata)
            self.assertIn("outputSchema", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["schemaVersion"], "a3.agent-output.v1")
            self.assertTrue(step.metadata["outputSchema"]["valid"])
            self.assertIn("degradation", step.metadata)
            self.assertEqual(step.metadata["degradation"]["status"], step.status)
            self.assertIn("a3EvidenceSchemaVersion", step.metadata)

        contract = evaluate_trace_contract({
            "workflow": run.workflow,
            "status": run.status,
            "fallbackStrategy": run.fallback_strategy,
            "latencyMs": run.latency_ms,
            "traceId": run.trace_id,
            "steps": [
                {"name": step.name, "status": step.status}
                for step in steps
            ],
        })
        self.assertTrue(contract["known"])
        self.assertTrue(contract["ready"])
        self.assertEqual(contract["missingRequiredSteps"], [])

    def test_openmaic_classroom_artifact_is_written_back_to_resource_pack(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "根轨迹分析", "topK": 3}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response = self.client.post(
            f"/api/resources/packs/{pack_id}/openmaic-classroom/",
            data=json.dumps(
                {
                    "jobId": "job-openmaic-001",
                    "status": "succeeded",
                    "classroomId": "classroom-001",
                    "classroomUrl": "/classroom/classroom-001",
                    "scenesCount": 5,
                    "pptxExportable": True,
                    "provider": "openmaic-generate-classroom",
                    "elapsedMs": 1234,
                    "tutorPersona": {
                        "id": "structured-teacher",
                        "name": "结构讲解",
                        "shortDescription": "先搭框架，再分步骤讲清概念",
                        "teachingStyle": "structured",
                        "avatarAssetId": "teacher-default-v1",
                        "avatarPublicPath": "/a3/assets/teacher-avatar/teacher.vrm",
                        "voiceProfileId": "voice-clear-guide",
                        "voicePreviewEnabled": True,
                        "allowedWorkflows": ["coaching", "classroom", "explain", "review", "plan"],
                        "schemaVersion": "a3.tutor-persona.v1",
                    },
                    "fallbackUsed": False,
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        artifact = payload["artifact"]
        self.assertEqual(artifact["type"], "openmaic_classroom")
        self.assertEqual(artifact["jobId"], "job-openmaic-001")
        self.assertEqual(artifact["classroomUrl"], "/classroom/classroom-001")
        self.assertTrue(artifact["pptxExportable"])
        refreshed = self.client.get(f"/api/resources/packs/{pack_id}/").json()["resourcePack"]
        self.assertEqual(refreshed["multimodalArtifacts"][0]["classroomId"], "classroom-001")
        self.assertIn("OpenMAIC 课堂", [item["label"] for item in refreshed["nextActions"]])
        log_payload = ResourcePackLog.objects.get(user=self.user, task_id=f"resource-pack:{pack_id}").payload
        self.assertEqual(log_payload["multimodalArtifacts"][0]["provider"], "openmaic-generate-classroom")
        artifact_row = OpenMAICArtifact.objects.get(user=self.user, resource_pack_id=pack_id, job_id="job-openmaic-001")
        self.assertEqual(artifact_row.artifact_type, "openmaic_classroom")
        self.assertEqual(artifact_row.status, "succeeded")
        self.assertEqual(artifact_row.payload["classroomId"], "classroom-001")
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "openmaic_classroom_bridge")
        self.assertEqual([step.name for step in run.steps.order_by("order")], ["A3ResourceBridgeAgent", "ResourcePackCommitAgent"])
        for step in run.steps.order_by("order"):
            self.assertIn("runtimePolicy", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["mode"], "agent_output")

    def test_openmaic_video_artifact_records_missing_provider_key_degradation(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "根轨迹分析", "topK": 3}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response = self.client.post(
            f"/api/resources/packs/{pack_id}/openmaic-video/",
            data=json.dumps(
                {
                    "status": "failed",
                    "provider": "seedance",
                    "resourceType": "micro_video_script",
                    "videoUrl": "",
                    "duration": 0,
                    "elapsedMs": 10,
                    "degradedReason": "No API key configured for video provider: seedance",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        artifact = payload["artifact"]
        self.assertEqual(artifact["type"], "openmaic_video")
        self.assertEqual(artifact["status"], "failed")
        self.assertEqual(artifact["resourceType"], "micro_video_script")
        self.assertIn("No API key configured", artifact["degradedReason"])
        refreshed = self.client.get(f"/api/resources/packs/{pack_id}/").json()["resourcePack"]
        self.assertEqual(refreshed["multimodalArtifacts"][0]["type"], "openmaic_video")
        artifact_row = OpenMAICArtifact.objects.get(user=self.user, resource_pack_id=pack_id, artifact_type="openmaic_video")
        self.assertEqual(artifact_row.status, "failed")
        self.assertEqual(artifact_row.provider, "seedance")
        self.assertIn("No API key configured", artifact_row.payload["degradedReason"])
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "openmaic_video_bridge")
        self.assertEqual([step.name for step in run.steps.order_by("order")], ["A3VideoBridgeAgent", "ResourcePackCommitAgent"])
        for step in run.steps.order_by("order"):
            self.assertIn("runtimePolicy", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["mode"], "agent_output")

    def test_openmaic_video_writeback_truncates_long_resource_pack_log_titles(self):
        long_goal = "deadlock video " + ("resource generation requirements " * 12)
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": long_goal, "topK": 3, "resourceType": "micro_video_script"}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201, pack_response.content)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response = self.client.post(
            f"/api/resources/packs/{pack_id}/openmaic-video/",
            data=json.dumps(
                {
                    "status": "succeeded",
                    "provider": "seedance",
                    "resourceType": "micro_video_script",
                    "videoUrl": "https://example.com/" + ("a" * 260) + ".mp4",
                    "duration": 10,
                    "width": 1920,
                    "height": 1080,
                    "elapsedMs": 1000,
                    "degradedReason": "",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        log = ResourcePackLog.objects.get(user=self.user, task_id=f"resource-pack:{pack_id}")
        self.assertLessEqual(len(log.task_title), 160)
        self.assertLessEqual(len(log.learning_goal), 160)
        self.assertEqual(log.payload["multimodalArtifacts"][0]["status"], "succeeded")
        self.assertIn("videoUrl", log.payload["multimodalArtifacts"][0])

    def test_openmaic_video_writeback_preserves_segmented_partial_artifact(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "操作系统死锁 1 分钟讲解视频", "topK": 3, "resourceType": "micro_video_script"}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201, pack_response.content)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response = self.client.post(
            f"/api/resources/packs/{pack_id}/openmaic-video/",
            data=json.dumps(
                {
                    "status": "partial",
                    "provider": "seedance",
                    "resourceType": "micro_video_script",
                    "videoUrl": "https://example.com/segment-1.mp4",
                    "duration": 50,
                    "width": 1920,
                    "height": 1080,
                    "elapsedMs": 60000,
                    "degradedReason": "1 分钟视频分段生成完成：5/6 段成功",
                    "segments": [
                        {"index": 1, "title": "导入", "status": "succeeded", "videoUrl": "https://example.com/segment-1.mp4", "duration": 10, "width": 1920, "height": 1080, "degradedReason": ""},
                        {"index": 2, "title": "概念", "status": "failed", "videoUrl": "", "duration": 10, "width": 0, "height": 0, "degradedReason": "provider timeout"},
                    ],
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        artifact = response.json()["artifact"]
        self.assertEqual(artifact["status"], "partial")
        self.assertEqual(len(artifact["segments"]), 2)
        self.assertEqual(artifact["segments"][1]["degradedReason"], "provider timeout")

    def test_openmaic_pptx_export_artifact_is_written_back_to_resource_pack(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus pptx export", "topK": 3}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response = self.client.post(
            f"/api/resources/packs/{pack_id}/openmaic-pptx-export/",
            data=json.dumps(
                {
                    "jobId": "pptx-classroom-001-29990101",
                    "status": "succeeded",
                    "classroomId": "classroom-001",
                    "classroomUrl": "/classroom/classroom-001",
                    "fileName": "root-locus-classroom.pptx",
                    "slidesCount": 6,
                    "provider": "openmaic-pptx-export",
                    "elapsedMs": 345,
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        artifact = payload["artifact"]
        self.assertEqual(artifact["type"], "openmaic_pptx_export")
        self.assertEqual(artifact["status"], "succeeded")
        self.assertEqual(artifact["fileName"], "root-locus-classroom.pptx")
        self.assertEqual(artifact["slidesCount"], 6)
        refreshed = self.client.get(f"/api/resources/packs/{pack_id}/").json()["resourcePack"]
        self.assertEqual(refreshed["multimodalArtifacts"][0]["type"], "openmaic_pptx_export")
        artifact_row = OpenMAICArtifact.objects.get(
            user=self.user,
            resource_pack_id=pack_id,
            artifact_type="openmaic_pptx_export",
            job_id="pptx-classroom-001-29990101",
        )
        self.assertEqual(artifact_row.provider, "openmaic-pptx-export")
        self.assertEqual(artifact_row.payload["slidesCount"], 6)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "openmaic_pptx_export_bridge")
        self.assertEqual([step.name for step in run.steps.order_by("order")], ["A3PPTXExportBridgeAgent", "ResourcePackCommitAgent"])
        for step in run.steps.order_by("order"):
            self.assertIn("runtimePolicy", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["mode"], "agent_output")

    def test_openmaic_classroom_interaction_is_written_back_to_learning_events(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus interaction", "topK": 3}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response = self.client.post(
            f"/api/resources/packs/{pack_id}/openmaic-interaction/",
            data=json.dumps(
                {
                    "eventType": "action_completed",
                    "classroomId": "classroom-001",
                    "classroomJobId": "job-openmaic-001",
                    "sceneId": "scene-003",
                    "sceneTitle": "Root locus walkthrough",
                    "actionType": "play_video",
                    "actionId": "video-demo-1",
                    "progress": 0.6,
                    "elapsedMs": 2400,
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["interaction"]["eventType"], "openmaic_action_completed")
        self.assertEqual(payload["interaction"]["resourcePackId"], pack_id)
        self.assertIn("traceId", payload)

        refreshed = LearnerProfile.objects.get(user=self.user)
        events = refreshed.extra_profile.get("learningEvents", [])
        self.assertEqual(events[0]["eventType"], "openmaic_action_completed")
        self.assertEqual(events[0]["signals"]["resourcePackId"], pack_id)
        self.assertEqual(events[0]["signals"]["classroomId"], "classroom-001")
        self.assertEqual(events[0]["signals"]["actionType"], "play_video")
        self.assertEqual(events[0]["signals"]["progress"], 0.6)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "openmaic_interaction_bridge")
        self.assertEqual([step.name for step in run.steps.order_by("order")], ["A3OpenMAICInteractionBridgeAgent", "ProfileAgent"])
        for step in run.steps.order_by("order"):
            self.assertIn("runtimePolicy", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["mode"], "agent_output")

    def test_resource_pack_detail_returns_openmaic_artifact_history_from_audit_table(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "artifact history", "topK": 3}),
            content_type="application/json",
        )
        self.assertEqual(pack_response.status_code, 201)
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id=pack_id,
            artifact_type="openmaic_classroom",
            job_id="job-history-classroom",
            status="succeeded",
            provider="openmaic-generate-classroom",
            payload={
                "type": "openmaic_classroom",
                "jobId": "job-history-classroom",
                "status": "succeeded",
                "classroomId": "classroom-history",
                "classroomUrl": "/classroom/classroom-history",
                "scenesCount": 6,
                "pptxExportable": True,
                "provider": "openmaic-generate-classroom",
                "createdAt": "2999-01-01T00:00:00+00:00",
            },
        )
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id=pack_id,
            artifact_type="openmaic_video",
            job_id="",
            status="succeeded",
            provider="seedance",
            payload={
                "type": "openmaic_video",
                "status": "succeeded",
                "provider": "seedance",
                "resourceType": "micro_video_script",
                "videoUrl": "/api/a3/video/playback/safe-id",
                "duration": 8,
                "createdAt": "2999-01-02T00:00:00+00:00",
            },
        )
        OpenMAICArtifact.objects.create(
            user=self.user,
            resource_pack_id=pack_id,
            artifact_type="openmaic_pptx_export",
            job_id="job-history-pptx",
            status="succeeded",
            provider="openmaic-pptx-export",
            payload={
                "type": "openmaic_pptx_export",
                "jobId": "job-history-pptx",
                "status": "succeeded",
                "provider": "openmaic-pptx-export",
                "classroomId": "classroom-history",
                "fileName": "history.pptx",
                "slidesCount": 6,
                "createdAt": "2999-01-03T00:00:00+00:00",
            },
        )

        response = self.client.get(f"/api/resources/packs/{pack_id}/")

        self.assertEqual(response.status_code, 200)
        pack = response.json()["resourcePack"]
        artifacts = pack["multimodalArtifacts"]
        self.assertEqual(len(artifacts), 3)
        self.assertEqual(artifacts[0]["type"], "openmaic_pptx_export")
        self.assertEqual(artifacts[1]["type"], "openmaic_video")
        self.assertEqual(artifacts[2]["jobId"], "job-history-classroom")

    def test_resource_pack_feedback_updates_effect_report(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "频率响应"}),
            content_type="application/json",
        )
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        feedback_response = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "completed", "resourceType": "practice_set", "score": 86}),
            content_type="application/json",
        )
        report_response = self.client.get("/api/learning/effect/report/")

        self.assertEqual(feedback_response.status_code, 200)
        self.assertEqual(report_response.status_code, 200)
        report = report_response.json()["effectReport"]
        self.assertGreaterEqual(report["resourceUsage"]["completed"], 1)
        self.assertGreaterEqual(report["resourceEffectiveness"], 1)
        self.assertIn("planAdjustment", report)

    def test_resource_feedback_persists_plan_adjustment_evidence(self):
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus remediation"}),
            content_type="application/json",
        )
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        feedback_response = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "completed", "resourceType": "practice_set", "score": 72}),
            content_type="application/json",
        )

        self.assertEqual(feedback_response.status_code, 200)
        effect_report = feedback_response.json()["effectReport"]
        adjustment = effect_report["planAdjustment"]
        self.assertEqual(adjustment["strategy"], "increase_practice")
        self.assertIn("evidence", adjustment)
        self.assertEqual(adjustment["evidence"]["completed"], 1)
        self.assertEqual(adjustment["evidence"]["averageFeedbackScore"], 72)
        self.assertEqual(adjustment["nextAction"]["href"], "/a3/assessment?practice=root%20locus%20remediation")
        refreshed = LearnerProfile.objects.get(user=self.user)
        self.assertEqual(refreshed.extra_profile["learningEffectReport"]["planAdjustment"]["strategy"], "increase_practice")

    def test_low_score_resource_feedback_writes_remedial_task_to_study_plan(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"days": 7}),
            content_type="application/json",
        )
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus remediation"}),
            content_type="application/json",
        )
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        feedback_response = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "completed", "resourceType": "practice_set", "score": 72}),
            content_type="application/json",
        )

        self.assertEqual(feedback_response.status_code, 200)
        refreshed = LearnerProfile.objects.get(user=self.user)
        plan = refreshed.extra_profile["studyPlan"]
        adjustment = plan["lastResourceFeedbackAdjustment"]
        self.assertEqual(adjustment["strategy"], "increase_practice")
        self.assertEqual(adjustment["evidence"]["averageFeedbackScore"], 72)
        tasks = [
            task
            for day in plan["days"]
            for task in day.get("tasks", [])
            if isinstance(task, dict)
        ]
        remedial_tasks = [
            task
            for task in tasks
            if task.get("metadata", {}).get("generatedBy") == "resource_feedback_adjustment"
        ]
        self.assertEqual(len(remedial_tasks), 1)
        remedial_task = remedial_tasks[0]
        self.assertEqual(remedial_task["type"], "practice")
        self.assertEqual(remedial_task["href"], "/a3/assessment?practice=root%20locus%20remediation")
        self.assertIn("补救", remedial_task["title"])
        self.assertEqual(remedial_task["metadata"]["strategy"], "increase_practice")

    def test_completed_resource_feedback_writes_mastery_reinforcement_to_study_plan(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"days": 7}),
            content_type="application/json",
        )
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus mastery"}),
            content_type="application/json",
        )
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        feedback_response = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "completed", "resourceType": "lecture_doc", "score": 90}),
            content_type="application/json",
        )

        self.assertEqual(feedback_response.status_code, 200)
        refreshed = LearnerProfile.objects.get(user=self.user)
        plan = refreshed.extra_profile["studyPlan"]
        adjustment = plan["lastResourceFeedbackAdjustment"]
        self.assertEqual(adjustment["strategy"], "reinforce_mastery")
        self.assertEqual(adjustment["evidence"]["averageFeedbackScore"], 90)
        tasks = [
            task
            for day in plan["days"]
            for task in day.get("tasks", [])
            if isinstance(task, dict)
        ]
        reinforcement_tasks = [
            task
            for task in tasks
            if task.get("metadata", {}).get("generatedBy") == "resource_feedback_adjustment"
        ]
        self.assertEqual(len(reinforcement_tasks), 1)
        self.assertEqual(reinforcement_tasks[0]["type"], "summary")
        self.assertEqual(reinforcement_tasks[0]["metadata"]["strategy"], "reinforce_mastery")
        self.assertEqual(adjustment["nextAction"]["href"], "/a3/today")

    def test_resource_feedback_persists_agent_trace_for_plan_writeback(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"days": 7}),
            content_type="application/json",
        )
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "root locus remediation"}),
            content_type="application/json",
        )
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        feedback_response = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "completed", "resourceType": "practice_set", "score": 72}),
            content_type="application/json",
        )

        self.assertEqual(feedback_response.status_code, 200)
        payload = feedback_response.json()
        self.assertIn("traceId", payload)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        self.assertEqual(run.workflow, "resource_feedback")
        self.assertEqual(run.status, "completed")
        steps = list(run.steps.order_by("order"))
        self.assertEqual(
            [step.name for step in steps],
            [
                "ResourceFeedbackAgent",
                "LearningEffectAgent",
                "LearningEffectAnalyzerAgent",
                "StudyPlanAgent",
                "MemoryCommitAgent",
            ],
        )
        self.assertEqual(steps[0].metadata["inputSummary"]["action"], "completed")
        self.assertEqual(steps[1].metadata["evidence"]["averageFeedbackScore"], 72)
        self.assertIn(steps[2].metadata["outputSummary"]["source"], {"llm", "rules_fallback"})
        self.assertTrue(steps[2].metadata["quality"]["evidenceBounded"])
        self.assertEqual(steps[3].metadata["stateDiff"]["LearnerProfile.extra_profile.studyPlan"], "adjusted")
        self.assertEqual(steps[3].metadata["quality"]["strategy"], "increase_practice")
        for step in steps:
            self.assertIn("runtimePolicy", step.metadata)
            self.assertEqual(step.metadata["outputSchema"]["mode"], "agent_output")
            self.assertEqual(step.metadata["degradation"]["status"], step.status)

    def test_skipped_resource_feedback_writes_load_reduction_to_study_plan(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"days": 7}),
            content_type="application/json",
        )
        pack_response = self.client.post(
            "/api/resources/generate/",
            data=json.dumps({"goal": "frequency response"}),
            content_type="application/json",
        )
        pack_id = pack_response.json()["resourcePack"]["resourcePackId"]

        response_one = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "skipped", "resourceType": "lecture_doc"}),
            content_type="application/json",
        )
        response_two = self.client.post(
            f"/api/resources/packs/{pack_id}/feedback/",
            data=json.dumps({"action": "skipped", "resourceType": "case_study"}),
            content_type="application/json",
        )

        self.assertEqual(response_one.status_code, 200)
        self.assertEqual(response_two.status_code, 200)
        refreshed = LearnerProfile.objects.get(user=self.user)
        plan = refreshed.extra_profile["studyPlan"]
        adjustment = plan["lastResourceFeedbackAdjustment"]
        self.assertEqual(adjustment["strategy"], "reduce_load")
        tasks = [
            task
            for day in plan["days"]
            for task in day.get("tasks", [])
            if isinstance(task, dict)
        ]
        lighter_tasks = [
            task
            for task in tasks
            if task.get("metadata", {}).get("generatedBy") == "resource_feedback_adjustment"
        ]
        self.assertEqual(len(lighter_tasks), 1)
        self.assertEqual(lighter_tasks[0]["type"], "review")
        self.assertLessEqual(lighter_tasks[0]["estimatedMinutes"], 8)
        self.assertIn("轻量", lighter_tasks[0]["title"])

    @patch.dict("os.environ", {"A3_QA_REALTIME_RAG_ENABLED": "1"})
    @patch("backend.apps.compat.agent_kernel.search_knowledge_base")
    def test_qa_interact_uses_realtime_rag_sources_and_exposes_mode(self, search):
        from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

        search.return_value = [
            KnowledgeBaseSearchResult(
                score=0.93,
                text="反馈控制通过测量输出并与期望值比较，形成误差信号来调节系统行为。",
                metadata={"title": "反馈控制讲义", "resource_type": "document"},
            )
        ]

        response = self.client.get("/api/v1/qa/interact/?q=反馈控制是什么")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["retrievalMode"], "realtime_rag")
        self.assertGreater(len(payload["sources"]), 0)
        self.assertNotEqual(payload["sources"][0]["type"], "RAG")
        self.assertEqual(payload["sources"][0]["type"], payload["sources"][0]["sourceTypeLabel"])
        self.assertIn("sourceOrigin", payload["sources"][0])
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        retriever = run.steps.get(name="RetrieverAgent")
        self.assertEqual(retriever.metadata["evidence"]["retrievalMode"], "realtime_rag")

    @patch.dict("os.environ", {"A3_QA_REALTIME_RAG_ENABLED": "1"})
    @patch("backend.apps.compat.agent_kernel.search_knowledge_base")
    def test_qa_interact_uses_interactive_retrieval_budget(self, search):
        from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

        search.return_value = [
            KnowledgeBaseSearchResult(
                score=0.91,
                text="Root locus describes how closed-loop poles move as gain changes.",
                metadata={"title": "Root locus note", "resource_type": "document"},
            )
        ]

        response = self.client.get("/api/v1/qa/interact/?q=root%20locus")

        self.assertEqual(response.status_code, 200)
        search.assert_called_once()
        self.assertEqual(search.call_args.kwargs["top_k"], 5)
        self.assertEqual(search.call_args.kwargs["candidate_multiplier"], 2)
        self.assertTrue(search.call_args.kwargs["force_lexical"])
        self.assertFalse(search.call_args.kwargs["visual_use_embedding"])
        payload = response.json()
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        retriever = run.steps.get(name="RetrieverAgent")
        self.assertEqual(retriever.metadata["evidence"]["topK"], 5)
        self.assertEqual(retriever.metadata["evidence"]["candidateMultiplier"], 2)
