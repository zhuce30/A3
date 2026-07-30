# A3 Knowledge Graph Evidence Workbench P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/a3/knowledge-graph` 的 P0 桌面体验重构为“页头 + 工具栏 + 同高画布/详情 + 状态栏”，移除遮挡图谱的浮层和拉长页面的构建状态卡，同时保持真实图谱接口、D3 Force、React Flow、增量邻域加载和证据详情不变。

**Architecture:** `KnowledgeGraphView` 继续拥有请求、图数据合并、选择和视图切换状态；新增的工具栏、工作区和状态栏均为无请求的展示组件，通过明确 props 接收状态与回调。详情是否可见由独立 `detailOpen` 状态控制，使用户可以关闭详情而不丢失中心节点、画布位置或已加载邻域。

**Tech Stack:** Next.js 16、React 19、TypeScript、Tailwind CSS 4、React Flow、D3 Force、Radix Popover、Vitest、Playwright

---

## Scope

本计划只实现设计规格中的 P0：

- 页面结构重组。
- 搜索、跳数和图谱切换进入画布上方工具栏。
- 图谱质量进入“数据状态”Popover。
- 详情与画布同高、内部滚动，并可关闭。
- 移除独立构建状态卡和画布内浮层。
- 画布高度响应可视区域。
- 保留现有 loading、empty、error 和真实 API 行为。

不包含：移动端关系列表、底部详情抽屉、全图实体搜索、新后端接口、教师质量审核、打开资料定位和新增学习动作。这些属于 P1/P2。

## File Map

### Create

- `OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-toolbar.tsx`
  - 资料图谱/课程路径分段控制、当前视图搜索、跳数切换和重置；同时导出供页头使用的数据状态入口。
- `OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-workspace.tsx`
  - 画布与详情的同高布局、详情关闭、内部滚动和窄屏覆盖行为。
- `OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-status-bar.tsx`
  - 当前加载数量、跳数、局部视图、加载和降级提示。
- `OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts`
  - P0 静态结构契约和回归保护。
- `OpenMAIC/e2e/tests/a3-knowledge-graph-workbench.spec.ts`
  - 真实登录后的选择、详情关闭和工作区滚动验证。

### Modify

- `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
  - 保留请求与图构建；替换嵌套卡片、浮层和常驻详情布局。
- `OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx`
  - 删除 `MaterialGraphSearchPanel` 和 `MaterialGraphMiniPanel`；将质量内容改成可嵌入 Popover 的 `MaterialGraphDataStatus`。
- `OpenMAIC/components/a3/features/knowledge-graph/material-detail-panel.tsx`
  - 从自身 `A3Card` 外壳解耦，变为详情正文，由工作区统一提供标题、关闭和滚动边界。
- `OpenMAIC/tests/a3-knowledge-graph-focused-layout.test.ts`
  - 移除“质量面板必须悬浮画布”的旧实现断言，保留真实接口和图算法断言。
- `OpenMAIC/tests/a3-material-knowledge-graph.test.ts`
  - 保留证据契约，补充无证据和待验证文案断言。

## Task 1: Capture The Real-Data Baseline

**Files:**

- Create: `OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts`
- Test: `OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts`

- [ ] **Step 1: Create a baseline test for behavior that must survive the redesign**

Create the test with only the current real-data contract. Do not add assertions for files that later tasks have not implemented yet:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const featureDir = path.join(root, 'components/a3/features/knowledge-graph');
const viewPath = path.join(root, 'components/a3/features/knowledge-graph-view.tsx');

describe('A3 knowledge graph evidence workbench', () => {
  it('preserves the real APIs and incremental material neighborhood loading', () => {
    const view = fs.readFileSync(viewPath, 'utf8');

    expect(fs.existsSync(path.join(featureDir, 'material-focused-flow.tsx'))).toBe(true);
    expect(view).toContain('/api/kb/graph/?');
    expect(view).toContain("'/api/learning/graph/'");
    expect(view).toContain("'/api/learning/paths/generate/'");
    expect(view).toContain("params.set('centerId', centerId)");
    expect(view).toContain('mergeMaterialGraphs');
    expect(view).not.toContain('mockMaterialGraph');
  });

});
```

