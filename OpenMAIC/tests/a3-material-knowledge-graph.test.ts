import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-graph-view.tsx');

describe('A3 material knowledge graph view', () => {
  it('loads uploaded-material graph by default and keeps course graph secondary', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("useState<GraphTab>('material')");
    expect(source).toContain("'/api/kb/graph/'");
    expect(source).toContain("'/api/learning/graph/'");
    expect(source.indexOf("'/api/kb/graph/'")).toBeLessThan(source.indexOf("'/api/learning/graph/'"));
    expect(source).toContain("资料图谱");
    expect(source).toContain("课程路径图");
  });

  it('keeps empty state tied to the real knowledge-base upload page', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('/a3/knowledge-base');
    expect(source).toContain('还没有生成资料知识图谱');
    expect(source).toContain('多模态解析');
  });

  it('renders PPT slide and degraded evidence from backend material graph contract', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('slideIndex');
    expect(source).toContain('blockType');
    expect(source).toContain('降级证据');
    expect(source).toContain("source: 'knowledge_base_materials'");
  });
  it('uses a duplicate-safe key for material evidence from the same PPT block', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('function materialEvidenceKey(item: MaterialEvidence, index: number)');
    expect(source).toContain('item.snippet.slice(0, 80)');
    expect(source).toContain('evidence.map((item, index)');
    expect(source).not.toContain('key={`${item.resourceId}-${item.blockId}-${item.location}`}');
  });

  it('prefers backend-normalized markdown snippets for material evidence', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('markdownSnippet?: string');
    expect(source).toContain('contentFormat?:');
    expect(source).toContain('formatFeatures?: string[]');
    expect(source).toContain('item.markdownSnippet || item.snippet');
  });

  it('renders material summaries, claims and evidence snippets through A3Markdown', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("import { A3Markdown } from '../ui/a3-markdown';");
    expect(source).toContain('formatMaterialMarkdown(node.summary');
    expect(source).toContain('formatMaterialMarkdown(claim.text)');
    expect(source).toContain('formatMaterialMarkdown(item.markdownSnippet || item.snippet)');
  });
});
