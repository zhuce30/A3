import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const today = readFileSync(join(root, 'components/a3/features/today-learning-view.tsx'), 'utf8');
const shell = readFileSync(join(root, 'components/a3/layout/a3-shell.tsx'), 'utf8');

describe('A3 today hub and desktop sidebar polish', () => {
  it('uses the shared adaptive warm highlight surface for the today hub', () => {
    expect(today).toContain('data-testid="a3-today-hub"');
    expect(today).toContain('bg-[var(--a3-highlight-bg)]');
    expect(today).toContain('text-[var(--a3-highlight-text)]');
    expect(today).not.toContain('border border-blue-100 bg-slate-950');
  });

  it('supports a persistent desktop icon sidebar without hiding navigation', () => {
    expect(shell).toContain("const A3_SIDEBAR_STORAGE_KEY = 'a3-sidebar-collapsed'");
    expect(shell).toContain('data-testid="a3-sidebar-toggle"');
    expect(shell).toContain('data-testid="a3-primary-sidebar"');
    expect(shell).toContain("sidebarCollapsed ? 'w-20' : 'w-[248px]'");
    expect(shell).toContain("sidebarCollapsed ? 'md:pl-20' : 'md:pl-[248px]'");
    expect(shell).toContain('data-testid={`a3-sidebar-collapsed-${item.href.replaceAll');
    expect(shell).toContain('window.localStorage.setItem(A3_SIDEBAR_STORAGE_KEY');
  });
});
