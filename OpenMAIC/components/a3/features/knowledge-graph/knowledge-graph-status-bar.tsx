import type { MaterialGraphDepth } from './material-focused-flow';
import type { MaterialGraph, MaterialGraphFocus } from './material-types';

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
      <span>当前加载 {nodeCount} 个实体</span>
      <span aria-hidden>·</span>
      <span>{edgeCount} 条关系</span>
      <span aria-hidden>·</span>
      <span>{depthLabel[props.depth]}</span>
      {props.loading ? <span>· 正在更新</span> : <span>· 数据已更新</span>}
      {partial ? <span className="text-amber-700">· 当前为局部视图</span> : null}
      {props.graph?.build.degraded ? <span className="text-amber-700">· 部分内容为降级抽取</span> : null}
    </footer>
  );
}
