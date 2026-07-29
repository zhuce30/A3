# A3 AI 课堂渐进式布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/a3/classroom` 改造成完整上下文可滚动、可手动收起、滚动后显示紧凑吸顶栏、输入区接近 ChatGPT 空间效率的 AI 课堂，同时保持所有现有后端接口和学习闭环不变。

**Architecture:** 课堂主工作区继续使用固定视口和单一内部滚动区。新增受控的课堂上下文组件与浮动输入框框架；`IntersectionObserver` 管理上下文是否离开视口，`sessionStorage` 保存当前课堂的手动收起状态，`ResizeObserver` 为浮动输入区提供动态防遮挡留白，现有 `use-stick-to-bottom` 管理聊天跟随和“回到最新消息”。

**Tech Stack:** Next.js 16、React 19、TypeScript、Tailwind CSS、Lucide React、use-stick-to-bottom、Vitest 4、jsdom、Playwright 1.58。

---

## 文件职责与变更范围

### 新建文件

- `OpenMAIC/components/a3/features/classroom/classroom-context-shell.tsx`
  - 负责展开上下文、流内摘要、吸顶摘要的表现。
  - 负责 `IntersectionObserver`、`sessionStorage` 和“从吸顶栏返回上下文”。
  - 不读取课堂 API，不持有导师或 OpenMAIC 业务数据。

- `OpenMAIC/components/a3/features/classroom/classroom-composer-frame.tsx`
  - 负责底部浮动定位、`ResizeObserver` 高度上报和视觉边界。
  - 不提交消息，不处理检索和语音业务。

- `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`
  - 在 jsdom 中验证展开、收起、会话恢复、吸顶显示和输入框高度上报。

### 修改文件

- `OpenMAIC/components/a3/features/classroom-view-redesign.tsx`
  - 将标题、目标、导师选择和 OpenMAIC 条移入课堂滚动内容。
  - 接入上下文组件、浮动输入框、`use-stick-to-bottom` 和回到底部按钮。
  - 调整普通桌面侧栏默认状态。

- `OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx`
  - 收紧 `compact` 模式高度与文案占位，不改变导师保存和音色试听逻辑。

- `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
  - 锁定真实接口、组件边界和布局机制。

- `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`
  - 覆盖首屏展开、手动收起、长回答吸顶、浮动输入框和响应式无重叠。

### 明确不修改

- Django API、数据库模型、Agent、Celery。
- `/api/learning/classroom/`、`/api/a3/coaching/respond`、课堂历史和 OpenMAIC artifact 契约。
- `ChatBubble`、`A3Markdown`、KaTeX、引用验证和课堂练习回写逻辑。

---

### Task 1: 先锁定渐进式布局合约

**Files:**
- Modify: `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
- Modify: `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`
- Test: `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
- Test: `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`

- [ ] **Step 1: 在合约测试中写入新的失败断言**

在 `A3 classroom redesigned workspace contract` 中新增：

```ts
it('uses progressive classroom context and a measured floating composer', () => {
  const source = fs.readFileSync(redesignPath, 'utf8');

  expect(source).toContain('ClassroomContextShell');
  expect(source).toContain('ClassroomStickyContextBar');
  expect(source).toContain('ClassroomComposerFrame');
  expect(source).toContain('useStickToBottom');
  expect(source).toContain("'--a3-composer-height'");
  expect(source).toContain('data-testid="a3-classroom-jump-latest"');
  expect(source).toContain('data-testid="a3-classroom-context-loading"');
  expect(source).toContain('copy.chooseTargetFirst');
  expect(source).toContain('copy.viewingHistoryCompact');
  expect(source).toContain('aria-live="polite"');
  expect(source).toContain('role="alert"');
  expect(source).not.toContain('grid-rows-[minmax(0,1fr)_auto]');
});

it('keeps classroom context collapse state local to the browser session', () => {
  const contextSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/a3/features/classroom/classroom-context-shell.tsx'),
    'utf8',
  );

  expect(contextSource).toContain('window.sessionStorage.getItem');
  expect(contextSource).toContain('window.sessionStorage.setItem');
  expect(contextSource).toContain('IntersectionObserver');
  expect(contextSource).not.toContain('localStorage');
});
```

- [ ] **Step 2: 在 Playwright fixture 中补齐导师与 OpenMAIC 数据**

在 `mockClassroomLayoutDependencies()` 增加真实形状的 mock 路由：

```ts
await page.route('**/api/profiles/tutor-preference/', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    success: true,
    selectedPersonaId: 'practice-coach',
    recommendedPersonaId: 'practice-coach',
    personas: [
      {
        id: 'practice-coach',
        name: '例题实战',
        shortDescription: '用例题、步骤和即时反馈巩固薄弱点',
        teachingStyle: 'practice',
        avatarAssetId: 'teacher-default-v1',
        avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
        voiceProfileId: 'voice-energetic-coach',
        voicePreviewEnabled: true,
        allowedWorkflows: ['coaching', 'classroom'],
        schemaVersion: 'a3.tutor-persona.v1',
        enabled: true,
      },
    ],
  }),
}));
```

将 `/api/resources/packs/` mock 整块替换为：

```ts
await page.route('**/api/resources/packs/', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    success: true,
    resourcePacks: [{
      schemaVersion: 'a3.resource-pack.v2',
      resourcePackId: 'classroom-layout-pack',
      goal: '掌握进程调度与死锁',
      learnerProfileSnapshot: {},
      resources: [],
      multimodalArtifacts: [{
        type: 'openmaic_classroom',
        status: 'succeeded',
        classroomUrl: '/classroom/classroom-layout-001',
        scenesCount: 4,
        createdAt: '2026-07-29T08:00:00Z',
      }],
    }],
  }),
}));
```

- [ ] **Step 3: 写入尚未实现的布局行为测试**

在现有 viewport 测试之后新增：

```ts
test('collapses context, reveals the sticky summary, and never covers the last message', async ({ page }) => {
  await mockClassroomLayoutDependencies(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/a3/classroom', { waitUntil: 'domcontentloaded' });

  const context = page.getByTestId('a3-classroom-context-region');
  const composer = page.getByTestId('a3-classroom-composer-frame');
  const dialogue = page.getByTestId('a3-classroom-dialogue');

  await expect(context).toBeVisible();
  await expect(page.getByTestId('a3-classroom-sticky-context')).toBeHidden();
  await page.getByRole('button', { name: '收起课堂信息' }).click();
  await expect(page.getByTestId('a3-classroom-context-summary')).toBeVisible();

  const collapsedBox = await context.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(collapsedBox!.height).toBeLessThanOrEqual(56);
  expect(composerBox!.height).toBeLessThanOrEqual(96);

  await dialogue.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByTestId('a3-classroom-sticky-context')).toBeVisible();

  const lastMessage = page.getByTestId('a3-classroom-message-assistant').last();
  const [messageBox, floatingBox] = await Promise.all([
    lastMessage.boundingBox(),
    composer.boundingBox(),
  ]);
  expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(floatingBox!.y);
});
```

同一文件现有 `gives courseware the remaining viewport height without covering the composer` 用例仍按旧的“输入区占据独立网格行”判断。将其 `inputBox` 边界断言替换为浮动结构断言：

```ts
const composer = page.getByTestId('a3-classroom-composer-frame');
const [classroomBox, workspaceBox, dialogueBox, composerBox] = await Promise.all([
  classroom.boundingBox(),
  workspace.boundingBox(),
  dialogue.boundingBox(),
  composer.boundingBox(),
]);
expect(classroomBox).not.toBeNull();
expect(workspaceBox).not.toBeNull();
expect(dialogueBox).not.toBeNull();
expect(composerBox).not.toBeNull();
expect(dialogueBox!.height).toBeGreaterThanOrEqual(viewport.minimumDialogueHeight);
expect(Math.abs(
  dialogueBox!.y + dialogueBox!.height - (workspaceBox!.y + workspaceBox!.height),
)).toBeLessThanOrEqual(1);
expect(composerBox!.y).toBeGreaterThanOrEqual(workspaceBox!.y);
expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
  workspaceBox!.y + workspaceBox!.height,
);
expect(Math.abs(classroomBox!.height - workspaceBox!.height)).toBeLessThanOrEqual(1);
```

- [ ] **Step 4: 运行测试并确认按预期失败**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-redesign-contract.test.ts
npx.cmd playwright test e2e/tests/a3-classroom-layout.spec.ts --project=chromium --workers=1
```

