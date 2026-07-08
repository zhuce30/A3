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
    expect(source).toContain("result.contentFormat === 'markdown'");
    expect(source).toContain('result.markdownSnippet || result.text');
  });
});
