# A3 Homepage Launch Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/a3` 改造成完整表达学习闭环、具备真实脱敏界面证据并满足公开上市展示基础要求的产品首页。

**Architecture:** 首页主要内容改为 Server Components，移动导航、课堂只读切换和数字教师保留为独立客户端岛。真实产品截图通过现有只读截图管线生成，公开首页不调用学习业务 API。根级副作用组件在 `/a3` 上短路，SEO 使用 Next.js metadata、robots、sitemap 和 web manifest 原生能力。

**Tech Stack:** Next.js 16 App Router、React 19、CSS Modules、Vitest、Playwright、Sharp。

---

### Task 1: Lock the new public homepage contract

**Files:**
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`
- Create: `OpenMAIC/tests/a3-homepage-launch-baseline.test.ts`
- Modify: `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts`

- [x] **Step 1: Write failing content tests**

测试首页包含 `today`、`assessment-review`、`progress-refresh` 三个真实界面章节，Hero 使用品牌名和学习闭环定位，公开导航不再包含评审语境，Footer 不再出现比赛和个人邮箱。

- [x] **Step 2: Write failing architecture and SEO tests**

检查首页主体文件没有 `use client`，交互只存在于专用 island 文件；检查 `lang="zh-CN"`、canonical、Open Graph、Twitter Card、JSON-LD、robots、sitemap 和 manifest 契约。

- [x] **Step 3: Write failing accessibility and performance tests**

检查 skip link、`main` 锚点、44 像素触控目标、Hero 非交互舞台不进入 Tab 顺序、深层首页链接关闭预取，以及公开首页跳过 provider/access-code 请求。

- [x] **Step 4: Run RED tests**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-launch-baseline.test.ts
```

Expected: 因新章节、SEO 文件和 Server/Client 边界尚未实现而失败。

### Task 2: Add real anonymized learning-loop assets

**Files:**
- Modify: `OpenMAIC/scripts/capture-a3-homepage-assets.mjs`
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`
- Create: `OpenMAIC/public/a3/assets/homepage/today-plan.webp`
- Create: `OpenMAIC/public/a3/assets/homepage/assessment-review.webp`
- Create: `OpenMAIC/public/a3/assets/homepage/progress-refresh.webp`

- [x] **Step 1: Define read-only capture targets**

从 `/a3/today` 截取今日任务，从 `/a3/wrong-notebook` 截取真实错题与复习队列，从 `/a3/report` 截取周总结、薄弱趋势和下一步计划。每个目标必须等待真实 DOM，缺少真实条目时明确失败。

- [x] **Step 2: Extend sensitive-content validation**

复用手机号、邮箱、绝对路径、API key 和 token 检查，并为三张新截图验证加载/错误状态、最小尺寸、WebP 解码和非空白像素。

- [x] **Step 3: Run the capture pipeline against the local A3 instance**

Run:

```powershell
cd OpenMAIC
pnpm.cmd capture:a3-homepage
```

Expected: 原子生成十张首页 WebP 资源，未发送业务写请求。

### Task 3: Convert the homepage to server-first composition

**Files:**
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.tsx`
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-mobile-nav.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-hero.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-story.tsx`
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-classroom-island.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-product-media.tsx`

- [x] **Step 1: Move navigation state into a small client island**

服务端 Header 输出品牌、桌面导航和 CTA，移动菜单岛负责 Escape、焦点移动、焦点归还和背景滚动锁。

- [x] **Step 2: Make hero and story server-renderable**

移除整页 motion 与 story 状态，使用 CSS entrance motion；Hero 图片舞台不设置 `tabIndex`。图片直接使用服务端 `next/image`，保留稳定比例和失败时可读的客户端 fallback 仅在必要位置使用。

- [x] **Step 3: Isolate classroom and digital teacher interactions**

课堂切换进入独立客户端岛；数字教师继续按接近视口后加载，且 reduced motion 下只显示静态真实截图。

- [x] **Step 4: Run GREEN architecture tests**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-launch-baseline.test.ts
```

Expected: Server/Client 边界、可访问性和预取契约通过。

### Task 4: Implement the launch-ready story and copy

**Files:**
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-content.ts`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-story.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-resource-showcase.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`

- [x] **Step 1: Replace hero and navigation copy**

首屏直接出现“智学引擎”，副标题说明“把诊断、资源、辅导和复习连成一条学习闭环”。主 CTA 为“开始体验”，次 CTA 指向 `#daily-learning`。

