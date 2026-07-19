import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const dashboard = readFileSync(join(root, 'components/a3/features/dashboard-view.tsx'), 'utf8');
const card = readFileSync(join(root, 'components/a3/ui/a3-card.tsx'), 'utf8');

describe('A3 dashboard action-first responsive layout', () => {
  it('puts todays actions before supporting dashboard content', () => {
    expect(dashboard).toContain('data-testid="a3-dashboard-action-zone"');
    expect(dashboard).toContain('data-testid="a3-dashboard-momentum-rail"');
    expect(dashboard).toContain('data-testid="a3-dashboard-path-profile-zone"');
  });

  it('uses zero-minimum grid tracks and cards', () => {
    expect(dashboard).toContain('xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]');
    expect(dashboard).not.toContain('xl:grid-cols-[1fr_1.05fr_1.35fr]');
    expect(card).toContain("'min-w-0 rounded-[14px]");
  });

  it('wraps real long task copy without expanding the page', () => {
    expect(dashboard).toContain('line-clamp-2 break-words');
    expect(dashboard).toContain('min-w-0 flex-1');
  });
});
