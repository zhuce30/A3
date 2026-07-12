# A3 Knowledge Graph Focused Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/a3/knowledge-graph` into a focused knowledge-graph workspace similar to the provided reference image: a selected entity sits in the center, relation edges radiate with labels and color, background nodes remain visible but muted, and the side panels show searchable entity details plus graph/index quality.

**Architecture:** Keep the existing `/api/kb/graph/` contract and `@xyflow/react` renderer. Add `d3-force` only for material graph coordinate calculation, then render the resulting nodes and custom relation edges through React Flow. Split the current large view into force-layout graph helpers, custom relation edge rendering, floating search/detail/stat panels, and structured detail components so the UI can improve without blocking backend extraction changes.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, `@xyflow/react`, `d3-force`, Vitest static/behavior tests, existing A3 API client and UI primitives.

---

## Scope

This plan only changes the knowledge graph presentation layer and frontend tests. It does not change the material graph extraction schema, Django models, or `/api/kb/graph/` response contract. When backend extraction adds cleaner fields such as `definition`, `keyPoints`, `attributes`, or `relationGroups`, the new detail components should accept those fields as optional enhancements without requiring another layout rewrite.

Dependency scope:

- Keep `@xyflow/react` as the renderer and interaction layer.
- Add `d3-force` for deterministic material graph layout coordinates. Do not replace React Flow with a canvas/SVG-only graph.
- If `d3-force` is not yet installed in `OpenMAIC/package.json`, add it with the package manager already used by the frontend and commit the lockfile change.

## File Structure

- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
  - Keep page-level loading, tab switching, API calls, and course graph behavior.
  - Replace the material graph layout with a focused radial layout.
  - Wire selected node, selected edge, graph depth, search query, and reset interactions.
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-focused-flow.tsx`
  - Own material graph layout construction for `@xyflow/react`.
  - Use `d3-force` to compute stable focused coordinates for the material graph.
  - Export pure helpers for selecting the default center, collecting visible node IDs, running the force layout, and building node/edge styles.
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-relation-edge.tsx`
  - Own the custom React Flow edge renderer for material relations.
  - Support colored arrows, relation labels, selected-edge emphasis, and muted background edges.
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx`
  - Own the left floating "search entity + selected node details" panel.
  - Own the right floating "graph quality + index status + entity/relation statistics" panel.
  - Own density controls.
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-detail-panel.tsx`
  - Own structured entity detail, relation detail, related claims, related relations, and evidence accordion.
- Create: `OpenMAIC/tests/a3-knowledge-graph-focused-layout.test.ts`
  - Verify the new component boundaries and user-visible test IDs.
  - Verify the graph still consumes real material graph fields instead of mock local data.

## Data Model Used By The Frontend

Continue to consume the existing frontend-local types:

```ts
type MaterialNode = {
  id: string;
  label: string;
  type: string;
  summary: string;
  confidence: number;
  evidence: MaterialEvidence[];
  degraded: boolean;
  schemaVersion: string;
};

type MaterialEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  weight: number;
  evidence: MaterialEvidence[];
  degraded: boolean;
};

type MaterialClaim = {
  id: string;
  text: string;
  entityIds: string[];
  verified: boolean;
  evidence: MaterialEvidence[];
  degraded: boolean;
};
```

Optional future fields from backend extraction should be read defensively:

```ts
type MaterialNodeEnhancement = {
  definition?: string;
  keyPoints?: string[];
  attributes?: Array<{ label: string; value: string }>;
  extractionMethod?: string;
};
```

Do not require these fields in the first implementation.

## Visual Target

The material graph should resemble the reference image in product behavior, not copy it literally:

- A selected entity sits near the visual center.
- Directly related nodes radiate around it with colored directional edges and readable relation labels.
- Secondary and unrelated nodes stay visible but muted, creating spatial context without competing for attention.
- Floating panels sit over the graph canvas instead of forcing the canvas into a small card.
- The left floating area combines entity search and selected-node quick details.
- The right floating area shows graph quality, index status, entity count, relation count, and density state.
- The right side remains a stable detail area for reading and action.

Use restrained product styling consistent with A3:

