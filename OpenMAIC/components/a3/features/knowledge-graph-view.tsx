'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { BookOpen, Database, Loader2, Maximize2, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3ApiResponse, KnowledgeGraph, KnowledgeGraphNode, KnowledgeGraphNodeStatus, LearningPath } from '@/lib/a3/learning-types';
import { cn } from '@/lib/utils';
import { A3Pill } from '../ui/a3-card';
import { KnowledgeGraphStatusBar } from './knowledge-graph/knowledge-graph-status-bar';
import { GraphDataStatusPopover, KnowledgeGraphToolbar } from './knowledge-graph/knowledge-graph-toolbar';
import { KnowledgeGraphWorkspace } from './knowledge-graph/knowledge-graph-workspace';
import { MaterialDetailPanel } from './knowledge-graph/material-detail-panel';
import { buildFocusedMaterialFlow, chooseDefaultMaterialCenter, type MaterialGraphDepth } from './knowledge-graph/material-focused-flow';
import { MaterialRelationEdge } from './knowledge-graph/material-relation-edge';
import type { GraphNodeData, MaterialGraph } from './knowledge-graph/material-types';

type GraphTab = 'material' | 'course';

const materialEdgeTypes = { materialRelation: MaterialRelationEdge };
const MATERIAL_GRAPH_INITIAL_LIMIT = 120;
const MATERIAL_GRAPH_EXPAND_LIMIT = 220;

const statusMeta: Record<KnowledgeGraphNodeStatus, { label: string; dot: string; surface: string; text: string }> = {
  mastered: { label: '已掌握', dot: 'bg-emerald-500', surface: '#ecfdf5', text: '#047857' },
  learning: { label: '学习中', dot: 'bg-blue-500', surface: '#eff6ff', text: '#1d4ed8' },
  weak: { label: '薄弱点', dot: 'bg-rose-500', surface: '#fff1f2', text: '#be123c' },
  locked: { label: '待解锁', dot: 'bg-slate-400', surface: '#f8fafc', text: '#475569' },
  unstarted: { label: '未学习', dot: 'bg-violet-500', surface: '#f5f3ff', text: '#6d28d9' },
};