- [ ] **Step 2: Run the baseline together with the existing focused tests**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts tests/a3-knowledge-graph-focused-layout.test.ts
```

Expected: PASS. This is a characterization test, not a behavior change; it protects the real APIs before the first RED step.

- [ ] **Step 3: Commit the green baseline test**

```powershell
cd D:\Download\A3
git add OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts
git commit -m "test(a3): preserve knowledge graph data contract"
```

## Task 2: Build The Toolbar And Data Status Popover

**Files:**

- Create: `OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-toolbar.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx`
- Test: `OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts`

- [ ] **Step 1: Add a failing data-status ownership assertion**

Append to the workbench test:

```ts
it('moves graph quality into the explicit data-status popover', () => {
  const toolbar = fs.readFileSync(path.join(featureDir, 'knowledge-graph-toolbar.tsx'), 'utf8');
  const panels = fs.readFileSync(path.join(featureDir, 'material-graph-panels.tsx'), 'utf8');

  expect(toolbar).toContain('GraphDataStatusPopover');
  expect(toolbar).toContain('数据状态');
  expect(panels).toContain('export function MaterialGraphDataStatus');
});

it('labels material search as current-view search and exposes accessible tabs', () => {
  const toolbar = fs.readFileSync(path.join(featureDir, 'knowledge-graph-toolbar.tsx'), 'utf8');

  expect(toolbar).toContain('搜索当前视图中的实体');
  expect(toolbar).toContain('当前视图没有匹配实体');
  expect(toolbar).toContain('role="tablist"');
  expect(toolbar).toContain('aria-selected');
  expect(toolbar).toContain('a3-material-graph-depth-one');
  expect(toolbar).toContain('a3-material-graph-depth-two');
  expect(toolbar).toContain('a3-material-graph-depth-all');
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts
```

Expected: FAIL because `GraphDataStatusPopover` and `MaterialGraphDataStatus` are missing.

- [ ] **Step 3: Replace floating panel exports with reusable data-status content**

Keep the existing exports temporarily because `KnowledgeGraphView` still imports them until Task 5. Add `MaterialGraphDataStatus` alongside `MaterialGraphStatsPanel`, reusing `deriveVisibleQuality`, `Stat`, and `Quality`:

```tsx
export function MaterialGraphDataStatus({ graph }: { graph: MaterialGraph | null }) {
  const quality = graph?.quality ?? (graph ? deriveVisibleQuality(graph) : {});

  return (
    <div className="w-[320px] space-y-4" data-testid="a3-material-graph-data-status">
      <div>
        <div className="text-sm font-semibold text-[var(--a3-text)]">数据状态</div>
        <div className="mt-1 text-xs text-[var(--a3-text-muted)]">
          {graph?.build.status ?? 'empty'} · {graph?.schemaVersion ?? 'a3.material-knowledge-graph.v1'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="实体" value={graph?.summary.entityCount ?? 0} />
        <Stat label="关系" value={graph?.summary.relationCount ?? 0} />
        <Stat label="资料" value={graph?.summary.resourceCount ?? 0} />
        <Stat label="断言" value={graph?.summary.claimCount ?? 0} />
      </div>
      <div className="space-y-2">
        <Quality label="证据覆盖" value={quality.evidenceCoverage} />
        <Quality label="孤立实体" value={quality.isolatedEntityRate} reverse />
        <Quality label="关系密度" value={quality.relationDensity} />
      </div>
      <dl className="grid gap-2 text-xs text-[var(--a3-text-muted)]">
        <div className="flex justify-between gap-4"><dt>最近构建</dt><dd>{formatBuildTime(graph?.build.lastBuiltAt)}</dd></div>
        <div className="flex justify-between gap-4"><dt>别名合并</dt><dd>{quality.aliasMergeCount ?? 0}</dd></div>
        <div className="flex justify-between gap-4"><dt>补抽轮次</dt><dd>{quality.gleaningRounds ?? 0}</dd></div>
      </dl>
      {graph?.build.reason ? <p className="text-xs leading-5 text-[var(--a3-text-muted)]">{graph.build.reason}</p> : null}
    </div>
  );
}

function formatBuildTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '暂无';
}
```

- [ ] **Step 4: Create the toolbar as a controlled component**

Use existing `Button`, `Popover`, Lucide icons, `cn`, `MaterialGraphDataStatus`, and `MaterialGraphDepth`. The public interface must be:

```tsx
export type KnowledgeGraphToolbarProps = {
  activeTab: 'material' | 'course';
  onTabChange: (tab: 'material' | 'course') => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchMatches: MaterialNode[];
  onSelectSearchResult: (nodeId: string) => void;
  depth: MaterialGraphDepth;
  onDepthChange: (depth: MaterialGraphDepth) => void;
  onReset: () => void;
  loading: boolean;
};
```

The rendered structure must include:

```tsx
<div className="flex flex-col gap-3 border-b border-[var(--a3-border)] px-4 py-3 lg:flex-row lg:items-center">
  <div role="tablist" aria-label="知识关系视图" className="inline-flex w-fit rounded-md bg-[var(--a3-surface-muted)] p-1">
    <button role="tab" aria-selected={activeTab === 'material'}>资料图谱</button>
    <button role="tab" aria-selected={activeTab === 'course'}>课程路径</button>
  </div>
  {activeTab === 'material' ? (
    <>
      <MaterialGraphSearch
        query={query}
        matches={searchMatches}
        onQueryChange={onQueryChange}
        onSelect={onSelectSearchResult}
        disabled={loading}
      />
      <GraphDepthControl depth={depth} onChange={onDepthChange} disabled={loading} />
      <Button variant="ghost" size="sm" onClick={onReset}>重置</Button>
    </>
  ) : null}
</div>
```

Use the existing Radix wrapper for the page-header action:

```tsx
export function GraphDataStatusPopover({ graph }: { graph: MaterialGraph | null }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Database className="size-4" />
          数据状态
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-4">
        <MaterialGraphDataStatus graph={graph} />
      </PopoverContent>
    </Popover>
  );
}
```

`GraphDepthControl` must retain the existing test ids and use a segmented-control group:

```tsx
function GraphDepthControl(props: {
  depth: MaterialGraphDepth;
  onChange: (depth: MaterialGraphDepth) => void;
  disabled: boolean;
}) {
  return (
    <div role="group" aria-label="关系范围" className="inline-flex rounded-md border border-[var(--a3-border)] p-0.5">
      {(['one', 'two', 'all'] as const).map((depth) => (
        <button
          key={depth}
          type="button"
          data-testid={`a3-material-graph-depth-${depth}`}
          disabled={props.disabled}
          aria-pressed={props.depth === depth}
          onClick={() => props.onChange(depth)}
          className={cn(
            'min-h-8 rounded px-3 text-xs font-medium transition-colors',
            props.depth === depth ? 'bg-blue-50 text-blue-700' : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)]',
          )}
        >
          {{ one: '一跳', two: '二跳', all: '全部' }[depth]}
        </button>
      ))}
    </div>
  );
}
```

`MaterialGraphSearch` owns only local candidate visibility. Its filtering remains in `KnowledgeGraphView`:

```tsx
function MaterialGraphSearch(props: {
  query: string;
  matches: MaterialNode[];
  onQueryChange: (value: string) => void;
  onSelect: (nodeId: string) => void;
  disabled: boolean;
}) {
  const open = props.query.trim().length > 0;
  return (
    <div className="relative min-w-0 flex-1 lg:max-w-md">
      <label className="flex min-h-9 items-center gap-2 rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3">
        <Search className="size-4 shrink-0 text-[var(--a3-text-muted)]" />
        <input
          role="combobox"
          aria-label="搜索当前视图中的实体"
          aria-expanded={open}
          value={props.query}
          disabled={props.disabled}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder="搜索当前视图中的实体"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      {open ? (
        <div role="listbox" className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-1 shadow-lg">
          {props.matches.length ? props.matches.map((node) => (
            <button key={node.id} role="option" type="button" onClick={() => props.onSelect(node.id)} className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--a3-surface-muted)]">
              <span className="block truncate text-sm font-medium text-[var(--a3-text)]">{node.label}</span>
              <span className="block truncate text-xs text-[var(--a3-text-muted)]">{node.summary || materialTypeLabel[node.type] || node.type}</span>
            </button>
          )) : <div className="px-3 py-2 text-sm text-[var(--a3-text-muted)]">当前视图没有匹配实体</div>}
        </div>
      ) : null}
    </div>
  );
}
```

`MaterialGraphSearch` must use `role="combobox"`, `aria-expanded`, a result `role="listbox"`, at most 8 results, and these exact strings:

```tsx
placeholder="搜索当前视图中的实体"
```

```tsx
<div className="px-3 py-2 text-sm text-[var(--a3-text-muted)]">当前视图没有匹配实体</div>
```

- [ ] **Step 5: Run the test and confirm GREEN**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts
```

