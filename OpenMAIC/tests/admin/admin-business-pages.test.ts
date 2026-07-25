import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('admin business page source contracts', () => {
  it('keeps conversation content behind an audited reveal', () => {
    const source = read('components/a3/features/admin/admin-conversations-view.tsx');
    expect(source).toContain('getA3AdminConversations');
    expect(source).toContain('getA3AdminConversation');
    expect(source).toContain('revealA3AdminConversation');
    expect(source).toContain('AdminReasonDialog');
    expect(source).toContain('AdminDetailDrawer');
    expect(source).toContain('AdminPagination');
    expect(source).toContain('AdminAccessGuard');
  });

  it('uses controlled catalog actions instead of deleting data', () => {
    const source = read('components/a3/features/admin/admin-catalog-view.tsx');
    expect(source).toContain('getA3AdminCatalogCourses');
    expect(source).toContain('getA3AdminCatalogResources');
    expect(source).toContain('updateA3AdminCatalogCourseStatus');
    expect(source).toContain('updateA3AdminCatalogResourceStatus');
    expect(source).toContain('reindexA3AdminCatalogResource');
    expect(source).toContain('AdminReasonDialog');
    expect(source).not.toMatch(/deleteA3Admin/i);
  });

  it('respects task retry and cancellation eligibility', () => {
    const source = read('components/a3/features/admin/admin-tasks-view.tsx');
    expect(source).toContain('getA3AdminTasks');
    expect(source).toContain('getA3AdminTask');
    expect(source).toContain('retryA3AdminTask');
    expect(source).toContain('cancelA3AdminTask');
    expect(source).toContain('eligibility.retry');
    expect(source).toContain('eligibility.cancel');
    expect(source).toContain('AdminReasonDialog');
  });

  it('renders real agent steps, spans, and redacted metadata', () => {
    const source = read('components/a3/features/admin/admin-agents-view.tsx');
    expect(source).toContain('getA3AdminAgentRuns');
    expect(source).toContain('getA3AdminAgentRun');
    expect(source).toContain('run.steps');
    expect(source).toContain('run.spans');
    expect(source).toContain('metadata');
    expect(source).toContain('AdminDetailDrawer');
  });

  it.each(['conversations', 'catalog', 'tasks', 'agents'])('exposes the %s route', (route) => {
    expect(read(`app/a3/admin/${route}/page.tsx`)).toContain('Admin');
  });
});
