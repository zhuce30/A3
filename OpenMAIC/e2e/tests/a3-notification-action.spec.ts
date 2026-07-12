import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  return execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function seedDemoData() {
  runManage('seed_demo_data');
}

function createTodayActionNotification(marker: string) {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import NotificationType, UserNotification

user = User.objects.get(phone="${STUDENT_PHONE}")
UserNotification.objects.filter(user=user, payload__generatedBy="e2e_notification_action").delete()
UserNotification.objects.create(
    user=user,
    title="E2E notification action ${marker}",
    detail="Open today's learning task from notification action.",
    notification_type=NotificationType.LEARNING_TASK,
    unread=True,
    action_url="/a3/today",
    payload={
        "generatedBy": "e2e_notification_action",
        "actionKind": "today",
        "pendingTasks": 1,
        "remainingMinutes": 15,
    },
)
`,
  ]);
}

function assignStudyPlanResourcePackChange(marker: string) {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserNotification
from backend.apps.learning.services import assign_resource_pack_to_today, generate_study_plan

user = User.objects.get(phone="${STUDENT_PHONE}")
UserNotification.objects.filter(user=user, payload__generatedBy="learning_reminder").delete()
generate_study_plan(user, duration_days=7, force=True)
assign_resource_pack_to_today(user, {
    "schemaVersion": "a3.resource-pack.v1",
    "title": "E2E notification plan change pack ${marker}",
    "learningGoal": "notification plan change ${marker}",
    "estimatedMinutes": 25,
    "practice": {"href": "/a3/assessment?practice=e2e-notification-plan-change-${marker}"},
    "nextAction": {
        "label": "Open today task",
        "href": "/a3/today",
        "reason": "E2E verifies notification explains why the plan changed.",
    },
    "evidence": {"confidence": "high", "verifiedSourceCount": 2},
})
`,
  ]);
}

