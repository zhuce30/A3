import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('admin core page source contracts', () => {
  it('keeps overview on the real range-aware admin API with safe refresh semantics', () => {
    const source = read('components/a3/features/admin/admin-overview-view.tsx');

    expect(source).toContain("getA3AdminOverview(range)");
    expect(source).toContain("'24h'");
    expect(source).toContain("'7d'");
    expect(source).toContain("'30d'");
    expect(source).toContain('document.visibilityState');
    expect(source).toContain('inFlight');
    expect(source).toContain('AdminDataStatusBadge');
    expect(source).toContain('AdminEmptyState');
    expect(source).toContain('AdminErrorState');
    expect(source).toContain('AdminSkeleton');
    expect(source).toContain('not_collected');
    expect(source).toContain('AdminAccessGuard');
  });

  it('keeps users on real filters and reasoned audit operations', () => {
    const source = read('components/a3/features/admin/admin-users-view.tsx');

    expect(source).toContain('getA3AdminUsers');
    expect(source).toContain('presence');
    expect(source).toContain('AdminReasonDialog');
    expect(source).toContain('AdminDetailDrawer');
    expect(source).toContain('revealA3AdminUserIp');
    expect(source).toContain('updateA3AdminUserStatus');
    expect(source).not.toContain('window.prompt');
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('AdminAccessGuard');
  });

  it('uses the real audit API and renders structured change detail', () => {
    const source = read('components/a3/features/admin/admin-audit-view.tsx');

    expect(source).toContain('getA3AdminAuditLogs');
    expect(source).toContain('before');
    expect(source).toContain('after');
    expect(source).toContain('metadata');
    expect(source).toContain('AdminDetailDrawer');
    expect(source).toContain('AdminAccessGuard');
    expect(source).toContain('AdminPagination');
    expect(source).toContain('success');
  });

  it('uses ECharts six SVG renderer with a stable lifecycle', () => {
    const source = read('components/a3/features/admin/admin-charts.tsx');

    expect(source).toContain("SVGRenderer");
    expect(source).toContain("renderer: 'svg'");
    expect(source).toContain('.resize()');
    expect(source).toContain('.dispose()');
    expect(source).toContain('aspect');
  });

  it('exposes the audit route as an admin guarded feature page', () => {
    const route = read('app/a3/admin/audit/page.tsx');
    expect(route).toContain('AdminAuditView');
  });
});
