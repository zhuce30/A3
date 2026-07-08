# A3 Knowledge Graph Real Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/a3/knowledge-graph` with a real, inspectable knowledge graph backed by the existing Django course graph, prerequisite edges, learning path state, wrong-question evidence, and student next actions.

**Architecture:** Keep `/api/learning/graph/` as the source of truth. Extend the API contract with graph schema version, evidence, typed edges, and path bindings, then replace the current hand-positioned SVG with `@xyflow/react`, which is already installed in `OpenMAIC/package.json`.

**Tech Stack:** Django, Django TestCase, Next.js client components, TypeScript, `@xyflow/react`, Vitest, Playwright optional visual regression.

---

## File Structure

- Modify: `backend/apps/learning/services.py`
  - Add `schemaVersion`, node `pathBinding`, node `evidence`, typed edge metadata, and graph build evidence.
- Modify: `backend/apps/learning/tests/test_path_planner.py`
  - Lock API contract so graph is not just a display list.
- Modify: `OpenMAIC/lib/a3/learning-types.ts`
  - Add typed graph schema fields used by React Flow and detail panels.
- Replace: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
  - Remove fixed SVG renderer and mojibake copy.
  - Render real graph nodes and prerequisite edges with React Flow.
- Create: `OpenMAIC/tests/a3-knowledge-graph-real-rendering.test.ts`
  - Static contract test that blocks regression to hand-coded SVG and asserts real graph affordances.

---

### Task 1: Lock Backend Graph Contract

**Files:**
- Modify: `backend/apps/learning/tests/test_path_planner.py`
- Modify: `backend/apps/learning/services.py`

- [ ] **Step 1: Write failing backend contract assertions**

In `backend/apps/learning/tests/test_path_planner.py`, extend `test_knowledge_graph_reflects_path_state` with these assertions after `graph = response.json()["graph"]`:

```python
self.assertEqual(graph["schemaVersion"], "a3.knowledge-graph.v1")
self.assertEqual(graph["evidence"]["source"], "learning_graph_service")
self.assertGreaterEqual(graph["evidence"]["prerequisiteEdgeCount"], 1)

edge = graph["edges"][0]
self.assertEqual(edge["type"], "prerequisite")
self.assertIn("label", edge)

current_node = nodes[str(current.knowledge_point_id)]
self.assertEqual(current_node["pathBinding"]["pathItemId"], str(current.id))
self.assertEqual(current_node["pathBinding"]["status"], "current")
self.assertEqual(current_node["evidence"]["source"], "course_knowledge_point")
self.assertIn("chapter", current_node["evidence"])
```

- [ ] **Step 2: Run the targeted test and confirm it fails**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_path_planner.PathPlannerTests.test_knowledge_graph_reflects_path_state
```

Expected: FAIL because `schemaVersion`, `evidence`, `edge.type`, and `pathBinding` are not returned yet.

- [ ] **Step 3: Add graph contract fields**

In `backend/apps/learning/services.py`, update `knowledge_graph` return payload:

```python
return {
    "schemaVersion": "a3.knowledge-graph.v1",
    "course": {"id": str(course.id), "code": course.code, "title": course.title, "edition": course.edition},
    "pathId": str(active_path.id) if active_path else None,
    "nodes": nodes,
    "edges": edges,
    "summary": _graph_summary(nodes),
    "evidence": {
        "source": "learning_graph_service",
        "courseId": str(course.id),
        "knowledgePointCount": len(nodes),
        "prerequisiteEdgeCount": len(edges),
        "activePathId": str(active_path.id) if active_path else None,
    },
}
```

Update edge serialization in the same function:

```python
edges = [
    {
        "from": str(edge.prerequisite_id),
        "to": str(edge.knowledge_point_id),
        "type": "prerequisite",
        "label": "先修",
    }
    for edge in KnowledgePrerequisite.objects.filter(knowledge_point__chapter__course=course)
]
```

Update `_serialize_graph_node` return payload:

```python
"pathBinding": {
    "pathItemId": str(path_item.id) if path_item else None,
    "pathOrder": path_item.order if path_item else None,
    "status": path_item.status if path_item else "unbound",
    "reason": path_item.reason if path_item else "",
},
"evidence": {
    "source": "course_knowledge_point",
    "knowledgePointId": str(point.id),
    "chapter": point.chapter.title,
    "wrongCount": wrong_count,
    "progress": progress,
},
```

- [ ] **Step 4: Run backend graph test**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_path_planner.PathPlannerTests.test_knowledge_graph_reflects_path_state
```

