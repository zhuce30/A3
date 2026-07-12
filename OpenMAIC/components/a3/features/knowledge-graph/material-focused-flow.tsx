import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { Edge, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { GraphNodeData, MaterialGraph, MaterialRelationEdgeData } from './material-types';
import { materialTypeLabel } from './material-types';

export type MaterialGraphDepth = 'one' | 'two' | 'all';

type LayoutNode = SimulationNodeDatum & {
  id: string;
  degree: number;
  direct: boolean;
  neighborhood: boolean;
  searchMatch: boolean;
  selected: boolean;
};

type NodeRadiusInput = {
  muted: boolean;
  selected: boolean;
  directNeighbor: boolean;
  searchMatch: boolean;
  degree: number;
};

const centerPoint = { x: 620, y: 360 };

export function chooseDefaultMaterialCenter(graph: MaterialGraph | null): string | null {
  if (!graph?.nodes.length) return null;
  const degree = new Map<string, number>();
  graph.nodes.forEach((node) => degree.set(node.id, 0));
  graph.edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });
  return [...graph.nodes]
    .sort((left, right) => {
      const degreeDelta = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
      if (degreeDelta) return degreeDelta;
      const confidenceDelta = (right.confidence ?? 0) - (left.confidence ?? 0);
      if (confidenceDelta) return confidenceDelta;
      return left.label.localeCompare(right.label, 'zh-Hans-CN');
    })[0]?.id ?? null;
}

export function collectMaterialNeighborhood(graph: MaterialGraph | null, centerNodeId: string | null, depth: MaterialGraphDepth): Set<string> {
  const ids = new Set<string>();
  if (!graph?.nodes.length) return ids;
  if (depth === 'all') {
    graph.nodes.forEach((node) => ids.add(node.id));
    return ids;
  }
  if (!centerNodeId) return ids;
  ids.add(centerNodeId);
  const adjacency = buildAdjacency(graph);
  const direct = adjacency.get(centerNodeId) ?? new Set<string>();
  direct.forEach((id) => ids.add(id));
  if (depth === 'two') {
    direct.forEach((id) => (adjacency.get(id) ?? new Set<string>()).forEach((next) => ids.add(next)));
  }
  return ids;
}

