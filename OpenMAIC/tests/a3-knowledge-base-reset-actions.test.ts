import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-base-view.tsx');

describe('A3 knowledge base reset actions', () => {
  it('exposes safe rebuild and dangerous clear actions from the knowledge-base page', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('data-testid="a3-kb-reset-derived"');
    expect(source).toContain('data-testid="a3-kb-clear-all"');
    expect(source).toContain("'/api/kb/reset/'");
    expect(source).toContain("action: 'reset_derived'");
    expect(source).toContain("action: 'clear_all'");
    expect(source).toContain('清空知识库');
    expect(source).toContain('清理已构建数据');
  });
});
