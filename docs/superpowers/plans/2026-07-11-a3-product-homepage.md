# 智学引擎 A3 产品首页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/a3` 从仪表盘重定向改为可上线的产品展示首页，以真实操作系统学习案例讲清个性化学习闭环，并提供注册、登录和评审体验入口。

**Architecture:** `/a3` 保留在现有 A3 路由树中，但作为公共页面绕过认证等待和学习后台外壳。首页组件独立放在 `components/a3/marketing/`，内容、交互、媒体和样式彼此分离；认证文件只接收评审模式和安全的登录后返回路径。所有展示素材由真实 A3 页面生成，首页本身不调用生成接口、不写业务数据。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Tailwind CSS 4、CSS Modules、Motion、Three.js/VRM（复用现有数字教师）、Vitest、Playwright。

**Approved design:** `docs/superpowers/specs/2026-07-11-a3-product-homepage-design.md`

---

## 文件边界

新增文件：

```text
OpenMAIC/components/a3/marketing/a3-homepage-content.ts
OpenMAIC/components/a3/marketing/a3-product-homepage.tsx
OpenMAIC/components/a3/marketing/a3-homepage-hero.tsx
OpenMAIC/components/a3/marketing/a3-homepage-story.tsx
OpenMAIC/components/a3/marketing/a3-homepage-teacher-stage.tsx
OpenMAIC/components/a3/marketing/a3-product-homepage.module.css
OpenMAIC/components/a3/auth/a3-review-login-panel.tsx
OpenMAIC/lib/a3/auth-navigation.ts
OpenMAIC/scripts/capture-a3-homepage-assets.mjs
OpenMAIC/tests/a3-homepage-public-route.test.ts
OpenMAIC/tests/a3-homepage-content.test.ts
OpenMAIC/tests/a3-review-login-mode.test.ts
OpenMAIC/e2e/tests/a3-product-homepage.spec.ts
OpenMAIC/public/a3/assets/homepage/profile.webp
OpenMAIC/public/a3/assets/homepage/diagnostic.webp
OpenMAIC/public/a3/assets/homepage/knowledge-base.webp
OpenMAIC/public/a3/assets/homepage/classroom.webp
OpenMAIC/public/a3/assets/homepage/teacher-workbench.webp
OpenMAIC/public/a3/assets/homepage/teacher-fallback.webp
```

修改文件：

```text
OpenMAIC/app/a3/page.tsx
OpenMAIC/app/a3/login/page.tsx
OpenMAIC/components/a3/auth/a3-auth-gate.tsx
OpenMAIC/components/a3/auth/a3-auth-pages.tsx
OpenMAIC/components/a3/layout/a3-shell.tsx
OpenMAIC/package.json
OpenMAIC/tests/a3-login-password-toggle.test.ts
OpenMAIC/e2e/tests/a3-route-smoke.spec.ts
```

职责约束：

- `a3-product-homepage.tsx` 只负责页面编排、导航和登录态 CTA。
- `a3-homepage-content.ts` 是首页全部文案、锚点和媒体路径的唯一来源。
- `a3-homepage-hero.tsx` 只负责首屏裁切界面与缓慢切换。
- `a3-homepage-story.tsx` 负责画像、诊断、知识库、课堂、证据、教师工作台和收尾章节。
- `a3-homepage-teacher-stage.tsx` 负责数字教师延迟加载、视口触发、静音状态演示和降级。
- `a3-product-homepage.module.css` 只作用于首页，不能改写全局 A3 主题变量。
- `a3-review-login-panel.tsx` 只在 `mode=review` 时渲染固定评审账号，普通登录页不含账号文案。
- `auth-navigation.ts` 集中处理内部返回路径校验，禁止开放重定向。

---

### Task 1: 建立 `/a3` 公共路由和外壳边界

**Files:**
- Modify: `OpenMAIC/components/a3/auth/a3-auth-gate.tsx`
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx`
- Create: `OpenMAIC/lib/a3/auth-navigation.ts`
- Create: `OpenMAIC/tests/a3-homepage-public-route.test.ts`

- [ ] **Step 1: 写公共路由和安全返回路径的失败测试**

创建 `OpenMAIC/tests/a3-homepage-public-route.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeA3ReturnPath } from '@/lib/a3/auth-navigation';

const root = process.cwd();
const gateSource = fs.readFileSync(
  path.join(root, 'components/a3/auth/a3-auth-gate.tsx'),
  'utf8',
);
const shellSource = fs.readFileSync(
  path.join(root, 'components/a3/layout/a3-shell.tsx'),
  'utf8',
);