- [x] **Step 2: Reorder the information architecture**

章节顺序固定为：今日计划、个性化起点、本地证据、多模态资源、课堂与辅导、测评与错题、计划和报告刷新、教师干预、可复现证据、隐私安全、FAQ、最终 CTA。

- [x] **Step 3: Replace generic evidence claims**

公开 53 条检索与安全回归用例、18 条可追踪工作流和六类资源链路，全部标注为 2026-07-14 工程快照，并明确样本和长期承诺边界。

- [x] **Step 4: Replace the competition footer**

Footer 仅保留产品、帮助、安全、隐私、用户协议和产品联系入口。不存在正式法律页面的入口使用现有 `/a3/privacy` 和 `/a3/help`，不新增无效链接。

### Task 5: Add SEO and skip irrelevant public-homepage initialization

**Files:**
- Modify: `OpenMAIC/app/layout.tsx`
- Modify: `OpenMAIC/app/a3/page.tsx`
- Create: `OpenMAIC/app/robots.ts`
- Create: `OpenMAIC/app/sitemap.ts`
- Create: `OpenMAIC/app/manifest.ts`
- Modify: `OpenMAIC/components/server-providers-init.tsx`
- Modify: `OpenMAIC/components/access-code-guard.tsx`

- [x] **Step 1: Publish Chinese document and complete metadata**

根布局输出 `zh-CN`；首页 metadata 包含 canonical、Open Graph、Twitter Card 和分享图。页面输出 `SoftwareApplication` JSON-LD，字段仅使用真实产品事实。

- [x] **Step 2: Add discovery controls**

robots 允许公开首页，禁止受保护 A3 页面；sitemap 仅列出公开首页与真实可公开入口；manifest 提供正式产品名、颜色和 standalone 显示模式。

- [x] **Step 3: Skip unrelated runtime effects on `/a3`**

由现有 `ServerProvidersInit`、`AccessCodeGuard` 和 A3 AuthGate 读取 pathname，在公开首页短路 provider、access-code 和匿名鉴权请求。Header 使用稳定的“登录”与“进入学习区”独立入口，不依赖匿名首屏鉴权。

- [x] **Step 4: Verify metadata and request behavior**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-public-route.test.ts tests/a3-homepage-launch-baseline.test.ts
```

Expected: 公开首页服务端内容、SEO 和无关请求短路全部通过。

### Task 6: Browser, visual and performance verification

**Files:**
- Modify: `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts`
- Modify: `OpenMAIC/e2e/tests/a3-homepage-hero-quality.spec.ts`
- Modify: `OpenMAIC/e2e/tests/a3-homepage-story-quality.spec.ts`

- [x] **Step 1: Run unit and static validation**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-launch-baseline.test.ts tests/a3-homepage-public-route.test.ts tests/a3-homepage-teacher-evidence.test.ts tests/a3-homepage-teacher-phase.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

- [x] **Step 2: Run desktop and mobile Playwright tests**

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-product-homepage.spec.ts e2e/tests/a3-homepage-hero-quality.spec.ts e2e/tests/a3-homepage-story-quality.spec.ts --project=chromium --workers=1
```

- [x] **Step 3: Inspect screenshots and canvas pixels**

检查桌面 1440×1000、移动 390×844 和短屏 375×568。确认三张新界面可读，文字和 CTA 不重叠，数字教师非空白且不会进入首屏关键路径。

- [x] **Step 4: Record the performance result**

记录 FCP、LCP、CLS、初始传输、脚本请求和公开首页无关 API 请求。目标为 LCP 不高于 2.5 秒、CLS 不高于 0.1、初始传输不高于 650 KB；环境限制导致无法达到时必须报告实测值和剩余瓶颈。

2026-07-14 生产模式实测：FCP/LCP 约 296–532 ms，CLS 为 0，初始传输约 816 KB，初始脚本 19 个，`/api/auth/me/`、`/api/server-providers`、`/api/access-code/status` 请求均为 0。初始传输尚未达到 650 KB，剩余主要来自根布局的 Theme、i18n、Toaster、A3 AuthGate 客户端边界及首屏附近真实截图；继续下降需要路由组级运行时隔离，留作下一批架构优化。
