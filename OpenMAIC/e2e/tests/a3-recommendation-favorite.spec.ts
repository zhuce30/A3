import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const PERSONALIZED_A_PHONE = '13800009992';
const PERSONALIZED_B_PHONE = '13800009993';
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

function resetRecommendationFavorites() {
  runManage('seed_demo_data');
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserFavorite

user = User.objects.get(phone="${STUDENT_PHONE}")
UserFavorite.objects.filter(user=user, group="A3 推荐资源").delete()
`,
  ]);
}

function resetPersonalizedRecommendationUsers() {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.learning.models import Chapter, Course, KnowledgePoint, LearningPath, LearningPathItem
from backend.apps.profiles.models import LearnerProfile

phones = ["${PERSONALIZED_A_PHONE}", "${PERSONALIZED_B_PHONE}"]
User.objects.filter(phone__in=phones).delete()
course, _ = Course.objects.update_or_create(
    code="E2E-REC-PERSONALIZED",
    defaults={"title": "E2E 推荐个性化课程"},
)
chapter, _ = Chapter.objects.update_or_create(
    course=course,
    order=1,
    defaults={"title": "个性化推荐章节"},
)
point_a, _ = KnowledgePoint.objects.update_or_create(
    chapter=chapter,
    code="E2E-REC-A",
    defaults={"order": 1, "title": "状态空间建模", "difficulty": 2, "estimated_minutes": 25},
)
point_b, _ = KnowledgePoint.objects.update_or_create(
    chapter=chapter,
    code="E2E-REC-B",
    defaults={"order": 2, "title": "频域校正设计", "difficulty": 3, "estimated_minutes": 35},
)
for phone, weak_point in (("${PERSONALIZED_A_PHONE}", point_a), ("${PERSONALIZED_B_PHONE}", point_b)):
    user = User.objects.create_user(phone=phone, password="${DEMO_PASSWORD}", display_name=f"E2E推荐{phone[-2:]}")
    user.phone_bound = True
    user.privacy_accepted = True
    user.profile_completed = True
    user.onboarding_step = "done"
    user.save(update_fields=["phone_bound", "privacy_accepted", "profile_completed", "onboarding_step", "updated_at"])
    LearnerProfile.objects.update_or_create(
        user=user,
        defaults={
            "foundation_level": "基础较弱",
            "daily_study_time": 45,
            "learning_goals": ["推荐排序验证"],
            "weak_points": [weak_point.title],
            "expected_resources": ["知识卡片"],
        },
    )
    path = LearningPath.objects.create(user=user, course=course, title=f"{phone} 个性化路径")
    for index, point in enumerate((point_a, point_b), start=1):
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=point,
            order=index,
            status="current" if index == 1 else "locked",
            estimated_minutes=point.estimated_minutes,
        )
`,
  ]);
}