Expected: all current workbench tests pass; no future workspace assertion has been added yet.

- [ ] **Step 6: Commit toolbar and data status**

```powershell
cd D:\Download\A3
git add OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-toolbar.tsx OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts
git commit -m "feat(a3): add knowledge graph workbench toolbar"
```

## Task 3: Build The Same-Height Workspace And Status Bar

**Files:**

- Create: `OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-workspace.tsx`
- Create: `OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-status-bar.tsx`
- Test: `OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts`

- [ ] **Step 1: Add failing workspace behavior assertions**

Append:

```ts
it('keeps canvas and detail in one bounded workspace', () => {
  const workspace = fs.readFileSync(path.join(featureDir, 'knowledge-graph-workspace.tsx'), 'utf8');

  expect(workspace).toContain('data-testid="a3-knowledge-graph-workspace"');
  expect(workspace).toContain("xl:grid-cols-[minmax(0,1fr)_380px]");
  expect(workspace).toContain('overflow-y-auto');
  expect(workspace).toContain('aria-label="关闭详情"');
  expect(workspace).toContain('min-h-[560px]');
});

it('reports loaded scope instead of full graph quality in the status bar', () => {
  const status = fs.readFileSync(path.join(featureDir, 'knowledge-graph-status-bar.tsx'), 'utf8');

  expect(status).toContain('当前加载');
  expect(status).toContain('当前为局部视图');
  expect(status).toContain('部分内容为降级抽取');
  expect(status).not.toContain('关系密度');
});
```

