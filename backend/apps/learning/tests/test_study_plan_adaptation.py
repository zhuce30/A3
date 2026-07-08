import json
import importlib
from datetime import timedelta

from django.apps import apps
from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserNotification
from backend.apps.learning.models import Chapter, Course, KnowledgePoint, ResourcePackLog
from backend.apps.learning.services import generate_learning_path, generate_study_plan
from backend.apps.profiles.models import LearnerProfile


MOJIBAKE_MARKERS = ("鏅", "瀛", "璇", "閿", "鐭", "婕", "绋", "鍏", "濂", "涓", "鍔", "棰", "鑷", "�")


def assert_no_mojibake(testcase: TestCase, value):
    if isinstance(value, dict):
        for item in value.values():
            assert_no_mojibake(testcase, item)
        return
    if isinstance(value, list):
        for item in value:
            assert_no_mojibake(testcase, item)
        return
    if isinstance(value, str):
        for marker in MOJIBAKE_MARKERS:
            testcase.assertNotIn(marker, value)


class StudyPlanAdaptationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800005555", password="TestPassword123")
        LearnerProfile.objects.create(user=self.user, foundation_level="基础", daily_study_time=60)
        self.course = Course.objects.get(code="AUTO-CONTROL-001")
        self.client = Client()
        self.client.force_login(self.user)

    def test_missed_tasks_roll_over_to_today(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        yesterday = timezone.localdate() - timedelta(days=1)
        today = timezone.localdate()
        plan["days"][0]["date"] = yesterday.isoformat()
        plan["days"][1]["date"] = today.isoformat()
        plan["days"][0]["tasks"][0]["status"] = "pending"
        profile = self.user.learner_profile
        extra_profile = profile.extra_profile
        extra_profile["studyPlan"] = plan
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])

        response = self.client.get("/api/learning/study-plan/")

        self.assertEqual(response.status_code, 200)
        refreshed = response.json()["plan"]
        today_day = next(day for day in refreshed["days"] if day["date"] == today.isoformat())
        rollover_tasks = [task for task in today_day["tasks"] if task.get("rolledOverFrom")]
        self.assertGreaterEqual(len(rollover_tasks), 1)
        self.assertEqual(rollover_tasks[0]["rolledOverFrom"]["date"], yesterday.isoformat())
        rollover_events = [
            event
            for event in refreshed.get("adjustmentTimeline", [])
            if event.get("type") == "rollover"
        ]
        self.assertGreaterEqual(len(rollover_events), 1)
        self.assertIn("顺延", rollover_events[0]["title"])
        explanation = refreshed["explanation"]
        self.assertEqual(explanation["currentChange"]["id"], rollover_events[0]["id"])
        self.assertEqual(explanation["currentChange"]["type"], "rollover")
        self.assertEqual(explanation["nextAction"]["href"], "/a3/today")

    def test_generated_plan_includes_adaptive_policy(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        policy = response.json()["plan"]["adaptivePolicy"]
        self.assertIn(policy["mode"], {"reduced_load", "standard", "accelerated"})
        self.assertTrue(policy["rolloverEnabled"])
        timeline = response.json()["plan"]["adjustmentTimeline"]
        self.assertGreaterEqual(len(timeline), 2)
        self.assertEqual(timeline[0]["type"], "policy")
        self.assertIn("reason", timeline[0])
        explanation = response.json()["plan"]["explanation"]
        self.assertIn("profileSignals", explanation)
        self.assertIn("loadPolicy", explanation)
        self.assertIn("weakPointPolicy", explanation)
        self.assertIn("reviewPolicy", explanation)
        self.assertEqual(explanation["loadPolicy"]["dailyMinutes"], policy["dailyMinutes"])

    def test_generated_plan_includes_personal_material_tasks(self):
        profile = self.user.learner_profile
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        extra_profile["personalMaterials"] = [
            {
                "resourceId": "resource-123",
                "resourceName": "student-note.pdf",
                "summary": "个人上传笔记包含根轨迹薄弱点。",
                "recommendedTasks": [
                    {
                        "title": "复习：根轨迹",
                        "reason": "来自你上传的资料《student-note.pdf》，建议优先梳理该知识点。",
                        "sourceResourceId": "resource-123",
                        "sourceScope": "personal",
                    }
                ],
            }
        ]
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])

        plan = generate_study_plan(self.user, duration_days=7, force=True)

        personal_tasks = [
            task
            for task in plan["days"][0]["tasks"]
            if task.get("source") == "personal_material"
        ]
        self.assertEqual(len(personal_tasks), 1)
        self.assertEqual(personal_tasks[0]["sourceResourceId"], "resource-123")
        self.assertEqual(personal_tasks[0]["sourceScope"], "personal")
        self.assertIn("个人资料", plan["adjustmentTimeline"][0]["title"])

    def test_generated_plan_exposes_path_today_and_duration_context(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 14, "force": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        context = plan["planContext"]
        self.assertEqual(context["schemaVersion"], "a3.study-plan-context.v1")
        self.assertEqual(context["learningPath"]["source"], "active_learning_path")
        self.assertGreaterEqual(context["learningPath"]["totalItems"], 1)
        self.assertIn("currentItem", context["learningPath"])
        self.assertGreaterEqual(len(context["todayBindings"]), 1)
        self.assertEqual({item["days"] for item in context["durationOptions"]}, {7, 14, 30})
        selected = [item for item in context["durationOptions"] if item["selected"]]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["days"], 14)
        self.assertEqual([item["name"] for item in context["agentRoles"]], ["DiagnosticAgent", "ProfileAgent", "PlannerAgent", "StudyPlanAgent", "DailySessionAgent"])

        today_point_ids = {task["knowledgePointId"] for task in plan["days"][0]["tasks"] if task["knowledgePointId"]}
        binding_point_ids = {item["knowledgePointId"] for item in context["todayBindings"] if item["knowledgePointId"]}
        self.assertTrue(today_point_ids.issubset(binding_point_ids))

    def test_task_completion_refreshes_plan_context_path_progress(self):
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
        context = response.json()["plan"]["planContext"]
        matching = [
            item
            for item in context["todayBindings"]
            if item["taskId"] == learn_task["id"] and item["knowledgePointId"] == learn_task["knowledgePointId"]
        ]
        self.assertEqual(len(matching), 1)
        self.assertGreaterEqual(matching[0]["pathProgress"], 60)

    def test_task_completion_returns_learning_loop_evidence(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        task = plan["days"][0]["tasks"][0]

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        feedback = response.json()["feedback"]
        evidence = feedback["loopEvidence"]
        self.assertEqual(evidence["schemaVersion"], "a3.learning-loop-evidence.v1")
        self.assertEqual(evidence["trigger"], "today_task_complete")
        self.assertEqual(evidence["subject"]["taskId"], task["id"])
        targets = {item["target"]: item for item in evidence["writeBacks"]}
        self.assertEqual(targets["study_plan"]["status"], "updated")
        self.assertEqual(targets["learning_path"]["status"], "updated")
        self.assertEqual(targets["report"]["status"], "derived")
        self.assertEqual(targets["notifications"]["status"], "created")
        self.assertTrue(evidence["nextAction"]["href"].startswith("/a3/"))

    def test_profile_weak_point_changes_first_plan_task_focus(self):
        course = Course.objects.create(code="PLAN-PERSONALIZATION", title="计划个性化测试课")
        chapter = Chapter.objects.create(course=course, order=1, title="画像适配章节")
        points = [
            KnowledgePoint.objects.create(
                chapter=chapter,
                code="PLAN-PERSONALIZATION-A",
                order=1,
                title="状态空间建模",
                difficulty=2,
                estimated_minutes=25,
            ),
            KnowledgePoint.objects.create(
                chapter=chapter,
                code="PLAN-PERSONALIZATION-B",
                order=2,
                title="频域校正设计",
                difficulty=3,
                estimated_minutes=35,
            ),
        ]
        first_tasks = []
        for index, point in enumerate(points, start=1):
            user = User.objects.create_user(phone=f"1380000660{index}", password="TestPassword123")
            LearnerProfile.objects.create(
                user=user,
                foundation_level="基础较弱",
                daily_study_time=45,
                weak_points=[point.title],
                learning_goals=["补齐自动控制基础"],
            )
            generate_learning_path(user, course, force=True)
            self.client.force_login(user)
            response = self.client.post(
                "/api/learning/study-plan/generate/",
                data=json.dumps({"durationDays": 7, "force": True}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 201)
            first_tasks.append(response.json()["plan"]["days"][0]["tasks"][0])

        self.assertIn(points[0].title, first_tasks[0]["title"])
        self.assertIn(points[1].title, first_tasks[1]["title"])
        self.assertNotEqual(first_tasks[0]["title"], first_tasks[1]["title"])

    def test_generated_plan_user_facing_copy_is_readable_chinese(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        assert_no_mojibake(self, {
            "title": plan["title"],
            "course": plan["course"],
            "level": plan["level"],
            "adaptivePolicy": plan["adaptivePolicy"],
            "coachTip": plan["coachTip"],
            "adjustmentTimeline": plan["adjustmentTimeline"],
            "days": plan["days"],
            "reviewQueue": plan["reviewQueue"],
        })
        self.assertIn("学习计划", plan["title"])
        self.assertGreaterEqual(len(plan["days"][0]["tasks"]), 1)
        self.assertIn("reason", plan["adjustmentTimeline"][0])

    def test_task_completion_returns_feedback(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        task = plan["days"][0]["tasks"][0]

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("feedback", payload)
        self.assertEqual(payload["feedback"]["taskId"], task["id"])
        self.assertIn("nextAction", payload["feedback"])
        self.assertIn("nextStepReason", payload["feedback"])
        self.assertIn("celebration", payload["feedback"])
        self.assertIn("reward", payload["feedback"])
        self.assertIn("remainingTasks", payload["feedback"])
        self.assertFalse(payload["feedback"]["dailyClosed"])
        self.assertGreaterEqual(len(payload["feedback"]["motivators"]), 1)
        self.assertIn("lastTaskFeedback", payload["plan"])

    def test_resource_pack_can_be_assigned_to_today_plan(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        pack = {
            "schemaVersion": "a3.resource-pack.v1",
            "title": "root locus 学习资源包",
            "learningGoal": "root locus",
            "estimatedMinutes": 45,
            "practice": {
                "href": "/a3/assessment?practice=root%20locus",
            },
            "nextAction": {
                "label": "进入 AI 课堂讲解",
                "href": "/a3/classroom",
                "reason": "先学习资源包，再进入专项练习。",
            },
            "evidence": {
                "confidence": "medium",
                "verifiedSourceCount": 1,
            },
        }

        response = self.client.post(
            "/api/learning/study-plan/resource-pack/assign/",
            data=json.dumps({"resourcePack": pack}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["task"]["type"], "resource_pack")
        self.assertEqual(payload["task"]["title"], "root locus 学习资源包")
        self.assertEqual(payload["task"]["href"], "/a3/assessment?practice=root%20locus")
        self.assertEqual(payload["task"]["metadata"]["resourcePack"]["learningGoal"], "root locus")
        today = payload["plan"]["days"][0]
        resource_tasks = [task for task in today["tasks"] if task["type"] == "resource_pack"]
        self.assertEqual(len(resource_tasks), 1)
        explanation = payload["plan"]["explanation"]
        self.assertEqual(explanation["currentChange"]["type"], "resource_pack")
        self.assertEqual(explanation["nextAction"]["href"], "/a3/today")
        self.assertEqual(explanation["adjustments"][0]["type"], "resource_pack")

        second = self.client.post(
            "/api/learning/study-plan/resource-pack/assign/",
            data=json.dumps({"resourcePack": pack}),
            content_type="application/json",
        )
        self.assertEqual(second.status_code, 200)
        today_again = second.json()["plan"]["days"][0]
        resource_tasks_again = [task for task in today_again["tasks"] if task["type"] == "resource_pack"]
        self.assertEqual(len(resource_tasks_again), 1)

    def test_resource_pack_completion_returns_pack_specific_feedback(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        pack = {
            "schemaVersion": "a3.resource-pack.v1",
            "title": "root locus 学习资源包",
            "learningGoal": "root locus",
            "estimatedMinutes": 45,
            "practice": {
                "href": "/a3/assessment?practice=root%20locus",
            },
            "nextAction": {
                "label": "进入 AI 课堂讲解",
                "href": "/a3/classroom",
                "reason": "先学习资源包，再进入专项练习。",
            },
            "evidence": {
                "confidence": "medium",
                "verifiedSourceCount": 1,
            },
        }
        assign_response = self.client.post(
            "/api/learning/study-plan/resource-pack/assign/",
            data=json.dumps({"resourcePack": pack}),
            content_type="application/json",
        )
        task = assign_response.json()["task"]

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        feedback = response.json()["feedback"]
        self.assertEqual(feedback["taskType"], "resource_pack")
        self.assertEqual(feedback["nextAction"]["href"], "/a3/assessment?practice=root%20locus")
        self.assertIn("资源包", feedback["headline"])
        self.assertEqual(feedback["resourcePack"]["learningGoal"], "root locus")
        self.assertEqual(feedback["resourcePack"]["verifiedSourceCount"], 1)
        self.assertEqual(feedback["reward"]["label"], "资源包闭环")

    def test_resource_pack_completion_creates_dedicated_practice_notification(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        pack = {
            "schemaVersion": "a3.resource-pack.v1",
            "title": "Root locus resource pack",
            "learningGoal": "root locus",
            "estimatedMinutes": 45,
            "practice": {
                "href": "/a3/assessment?practice=root%20locus",
            },
            "evidence": {
                "confidence": "medium",
                "verifiedSourceCount": 2,
            },
        }
        assign_response = self.client.post(
            "/api/learning/study-plan/resource-pack/assign/",
            data=json.dumps({"resourcePack": pack}),
            content_type="application/json",
        )
        task = assign_response.json()["task"]

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        notification = UserNotification.objects.filter(
            user=self.user,
            payload__generatedBy="resource_pack_completion",
            payload__taskId=task["id"],
        ).first()
        self.assertIsNotNone(notification)
        self.assertEqual(notification.action_url, "/a3/assessment?practice=root%20locus")
        self.assertEqual(notification.payload["actionKind"], "assessment")
        self.assertEqual(notification.payload["resourcePack"]["learningGoal"], "root locus")
        self.assertEqual(notification.payload["resourcePack"]["verifiedSourceCount"], 2)

    def test_resource_pack_completion_is_recorded_in_profile_runs(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        pack = {
            "schemaVersion": "a3.resource-pack.v1",
            "title": "Root locus resource pack",
            "learningGoal": "root locus",
            "estimatedMinutes": 45,
            "practice": {
                "href": "/a3/assessment?practice=root%20locus",
            },
            "evidence": {
                "confidence": "high",
                "verifiedSourceCount": 3,
            },
        }
        assign_response = self.client.post(
            "/api/learning/study-plan/resource-pack/assign/",
            data=json.dumps({"resourcePack": pack}),
            content_type="application/json",
        )
        task = assign_response.json()["task"]

        self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        self.user.learner_profile.refresh_from_db()
        runs = self.user.learner_profile.extra_profile.get("resourcePackRuns")
        self.assertIsInstance(runs, list)
        self.assertEqual(runs[0]["taskId"], task["id"])
        self.assertEqual(runs[0]["learningGoal"], "root locus")
        self.assertEqual(runs[0]["verifiedSourceCount"], 3)
        self.assertEqual(runs[0]["confidence"], "high")
        self.assertEqual(runs[0]["practiceHref"], "/a3/assessment?practice=root%20locus")
        self.assertEqual(runs[0]["source"], "study_plan_completion")

    def test_resource_pack_completion_creates_resource_pack_log(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        pack = {
            "schemaVersion": "a3.resource-pack.v1",
            "title": "Root locus resource pack",
            "learningGoal": "root locus",
            "estimatedMinutes": 45,
            "practice": {
                "href": "/a3/assessment?practice=root%20locus",
            },
            "evidence": {
                "confidence": "high",
                "verifiedSourceCount": 3,
            },
        }
        assign_response = self.client.post(
            "/api/learning/study-plan/resource-pack/assign/",
            data=json.dumps({"resourcePack": pack}),
            content_type="application/json",
        )
        task = assign_response.json()["task"]

        self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        log = ResourcePackLog.objects.get(user=self.user, task_id=task["id"])
        self.assertEqual(log.task_title, "Root locus resource pack")
        self.assertEqual(log.learning_goal, "root locus")
        self.assertEqual(log.verified_source_count, 3)
        self.assertEqual(log.confidence, "high")
        self.assertEqual(log.practice_href, "/a3/assessment?practice=root%20locus")
        self.assertEqual(log.source, "study_plan_completion")

    def test_resource_pack_log_backfill_migration_copies_legacy_profile_runs(self):
        profile = self.user.learner_profile
        completed_at = timezone.now().isoformat()
        profile.extra_profile = {
            **(profile.extra_profile if isinstance(profile.extra_profile, dict) else {}),
            "resourcePackRuns": [
                {
                    "schemaVersion": "a3.resource-pack-run.v1",
                    "runId": "legacy-run-1",
                    "taskId": "resource-pack:legacy-root-locus",
                    "taskTitle": "Legacy root locus pack",
                    "learningGoal": "legacy root locus",
                    "verifiedSourceCount": 4,
                    "confidence": "high",
                    "practiceHref": "/a3/assessment?practice=legacy",
                    "source": "study_plan_completion",
                    "completedAt": completed_at,
                    "nextStepReason": "Backfilled from legacy profile.",
                }
            ],
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        migration = importlib.import_module("backend.apps.learning.migrations.0006_backfill_resource_pack_logs")
        migration.backfill_resource_pack_logs(apps, None)

        log = ResourcePackLog.objects.get(user=self.user, task_id="resource-pack:legacy-root-locus")
        self.assertEqual(log.task_title, "Legacy root locus pack")
        self.assertEqual(log.learning_goal, "legacy root locus")
        self.assertEqual(log.verified_source_count, 4)
        self.assertEqual(log.confidence, "high")
        self.assertEqual(log.practice_href, "/a3/assessment?practice=legacy")
        self.assertEqual(log.next_step_reason, "Backfilled from legacy profile.")

    def test_task_completion_creates_next_action_notification(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        task = plan["days"][0]["tasks"][0]

        response = self.client.post(
            "/api/learning/study-plan/tasks/complete/",
            data=json.dumps({"dayIndex": 1, "taskId": task["id"]}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        feedback = response.json()["feedback"]
        notification = UserNotification.objects.filter(
            user=self.user,
            payload__generatedBy="study_plan_completion",
            payload__taskId=task["id"],
        ).first()
        self.assertIsNotNone(notification)
        self.assertEqual(notification.action_url, feedback["nextAction"]["href"])
        self.assertIn(feedback["nextAction"]["label"], notification.detail)

    def test_completing_all_today_tasks_creates_daily_completion_prompt(self):
        response = self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        plan = response.json()["plan"]
        today = plan["days"][0]
        last_payload = None

        for task in today["tasks"]:
            response = self.client.post(
                "/api/learning/study-plan/tasks/complete/",
                data=json.dumps({"dayIndex": today["dayIndex"], "taskId": task["id"]}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200)
            last_payload = response.json()

        self.assertIsNotNone(last_payload)
        self.assertEqual(last_payload["feedback"]["nextAction"]["href"], "/a3/report")
        self.assertTrue(last_payload["feedback"]["dailyClosed"])
        self.assertEqual(last_payload["feedback"]["remainingTasks"], 0)
        self.assertIn("闭环", last_payload["feedback"]["celebration"])
        notification = UserNotification.objects.filter(
            user=self.user,
            payload__generatedBy="daily_completion",
            payload__date=timezone.localdate().isoformat(),
        ).first()
        self.assertIsNotNone(notification)
        self.assertEqual(notification.action_url, "/a3/report")

    def test_daily_reflection_is_saved_to_profile(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )

        response = self.client.post(
            "/api/learning/study-plan/reflections/",
            data=json.dumps({"summary": "I understood root locus basics.", "confusion": "Need more practice.", "confidence": 4}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertEqual(payload["reflection"]["confidence"], 4)
        self.assertGreaterEqual(len(payload["recent"]), 1)
        self.user.learner_profile.refresh_from_db()
        reflections = self.user.learner_profile.extra_profile["dailyReflections"]
        self.assertEqual(reflections[0]["summary"], "I understood root locus basics.")

    def test_dashboard_returns_motivation_summary(self):
        self.client.post(
            "/api/learning/study-plan/generate/",
            data=json.dumps({"durationDays": 7, "force": True}),
            content_type="application/json",
        )
        self.client.post(
            "/api/learning/study-plan/reflections/",
            data=json.dumps({"summary": "Kept the habit.", "confidence": 4}),
            content_type="application/json",
        )

        response = self.client.get("/api/learning/dashboard/")

        self.assertEqual(response.status_code, 200)
        motivation = response.json()["motivation"]
        self.assertIn("streakDays", motivation)
        self.assertIn("todayRemainingMinutes", motivation)
        self.assertGreaterEqual(len(motivation["badges"]), 1)
        self.assertIn("weeklyTarget", motivation)
        self.assertIn("primaryAction", motivation)
        self.assertIn("reason", motivation["primaryAction"])
        self.assertIn("weeklyCompletedTasks", motivation)