Expected: PASS.

---

### Task 2: Update Frontend Types

**Files:**
- Modify: `OpenMAIC/lib/a3/learning-types.ts`

- [ ] **Step 1: Extend graph types**

Update `KnowledgeGraphNode`:

```ts
export type KnowledgeGraphNode = {
  id: string;
  code: string;
  title: string;
  description: string;
  chapter: { order: number; title: string };
  difficulty: number;
  estimatedMinutes: number;
  status: KnowledgeGraphNodeStatus;
  progress: number;
  wrongCount: number;
  pathOrder: number | null;
  reason: string;
  pathBinding?: {
    pathItemId: string | null;
    pathOrder: number | null;
    status: 'locked' | 'current' | 'completed' | 'unbound' | string;
    reason: string;
  };
  evidence?: {
    source: 'course_knowledge_point' | string;
    knowledgePointId: string;
    chapter: string;
    wrongCount: number;
    progress: number;
  };
};
```

Update `KnowledgeGraphEdge`:

```ts
export type KnowledgeGraphEdge = {
  from: string;
  to: string;
  type?: 'prerequisite' | string;
  label?: string;
};
```

Update `KnowledgeGraph`:

```ts
export type KnowledgeGraph = {
  schemaVersion?: 'a3.knowledge-graph.v1' | string;
  course: Pick<Course, 'id' | 'code' | 'title' | 'edition'> | null;
  pathId: string | null;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  summary: KnowledgeGraphSummary;
  evidence?: {
    source: 'learning_graph_service' | string;
    courseId: string;
    knowledgePointCount: number;
    prerequisiteEdgeCount: number;
    activePathId: string | null;
  };
};
```

- [ ] **Step 2: Type-check**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
```

Expected: PASS or only errors from later tasks not yet implemented.

---

### Task 3: Replace SVG With React Flow Real Graph

**Files:**
- Replace: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`

- [ ] **Step 1: Add React Flow imports and remove SVG-only positioning**

Use these imports:

```ts
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
```

Remove `PositionedNode` and `positionNodes`.

- [ ] **Step 2: Build graph layout from real data**

Add this helper near the bottom of `knowledge-graph-view.tsx`:

```ts
function buildFlowGraph(graph: KnowledgeGraph | null, selectedId: string | null): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };

  const chapterOrders = Array.from(new Set(graph.nodes.map((node) => node.chapter.order))).sort((a, b) => a - b);
  const byChapter = new Map<number, KnowledgeGraphNode[]>();
  graph.nodes.forEach((node) => {
    const current = byChapter.get(node.chapter.order) ?? [];
    current.push(node);
    byChapter.set(node.chapter.order, current);
  });

  const flowNodes: Node[] = graph.nodes.map((node) => {
    const chapterIndex = chapterOrders.indexOf(node.chapter.order);
    const siblings = byChapter.get(node.chapter.order) ?? [];
    const siblingIndex = siblings.findIndex((item) => item.id === node.id);
    return {
      id: node.id,
      position: { x: chapterIndex * 260, y: siblingIndex * 150 },
      data: {
        label: node.title,
        chapter: node.chapter.title,
        status: node.status,
        progress: node.progress,
        wrongCount: node.wrongCount,
      },
      selected: selectedId === node.id,
      className: `a3-kg-node a3-kg-node-${node.status}`,
      style: {
        width: 210,
        borderRadius: 12,
        border: selectedId === node.id ? '2px solid #2563eb' : '1px solid #cbd5e1',
        background: statusMeta[node.status].surface,
        color: statusMeta[node.status].text,
        padding: 12,
        fontSize: 13,
        boxShadow: selectedId === node.id ? '0 12px 30px rgba(37, 99, 235, 0.18)' : '0 8px 20px rgba(15, 23, 42, 0.08)',
      },
    };
  });

  const flowEdges: Edge[] = graph.edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    label: edge.label ?? '先修',
    animated: graph.nodes.find((node) => node.id === edge.to)?.status === 'learning',
    style: { stroke: '#2563eb', strokeWidth: 1.8 },
    labelStyle: { fill: '#475569', fontSize: 11 },
  }));

  return { nodes: flowNodes, edges: flowEdges };
}
```

