'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, BookOpen, Database, Loader2, Maximize2, Network, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3ApiResponse, KnowledgeGraph, KnowledgeGraphNode, KnowledgeGraphNodeStatus, LearningPath } from '@/lib/a3/learning-types';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';

type GraphTab = 'material' | 'course';

type MaterialEvidence = {
  resourceId: string;
  resourceTitle: string;
  resourceType: string;
  blockId: string;
  blockType: string;
  pageNumber: number | null;
  slideIndex: number | null;
  location: string;
  snippet: string;
  markdownSnippet?: string;
  contentFormat?: 'markdown' | 'plain' | string;
  formatFeatures?: string[];
  confidence: number;
  degraded: boolean;
  warnings?: string[];
};

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

type MaterialGraph = {
  schemaVersion: string;
  source: 'knowledge_base_materials' | string;
  mode: 'material_graph' | string;
  nodes: MaterialNode[];
  edges: MaterialEdge[];
  claims: MaterialClaim[];
  summary: {
    resourceCount: number;
    entityCount: number;
    relationCount: number;
    claimCount: number;
    degradedCount: number;
  };
  build: {
    status: string;
    lastBuiltAt: string | null;
    degraded: boolean;
    reason: string;
  };
  nextAction?: { label: string; href: string } | null;
};

type GraphNodeData = {
  label: ReactNode;
};

const statusMeta: Record<KnowledgeGraphNodeStatus, { label: string; dot: string; surface: string; text: string }> = {
  mastered: { label: '已掌握', dot: 'bg-emerald-500', surface: '#ecfdf5', text: '#047857' },
  learning: { label: '学习中', dot: 'bg-blue-500', surface: '#eff6ff', text: '#1d4ed8' },
  weak: { label: '薄弱点', dot: 'bg-rose-500', surface: '#fff1f2', text: '#be123c' },
  locked: { label: '待解锁', dot: 'bg-slate-400', surface: '#f8fafc', text: '#475569' },
  unstarted: { label: '未学习', dot: 'bg-violet-500', surface: '#f5f3ff', text: '#6d28d9' },
};

const materialTypeLabel: Record<string, string> = {
  concept: '概念',
  method: '方法',
  formula: '公式',
  visual: '图表',
};