Expected:

- Vitest 因新组件文件不存在或源代码未包含新组件而失败。
- Playwright 因找不到 `a3-classroom-context-region` 而失败。
- 不能接受登录、mock 路由或旧 fixture 乱码导致的其他失败。

- [ ] **Step 5: 提交测试基线**

```powershell
git add OpenMAIC/tests/a3-classroom-redesign-contract.test.ts OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts
git commit -m "test: define progressive classroom layout"
```

---

### Task 2: 建立课堂上下文组件和状态恢复

**Files:**
- Create: `OpenMAIC/components/a3/features/classroom/classroom-context-shell.tsx`
- Create: `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`
- Test: `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`

- [ ] **Step 1: 写上下文组件的 jsdom 失败测试**

测试文件顶部使用 jsdom：

```ts
// @vitest-environment jsdom

import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClassroomContextShell,
  ClassroomStickyContextBar,
  useClassroomContextVisibility,
} from '@/components/a3/features/classroom/classroom-context-shell';
```

使用可控 observer：

```ts
let observerCallback: IntersectionObserverCallback | null = null;

class ControlledIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();

  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
}
```

至少覆盖三条行为：

```ts
it('defaults a new target to expanded and restores a collapsed session', async () => {
  const first = mountContext({ storageKey: 'target-a' });
  expect(first.container.querySelector('[data-testid="a3-classroom-context-expanded"]')).not.toBeNull();

  act(() => first.container.querySelector<HTMLButtonElement>('[aria-label="收起课堂信息"]')!.click());
  expect(sessionStorage.getItem('a3:classroom-context:target-a')).toBe('collapsed');
  first.unmount();

  const restored = mountContext({ storageKey: 'target-a' });
  expect(restored.container.querySelector('[data-testid="a3-classroom-context-summary"]')).not.toBeNull();
});

it('does not reuse the collapsed state for a different target', () => {
  sessionStorage.setItem('a3:classroom-context:target-a', 'collapsed');
  const view = mountContext({ storageKey: 'target-b' });
  expect(view.container.querySelector('[data-testid="a3-classroom-context-expanded"]')).not.toBeNull();
});

it('shows the sticky bar only after the context leaves the scroll root', () => {
  const view = mountContext({ storageKey: 'target-a' });
  act(() => observerCallback?.(
    [{ isIntersecting: false, target: view.contextElement } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
  expect(view.container.querySelector('[data-testid="a3-classroom-sticky-context"]')).not.toBeNull();
});
```

- [ ] **Step 2: 运行测试确认组件不存在**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-progressive-layout.test.tsx
```

Expected: FAIL，提示无法解析 `classroom-context-shell`。

- [ ] **Step 3: 创建受控上下文组件**

实现以下公开接口，不把 `ClassroomContext` 或 artifact 类型带进组件：

```tsx
'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';

export type ClassroomContextSummary = {
  title: string;
  tutorLabel: string;
  statusLabel: string;
  statusTone: 'neutral' | 'warning';
};

type VisibilityOptions = {
  storageKey: string;
  scrollRootRef: RefObject<HTMLElement | null>;
};

export function useClassroomContextVisibility({ storageKey, scrollRootRef }: VisibilityOptions) {
  const regionRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [contextInView, setContextInView] = useState(true);
  const key = `a3:classroom-context:${storageKey || 'waiting-target'}`;

  useEffect(() => {
    setExpanded(window.sessionStorage.getItem(key) !== 'collapsed');
    setContextInView(true);
    scrollRootRef.current?.scrollTo?.({ top: 0, behavior: 'auto' });
  }, [key, scrollRootRef]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setContextInView(entry.isIntersecting),
      { root: scrollRootRef.current, threshold: 0 },
    );
    observer.observe(region);
    return () => observer.disconnect();
  }, [scrollRootRef, key]);

  const setContextExpanded = useCallback((value: boolean) => {
    setExpanded(value);
    window.sessionStorage.setItem(key, value ? 'expanded' : 'collapsed');
  }, [key]);

  const openFromSticky = useCallback(() => {
    setContextExpanded(true);
    regionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    window.requestAnimationFrame(() => regionRef.current?.focus({ preventScroll: true }));
  }, [setContextExpanded]);

  return {
    regionRef,
    expanded,
    contextInView,
    collapse: () => setContextExpanded(false),
    expand: () => setContextExpanded(true),
    openFromSticky,
  };
}
```

同文件实现两个受控视图：

```tsx
export function ClassroomContextShell({
  regionRef,
  expanded,
  summary,
  summaryAction,
  collapseLabel,
  expandLabel,
  onCollapse,
  onExpand,
  children,
}: {
  regionRef: Ref<HTMLElement>;
  expanded: boolean;
  summary: ClassroomContextSummary;
  summaryAction?: ReactNode;
  collapseLabel: string;
  expandLabel: string;
  onCollapse: () => void;
  onExpand: () => void;
  children: ReactNode;
}) {
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      data-testid="a3-classroom-context-region"
      className="border-b border-slate-200 bg-white outline-none"
    >
      {expanded ? (
        <div id="a3-classroom-context-content" data-testid="a3-classroom-context-expanded" className="relative">
          <button
            type="button"
            aria-expanded="true"
            aria-controls="a3-classroom-context-content"
            aria-label={collapseLabel}
            onClick={onCollapse}
            className="absolute right-4 top-3 z-10 inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm text-slate-600 hover:bg-slate-100"
          >
            <ChevronUp className="size-4" />{collapseLabel}
          </button>
          {children}
        </div>
      ) : (
        <div data-testid="a3-classroom-context-summary" className="flex min-h-12 items-center px-4 md:px-6">
          <button
            type="button"
            aria-expanded="false"
            aria-controls="a3-classroom-context-content"
            aria-label={expandLabel}
            onClick={onExpand}
            className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950">{summary.title}</span>
            <span className="hidden text-xs text-slate-600 sm:inline">{summary.tutorLabel}</span>
            <span className={cn(
              'hidden text-xs md:inline',
              summary.statusTone === 'warning' ? 'text-amber-700' : 'text-slate-500',
            )}>
              {summary.statusLabel}
            </span>
            <ChevronDown className="size-4 shrink-0 text-slate-500" />
          </button>
          {summaryAction}
        </div>
      )}
    </section>
  );
}

