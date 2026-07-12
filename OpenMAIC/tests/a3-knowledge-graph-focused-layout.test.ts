import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const featureDir = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph');
const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph-view.tsx');

const mojibakePattern = /[锟閿閸鐠娑闂鈫]/;

describe('A3 knowledge graph focused layout', () => {
  it('splits the material graph into focused flow, floating panels, and structured detail', () => {
    expect(fs.existsSync(path.join(featureDir, 'material-focused-flow.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'material-relation-edge.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'material-graph-panels.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'material-detail-panel.tsx'))).toBe(true);
  });

  it('keeps the real material graph API contract and exposes focused graph test ids', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('/api/kb/graph/?');
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

  it('keeps the material graph readable with path evidence and muted background points', () => {
    const viewSource = fs.readFileSync(viewPath, 'utf8');
    const flowSource = fs.readFileSync(path.join(featureDir, 'material-focused-flow.tsx'), 'utf8');
    const detailSource = fs.readFileSync(path.join(featureDir, 'material-detail-panel.tsx'), 'utf8');
    const panelSource = fs.readFileSync(path.join(featureDir, 'material-graph-panels.tsx'), 'utf8');

    expect(viewSource).toContain('onlyRenderVisibleElements');
    expect(flowSource).toContain('const backgroundPoint');
    expect(flowSource).toContain('const flowNodes');
    expect(flowSource).toContain('flowNodeIds.has(edge.source)');
    expect(flowSource).toContain('opacity: muted ? 0.08');
    expect(flowSource).toContain('opacity: muted ? 0.04');
    expect(detailSource).toContain('data-testid="a3-material-readable-path"');
    expect(detailSource).toContain("' -> '");
    expect(viewSource).not.toMatch(mojibakePattern);
    expect(panelSource).not.toMatch(mojibakePattern);
    expect(detailSource).not.toMatch(mojibakePattern);
  });

  it('renders material entities as circular semantic bubbles instead of rectangular cards', () => {
    const flowSource = fs.readFileSync(path.join(featureDir, 'material-focused-flow.tsx'), 'utf8');
    const typeSource = fs.readFileSync(path.join(featureDir, 'material-types.ts'), 'utf8');

    expect(flowSource).toContain('getMaterialNodeRadius');
    expect(flowSource).toContain('getMaterialNodeTone');
    expect(flowSource).toContain('const nodeRadius');
    expect(flowSource).toContain('const nodeDiameter = nodeRadius * 2');
    expect(flowSource).toContain('borderRadius: 999');
    expect(flowSource).toContain('width: nodeDiameter');
    expect(flowSource).toContain('height: nodeDiameter');
    expect(flowSource).toContain('a3-material-node-halo');
    expect(flowSource).not.toContain('minHeight: muted ? 16 : selected ? 104 : 88');
    expect(flowSource).not.toContain('width: muted ? 16 : selected ? 232 : 184');
    expect(typeSource).toContain("concept: '概念'");
    expect(typeSource).toContain("method: '方法'");
    expect(typeSource).toContain("formula: '公式'");
    expect(typeSource).toContain("visual: '图表'");
    expect(typeSource).toContain("metric: '指标'");
    expect(typeSource).toContain("system: '系统'");
    expect(typeSource).not.toMatch(mojibakePattern);
  });

  it('keeps relation labels selective and readable for dense circular graphs', () => {
    const flowSource = fs.readFileSync(path.join(featureDir, 'material-focused-flow.tsx'), 'utf8');
    const edgeSource = fs.readFileSync(path.join(featureDir, 'material-relation-edge.tsx'), 'utf8');
    const typeSource = fs.readFileSync(path.join(featureDir, 'material-types.ts'), 'utf8');

    expect(typeSource).toContain('showLabel: boolean');
    expect(flowSource).toContain('showLabel: selected || endpointFocused');
    expect(edgeSource).toContain('const showLabel = Boolean(edgeData.showLabel)');
    expect(edgeSource).toContain('if (!showLabel) return');
    expect(edgeSource).toContain("edgeData.label || edgeData.relationType || '关联'");
    expect(edgeSource).not.toMatch(mojibakePattern);
  });

  it('adds soft visual depth without turning the graph into rectangular cards again', () => {
    const viewSource = fs.readFileSync(viewPath, 'utf8');
    const flowSource = fs.readFileSync(path.join(featureDir, 'material-focused-flow.tsx'), 'utf8');
    const edgeSource = fs.readFileSync(path.join(featureDir, 'material-relation-edge.tsx'), 'utf8');

    expect(viewSource).toContain('a3-material-graph-canvas');
    expect(viewSource).toContain('radial-gradient(circle at 50% 44%');
    expect(flowSource).toContain('a3-material-node-core');
    expect(flowSource).toContain('a3-material-node-sheen');
    expect(flowSource).toContain('inset 0 1px 1px rgba(255, 255, 255, 0.72)');
    expect(flowSource).toContain('transition:');
    expect(flowSource).toContain('filter: selected ?');
    expect(edgeSource).toContain('drop-shadow');
    expect(edgeSource).toContain('transition:');
  });

  it('loads material graph neighborhoods on demand instead of fetching the full graph for every click', () => {
    const viewSource = fs.readFileSync(viewPath, 'utf8');
    const typeSource = fs.readFileSync(path.join(featureDir, 'material-types.ts'), 'utf8');

    expect(typeSource).toContain('focus?: MaterialGraphFocus');
    expect(viewSource).toContain('const MATERIAL_GRAPH_INITIAL_LIMIT');
    expect(viewSource).toContain('const MATERIAL_GRAPH_EXPAND_LIMIT');
    expect(viewSource).toContain('loadMaterialGraphNeighborhood');
    expect(viewSource).toContain("params.set('centerId', centerId)");
    expect(viewSource).toContain('mergeMaterialGraphs');
    expect(viewSource).toContain('onMaterialNodeClick');
    expect(viewSource).toContain('void loadMaterialGraphNeighborhood(nodeId');
    expect(viewSource).not.toContain("a3GetJson<A3ApiResponse<{ graph: MaterialGraph }>>('/api/kb/graph/');");
  });
});