export function KnowledgeGraphView() {
  const graphRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<GraphTab>('material');
  const [materialGraph, setMaterialGraph] = useState<MaterialGraph | null>(null);
  const [courseGraph, setCourseGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedMaterialNodeId, setSelectedMaterialNodeId] = useState<string | null>(null);
  const [selectedMaterialEdgeId, setSelectedMaterialEdgeId] = useState<string | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [message, setMessage] = useState('');

  const loadMaterialGraph = useCallback(async () => {
    setLoading(true);
    const result = await a3GetJson<A3ApiResponse<{ graph: MaterialGraph }>>('/api/kb/graph/');
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '资料知识图谱加载失败');
      return;
    }
    setMaterialGraph(result.graph);
    setSelectedMaterialNodeId((current) => current ?? result.graph.nodes[0]?.id ?? null);
    setSelectedMaterialEdgeId(null);
    setMessage('');
  }, []);

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
    const timer = window.setTimeout(() => {
      void (activeTab === 'material' ? loadMaterialGraph() : loadCourseGraph());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, loadCourseGraph, loadMaterialGraph]);

  const materialFlow = useMemo(() => buildMaterialFlow(materialGraph, selectedMaterialNodeId, selectedMaterialEdgeId), [materialGraph, selectedMaterialNodeId, selectedMaterialEdgeId]);
  const courseFlow = useMemo(() => buildCourseFlow(courseGraph, selectedCourseId), [courseGraph, selectedCourseId]);
  const materialNodesById = useMemo(() => new Map((materialGraph?.nodes ?? []).map((node) => [node.id, node])), [materialGraph]);
  const materialEdgesById = useMemo(() => new Map((materialGraph?.edges ?? []).map((edge) => [edge.id, edge])), [materialGraph]);
  const courseNodesById = useMemo(() => new Map((courseGraph?.nodes ?? []).map((node) => [node.id, node])), [courseGraph]);
  const selectedMaterialNode = selectedMaterialNodeId ? materialNodesById.get(selectedMaterialNodeId) ?? null : null;
  const selectedMaterialEdge = selectedMaterialEdgeId ? materialEdgesById.get(selectedMaterialEdgeId) ?? null : null;
  const selectedCourseNode = selectedCourseId ? courseNodesById.get(selectedCourseId) ?? null : null;
  const selectedClaims = useMemo(
    () => (materialGraph?.claims ?? []).filter((claim) => selectedMaterialNodeId && claim.entityIds.includes(selectedMaterialNodeId)).slice(0, 5),
    [materialGraph, selectedMaterialNodeId],
  );

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

  const activeFlow = activeTab === 'material' ? materialFlow : courseFlow;
  const isMaterialEmpty = activeTab === 'material' && !loading && !(materialGraph?.nodes.length);

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <A3Card
          title="资料知识图谱"
          subtitle={activeTab === 'material' ? '从已上传资料的多模态解析块抽取实体、关系和证据；课程路径图保留在次级页签。' : '课程路径图展示课程知识点、先修关系和学习进度，不代表上传资料图谱。'}
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void reloadCurrent()} disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                刷新
              </Button>
              <Button size="sm" variant="outline" onClick={() => void requestFullscreen()}>
                <Maximize2 className="size-4" />
                全屏
              </Button>
            </div>
          }
        >
          <div className="mb-4 flex flex-wrap gap-2">
            <TabButton active={activeTab === 'material'} onClick={() => setActiveTab('material')}>
              <Database className="size-4" />
              资料图谱
            </TabButton>
            <TabButton active={activeTab === 'course'} onClick={() => setActiveTab('course')}>
              <Network className="size-4" />
              课程路径图
            </TabButton>
          </div>

          {message && <div className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">{message}</div>}

          {activeTab === 'material' ? (
            <div className="mb-5 grid gap-3 md:grid-cols-4">
              <GraphMetric label="资料数" value={materialGraph?.summary.resourceCount ?? 0} />
              <GraphMetric label="实体" value={materialGraph?.summary.entityCount ?? 0} />
              <GraphMetric label="关系" value={materialGraph?.summary.relationCount ?? 0} tone="blue" />
              <GraphMetric label="降级证据" value={materialGraph?.summary.degradedCount ?? 0} tone="orange" />
            </div>
          ) : (
            <div className="mb-5 grid gap-3 md:grid-cols-4">
              <GraphMetric label="知识点" value={courseGraph?.summary.total ?? 0} />
              <GraphMetric label="掌握率" value={`${courseGraph?.summary.masteryRate ?? 0}%`} />
              <GraphMetric label="薄弱点" value={courseGraph?.summary.weak ?? 0} tone="red" />
              <GraphMetric label="下一步" value={courseGraph?.summary.nextCount ?? 0} tone="blue" />
            </div>
          )}

          <div ref={graphRef} className="relative h-[640px] overflow-hidden rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)]" data-testid="a3-real-knowledge-graph">
            {loading && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--a3-surface-solid)]/80">
                <div className="flex items-center gap-2 text-sm text-[var(--a3-text-muted)]">
                  <Loader2 className="size-4 animate-spin" />
                  正在读取{activeTab === 'material' ? '资料知识图谱' : '课程路径图'}
                </div>
              </div>
            )}

            {!loading && activeFlow.nodes.length > 0 && (
              <ReactFlow
                nodes={activeFlow.nodes}
                edges={activeFlow.edges}
                fitView
                fitViewOptions={{ padding: 0.18 }}
                nodesDraggable
                nodesConnectable={false}
                elementsSelectable
                onNodeClick={(_, node) => {
                  if (activeTab === 'material') {
                    setSelectedMaterialNodeId(node.id);
                    setSelectedMaterialEdgeId(null);
                  } else {
                    setSelectedCourseId(node.id);
                  }
                }}
                onEdgeClick={(_, edge) => {
                  if (activeTab === 'material') {
                    setSelectedMaterialEdgeId(edge.id);
                    setSelectedMaterialNodeId(null);
                  }
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
                  <p className="mt-2 text-sm leading-7 text-[var(--a3-text-muted)]">{materialGraph?.build.reason || '请先在知识库上传资料并完成多模态解析，系统会从真实解析块生成实体、关系和来源证据。'}</p>
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
        </A3Card>

        {activeTab === 'material' ? (
          <A3Card title="构建状态">
            <div className="grid gap-3 md:grid-cols-3">
              <InfoBox label="Schema" value={materialGraph?.schemaVersion ?? 'a3.material-knowledge-graph.v1'} />
              <InfoBox label="状态" value={materialGraph?.build.status ?? 'empty'} />
              <InfoBox label="最近构建" value={materialGraph?.build.lastBuiltAt ? new Date(materialGraph.build.lastBuiltAt).toLocaleString() : '暂无'} />
            </div>
            {materialGraph?.build.reason && <p className="mt-3 text-sm leading-7 text-[var(--a3-text-muted)]">{materialGraph.build.reason}</p>}
          </A3Card>
        ) : (
          <A3Card title="课程图谱说明">
            <p className="text-sm leading-7 text-[var(--a3-text-muted)]">课程路径图来自课程知识点和学习路径进度，只用于解释学习顺序；上传资料形成的实体关系请回到“资料图谱”查看。</p>
          </A3Card>
        )}
      </div>

      <div className="space-y-5">
        {activeTab === 'material' ? (
          <MaterialDetail node={selectedMaterialNode} edge={selectedMaterialEdge} claims={selectedClaims} />
        ) : (
          <CourseDetail node={selectedCourseNode} planning={planning} onRegenerate={() => void regeneratePath()} />
        )}
      </div>
    </div>
  );
}

function buildMaterialFlow(graph: MaterialGraph | null, selectedNodeId: string | null, selectedEdgeId: string | null): { nodes: Node<GraphNodeData>[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const radius = Math.max(260, Math.min(620, graph.nodes.length * 28));
  const nodes = graph.nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(graph.nodes.length, 1);
    const tone = materialTone(node.type, node.degraded);
    return {
      id: node.id,
      position: { x: Math.cos(angle) * radius + radius, y: Math.sin(angle) * radius + radius },
      data: {
        label: (
          <div className="space-y-2 text-left">
            <div className="line-clamp-2 font-semibold leading-5">{node.label}</div>
            <div className="flex items-center justify-between text-xs">
              <span>{materialTypeLabel[node.type] ?? node.type}</span>
              <span>{Math.round(node.confidence * 100)}%</span>
            </div>
            {node.degraded && <div className="rounded bg-white/75 px-2 py-1 text-xs text-amber-700">降级抽取</div>}
          </div>
        ),
      },
      selected: selectedNodeId === node.id,
      style: {
        width: 210,
        borderRadius: 10,
        border: selectedNodeId === node.id ? '2px solid #2563eb' : `1px solid ${tone.border}`,
        background: tone.surface,
        color: tone.text,
        padding: 12,
        fontSize: 13,
        boxShadow: selectedNodeId === node.id ? '0 12px 30px rgba(37, 99, 235, 0.18)' : '0 8px 20px rgba(15, 23, 42, 0.08)',
      },
    } satisfies Node<GraphNodeData>;
  });
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: selectedEdgeId === edge.id,
    style: { stroke: selectedEdgeId === edge.id ? '#2563eb' : '#64748b', strokeWidth: selectedEdgeId === edge.id ? 2.4 : 1.7 },
    labelStyle: { fill: '#475569', fontSize: 11 },
  }));
  return { nodes, edges };
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

