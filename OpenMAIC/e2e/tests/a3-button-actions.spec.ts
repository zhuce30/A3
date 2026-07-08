import { execFileSync } from 'node:child_process';
import path from 'node:path';
import JSZip from 'jszip';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const DEMO_PASSWORD = 'Demo@123456';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

function seedDemoData() {
  runManage('seed_demo_data');
}

function createReportActionNotification(marker: string) {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import NotificationType, UserNotification

user = User.objects.get(phone="${STUDENT_PHONE}")
UserNotification.objects.filter(user=user, payload__generatedBy="e2e_cross_page_report", payload__marker="${marker}").delete()
UserNotification.objects.create(
    user=user,
    title="E2E 跨页报告提醒 ${marker}",
    detail="查看学习报告并执行下周行动。",
    notification_type=NotificationType.SYSTEM,
    unread=True,
    action_url="/a3/report",
    payload={
        "generatedBy": "e2e_cross_page_report",
        "marker": "${marker}",
        "actionKind": "report",
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
from backend.apps.learning.services import assign_resource_pack_to_today, generate_study_plan

user = User.objects.get(phone="${STUDENT_PHONE}")
generate_study_plan(user, duration_days=7, force=True)
assign_resource_pack_to_today(user, {
    "schemaVersion": "a3.resource-pack.v1",
    "title": "E2E 计划变化资源包 ${marker}",
    "learningGoal": "root locus e2e plan change ${marker}",
    "estimatedMinutes": 25,
    "practice": {"href": "/a3/assessment?practice=e2e-plan-change-${marker}"},
    "nextAction": {
        "label": "进入专项练习",
        "href": "/a3/assessment?practice=e2e-plan-change-${marker}",
        "reason": "E2E 验证资源包加入今日任务后，计划解释能说明为什么任务变化。",
    },
    "evidence": {"confidence": "high", "verifiedSourceCount": 2},
})
`,
  ]);
}

function completeStudyPlanTaskForSyncEvidence() {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.learning.services import complete_study_plan_task, current_study_plan, generate_study_plan

user = User.objects.get(phone="${STUDENT_PHONE}")
plan = current_study_plan(user)
if not isinstance(plan, dict) or not plan.get("days"):
    plan = generate_study_plan(user, duration_days=7, force=True)

target_day = None
target_task = None
for day in plan.get("days") or []:
    tasks = day.get("tasks") or []
    if not isinstance(tasks, list):
        continue
    for task in tasks:
        if isinstance(task, dict) and task.get("id"):
            target_day = day
            target_task = task
            break
    if target_task:
        break

if target_day is None or target_task is None:
    raise RuntimeError("E2E study plan has no task to complete")

complete_study_plan_task(
    user,
    day_index=int(target_day.get("dayIndex") or 1),
    task_id=str(target_task.get("id")),
)
`,
  ]);
}