- [ ] **Step 2: Run and confirm RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts
```

Expected: FAIL because the workspace and status files do not exist.

- [ ] **Step 3: Create the workspace shell**

Implement this controlled boundary:

```tsx
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function KnowledgeGraphWorkspace(props: {
  canvas: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  detailTitle: string;
  onCloseDetail: () => void;
}) {
  return (
    <section
      data-testid="a3-knowledge-graph-workspace"
      className={cn(
        'relative grid h-[min(760px,calc(100dvh-13rem))] min-h-[560px] overflow-hidden',
        'max-md:h-[560px] max-md:min-h-[480px]',
        props.detailOpen && 'xl:grid-cols-[minmax(0,1fr)_380px]',
      )}
    >
      <div className="min-h-0 min-w-0">{props.canvas}</div>
      {props.detailOpen ? (
        <aside
          aria-label={props.detailTitle}
          className="absolute inset-y-0 right-0 z-20 flex w-[min(400px,92%)] flex-col border-l border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-xl xl:static xl:w-auto xl:shadow-none"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--a3-border)] px-4">
            <h2 className="text-sm font-semibold text-[var(--a3-text)]">{props.detailTitle}</h2>
            <Button variant="ghost" size="icon" onClick={props.onCloseDetail} aria-label="关闭详情">
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{props.detail}</div>
        </aside>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 4: Create the status bar**

```tsx
import type { MaterialGraph, MaterialGraphFocus } from './material-types';
import type { MaterialGraphDepth } from './material-focused-flow';

const depthLabel: Record<MaterialGraphDepth, string> = { one: '一跳', two: '二跳', all: '全部' };

export function KnowledgeGraphStatusBar(props: {
  graph: MaterialGraph | null;
  focus?: MaterialGraphFocus;
  depth: MaterialGraphDepth;
  loading: boolean;
}) {
  const nodeCount = props.focus?.returnedNodeCount ?? props.graph?.nodes.length ?? 0;
  const edgeCount = props.focus?.returnedEdgeCount ?? props.graph?.edges.length ?? 0;
  const partial = Boolean(props.focus?.partial || props.focus?.hasMore);

  return (
    <footer className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--a3-border)] px-4 py-2 text-xs text-[var(--a3-text-muted)]">
      <span>当前加载 {nodeCount} 个实体</span><span aria-hidden>·</span>
      <span>{edgeCount} 条关系</span><span aria-hidden>·</span>
      <span>{depthLabel[props.depth]}</span>
      {props.loading ? <span>· 正在更新</span> : <span>· 数据已更新</span>}
      {partial ? <span className="text-amber-700">· 当前为局部视图</span> : null}
      {props.graph?.build.degraded ? <span className="text-amber-700">· 部分内容为降级抽取</span> : null}
    </footer>
  );
}
```

- [ ] **Step 5: Run the tests and confirm GREEN for the new components**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts
```

Expected: all current workbench tests pass; view integration assertions are added only in Task 5.

- [ ] **Step 6: Commit the workspace boundary**

```powershell
cd D:\Download\A3
git add OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-workspace.tsx OpenMAIC/components/a3/features/knowledge-graph/knowledge-graph-status-bar.tsx OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts
git commit -m "feat(a3): add bounded knowledge graph workspace"
```

## Task 4: Make Material Detail Content Drawer-Safe

**Files:**

- Modify: `OpenMAIC/components/a3/features/knowledge-graph/material-detail-panel.tsx`
- Modify: `OpenMAIC/tests/a3-material-knowledge-graph.test.ts`

- [ ] **Step 1: Write failing detail-state assertions**

Append to `a3-material-knowledge-graph.test.ts`:

```ts
it('renders detail content without its own outer card and distinguishes evidence states', () => {
  const detail = fs.readFileSync(detailPath, 'utf8');

  expect(detail).not.toContain('<A3Card');
  expect(detail).toContain('暂无可核验来源');
  expect(detail).toContain('待验证');
  expect(detail).toContain('降级抽取');
  expect(detail).toContain('data-testid="a3-material-detail-panel"');
});
```

- [ ] **Step 2: Run and confirm RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-material-knowledge-graph.test.ts
```

Expected: FAIL because the detail still renders `A3Card` and says “暂无证据片段”。

- [ ] **Step 3: Remove only the outer card ownership**

Change `MaterialDetailPanel` so its edge and node branches return plain content:

```tsx
type MaterialDetailPanelProps = {
  node: MaterialNode | null;
  edge: MaterialEdge | null;
  claims: MaterialClaim[];
  edges: MaterialEdge[];
  nodesById: Map<string, MaterialNode>;
};

export function MaterialDetailPanel(props: MaterialDetailPanelProps) {
  const { node, edge, claims, edges, nodesById } = props;

  if (edge) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    return (
      <div className="space-y-5" data-testid="a3-material-detail-panel">
        <DetailHeading
          title={edge.label || edge.type}
          meta={`${edge.type} · 权重 ${Math.round((edge.weight ?? 0) * 100)}%`}
          state={edge.degraded ? 'degraded' : edge.evidence.length ? 'verified' : 'unverified'}
        />
        <ReadablePath source={source?.label ?? edge.source} label={edge.label || edge.type} target={target?.label ?? edge.target} confidence={edge.weight} />
        <EvidenceList evidence={edge.evidence} />
      </div>
    );
  }

  return node ? (
    <div data-testid="a3-material-detail-panel">
      <EntityDetail node={node} edges={edges} claims={claims} nodesById={nodesById} />
    </div>
  ) : null;
}
```

Add one state helper and use the existing `A3Pill`:

```tsx
function DetailHeading(props: { title: string; meta: string; state: 'verified' | 'unverified' | 'degraded' }) {
  const state = {
    verified: { label: '已验证', tone: 'green' as const },
    unverified: { label: '待验证', tone: 'slate' as const },
    degraded: { label: '降级抽取', tone: 'orange' as const },
  }[props.state];

  return (
    <header>
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-lg font-semibold text-[var(--a3-text)]">{props.title}</h3>
        <A3Pill tone={state.tone}>{state.label}</A3Pill>
      </div>
      <p className="mt-1 text-sm text-[var(--a3-text-muted)]">{props.meta}</p>
    </header>
  );
}
```

For entity state, call `DetailHeading` at the top of `EntityDetail` before the standard explanation:

```tsx
<DetailHeading
  title={props.node.label}
  meta={`${materialTypeLabel[props.node.type] ?? props.node.type} · 置信度 ${Math.round((props.node.confidence ?? 0) * 100)}%`}
  state={props.node.degraded ? 'degraded' : props.node.evidence.length ? 'verified' : 'unverified'}
/>
```

Remove the old duplicated entity `<h2>` and meta paragraph. Change the empty evidence copy to:

```tsx
{!evidence.length && <p className="text-sm text-[var(--a3-text-muted)]">暂无可核验来源。</p>}
```

- [ ] **Step 4: Run and confirm GREEN**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-material-knowledge-graph.test.ts
```

Expected: all material detail contract tests pass.

- [ ] **Step 5: Commit drawer-safe detail content**

```powershell
cd D:\Download\A3
git add OpenMAIC/components/a3/features/knowledge-graph/material-detail-panel.tsx OpenMAIC/tests/a3-material-knowledge-graph.test.ts
git commit -m "refactor(a3): make graph evidence detail drawer safe"
```

## Task 5: Integrate The Workbench Into KnowledgeGraphView

**Files:**

- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
- Test: `OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts`
- Test: `OpenMAIC/tests/a3-knowledge-graph-focused-layout.test.ts`

- [ ] **Step 1: Add failing state-ownership assertions**

Append to the workbench test:

```ts
it('controls contextual detail separately from graph selection', () => {
  const view = fs.readFileSync(viewPath, 'utf8');

  expect(view).toContain('const [detailOpen, setDetailOpen] = useState(true)');
  expect(view).toContain('setDetailOpen(true)');
  expect(view).toContain('onCloseDetail={() => setDetailOpen(false)}');
  expect(view).toContain('searchMatches={materialSearchMatches}');
  expect(view).toContain('<section ref={graphRef}');
  expect(view).not.toContain('<A3Card');
});

it('composes the workbench and removes controls that covered graph nodes', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  const panels = fs.readFileSync(path.join(featureDir, 'material-graph-panels.tsx'), 'utf8');

  expect(view).toContain('<KnowledgeGraphToolbar');
  expect(view).toContain('<KnowledgeGraphWorkspace');
  expect(view).toContain('<KnowledgeGraphStatusBar');
  expect(view).not.toContain('absolute left-4 top-4');
  expect(view).not.toContain('absolute right-4 top-4');
  expect(view).not.toContain('MaterialGraphMiniPanel');
  expect(view).not.toContain('<A3Card title="构建状态">');
  expect(view).not.toContain('h-[680px]');
  expect(panels).not.toContain('export function MaterialGraphSearchPanel');
  expect(panels).not.toContain('export function MaterialGraphMiniPanel');
  expect(panels).not.toContain('export function MaterialGraphStatsPanel');
});
```

In `a3-knowledge-graph-focused-layout.test.ts`, replace the old floating ownership assertions:

```ts
expect(source).toContain('data-testid="a3-material-graph-search"');
expect(source).toContain('data-testid="a3-material-graph-quality-panel"');
```

with:

```ts
expect(source).toContain('data-testid="a3-real-knowledge-graph"');
expect(source).toContain('data-testid="a3-material-focused-graph"');
expect(source).toContain('data-testid="a3-material-detail-panel"');
expect(source).toContain('KnowledgeGraphToolbar');
expect(source).toContain('KnowledgeGraphWorkspace');
```

- [ ] **Step 2: Run and confirm RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts tests/a3-knowledge-graph-focused-layout.test.ts
```

Expected: FAIL because `KnowledgeGraphView` still owns the old grid, cards and floating panels.

- [ ] **Step 3: Replace imports and derive search results in the view**

Remove `MaterialGraphMiniPanel`, `MaterialGraphSearchPanel`, `MaterialGraphStatsPanel`, `A3Card`, and `InfoBox` usage. After the view no longer imports them, delete the three obsolete exports and their unused imports from `material-graph-panels.tsx`. Keep `MaterialGraphDataStatus`, `deriveVisibleQuality`, `Stat`, and `Quality`. Add:

```tsx
import { GraphDataStatusPopover, KnowledgeGraphToolbar } from './knowledge-graph/knowledge-graph-toolbar';
import { KnowledgeGraphWorkspace } from './knowledge-graph/knowledge-graph-workspace';
import { KnowledgeGraphStatusBar } from './knowledge-graph/knowledge-graph-status-bar';
```

Change the fullscreen ref so it owns the entire workbench:

```tsx
const graphRef = useRef<HTMLElement | null>(null);
```

Add state:

```tsx
const [detailOpen, setDetailOpen] = useState(true);
```

Derive current-view matches without a new API:

```tsx
const materialSearchMatches = useMemo(() => {
  const query = materialSearchQuery.trim().toLowerCase();
  if (!query) return [];
  return (materialGraph?.nodes ?? [])
    .filter((node) => `${node.label} ${node.summary} ${node.type}`.toLowerCase().includes(query))
    .slice(0, 8);
}, [materialGraph, materialSearchQuery]);
```

Update selection handlers:

```tsx
function onMaterialNodeClick(nodeId: string) {
  setSelectedMaterialNodeId(nodeId);
  setSelectedMaterialEdgeId(null);
  setDetailOpen(true);
  void loadMaterialGraphNeighborhood(nodeId, materialDepth);
}

function resetMaterialCenter() {
  setSelectedMaterialNodeId(chooseDefaultMaterialCenter(materialGraph));
  setSelectedMaterialEdgeId(null);
  setMaterialSearchQuery('');
  setDetailOpen(true);
}

function onMaterialEdgeClick(edgeId: string) {
  setSelectedMaterialEdgeId(edgeId);
  const materialEdge = materialEdgesById.get(edgeId);
  setSelectedMaterialNodeId(materialEdge?.source ?? null);
  setDetailOpen(true);
}
```

When changing tabs, keep each graph's selection but reopen detail only when the target view has a selection:

```tsx
function onTabChange(tab: GraphTab) {
  setActiveTab(tab);
  setDetailOpen(tab === 'material' ? Boolean(selectedMaterialNode || selectedMaterialEdge) : Boolean(selectedCourseNode));
}
```

- [ ] **Step 4: Replace the page body with the workbench structure**

The top-level render must follow this ownership:

```tsx
return (
  <section ref={graphRef} className="overflow-hidden rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)]" data-testid="a3-knowledge-graph-workbench">
    <header className="flex flex-col gap-3 border-b border-[var(--a3-border)] px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-[var(--a3-text)]">知识关系</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--a3-text-muted)]">从资料证据理解知识点之间的关系，并进入下一步学习。</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void reloadCurrent()} disabled={loading}>刷新</Button>
        {activeTab === 'material' ? <GraphDataStatusPopover graph={materialGraph} /> : null}
        <Button size="sm" variant="outline" onClick={() => void requestFullscreen()}>全屏</Button>
      </div>
    </header>

    <KnowledgeGraphToolbar
      activeTab={activeTab}
      onTabChange={onTabChange}
      query={materialSearchQuery}
      onQueryChange={setMaterialSearchQuery}
      searchMatches={materialSearchMatches}
      onSelectSearchResult={onMaterialNodeClick}
      depth={materialDepth}
      onDepthChange={onMaterialDepthChange}
      onReset={resetMaterialCenter}
      loading={loading}
    />

    {message ? <div role="status" className="border-b border-[var(--a3-border)] px-4 py-2 text-sm text-blue-700">{message}</div> : null}

    <KnowledgeGraphWorkspace
      canvas={graphCanvas}
      detail={activeTab === 'material'
        ? <MaterialDetailPanel node={selectedMaterialNode} edge={selectedMaterialEdge} claims={selectedClaims} edges={materialGraph?.edges ?? []} nodesById={materialNodesById} />
        : <CourseDetail node={selectedCourseNode} planning={planning} onRegenerate={() => void regeneratePath()} />}
      detailOpen={detailOpen}
      detailTitle={activeTab === 'material' ? (selectedMaterialEdge ? '关系证据' : '实体详情') : '课程节点详情'}
      onCloseDetail={() => setDetailOpen(false)}
    />

    {activeTab === 'material' ? <KnowledgeGraphStatusBar graph={materialGraph} focus={materialGraph?.focus} depth={materialDepth} loading={loading} /> : null}
  </section>
);
```

Extract the existing React Flow/loading/empty branches into a local `graphCanvas` variable. Keep these exact behaviors:

- `edgeTypes={materialEdgeTypes}`.
- `onlyRenderVisibleElements`.
- `fitView` and the current padding.
- `onNodeClick` calls `onMaterialNodeClick`.
- `onEdgeClick` calls `onMaterialEdgeClick`.
- `Controls` remains inside the canvas.
- `MiniMap` remains course-only.
- empty state action still links to `/a3/knowledge-base` or backend `nextAction.href`.
- the canvas no longer owns `ref={graphRef}`; fullscreen targets the complete workbench section.

The canvas root must use:

```tsx
className="a3-material-graph-canvas relative h-full min-h-0 overflow-hidden"
```

Do not restore the two absolute floating panels or the independent build card.

Convert `CourseDetail` from an `A3Card` wrapper to plain drawer content before running tests. Keep its current status pill, description and four real actions, but return a `div` with `data-testid="a3-course-detail-panel"`; the workspace owns the panel border, title, close button and scrolling.

- [ ] **Step 5: Run focused tests and confirm GREEN**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts tests/a3-knowledge-graph-focused-layout.test.ts tests/a3-material-knowledge-graph.test.ts tests/a3-knowledge-graph-real-rendering.test.ts
```

Expected: all four files pass with no missing component, old floating-panel, fixed-height or real-API regressions.

- [ ] **Step 6: Commit integration**

```powershell
cd D:\Download\A3
git add OpenMAIC/components/a3/features/knowledge-graph-view.tsx OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx OpenMAIC/tests/a3-knowledge-graph-evidence-workbench.test.ts OpenMAIC/tests/a3-knowledge-graph-focused-layout.test.ts
git commit -m "feat(a3): integrate knowledge graph evidence workbench"
```

## Task 6: Add Real Browser Regression Coverage

**Files:**

- Create: `OpenMAIC/e2e/tests/a3-knowledge-graph-workbench.spec.ts`

- [ ] **Step 1: Write the E2E test before visual tweaks**

Use the existing A3 Playwright fixture and demo account setup pattern. The test must verify behavior, not pixel snapshots alone:

```ts
import { execFileSync } from 'node:child_process';
import { expect, test } from '../fixtures/base';
import { resolveA3PlaywrightRuntime } from '../playwright-runtime';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

test.beforeAll(({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const runtime = resolveA3PlaywrightRuntime(process.env, process.cwd());
  if (!runtime.useExistingServers) {
    execFileSync(runtime.backendPython, [runtime.backendManagePy, 'seed_demo_data'], {
      cwd: runtime.backendProjectRoot,
      stdio: 'pipe',
    });
  }
});

async function login(page: import('@playwright/test').Page) {
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 60_000 });
}