export function ClassroomStickyContextBar({
  visible,
  summary,
  actions,
  mobileActions,
  onOpen,
  openLabel,
}: {
  visible: boolean;
  summary: ClassroomContextSummary;
  actions: ReactNode;
  mobileActions?: ReactNode;
  onOpen: () => void;
  openLabel: string;
}) {
  if (!visible) return null;
  return (
    <div
      data-testid="a3-classroom-sticky-context"
      className="absolute inset-x-0 top-0 z-30 flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-4 shadow-sm md:px-6"
    >
      <button
        type="button"
        aria-controls="a3-classroom-context-content"
        aria-label={openLabel}
        onClick={onOpen}
        className="min-h-11 min-w-0 flex flex-1 items-center gap-3 text-left"
      >
        <span className="truncate text-sm font-semibold text-slate-950">{summary.title}</span>
        <span className="hidden text-xs text-slate-600 sm:inline">{summary.tutorLabel}</span>
        <span className={cn(
          'hidden text-xs lg:inline',
          summary.statusTone === 'warning' ? 'text-amber-700' : 'text-slate-500',
        )}>
          {summary.statusLabel}
        </span>
      </button>
      <div className="shrink-0 sm:hidden">{mobileActions}</div>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">{actions}</div>
    </div>
  );
}
```

- [ ] **Step 4: 补全测试挂载函数并运行**

在测试文件中加入完整挂载代码。这里使用真实滚动根节点，不查询组件内部 DOM 来拼接 ref：

```tsx
const mountedRoots: Root[] = [];

function ContextHarness({ storageKey }: { storageKey: string }) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const layout = useClassroomContextVisibility({ storageKey, scrollRootRef });
  const summary = {
    title: '进程调度',
    tutorLabel: '结构化导师',
    statusLabel: '4 个场景',
    statusTone: 'neutral' as const,
  };

  return (
    <div ref={scrollRootRef} style={{ height: 320, overflowY: 'auto' }}>
      <ClassroomContextShell
        regionRef={layout.regionRef}
        expanded={layout.expanded}
        summary={summary}
        collapseLabel="收起课堂信息"
        expandLabel="展开课堂信息"
        onCollapse={layout.collapse}
        onExpand={layout.expand}
      >
        <div style={{ height: 180 }}>课堂完整信息</div>
      </ClassroomContextShell>
      <ClassroomStickyContextBar
        visible={!layout.contextInView}
        summary={summary}
        actions={<button type="button">刷新</button>}
        onOpen={layout.openFromSticky}
        openLabel="展开课堂信息"
      />
      <div style={{ height: 600 }}>对话内容</div>
    </div>
  );
}

function mountContext({ storageKey }: { storageKey: string }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => root.render(<ContextHarness storageKey={storageKey} />));
  return {
    container,
    contextElement: container.querySelector<HTMLElement>('[data-testid="a3-classroom-context-region"]')!,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      const index = mountedRoots.indexOf(root);
      if (index >= 0) mountedRoots.splice(index, 1);
    },
  };
}

