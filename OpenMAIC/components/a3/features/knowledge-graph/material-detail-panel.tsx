import { AlertTriangle } from 'lucide-react';
import { A3Pill } from '../../ui/a3-card';
import { A3Markdown } from '../../ui/a3-markdown';
import type { MaterialClaim, MaterialEdge, MaterialEvidence, MaterialNode } from './material-types';
import { formatMaterialMarkdown, materialEvidenceKey, materialTypeLabel } from './material-types';

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

function EntityDetail(props: { node: MaterialNode; claims: MaterialClaim[]; edges: MaterialEdge[]; nodesById: Map<string, MaterialNode> }) {
  const relatedEdges = props.edges.filter((edge) => edge.source === props.node.id || edge.target === props.node.id).slice(0, 8);
  return (
    <div className="space-y-5">
      <DetailHeading
        title={props.node.label}
        meta={`${materialTypeLabel[props.node.type] ?? props.node.type} · 置信度 ${Math.round((props.node.confidence ?? 0) * 100)}%`}
        state={props.node.degraded ? 'degraded' : props.node.evidence.length ? 'verified' : 'unverified'}
      />

      <section>
        <div className="mb-2 text-sm font-semibold text-[var(--a3-text)]">标准解释</div>
        <A3Markdown className="text-sm leading-7 text-[var(--a3-text-muted)]">
          {formatMaterialMarkdown(props.node.definition || props.node.summary || '该实体来自上传资料解析块，暂无更长摘要。')}
        </A3Markdown>
      </section>

      {props.node.keyPoints?.length ? (
        <section>
          <div className="mb-2 text-sm font-semibold text-[var(--a3-text)]">关键点</div>
          <ul className="space-y-2 text-sm leading-6 text-[var(--a3-text-muted)]">
            {props.node.keyPoints.slice(0, 5).map((point) => (
              <li key={point} className="break-words">· {point}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <div className="mb-2 text-sm font-semibold text-[var(--a3-text)]">路径证据</div>
        <div className="space-y-2">
          {relatedEdges.map((edge) => {
            const outbound = edge.source === props.node.id;
            const other = props.nodesById.get(outbound ? edge.target : edge.source);
            return (
              <ReadablePath
                key={edge.id}
                source={outbound ? props.node.label : other?.label ?? edge.source}
                label={edge.label || edge.type}
                target={outbound ? other?.label ?? edge.target : props.node.label}
                confidence={edge.weight}
              />
            );
          })}
          {!relatedEdges.length && <p className="text-sm text-[var(--a3-text-muted)]">暂无关联关系。</p>}
        </div>
      </section>

      {props.claims.length > 0 && (
        <section>
          <div className="mb-2 text-sm font-semibold text-[var(--a3-text)]">关联断言</div>
          <div className="space-y-2">
            {props.claims.map((claim) => (
              <div key={claim.id} className="rounded-lg bg-[var(--a3-surface-muted)] p-3">
                <A3Markdown className="text-sm leading-6 text-[var(--a3-text-muted)]">{formatMaterialMarkdown(claim.text)}</A3Markdown>
                <div className="mt-2 text-xs text-[var(--a3-text-muted)]">{claim.verified ? '已验证' : '待验证'}{claim.degraded ? ' · 降级抽取' : ''}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <EvidenceList evidence={props.node.evidence} />
    </div>
  );
}

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

function ReadablePath({ source, label, target, confidence }: { source: string; label: string; target: string; confidence?: number }) {
  return (
    <div data-testid="a3-material-readable-path" className="rounded-lg bg-[var(--a3-surface-muted)] px-3 py-2 text-sm">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <span className="min-w-0 truncate font-medium text-[var(--a3-text)]">{source}</span>
        <span className="shrink-0 text-xs text-[var(--a3-text-muted)]">{' -> '}</span>
        <span className="min-w-0 truncate font-medium text-[var(--a3-text)]">{target}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs text-[var(--a3-text-muted)]">
        <span className="min-w-0 truncate">{label}</span>
        {typeof confidence === 'number' && <span className="shrink-0">{Math.round(confidence * 100)}%</span>}
      </div>
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: MaterialEvidence[] }) {
  return (
    <section className="space-y-3">
      <div className="text-sm font-semibold text-[var(--a3-text)]">来源证据</div>
      {evidence.map((item, index) => (
        <details key={materialEvidenceKey(item, index)} className="rounded-xl bg-[var(--a3-surface-muted)] p-3 text-sm leading-6" open={index === 0}>
          <summary className="cursor-pointer list-none">
            <div className="min-w-0">
              <div className="truncate font-medium text-[var(--a3-text)]">{item.resourceTitle}</div>
              <div className="truncate text-xs text-[var(--a3-text-muted)]">{item.location}</div>
            </div>
          </summary>
          <A3Markdown className="mt-3 text-[var(--a3-text-muted)] [&_table]:min-w-[460px]">{formatMaterialMarkdown(item.markdownSnippet || item.snippet)}</A3Markdown>
          {item.degraded && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">
              <AlertTriangle className="size-3" />
              降级证据
            </div>
          )}
        </details>
      ))}
      {!evidence.length && <p className="text-sm text-[var(--a3-text-muted)]">暂无可核验来源。</p>}
    </section>
  );
}