function MaterialDetail({ node, edge, claims }: { node: MaterialNode | null; edge: MaterialEdge | null; claims: MaterialClaim[] }) {
  if (edge) {
    return (
      <A3Card title="关系证据" action={<A3Pill tone={edge.degraded ? 'orange' : 'green'}>{edge.degraded ? '降级' : '已验证'}</A3Pill>}>
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--a3-text)]">{edge.label}</h2>
            <p className="mt-1 text-sm text-[var(--a3-text-muted)]">{edge.type} · 权重 {Math.round(edge.weight * 100)}%</p>
          </div>
          <EvidenceList evidence={edge.evidence} />
        </div>
      </A3Card>
    );
  }
  return (
    <A3Card title="实体详情" action={node ? <A3Pill tone={node.degraded ? 'orange' : 'green'}>{node.degraded ? '降级抽取' : '已验证'}</A3Pill> : undefined}>
      {node ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--a3-text)]">{node.label}</h2>
            <p className="mt-1 text-sm text-[var(--a3-text-muted)]">{materialTypeLabel[node.type] ?? node.type} · 置信度 {Math.round(node.confidence * 100)}%</p>
          </div>
          <A3Markdown className="text-sm leading-7 text-[var(--a3-text-muted)]">{formatMaterialMarkdown(node.summary || '该实体来自上传资料解析块，暂无更长摘要。')}</A3Markdown>
          <EvidenceList evidence={node.evidence} />
          {claims.length > 0 && (
            <div className="rounded-xl bg-[var(--a3-surface-muted)] p-3">
              <div className="mb-2 text-sm font-semibold text-[var(--a3-text)]">关联断言</div>
              <div className="space-y-2">
                {claims.map((claim) => (
                  <A3Markdown key={claim.id} className="text-sm leading-6 text-[var(--a3-text-muted)]">{formatMaterialMarkdown(claim.text)}</A3Markdown>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="py-10 text-center text-sm text-[var(--a3-text-muted)]">请选择一个实体或关系查看来源证据。</div>
      )}
    </A3Card>
  );
}

function CourseDetail({ node, planning, onRegenerate }: { node: KnowledgeGraphNode | null; planning: boolean; onRegenerate: () => void }) {
  return (
    <A3Card title="课程节点详情" action={node ? <A3Pill tone={node.status === 'weak' ? 'red' : node.status === 'mastered' ? 'green' : 'blue'}>{statusMeta[node.status].label}</A3Pill> : undefined}>
      {node ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--a3-text)]">{node.title}</h2>
            <p className="mt-1 text-sm text-[var(--a3-text-muted)]">第 {node.chapter.order} 章 · {node.chapter.title}</p>
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
    </A3Card>
  );
}

