from __future__ import annotations

import json
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.assessments.models import Question, WrongQuestion
from backend.apps.engagement.models import NotificationType, UserFavorite, UserNotification
from backend.apps.engagement.services import create_notification, ensure_learning_reminders, serialize_notification
from backend.apps.learning.models import Course
from backend.apps.learning.services import assign_resource_pack_to_today, generate_learning_path, generate_study_plan
from backend.apps.profiles.models import LearnerProfile


class EngagementApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800001001", password="Password123", display_name="测试同学")
        self.client = Client()
        self.client.force_login(self.user)

    def test_notifications_generate_actionable_learning_reminders_once(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="基础", daily_study_time=60)
        generate_learning_path(self.user, Course.objects.get(code="AUTO-CONTROL-001"))
        generate_study_plan(self.user, duration_days=7, force=True)

        first = self.client.get("/api/engagement/notifications/")
        second = self.client.get("/api/engagement/notifications/")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        first_payload = first.json()
        second_payload = second.json()
        self.assertTrue(first_payload["success"])
        self.assertGreaterEqual(first_payload["summary"]["unread"], 1)
        self.assertGreaterEqual(len(first_payload["notifications"]), 1)
        self.assertTrue(
            any(item["actionUrl"] in {"/a3/today", "/a3/wrong-notebook"} for item in first_payload["notifications"])
        )
        self.assertEqual(first_payload["summary"]["total"], second_payload["summary"]["total"])

    def test_mark_all_read_updates_real_notifications(self):
        create_notification(
            self.user,
            title="阶段测评已生成",
            detail="系统已根据当前学习路径生成题目。",
            notification_type=NotificationType.ASSESSMENT,
            action_url="/a3/assessment",
        )

        response = self.client.post("/api/engagement/notifications/read-all/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["summary"]["unread"], 0)
        self.assertEqual(UserNotification.objects.filter(user=self.user, unread=True).count(), 0)

    def test_notifications_can_filter_by_action_kind(self):
        create_notification(
            self.user,
            title="今日任务待完成",
            detail="还有 2 个任务。",
            notification_type=NotificationType.LEARNING_TASK,
            action_url="/a3/today",
            payload={"actionKind": "today"},
        )
        create_notification(
            self.user,
            title="错题复习到期",
            detail="有 1 个错题需要复盘。",
            notification_type=NotificationType.ASSESSMENT,
            action_url="/a3/wrong-notebook",
            payload={"actionKind": "review"},
        )

        response = self.client.get("/api/engagement/notifications/?action=today")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(len(payload["notifications"]), 1)
        self.assertEqual(payload["notifications"][0]["payload"]["actionKind"], "today")

    def test_notifications_return_action_groups_with_primary_actions(self):
        create_notification(
            self.user,
            title="今日任务待完成",
            detail="还有 2 个任务。",
            notification_type=NotificationType.LEARNING_TASK,
            action_url="/a3/today",
            payload={"actionKind": "today", "pendingTasks": 2, "remainingMinutes": 30},
        )
        create_notification(
            self.user,
            title="错题复习到期",
            detail="有 1 个错题需要复盘。",
            notification_type=NotificationType.ASSESSMENT,
            action_url="/a3/wrong-notebook",
            payload={"actionKind": "review", "dueReviews": 1},
        )

        response = self.client.get("/api/engagement/notifications/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("actionGroups", payload)
        kinds = {item["kind"] for item in payload["actionGroups"]}
        self.assertIn("today", kinds)
        self.assertIn("review", kinds)
        today_group = next(item for item in payload["actionGroups"] if item["kind"] == "today")
        self.assertEqual(today_group["primaryAction"]["href"], "/a3/today")
        self.assertEqual(today_group["count"], 1)
        self.assertEqual(today_group["unread"], 1)
        self.assertIn("recent", today_group)

    def test_notifications_include_learning_loop_guidance(self):
        create_notification(
            self.user,
            title="错题复习到期",
            detail="有 2 个错题需要复盘。",
            notification_type=NotificationType.ASSESSMENT,
            action_url="/a3/wrong-notebook",
            payload={"actionKind": "review", "dueReviews": 2},
        )

        response = self.client.get("/api/engagement/notifications/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        notification = payload["notifications"][0]
        loop = notification["learningLoop"]
        self.assertEqual(loop["schemaVersion"], "a3.notification-loop.v1")
        self.assertEqual(loop["kind"], "review")
        self.assertEqual(loop["nextAction"]["href"], "/a3/wrong-notebook")
        self.assertIn("为什么提醒", loop["reason"])
        self.assertIn("完成后反馈", loop["expectedFeedback"])
        review_group = next(item for item in payload["actionGroups"] if item["kind"] == "review")
        self.assertEqual(review_group["learningLoop"]["kind"], "review")
        self.assertEqual(review_group["learningLoop"]["nextAction"]["href"], "/a3/wrong-notebook")

    def test_rollover_reminder_uses_plan_specific_guidance(self):
        today = timezone.localdate().isoformat()
        previous_day = (timezone.localdate() - timedelta(days=1)).isoformat()

        ensure_learning_reminders(
            self.user,
            plan={
                "days": [{
                    "date": today,
                    "tasks": [{
                        "id": "rollover-task-1",
                        "title": "复习死锁检测",
                        "status": "pending",
                        "rolledOverFrom": previous_day,
                    }],
                }],
                "reviewQueue": [],
            },
            motivation={"todayRemainingMinutes": 30, "streakDays": 1, "todayTotalTasks": 1},
        )
        ensure_learning_reminders(
            self.user,
            plan={
                "days": [{
                    "date": today,
                    "tasks": [
                        {
                            "id": "rollover-task-1",
                            "title": "复习死锁检测",
                            "status": "pending",
                            "rolledOverFrom": previous_day,
                        },
                        {
                            "id": "rollover-task-2",
                            "title": "完成银行家算法练习",
                            "status": "pending",
                            "rolledOverFrom": previous_day,
                        },
                    ],
                }],
                "reviewQueue": [],
            },
            motivation={"todayRemainingMinutes": 55, "streakDays": 1, "todayTotalTasks": 2},
        )

        reminder = UserNotification.objects.get(user=self.user, title="有顺延任务需要处理")
        payload = serialize_notification(reminder)
        self.assertEqual(reminder.action_url, "/a3/study-plan")
        self.assertEqual(reminder.payload["actionKind"], "plan")
        self.assertEqual(reminder.payload["rolloverTasks"], 2)
        self.assertIn("2 个任务", reminder.detail)
        self.assertEqual(payload["learningLoop"]["kind"], "plan")
        self.assertIn("2 个顺延任务", payload["learningLoop"]["reason"])

    def test_learning_reminder_learning_loop_includes_current_plan_change(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="鍩虹", daily_study_time=60)
        generate_learning_path(self.user, Course.objects.get(code="AUTO-CONTROL-001"))
        generate_study_plan(self.user, duration_days=7, force=True)
        assign_resource_pack_to_today(
            self.user,
            {
                "title": "E2E notif plan-change-marker",
                "learningGoal": "notification plan change marker",
                "estimatedMinutes": 25,
                "nextAction": {
                    "label": "Open today task",
                    "href": "/a3/today",
                    "reason": "Use notification plan-change guidance to return to today tasks.",
                },
                "evidence": {"confidence": "high", "verifiedSourceCount": 2},
            },
        )

        response = self.client.get("/api/engagement/notifications/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        today_notification = next(item for item in payload["notifications"] if item["actionUrl"] == "/a3/today")
        plan_change = today_notification["learningLoop"]["planChange"]
        self.assertEqual(plan_change["schemaVersion"], "a3.notification-plan-change.v1")
        self.assertEqual(plan_change["currentChange"]["type"], "resource_pack")
        self.assertIn("plan-change-marker", plan_change["currentChange"]["detail"])
        self.assertEqual(plan_change["nextAction"]["href"], "/a3/today")
        today_group = next(item for item in payload["actionGroups"] if item["kind"] == "today")
        self.assertEqual(today_group["learningLoop"]["planChange"]["currentChange"]["type"], "resource_pack")

    def test_notifications_generate_review_reminder_from_due_wrong_questions_without_plan_queue(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="鍩虹", daily_study_time=60)
        question = Question.objects.select_related("knowledge_point").first()
        wrong = WrongQuestion.objects.create(
            user=self.user,
            question=question,
            review_after=timezone.now() - timedelta(hours=1),
            mastered=False,
        )

        response = self.client.get("/api/engagement/notifications/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        review_notification = next(item for item in payload["notifications"] if item["actionUrl"] == "/a3/wrong-notebook")
        self.assertEqual(review_notification["payload"]["actionKind"], "review")
        self.assertEqual(review_notification["payload"]["dueReviews"], 1)
        self.assertEqual(review_notification["payload"]["wrongQuestionIds"], [str(wrong.id)])
        self.assertEqual(review_notification["payload"]["knowledgePoints"], [wrong.question.knowledge_point.title])
        self.assertEqual(review_notification["learningLoop"]["kind"], "review")
        review_group = next(item for item in payload["actionGroups"] if item["kind"] == "review")
        self.assertEqual(review_group["primaryAction"]["href"], "/a3/wrong-notebook")

    def test_learning_path_notifications_are_grouped_as_plan_actions(self):
        create_notification(
            self.user,
            title="学习路径已更新",
            detail="请查看当前路径节点。",
            notification_type=NotificationType.LEARNING_TASK,
            action_url="/a3/learning-path",
            payload={},
        )

        response = self.client.get("/api/engagement/notifications/")

        self.assertEqual(response.status_code, 200)
        kinds = {item["kind"] for item in response.json()["actionGroups"]}
        self.assertIn("plan", kinds)
        self.assertNotIn("today", kinds)

    def test_create_and_delete_favorite(self):
        response = self.client.post(
            "/api/engagement/favorites/create/",
            data=json.dumps({"title": "根轨迹错题讲解", "type": "video", "source": "课堂", "group": "根轨迹法"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        favorite_id = response.json()["favorite"]["id"]

        response = self.client.get("/api/engagement/favorites/?group=根轨迹法")
        self.assertEqual(response.status_code, 200)
        titles = {item["title"] for item in response.json()["favorites"]}
        self.assertIn("根轨迹错题讲解", titles)

        response = self.client.delete(f"/api/engagement/favorites/{favorite_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(UserFavorite.objects.filter(id=favorite_id).exists())

    def test_dashboard_generates_learning_reminders_once(self):
        LearnerProfile.objects.create(user=self.user, foundation_level="基础", daily_study_time=60)
        generate_learning_path(self.user, Course.objects.get(code="AUTO-CONTROL-001"))
        generate_study_plan(self.user, duration_days=7, force=True)

        first = self.client.get("/api/learning/dashboard/")
        second = self.client.get("/api/learning/dashboard/")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertGreaterEqual(first.json()["motivation"]["newReminders"], 1)
        self.assertEqual(second.json()["motivation"]["newReminders"], 0)
        self.assertGreaterEqual(
            UserNotification.objects.filter(user=self.user, payload__generatedBy="learning_reminder").count(),
            1,
        )