Update `statusMeta` to include `surface` and `text`:

```ts
mastered: { label: '已掌握', className: 'border-emerald-300 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', surface: '#ecfdf5', text: '#047857' },
learning: { label: '学习中', className: 'border-blue-300 bg-blue-50 text-blue-700', dot: 'bg-blue-500', surface: '#eff6ff', text: '#1d4ed8' },
weak: { label: '薄弱点', className: 'border-rose-300 bg-rose-50 text-rose-700', dot: 'bg-rose-500', surface: '#fff1f2', text: '#be123c' },
locked: { label: '待解锁', className: 'border-slate-300 bg-slate-50 text-slate-600', dot: 'bg-slate-400', surface: '#f8fafc', text: '#475569' },
unstarted: { label: '未学习', className: 'border-violet-300 bg-violet-50 text-violet-700', dot: 'bg-violet-500', surface: '#f5f3ff', text: '#6d28d9' },
```

- [ ] **Step 3: Render React Flow**

Replace the current SVG and absolutely positioned button block with:

```tsx
<div className="relative h-[640px] overflow-hidden rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)]" data-testid="a3-real-knowledge-graph">
  {loading && (
    <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--a3-surface-solid)]/80">
      <div className="flex items-center gap-2 text-sm text-[var(--a3-text-muted)]">
        <Loader2 className="size-4 animate-spin" />
        正在读取课程知识图谱
      </div>
    </div>
  )}

  {!loading && graph?.nodes.length ? (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(_, node) => setSelectedId(node.id)}
    >
      <Background gap={24} color="#e2e8f0" />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  ) : null}

  {!loading && !graph?.nodes.length && (
    <div className="grid h-full place-items-center text-sm text-[var(--a3-text-muted)]">
      暂无课程知识点。请先完成课程初始化或联系教师维护课程结构。
    </div>
  )}
</div>
```

Add before render:

```ts
const flow = useMemo(() => buildFlowGraph(graph, selectedId), [graph, selectedId]);
const nodesById = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.id, node])), [graph]);
const selected = selectedId ? nodesById.get(selectedId) ?? null : null;
const recommendations = useMemo(() => (graph?.nodes ?? []).filter((node) => node.status === 'weak' || node.status === 'learning').slice(0, 4), [graph]);
```

- [ ] **Step 4: Replace mojibake copy with product Chinese**

Use these visible strings in the page:

```tsx
title="真实知识图谱"
subtitle={graph?.course ? `${graph.course.title} · ${graph.course.edition || '课程知识结构'}` : '展示课程知识点、先修依赖、学习路径状态和错题证据。'}
```

Button labels:

```tsx
刷新图谱
全屏查看
根据画像重排学习路径
```

Metric labels:

```tsx
总知识点
掌握率
薄弱点
建议下一步
```

Detail panel labels:

```tsx
知识点详情
第 {selected.chapter.order} 章 · {selected.chapter.title}
难度
预计
错题
学习进度
证据来源
路径绑定
```

- [ ] **Step 5: Type-check**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
```

Expected: PASS.

---

### Task 4: Connect Graph Nodes To Learning Loop

**Files:**
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`

- [ ] **Step 1: Add next action links in selected node panel**

Add imports:

```ts
import Link from 'next/link';
import { BookOpen, ClipboardCheck, MessageCircle } from 'lucide-react';
```

Inside selected node detail panel after progress:

```tsx
<div className="grid gap-2">
  <Button asChild variant="outline" className="justify-start">
    <Link href="/a3/today">
      <BookOpen className="size-4" />
      回到今日任务
    </Link>
  </Button>
  <Button asChild variant="outline" className="justify-start">
    <Link href={`/a3/coaching?knowledgePointId=${selected.id}`}>
      <MessageCircle className="size-4" />
      围绕该知识点辅导
    </Link>
  </Button>
  <Button asChild variant="outline" className="justify-start">
    <Link href={`/a3/assessment?knowledgePointId=${selected.id}`}>
      <ClipboardCheck className="size-4" />
      针对该知识点测评
    </Link>
  </Button>
</div>
```

- [ ] **Step 2: Show evidence without exposing local paths**

Add below selected reason:

