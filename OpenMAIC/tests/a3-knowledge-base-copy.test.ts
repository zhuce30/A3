import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-base-view.tsx');

describe('A3 knowledge base action copy', () => {
  it('distinguishes uploading new resources from reparsing existing resources', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('选择新资料');
    expect(source).toContain('上传新资料');
    expect(source).toContain('重新解析已有资料');
    expect(source).toContain('上传新资料会自动完成文本、图片、PDF/PPT 页面等多模态解析和索引');
    expect(source).toContain('重新解析已有资料不会新增文件');
    expect(source).not.toContain('强制重建多模态解析');
  });

  it('renders knowledge-base search markdown snippets through A3Markdown', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("import { A3Markdown } from '../ui/a3-markdown';");
    expect(source).toContain('markdownSnippet?: string');
    expect(source).toContain('contextSnippet?: string');
    expect(source).toContain("result.contentFormat === 'markdown'");
    expect(source).toContain('result.contextSnippet ||');
  });

  it('lets users expand and collapse the background jobs panel', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('jobsPanelExpanded');
    expect(source).toContain('setJobsPanelExpanded');
    expect(source).toContain('data-testid="a3-kb-jobs-panel-toggle"');
    expect(source).toContain('data-testid="a3-kb-jobs-panel-collapsed"');
    expect(source).toContain('data-testid="a3-kb-job-expanded"');
    expect(source).toContain('function JobProgressDetail');
  });

  it('shows a recovery notice when knowledge-base processing is interrupted', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('data-testid="a3-kb-interrupted-notice"');
    expect(source).toContain('function isInterruptedResource');
    expect(source).toContain('function isInterruptedJob');
    expect(source).toContain('function isUnresolvedInterruptedJob');
    expect(source).toContain('function isInterruptedText');
    expect(source).toContain('interruptedResources.length');
    expect(source).toContain("resource.status === 'failed' || resource.status === 'indexing'");
    expect(source).toContain('处理被中断，可重解析或删除。');
  });
});