function EvidenceList({ evidence }: { evidence: MaterialEvidence[] }) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold text-[var(--a3-text)]">来源证据</div>
      {evidence.map((item, index) => (
        <div key={materialEvidenceKey(item, index)} className="rounded-xl bg-[var(--a3-surface-muted)] p-3 text-sm leading-6">
          <div className="font-medium text-[var(--a3-text)]">{item.resourceTitle}</div>
          <div className="text-[var(--a3-text-muted)]">{item.location}</div>
          <A3Markdown className="mt-2 text-[var(--a3-text-muted)] [&_table]:min-w-[460px]">{formatMaterialMarkdown(item.markdownSnippet || item.snippet)}</A3Markdown>
          {item.degraded && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">
              <AlertTriangle className="size-3" />
              降级证据
            </div>
          )}
        </div>
      ))}
      {!evidence.length && <p className="text-sm text-[var(--a3-text-muted)]">暂无证据片段。</p>}
    </div>
  );
}

function materialEvidenceKey(item: MaterialEvidence, index: number) {
  return [item.resourceId, item.blockId, item.location, item.blockType, item.snippet.slice(0, 80), index].join('::');
}

function formatMaterialMarkdown(value: string) {
  return value.trim();
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition',
        active ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-[var(--a3-border)] bg-white text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)]',
      )}
    >
      {children}
    </button>
  );
}

function GraphMetric({ label, value, tone = 'slate' }: { label: string; value: string | number; tone?: 'slate' | 'blue' | 'red' | 'orange' }) {
  const toneClass = tone === 'blue' ? 'text-blue-700' : tone === 'red' ? 'text-rose-700' : tone === 'orange' ? 'text-amber-700' : 'text-[var(--a3-text)]';
  return (
    <div className="rounded-xl bg-[var(--a3-surface-muted)] p-4">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold', toneClass)}>{value}</div>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function materialTone(type: string, degraded: boolean) {
  if (degraded) return { surface: '#fffbeb', border: '#f59e0b', text: '#92400e' };
  if (type === 'method') return { surface: '#eff6ff', border: '#60a5fa', text: '#1d4ed8' };
  if (type === 'formula') return { surface: '#f0fdf4', border: '#4ade80', text: '#15803d' };
  if (type === 'visual') return { surface: '#f5f3ff', border: '#a78bfa', text: '#6d28d9' };
  return { surface: '#f8fafc', border: '#cbd5e1', text: '#334155' };
}