```tsx
<div className="rounded-xl bg-[var(--a3-surface-muted)] p-3 text-sm leading-6 text-[var(--a3-text-muted)]">
  <div className="font-medium text-[var(--a3-text)]">证据来源</div>
  <div>课程知识点：{selected.evidence?.knowledgePointId ?? selected.id}</div>
  <div>章节：{selected.evidence?.chapter ?? selected.chapter.title}</div>
  <div>错题记录：{selected.evidence?.wrongCount ?? selected.wrongCount} 次未掌握</div>
</div>
```

Add path binding:

```tsx
<div className="rounded-xl bg-blue-50 p-3 text-sm leading-6 text-blue-800">
  <div className="font-medium">路径绑定</div>
  <div>{selected.pathBinding?.pathItemId ? `已绑定学习路径第 ${selected.pathBinding.pathOrder ?? selected.pathOrder ?? '-'} 个节点` : '该知识点尚未进入当前学习路径'}</div>
  <div>{selected.pathBinding?.reason || selected.reason || '系统会结合画像、诊断和错题状态决定是否安排到今日任务。'}</div>
</div>
```

- [ ] **Step 3: Type-check**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
```

Expected: PASS.

---

### Task 5: Add Frontend Regression Test

**Files:**
- Create: `OpenMAIC/tests/a3-knowledge-graph-real-rendering.test.ts`

- [ ] **Step 1: Add static test**

Create `OpenMAIC/tests/a3-knowledge-graph-real-rendering.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const view = readFileSync(join(root, 'components/a3/features/knowledge-graph-view.tsx'), 'utf8');
const types = readFileSync(join(root, 'lib/a3/learning-types.ts'), 'utf8');

describe('A3 real knowledge graph page', () => {
  it('uses React Flow instead of a fixed SVG pseudo graph', () => {
    expect(view).toContain("from '@xyflow/react'");
    expect(view).toContain('<ReactFlow');
    expect(view).toContain('data-testid="a3-real-knowledge-graph"');
    expect(view).not.toContain('<svg className="absolute inset-0 size-full"');
    expect(view).not.toContain('function positionNodes');
  });

  it('surfaces real graph evidence and learning-loop actions', () => {
    expect(view).toContain('证据来源');
    expect(view).toContain('路径绑定');
    expect(view).toContain('/a3/today');
    expect(view).toContain('/a3/coaching?knowledgePointId=');
    expect(view).toContain('/a3/assessment?knowledgePointId=');
  });

  it('types graph schema, prerequisite edges, and node evidence', () => {
    expect(types).toContain('schemaVersion?:');
    expect(types).toContain('a3.knowledge-graph.v1');
    expect(types).toContain("type?: 'prerequisite'");
    expect(types).toContain('pathBinding?:');
    expect(types).toContain('evidence?:');
  });
});
```

- [ ] **Step 2: Run frontend test**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-real-rendering.test.ts
```

Expected: PASS.

---

### Task 6: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run backend checks**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_path_planner.PathPlannerTests.test_knowledge_graph_reflects_path_state
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: all PASS.

- [ ] **Step 2: Run frontend checks**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd vitest run tests/a3-knowledge-graph-real-rendering.test.ts
pnpm.cmd lint
```

Expected: `tsc` and Vitest PASS. Lint may retain the known historical warnings listed in `AGENTS.md`, with no new A3 knowledge graph warnings.

- [ ] **Step 3: Manual page check**

Open:

```text
http://127.0.0.1:3002/a3/knowledge-graph
```

Expected:

- The page title is `真实知识图谱`.
- Graph nodes are rendered inside React Flow with zoom controls and MiniMap.
- Edges show prerequisite relationships.
- Clicking a node updates the detail panel.
- Detail panel shows evidence and path binding.
- Buttons route to today, coaching, assessment, and path regeneration.
- No visible mojibake.

---

## Self-Review

Spec coverage:

- Real backend graph source: Task 1.
- Open-source migration approach: Task 3 uses already-installed `@xyflow/react`.
- Product usefulness for students: Task 4 adds current node actions and evidence.
- No fake content: all graph nodes and edges are read from `/api/learning/graph/`.
- Verification: Tasks 5 and 6.

Placeholder scan:

- No placeholder implementation steps remain.

Type consistency:

- Backend uses `schemaVersion`, `pathBinding`, `evidence`, and edge `type`.
- Frontend types and tests use the same property names.