function createTargetedTeacherIntervention(marker: string) {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserNotification
from backend.apps.learning.services import execute_teacher_task

teacher = User.objects.get(phone="${TEACHER_PHONE}")
student = User.objects.get(phone="${STUDENT_PHONE}")
UserNotification.objects.filter(user=student, payload__generatedBy="e2e_teacher_top_context", payload__marker="${marker}").delete()
result = execute_teacher_task(
    teacher,
    "intervention",
    student_id=str(student.id),
    message="E2E teacher top notification ${marker}: review wrong notebook first.",
)
notification = UserNotification.objects.filter(
    user=student,
    payload__teacherId=str(teacher.id),
    payload__targetedByTeacher=True,
).order_by("-created_at").first()
payload = notification.payload if isinstance(notification.payload, dict) else {}
payload.update({
    "generatedBy": "e2e_teacher_top_context",
    "marker": "${marker}",
})
notification.payload = payload
notification.save(update_fields=["payload"])
print(result)
`,
  ]);
}

async function loginAsStudent(page: import('@playwright/test').Page) {
  await loginAs(page, STUDENT_PHONE);
}

async function loginAsTeacher(page: import('@playwright/test').Page) {
  await loginAs(page, TEACHER_PHONE);
}

async function loginAs(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(phone);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').first().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function buildKnowledgeXlsxBuffer(question: string, answer: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.folder('xl')?.file('workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.folder('xl')?.folder('_rels')?.file('workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);

  const headers = [
    '标准问题(80字以内，不能为空)',
    '相似问法1(80字以内)',
    '答案(2000字以内，不能为空)',
    '规则分类（20字以内，空为默认分类）',
  ];
  const row = [question, '', answer, 'E2E知识库'];
  const cell = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  zip.folder('xl')?.folder('worksheets')?.file('sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">${headers.map((value, index) => cell(`${String.fromCharCode(65 + index)}1`, value)).join('')}</row>
    <row r="2">${row.map((value, index) => cell(`${String.fromCharCode(65 + index)}2`, value)).join('')}</row>
  </sheetData>
</worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

test.describe.serial('A3 button-level actions', () => {
  test.setTimeout(180_000);

  test.beforeEach(() => {
    seedDemoData();
  });

  test('student can favorite a recommendation and see it in favorites', async ({ page }) => {
    const marker = Date.now().toString(36).slice(-5);
    createTargetedTeacherIntervention(marker);

    await loginAsStudent(page);
    await page.goto('/a3/recommendations');

    const favoriteButton = page.getByTestId('a3-recommendation-favorite').first();
    await expect(favoriteButton).toBeEnabled({ timeout: 60_000 });
    await favoriteButton.click();
    await expect(page.getByTestId('a3-recommendation-message')).toBeVisible({ timeout: 30_000 });

    await page.goto('/a3/favorites');
    await expect(page.getByTestId('a3-favorite-item').first()).toBeVisible({ timeout: 30_000 });
  });

  test('student can inspect recommendation reasons, scores, sources, and learning signals', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/recommendations');

    const row = page.getByTestId('a3-recommendation-row').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByTestId('a3-recommendation-title')).toBeVisible();
    await expect(row.getByTestId('a3-recommendation-reason')).toBeVisible();
    await expect(row.getByTestId('a3-recommendation-score')).toBeVisible();
    const rowEvidence = row.getByTestId('a3-recommendation-evidence');
    await expect(rowEvidence).toBeVisible();
    await expect(rowEvidence).toContainText('画像');
    await expect(rowEvidence).toContainText('排序');
    await expect(rowEvidence).toContainText(/证据|降级/);
    await expect(page.getByTestId('a3-recommendation-profile-signals')).toBeVisible();
    await expect(page.getByTestId('a3-recommendation-ranking-weights')).toBeVisible();
    await expect(page.getByTestId('a3-recommendation-source-list')).toBeVisible();
    await expect(page.getByTestId('a3-recommendation-source').first()).toBeVisible();
    const explainer = page.getByTestId('a3-recommendation-personalization-explainer');
    await expect(explainer).toBeVisible();
    await expect(explainer).toContainText('画像信号');
    await expect(explainer).toContainText('当前查询');
    await expect(explainer).toContainText('排序权重');
    await expect(explainer).toContainText('推荐理由');
  });

  test('student can mark all notifications as read', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/notifications');

    await expect(page.getByTestId('a3-notifications-view')).toBeVisible();
    const markAllButton = page.getByTestId('a3-notifications-read-all');
    await expect(markAllButton).toBeEnabled({ timeout: 30_000 });
    await markAllButton.click();

    await expect(markAllButton).toBeDisabled({ timeout: 30_000 });
  });

  test('student can complete a today task and receive next-step feedback', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/today');

    await expect(page.getByRole('heading', { name: '今日学习' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('今日完成度')).toBeVisible();
    await expect(page.getByText('每日复盘')).toBeVisible();

    const task = page.getByTestId('a3-today-task').first();
    await expect(task).toBeVisible({ timeout: 60_000 });

    const completeButton = task.getByTestId('a3-today-task-complete');
    await expect(completeButton).toBeEnabled({ timeout: 30_000 });
    await completeButton.click();

    await expect(page.getByTestId('a3-today-feedback')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-today-classroom-progress-sync')).toBeVisible();
    await expect(page.getByTestId('a3-today-classroom-progress-sync')).toContainText(/今日|回写任务|剩余任务/);
    await expect(page.getByTestId('a3-today-feedback-next-reason')).toContainText('为什么下一步做这个');
    await expect(page.getByTestId('a3-today-path-sync')).toBeVisible();
    await expect(page.getByTestId('a3-today-path-sync')).toContainText('学习路径');
    await expect(page.getByTestId('a3-today-report-sync')).toBeVisible();
    await expect(page.getByTestId('a3-today-report-sync')).toContainText('报告指标');
    await expect(page.getByTestId('a3-today-report-sync')).toContainText('计划完成率');
    await expect(page.getByTestId('a3-today-report-sync')).toContainText('本次变化');
    await expect(page.getByTestId('a3-today-report-sync')).toContainText(/持平|本次|\+/);
    await expect(page.getByTestId('a3-today-feedback-next-action')).toBeVisible();
    await expect(page.getByTestId('a3-today-feedback-notification-action')).toBeVisible();
    await expect(page.getByTestId('a3-today-report-action-loop')).toBeVisible();
    await expect(page.getByTestId('a3-today-report-primary-action')).toBeVisible();
    await expect(page.getByTestId('a3-today-report-loop-step').first()).toBeVisible();
    await expect(page.getByTestId('a3-today-continuity-rail')).toBeVisible();
    await expect(page.getByTestId('a3-today-continuity-notifications')).toBeVisible();
    await expect(page.getByTestId('a3-today-continuity-report')).toBeVisible();
    await expect(completeButton).toBeDisabled({ timeout: 30_000 });
  });

  test('student can move through learning path, today task, and plan duration rewrite', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/learning-path');
    await expect(page.getByTestId('a3-learning-path-plan-linkage')).toBeVisible({ timeout: 60_000 });
    const pathCompleteButton = page.getByRole('button', { name: '完成当前节点' }).first();
    await expect(pathCompleteButton).toBeEnabled({ timeout: 30_000 });
    await pathCompleteButton.click();
    await expect(page.getByTestId('a3-learning-path-plan-linkage')).toContainText(/计划进度|路径进度/, { timeout: 30_000 });

    await page.goto('/a3/today');
    const relationship = page.getByTestId('a3-today-relationship');
    await expect(relationship).toBeVisible({ timeout: 60_000 });
    await expect(relationship).toContainText('路径');
    await expect(relationship).toContainText('计划');
    await expect(relationship).toContainText('今日');
    await expect(relationship).toContainText('写回');
    const task = page.getByTestId('a3-today-task').first();
    await expect(task).toBeVisible({ timeout: 60_000 });
    const completeButton = task.getByTestId('a3-today-task-complete');
    await expect(completeButton).toBeEnabled({ timeout: 30_000 });
    await completeButton.click();
    await expect(page.getByTestId('a3-today-feedback')).toBeVisible({ timeout: 30_000 });

    await page.goto('/a3/study-plan');
    await expect(page.getByTestId('a3-study-plan-continuity')).toBeVisible({ timeout: 60_000 });
    const rewriteButton = page.getByRole('button', { name: /14 天重排/ });
    await expect(rewriteButton).toBeEnabled({ timeout: 30_000 });
    const rewriteResponse = page.waitForResponse((response) => response.url().includes('/api/learning/study-plan/generate/') && response.status() === 201);
    await rewriteButton.click();
    await rewriteResponse;
    await expect(page.getByTestId('a3-study-plan-continuity')).toContainText('路径');
    await expect(page.getByTestId('a3-study-plan-continuity')).toContainText('写回');
    await expect(page.getByTestId('a3-study-plan-period')).toContainText('14 天周期计划');
    await expect(page.getByTestId('a3-study-plan-period')).toContainText('已排 14 天');
  });

  test('student can understand study plan page core guidance', async ({ page }) => {
    const marker = `${Date.now()}`;
    assignStudyPlanResourcePackChange(marker);
    completeStudyPlanTaskForSyncEvidence();

    await loginAsStudent(page);
    await page.goto('/a3/study-plan');

    await expect(page.getByText('智学引擎').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('link', { name: /今日学习/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /学习计划/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /我的收藏/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /学习计划/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('今日计划')).toBeVisible();
    await expect(page.getByTestId('a3-study-plan-period')).toContainText(/(7|14|30) 天周期计划/);
    await expect(page.getByTestId('a3-study-plan-period')).toContainText(/已排 (7|14|30) 天/);
    await expect(page.getByTestId('a3-study-plan-period')).not.toContainText('接下来 7 天');
    await expect(page.getByText('间隔复习队列')).toBeVisible();
    await expect(page.getByTestId('a3-study-plan-rationale')).toBeVisible();
    const planExplainer = page.getByTestId('a3-study-plan-explainer');
    await expect(planExplainer).toBeVisible();
    await expect(planExplainer).toContainText('画像');
    await expect(planExplainer).toContainText('薄弱点');
    await expect(planExplainer).toContainText('节奏');
    await expect(planExplainer).toContainText('复习队列');
    await expect(page.getByTestId('a3-study-plan-today')).toBeVisible();
    await expect(page.getByTestId('a3-study-plan-classroom-progress-sync')).toBeVisible();
    await expect(page.getByTestId('a3-study-plan-classroom-progress-sync')).toContainText(/课堂回写|今日|剩余任务/);
    await expect(page.getByTestId('a3-study-plan-adjustments')).toBeVisible();
    await expect(page.getByTestId('a3-study-plan-review-queue')).toBeVisible();
    await expect(page.getByTestId('a3-study-plan-weak-mastery')).toBeVisible();
    const currentChange = page.getByTestId('a3-study-plan-current-change');
    await expect(currentChange).toBeVisible();
    await expect(currentChange).toContainText('最近任务为什么变了');
    await expect(currentChange).toContainText('资源包');
    await expect(currentChange).toContainText(marker);
    await expect(currentChange.getByTestId('a3-study-plan-current-change-action')).toHaveAttribute('href', '/a3/today');
  });

  test('student can inspect product readiness and evaluation metrics', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/recommendations');
    await expect(page.getByTestId('a3-recommendation-favorite').first()).toBeEnabled({ timeout: 60_000 });

    const statusResponsePromise = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponsePromise;

    await expect(page.getByTestId('a3-capabilities-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: '产品级学习闭环与评测指标' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '产品就绪度' })).toBeVisible();
    await expect(page.getByText('评测指标可视化')).toBeVisible();
    await expect(page.getByText('Top3 命中率')).toBeVisible();
    await expect(page.getByText('验证覆盖率')).toBeVisible();
    await expect(page.getByText('安全拒答率')).toBeVisible();
    await expect(page.getByTestId('a3-agent-trace-waterfall')).toBeVisible();
    await expect(page.getByText('Agent Trace Waterfall')).toBeVisible();
    await expect(page.getByText(/schema: a3\.agent-run\.v1|schema: legacy/).first()).toBeVisible();
    await expect(page.getByText(/fallback:/).first()).toBeVisible();
    await expect(page.getByText(/maxRetries:/).first()).toBeVisible();
  });

  test('student can use learning report as a next-week action hub', async ({ page }) => {
    const marker = `${Date.now()}`;
    assignStudyPlanResourcePackChange(marker);

    await loginAsStudent(page);
    await page.goto('/a3/report');

    await expect(page.getByTestId('a3-report-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-report-weekly-summary')).toBeVisible();
    await expect(page.getByTestId('a3-report-weekly-prescription')).toBeVisible();
    await expect(page.getByTestId('a3-report-diagnosis')).toBeVisible();
    await expect(page.getByTestId('a3-report-focus-areas')).toBeVisible();
    await expect(page.getByTestId('a3-report-completion-criteria')).toBeVisible();
    await expect(page.getByTestId('a3-report-weakness-trends')).toBeVisible();
    await expect(page.getByTestId('a3-report-weakness-trends')).toContainText(/加重|观察|改善/);
    await expect(page.getByTestId('a3-report-action-today')).toBeVisible();
    await expect(page.getByTestId('a3-report-action-review')).toBeVisible();
    await expect(page.getByTestId('a3-report-action-plan')).toBeVisible();
    await expect(page.getByTestId('a3-report-primary-action')).toBeVisible();
    await expect(page.getByTestId('a3-report-continuity-loop')).toBeVisible();
    await expect(page.getByTestId('a3-report-loop-step-today')).toBeVisible();
    await expect(page.getByTestId('a3-report-loop-step-review')).toBeVisible();
    await expect(page.getByTestId('a3-report-loop-step-plan')).toBeVisible();
    await expect(page.getByTestId('a3-report-loop-primary')).toBeVisible();
    const masteryExplanation = page.getByTestId('a3-report-wrong-mastery-explanation');
    await expect(masteryExplanation).toBeVisible();
    await expect(masteryExplanation).toContainText('待巩固');
    await expect(masteryExplanation).toContainText('已掌握');
    await expect(masteryExplanation).toContainText('错题本');
    const planChange = page.getByTestId('a3-report-plan-change');
    await expect(planChange).toBeVisible();
    await expect(planChange).toContainText('计划为什么变了');
    await expect(planChange).toContainText('资源包');
    await expect(planChange).toContainText(marker);
    await expect(planChange.getByTestId('a3-report-plan-change-action')).toHaveAttribute('href', '/a3/today');
  });

  test('student can continue from today task to notifications, report, and next plan action', async ({ page }) => {
    const marker = `${Date.now()}`;
    createReportActionNotification(marker);

    await loginAsStudent(page);
    await page.goto('/a3/today');

    const task = page.getByTestId('a3-today-task').first();
    await expect(task).toBeVisible({ timeout: 60_000 });
    const completeButton = task.getByTestId('a3-today-task-complete');
    await expect(completeButton).toBeEnabled({ timeout: 30_000 });
    await completeButton.click();

    await expect(page.getByTestId('a3-today-feedback')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('a3-today-feedback-notification-action').click();

    await expect(page).toHaveURL(/\/a3\/notifications/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-notifications-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-notification-action-report').click();

    await expect(page).toHaveURL(/\/a3\/report/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-report-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-report-action-hub')).toBeVisible();
    await page.getByTestId('a3-report-action-plan').click();

    await expect(page).toHaveURL(/\/a3\/study-plan/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /学习计划/ })).toBeVisible({ timeout: 60_000 });
  });

  test('student can retry a wrong question and see graded explanation', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/wrong-notebook');

    const item = page.getByTestId('a3-wrong-question-item').first();
    await expect(item).toBeVisible({ timeout: 60_000 });
    await item.getByTestId('a3-wrong-question-expand').click();

    await item.getByTestId('a3-wrong-option').first().click();
    await item.getByTestId('a3-wrong-retry-submit').click();

    await expect(page.getByTestId('a3-wrong-retry-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-wrong-retry-feedback')).toBeVisible();
    await expect(page.getByTestId('a3-wrong-next-review')).toBeVisible();
    await expect(page.getByTestId('a3-wrong-next-action')).toBeVisible();
    await expect(page.getByTestId('a3-wrong-study-plan-sync')).toBeVisible();
    await expect(page.getByTestId('a3-wrong-report-sync')).toBeVisible();
  });

  test('student can submit an assessment answer and continue with targeted practice', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/assessment');

    await expect(page.getByTestId('a3-assessment-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-assessment-question')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-assessment-option').first().click();
    await expect(page.getByTestId('a3-assessment-submit')).toBeEnabled();
    await page.getByTestId('a3-assessment-submit').click();

    await expect(page.getByTestId('a3-assessment-feedback')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-assessment-explanation')).toBeVisible();
    await expect(page.getByTestId('a3-assessment-plan-sync')).toBeVisible();
    await expect(page.getByTestId('a3-assessment-next-question')).toBeVisible();

    await page.getByTestId('a3-assessment-practice-input').fill('根轨迹');
    await expect(page.getByTestId('a3-assessment-practice-start')).toBeEnabled();
    await page.getByTestId('a3-assessment-practice-start').click();
    await expect(page.getByTestId('a3-assessment-practice-focus')).toContainText('根轨迹', { timeout: 30_000 });
  });

  test('teacher intervention reaches student notifications and routes to wrong notebook', async ({ page }) => {
    await loginAsTeacher(page);
    await page.goto('/a3/teacher');

    await expect(page.getByTestId('a3-teacher-workbench')).toBeVisible({ timeout: 60_000 });
    const interventionButton = page.getByTestId('a3-student-intervention').first();
    await expect(interventionButton).toBeEnabled({ timeout: 60_000 });
    await interventionButton.click();
    await expect(page.getByTestId('a3-teacher-message')).toContainText(/已向|已通知/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-teacher-intervention-evidence')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-teacher-intervention-evidence')).toContainText('通知回流');
    await expect(page.getByTestId('a3-teacher-intervention-evidence')).toContainText('目标学生');
    await expect(page.getByTestId('a3-teacher-intervention-notification-link')).toHaveAttribute('href', '/a3/notifications');

    const marker = Date.now().toString(36).slice(-5);
    createTargetedTeacherIntervention(marker);

    await loginAsStudent(page);
    await page.goto('/a3/dashboard');
    await expect(page).toHaveURL(/\/a3\/dashboard/, { timeout: 30_000 });
    await page.getByTestId('a3-top-notifications-trigger').click();
    const topPanel = page.getByTestId('a3-top-notifications-panel');
    await expect(topPanel).toBeVisible({ timeout: 30_000 });
    const topTeacherNotification = topPanel.getByTestId('a3-top-notification-item').filter({ hasText: marker }).first();
    await expect(topTeacherNotification).toBeVisible({ timeout: 60_000 });
    await expect(topTeacherNotification.getByTestId('a3-top-teacher-notification-context')).toBeVisible();

    await page.goto('/a3/notifications');
    await expect(page.getByTestId('a3-notifications-view')).toBeVisible({ timeout: 60_000 });

    const teacherNotification = page
      .getByTestId('a3-notification-item')
      .filter({ hasText: '老师发起了学习干预提醒' })
      .first();
    await expect(teacherNotification).toBeVisible({ timeout: 60_000 });
    await expect(teacherNotification).toContainText('教师提醒');
    await expect(teacherNotification.getByTestId('a3-teacher-notification-context')).toContainText('教师定向干预');
    await expect(teacherNotification.getByTestId('a3-teacher-notification-context')).toContainText('错题复盘');

    await teacherNotification.getByRole('button', { name: '前往处理' }).click();
    await expect(page).toHaveURL(/\/a3\/wrong-notebook/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-wrong-notebook-view')).toBeVisible({ timeout: 60_000 });
  });

  test('teacher can upload, index, and search a knowledge resource', async ({ page }) => {
    const now = Date.now();
    const uploadName = `a3-e2e-control-system-${now}.xlsx`;
    const question = `A3 E2E 根轨迹索引验证 ${now}`;
    const answer = '这是一个来自教师上传知识库的自动化验证答案，用于证明上传资源完成索引后可以被检索召回。';

    await loginAsTeacher(page);
    await page.goto('/a3/knowledge-base');

    await expect(page.getByTestId('a3-knowledge-base-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-kb-file-input').setInputFiles({
      name: uploadName,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildKnowledgeXlsxBuffer(question, answer),
    });
    await expect(page.getByTestId('a3-kb-upload-submit')).toBeEnabled();
    await page.getByTestId('a3-kb-upload-submit').click();

    await expect(page.getByTestId('a3-kb-message')).toContainText(/上传|索引|队列/, { timeout: 30_000 });
    const uploadedRow = page.getByTestId('a3-kb-resource-row').filter({ hasText: uploadName });
    await expect(uploadedRow).toBeVisible({ timeout: 30_000 });
    await expect(uploadedRow).toContainText('已索引', { timeout: 60_000 });
    await expect(page.getByTestId('a3-kb-job-item').first()).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('a3-kb-search-input').fill(question);
    const searchResponsePromise = page.waitForResponse((response) => response.url().includes('/api/kb/search/') && response.status() === 200);
    await page.getByTestId('a3-kb-search-submit').click();
    await searchResponsePromise;
    await expect(page.getByTestId('a3-kb-search-result').filter({ hasText: uploadName })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-kb-quality-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-kb-quality-panel')).toContainText('上传证据');
    await expect(page.getByTestId('a3-kb-quality-panel')).toContainText('索引证据');
    await expect(page.getByTestId('a3-kb-quality-panel')).toContainText('检索证据');
    await expect(page.getByTestId('a3-kb-quality-panel')).toContainText('课堂引用');
    await expect(page.getByTestId('a3-kb-quality-search-count')).toContainText(/1|2|3|4|5/);
  });

  test('student classroom can cite a teacher uploaded knowledge resource', async ({ page }) => {
    test.setTimeout(300_000);
    const now = Date.now();
    const uploadName = `a3-e2e-classroom-citation-${now}.xlsx`;
    const question = `传递函数 稳定性 根轨迹 时域响应 频率响应 A3 E2E 课堂引用 ${now}`;
    const answer = `这是教师上传知识库资源中的课堂引用验证内容，覆盖自动控制原理当前学习路径关键词 ${now}。`;

    await loginAsTeacher(page);
    await page.goto('/a3/knowledge-base');

    await expect(page.getByTestId('a3-knowledge-base-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-kb-file-input').setInputFiles({
      name: uploadName,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildKnowledgeXlsxBuffer(question, answer),
    });
    await expect(page.getByTestId('a3-kb-upload-submit')).toBeEnabled();
    await page.getByTestId('a3-kb-upload-submit').click();

    const uploadedRow = page.getByTestId('a3-kb-resource-row').filter({ hasText: uploadName });
    await expect(uploadedRow).toBeVisible({ timeout: 30_000 });
    await expect(uploadedRow).toContainText('已索引', { timeout: 60_000 });

    await loginAsStudent(page);
    await page.goto('/a3/classroom');

    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-classroom-source').filter({ hasText: uploadName })).toBeVisible({ timeout: 60_000 });
  });

  test('student can ask classroom question, save verified note, and see it in favorites', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/classroom');

    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-classroom-input').fill('根轨迹是什么？请结合当前学习目标回答');
    await page.getByTestId('a3-classroom-submit').click();

    await expect(page.getByTestId('a3-classroom-verification')).toBeVisible({ timeout: 90_000 });
    const saveButton = page.getByTestId('a3-classroom-save-note').first();
    await expect(saveButton).toBeEnabled({ timeout: 30_000 });
    await saveButton.click();
    await expect(page.getByTestId('a3-classroom-message')).toContainText('已保存为课堂笔记', { timeout: 30_000 });

    await page.goto('/a3/favorites');
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: '课堂笔记' }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('student can ask face-to-face coaching question, see verification, and save a coaching note', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/coaching');

    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });
    const responsePromise = page.waitForResponse((response) => response.url().includes('/api/a3/coaching/respond') && response.status() === 200);
    await page.getByTestId('a3-coaching-suggestion').first().click();
    await responsePromise;

    await expect(page.getByTestId('a3-coaching-message-user').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-coaching-verification')).toBeVisible({ timeout: 90_000 });

    const saveButton = page.getByTestId('a3-coaching-save-note').first();
    await expect(saveButton).toBeEnabled({ timeout: 30_000 });
    await saveButton.click();
    await expect(page.getByTestId('a3-coaching-error')).toContainText('已保存为辅导笔记', { timeout: 30_000 });

    await page.goto('/a3/favorites');
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: '辅导笔记' }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('student can recover from photo coaching without camera by switching to text', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/coaching');

    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-coaching-photo-question').click();

    await expect(page.getByTestId('a3-coaching-error')).toContainText('请先开启摄像头', { timeout: 30_000 });
    await expect(page.getByTestId('a3-coaching-start-media-from-error')).toBeVisible();
    const textFallback = page.getByTestId('a3-coaching-text-fallback').first();
    await expect(textFallback).toBeVisible();

    await textFallback.click();
    await expect(page.getByTestId('a3-coaching-error')).toHaveCount(0);
    await expect(page.getByTestId('a3-coaching-suggestion').first()).toBeEnabled();
  });
});
