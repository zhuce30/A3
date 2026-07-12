import type { ReactNode } from 'react';

export type MaterialEvidence = {
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

export type MaterialNode = {
  id: string;
  label: string;
  type: string;
  summary: string;
  confidence: number;
  evidence: MaterialEvidence[];
  degraded: boolean;
  schemaVersion: string;
  definition?: string;
  keyPoints?: string[];
  attributes?: Array<{ label: string; value: string }>;
  extractionMethod?: string;
};

export type MaterialEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  weight: number;
  evidence: MaterialEvidence[];
  degraded: boolean;
};

export type MaterialClaim = {
  id: string;
  text: string;
  entityIds: string[];
  verified: boolean;
  evidence: MaterialEvidence[];
  degraded: boolean;
};

export type MaterialGraphQuality = {
  isolatedEntityRate?: number;
  evidenceCoverage?: number;
  aliasMergeCount?: number;
  relationDensity?: number;
  gleaningRounds?: number;
  processedBatchCount?: number;
  successfulBatchCount?: number;
  failedBatchCount?: number;
};

export type MaterialGraphFocus = {
  centerId: string | null;
  depth: 'center' | 'one' | 'two' | 'all' | string;
  limit: number;
  returnedNodeCount: number;
  returnedEdgeCount: number;
  hasMore: boolean;
  partial: boolean;
};

export type MaterialGraph = {
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
  focus?: MaterialGraphFocus;
  build: {
    status: string;
    lastBuiltAt: string | null;
    degraded: boolean;
    reason: string;
  };
  quality?: MaterialGraphQuality;
  nextAction?: { label: string; href: string } | null;
};

export type GraphNodeData = {
  label: ReactNode;
};

export type MaterialRelationEdgeData = {
  label: string;
  relationType: string;
  selected: boolean;
  muted: boolean;
  color: string;
  showLabel: boolean;
};

export const materialTypeLabel: Record<string, string> = {
  concept: '概念',
  method: '方法',
  formula: '公式',
  visual: '图表',
  metric: '指标',
  system: '系统',
};

export function materialEvidenceKey(item: MaterialEvidence, index: number) {
  return [item.resourceId, item.blockId, item.location, item.blockType, item.snippet.slice(0, 80), index].join('::');
}

export function formatMaterialMarkdown(value: string) {
  return value.trim();
}
