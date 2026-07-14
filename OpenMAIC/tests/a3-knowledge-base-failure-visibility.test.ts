import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-base-view.tsx');

describe('A3 knowledge-base failure visibility', () => {
  it('shows per-resource parser errors and marks partially failed jobs', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('data-testid="a3-kb-resource-error"');
    expect(source).toContain('function jobDisplayStatus');
    expect(source).toContain('<StatusPill status={jobDisplayStatus(job)} />');
    expect(source).toContain("partial_failure: { label: '部分失败', tone: 'orange' }");
  });

  it('clears a transient load error after the backend responds successfully', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("const [loadError, setLoadError] = useState('')");
    expect(source).toContain("setLoadError(result.error ?? '资料读取失败')");
    expect(source).toContain("setLoadError('')");
    expect(source).toContain('data-testid="a3-kb-load-error"');
  });
});