- Background: light tinted neutral canvas, no dark mode switch in this task.
- Node colors: multiple semantic tones by entity type, not a single blue/purple palette.
- Selected center: stronger border, larger size, clear label.
- Edge colors: relation type based, with selected relation emphasized by stroke width, opacity, arrow marker, and label weight.
- Cards: only for floating panels and the right detail surface, no nested cards.

## Interaction Contract

- Clicking a material node selects it and recenters/highlights its local neighborhood.
- Clicking a material edge selects the relation and keeps both endpoint nodes emphasized.
- Search filters or focuses matching entities by label and summary. Search is part of the left floating panel.
- The default selected entity is the highest-degree entity, then highest confidence, then label.
- Density control supports:
  - `一跳`: selected node plus directly connected nodes.
  - `二跳`: selected node, direct neighbors, and neighbors of direct neighbors.
  - `全部`: all nodes with non-neighborhood nodes muted.
- Reset chooses the default center node again.
- Right detail stays visible on desktop and moves below the graph on smaller screens.
- The graph uses `d3-force` to produce a natural spread, but React Flow remains responsible for pan, zoom, node/edge rendering, selection, and controls.

## Task 1: Static Contract Test

**Files:**
- Create: `OpenMAIC/tests/a3-knowledge-graph-focused-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file with these checks:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const featureDir = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph');
const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph-view.tsx');

describe('A3 knowledge graph focused layout', () => {
  it('splits the material graph into focused flow, floating panels, and structured detail', () => {
    expect(fs.existsSync(path.join(featureDir, 'material-focused-flow.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'material-relation-edge.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'material-graph-panels.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'material-detail-panel.tsx'))).toBe(true);
  });

  it('keeps the real material graph API contract and exposes focused graph test ids', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("'/api/kb/graph/'");
    expect(source).toContain('data-testid="a3-real-knowledge-graph"');
    expect(source).toContain('data-testid="a3-material-focused-graph"');
    expect(source).toContain('data-testid="a3-material-graph-search"');
    expect(source).toContain('data-testid="a3-material-graph-quality-panel"');
    expect(source).toContain('data-testid="a3-material-detail-panel"');
    expect(source).toContain('MaterialRelationEdge');
    expect(source).not.toContain('mockMaterialGraph');
  });

  it('uses d3-force for material graph coordinates while keeping React Flow rendering', () => {
    const viewSource = fs.readFileSync(viewPath, 'utf8');
    const flowSource = fs.readFileSync(path.join(featureDir, 'material-focused-flow.tsx'), 'utf8');
    const edgeSource = fs.readFileSync(path.join(featureDir, 'material-relation-edge.tsx'), 'utf8');
    const packageSource = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');

    expect(packageSource).toContain('d3-force');
    expect(viewSource).toContain('edgeTypes={materialEdgeTypes}');
    expect(flowSource).toContain('d3-force');
    expect(flowSource).toContain('forceSimulation');
    expect(flowSource).toContain('chooseDefaultMaterialCenter');
    expect(flowSource).toContain("type: 'materialRelation'");
    expect(edgeSource).toContain('BaseEdge');
    expect(edgeSource).toContain('EdgeLabelRenderer');
    expect(edgeSource).toContain('a3-material-relation-edge');
    expect(edgeSource).toContain('a3-material-relation-label');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-focused-layout.test.ts
```

Expected: fail because the new component files, `d3-force` dependency, custom edge registration, and test IDs do not exist yet.

## Task 2: d3-force Focused Flow Helpers

**Files:**
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-focused-flow.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`

- [ ] **Step 1: Create the focused flow module**

Implement these exports:

```ts
import type { Edge, Node } from '@xyflow/react';

export type MaterialGraphDepth = 'one' | 'two' | 'all';

export function chooseDefaultMaterialCenter(graph: MaterialGraph | null): string | null;

export function collectMaterialNeighborhood(
  graph: MaterialGraph | null,
  centerNodeId: string | null,
  depth: MaterialGraphDepth,
): Set<string>;