async function loginAs(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(phone);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function loginAsStudent(page: Page) {
  await loginAs(page, STUDENT_PHONE);
}

test.describe.serial('A3 recommendation favorite flow', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    resetRecommendationFavorites();
    resetPersonalizedRecommendationUsers();
  });

  test('student can favorite a recommendation and continue to favorites', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/recommendations');

    await expect(page.getByTestId('a3-recommendation-profile-inputs')).toContainText('每日 60 分钟');
    await expect(page.getByTestId('a3-recommendation-profile-inputs')).toContainText('根轨迹');

    const firstRecommendation = page.getByTestId('a3-recommendation-row').first();
    await expect(firstRecommendation).toBeVisible({ timeout: 60_000 });
    const recommendationTitle = (await firstRecommendation.getByTestId('a3-recommendation-title').innerText()).trim();

    await firstRecommendation.getByTestId('a3-recommendation-favorite').click();
    const message = page.getByTestId('a3-recommendation-message');
    await expect(message).toBeVisible({ timeout: 30_000 });
    await expect(message).toContainText('已收藏');
    await expect(firstRecommendation.getByTestId('a3-recommendation-saved')).toContainText('已收藏');
    await expect(firstRecommendation.getByTestId('a3-recommendation-view-favorite')).toBeVisible();

    await page.goto('/a3/recommendations');
    const reloadedRecommendation = page.getByTestId('a3-recommendation-row').filter({ hasText: recommendationTitle }).first();
    await expect(reloadedRecommendation).toBeVisible({ timeout: 60_000 });
    await expect(reloadedRecommendation.getByTestId('a3-recommendation-saved')).toContainText('已收藏', { timeout: 30_000 });

    await reloadedRecommendation.getByTestId('a3-recommendation-view-favorite').click();
    await expect(page).toHaveURL(/\/a3\/favorites/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: recommendationTitle })).toBeVisible({ timeout: 60_000 });
  });

  test('different learner profiles see different recommendation ranking explanations', async ({ page }) => {
    await loginAs(page, PERSONALIZED_A_PHONE);
    await page.goto('/a3/recommendations');

    const firstProfileInputs = page.getByTestId('a3-recommendation-profile-inputs');
    const firstRecommendation = page.getByTestId('a3-recommendation-row').first();
    await expect(firstProfileInputs).toContainText('状态空间建模', { timeout: 60_000 });
    await expect(firstRecommendation.getByTestId('a3-recommendation-title')).toContainText('状态空间建模', { timeout: 60_000 });
    const firstTitle = (await firstRecommendation.getByTestId('a3-recommendation-title').innerText()).trim();

    await loginAs(page, PERSONALIZED_B_PHONE);
    await page.goto('/a3/recommendations');

    const secondProfileInputs = page.getByTestId('a3-recommendation-profile-inputs');
    const secondRecommendation = page.getByTestId('a3-recommendation-row').first();
    await expect(secondProfileInputs).toContainText('频域校正设计', { timeout: 60_000 });
    await expect(secondRecommendation.getByTestId('a3-recommendation-title')).toContainText('频域校正设计', { timeout: 60_000 });
    const secondTitle = (await secondRecommendation.getByTestId('a3-recommendation-title').innerText()).trim();

    expect(secondTitle).not.toBe(firstTitle);
  });

  test('student can switch from fast recommendations to deep retrieval mode', async ({ page }) => {
    await page.route('**/api/recommend/', async (route) => {
      const body = route.request().postDataJSON() as { mode?: string } | undefined;
      const mode = body?.mode === 'deep' ? 'deep' : 'fast';
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          traceId: `e2e-${mode}`,
          profile: {},
          target: null,
          query: '根轨迹 个性化推荐',
          profileSignals: [{ label: '薄弱点', value: '根轨迹', tone: 'orange' }],
          recommendations: [
            {
              id: `rec-${mode}`,
              rank: 1,
              title: mode === 'deep' ? '深度检索推荐资料' : '快速课堂推荐资料',
              type: '知识卡片',
              score: mode === 'deep' ? 96 : 88,
              reason: mode === 'deep' ? '深度知识库证据命中' : '快速课堂上下文命中',
              href: '/a3/learning-path',
              citation: null,
              evidence: {
                profileMatch: { matched: true, signals: ['weakPoint'], reason: '根轨迹专项突破' },
                rankingBasis: [{ label: '画像薄弱点命中', value: true }],
                sourceEvidence: null,
                fallback: false,
              },
            },
          ],
          sources: [],
          rationale: {
            strategy: 'E2E recommendation mode test',
            profileInputs: {
              foundationLevel: '基础薄弱',
              dailyMinutes: 45,
              learningGoals: ['根轨迹专项突破'],
              weakPoints: ['根轨迹'],
              expectedResources: ['知识卡片'],
              pace: 'steady',
            },
            weights: [{ label: '画像薄弱点命中', value: 1 }],
            fallbackUsed: false,
            retrievalMode: mode,
          },
        }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/recommendations');

    await expect(page.getByTestId('a3-recommendation-retrieval-mode')).toContainText('快速课堂上下文', { timeout: 60_000 });
    await expect(page.getByTestId('a3-recommendation-title').first()).toContainText('快速课堂推荐资料');

    await page.getByTestId('a3-recommendation-deep-refresh').click();

    await expect(page.getByTestId('a3-recommendation-profile-inputs')).toContainText('每日 45 分钟');
    await expect(page.getByTestId('a3-recommendation-profile-inputs')).toContainText('根轨迹专项突破');

    await expect(page.getByTestId('a3-recommendation-retrieval-mode')).toContainText('深度知识库检索', { timeout: 30_000 });
    await expect(page.getByTestId('a3-recommendation-title').first()).toContainText('深度检索推荐资料');
  });
});