function createActionKindNotifications(marker: string) {
  const rows = [
    ['today', '浠婃棩浠诲姟', '/a3/today', 'Open today task.', 'learning_task'],
    ['review', '閿欓澶嶇洏', '/a3/wrong-notebook', 'Review due mistakes.', 'assessment'],
    ['plan', '瀛︿範璁″垝', '/a3/study-plan', 'Inspect adjusted plan.', 'learning_task'],
    ['assessment', '闃舵娴嬭瘎', '/a3/assessment', 'Start assessment.', 'assessment'],
    ['report', '瀛︿範鎶ュ憡', '/a3/report', 'Read weekly report.', 'system'],
  ];
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import NotificationType, UserNotification

type_map = {
    "learning_task": NotificationType.LEARNING_TASK,
    "assessment": NotificationType.ASSESSMENT,
    "system": NotificationType.SYSTEM,
}
user = User.objects.get(phone="${STUDENT_PHONE}")
UserNotification.objects.filter(user=user, payload__generatedBy="e2e_notification_kind_matrix", payload__marker="${marker}").delete()
for kind, label, action_url, detail, type_key in ${JSON.stringify(rows)}:
    UserNotification.objects.create(
        user=user,
        title=f"E2E {label} ${marker}",
        detail=detail,
        notification_type=type_map[type_key],
        unread=True,
        action_url=action_url,
        payload={
            "generatedBy": "e2e_notification_kind_matrix",
            "marker": "${marker}",
            "actionKind": kind,
            "pendingTasks": 1,
            "remainingMinutes": 15,
            "dueReviews": 2,
        },
    )
`,
  ]);
}

function createDueWrongQuestionReminder(marker: string) {
  runManage('shell', [
    '-c',
    `
from datetime import timedelta
from django.utils import timezone
from backend.apps.accounts.models import User
from backend.apps.assessments.models import Question, WrongQuestion
from backend.apps.engagement.models import UserNotification
from backend.apps.engagement.services import ensure_learning_reminders

user = User.objects.get(phone="${STUDENT_PHONE}")
today = timezone.localdate().isoformat()
UserNotification.objects.filter(user=user, payload__generatedBy="learning_reminder", payload__actionKind="review").delete()
UserNotification.objects.filter(user=user, payload__reminderKey=f"review-due:{today}").delete()
WrongQuestion.objects.filter(user=user).update(mastered=True, review_after=timezone.now() + timedelta(days=14))
question = (
    Question.objects.select_related("knowledge_point")
    .filter(knowledge_point__title__contains="根轨迹")
    .first()
    or Question.objects.select_related("knowledge_point").first()
)
extra_question = (
    Question.objects.select_related("knowledge_point")
    .exclude(knowledge_point=question.knowledge_point)
    .first()
)
wrong, _ = WrongQuestion.objects.update_or_create(
    user=user,
    question=question,
    defaults={
        "review_after": timezone.now() - timedelta(hours=3),
        "mastered": False,
        "wrong_count": 2,
        "consecutive_correct": 0,
        "last_wrong_answer": "Z",
    },
)
if extra_question:
    WrongQuestion.objects.update_or_create(
        user=user,
        question=extra_question,
        defaults={
            "review_after": timezone.now() - timedelta(hours=2),
            "mastered": False,
            "wrong_count": 1,
            "consecutive_correct": 0,
            "last_wrong_answer": "Z",
        },
    )
notification = ensure_learning_reminders(user, plan={}, motivation={})[0]
payload = notification.payload if isinstance(notification.payload, dict) else {}
payload.update({"marker": "${marker}"})
notification.payload = payload
notification.title = f"E2E due wrong review ${marker}"
notification.detail = f"E2E due wrong question reminder ${marker}"
notification.save(update_fields=["payload", "title", "detail"])
print(str(wrong.id))
`,
  ]);
}

function getNotificationState(marker: string) {
  const output = runManage('shell', [
    '-c',
    `
import json
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserNotification

user = User.objects.get(phone="${STUDENT_PHONE}")
notification = UserNotification.objects.get(user=user, title__contains="${marker}")
print(json.dumps({"unread": notification.unread, "readAt": notification.read_at.isoformat() if notification.read_at else None}))
`,
  ]);
  return JSON.parse(output.trim().split(/\r?\n/).at(-1) || '{}') as { unread: boolean; readAt: string | null };
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

test.describe.serial('A3 notification actions', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('student action card marks notification as read before routing to today task', async ({ page }) => {
    const marker = `${Date.now()}`;
    createTodayActionNotification(marker);

    await loginAsStudent(page);
    await page.goto('/a3/notifications');

    const actionCard = page.getByTestId('a3-notification-action-today');
    await expect(actionCard).toBeVisible({ timeout: 60_000 });
    await expect(actionCard).toContainText('鏈');

    await actionCard.click();
    await expect(page).toHaveURL(/\/a3\/today/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-today-view')).toBeVisible({ timeout: 60_000 });

    const notification = getNotificationState(marker);
    expect(notification.unread).toBe(false);
    expect(notification.readAt).toBeTruthy();
  });

  test('student sees every notification action kind with reason and routable CTA', async ({ page }) => {
    const marker = `${Date.now()}`;
    createActionKindNotifications(marker);

    await loginAsStudent(page);
    await page.goto('/a3/notifications');
    await expect(page.getByTestId('a3-notifications-view')).toBeVisible({ timeout: 60_000 });

    const expected = [
      { kind: 'today', href: /\/a3\/today/ },
      { kind: 'review', href: /\/a3\/wrong-notebook/ },
      { kind: 'plan', href: /\/a3\/study-plan/ },
      { kind: 'assessment', href: /\/a3\/assessment/ },
      { kind: 'report', href: /\/a3\/report/ },
    ] as const;

    for (const item of expected) {
      const actionCard = page.getByTestId(`a3-notification-action-${item.kind}`);
      await expect(actionCard).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId(`a3-notification-action-reason-${item.kind}`)).toBeVisible();
      await expect(page.getByTestId(`a3-notification-action-cta-${item.kind}`)).toBeVisible();
      await expect(page.getByTestId(`a3-notification-action-loop-${item.kind}`)).toBeVisible();
    }

    await expect(page.getByTestId('a3-notification-rhythm')).toBeVisible();
    await expect(page.getByTestId('a3-notification-rhythm-today')).toBeVisible();
    await expect(page.getByTestId('a3-notification-rhythm-review')).toBeVisible();
    await expect(page.getByTestId('a3-notification-rhythm-report')).toBeVisible();
    await expect(page.getByTestId('a3-notification-rhythm-review')).toBeVisible();

    const reviewNotification = page.getByTestId('a3-notification-item').filter({ hasText: `E2E 閿欓澶嶇洏 ${marker}` });

    await page.getByTestId('a3-notification-action-report').click();
    await expect(page).toHaveURL(expected.find((item) => item.kind === 'report')!.href, { timeout: 30_000 });
    await expect(page.getByTestId('a3-report-view')).toBeVisible({ timeout: 60_000 });
  });

  test('student sees current plan change reason inside notification learning loop', async ({ page }) => {
    const marker = Date.now().toString(36).slice(-4);
    assignStudyPlanResourcePackChange(marker);

    await loginAsStudent(page);
    await page.goto('/a3/notifications');
    await expect(page.getByTestId('a3-notifications-view')).toBeVisible({ timeout: 60_000 });

    const planChange = page.getByTestId('a3-notification-plan-change').filter({ hasText: marker }).first();
    await expect(planChange).toBeVisible({ timeout: 60_000 });
    await expect(planChange).toContainText('plan change');
    await expect(page.getByTestId('a3-notification-action-loop-today')).toContainText(marker);
  });

  test('student opens due wrong-question reminder and reaches wrong notebook', async ({ page }) => {
    const marker = `${Date.now()}`;
    createDueWrongQuestionReminder(marker);

    await loginAsStudent(page);
    await page.goto('/a3/notifications?action=review');
    await expect(page.getByTestId('a3-notifications-view')).toBeVisible({ timeout: 60_000 });

    const reviewNotification = page.getByTestId('a3-notification-item').filter({ hasText: marker }).first();
    await expect(reviewNotification).toBeVisible({ timeout: 60_000 });
    await expect(reviewNotification.getByTestId('a3-notification-learning-loop')).toBeVisible();
    await expect(reviewNotification.getByTestId('a3-notification-review-points')).toBeVisible();
    await expect(reviewNotification.getByTestId('a3-notification-review-points')).toContainText('根轨迹');
    await expect(reviewNotification.getByTestId('a3-notification-review-points')).toContainText('反馈控制');
    const reviewAction = page.getByTestId('a3-notification-action-review');
    await expect(reviewAction).toBeVisible();
    await expect(reviewAction).toContainText('根轨迹');
    await expect(reviewAction).toContainText('+1');

    await reviewNotification.getByRole('button').last().click();
    await expect(page).toHaveURL(/\/a3\/wrong-notebook/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-wrong-notebook-view')).toBeVisible({ timeout: 60_000 });
    const dueReviewPanel = page.getByTestId('a3-wrong-due-review-panel');
    await expect(dueReviewPanel).toBeVisible();
    await expect(dueReviewPanel).toContainText('根轨迹');
    await expect(dueReviewPanel).toContainText('反馈控制');
    await expect(page.getByTestId('a3-wrong-question-item').first()).toBeVisible();
  });

  test('student opens wrong notebook directly and sees due reviews before the full queue', async ({ page }) => {
    const marker = `${Date.now()}`;
    createDueWrongQuestionReminder(marker);

    await loginAsStudent(page);
    await page.goto('/a3/wrong-notebook');
    await expect(page.getByTestId('a3-wrong-notebook-view')).toBeVisible({ timeout: 60_000 });

    const dueReviewPanel = page.getByTestId('a3-wrong-due-review-panel');
    await expect(dueReviewPanel).toBeVisible();
    await expect(dueReviewPanel).toContainText('根轨迹');
    await expect(dueReviewPanel).toContainText('反馈控制');

    const panelTop = await dueReviewPanel.evaluate((node) => node.getBoundingClientRect().top);
    const firstQueueItemTop = await page.getByTestId('a3-wrong-question-item').first().evaluate((node) => node.getBoundingClientRect().top);
    expect(panelTop).toBeLessThan(firstQueueItemTop);

    await dueReviewPanel.getByRole('button').first().click();
    const focusedItem = page.getByTestId('a3-wrong-question-item').first();
    await expect(focusedItem).toHaveAttribute('data-focused-review', 'true');
    await expect(focusedItem.getByTestId('a3-wrong-option').first()).toBeVisible();
  });

  test('student sees learning loop guidance in top notification dropdown', async ({ page }) => {
    const marker = `${Date.now()}`;
    createTodayActionNotification(marker);

    await loginAsStudent(page);
    await page.goto('/a3/dashboard');
    await expect(page).toHaveURL(/\/a3\/dashboard/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-top-notifications-trigger')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-top-notifications-trigger').click();
    const panel = page.getByTestId('a3-top-notifications-panel');
    await expect(panel).toBeVisible();
    const notification = panel.getByTestId('a3-top-notification-item').filter({ hasText: marker });
    await expect(notification).toBeVisible();
    await expect(notification.getByTestId('a3-top-notification-learning-loop')).toBeVisible();
  });

  test('student opens due wrong-question reminder from top notification dropdown', async ({ page }) => {
    const marker = `${Date.now()}`;
    createDueWrongQuestionReminder(marker);

    await loginAsStudent(page);
    await page.goto('/a3/dashboard');
    await expect(page).toHaveURL(/\/a3\/dashboard/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-top-notifications-trigger')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-top-notifications-trigger').click();
    const panel = page.getByTestId('a3-top-notifications-panel');
    await expect(panel).toBeVisible();
    const notification = panel.getByTestId('a3-top-notification-item').filter({ hasText: marker }).first();
    await expect(notification).toBeVisible({ timeout: 60_000 });
    await expect(notification.getByTestId('a3-top-notification-learning-loop')).toBeVisible();
    await expect(notification.getByTestId('a3-top-review-notification-context')).toBeVisible();
    await expect(notification.getByTestId('a3-top-review-notification-context')).toContainText('根轨迹');
    await expect(notification.getByTestId('a3-top-review-notification-context')).toContainText('+1');

    await notification.click();
    await expect(page).toHaveURL(/\/a3\/wrong-notebook/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-wrong-notebook-view')).toBeVisible({ timeout: 60_000 });
  });

  test('student sees current plan change inside top notification dropdown', async ({ page }) => {
    const marker = Date.now().toString(36).slice(-4);
    assignStudyPlanResourcePackChange(marker);

    await loginAsStudent(page);
    await page.goto('/a3/dashboard');
    await expect(page).toHaveURL(/\/a3\/dashboard/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-top-notifications-trigger')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-top-notifications-trigger').click();
    const panel = page.getByTestId('a3-top-notifications-panel');
    await expect(panel).toBeVisible();
    const notification = panel.getByTestId('a3-top-notification-item').filter({ hasText: marker }).first();
    await expect(notification).toBeVisible({ timeout: 60_000 });
    await expect(notification.getByTestId('a3-top-notification-plan-change')).toContainText(marker);
  });
});