export function buildFocusedMaterialFlow(input: {
  graph: MaterialGraph | null;
  centerNodeId: string | null;
  selectedEdgeId: string | null;
  depth: MaterialGraphDepth;
  searchQuery: string;
  onSelectNodeLabel?: never;
}): { nodes: Node<GraphNodeData>[]; edges: Edge[] };
```

Implementation rules:

- `chooseDefaultMaterialCenter` sorts by relation degree, then confidence, then label.
- `collectMaterialNeighborhood` returns all node IDs for `all`, direct neighbors for `one`, and two-hop neighbors for `two`.
- `buildFocusedMaterialFlow` uses `d3-force` to calculate coordinates for the material graph.
- The selected center node is pinned near `{ x: 560, y: 340 }` via fixed `fx/fy` simulation values or a post-simulation transform.
- Direct neighbors receive stronger link force and should settle near the center, visually similar to a radial graph.
- Two-hop/background nodes remain visible with weaker charge/link strength and opacity around `0.22` to `0.32`.
- Non-neighborhood nodes are still present for spatial context in `all` mode, but they must not compete visually with the selected ego network.
- Search matches keep full opacity and use a distinct border color.
- Selected node width stays stable so hover and label changes do not shift layout.
- Force simulation must be deterministic enough for tests and screenshots:
  - Use stable input ordering.
  - Run a fixed tick count, for example 120-180 ticks.
  - Do not depend on browser animation timers for initial coordinates.
- `d3-force` owns coordinates only. React Flow still owns rendering, selection, pan, zoom, controls, and minimap behavior.

- [ ] **Step 2: Replace `buildMaterialFlow` in the view**

In `knowledge-graph-view.tsx`, import and use `buildFocusedMaterialFlow` for the material tab. Keep `buildCourseFlow` in the existing file for the course tab.

- [ ] **Step 3: Run typecheck**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

Expected: no new TypeScript errors.

## Task 3: Custom Material Relation Edge

**Files:**
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-relation-edge.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph/material-focused-flow.tsx`

- [ ] **Step 1: Create the custom edge component**

Implement:

```ts
export function MaterialRelationEdge(props: EdgeProps<MaterialRelationEdgeData>): JSX.Element;
```

Behavior:

- Render through React Flow primitives: `BaseEdge`, `EdgeLabelRenderer`, and marker/arrow configuration.
- Use relation type to choose stroke color. Avoid a one-note blue/purple palette.
- Show the relation label near the edge midpoint.
- Rotate or position the label so it reads as attached to the edge without overlapping the selected center node.
- Selected edge uses stronger stroke width, higher opacity, and bolder label.
- Muted background edge uses lower opacity and a smaller label.
- Directional edge arrow must remain visible on selected and one-hop relations.

Required test IDs:

- `a3-material-relation-edge`
- `a3-material-relation-label`

- [ ] **Step 2: Register the custom edge type**

In `knowledge-graph-view.tsx`, register:

```ts
const materialEdgeTypes = { materialRelation: MaterialRelationEdge };
```

Pass it into React Flow for the material graph only. Keep the course graph edge behavior unchanged unless it already shares the same React Flow instance safely.

- [ ] **Step 3: Emit custom edge data from flow helpers**

`buildFocusedMaterialFlow` should emit material edges with:

```ts
type: 'materialRelation',
data: {
  label,
  relationType,
  selected,
  muted,
  color,
}
```

- [ ] **Step 4: Run the focused layout test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-focused-layout.test.ts
```

Expected: custom edge file and IDs are covered by static contract.

## Task 4: Floating Graph Panels

**Files:**
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`

- [ ] **Step 1: Create panel components**

Create these components:

```ts
export function MaterialGraphSearchPanel(props: {
  query: string;
  onQueryChange: (value: string) => void;
  onReset: () => void;
  loading: boolean;
  selectedNode: MaterialNode | null;
}): JSX.Element;

export function MaterialGraphMiniPanel(props: {
  node: MaterialNode | null;
  edge: MaterialEdge | null;
}): JSX.Element;

export function MaterialGraphStatsPanel(props: {
  graph: MaterialGraph | null;
  depth: MaterialGraphDepth;
  onDepthChange: (depth: MaterialGraphDepth) => void;
  quality?: {
    isolatedEntityRate?: number;
    evidenceCoverage?: number;
    aliasMergeCount?: number;
    relationDensity?: number;
    gleaningRounds?: number;
  };
}): JSX.Element;
```

