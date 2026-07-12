import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph-view.tsx');
const typePath = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph/material-types.ts');
const detailPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph/material-detail-panel.tsx');
const mojibakePattern = /[锟閿閸鐠娑闂鈫]/;

describe('A3 material knowledge graph view', () => {
  it('loads uploaded-material graph by default and keeps course graph secondary', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("useState<GraphTab>('material')");
    expect(source).toContain('/api/kb/graph/?');
    expect(source).toContain("'/api/learning/graph/'");
    expect(source.indexOf('/api/kb/graph/?')).toBeLessThan(source.indexOf("'/api/learning/graph/'"));
    expect(source).toContain('资料图谱');
    expect(source).toContain('课程路径图');
    expect(source).not.toMatch(mojibakePattern);
  });

  it('keeps empty state tied to the real knowledge-base upload page', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('/a3/knowledge-base');
    expect(source).toContain('还没有生成资料知识图谱');
    expect(source).toContain('多模态解析');
    expect(source).not.toMatch(mojibakePattern);
  });

  it('renders PPT slide and degraded evidence from backend material graph contract', () => {
    const types = fs.readFileSync(typePath, 'utf8');
    const detail = fs.readFileSync(detailPath, 'utf8');

    expect(types).toContain('slideIndex');
    expect(types).toContain('blockType');
    expect(detail).toContain('降级证据');
    expect(types).toContain("source: 'knowledge_base_materials'");
    expect(types).not.toMatch(mojibakePattern);
    expect(detail).not.toMatch(mojibakePattern);
  });

  it('uses a duplicate-safe key for material evidence from the same PPT block', () => {
    const types = fs.readFileSync(typePath, 'utf8');
    const detail = fs.readFileSync(detailPath, 'utf8');

    expect(types).toContain('function materialEvidenceKey(item: MaterialEvidence, index: number)');
    expect(types).toContain('item.snippet.slice(0, 80)');
    expect(detail).toContain('evidence.map((item, index)');
    expect(detail).not.toContain('key={`${item.resourceId}-${item.blockId}-${item.location}`}');
  });

  it('prefers backend-normalized markdown snippets for material evidence', () => {
    const types = fs.readFileSync(typePath, 'utf8');
    const detail = fs.readFileSync(detailPath, 'utf8');

    expect(types).toContain('markdownSnippet?: string');
    expect(types).toContain('contentFormat?:');
    expect(types).toContain('formatFeatures?: string[]');
    expect(detail).toContain('item.markdownSnippet || item.snippet');
  });

  it('renders material summaries, claims and evidence snippets through A3Markdown', () => {
    const source = fs.readFileSync(detailPath, 'utf8');

    expect(source).toContain("import { A3Markdown } from '../../ui/a3-markdown';");
    expect(source).toContain('formatMaterialMarkdown(props.node.definition || props.node.summary');
    expect(source).toContain('formatMaterialMarkdown(claim.text)');
    expect(source).toContain('formatMaterialMarkdown(item.markdownSnippet || item.snippet)');
  });
});
