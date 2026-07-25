import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('admin governance page source contracts', () => {
  it('reviews real security events with a reasoned transition', () => {
    const source = read('components/a3/features/admin/admin-safety-view.tsx');
    expect(source).toContain('getA3AdminSecurityEvents');
    expect(source).toContain('reviewA3AdminSecurityEvent');
    expect(source).toContain('AdminReasonDialog');
    expect(source).toContain('reviewStatus');
    expect(source).toContain('false_positive');
    expect(source).toContain('resolved');
    expect(source).toContain('AdminAccessGuard');
  });

  it('shows secret-free configuration evidence and explicit verification', () => {
    const source = read('components/a3/features/admin/admin-settings-view.tsx');
    expect(source).toContain('getA3AdminConfiguration');
    expect(source).toContain('verifyA3AdminConfiguration');
    expect(source).toContain('AdminReasonDialog');
    expect(source).toContain('已配置 · 未监控');
    expect(source).toContain('lastVerifiedAt');
    expect(source).not.toMatch(/apiKey|secretValue|passwordValue/);
  });

  it.each(['safety', 'settings'])('exposes the %s route', (route) => {
    expect(read(`app/a3/admin/${route}/page.tsx`)).toContain('Admin');
  });
});