Required test IDs:

- `a3-material-graph-search`
- `a3-material-left-entity-panel`
- `a3-material-node-mini-panel`
- `a3-material-graph-stats-panel`
- `a3-material-graph-quality-panel`
- `a3-material-graph-index-panel`
- `a3-material-graph-depth-one`
- `a3-material-graph-depth-two`
- `a3-material-graph-depth-all`

- [ ] **Step 2: Overlay panels on the canvas**

Inside the existing graph canvas, render:

- Left floating panel at top-left: search entity input, reset action, selected node quick details.
- Right floating panel at top-right: graph quality, index status, entity count, relation count, density controls.
- Mini relation/node context panel below search when useful, but avoid nesting cards.

Use absolute positioning inside the graph container:

```tsx
<div className="pointer-events-none absolute inset-0 z-20">
  <div className="pointer-events-auto absolute left-4 top-4 w-[min(340px,calc(100%-2rem))]">
    ...
  </div>
  <div className="pointer-events-auto absolute right-4 top-4 hidden w-[280px] lg:block">
    ...
  </div>
</div>
```

- [ ] **Step 3: Preserve graph interaction**

Set panel wrapper to `pointer-events-none` and each interactive panel to `pointer-events-auto` so ReactFlow pan/zoom still works outside the panels.

- [ ] **Step 4: Run the focused layout test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-focused-layout.test.ts
```

Expected: the test passes once component files and test IDs exist.

## Task 5: Structured Right Detail Panel

**Files:**
- Create: `OpenMAIC/components/a3/features/knowledge-graph/material-detail-panel.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`

- [ ] **Step 1: Move material detail rendering into a focused module**

Create:

```ts
export function MaterialDetailPanel(props: {
  node: MaterialNode | null;
  edge: MaterialEdge | null;
  claims: MaterialClaim[];
  edges: MaterialEdge[];
  nodesById: Map<string, MaterialNode>;
}): JSX.Element;
```

Required structure:

- Entity mode:
  - Header: entity label, type, confidence, degraded/verified pill.
  - Summary section: short cleaned summary or fallback text.
  - Related relations section: outgoing and incoming relations for the selected node.
  - Claims section: related claims, each with verified/degraded state.
  - Evidence section: collapsible source evidence.
- Relation mode:
  - Header: relation label and type.
  - Endpoint row: source entity -> target entity.
  - Evidence section: collapsible source evidence.
- Empty mode:
  - Clear Chinese empty state asking the user to select an entity or relation.

Required test ID:

- `a3-material-detail-panel`

- [ ] **Step 2: Replace the old `MaterialDetail` usage**

In `knowledge-graph-view.tsx`, replace:

```tsx
<MaterialDetail node={selectedMaterialNode} edge={selectedMaterialEdge} claims={selectedClaims} />
```

with:

```tsx
<MaterialDetailPanel
  node={selectedMaterialNode}
  edge={selectedMaterialEdge}
  claims={selectedClaims}
  edges={materialGraph?.edges ?? []}
  nodesById={materialNodesById}
/>
```

- [ ] **Step 3: Remove duplicated local helpers**

Move `EvidenceList`, `materialEvidenceKey`, and `formatMaterialMarkdown` into the new detail module if they are only used there.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

Expected: no new TypeScript errors.

## Task 6: Mobile And Dense Graph Behavior

**Files:**
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph/material-graph-panels.tsx`
- Modify: `OpenMAIC/components/a3/features/knowledge-graph/material-detail-panel.tsx`

- [ ] **Step 1: Make the layout responsive**

Use this page grid behavior:

```tsx
<div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_380px]">
```

The graph should be full width on mobile and tablet. The right detail panel should stack below the graph until `2xl`.

- [ ] **Step 2: Protect text from overflow**

Apply these patterns where labels can be long:

```tsx
className="min-w-0 truncate"
className="line-clamp-2 break-words"
className="overflow-hidden text-ellipsis"
```