export function KnowledgeGraphView() {
  const graphRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<GraphTab>('material');
  const [materialGraph, setMaterialGraph] = useState<MaterialGraph | null>(null);
  const [courseGraph, setCourseGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedMaterialNodeId, setSelectedMaterialNodeId] = useState<string | null>(null);
  const [selectedMaterialEdgeId, setSelectedMaterialEdgeId] = useState<string | null>(null);
  const [materialDepth, setMaterialDepth] = useState<MaterialGraphDepth>('one');
  const [materialSearchQuery, setMaterialSearchQuery] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [message, setMessage] = useState('');

  const loadMaterialGraph = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('depth', '1');
    params.set('limit', String(MATERIAL_GRAPH_INITIAL_LIMIT));
    const result = await a3GetJson<A3ApiResponse<{ graph: MaterialGraph }>>(`/api/kb/graph/?${params.toString()}`);
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '资料知识图谱加载失败');
      return;
    }
    setMaterialGraph(result.graph);
    setSelectedMaterialNodeId((current) => (current && result.graph.nodes.some((node) => node.id === current) ? current : chooseDefaultMaterialCenter(result.graph)));
    setSelectedMaterialEdgeId(null);
    setMaterialDepth('one');
    setMessage('');
  }, []);

  const loadMaterialGraphNeighborhood = useCallback(async (centerId: string, depth: MaterialGraphDepth = materialDepth) => {
    const params = new URLSearchParams();
    params.set('depth', depth === 'all' ? 'all' : depth === 'two' ? '2' : '1');
    params.set('limit', String(MATERIAL_GRAPH_EXPAND_LIMIT));
    params.set('centerId', centerId);
    const result = await a3GetJson<A3ApiResponse<{ graph: MaterialGraph }>>(`/api/kb/graph/?${params.toString()}`);
    if (!result.success) {
      setMessage(result.error ?? '资料知识图谱邻域加载失败');
      return;
    }
    setMaterialGraph((current) => (current ? mergeMaterialGraphs(current, result.graph) : result.graph));
    setSelectedMaterialNodeId(centerId);
    setSelectedMaterialEdgeId(null);
    setMessage('');
  }, [materialDepth]);

  const loadCourseGraph = useCallback(async () => {
    setLoading(true);
    const result = await a3GetJson<A3ApiResponse<{ graph: KnowledgeGraph }>>('/api/learning/graph/');
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '课程路径图加载失败');
      return;
    }
    setCourseGraph(result.graph);
    setSelectedCourseId((current) => current ?? result.graph.nodes.find((node) => node.status === 'learning' || node.status === 'weak')?.id ?? result.graph.nodes[0]?.id ?? null);
    setMessage('');
  }, []);

  useEffect(() => {
    if (activeTab === 'material' && materialGraph) return;
    if (activeTab === 'course' && courseGraph) return;
    const timer = window.setTimeout(() => {
      void (activeTab === 'material' ? loadMaterialGraph() : loadCourseGraph());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, courseGraph, loadCourseGraph, loadMaterialGraph, materialGraph]);

  const materialNodesById = useMemo(() => new Map((materialGraph?.nodes ?? []).map((node) => [node.id, node])), [materialGraph]);
  const materialEdgesById = useMemo(() => new Map((materialGraph?.edges ?? []).map((edge) => [edge.id, edge])), [materialGraph]);
  const effectiveSelectedMaterialNodeId = selectedMaterialNodeId && materialNodesById.has(selectedMaterialNodeId) ? selectedMaterialNodeId : chooseDefaultMaterialCenter(materialGraph);
  const materialFlow = useMemo(
    () =>
      buildFocusedMaterialFlow({
        graph: materialGraph,
        centerNodeId: effectiveSelectedMaterialNodeId,
        selectedEdgeId: selectedMaterialEdgeId,
        depth: materialDepth,
        searchQuery: materialSearchQuery,
      }),
    [effectiveSelectedMaterialNodeId, materialDepth, materialGraph, materialSearchQuery, selectedMaterialEdgeId],
  );
  const courseFlow = useMemo(() => buildCourseFlow(courseGraph, selectedCourseId), [courseGraph, selectedCourseId]);
  const courseNodesById = useMemo(() => new Map((courseGraph?.nodes ?? []).map((node) => [node.id, node])), [courseGraph]);
  const selectedMaterialNode = effectiveSelectedMaterialNodeId ? materialNodesById.get(effectiveSelectedMaterialNodeId) ?? null : null;
  const selectedMaterialEdge = selectedMaterialEdgeId ? materialEdgesById.get(selectedMaterialEdgeId) ?? null : null;
  const selectedCourseNode = selectedCourseId ? courseNodesById.get(selectedCourseId) ?? null : null;
  const materialSearchMatches = useMemo(() => {
    const query = materialSearchQuery.trim().toLowerCase();
    if (!query) return [];
    return (materialGraph?.nodes ?? [])
      .filter((node) => `${node.label} ${node.summary} ${node.type}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [materialGraph, materialSearchQuery]);
  const selectedClaims = useMemo(() => {
    const selectedIds = new Set<string>();
    if (effectiveSelectedMaterialNodeId) selectedIds.add(effectiveSelectedMaterialNodeId);
    if (selectedMaterialEdge) {
      selectedIds.add(selectedMaterialEdge.source);
      selectedIds.add(selectedMaterialEdge.target);
    }
    return (materialGraph?.claims ?? []).filter((claim) => claim.entityIds.some((id) => selectedIds.has(id))).slice(0, 8);
  }, [effectiveSelectedMaterialNodeId, materialGraph, selectedMaterialEdge]);

  async function reloadCurrent() {
    if (activeTab === 'material') await loadMaterialGraph();
    else await loadCourseGraph();
  }

  async function regeneratePath() {
    setPlanning(true);
    const result = await a3PostJson<A3ApiResponse<{ path: LearningPath }>>('/api/learning/paths/generate/', { courseId: courseGraph?.course?.id, force: true });
    setPlanning(false);
    if (!result.success) {
      setMessage(result.error ?? '学习路径重排失败');
      return;
    }
    setMessage('已根据当前画像、诊断结果和先修关系重新生成学习路径');
    await loadCourseGraph();
  }

  async function requestFullscreen() {
    if (!graphRef.current || !document.fullscreenEnabled) {
      setMessage('当前浏览器不支持全屏查看');
      return;
    }
    await graphRef.current.requestFullscreen();
  }

  function resetMaterialCenter() {
    setSelectedMaterialNodeId(chooseDefaultMaterialCenter(materialGraph));
    setSelectedMaterialEdgeId(null);
    setMaterialSearchQuery('');
    setDetailOpen(true);
  }

  function onMaterialNodeClick(nodeId: string) {
    setSelectedMaterialNodeId(nodeId);
    setSelectedMaterialEdgeId(null);
    setDetailOpen(true);
    void loadMaterialGraphNeighborhood(nodeId, materialDepth);
  }

  function onMaterialEdgeClick(edgeId: string) {
    setSelectedMaterialEdgeId(edgeId);
    const materialEdge = materialEdgesById.get(edgeId);
    setSelectedMaterialNodeId(materialEdge?.source ?? null);
    setDetailOpen(true);
  }

  function onTabChange(tab: GraphTab) {
    setActiveTab(tab);
    setDetailOpen(tab === 'material' ? Boolean(selectedMaterialNode || selectedMaterialEdge) : Boolean(selectedCourseNode));
  }

  function onMaterialDepthChange(depth: MaterialGraphDepth) {
    setMaterialDepth(depth);
    const centerId = effectiveSelectedMaterialNodeId ?? chooseDefaultMaterialCenter(materialGraph);
    if (centerId) void loadMaterialGraphNeighborhood(centerId, depth);
  }

  const isMaterialEmpty = activeTab === 'material' && !loading && !(materialGraph?.nodes.length);

  const graphCanvas = (
    <div
      className="a3-material-graph-canvas relative h-full min-h-0 overflow-hidden"
      data-testid="a3-real-knowledge-graph"
      style={{
        background:
          'radial-gradient(circle at 50% 44%, rgba(255, 255, 255, 0.96) 0%, rgba(239, 246, 255, 0.78) 42%, rgba(248, 250, 252, 0.92) 74%), linear-gradient(135deg, rgba(241, 245, 249, 0.96), rgba(236, 253, 245, 0.28))',
      }}
    >
      {loading && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--a3-surface-solid)]/80">
          <div className="flex items-center gap-2 text-sm text-[var(--a3-text-muted)]">
            <Loader2 className="size-4 animate-spin" />
            正在读取{activeTab === 'material' ? '资料知识图谱' : '课程路径图'}
          </div>
        </div>
      )}

      {!loading && activeTab === 'material' && materialFlow.nodes.length > 0 && (
        <div className="h-full" data-testid="a3-material-focused-graph">
          <ReactFlow
            nodes={materialFlow.nodes}
            edges={materialFlow.edges}
            edgeTypes={materialEdgeTypes}
            onlyRenderVisibleElements
            fitView
            fitViewOptions={{ padding: 0.16 }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, node) => onMaterialNodeClick(node.id)}
            onEdgeClick={(_, edge) => onMaterialEdgeClick(edge.id)}
          >
            <Background gap={24} color="#dbe3ee" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}

      {!loading && activeTab === 'course' && courseFlow.nodes.length > 0 && (
        <ReactFlow
          nodes={courseFlow.nodes}
          edges={courseFlow.edges}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, node) => {
            setSelectedCourseId(node.id);
            setDetailOpen(true);
          }}
        >
          <Background gap={24} color="#e2e8f0" />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}

      {isMaterialEmpty && (
        <div className="grid h-full place-items-center p-6 text-center">
          <div className="max-w-md">
            <Database className="mx-auto size-10 text-blue-600" />
            <h3 className="mt-3 text-lg font-semibold text-[var(--a3-text)]">还没有生成资料知识图谱</h3>
            <p className="mt-2 text-sm leading-7 text-[var(--a3-text-muted)]">
              {materialGraph?.build.reason || '请先在知识库上传资料并完成多模态解析，系统会从真实解析块生成实体、关系和来源证据。'}
            </p>
            <Button asChild className="mt-4 bg-blue-600 hover:bg-blue-700">
              <Link href={materialGraph?.nextAction?.href ?? '/a3/knowledge-base'}>{materialGraph?.nextAction?.label ?? '上传资料'}</Link>
            </Button>
          </div>
        </div>
      )}

      {activeTab === 'course' && !loading && !courseGraph?.nodes.length && (
        <div className="grid h-full place-items-center text-sm text-[var(--a3-text-muted)]">暂无课程路径图，请先完成入学诊断或生成学习路径。</div>
      )}
    </div>
  );

  return (
    <section ref={graphRef}
      className="overflow-hidden rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)]"
      data-testid="a3-knowledge-graph-workbench"
    >
      <header className="flex flex-col gap-3 border-b border-[var(--a3-border)] px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--a3-text)]">知识关系</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--a3-text-muted)]">在资料图谱中核验来源证据，或切换课程路径图理解学习顺序并进入下一步学习。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void reloadCurrent()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            刷新
          </Button>
          {activeTab === 'material' ? <GraphDataStatusPopover graph={materialGraph} /> : null}
          <Button size="sm" variant="outline" onClick={() => void requestFullscreen()}>
            <Maximize2 className="size-4" />
            全屏
          </Button>
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

      {message ? (
        <div role="status" className="border-b border-[var(--a3-border)] px-4 py-2 text-sm text-blue-700">
          {message}
        </div>
      ) : null}

      <KnowledgeGraphWorkspace
        canvas={graphCanvas}
        detail={
          activeTab === 'material' ? (
            <MaterialDetailPanel
              node={selectedMaterialNode}
              edge={selectedMaterialEdge}
              claims={selectedClaims}
              edges={materialGraph?.edges ?? []}
              nodesById={materialNodesById}
            />
          ) : (
            <CourseDetail node={selectedCourseNode} planning={planning} onRegenerate={() => void regeneratePath()} />
          )
        }
        detailOpen={detailOpen}
        detailTitle={activeTab === 'material' ? (selectedMaterialEdge ? '关系证据' : '实体详情') : '课程节点详情'}
        onCloseDetail={() => setDetailOpen(false)}
      />

      {activeTab === 'material' ? (
        <KnowledgeGraphStatusBar graph={materialGraph} focus={materialGraph?.focus} depth={materialDepth} loading={loading} />
      ) : null}
    </section>
  );
}

function mergeMaterialGraphs(current: MaterialGraph, incoming: MaterialGraph): MaterialGraph {
  return {
    ...incoming,
    nodes: mergeById(current.nodes, incoming.nodes),
    edges: mergeById(current.edges, incoming.edges),
    claims: mergeById(current.claims, incoming.claims),
  };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  current.forEach((item) => byId.set(item.id, item));
  incoming.forEach((item) => byId.set(item.id, item));
  return [...byId.values()];
}

function buildCourseFlow(graph: KnowledgeGraph | null, selectedId: string | null): { nodes: Node<GraphNodeData>[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const chapterOrders = Array.from(new Set(graph.nodes.map((node) => node.chapter.order))).sort((a, b) => a - b);
  const byChapter = new Map<number, KnowledgeGraphNode[]>();
  graph.nodes.forEach((node) => byChapter.set(node.chapter.order, [...(byChapter.get(node.chapter.order) ?? []), node]));
  const nodes = graph.nodes.map((node) => {
    const chapterIndex = chapterOrders.indexOf(node.chapter.order);
    const siblings = byChapter.get(node.chapter.order) ?? [];
    const siblingIndex = siblings.findIndex((item) => item.id === node.id);
    const meta = statusMeta[node.status];
    return {
      id: node.id,
      position: { x: chapterIndex * 270, y: siblingIndex * 150 },
      data: {
        label: (
          <div className="space-y-2 text-left">
            <div className="flex items-center justify-between gap-2">
              <span className="line-clamp-2 font-semibold leading-5">{node.title}</span>
              <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
            </div>
            <div className="text-xs opacity-75">{node.chapter.title}</div>
            <div className="flex items-center justify-between text-xs">
              <span>{meta.label}</span>
              <span>{node.progress}%</span>
            </div>
          </div>
        ),
      },
      selected: selectedId === node.id,
      style: {
        width: 210,
        borderRadius: 10,
        border: selectedId === node.id ? '2px solid #2563eb' : '1px solid #cbd5e1',
        background: meta.surface,
        color: meta.text,
        padding: 12,
        fontSize: 13,
      },
    } satisfies Node<GraphNodeData>;
  });
  const edges = graph.edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    label: edge.label ?? '先修',
    animated: graph.nodes.find((node) => node.id === edge.to)?.status === 'learning',
    style: { stroke: '#2563eb', strokeWidth: 1.8 },
    labelStyle: { fill: '#475569', fontSize: 11 },
  }));
  return { nodes, edges };
}

function CourseDetail({ node, planning, onRegenerate }: { node: KnowledgeGraphNode | null; planning: boolean; onRegenerate: () => void }) {
  return (
    <div data-testid="a3-course-detail-panel">
      {node ? (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words text-lg font-semibold text-[var(--a3-text)]">{node.title}</h2>
              <p className="mt-1 text-sm text-[var(--a3-text-muted)]">第 {node.chapter.order} 章 · {node.chapter.title}</p>
            </div>
            <A3Pill tone={node.status === 'weak' ? 'red' : node.status === 'mastered' ? 'green' : 'blue'}>{statusMeta[node.status].label}</A3Pill>
          </div>
          <p className="text-sm leading-7 text-[var(--a3-text-muted)]">{node.description || '该课程节点暂无说明。'}</p>
          <div className="rounded-xl bg-[var(--a3-surface-muted)] p-3">
            <div className="text-sm font-semibold text-[var(--a3-text)]">路径绑定</div>
            <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">围绕当前节点进入今日任务、AI 辅导或测评，完成后会回写学习进度。</p>
          </div>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/a3/today">
              <BookOpen className="size-4" />
              回到今日任务
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href={`/a3/coaching?knowledgePointId=${encodeURIComponent(node.id)}`}>
              <Sparkles className="size-4" />
              针对该节点辅导
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href={`/a3/assessment?knowledgePointId=${encodeURIComponent(node.id)}`}>
              <BookOpen className="size-4" />
              针对该节点测评
            </Link>
          </Button>
          <Button className="w-full bg-blue-600 hover:bg-blue-700" disabled={planning} onClick={onRegenerate}>
            {planning ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            根据画像重排学习路径
          </Button>
        </div>
      ) : (
        <div className="py-10 text-center text-sm text-[var(--a3-text-muted)]">请选择一个课程节点查看详情。</div>
      )}
    </div>
  );
}