test('keeps evidence detail inside the graph workspace and can restore full canvas width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/a3/knowledge-graph');

  const workspace = page.getByTestId('a3-knowledge-graph-workspace');
  const graph = page.getByTestId('a3-real-knowledge-graph');
  await expect(workspace).toBeVisible({ timeout: 60_000 });
  await expect(graph).toBeVisible();

  const detail = page.getByTestId('a3-material-detail-panel');
  await expect(detail).toBeVisible();

  const workspaceBox = await workspace.boundingBox();
  const graphBoxWithDetail = await graph.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(graphBoxWithDetail).not.toBeNull();
  expect(Math.abs((workspaceBox?.height ?? 0) - (graphBoxWithDetail?.height ?? 0))).toBeLessThan(4);

  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(detail).not.toBeVisible();

  const graphBoxWithoutDetail = await graph.boundingBox();
  expect((graphBoxWithoutDetail?.width ?? 0)).toBeGreaterThan(graphBoxWithDetail?.width ?? 0);
});

test('labels local search honestly and exposes data health on demand', async ({ page }) => {
  await login(page);
  await page.goto('/a3/knowledge-graph');

  await expect(page.getByPlaceholder('搜索当前视图中的实体')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '数据状态' }).click();
  await expect(page.getByTestId('a3-material-graph-data-status')).toBeVisible();
});
```

- [ ] **Step 2: Run and inspect the first browser result**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd playwright test e2e/tests/a3-knowledge-graph-workbench.spec.ts --project=chromium --workers=1
```

