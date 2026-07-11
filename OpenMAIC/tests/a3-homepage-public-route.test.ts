import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeA3ReturnPath } from '@/lib/a3/auth-navigation';

const root = process.cwd();
const gateSource = fs.readFileSync(
  path.join(root, 'components/a3/auth/a3-auth-gate.tsx'),
  'utf8',
);
const shellSource = fs.readFileSync(
  path.join(root, 'components/a3/layout/a3-shell.tsx'),
  'utf8',
);

describe('A3 product homepage route boundary', () => {
  it('keeps /a3 public without treating it as an auth-only guest page', () => {
    expect(gateSource).toContain("const publicPaths = new Set(['/a3'])");
    expect(gateSource).toContain('if (isPublicPath)');
    expect(gateSource).toContain('value={user ?? null}');
  });

  it('checks the public route before the auth loading state', () => {
    expect(gateSource.indexOf('if (isPublicPath)')).toBeLessThan(
      gateSource.indexOf('if (user === undefined || target)'),
    );
  });

  it('bypasses the learning workspace shell on the public homepage', () => {
    expect(shellSource).toContain('A3_SHELL_BYPASS_PATHS.has(pathname)');
  });

  it('accepts internal A3 return paths and preserves query and hash', () => {
    expect(normalizeA3ReturnPath('/a3/coaching')).toBe('/a3/coaching');
    expect(normalizeA3ReturnPath('/a3/classroom?source=home')).toBe(
      '/a3/classroom?source=home',
    );
    expect(normalizeA3ReturnPath('/a3/classroom?source=home#citations')).toBe(
      '/a3/classroom?source=home#citations',
    );
  });

  it.each([
    undefined,
    null,
    '',
    '/a3',
    '/a3?source=home',
    '/a3/login',
    '/a3/login?next=/a3/coaching',
    '/a3/register',
    '/a3/forgot-password',
    '//evil.example/a3',
    'https://evil.example',
    '/admin',
    '/a3/../admin',
  ])('rejects unsafe or non-return path %s', (value) => {
    expect(normalizeA3ReturnPath(value)).toBeNull();
  });
});
