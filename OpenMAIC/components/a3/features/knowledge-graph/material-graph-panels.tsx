import { Database, RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MaterialEdge, MaterialGraph, MaterialGraphQuality, MaterialNode } from './material-types';
import { materialTypeLabel } from './material-types';
import type { MaterialGraphDepth } from './material-focused-flow';

export function MaterialGraphSearchPanel(props: {
  query: string;
  onQueryChange: (value: string) => void;
  onReset: () => void;
  loading: boolean;
  selectedNode: MaterialNode | null;
  graph?: MaterialGraph | null;
  onSelectNode?: (id: string) => void;
}) {
  const matches = (props.graph?.nodes ?? [])
    .filter((node) => {
      const query = props.query.trim().toLowerCase();
      if (!query) return false;
      return `${node.label} ${node.summary}`.toLowerCase().includes(query);
    })
    .slice(0, 6);

  return (
    <div className="space-y-3 rounded-xl border border-slate-200/80 bg-[var(--a3-surface-solid)]/95 p-3 shadow-lg shadow-slate-200/70 backdrop-blur" data-testid="a3-material-left-entity-panel">
      <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="a3-material-graph-search">
        <Search className="size-4 shrink-0" />
        <input
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          disabled={props.loading}
          placeholder="搜索实体、术语或摘要"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
        />
      </label>
      {matches.length > 0 && (
        <div className="max-h-44 space-y-1 overflow-auto">
          {matches.map((node) => (
            <button key={node.id} type="button" onClick={() => props.onSelectNode?.(node.id)} className="w-full rounded-lg px-2 py-2 text-left text-xs text-slate-600 hover:bg-slate-100">
              <span className="block truncate font-medium text-slate-900">{node.label}</span>
              <span className="line-clamp-1">{node.summary || materialTypeLabel[node.type] || node.type}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-950">{props.selectedNode?.label ?? '未选择实体'}</div>
          <div className="truncate text-xs text-slate-500">{props.selectedNode ? materialTypeLabel[props.selectedNode.type] ?? props.selectedNode.type : '点击图谱中的节点查看详情'}</div>
        </div>
        <Button size="sm" variant="outline" onClick={props.onReset} disabled={props.loading} aria-label="重置中心实体">
          <RotateCcw className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function MaterialGraphMiniPanel(props: { node: MaterialNode | null; edge: MaterialEdge | null }) {
  if (!props.node && !props.edge) return null;
  return (
    <div className="rounded-xl border border-slate-200/80 bg-[var(--a3-surface-solid)]/95 p-3 shadow-lg shadow-slate-200/70 backdrop-blur" data-testid="a3-material-node-mini-panel">
      {props.edge ? (
        <div className="space-y-1">
          <div className="truncate text-sm font-semibold text-slate-950">{props.edge.label || props.edge.type}</div>
          <div className="text-xs text-slate-500">关系强度 {Math.round((props.edge.weight ?? 0) * 100)}%</div>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="line-clamp-2 text-sm font-semibold text-slate-950">{props.node?.label}</div>
          <div className="text-xs text-slate-500">置信度 {Math.round((props.node?.confidence ?? 0) * 100)}%</div>
          {props.node?.summary && <div className="line-clamp-2 text-xs leading-5 text-slate-600">{props.node.summary}</div>}
        </div>
      )}
    </div>
  );
}

export function MaterialGraphStatsPanel(props: {
  graph: MaterialGraph | null;
  depth: MaterialGraphDepth;
  onDepthChange: (depth: MaterialGraphDepth) => void;
  quality?: MaterialGraphQuality;
}) {
  const graph = props.graph;
  const quality = props.quality ?? graph?.quality ?? {};
  const fallbackQuality = graph ? deriveVisibleQuality(graph) : {};
  const displayQuality = { ...fallbackQuality, ...quality };
  const tooDense = (graph?.nodes.length ?? 0) > 80;
  return (
    <div className="space-y-3 rounded-xl border border-slate-200/80 bg-[var(--a3-surface-solid)]/95 p-3 shadow-lg shadow-slate-200/70 backdrop-blur" data-testid="a3-material-graph-stats-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-950">图谱状态</div>
          <div className="text-xs text-slate-500">{graph?.build.status ?? 'empty'}</div>
        </div>
        <Database className="size-4 text-slate-500" />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs" data-testid="a3-material-graph-index-panel">
        <Stat label="实体" value={graph?.summary.entityCount ?? graph?.nodes.length ?? 0} />
        <Stat label="关系" value={graph?.summary.relationCount ?? graph?.edges.length ?? 0} />
        <Stat label="资料" value={graph?.summary.resourceCount ?? 0} />
        <Stat label="断言" value={graph?.summary.claimCount ?? graph?.claims.length ?? 0} />
      </div>
      <div className="space-y-2" data-testid="a3-material-graph-quality-panel">
        <Quality label="证据覆盖" value={displayQuality.evidenceCoverage} />
        <Quality label="孤立实体" value={displayQuality.isolatedEntityRate} reverse />
        <Quality label="关系密度" value={displayQuality.relationDensity} />
        <div className="flex justify-between text-xs text-slate-500">
          <span>别名合并</span>
          <span>{displayQuality.aliasMergeCount ?? 0}</span>
        </div>
        <div className="flex justify-between text-xs text-slate-500">
          <span>补抽轮次</span>
          <span>{displayQuality.gleaningRounds ?? 0}</span>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-1 text-xs font-medium text-slate-600">
          <SlidersHorizontal className="size-3.5" />
          显示密度
        </div>
        <div className="grid grid-cols-3 gap-1">
          <DepthButton id="a3-material-graph-depth-one" active={props.depth === 'one'} onClick={() => props.onDepthChange('one')}>一跳</DepthButton>
          <DepthButton id="a3-material-graph-depth-two" active={props.depth === 'two'} onClick={() => props.onDepthChange('two')}>二跳</DepthButton>
          <DepthButton id="a3-material-graph-depth-all" active={props.depth === 'all'} onClick={() => props.onDepthChange('all')}>全部</DepthButton>
        </div>
        {tooDense && <p className="text-xs leading-5 text-amber-700">节点较多，已优先展示当前实体的一跳关系。</p>}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-2">
      <div className="text-slate-500">{label}</div>
      <div className="mt-0.5 font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function Quality({ label, value, reverse = false }: { label: string; value?: number; reverse?: boolean }) {
  const percent = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)));
  const good = reverse ? percent <= 20 : percent >= 70;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={cn('h-full rounded-full', good ? 'bg-emerald-500' : 'bg-amber-500')} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function DepthButton({ id, active, onClick, children }: { id: string; active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      data-testid={id}
      onClick={onClick}
      className={cn('rounded-md border px-2 py-1.5 text-xs font-medium transition', active ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}
    >
      {children}
    </button>
  );
}

function deriveVisibleQuality(graph: MaterialGraph): MaterialGraphQuality {
  const entityIds = new Set(graph.nodes.map((node) => node.id));
  const connected = new Set<string>();
  graph.edges.forEach((edge) => {
    connected.add(edge.source);
    connected.add(edge.target);
  });
  const evidenceTotal = graph.nodes.length + graph.edges.length + graph.claims.length;
  const evidenceBound =
    graph.nodes.filter((node) => node.evidence?.length).length +
    graph.edges.filter((edge) => edge.evidence?.length).length +
    graph.claims.filter((claim) => claim.evidence?.length).length;
  const maxEdges = graph.nodes.length * Math.max(graph.nodes.length - 1, 0);
  return {
    isolatedEntityRate: entityIds.size ? (entityIds.size - [...connected].filter((id) => entityIds.has(id)).length) / entityIds.size : 0,
    evidenceCoverage: evidenceTotal ? evidenceBound / evidenceTotal : 0,
    relationDensity: maxEdges ? graph.edges.length / maxEdges : 0,
  };
}