Do not use viewport-width font scaling.

- [ ] **Step 3: Add graph empty and too-dense guidance**

If there are no nodes, keep the current empty state and link to `/a3/knowledge-base`.

If there are more than 80 nodes, default to `一跳` depth and show a small note in the stats panel:

```text
节点较多，已优先展示当前实体的一跳关系。
```

The `d3-force` layout should still receive all graph data in `all` mode, but one-hop and two-hop modes should reduce visual weight instead of deleting context silently. Background nodes and edges must be muted enough that selected paths remain readable.
- [ ] **Step 4: Run lint**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd lint
```

Expected: no new lint errors. Existing historical warnings listed in `AGENTS.md` can remain if unrelated.

## Task 7: Visual Verification

**Files:**
- Modify only if the screenshot reveals layout defects.

- [ ] **Step 1: Start or reuse the frontend dev server**

If no server is running:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd dev --port 3002
```

Expected: app available at `http://127.0.0.1:3002`.

- [ ] **Step 2: Open the page**

Visit:

```text
http://127.0.0.1:3002/a3/knowledge-graph
```

Verify manually or with Playwright screenshot:

- The graph has a clear centered selected entity.
- The default center is the highest-degree material entity when no entity is selected.
- The `d3-force` layout produces a natural spread instead of a rigid circular ring.
- One-hop relations are readable.
- Relation edges use custom colored arrows and visible labels.
- Selecting an edge highlights the path, arrow, and label without losing endpoint emphasis.
- Background nodes are muted.
- The left floating panel combines entity search and selected-node quick details.
- The right floating panel shows graph quality, index status, entity counts, relation counts, and density controls.
- Left floating panels do not block graph pan/zoom outside their bounds.
- Right detail panel is still present and structured.
- Mobile width does not overlap panels and detail content.

- [ ] **Step 3: Run the final focused verification**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-graph-focused-layout.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: focused test passes, TypeScript passes, lint has no new errors.

## Rollback Plan

If the focused graph layout performs poorly with large graphs, keep the new right detail panel and add a feature flag inside `knowledge-graph-view.tsx`:

```ts
const focusedMaterialGraphEnabled = true;
```

Switching it to `false` should restore the old `buildMaterialFlow` path during debugging. Remove the flag after the focused layout is stable.

## Risks

- Very dense graphs can still become visually noisy. The depth selector and default one-hop mode for large graphs are required.
- `d3-force` can become nondeterministic if implementation uses animation ticks or unstable input order. Use sorted inputs and a fixed tick count.
- Relation labels can overlap each other or the selected center on dense neighborhoods. Keep labels short, hide or de-emphasize muted labels, and validate screenshots.
- Custom edge rendering can hurt performance if every muted edge renders a heavy label. Only selected and one-hop edges should receive full label treatment.
- Long Chinese entity labels may overlap edge labels. Use line clamps and stable node dimensions.
- Backend extraction changes may add richer fields while this work is in progress. Treat those fields as optional and keep compatibility with the current API.
- The current component is already large. Splitting focused flow, panels, and detail into separate files is part of the plan, not optional cleanup.

## Acceptance Criteria

- `/a3/knowledge-graph` material tab visually resembles a focused radial graph instead of a flat circular graph.
- `@xyflow/react` remains the renderer and interaction layer.
- `d3-force` is added and used only for material graph coordinate calculation.
- The default selected material entity is the highest-degree entity, with confidence and label as tie-breakers.
- A custom `MaterialRelationEdge` renders colored directional arrows, relation labels, and selected-edge highlighting.
- The material graph passes `edgeTypes={materialEdgeTypes}` or an equivalent custom-edge registration into React Flow.
- The left floating panel contains entity search plus selected-node details.
- The right floating panel contains graph quality, index status, entity statistics, relation statistics, and density controls.
- The right-side entity detail remains available and is easier to read.
- The page still fetches real graph data from `/api/kb/graph/`.
- No mock graph data is introduced.
- Existing course graph tab continues to work.
- New focused layout test passes.
- `npx.cmd tsc --noEmit` passes.
- `pnpm.cmd lint` reports no new lint failures.