beforeEach(() => {
  observerCallback = null;
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
  sessionStorage.clear();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
```

Run:

```powershell
pnpm.cmd vitest run tests/a3-classroom-progressive-layout.test.tsx
```

Expected: PASS，至少 3 tests passed。

- [ ] **Step 5: 提交上下文基础组件**

```powershell
git add OpenMAIC/components/a3/features/classroom/classroom-context-shell.tsx OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx
git commit -m "feat: add progressive classroom context shell"
```

---

### Task 3: 将课堂标题、导师和 OpenMAIC 信息接入滚动上下文

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx:534-1263`
- Modify: `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
- Test: `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
- Test: `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`

- [ ] **Step 1: 导入上下文组件并建立摘要数据**

添加导入：

```tsx
import { useStickToBottom } from 'use-stick-to-bottom';

import {
  ClassroomContextShell,
  ClassroomStickyContextBar,
  useClassroomContextVisibility,
} from './classroom/classroom-context-shell';
```

在 `ClassroomViewRedesign` 中先建立唯一的滚动容器 ref，再构造摘要。`scrollRef` 同时交给滚动库、DOM 和上下文 observer：

```tsx
const { scrollRef, contentRef } = useStickToBottom({
  initial: false,
  resize: { damping: 0.78, stiffness: 0.08, mass: 1 },
});
const contextLayout = useClassroomContextVisibility({
  storageKey: target?.id || target?.title || 'waiting-target',
  scrollRootRef: scrollRef,
});
const selectedTutorLabel = tutorPersona.personas.find(
  (persona) => persona.id === tutorPersona.selectedPersonaId,
)?.name || copy.tutorPending;
const contextSummary = {
  title: target?.title || copy.waitingTarget,
  tutorLabel: selectedTutorLabel,
  statusLabel: tutorPersona.error
    ? copy.tutorUnavailable
    : openmaicClassroomArtifact?.status === 'succeeded'
      ? `${openmaicClassroomArtifact.scenesCount || 0} ${copy.scenesUnit}`
      : copy.notGenerated,
  statusTone: tutorPersona.error ? 'warning' as const : 'neutral' as const,
};
```

- [ ] **Step 2: 将固定标题区移动到对话滚动区**

删除当前 `<section>` 下、滚动网格之前独立渲染的 `<WorkspaceHeader />`。

把工作区改为 `relative`，并在 `a3-classroom-dialogue` 内最前面渲染：

```tsx
<ClassroomContextShell
  regionRef={contextLayout.regionRef}
  expanded={contextLayout.expanded}
  summary={contextSummary}
  collapseLabel={copy.collapseClassroomInfo}
  expandLabel={copy.expandClassroomInfo}
  summaryAction={tutorPersona.error ? (
    <Button
      type="button"
      variant="ghost"
      className="min-h-11 shrink-0 gap-1 px-2 text-amber-700"
      title={copy.retryTutor}
      aria-label={copy.retryTutor}
      onClick={() => void tutorPersona.reload()}
    >
      <RefreshCw className="size-4" />
      <span className="hidden sm:inline">{copy.retryTutor}</span>
    </Button>
  ) : undefined}
  onCollapse={contextLayout.collapse}
  onExpand={contextLayout.expand}
>
  {loading && !classroom ? (
    <div
      data-testid="a3-classroom-context-loading"
      role="status"
      aria-live="polite"
      className="flex min-h-12 items-center gap-3 px-4 md:px-6"
    >
      <span className="h-4 w-40 animate-pulse rounded bg-slate-200" />
      <span className="hidden h-3 w-24 animate-pulse rounded bg-slate-100 sm:block" />
      <span className="sr-only">{copy.loadingContext}</span>
    </div>
  ) : (
    <>
      <WorkspaceHeader
        copy={copy}
        classroom={classroom}
        target={target}
        loading={loading}
        historyOpen={historyOpen}
        drawerOpen={drawerOpen}
        readiness={completedReadiness}
        onRefresh={() => void loadClassroom()}
        onToggleHistory={() => setHistoryOpen((value) => !value)}
        onToggleDrawer={() => setDrawerOpen((value) => !value)}
      />
      <div className="border-t border-slate-200 bg-[#fbfaf5] px-4 py-2 md:px-6">
        <TutorPersonaSelector
          compact
          personas={tutorPersona.personas}
          selectedPersonaId={tutorPersona.selectedPersonaId}
          recommendedPersonaId={tutorPersona.recommendedPersonaId}
          loading={tutorPersona.loading}
          saving={tutorPersona.saving}
          error={tutorPersona.error}
          onSelect={tutorPersona.selectPersona}
          onRetry={tutorPersona.reload}
        />
      </div>
      <OpenMAICInlineBar copy={copy} artifact={openmaicClassroomArtifact} />
    </>
  )}
</ClassroomContextShell>
```

`section` 必须增加：

```tsx
className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] border border-slate-200 bg-white text-slate-950 shadow-sm"
```

给现有 `a3-classroom-dialogue` 元素绑定 `scrollRef`，并给它的全部现有子节点增加唯一的 `contentRef` 包装层。开始标签固定为：

```tsx
<div
  ref={scrollRef}
  className="min-h-0 overflow-y-auto"
  data-testid="a3-classroom-dialogue"
>
  <div ref={contentRef} data-testid="a3-classroom-dialogue-content">
```

在当前 `a3-classroom-dialogue` 结束标签之前依次补上内容层和滚动层的两个 `</div>`；前一个代码块中的 `ClassroomContextShell` 以及原消息容器均是 `a3-classroom-dialogue-content` 的直接子节点。

`ClassroomContextShell` 已通过 `regionRef` prop 绑定 `contextLayout.regionRef`。Task 6 只补充跟随策略，不再替换或合并任何滚动 ref。

- [ ] **Step 3: 在工作区顶部渲染吸顶摘要**

将吸顶栏作为滚动区的绝对定位兄弟节点，不能放在消息列表流内：

```tsx
<ClassroomStickyContextBar
  visible={!contextLayout.contextInView}
  summary={contextSummary}
  onOpen={contextLayout.openFromSticky}
  openLabel={copy.expandClassroomInfo}
  actions={(
    <>
      {tutorPersona.error && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 text-amber-700"
          aria-label={copy.retryTutor}
          title={copy.retryTutor}
          onClick={() => void tutorPersona.reload()}
        >
          <RefreshCw className="size-4" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11"
        aria-label={copy.refreshContext}
        title={copy.refreshContext}
        onClick={() => void loadClassroom()}
      >
        <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11"
        aria-label={copy.sidePanel}
        title={copy.sidePanel}
        onClick={() => setDrawerOpen(true)}
      >
        <PanelRightOpen className="size-4" />
      </Button>
    </>
  )}
/>
```

- [ ] **Step 4: 增加中英文布局文案**

在 `classroomCopy` 的 `zh-CN` 和 `en-US` 同步增加：

```ts
classroomInfo: '课堂信息',
collapseClassroomInfo: '收起课堂信息',
expandClassroomInfo: '展开课堂信息',
jumpLatest: '回到最新消息',
viewingHistoryCompact: '正在查看历史对话',
loadingContext: '正在加载课堂信息',
tutorUnavailable: '导师方式加载失败',
retryTutor: '重试导师方式',
chooseTargetFirst: '请先选择学习目标，再开始提问',
tutorPending: '辅导方式待选择',
moreActions: '更多操作',
```

英文值分别使用 `Classroom info`、`Collapse classroom info`、`Expand classroom info`、`Jump to latest`、`Viewing chat history`、`Loading classroom context`、`Tutor preference unavailable`、`Retry tutor preference`、`Choose a learning target before asking a question`、`Tutor preference pending`、`More actions`。

- [ ] **Step 5: 运行上下文和接口合约测试**

```powershell
pnpm.cmd vitest run tests/a3-classroom-progressive-layout.test.tsx tests/a3-classroom-redesign-contract.test.ts
```

Expected: PASS。真实 API 字符串、`mode` 和 `scope` 断言继续通过。

- [ ] **Step 6: 提交滚动上下文集成**

```powershell
git add OpenMAIC/components/a3/features/classroom-view-redesign.tsx OpenMAIC/tests/a3-classroom-redesign-contract.test.ts
git commit -m "feat: move classroom context into dialogue flow"
```

---

### Task 4: 压缩展开态导师与 OpenMAIC 区域

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx:1265-1380`
- Modify: `OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx:102-205`
- Modify: `OpenMAIC/tests/a3-tutor-persona-selector.test.ts`
- Test: `OpenMAIC/tests/a3-tutor-persona-selector.test.ts`

- [ ] **Step 1: 先写 compact 模式的失败断言**

在导师选择器测试中新增：

```ts
it('keeps compact classroom personas within a 64px option target', () => {
  mountSelector({ compact: true, personas });
  const personaOption = query('[data-testid="a3-tutor-persona-option-structured-teacher"]');
  const description = personaOption.querySelector<HTMLElement>('[data-testid="a3-tutor-persona-description"]');
  expect(personaOption.className).toContain('min-h-16');
  expect(description?.className).toContain('line-clamp-1');
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm.cmd vitest run tests/a3-tutor-persona-selector.test.ts
```

Expected: FAIL，当前 compact 使用 `min-h-[76px]` 且描述为 `line-clamp-2`。

- [ ] **Step 3: 收紧导师 compact 视觉密度**

将 compact 分支改为：

```tsx
compact ? 'min-h-16 py-1.5' : 'min-h-[84px] py-2'
```

描述增加 test id，并按模式切换：

```tsx
<span
  data-testid="a3-tutor-persona-description"
  className={cn(
    'mt-1 block text-xs leading-5 text-[#6a7771]',
    compact ? 'line-clamp-1' : 'line-clamp-2',
  )}
>
  {persona.shortDescription}
</span>
```

推荐状态在 compact 模式只保留星形图标 tooltip，不额外增加第三行文字。试听按钮仍为独立 32px 图标按钮。

- [ ] **Step 4: 压缩 WorkspaceHeader 和 OpenMAICInlineBar**

在展开态：

- `WorkspaceHeader` 内边距从 `py-4` 调整到 `py-3`。
- 标题改为 `text-xl md:text-2xl`。
- 学习目标使用 `line-clamp-1`。
- 为右侧“收起”按钮预留至少 88px，不允许与标题操作重叠。
- OpenMAIC 条使用 `min-h-12` 单行布局。
- `pptxHint` 在 `lg` 以下隐藏，在桌面端使用 `truncate`，完整内容放入 `title` 或 tooltip。

目标 JSX：

```tsx
<div className="flex min-h-12 items-center gap-3 px-4 py-2 md:px-6">
  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
    <Layers3 className="size-4" />
  </span>
  <div className="min-w-0 flex-1">
    <div className="flex items-center gap-2">
      <h2 className="truncate text-sm font-semibold text-slate-950">{copy.openmaicClassroom}</h2>
      <A3Pill tone={artifact?.status === 'succeeded' ? 'green' : artifact ? 'orange' : 'slate'}>
        {artifact?.status ?? copy.notGenerated}
      </A3Pill>
    </div>
    <p className="hidden truncate text-xs text-slate-500 lg:block" title={copy.pptxHint}>
      {copy.pptxHint}
    </p>
  </div>
  {artifact?.classroomUrl ? (
    <Button
      asChild
      size="sm"
      className="shrink-0 bg-blue-600 text-white hover:bg-blue-700"
      data-testid="a3-classroom-openmaic-open"
    >
      <Link href={artifact.classroomUrl}>
        <ExternalLink className="size-4" />
        {copy.openClassroom}
      </Link>
    </Button>
  ) : (
    <Button asChild size="sm" variant="outline" className={cn('shrink-0', CLASSROOM_OUTLINE_BUTTON_CLASS)}>
      <Link href="/a3/recommendations">
        <UploadCloud className="size-4" />
        {copy.generateResourceClassroom}
      </Link>
    </Button>
  )}
</div>
```

- [ ] **Step 5: 运行导师和课堂测试**

```powershell
pnpm.cmd vitest run tests/a3-tutor-persona-selector.test.ts tests/a3-classroom-progressive-layout.test.tsx tests/a3-classroom-redesign-contract.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交信息密度调整**

```powershell
git add OpenMAIC/components/a3/features/classroom-view-redesign.tsx OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx OpenMAIC/tests/a3-tutor-persona-selector.test.ts
git commit -m "fix: compact classroom context controls"
```

---

### Task 5: 建立动态测量的浮动输入区

**Files:**
- Create: `OpenMAIC/components/a3/features/classroom/classroom-composer-frame.tsx`
- Modify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx:1140-1240,1505-1715`
- Modify: `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`
- Test: `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`

- [ ] **Step 1: 写 ResizeObserver 高度上报失败测试**

在 progressive layout 测试顶部增加组件导入、可控 `ResizeObserver` 和完整挂载函数：

```tsx
import { ClassroomComposerFrame } from '@/components/a3/features/classroom/classroom-composer-frame';

let resizeCallback: ResizeObserverCallback | null = null;

class ControlledResizeObserver implements ResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
}

function mountComposer({ onHeightChange }: { onHeightChange: (height: number) => void }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <ClassroomComposerFrame onHeightChange={onHeightChange}>
        <textarea defaultValue="测试问题" />
      </ClassroomComposerFrame>,
    );
  });
  return { container };
}
```

在 `beforeEach` 中追加 `vi.stubGlobal('ResizeObserver', ControlledResizeObserver)` 和 `resizeCallback = null`；Task 2 的统一 `afterEach` 已负责恢复全局对象和卸载 root。然后增加断言：

```ts
it('reports the floating composer height without owning message state', () => {
  const onHeightChange = vi.fn();
  const view = mountComposer({ onHeightChange });
  resizeCallback?.([
    { contentRect: { height: 88 } } as ResizeObserverEntry,
  ], {} as ResizeObserver);
  expect(onHeightChange).toHaveBeenLastCalledWith(88);
  expect(view.container.querySelector('[data-testid="a3-classroom-composer-frame"]')).not.toBeNull();
});
```

- [ ] **Step 2: 运行测试确认组件不存在**

```powershell
pnpm.cmd vitest run tests/a3-classroom-progressive-layout.test.tsx
```

Expected: FAIL，无法解析 `classroom-composer-frame`。

- [ ] **Step 3: 创建浮动输入框框架**

```tsx
'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function ClassroomComposerFrame({
  children,
  onHeightChange,
}: {
  children: ReactNode;
  onHeightChange: (height: number) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const report = () => onHeightChange(Math.ceil(frame.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      onHeightChange(Math.ceil(entry.contentRect.height));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={frameRef}
      data-testid="a3-classroom-composer-frame"
      className="absolute inset-x-0 bottom-0 z-20 px-3 pb-2 md:px-6"
    >
      <div className="mx-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-[0_10px_32px_rgba(15,23,42,0.12)]">
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 将主工作区改为浮动输入框加动态留白**

导入框架组件：

```tsx
import { ClassroomComposerFrame } from './classroom/classroom-composer-frame';
```

在 React import 中加入 `type CSSProperties`，并在主组件增加：

```tsx
const [composerHeight, setComposerHeight] = useState(88);
const handleComposerHeight = useCallback((height: number) => {
  setComposerHeight((current) => current === height ? current : height);
}, []);
```

工作区 style：

```tsx
style={{ '--a3-composer-height': `${composerHeight}px` } as CSSProperties}
```

给 `a3-classroom-dialogue` 滚动元素增加：

```tsx
style={{ scrollPaddingBottom: 'calc(var(--a3-composer-height) + 16px)' }}
```

给原消息内容容器增加动态底部留白：

```tsx
<div
  className="mx-auto flex w-full flex-col gap-5 px-4 py-5 pb-[calc(var(--a3-composer-height)+16px)] md:px-7"
>
```

删除 `grid-rows-[minmax(0,1fr)_auto]`，输入区改为：

```tsx
<ClassroomComposerFrame onHeightChange={handleComposerHeight}>
  <Composer
    copy={copy}
    contentWidthClass={contentWidthClass}
    target={target}
    asking={asking}
    input={input}
    message={message}
    retrievalMode={retrievalMode}
    retrievalScope={retrievalScope}
    sources={classroom?.sources ?? []}
    viewingHistoryId={viewingHistoryId}
    imageAttachment={imageAttachment}
    imageAttachmentError={imageAttachmentError}
    voiceSupported={voiceSupported}
    voiceListening={voiceListening}
    voiceTranscribing={voiceTranscribing}
    voiceDraft={voiceDraft}
    voiceError={voiceError}
    imageInputRef={imageInputRef}
    onInputChange={setInput}
    onModeChange={setRetrievalMode}
    onScopeChange={setRetrievalScope}
    onAsk={askQuestion}
    onImageUpload={handleImageUpload}
    onRemoveImage={() => {
      setImageAttachment(null);
      setImageAttachmentError('');
      if (imageInputRef.current) imageInputRef.current.value = '';
    }}
    onToggleVoice={() => void toggleVoiceInput()}
    onNewDialogue={() => void startNewClassroomDialogue()}
  />
</ClassroomComposerFrame>
```

- [ ] **Step 5: 把输入区工具收进输入框内部**

`Composer` 移除顶部独立工具行：

- 移除“新对话”“练习”“行动”三个常驻按钮。
- 保留图片、语音、检索模式、资料范围、来源数和发送。
- 历史侧栏继续承载“新建对话”。
- 右侧面板继续承载“练习”和“行动”。

同时从 `Composer` 的参数解构、TypeScript props 和调用位置删除不再使用的 `onOpenDrawer`；保留 `onNewDialogue`，因为历史只读提示仍通过它恢复新会话。

将 `Composer` 返回值开头的两层容器：

```tsx
<div className="border-t border-slate-200 bg-white px-4 py-3 md:px-6">
  <div className={cn('mx-auto w-full transition-[max-width] duration-200 ease-out', contentWidthClass)}>
```

替换为单层容器，并删除函数末尾对应的一个多余 `</div>`：

```tsx
<div className={cn('mx-auto w-full transition-[max-width] duration-200 ease-out', contentWidthClass)}>
```

在文件顶部把 React hook 导入补为 `useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState`。在 `Composer` 内增加：

```tsx
const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
```

保留当前图片预览、图片错误和语音状态块，它们位于表单之前。将当前 `<form>` 整块替换为以下真实结构：

```tsx
{message && <div aria-live="polite"><ClassroomMessage message={message} /></div>}
{viewingHistoryId && (
  <div role="status" aria-live="polite" className="mb-2 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 text-sm text-amber-800">
    <span>{copy.viewingHistoryCompact}</span>
    <Button type="button" size="sm" variant="ghost" onClick={onNewDialogue}>
      <Plus className="size-4" />{copy.shortNewDialogue}
    </Button>
  </div>
)}
{!target && (
  <div role="status" className="mb-2 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 text-sm text-slate-700">
    <span>{copy.chooseTargetFirst}</span>
    <Button asChild type="button" size="sm" variant="outline">
      <Link href="/a3/learning-path">{copy.learningPath}</Link>
    </Button>
  </div>
)}
```

把图片错误块增加 `role="alert"`；把语音状态块增加 `aria-live="polite"`，并设置 `role={voiceError || !voiceSupported ? 'alert' : 'status'}`。然后将当前 `<form>` 整块替换为：

```tsx
<form
  onSubmit={(event) => {
    event.preventDefault();
    onAsk();
  }}
  className="rounded-xl bg-white focus-within:ring-2 focus-within:ring-blue-100"
>
  <input
    ref={imageInputRef}
    type="file"
    accept="image/*"
    className="hidden"
    data-testid="a3-classroom-image-upload"
    onChange={(event) => onImageUpload(event.target.files?.[0])}
  />
  <textarea
    ref={composerTextareaRef}
    value={input}
    onChange={(event) => onInputChange(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onAsk();
      }
    }}
    data-testid="a3-classroom-input"
    rows={1}
    className="max-h-[35dvh] min-h-8 w-full resize-none overflow-y-auto bg-transparent px-3 py-1 text-sm leading-6 text-slate-950 outline-none placeholder:text-slate-400"
    placeholder={target ? copy.placeholder(target.title) : copy.placeholderNoTarget}
    disabled={!target || Boolean(viewingHistoryId)}
  />
  <div className="flex min-h-11 items-center gap-2 px-1">
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={asking || !target}
        className="size-11 rounded-lg"
        aria-label={copy.attachImage}
        title={copy.attachImage}
        onClick={() => imageInputRef.current?.click()}
      >
        <ImageIcon className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={asking || voiceTranscribing || !target || Boolean(viewingHistoryId)}
        aria-pressed={voiceListening}
        data-testid="a3-classroom-voice-input"
        className={cn('size-11 rounded-lg', voiceListening && 'bg-blue-50 text-blue-700')}
        aria-label={voiceListening ? copy.finishVoice : copy.voiceInput}
        title={voiceListening ? copy.finishVoice : copy.voiceInput}
        onClick={onToggleVoice}
      >
        {voiceTranscribing ? <Loader2 className="size-4 animate-spin" /> : voiceListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </Button>
    </div>
    <div className="min-w-0 flex-1 overflow-x-auto">
      <RetrievalControls
        copy={copy}
        mode={retrievalMode}
        scope={retrievalScope}
        sources={sources}
        disabled={disabled}
        onModeChange={onModeChange}
        onScopeChange={onScopeChange}
      />
    </div>
    <Button
      data-testid="a3-classroom-submit"
      type="submit"
      size="icon"
      disabled={asking || !target || Boolean(viewingHistoryId) || (!input.trim() && !imageAttachment)}
      className="size-11 shrink-0 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
      aria-label={copy.send}
    >
      {asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
    </Button>
  </div>
</form>
```

使用 `useLayoutEffect` 自动增高 textarea：

```tsx
useLayoutEffect(() => {
  const textarea = composerTextareaRef.current;
  if (!textarea) return;
  textarea.style.height = '0px';
  const maxHeight = Math.round(window.innerHeight * 0.35);
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}, [input]);
```

上述 `onKeyDown` 已明确保护中文输入法组合态；`Shift+Enter` 保留换行，普通 Enter 才提交。

- [ ] **Step 6: 运行组件和类型测试**

```powershell
pnpm.cmd vitest run tests/a3-classroom-progressive-layout.test.tsx tests/a3-classroom-redesign-contract.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS；TypeScript 无错误。

- [ ] **Step 7: 提交浮动输入区**

```powershell
git add OpenMAIC/components/a3/features/classroom/classroom-composer-frame.tsx OpenMAIC/components/a3/features/classroom-view-redesign.tsx OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx
git commit -m "feat: add measured floating classroom composer"
```

---

### Task 6: 接入成熟聊天滚动和“回到最新消息”

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx:575-630,1140-1220`
- Modify: `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
- Modify: `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`
- Test: `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`

- [ ] **Step 1: 写离开底部后不抢滚动位置的 E2E 失败测试**

```ts
test('preserves reading position and offers a jump-to-latest action', async ({ page }) => {
  await mockClassroomLayoutDependencies(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/a3/classroom', { waitUntil: 'domcontentloaded' });

  const dialogue = page.getByTestId('a3-classroom-dialogue');
  await dialogue.evaluate((element) => { element.scrollTop = 0; });
  const before = await dialogue.evaluate((element) => element.scrollTop);

  await page.evaluate(() => {
    const content = document.querySelector('[data-testid="a3-classroom-dialogue-content"]');
    const newMessage = document.createElement('div');
    newMessage.style.height = '480px';
    newMessage.textContent = '模拟新增的长回答内容';
    content?.append(newMessage);
  });

  expect(await dialogue.evaluate((element) => element.scrollTop)).toBe(before);
  await expect(page.getByTestId('a3-classroom-jump-latest')).toBeVisible();
  await page.getByTestId('a3-classroom-jump-latest').click();
  await expect.poll(() => dialogue.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThan(4);
});
```

- [ ] **Step 2: 运行测试确认回到底部按钮不存在**

```powershell
npx.cmd playwright test e2e/tests/a3-classroom-layout.spec.ts --project=chromium --workers=1 -g "jump-to-latest"
```

Expected: FAIL，找不到 `a3-classroom-jump-latest`。

- [ ] **Step 3: 完成 use-stick-to-bottom 的阅读位置策略**

Task 3 已导入 hook，并把 `scrollRef`、`contentRef` 绑定为唯一滚动结构。本步只把 Task 3 的解构扩展为：

```tsx
const {
  scrollRef,
  contentRef,
  scrollToBottom,
  isNearBottom,
} = useStickToBottom({
  initial: false,
  resize: { damping: 0.78, stiffness: 0.08, mass: 1 },
});
```

删除 `dialogueEndRef` 的声明、末尾空 `<div ref={dialogueEndRef} />`，并把当前自动滚动 effect：

```tsx
useEffect(() => {
  chatRef.current = chat;
  dialogueEndRef.current?.scrollIntoView({ block: 'end' });
}, [chat, asking]);
```

替换为。`initialChatSettledRef` 保证恢复历史或欢迎消息时仍从课堂上下文顶部开始，不会因首批数据写入立刻跳到底部：

```tsx
const initialChatSettledRef = useRef(false);

useEffect(() => {
  chatRef.current = chat;
  if (!initialChatSettledRef.current) {
    if (chat.length > 0) initialChatSettledRef.current = true;
    return;
  }
  void scrollToBottom({
    animation: 'smooth',
    preserveScrollPosition: true,
  });
}, [asking, chat, scrollToBottom]);
```

在主组件中增加主动发送专用回调：

```tsx
const followLatestAfterUserMessage = useCallback(() => {
  window.requestAnimationFrame(() => {
    void scrollToBottom({ animation: 'smooth', ignoreEscapes: true });
  });
}, [scrollToBottom]);
```

在 `generateResourceInClassroom()` 和 `askQuestion()` 中，将各自的 `setChat((current) => [...current, userMessage]);` 后一行都加上 `followLatestAfterUserMessage();`。这样用户主动发问必定看到自己的消息，而后台追加回答仅在原本接近底部时继续跟随。

- [ ] **Step 4: 在输入区上方增加回到底部按钮**

先在现有 `lucide-react` 导入列表加入 `ChevronDown`，再把按钮作为滚动区和浮动 Composer 的绝对定位兄弟节点：

```tsx
{!isNearBottom && (
  <button
    type="button"
    data-testid="a3-classroom-jump-latest"
    aria-label={copy.jumpLatest}
    title={copy.jumpLatest}
    onClick={() => void scrollToBottom({ animation: 'smooth', ignoreEscapes: true })}
    className="absolute bottom-[calc(var(--a3-composer-height)+12px)] left-1/2 z-20 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
  >
    <ChevronDown className="size-4" />{copy.jumpLatest}
  </button>
)}
```

该按钮只表达状态变化，不添加装饰动画。

- [ ] **Step 5: 运行滚动 E2E 和合约测试**

```powershell
pnpm.cmd vitest run tests/a3-classroom-redesign-contract.test.ts
npx.cmd playwright test e2e/tests/a3-classroom-layout.spec.ts --project=chromium --workers=1
```

Expected: PASS；用户离开底部时新增内容不抢阅读位置。

- [ ] **Step 6: 提交聊天滚动行为**

```powershell
git add OpenMAIC/components/a3/features/classroom-view-redesign.tsx OpenMAIC/tests/a3-classroom-redesign-contract.test.ts OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts
git commit -m "fix: preserve classroom reading position"
```

---

### Task 7: 完成响应式侧栏和移动端输入区

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx:566-622,1099-1255`
- Modify: `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`
- Test: `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`

- [ ] **Step 1: 写不同宽度的面板默认状态测试**

为 E2E 增加完整的表格驱动断言，并保留每个断点的截图证据：

```ts
test('uses responsive panel defaults', async ({ page }, testInfo) => {
  await mockClassroomLayoutDependencies(page);
  for (const state of [
    { width: 1920, height: 1080, historyVisible: true, drawerVisible: true },
    { width: 1440, height: 900, historyVisible: true, drawerVisible: false },
    { width: 1024, height: 768, historyVisible: false, drawerVisible: false },
    { width: 390, height: 844, historyVisible: false, drawerVisible: false },
  ]) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.goto('/a3/classroom', { waitUntil: 'domcontentloaded' });
    const history = page.getByTestId('a3-classroom-history-panel');
    const drawer = page.getByTestId('a3-classroom-drawer');
    if (state.historyVisible) {
      await expect(history).toBeVisible();
    } else {
      await expect(history).toBeHidden();
    }
    if (state.drawerVisible) {
      await expect(drawer).toBeVisible();
    } else {
      await expect(drawer).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => document.documentElement.clientWidth),
    );
    await page.screenshot({
      path: testInfo.outputPath(`a3-classroom-responsive-${state.width}x${state.height}.png`),
      fullPage: true,
    });
  }
});
```

现有 `gives courseware the remaining viewport height without covering the composer` 用例不能再假设右侧面板始终默认打开。把其中无条件点击“侧面板”的三行替换为：

```ts
const drawer = page.getByTestId('a3-classroom-drawer');
if (await drawer.isVisible()) {
  await workspace.getByRole('button', { name: '侧面板', exact: true }).click();
}
await expect(drawer).toBeHidden();
```

- [ ] **Step 2: 运行测试确认 1440px 当前仍同时打开两侧**

```powershell
npx.cmd playwright test e2e/tests/a3-classroom-layout.spec.ts --project=chromium --workers=1 -g "panel defaults"
```

Expected: FAIL，当前 `historyOpen` 和 `drawerOpen` 都默认 `true`。

- [ ] **Step 3: 按断点同步默认面板状态**

新增纯函数：

```ts
function classroomPanelDefaults(width: number) {
  if (width >= 1600) return { historyOpen: true, drawerOpen: true };
  if (width >= 1280) return { historyOpen: true, drawerOpen: false };
  return { historyOpen: false, drawerOpen: false };
}
```

挂载时只执行一次默认同步，之后尊重用户手动开关：

```tsx
useEffect(() => {
  const defaults = classroomPanelDefaults(window.innerWidth);
  setHistoryOpen(defaults.historyOpen);
  setDrawerOpen(defaults.drawerOpen);
}, []);
```

现有页面滚动锁继续以 `min-width: 1280px` 为边界，不扩展到移动端。

- [ ] **Step 4: 收紧移动端吸顶栏和输入工具**

在 `lucide-react` 导入中加入 `MoreHorizontal`，并在 `classroom-view-redesign.tsx` 新增移动端原生菜单：

```tsx
function MobileStickyActions({
  copy,
  loading,
  tutorError,
  onRefresh,
  onRetryTutor,
  onOpenDrawer,
}: {
  copy: ClassroomCopy;
  loading: boolean;
  tutorError: boolean;
  onRefresh: () => void;
  onRetryTutor: () => void;
  onOpenDrawer: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const runAndClose = (action: () => void) => {
    detailsRef.current?.removeAttribute('open');
    action();
  };
  return (
    <details ref={detailsRef} className="relative">
      <summary
        aria-label={copy.moreActions}
        title={copy.moreActions}
        className="inline-flex size-11 list-none items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
      >
        <MoreHorizontal className="size-5" />
      </summary>
      <div className="absolute right-0 top-full z-40 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
        {tutorError && (
          <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-sm text-amber-700 hover:bg-amber-50" onClick={() => runAndClose(onRetryTutor)}>
            <RefreshCw className="size-4" />{copy.retryTutor}
          </button>
        )}
        <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-sm text-slate-700 hover:bg-slate-50" onClick={() => runAndClose(onRefresh)}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />{copy.refreshContext}
        </button>
        <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-sm text-slate-700 hover:bg-slate-50" onClick={() => runAndClose(onOpenDrawer)}>
          <PanelRightOpen className="size-4" />{copy.sidePanel}
        </button>
      </div>
    </details>
  );
}
```

给 Task 3 的 `ClassroomStickyContextBar` 增加：

```tsx
mobileActions={(
  <MobileStickyActions
    copy={copy}
    loading={loading}
    tutorError={Boolean(tutorPersona.error)}
    onRefresh={() => void loadClassroom()}
    onRetryTutor={() => void tutorPersona.reload()}
    onOpenDrawer={() => setDrawerOpen(true)}
  />
)}
```

将 `ClassroomComposerFrame` 的定位类替换为以下安全区版本：

```tsx
className="absolute inset-x-0 bottom-0 z-20 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:px-6 md:pb-2"
```

将 `RetrievalControls` 根节点从 `flex flex-wrap` 改为：

```tsx
className="flex min-w-max flex-nowrap items-center gap-2"
```

外层仍使用 Task 5 已写明的 `min-w-0 flex-1 overflow-x-auto`，发送按钮保持 `size-11 shrink-0`。主页面继续使用当前 `100dvh`，不得改回 `100vh`。

- [ ] **Step 5: 运行全部课堂布局 E2E**

```powershell
npx.cmd playwright test e2e/tests/a3-classroom-layout.spec.ts --project=chromium --workers=1
```

Expected: PASS，所有 viewport 无重叠和横向溢出。

- [ ] **Step 6: 提交响应式行为**

```powershell
git add OpenMAIC/components/a3/features/classroom-view-redesign.tsx OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts
git commit -m "fix: adapt classroom workspace density"
```

---

### Task 8: 完成视觉验证和全量回归

**Files:**
- Modify only if validation finds an issue:
  - `OpenMAIC/components/a3/features/classroom-view-redesign.tsx`
  - `OpenMAIC/components/a3/features/classroom/classroom-context-shell.tsx`
  - `OpenMAIC/components/a3/features/classroom/classroom-composer-frame.tsx`
  - `OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx`
- Test:
  - `OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx`
  - `OpenMAIC/tests/a3-classroom-redesign-contract.test.ts`
  - `OpenMAIC/tests/a3-tutor-persona-selector.test.ts`
  - `OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts`
  - Existing A3 classroom E2E suite

- [ ] **Step 1: 运行课堂专项单元测试**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-progressive-layout.test.tsx tests/a3-classroom-redesign-contract.test.ts tests/a3-tutor-persona-selector.test.ts tests/a3-classroom-markdown.test.ts
```

Expected: all tests passed。

- [ ] **Step 2: 运行 TypeScript 和 lint**

```powershell
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected:

- `tsc` exit code 0。
- lint 无新增 error；只能保留 `AGENTS.md` 已列出的历史 warning。

- [ ] **Step 3: 运行课堂业务回归**

```powershell
pnpm.cmd vitest run tests/a3-openmaic-classroom-bridge.test.ts tests/a3-openmaic-artifact-history.test.ts tests/a3-openmaic-page-ownership.test.ts tests/a3-openmaic-handoff-sync.test.ts tests/a3-openmaic-text-quality.test.ts
pnpm.cmd test:e2e:a3-classroom
```

Expected: OpenMAIC 课堂、PPTX artifact、课堂笔记和课堂内练习回写继续通过。

- [ ] **Step 4: 生成五个 viewport 的 Playwright 截图**

```powershell
npx.cmd playwright test e2e/tests/a3-classroom-layout.spec.ts --project=chromium --workers=1
```

检查 test output 中：

- `1920x1080` 首屏展开、两侧栏显示。
- `1440x900` 右侧栏默认收起，主对话宽度合理。
- `1366x768` 手动收起后上下文不超过 56px，输入区不超过 96px。
- `1024x768` 两侧栏进入抽屉。
- `390x844` 无横向滚动，发送按钮和输入区可见。

- [ ] **Step 5: 做像素与边界断言**

Playwright 中至少保留以下数值断言：

```ts
expect(collapsedContextBox.height).toBeLessThanOrEqual(56);
expect(stickyContextBox.height).toBeLessThanOrEqual(48);
expect(idleComposerBox.height).toBeLessThanOrEqual(96);
expect(lastMessageBox.y + lastMessageBox.height).toBeLessThanOrEqual(composerBox.y);
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
  await page.evaluate(() => document.documentElement.clientWidth),
);
```

- [ ] **Step 6: 检查没有调试残留和无关变更**

```powershell
cd D:\Download\A3
rg -n "DEBUG-|console\.log" OpenMAIC/components/a3/features/classroom OpenMAIC/components/a3/features/classroom-view-redesign.tsx
git diff --check
git status --short --branch
```

Expected:

- 新组件无调试日志和占位文字。
- 不暂存 `control/*.pidbox.exchange`、`.tmp/`、`outputs/` 或用户的其他未跟踪文件。

- [ ] **Step 7: 提交最终验证修正**

只有视觉或回归验证产生必要修正时才创建该提交：

```powershell
git add OpenMAIC/components/a3/features/classroom OpenMAIC/components/a3/features/classroom-view-redesign.tsx OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx OpenMAIC/tests/a3-classroom-progressive-layout.test.tsx OpenMAIC/tests/a3-classroom-redesign-contract.test.ts OpenMAIC/tests/a3-tutor-persona-selector.test.ts OpenMAIC/e2e/tests/a3-classroom-layout.spec.ts
git commit -m "fix: finish classroom progressive layout"
```

Expected: 如果没有额外修正，不创建空提交。

---

## 最终验收清单

- [ ] 新课堂首次进入时课堂上下文展开。
- [ ] 手动收起后刷新当前标签页仍保持收起。
- [ ] 新学习目标不继承旧目标的收起状态。
- [ ] 上下文滚出后只显示一条紧凑吸顶栏。
- [ ] 从吸顶栏打开课堂信息会回到顶部并展开。
- [ ] 加载时显示 48px 骨架；导师错误在摘要中可见并可重试。
- [ ] 无学习目标时提供学习路径入口；历史会话明确只读并可新建对话。
- [ ] 输入区空闲高度不超过 96px。
- [ ] 多行输入、图片和语音状态不会覆盖消息。
- [ ] 用户阅读旧消息时，新内容不会强制滚到底部。
- [ ] “回到最新消息”可以恢复跟随。
- [ ] 检索 `mode`、`scope` 和所有课堂 API 契约不变。
- [ ] 长 Markdown、公式、表格、代码块和最后一条消息无重叠。
- [ ] 桌面、普通笔记本、平板和移动端均无横向溢出。
- [ ] 图标按钮有 `aria-label`/tooltip，关键触控目标不小于 44px。
- [ ] 未混入无关本地文件，未修改后端接口。
