import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const catalogPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx');

describe('algorithm lab UI', () => {
  it('has catalog loading, error, empty, progress and resume states', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('正在读取实验进度');
    expect(source).toContain('重新加载');
    expect(source).toContain('暂无可用实验');
    expect(source).toContain('继续上次实验');
    expect(source).toContain('verifiedRuns');
  });

  it('recovers and clears local unfinished sessions without persisting steps', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('loadLabSession');
    expect(source).toContain('clearLabSession');
    expect(source).toContain('清除记录');
    expect(source).not.toContain('session.steps');
  });

  it('orders recommended labs first and renders repeated lab items with one clear action', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('recommended');
    expect(source).toContain('sortedLabs.map');
    expect(source).toContain('data-testid="a3-algorithm-lab-item"');
    expect(source).toContain('data-testid="a3-algorithm-lab-action"');
  });
});
