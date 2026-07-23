import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.resolve(root, file), 'utf8');

describe('A3 admin operations contracts', () => {
  it('defines role-gated navigation and real admin endpoints', () => {
    const navigation = read('lib/a3/navigation.ts');
    const api = read('lib/a3/admin-api.ts');
    expect(navigation).toContain("roles: ['admin']");
    expect(navigation).toContain('/a3/admin/overview');
    expect(navigation).toContain('/a3/admin/users');
    expect(api).toContain('/api/admin/overview/');
    expect(api).toContain('/api/admin/users/');
  });

  it('sends bounded presence heartbeats only from the authenticated shell', () => {
    const shell = read('components/a3/layout/a3-shell.tsx');
    expect(shell).toContain('/api/auth/presence/heartbeat/');
    expect(shell).toContain('document.visibilityState');
    expect(shell).toContain('60_000');
  });
});