export function buildFocusedMaterialFlow(input: {
  graph: MaterialGraph | null;
  centerNodeId: string | null;
  selectedEdgeId: string | null;
  depth: MaterialGraphDepth;
  searchQuery: string;
  onSelectNodeLabel?: never;
}): { nodes: Node<GraphNodeData>[]; edges: Edge<MaterialRelationEdgeData>[] } {
  const { graph, selectedEdgeId, depth, searchQuery } = input;
  if (!graph) return { nodes: [], edges: [] };
  const centerNodeId = input.centerNodeId ?? chooseDefaultMaterialCenter(graph);
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedEndpointIds = new Set(selectedEdge ? [selectedEdge.source, selectedEdge.target] : []);
  const neighborhood = collectMaterialNeighborhood(graph, centerNodeId, depth);
  const direct = collectMaterialNeighborhood(graph, centerNodeId, 'one');
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const sortedNodes = [...graph.nodes].sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'));
  const sortedEdges = [...graph.edges].sort((left, right) => left.id.localeCompare(right.id));
  const degree = new Map<string, number>();
  sortedNodes.forEach((node) => degree.set(node.id, 0));
  sortedEdges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });

  const nodeMatchesSearch = (node: MaterialGraph['nodes'][number]) =>
    Boolean(normalizedQuery && `${node.label} ${node.summary}`.toLowerCase().includes(normalizedQuery));
  const flowNodes =
    depth === 'all'
      ? sortedNodes
      : sortedNodes.filter((node) => neighborhood.has(node.id) || selectedEndpointIds.has(node.id) || nodeMatchesSearch(node));

  const flowNodeIds = new Set(flowNodes.map((node) => node.id));

  const layoutNodes: LayoutNode[] = flowNodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(flowNodes.length, 1);
    const isSelected = node.id === centerNodeId || selectedEndpointIds.has(node.id);
    const searchMatch = nodeMatchesSearch(node);
    return {
      id: node.id,
      degree: degree.get(node.id) ?? 0,
      direct: direct.has(node.id),
      neighborhood: neighborhood.has(node.id),
      searchMatch,
      selected: isSelected,
      x: centerPoint.x + Math.cos(angle) * (node.id === centerNodeId ? 0 : 280),
      y: centerPoint.y + Math.sin(angle) * (node.id === centerNodeId ? 0 : 220),
      fx: node.id === centerNodeId ? centerPoint.x : undefined,
      fy: node.id === centerNodeId ? centerPoint.y : undefined,
    };
  });

  const visibleLinks = sortedEdges
    .filter((edge) => flowNodeIds.has(edge.source) && flowNodeIds.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, strength: direct.has(edge.source) || direct.has(edge.target) ? 0.56 : 0.14 }));

  forceSimulation(layoutNodes)
    .force(
      'link',
      forceLink<LayoutNode, { source: string; target: string; strength: number }>(visibleLinks)
        .id((node) => node.id)
        .distance((link) => (link.strength > 0.3 ? 170 : 260))
        .strength((link) => link.strength),
    )
    .force('charge', forceManyBody<LayoutNode>().strength((node) => (node.direct ? -360 : -120)))
    .force(
      'collide',
      forceCollide<LayoutNode>()
        .radius((node) => getMaterialNodeRadius({ muted: false, selected: node.selected, directNeighbor: node.direct, searchMatch: node.searchMatch, degree: node.degree }) + 34)
        .strength(0.88),
    )
    .force('center', forceCenter(centerPoint.x, centerPoint.y).strength(0.08))
    .force('x', forceX<LayoutNode>(centerPoint.x).strength((node) => (node.direct ? 0.07 : 0.025)))
    .force('y', forceY<LayoutNode>(centerPoint.y).strength((node) => (node.direct ? 0.07 : 0.025)))
    .stop()
    .tick(150);

  const layoutById = new Map(layoutNodes.map((node) => [node.id, node]));
  const nodes = flowNodes.map((node) => {
    const layout = layoutById.get(node.id);
    const selected = node.id === centerNodeId || selectedEndpointIds.has(node.id);
    const directNeighbor = direct.has(node.id);
    const muted = depth !== 'all' && !neighborhood.has(node.id) && !layout?.searchMatch;
    const tone = getMaterialNodeTone(node.type, node.degraded);
    const nodeRadius = getMaterialNodeRadius({
      muted,
      selected,
      directNeighbor,
      searchMatch: Boolean(layout?.searchMatch),
      degree: degree.get(node.id) ?? 0,
    });
    const nodeDiameter = nodeRadius * 2;
    const shortLabel = shortenMaterialNodeLabel(node.label, selected ? 18 : directNeighbor ? 12 : 8);
    const backgroundPoint = (
      <div className="grid size-2 place-items-center rounded-full bg-current">
        <span className="sr-only">{node.label}</span>
      </div>
    );

    return {
      id: node.id,
      position: {
        x: Math.round((layout?.x ?? centerPoint.x) - nodeRadius),
        y: Math.round((layout?.y ?? centerPoint.y) - nodeRadius),
      },
      data: {
        label: muted ? backgroundPoint : (
          <div className={cn('a3-material-node-core relative grid h-full w-full place-items-center overflow-hidden rounded-full text-center', selected && 'font-semibold')}>
            {selected && (
              <span
                aria-hidden="true"
                className="a3-material-node-halo pointer-events-none absolute inset-0 rounded-full"
                style={{ boxShadow: `0 0 0 7px ${tone.halo}, 0 18px 42px ${tone.shadow}` }}
              />
            )}
            <span
              aria-hidden="true"
              className="a3-material-node-sheen pointer-events-none absolute rounded-full"
              style={{
                left: selected ? '17%' : '20%',
                top: selected ? '12%' : '15%',
                width: selected ? '42%' : '38%',
                height: selected ? '30%' : '28%',
                background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.05))',
                filter: 'blur(0.2px)',
              }}
            />
            <div className="relative z-10 flex max-w-[82%] flex-col items-center justify-center gap-0.5">
              <span className={cn('line-clamp-2 break-words text-center', selected ? 'text-[12px] leading-4' : 'text-[10px] leading-3')}>
                {shortLabel}
              </span>
              {selected && <span className="max-w-full truncate text-[10px] font-medium opacity-75">{materialTypeLabel[node.type] ?? node.type}</span>}
              {selected && <span className="text-[10px] font-semibold opacity-80">{Math.round((node.confidence ?? 0) * 100)}%</span>}
            </div>
          </div>
        ),
      },
      selected,
      style: {
        width: nodeDiameter,
        height: nodeDiameter,
        borderRadius: 999,
        border: selected ? `3px solid ${tone.selected}` : layout?.searchMatch ? '2px solid #0f766e' : `1px solid ${tone.border}`,
        background: muted ? tone.selected : `radial-gradient(circle at 34% 28%, ${tone.highlight} 0%, ${tone.surface} 58%, ${tone.soft} 100%)`,
        color: tone.text,
        opacity: muted ? 0.08 : directNeighbor || selected || layout?.searchMatch ? 1 : 0.55,
        padding: 0,
        fontSize: selected ? 12 : 11,
        boxShadow: selected
          ? `inset 0 1px 1px rgba(255, 255, 255, 0.72), inset 0 -10px 18px rgba(15, 23, 42, 0.06), 0 18px 40px ${tone.shadow}`
          : directNeighbor
            ? 'inset 0 1px 1px rgba(255, 255, 255, 0.72), inset 0 -7px 12px rgba(15, 23, 42, 0.045), 0 10px 24px rgba(15, 23, 42, 0.10)'
            : 'inset 0 1px 1px rgba(255, 255, 255, 0.72), inset 0 -5px 9px rgba(15, 23, 42, 0.035), 0 6px 14px rgba(15, 23, 42, 0.06)',
        filter: selected ? 'saturate(1.08) contrast(1.02)' : directNeighbor || layout?.searchMatch ? 'saturate(1.02)' : 'saturate(0.9)',
        transition: 'opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), filter 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    } satisfies Node<GraphNodeData>;
  });

  const edges = sortedEdges.filter((edge) => flowNodeIds.has(edge.source) && flowNodeIds.has(edge.target)).map((edge) => {
    const endpointFocused = direct.has(edge.source) && direct.has(edge.target);
    const selected = selectedEdgeId === edge.id;
    const muted = !selected && !endpointFocused && depth !== 'all';
    const color = materialRelationColor(edge.type);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'materialRelation',
      animated: selected,
      data: {
        label: edge.label || edge.type,
        relationType: edge.type,
        selected,
        muted,
        color,
        showLabel: selected || endpointFocused,
      },
      markerEnd: { type: 'arrowclosed', color },
      style: { stroke: color, strokeWidth: selected ? 3 : endpointFocused ? 2 : 1.2, opacity: muted ? 0.04 : selected ? 1 : 0.72 },
    } satisfies Edge<MaterialRelationEdgeData>;
  });

  return { nodes, edges };
}

