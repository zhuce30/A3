import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const featureDir = path.join(root, 'components/a3/features/knowledge-graph');
const viewPath = path.join(root, 'components/a3/features/knowledge-graph-view.tsx');

describe('A3 knowledge graph evidence workbench', () => {
  it('preserves the real APIs and incremental material neighborhood loading', () => {
    const view = fs.readFileSync(viewPath, 'utf8');

    expect(fs.existsSync(path.join(featureDir, 'material-focused-flow.tsx'))).toBe(true);
    expect(view).toContain('/api/kb/graph/?');
    expect(view).toContain("'/api/learning/graph/'");
    expect(view).toContain("'/api/learning/paths/generate/'");
    expect(view).toContain("params.set('centerId', centerId)");
    expect(view).toContain('mergeMaterialGraphs');
    expect(view).not.toContain('mockMaterialGraph');
  });

  it('moves graph quality into the explicit data-status popover', () => {
    const toolbar = fs.readFileSync(path.join(featureDir, 'knowledge-graph-toolbar.tsx'), 'utf8');
    const panels = fs.readFileSync(path.join(featureDir, 'material-graph-panels.tsx'), 'utf8');

    expect(toolbar).toContain('GraphDataStatusPopover');
    expect(toolbar).toContain('数据状态');
    expect(panels).toContain('export function MaterialGraphDataStatus');
  });

  it('labels material search as current-view search and exposes accessible tabs', () => {
    const toolbar = fs.readFileSync(path.join(featureDir, 'knowledge-graph-toolbar.tsx'), 'utf8');

    expect(toolbar).toContain('搜索当前视图中的实体');
    expect(toolbar).toContain('当前视图没有匹配实体');
    expect(toolbar).toContain('role="tablist"');
    expect(toolbar).toContain('aria-selected');
    expect(toolbar).toContain('a3-material-graph-depth-one');
    expect(toolbar).toContain('a3-material-graph-depth-two');
    expect(toolbar).toContain('a3-material-graph-depth-all');
  });

  it('keeps canvas and detail in one bounded workspace', () => {
    const workspace = fs.readFileSync(path.join(featureDir, 'knowledge-graph-workspace.tsx'), 'utf8');

    expect(workspace).toContain('data-testid="a3-knowledge-graph-workspace"');
    expect(workspace).toContain("xl:grid-cols-[minmax(0,1fr)_380px]");
    expect(workspace).toContain('overflow-y-auto');
    expect(workspace).toContain('aria-label="关闭详情"');
    expect(workspace).toContain('min-h-[560px]');
    expect(workspace).toContain('grid-rows-[minmax(0,1fr)]');
  });

  it('reports loaded scope instead of full graph quality in the status bar', () => {
    const status = fs.readFileSync(path.join(featureDir, 'knowledge-graph-status-bar.tsx'), 'utf8');

    expect(status).toContain('当前加载');
    expect(status).toContain('当前为局部视图');
    expect(status).toContain('部分内容为降级抽取');
    expect(status).not.toContain('关系密度');
  });

  it('controls contextual detail separately from graph selection', () => {
    const view = fs.readFileSync(viewPath, 'utf8');

    expect(view).toContain('const [detailOpen, setDetailOpen] = useState(true)');
    expect(view).toContain('setDetailOpen(true)');
    expect(view).toContain('onCloseDetail={() => setDetailOpen(false)}');
    expect(view).toContain('searchMatches={materialSearchMatches}');
    expect(view).toContain('<section ref={graphRef}');
    expect(view).not.toContain('<A3Card');
  });

  it('composes the workbench and removes controls that covered graph nodes', () => {
    const view = fs.readFileSync(viewPath, 'utf8');
    const panels = fs.readFileSync(path.join(featureDir, 'material-graph-panels.tsx'), 'utf8');

    expect(view).toContain('<KnowledgeGraphToolbar');
    expect(view).toContain('<KnowledgeGraphWorkspace');
    expect(view).toContain('<KnowledgeGraphStatusBar');
    expect(view).not.toContain('absolute left-4 top-4');
    expect(view).not.toContain('absolute right-4 top-4');
    expect(view).not.toContain('MaterialGraphMiniPanel');
    expect(view).not.toContain('<A3Card title="构建状态">');
    expect(view).not.toContain('h-[680px]');
    expect(panels).not.toContain('export function MaterialGraphSearchPanel');
    expect(panels).not.toContain('export function MaterialGraphMiniPanel');
    expect(panels).not.toContain('export function MaterialGraphStatsPanel');
  });
});