Expected: PASS. If the configured dev server hits the known Turbopack symlink panic, run the existing-server path with Next webpack and record the environment limitation; do not weaken selectors or remove assertions.

- [ ] **Step 3: Capture the required desktop and narrow screenshots**

Capture after the graph and detail are visible:

```ts
await page.setViewportSize({ width: 1440, height: 900 });
await page.screenshot({ path: 'test-results/a3-knowledge-graph-1440.png', fullPage: true });
await page.setViewportSize({ width: 1024, height: 768 });
await page.screenshot({ path: 'test-results/a3-knowledge-graph-1024.png', fullPage: true });
```

Inspect both images for:

- no search or quality panels over graph nodes;
- detail and canvas share one vertical boundary;
- no large blank center column below the graph;
- toolbar text and controls do not overlap;
- selected node and its neighboring relationships remain readable.

- [ ] **Step 4: Commit E2E coverage**

```powershell
cd D:\Download\A3
git add OpenMAIC/e2e/tests/a3-knowledge-graph-workbench.spec.ts
git commit -m "test(a3): cover knowledge graph workbench interactions"
```

Do not add generated screenshots or `test-results/` to Git.

## Task 7: Full Verification And Handoff

**Files:**

- Verify only; no production changes unless a command exposes a regression.

- [ ] **Step 1: Run the focused frontend suite**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-evidence-workbench.test.ts tests/a3-knowledge-graph-focused-layout.test.ts tests/a3-material-knowledge-graph.test.ts tests/a3-knowledge-graph-real-rendering.test.ts
```

Expected: all tests pass, zero failures.

- [ ] **Step 2: Run TypeScript and lint**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: TypeScript exits 0. Lint exits 0; only the historical warnings permitted by `AGENTS.md` may remain.

- [ ] **Step 3: Run the backend graph contract tests**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_material_knowledge_graph
backend\.venv\Scripts\python.exe backend\manage.py check
```

Expected: backend graph tests pass and Django reports no system-check issues.

- [ ] **Step 4: Run the browser regression**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd playwright test e2e/tests/a3-knowledge-graph-workbench.spec.ts --project=chromium --workers=1
```

Expected: both workbench scenarios pass.

- [ ] **Step 5: Review the final diff against the P0 scope**

```powershell
cd D:\Download\A3
git status --short --branch
git diff --stat HEAD~4..HEAD
git diff --check HEAD~4..HEAD
```

Confirm:

- no backend API changes;
- no mock data;
- no tracked screenshots or runtime files;
- no unrelated user files;
- no P1/P2 features added prematurely.

- [ ] **Step 6: Prepare the handoff**

Report in the `AGENTS.md` format:

```text
已完成：
- P0 文件与行为

验证：
- focused Vitest / tsc / lint / backend graph tests / Django check / Playwright

未完成：
- P1 移动端关系列表、真实学习动作
- P2 全图实体搜索、教师审计

下一步：
- 1-3 个可直接执行的 P1 任务
```