describe('A3 product homepage route boundary', () => {
  it('keeps /a3 public without treating it as an auth-only guest page', () => {
    expect(gateSource).toContain("const publicPaths = new Set(['/a3'])");
    expect(gateSource).toContain('if (isPublicPath)');
    expect(gateSource).toContain('value={user ?? null}');
  });

  it('bypasses the learning workspace shell on the public homepage', () => {
    expect(shellSource).toContain('A3_SHELL_BYPASS_PATHS.has(pathname)');
  });

  it('accepts only internal A3 return paths', () => {
    expect(normalizeA3ReturnPath('/a3/coaching')).toBe('/a3/coaching');
    expect(normalizeA3ReturnPath('/a3/classroom?source=home')).toBe(
      '/a3/classroom?source=home',
    );
    expect(normalizeA3ReturnPath('/a3/login')).toBeNull();
    expect(normalizeA3ReturnPath('//evil.example/a3')).toBeNull();
    expect(normalizeA3ReturnPath('https://evil.example')).toBeNull();
    expect(normalizeA3ReturnPath('/admin')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-public-route.test.ts
```

Expected: FAIL，原因包括 `auth-navigation` 不存在、`publicPaths` 不存在，以及 Shell 仍使用旧的旁路集合。

- [ ] **Step 3: 实现安全返回路径工具**

创建 `OpenMAIC/lib/a3/auth-navigation.ts`：

```ts
const blockedReturnPaths = new Set([
  '/a3',
  '/a3/login',
  '/a3/register',
  '/a3/forgot-password',
]);

export function normalizeA3ReturnPath(value?: string | null) {
  if (!value || !value.startsWith('/a3/') || value.startsWith('//')) return null;

  const [pathname] = value.split(/[?#]/, 1);
  if (!pathname || blockedReturnPaths.has(pathname)) return null;

  return value;
}
```

- [ ] **Step 4: 将 `/a3` 从认证访客页中独立出来**

在 `a3-auth-gate.tsx` 中使用三组路径：

```ts
const publicPaths = new Set(['/a3']);
const guestPaths = new Set(['/a3/login', '/a3/register', '/a3/forgot-password']);
const flowPaths = new Set([
  '/a3/role-selection',
  '/a3/phone-binding',
  '/a3/welcome',
  '/a3/privacy',
  '/a3/profile-setup',
]);

// 组件内部
const isPublicPath = publicPaths.has(pathname);
const isGuestPath = guestPaths.has(pathname);
const isFlowPath = flowPaths.has(pathname);
```

`target` 的首个业务判断必须豁免公共首页，并把 `isPublicPath` 加入依赖：

```ts
const target = useMemo(() => {
  if (user === undefined) return null;
  if (isPublicPath) return null;
  if (!user) {
    return isGuestPath ? null : `/a3/login?next=${encodeURIComponent(pathname)}`;
  }
  const nextPath = nextPathForUser(user);
  if (isGuestPath) return nextPath;
  if (!isFlowPath && nextPath !== '/a3/dashboard') return nextPath;
  return null;
}, [isFlowPath, isGuestPath, isPublicPath, pathname, user]);
```

公共首页必须立即渲染，认证请求在后台更新用户状态：

```tsx
if (isPublicPath) {
  return (
    <A3CurrentUserContext.Provider value={user ?? null}>
      {children}
    </A3CurrentUserContext.Provider>
  );
}
```

公共首页分支放在现有 loading 分支之前；其他受保护路由仍使用 `target` 中带 `next` 的登录地址。

导出统一外壳旁路集合：

```ts
export const A3_SHELL_BYPASS_PATHS = new Set([
  ...publicPaths,
  ...guestPaths,
  ...flowPaths,
]);
```

- [ ] **Step 5: 更新 A3 Shell 使用新的旁路集合**

在 `a3-shell.tsx` 中替换导入与判断：

```ts
import {
  A3_SHELL_BYPASS_PATHS,
  useA3CurrentUser,
} from '@/components/a3/auth/a3-auth-gate';

if (A3_SHELL_BYPASS_PATHS.has(pathname)) return <>{children}</>;
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-public-route.test.ts tests/a3-navigation-consolidation.test.ts
```

Expected: 两个测试文件全部 PASS。

- [ ] **Step 7: 提交公共路由边界**

```powershell
git add -- OpenMAIC/components/a3/auth/a3-auth-gate.tsx OpenMAIC/components/a3/layout/a3-shell.tsx OpenMAIC/lib/a3/auth-navigation.ts OpenMAIC/tests/a3-homepage-public-route.test.ts
git commit -m "feat: expose the A3 product homepage route"
```

---

### Task 2: 增加隔离的评审登录模式和登录后返回

**Files:**
- Create: `OpenMAIC/components/a3/auth/a3-review-login-panel.tsx`
- Modify: `OpenMAIC/app/a3/login/page.tsx`
- Modify: `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`
- Modify: `OpenMAIC/tests/a3-login-password-toggle.test.ts`
- Create: `OpenMAIC/tests/a3-review-login-mode.test.ts`

- [ ] **Step 1: 写评审模式失败测试**

创建 `OpenMAIC/tests/a3-review-login-mode.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const loginPage = fs.readFileSync(path.join(root, 'app/a3/login/page.tsx'), 'utf8');
const authPages = fs.readFileSync(
  path.join(root, 'components/a3/auth/a3-auth-pages.tsx'),
  'utf8',
);
const reviewPanel = fs.readFileSync(
  path.join(root, 'components/a3/auth/a3-review-login-panel.tsx'),
  'utf8',
);

describe('A3 review login mode', () => {
  it('derives review mode and a safe return target from search params', () => {
    expect(loginPage).toContain("mode === 'review'");
    expect(loginPage).toContain('normalizeA3ReturnPath(next)');
    expect(loginPage).toContain('<LoginPage reviewMode={reviewMode} returnTo={returnTo} />');
  });

  it('keeps review credentials inside the review-only panel', () => {
    expect(reviewPanel).toContain("const REVIEW_IDENTIFIER = '13800000001'");
    expect(reviewPanel).toContain("const REVIEW_PASSWORD = 'Demo@123456'");
    expect(reviewPanel).toContain('一键填入评审账号');
    expect(reviewPanel).toContain('data-testid="a3-review-fill-account"');
    expect(authPages).not.toContain("const REVIEW_PASSWORD = 'Demo@123456'");
  });

  it('lets LoginPage prefer an approved return target after onboarding', () => {
    expect(authPages).toContain('reviewMode = false');
    expect(authPages).toContain('returnTo?: string | null');
    expect(authPages).toContain('result.user?.profileCompleted && returnTo');
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-review-login-mode.test.ts tests/a3-login-password-toggle.test.ts
```

Expected: 新测试 FAIL；旧测试保持 PASS。

- [ ] **Step 3: 创建评审专用账号面板**

创建 `a3-review-login-panel.tsx`：

```tsx
'use client';

import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

const REVIEW_IDENTIFIER = '13800000001';
const REVIEW_PASSWORD = 'Demo@123456';

type A3ReviewLoginPanelProps = {
  onFill: (credentials: { identifier: string; password: string }) => void;
};

export function A3ReviewLoginPanel({ onFill }: A3ReviewLoginPanelProps) {
  return (
    <section
      data-testid="a3-review-login-panel"
      className="mb-6 border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"
    >
      <div className="flex items-start gap-3">
        <ClipboardCheck className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">评审体验</h2>
          <p className="mt-1 text-sm leading-6 text-emerald-800">
            使用预置学生账号查看完整学习闭环。登录仍会调用真实认证接口。
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <span>账号：{REVIEW_IDENTIFIER}</span>
            <span>密码：{REVIEW_PASSWORD}</span>
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="a3-review-fill-account"
            className="mt-4 bg-emerald-700 text-white hover:bg-emerald-800"
            onClick={() =>
              onFill({ identifier: REVIEW_IDENTIFIER, password: REVIEW_PASSWORD })
            }
          >
            一键填入评审账号
          </Button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 让登录路由解析 `mode` 和 `next`**

将 `app/a3/login/page.tsx` 改为异步服务端页面：

```tsx
import { LoginPage } from '@/components/a3/auth/a3-auth-pages';
import { normalizeA3ReturnPath } from '@/lib/a3/auth-navigation';

type LoginSearchParams = Promise<{
  mode?: string;
  next?: string;
}>;

export default async function A3LoginPage({
  searchParams,
}: {
  searchParams: LoginSearchParams;
}) {
  const { mode, next } = await searchParams;
  const reviewMode = mode === 'review';
  const returnTo = normalizeA3ReturnPath(next);

  return <LoginPage reviewMode={reviewMode} returnTo={returnTo} />;
}
```

- [ ] **Step 5: 在 LoginPage 中接入评审面板和安全返回**

在认证页文件中新增导入：

```ts
import { A3ReviewLoginPanel } from '@/components/a3/auth/a3-review-login-panel';
```

更新签名与成功跳转：

```tsx
export function LoginPage({
  reviewMode = false,
  returnTo = null,
}: {
  reviewMode?: boolean;
  returnTo?: string | null;
}) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError('');
    if (!identifier.trim() || !password.trim()) {
      setError('请输入账号和密码后再登录');
      return;
    }
    setSubmitting(true);
    const result = await postJson('/api/auth/login/', { identifier, password });
    setSubmitting(false);
    if (!result.success) return setError(result.error ?? '登录失败');
    syncA3User(result.user);
    const destination =
      result.user?.profileCompleted && returnTo ? returnTo : nextPath(result.user);
    router.push(destination);
  }

  return (
    <AuthFrame>
      <FormCard
        title={reviewMode ? '进入评审体验' : '欢迎回来'}
        subtitle={
          reviewMode
            ? '登录预置账号，查看完整学习闭环与真实数据回流。'
            : '使用已开通的学生、教师或管理员账号进入对应学习工作区。'
        }
      >
        {reviewMode ? (
          <A3ReviewLoginPanel
            onFill={({ identifier: nextIdentifier, password: nextPassword }) => {
              setIdentifier(nextIdentifier);
              setPassword(nextPassword);
              setError('');
            }}
          />
        ) : null}
        <div className="space-y-5">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">账号</span>
            <div className="relative">
              <FieldIcon icon={User} />
              <Input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" />
            </div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">密码</span>
            <div className="relative">
              <FieldIcon icon={Lock} />
              <Input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              <button type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((current) => !current)}>
                {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            </div>
          </label>
          <ErrorBox message={error} />
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : '登录'}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <Link href="/a3/forgot-password">忘记密码？</Link>
            <Link href="/a3/register">还没有账号？立即注册</Link>
          </div>
        </div>
      </FormCard>
    </AuthFrame>
  );
}
```

实现时用上述结构替换现有 `LoginPage`，同时保留当前文件中输入框的尺寸、图标定位和按钮视觉类名。

- [ ] **Step 6: 调整普通登录页防演示账号测试**

保留 `a3-login-password-toggle.test.ts` 对 `LoginPage` 源码切片的检查，但把“整个源文件不含演示数据”的断言限定到普通登录区：

```ts
expect(loginSection).not.toContain("const REVIEW_IDENTIFIER = '13800000001'");
expect(loginSection).not.toContain("const REVIEW_PASSWORD = 'Demo@123456'");
expect(loginSection).toContain('<A3ReviewLoginPanel');
expect(loginSection).toContain('reviewMode ?');
```

- [ ] **Step 7: 运行登录相关测试**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-review-login-mode.test.ts tests/a3-login-password-toggle.test.ts tests/a3-email-registration.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交评审登录模式**

```powershell
git add -- OpenMAIC/app/a3/login/page.tsx OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/components/a3/auth/a3-review-login-panel.tsx OpenMAIC/tests/a3-login-password-toggle.test.ts OpenMAIC/tests/a3-review-login-mode.test.ts
git commit -m "feat: add the A3 review login mode"
```

---

### Task 3: 从真实页面生成首页媒体资产

**Files:**
- Create: `OpenMAIC/scripts/capture-a3-homepage-assets.mjs`
- Modify: `OpenMAIC/package.json`
- Create: `OpenMAIC/public/a3/assets/homepage/*.webp`
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`（本任务先创建资产检查部分）

- [ ] **Step 1: 写资产存在性和隐私边界失败测试**

创建 `OpenMAIC/tests/a3-homepage-content.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const assetDir = path.resolve(process.cwd(), 'public/a3/assets/homepage');
const expectedAssets = [
  'profile.webp',
  'diagnostic.webp',
  'knowledge-base.webp',
  'classroom.webp',
  'teacher-workbench.webp',
  'teacher-fallback.webp',
];

describe('A3 product homepage assets', () => {
  it('ships every real product image used by the homepage', () => {
    for (const filename of expectedAssets) {
      const file = path.join(assetDir, filename);
      expect(fs.existsSync(file), filename).toBe(true);
      expect(fs.statSync(file).size, filename).toBeGreaterThan(10_000);
    }
  });

  it('does not publish source documents or local path metadata', () => {
    const published = fs.readdirSync(assetDir);
    expect(published.some((name) => /\.(pdf|pptx?|json|txt)$/i.test(name))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行资产测试并确认失败**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
```

Expected: FAIL，`public/a3/assets/homepage` 或目标图片不存在。

- [ ] **Step 3: 创建可复现截图脚本**

创建 `OpenMAIC/scripts/capture-a3-homepage-assets.mjs`。脚本只读取真实页面，不修改业务数据；运行前由命令显式 seed 演示数据。

```js
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const baseURL = process.env.A3_CAPTURE_BASE_URL ?? 'http://localhost:3002';
const outputDir = path.resolve('public/a3/assets/homepage');
const password = process.env.A3_CAPTURE_PASSWORD ?? 'Demo@123456';

async function login(page, identifier) {
  await page.goto(`${baseURL}/a3/login`, { waitUntil: 'networkidle' });
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(identifier);
  await inputs.nth(1).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/a3/login'));
}

async function capture(page, route, filename, testId) {
  await page.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' });
  const target = testId ? page.getByTestId(testId) : page.locator('main');
  await target.first().waitFor({ state: 'visible', timeout: 60_000 });
  const png = await target.first().screenshot({
    type: 'png',
    animations: 'disabled',
  });
  await sharp(png)
    .resize({ width: 1440, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(path.join(outputDir, filename));
}

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const page = await context.newPage();

try {
  await login(page, '13800000001');
  await capture(page, '/a3/profile-setup', 'profile.webp', 'a3-profile-setup-view');
  await capture(
    page,
    '/a3/admission-diagnostic',
    'diagnostic.webp',
    'a3-admission-diagnostic-view',
  );
  await capture(
    page,
    '/a3/knowledge-base',
    'knowledge-base.webp',
    'a3-knowledge-base-view',
  );
  await capture(page, '/a3/classroom', 'classroom.webp', 'a3-classroom-view');
  await capture(page, '/a3/coaching', 'teacher-fallback.webp', 'a3-digital-human-avatar');

  await context.clearCookies();
  await login(page, '13800000002');
  await capture(
    page,
    '/a3/teacher',
    'teacher-workbench.webp',
    'a3-teacher-workbench',
  );
} finally {
  await browser.close();
}
```

- [ ] **Step 4: 增加截图脚本命令**

在 `package.json` scripts 中加入：

```json
"capture:a3-homepage": "node scripts/capture-a3-homepage-assets.mjs"
```

- [ ] **Step 5: 启动真实服务并生成资产**

终端 A：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py seed_demo_data
backend\.venv\Scripts\python.exe backend\manage.py runserver 127.0.0.1:8000 --noreload
```

终端 B：

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd dev -- --port 3002
```

终端 C：

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd capture:a3-homepage
```

Expected: `public/a3/assets/homepage` 生成 6 张 WebP；每张画面来自真实 A3 页面，不含浏览器地址栏、本地路径或密钥。

- [ ] **Step 6: 人工检查全部资产**

逐张打开图片，检查：

- 没有真实个人姓名、手机号或邮箱。
- 没有文件哈希和本地路径。
- 产品界面没有 loading、报错或空白画布。
- `teacher-fallback.webp` 中数字教师完整可见，不裁掉脸部。
- `teacher-workbench.webp` 不出现 OpenMAIC 品牌标识。

- [ ] **Step 7: 运行资产测试确认通过**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
```

Expected: PASS。

- [ ] **Step 8: 提交可复现素材**

```powershell
git add -- OpenMAIC/scripts/capture-a3-homepage-assets.mjs OpenMAIC/package.json OpenMAIC/tests/a3-homepage-content.test.ts OpenMAIC/public/a3/assets/homepage
git commit -m "assets: capture real A3 homepage product states"
```

---

### Task 4: 实现首页内容模型、导航和沉浸式首屏

**Files:**
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-content.ts`
- Create: `OpenMAIC/components/a3/marketing/a3-product-homepage.tsx`
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-hero.tsx`
- Create: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`
- Modify: `OpenMAIC/app/a3/page.tsx`
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`

- [ ] **Step 1: 扩展首页内容契约失败测试**

在 `a3-homepage-content.test.ts` 中追加：

```ts
import {
  A3_HOMEPAGE_FOOTER,
  A3_HOMEPAGE_NAV,
  A3_HOMEPAGE_STORY,
} from '@/components/a3/marketing/a3-homepage-content';

describe('A3 product homepage content contract', () => {
  it('uses the approved restrained navigation and CTA routes', () => {
    expect(A3_HOMEPAGE_NAV.map((item) => item.label)).toEqual([
      '产品能力',
      '学习闭环',
      '真实证据',
      '联系我们',
    ]);
    expect(A3_HOMEPAGE_NAV.every((item) => item.href.startsWith('#'))).toBe(true);
  });

  it('keeps the approved learning story in order', () => {
    expect(A3_HOMEPAGE_STORY.map((item) => item.title)).toEqual([
      '先认识你。',
      '找到你的起点。',
      '让资料真正为你所用。',
      '走进为你生成的课堂。',
      '随时有人陪你学懂。',
      '每一步，都有据可循。',
      '及时看见，也能及时介入。',
    ]);
  });

  it('keeps competition and team details out of the hero model', () => {
    const storyJson = JSON.stringify(A3_HOMEPAGE_STORY);
    expect(storyJson).not.toContain(A3_HOMEPAGE_FOOTER.team);
    expect(storyJson).not.toContain(A3_HOMEPAGE_FOOTER.competition);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
```

Expected: FAIL，marketing 内容模块不存在。

- [ ] **Step 3: 创建首页唯一内容模型**

创建 `a3-homepage-content.ts`：

```ts
export const A3_HOMEPAGE_NAV = [
  { label: '产品能力', href: '#capabilities' },
  { label: '学习闭环', href: '#learning-loop' },
  { label: '真实证据', href: '#evidence' },
  { label: '联系我们', href: '#contact' },
] as const;

export const A3_HOMEPAGE_HERO_MEDIA = [
  { src: '/a3/assets/homepage/profile.webp', alt: '学习画像界面' },
  { src: '/a3/assets/homepage/diagnostic.webp', alt: '入学诊断界面' },
  { src: '/a3/assets/homepage/knowledge-base.webp', alt: '本地知识库界面' },
  { src: '/a3/assets/homepage/classroom.webp', alt: 'AI 课堂界面' },
] as const;

export const A3_HOMEPAGE_STORY = [
  {
    id: 'profile',
    index: '01 / PROFILE',
    title: '先认识你。',
    summary: '目标、基础、时间和偏好，组成你的学习画像。',
    media: '/a3/assets/homepage/profile.webp',
    alt: '学习画像设置界面',
  },
  {
    id: 'diagnostic',
    index: '02 / DIAGNOSTIC',
    title: '找到你的起点。',
    summary: '一次诊断，找出进程调度中真正需要补齐的部分。',
    media: '/a3/assets/homepage/diagnostic.webp',
    alt: '操作系统入学诊断界面',
  },
  {
    id: 'knowledge',
    index: '03 / KNOWLEDGE',
    title: '让资料真正为你所用。',
    summary: '课本、课程 PPT 和知识总结，变成随时可查的学习依据。',
    media: '/a3/assets/homepage/knowledge-base.webp',
    alt: '操作系统本地知识库界面',
  },
  {
    id: 'classroom',
    index: '04 / CLASSROOM',
    title: '走进为你生成的课堂。',
    summary: '讲解紧跟你的薄弱点，也保留每一条资料来源。',
    media: '/a3/assets/homepage/classroom.webp',
    alt: '个性化 AI 课堂界面',
  },
  {
    id: 'coaching',
    index: '05 / COACHING',
    title: '随时有人陪你学懂。',
    summary: '看见问题、听懂追问，再陪你把难点讲明白。',
    media: '/a3/assets/homepage/teacher-fallback.webp',
    alt: '数字教师实时辅导界面',
  },
  {
    id: 'evidence',
    index: '06 / EVIDENCE',
    title: '每一步，都有据可循。',
    summary: '从资料来源到学习进展，过程清清楚楚。',
    media: null,
    alt: '',
  },
  {
    id: 'teacher',
    index: '07 / TEACHER',
    title: '及时看见，也能及时介入。',
    summary: '教师看见进度和薄弱点，在需要的时候推送任务。',
    media: '/a3/assets/homepage/teacher-workbench.webp',
    alt: '教师工作台界面',
  },
] as const;

export const A3_HOMEPAGE_EVIDENCE = [
  { label: '知识库', value: '资料可检索' },
  { label: 'AI 回答', value: '来源可验证' },
  { label: '学习进展', value: '结果会写回' },
] as const;

export const A3_HOMEPAGE_FOOTER = {
  team: '这次不要意味何',
  competition: 'A3-基于大模型的个性化资源生成与学习多智能体系统开发',
  email: '3062221819@qq.com',
} as const;
```

- [ ] **Step 4: 创建首屏组件**

`a3-homepage-hero.tsx` 使用 `next/image`、`motion/react` 和 `useReducedMotion`。实现要求：

```tsx
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion, useReducedMotion } from 'motion/react';
import { A3_HOMEPAGE_HERO_MEDIA } from './a3-homepage-content';
import styles from './a3-product-homepage.module.css';

export function A3HomepageHero() {
  const reduceMotion = useReducedMotion();

  return (
    <section className={styles.hero} aria-labelledby="a3-homepage-title">
      <div className={styles.heroCopy}>
        <p className={styles.eyebrow}>A3 PERSONAL LEARNING ENGINE</p>
        <h1 id="a3-homepage-title">每一步学习，<br />都更懂你。</h1>
        <p className={styles.heroSupport}>
          一群懂学习的智能体，陪你找到自己的节奏。
        </p>
        <Link className={styles.primaryCta} href="/a3/register">
          开启我的智学旅程
        </Link>
      </div>

      <motion.div
        className={styles.heroStage}
        initial={reduceMotion ? false : { opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.8, ease: [0.22, 1, 0.36, 1] }}
        data-testid="a3-homepage-hero-stage"
      >
        {A3_HOMEPAGE_HERO_MEDIA.map((item, index) => (
          <figure key={item.src} className={styles.heroScreen} data-screen={index + 1}>
            <Image
              src={item.src}
              alt={item.alt}
              fill
              priority={index === 0}
              sizes="(max-width: 768px) 92vw, 62vw"
            />
          </figure>
        ))}
      </motion.div>
    </section>
  );
}
```

首屏界面切换只使用 CSS animation，`:hover` 和 `:focus-within` 暂停，`prefers-reduced-motion` 下关闭：

```css
.heroScreen {
  animation: a3HeroCycle 16s infinite both;
}

.heroStage:hover .heroScreen,
.heroStage:focus-within .heroScreen {
  animation-play-state: paused;
}

@media (prefers-reduced-motion: reduce) {
  .heroScreen { animation: none; }
  .heroScreen:not(:first-child) { display: none; }
}
```

- [ ] **Step 5: 创建首页编排和极简导航**

`a3-product-homepage.tsx` 必须：

- 使用 `useA3CurrentUser()` 判断是否显示“进入学习区”。
- 主导航使用锚点。
- `登录` 指向 `/a3/login`。
- `评审体验` 指向 `/a3/login?mode=review`。
- `开启旅程` 指向 `/a3/register`。
- 移动端使用可关闭菜单，CTA 始终可见。

核心结构：

```tsx
'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { A3_HOMEPAGE_NAV } from './a3-homepage-content';
import { A3HomepageHero } from './a3-homepage-hero';
import styles from './a3-product-homepage.module.css';

export function A3ProductHomepage() {
  const user = useA3CurrentUser();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={styles.page} data-testid="a3-product-homepage">
      <header className={styles.header}>
        <Link href="/a3" className={styles.brand} aria-label="智学引擎首页">
          智学引擎
        </Link>
        <nav className={styles.desktopNav} aria-label="首页导航">
          {A3_HOMEPAGE_NAV.map((item) => (
            <a key={item.href} href={item.href}>{item.label}</a>
          ))}
        </nav>
        <div className={styles.headerActions}>
          {user ? <Link href="/a3/dashboard">进入学习区</Link> : <Link href="/a3/login">登录</Link>}
          <Link href="/a3/login?mode=review">评审体验</Link>
          <Link className={styles.headerCta} href="/a3/register">开启旅程</Link>
          <button
            className={styles.menuButton}
            type="button"
            aria-label={menuOpen ? '关闭导航' : '打开导航'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      {menuOpen ? (
        <nav className={styles.mobileNav} aria-label="移动端首页导航">
          {A3_HOMEPAGE_NAV.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
              {item.label}
            </a>
          ))}
          <Link href={user ? '/a3/dashboard' : '/a3/login'} onClick={() => setMenuOpen(false)}>
            {user ? '进入学习区' : '登录'}
          </Link>
          <Link href="/a3/login?mode=review" onClick={() => setMenuOpen(false)}>评审体验</Link>
        </nav>
      ) : null}
      <main>
        <A3HomepageHero />
      </main>
    </div>
  );
}
```

Task 5 创建 `A3HomepageStory` 后，在同一个 `<main>` 中紧接 `A3HomepageHero` 导入并渲染 `<A3HomepageStory />`。

- [ ] **Step 6: 替换 `/a3` 重定向并增加页面元数据**

修改 `app/a3/page.tsx`：

```tsx
import type { Metadata } from 'next';
import { A3ProductHomepage } from '@/components/a3/marketing/a3-product-homepage';

export const metadata: Metadata = {
  title: '智学引擎 | 每一步学习，都更懂你',
  description: '面向大学生的多智能体个性化学习平台。',
};

export default function A3IndexPage() {
  return <A3ProductHomepage />;
}
```

- [ ] **Step 7: 完成首屏 CSS，检查稳定尺寸**

CSS Module 至少定义以下稳定约束：

```css
.page { min-height: 100vh; background: #0b0e10; color: #f5f7f2; }
.header { position: sticky; top: 0; z-index: 50; min-height: 72px; }
.hero { min-height: calc(100svh - 72px); overflow: hidden; position: relative; }
.heroStage { position: absolute; inset: 15% -4% 4% 40%; perspective: 1200px; }
.heroScreen { position: absolute; width: min(920px, 72vw); aspect-ratio: 16 / 10; overflow: hidden; }
.heroScreen img { object-fit: cover; object-position: left top; }
.primaryCta, .headerCta { background: #d9ff62; color: #10130b; }
```

桌面标题使用固定断点字号，不使用 `vw`：`56px / 72px / 84px`。移动端标题最大 `52px`，最长中文词组不得溢出。

- [ ] **Step 8: 运行内容和类型测试**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-public-route.test.ts
npx.cmd tsc --noEmit
```

Expected: 测试全部 PASS；TypeScript 无错误。

- [ ] **Step 9: 提交首页首屏**

```powershell
git add -- OpenMAIC/app/a3/page.tsx OpenMAIC/components/a3/marketing OpenMAIC/tests/a3-homepage-content.test.ts
git commit -m "feat: build the A3 product homepage hero"
```

---

### Task 5: 实现连续学习叙事、证据和教师章节

**Files:**
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-story.tsx`
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-teacher-stage.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`

- [ ] **Step 1: 写章节结构和禁用内容失败测试**

在 `a3-homepage-content.test.ts` 追加源文件契约：

```ts
const homepageSource = fs.readFileSync(
  path.resolve(process.cwd(), 'components/a3/marketing/a3-product-homepage.tsx'),
  'utf8',
);
const storySource = fs.readFileSync(
  path.resolve(process.cwd(), 'components/a3/marketing/a3-homepage-story.tsx'),
  'utf8',
);
const teacherSource = fs.readFileSync(
  path.resolve(process.cwd(), 'components/a3/marketing/a3-homepage-teacher-stage.tsx'),
  'utf8',
);

it('keeps homepage actions real and evidence read-only', () => {
  expect(homepageSource).toContain('href="/a3/register"');
  expect(homepageSource).toContain('href="/a3/login?mode=review"');
  expect(storySource).not.toContain('a3PostJson');
  expect(storySource).not.toContain('/api/resources/generate/');
});

it('renders approved evidence and a lazy digital teacher', () => {
  expect(storySource).toContain('A3_HOMEPAGE_EVIDENCE.map');
  expect(teacherSource).toContain("ssr: false");
  expect(teacherSource).toContain('IntersectionObserver');
  expect(teacherSource).toContain("state='listening'");
});

it('does not expose restricted brands or local paths', () => {
  const combined = `${homepageSource}\n${storySource}`;
  expect(combined).not.toContain('OpenMAIC');
  expect(combined).not.toMatch(/[A-Z]:\\\\/);
  expect(combined).not.toContain('signedUrl');
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
```

Expected: FAIL，story 和 teacher stage 尚未实现。

- [ ] **Step 3: 实现常规学习章节**

`a3-homepage-story.tsx` 按内容模型顺序渲染章节。画像、诊断、知识库和课堂使用统一组件：

```tsx
type StoryItem = (typeof A3_HOMEPAGE_STORY)[number];
type ProductStoryItem = StoryItem & { media: string };

function isProductStoryItem(item: StoryItem): item is ProductStoryItem {
  return item.media !== null;
}

function ProductStorySection({
  item,
  priority = false,
}: {
  item: ProductStoryItem;
  priority?: boolean;
}) {
  return (
    <section id={item.id} className={styles.storySection} data-testid={`a3-homepage-${item.id}`}>
      <div className={styles.storyCopy}>
        <p className={styles.eyebrow}>{item.index}</p>
        <h2>{item.title}</h2>
        <p>{item.summary}</p>
      </div>
      <figure className={styles.fullProductFrame}>
        <Image
          src={item.media}
          alt={item.alt}
          fill
          priority={priority}
          sizes="(max-width: 768px) 92vw, 64vw"
        />
      </figure>
    </section>
  );
}
```

完整界面使用固定 `aspect-ratio`，`object-fit: contain`，不能复用首屏的裁切样式。

文件顶部使用以下导入，保证后续步骤的状态和组件名称一致：

```tsx
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import {
  A3_HOMEPAGE_EVIDENCE,
  A3_HOMEPAGE_FOOTER,
  A3_HOMEPAGE_STORY,
} from './a3-homepage-content';
import { A3HomepageTeacherStage } from './a3-homepage-teacher-stage';
import styles from './a3-product-homepage.module.css';
```

- [ ] **Step 4: 实现知识库视觉高潮**

知识库章节在完整截图旁增加一条纯展示数据流：

```tsx
<div className={styles.knowledgeFlow} aria-label="知识库学习依据流向">
  <span>操作系统课本</span>
  <span>课程 PPT</span>
  <span>知识总结</span>
  <strong>本地知识库</strong>
  <span>课堂</span>
  <span>引用</span>
  <span>学习计划</span>
</div>
```

节点连线用 CSS border 或伪元素，不手绘 SVG。移动端改为两行网格，不允许横向溢出。

- [ ] **Step 5: 实现讲解/引用只读切换**

课堂章节可切换两种只读状态：

```tsx
const [classroomMode, setClassroomMode] = useState<'lesson' | 'citations'>('lesson');

<div role="group" aria-label="课堂展示模式" className={styles.segmentedControl}>
  <button
    type="button"
    aria-pressed={classroomMode === 'lesson'}
    onClick={() => setClassroomMode('lesson')}
  >讲解</button>
  <button
    type="button"
    aria-pressed={classroomMode === 'citations'}
    onClick={() => setClassroomMode('citations')}
  >引用</button>
</div>
```

`citations` 状态显示固定的真实资料标签：“操作系统 / 第 3 章 / 课程 PPT”和“进程调度 / 知识总结”，不显示页码、哈希或本地路径。

- [ ] **Step 6: 实现延迟加载数字教师**

`a3-homepage-teacher-stage.tsx`：

```tsx
'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import styles from './a3-product-homepage.module.css';

const DigitalHumanAvatar = dynamic(
  () =>
    import('@/components/a3/features/coaching/digital-human-avatar').then(
      (module) => module.DigitalHumanAvatar,
    ),
  { ssr: false },
);

export function A3HomepageTeacherStage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className={styles.teacherStage} data-testid="a3-homepage-teacher-stage">
      {active ? (
        <DigitalHumanAvatar
          state='listening'
          mode="local_vrm"
          audioLevel={0}
          assistantSpeaking={false}
          providerLabel="本地数字教师"
          modelLabel="静音演示"
        />
      ) : (
        <Image
          src="/a3/assets/homepage/teacher-fallback.webp"
          alt="数字教师实时辅导界面"
          fill
          sizes="(max-width: 768px) 92vw, 60vw"
        />
      )}
      <div className={styles.teacherPrompt}>正在倾听：进程调度为什么会发生饥饿？</div>
      <Link href="/a3/coaching">进入实时辅导</Link>
    </div>
  );
}
```

数字教师容器是无装饰边框的全宽舞台，不放在嵌套卡片中。不得调用麦克风、摄像头或音频 API。

- [ ] **Step 7: 实现证据和教师工作台章节**

证据章节必须直接使用内容模型：

```tsx
<section id="evidence" className={styles.evidenceSection}>
  <div>
    <p className={styles.eyebrow}>06 / EVIDENCE</p>
    <h2>每一步，<br />都有据可循。</h2>
    <p>从资料来源到学习进展，过程清清楚楚。</p>
  </div>
  <div className={styles.evidenceGrid}>
    {A3_HOMEPAGE_EVIDENCE.map((item) => (
      <div key={item.value}>
        <span>{item.label}</span>
        <strong>{item.value}</strong>
      </div>
    ))}
  </div>
</section>
```

教师章节使用完整工作台截图和一个真实路由按钮 `href="/a3/teacher"`。未登录时由 AuthGate 自动带 `next` 参数进入登录页。

- [ ] **Step 8: 实现收尾与页尾**

```tsx
<section id="contact" className={styles.closingSection}>
  <h2>开启你的<br />智学旅程。</h2>
  <Link href="/a3/register">开启我的智学旅程</Link>
</section>
<footer className={styles.footer}>
  <span>团队：{A3_HOMEPAGE_FOOTER.team}</span>
  <span>比赛：{A3_HOMEPAGE_FOOTER.competition}</span>
  <a href={`mailto:${A3_HOMEPAGE_FOOTER.email}`}>{A3_HOMEPAGE_FOOTER.email}</a>
</footer>
```

最终 `A3HomepageStory` 按以下顺序组装，避免章节顺序散落在 JSX 中：

```tsx
export function A3HomepageStory() {
  const [classroomMode, setClassroomMode] = useState<'lesson' | 'citations'>('lesson');
  const [profile, diagnostic, knowledge, classroom, coaching, evidence, teacher] =
    A3_HOMEPAGE_STORY;

  if (
    !profile ||
    !diagnostic ||
    !knowledge ||
    !classroom ||
    !coaching ||
    !evidence ||
    !teacher ||
    !isProductStoryItem(profile) ||
    !isProductStoryItem(diagnostic) ||
    !isProductStoryItem(knowledge) ||
    !isProductStoryItem(classroom) ||
    !isProductStoryItem(teacher)
  ) {
    return null;
  }

  return (
    <div id="capabilities">
      <ProductStorySection item={profile} priority />
      <ProductStorySection item={diagnostic} />
      <div id="learning-loop" className={styles.storyBand}>
        <ProductStorySection item={knowledge} />
        <div className={styles.knowledgeFlow} aria-label="知识库学习依据流向">
          <span>操作系统课本</span><span>课程 PPT</span><span>知识总结</span>
          <strong>本地知识库</strong>
          <span>课堂</span><span>引用</span><span>学习计划</span>
        </div>
      </div>
      <div className={styles.storyBand}>
        <ProductStorySection item={classroom} />
        <div role="group" aria-label="课堂展示模式" className={styles.segmentedControl}>
          <button type="button" aria-pressed={classroomMode === 'lesson'} onClick={() => setClassroomMode('lesson')}>讲解</button>
          <button type="button" aria-pressed={classroomMode === 'citations'} onClick={() => setClassroomMode('citations')}>引用</button>
        </div>
        {classroomMode === 'citations' ? (
          <div className={styles.citationLabels}>
            <span>操作系统 / 第 3 章 / 课程 PPT</span>
            <span>进程调度 / 知识总结</span>
          </div>
        ) : null}
      </div>
      <section id={coaching.id} className={styles.storySection}>
        <div className={styles.storyCopy}><p className={styles.eyebrow}>{coaching.index}</p><h2>{coaching.title}</h2><p>{coaching.summary}</p></div>
        <A3HomepageTeacherStage />
      </section>
      <EvidenceSection item={evidence} />
      <ProductStorySection item={teacher} />
      <ClosingSection />
    </div>
  );
}
```

`EvidenceSection` 和 `ClosingSection` 分别封装 Step 7、Step 8 给出的 JSX。`ProductStorySection` 外层已经是 `section`，因此 `storyBand` 使用无语义 `div`，避免 `section` 嵌套影响标题层级。

- [ ] **Step 9: 运行章节契约与类型检查**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS，无类型错误。

- [ ] **Step 10: 提交完整叙事**

```powershell
git add -- OpenMAIC/components/a3/marketing OpenMAIC/tests/a3-homepage-content.test.ts
git commit -m "feat: add the A3 homepage learning story"
```

---

### Task 6: 完成响应式、减少动态效果和媒体降级

**Files:**
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-hero.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-story.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-teacher-stage.tsx`
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`

- [ ] **Step 1: 写响应式和降级契约失败测试**

在内容测试中增加：

```ts
const cssSource = fs.readFileSync(
  path.resolve(process.cwd(), 'components/a3/marketing/a3-product-homepage.module.css'),
  'utf8',
);

it('provides reduced-motion and mobile layout fallbacks', () => {
  expect(cssSource).toContain('@media (prefers-reduced-motion: reduce)');
  expect(cssSource).toContain('@media (max-width: 767px)');
  expect(cssSource).toContain('aspect-ratio:');
  expect(cssSource).not.toMatch(/font-size:\s*[^;]*(vw|cqw)/);
});

it('keeps media failure states readable', () => {
  expect(storySource).toContain('onError');
  expect(teacherSource).toContain('teacher-fallback.webp');
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
```

Expected: FAIL，媒体 `onError` 或完整响应式规则尚未就绪。

- [ ] **Step 3: 增加统一媒体降级组件**

在 story 文件中添加局部组件，图片失败时保留稳定尺寸和可读说明：

```tsx
function ProductMedia({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <figure className={styles.fullProductFrame}>
      {failed ? (
        <div className={styles.mediaFallback} role="img" aria-label={alt}>
          <span>产品界面暂未加载</span>
          <small>你仍可继续浏览完整学习流程。</small>
        </div>
      ) : (
        <Image
          src={src}
          alt={alt}
          fill
          sizes="(max-width: 768px) 92vw, 64vw"
          onError={() => setFailed(true)}
        />
      )}
    </figure>
  );
}
```

- [ ] **Step 4: 完成移动端布局规则**

移动端必须满足：

```css
@media (max-width: 767px) {
  .desktopNav { display: none; }
  .menuButton { display: inline-flex; }
  .header { min-height: 64px; padding: 0 16px; }
  .headerActions > a:not(.headerCta) { display: none; }
  .hero { min-height: 760px; padding: 72px 18px 28px; }
  .heroStage { inset: 360px -12% 20px 8%; }
  .storySection { min-height: auto; grid-template-columns: 1fr; padding: 88px 18px; }
  .storyCopy h2, .evidenceSection h2, .closingSection h2 { font-size: 44px; }
  .fullProductFrame { width: 100%; aspect-ratio: 4 / 3; }
  .evidenceGrid { grid-template-columns: 1fr; }
  .knowledgeFlow { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
```

移动端不使用 sticky story panel、固定横向滚动或超过视口宽度的 transform。

- [ ] **Step 5: 完成减少动态效果规则**

```css
@media (prefers-reduced-motion: reduce) {
  .page { scroll-behavior: auto; }
  .heroScreen,
  .storySection,
  .knowledgeFlow span,
  .knowledgeFlow strong {
    animation: none !important;
    transition: none !important;
  }
}
```

在教师组件中通过 `window.matchMedia('(prefers-reduced-motion: reduce)')` 判断；开启时只显示静态 fallback，不加载 3D 模型。

- [ ] **Step 6: 确保焦点、键盘和对比度可用**

- 所有按钮和链接提供可见 `:focus-visible` 描边。
- 移动菜单打开时使用 `aria-expanded`，关闭后焦点返回菜单按钮。
- “讲解/引用”使用 `aria-pressed`。
- 荧光黄绿文字只放在深色背景或作为深色文字的按钮背景。
- 不使用仅靠颜色区分的状态。

- [ ] **Step 7: 运行契约、类型和 lint**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: 测试与 TypeScript PASS；lint 不新增 warning。AGENTS.md 列出的历史 warning 可保留。

- [ ] **Step 8: 提交响应式与降级**

```powershell
git add -- OpenMAIC/components/a3/marketing OpenMAIC/tests/a3-homepage-content.test.ts
git commit -m "fix: harden A3 homepage responsive media states"
```

---

### Task 7: 增加 Playwright 流程、视觉和 3D 画布验收

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts`
- Modify: `OpenMAIC/e2e/tests/a3-route-smoke.spec.ts`

- [ ] **Step 1: 写首页核心流程 E2E**

创建 `a3-product-homepage.spec.ts`：

```ts
import { test, expect } from '../fixtures/base';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(2);
}

test.describe('A3 product homepage', () => {
  test('renders immediately as a public product page', async ({ page }) => {
    await page.route('**/api/auth/me/', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ json: { user: null } });
    });
    await page.goto('/a3');
    await expect(page.getByTestId('a3-product-homepage')).toBeVisible({ timeout: 1000 });
    await expect(page.getByRole('heading', { name: /每一步学习/ })).toBeVisible();
    await expect(page.getByRole('link', { name: '开启我的智学旅程' })).toHaveAttribute(
      'href',
      '/a3/register',
    );
  });

  test('opens review login and fills the real review account', async ({ page }) => {
    await page.goto('/a3');
    await page.getByRole('link', { name: '评审体验' }).click();
    await expect(page).toHaveURL(/\/a3\/login\?mode=review/);
    await expect(page.getByTestId('a3-review-login-panel')).toBeVisible();
    await page.getByTestId('a3-review-fill-account').click();
    const inputs = page.locator('main input');
    await expect(inputs.nth(0)).toHaveValue('13800000001');
    await expect(inputs.nth(1)).toHaveValue('Demo@123456');
  });

  test('anchors and read-only classroom controls work without API writes', async ({ page }) => {
    const writes: string[] = [];
    page.on('request', (request) => {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url());
    });
    await page.goto('/a3');
    await page.getByRole('link', { name: '真实证据' }).click();
    await expect(page.locator('#evidence')).toBeInViewport();
    await page.getByRole('button', { name: '引用' }).click();
    await expect(page.getByText('操作系统 / 第 3 章 / 课程 PPT')).toBeVisible();
    expect(writes).toEqual([]);
  });
});
```

- [ ] **Step 2: 写桌面、移动端和减少动态效果检查**

追加：

```ts
for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} layout has no overflow or overlapping CTA`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/a3');
    await expectNoHorizontalOverflow(page);
    const cta = page.getByRole('link', { name: '开启我的智学旅程' }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveCSS('pointer-events', 'auto');
    await page.screenshot({
      path: `test-results/a3-homepage-${viewport.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

test('reduced motion keeps every section readable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/a3');
  await expect(page.getByText('先认识你。')).toBeVisible();
  await expect(page.getByText('及时看见，也能及时介入。')).toBeVisible();
  await expect(page.getByTestId('a3-homepage-teacher-stage').locator('canvas')).toHaveCount(0);
});
```

- [ ] **Step 3: 写正常动效下的 3D 非空画布检查**

```ts
test('digital teacher renders a nonblank canvas when the section enters view', async ({ page }) => {
  await page.goto('/a3');
  const stage = page.getByTestId('a3-homepage-teacher-stage');
  await stage.scrollIntoViewIfNeeded();
  const canvas = stage.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const pixelStats = await canvas.evaluate((element: HTMLCanvasElement) => {
    const sample = document.createElement('canvas');
    sample.width = 32;
    sample.height = 32;
    const context = sample.getContext('2d');
    if (!context) return { opaque: 0, variance: 0 };
    context.drawImage(element, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    let opaque = 0;
    let min = 255;
    let max = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const lightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      if (pixels[index + 3] > 0) opaque += 1;
      min = Math.min(min, lightness);
      max = Math.max(max, lightness);
    }
    return { opaque, variance: max - min };
  });

  expect(pixelStats.opaque).toBeGreaterThan(700);
  expect(pixelStats.variance).toBeGreaterThan(12);
});
```

如果 WebGL 画布因 `preserveDrawingBuffer=false` 无法被 2D canvas 读取，则改用 Playwright 对教师舞台截图，再用仓库已有 `sharp` 读取 32×32 缩略图并计算非透明像素与亮度方差；不得删除画布非空验证。

- [ ] **Step 4: 更新路由烟雾测试对 `/a3` 的预期**

`a3-route-smoke.spec.ts` 中 `/a3` 不再作为登录后业务页验证。增加独立断言：

```ts
test('public A3 route stays on the product homepage', async ({ page }) => {
  await page.goto('/a3');
  await expect(page).toHaveURL(/\/a3$/);
  await expect(page.getByTestId('a3-product-homepage')).toBeVisible();
});
```

从 `STUDENT_ROUTES` 中删除 `/a3`，避免登录态 smoke 把首页误判为学习工作区。

- [ ] **Step 5: 启动服务并运行专项 E2E**

Run:

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-product-homepage.spec.ts --project=chromium --workers=1
```

Expected: 所有首页测试 PASS，并生成桌面与移动端截图。

- [ ] **Step 6: 查看截图并逐项视觉验收**

使用 Playwright 生成的图片检查：

- 1440×1000 首屏可看到品牌、主标题、CTA、真实产品界面和下一章节提示。
- 390×844 不出现横向滚动，标题、CTA、导航不重叠。
- 每个章节的产品截图完整可读，未被前后文字遮挡。
- 页面不是单一黑/黄绿配色，浅色产品界面提供足够视觉层次。
- 教师舞台非空、人物取景完整、没有载入状态残留。
- 页尾长比赛名称可以自然换行，不挤压邮箱。

- [ ] **Step 7: 运行完整前端回归**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-public-route.test.ts tests/a3-homepage-content.test.ts tests/a3-review-login-mode.test.ts tests/a3-login-password-toggle.test.ts tests/a3-navigation-consolidation.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
npx.cmd playwright test e2e/tests/a3-product-homepage.spec.ts e2e/tests/a3-route-smoke.spec.ts --project=chromium --workers=1
```

Expected: Vitest、TypeScript、lint 和 Playwright 全部通过；只允许 AGENTS.md 已列出的历史 lint warning。

- [ ] **Step 8: 运行后端基线验证**

首页不修改后端接口，但仍验证学习闭环基线：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: 两条命令均成功。

- [ ] **Step 9: 提交 E2E 和验收修复**

```powershell
git add -- OpenMAIC/e2e/tests/a3-product-homepage.spec.ts OpenMAIC/e2e/tests/a3-route-smoke.spec.ts OpenMAIC/components/a3/marketing
git commit -m "test: verify the A3 product homepage experience"
```

---

## 最终交付检查

- [ ] `git status --short --branch` 确认每次提交只包含计划规定文件，不混入工作区既有改动。
- [ ] `/a3` 对游客立即展示首页，不等待 `/api/auth/me/`。
- [ ] 已登录用户在首页看到“进入学习区”，不会被自动重定向。
- [ ] 普通 `/a3/login` 不展示固定评审账号。
- [ ] `/a3/login?mode=review` 展示账号并支持一键填入，登录走真实 API。
- [ ] 首页不调用写接口、不暴露 OpenMAIC 标识、本地路径、哈希、密钥或真实个人信息。
- [ ] 桌面、移动、减少动态效果、图片失败和 3D 降级均可用。
- [ ] 页面媒体没有阻塞主标题和 CTA 的首次呈现。
- [ ] 所有验证命令的结果写入最终交接说明。