function buildAdjacency(graph: MaterialGraph) {
  const adjacency = new Map<string, Set<string>>();
  graph.nodes.forEach((node) => adjacency.set(node.id, new Set<string>()));
  graph.edges.forEach((edge) => {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  });
  return adjacency;
}

function getMaterialNodeRadius(input: NodeRadiusInput) {
  if (input.muted) return 8;
  const degreeBoost = Math.min(10, Math.max(0, input.degree) * 1.2);
  if (input.selected) return Math.round(42 + degreeBoost);
  if (input.searchMatch) return 34;
  if (input.directNeighbor) return Math.round(28 + Math.min(6, degreeBoost));
  return Math.round(18 + Math.min(4, degreeBoost));
}

function getMaterialNodeTone(type: string, degraded: boolean) {
  if (degraded) {
    return {
      surface: '#fffbeb',
      soft: '#fef3c7',
      highlight: '#fff7cc',
      border: '#f59e0b',
      selected: '#d97706',
      text: '#92400e',
      halo: 'rgba(245, 158, 11, 0.18)',
      shadow: 'rgba(217, 119, 6, 0.20)',
    };
  }
  if (type === 'method') {
    return {
      surface: '#eef6ff',
      soft: '#dbeafe',
      highlight: '#f8fbff',
      border: '#60a5fa',
      selected: '#2563eb',
      text: '#1d4ed8',
      halo: 'rgba(37, 99, 235, 0.16)',
      shadow: 'rgba(37, 99, 235, 0.18)',
    };
  }
  if (type === 'formula') {
    return {
      surface: '#eefbf3',
      soft: '#dcfce7',
      highlight: '#f8fff9',
      border: '#4ade80',
      selected: '#16a34a',
      text: '#15803d',
      halo: 'rgba(22, 163, 74, 0.16)',
      shadow: 'rgba(22, 163, 74, 0.18)',
    };
  }
  if (type === 'visual') {
    return {
      surface: '#f5f0ff',
      soft: '#ede9fe',
      highlight: '#fbfaff',
      border: '#a78bfa',
      selected: '#7c3aed',
      text: '#6d28d9',
      halo: 'rgba(124, 58, 237, 0.15)',
      shadow: 'rgba(124, 58, 237, 0.16)',
    };
  }
  if (type === 'metric') {
    return {
      surface: '#fff7ed',
      soft: '#ffedd5',
      highlight: '#fffaf3',
      border: '#fb923c',
      selected: '#ea580c',
      text: '#9a3412',
      halo: 'rgba(234, 88, 12, 0.15)',
      shadow: 'rgba(234, 88, 12, 0.16)',
    };
  }
  if (type === 'system') {
    return {
      surface: '#ecfeff',
      soft: '#cffafe',
      highlight: '#f7feff',
      border: '#22d3ee',
      selected: '#0891b2',
      text: '#0e7490',
      halo: 'rgba(8, 145, 178, 0.15)',
      shadow: 'rgba(8, 145, 178, 0.16)',
    };
  }
  return {
    surface: '#f8fafc',
    soft: '#e2e8f0',
    highlight: '#fbfdff',
    border: '#cbd5e1',
    selected: '#334155',
    text: '#334155',
    halo: 'rgba(51, 65, 85, 0.12)',
    shadow: 'rgba(51, 65, 85, 0.14)',
  };
}

function shortenMaterialNodeLabel(label: string, maxLength: number) {
  const normalized = label.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(2, maxLength - 1))}…`;
}

function materialRelationColor(type: string) {
  if (type.includes('prerequisite') || type.includes('depends') || type.includes('前置') || type.includes('依赖')) return '#2563eb';
  if (type.includes('part') || type.includes('contains') || type.includes('包含') || type.includes('组成')) return '#0891b2';
  if (type.includes('influence') || type.includes('cause') || type.includes('影响') || type.includes('因果')) return '#dc2626';
  if (type.includes('used') || type.includes('method') || type.includes('使用') || type.includes('方法')) return '#16a34a';
  if (type.includes('formula') || type.includes('derived') || type.includes('公式') || type.includes('推导')) return '#ea580c';
  return '#64748b';
}
