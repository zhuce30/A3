import { cn } from '@/lib/utils';
import type { MaterialGraph, MaterialGraphQuality } from './material-types';

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
        <div className="flex justify-between gap-4">
          <dt>最近构建</dt>
          <dd>{formatBuildTime(graph?.build.lastBuiltAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>别名合并</dt>
          <dd>{quality.aliasMergeCount ?? 0}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>补抽轮次</dt>
          <dd>{quality.gleaningRounds ?? 0}</dd>
        </div>
      </dl>
      {graph?.build.reason ? <p className="text-xs leading-5 text-[var(--a3-text-muted)]">{graph.build.reason}</p> : null}
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

function formatBuildTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '暂无';
}
