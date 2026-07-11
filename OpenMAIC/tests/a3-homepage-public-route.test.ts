import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import {
  A3_FLOW_PATHS,
  A3_GUEST_PATHS,
  A3_PUBLIC_PATHS,
  A3_SHELL_BYPASS_PATHS,
  getA3AuthTarget,
  normalizeA3ReturnPath,
} from '@/lib/a3/auth-navigation';

const root = process.cwd();
const gateSource = fs.readFileSync(
  path.join(root, 'components/a3/auth/a3-auth-gate.tsx'),
  'utf8',
);
const shellSource = fs.readFileSync(
  path.join(root, 'components/a3/layout/a3-shell.tsx'),
  'utf8',
);

const onboardingUser: A3PublicUser = {
  id: 'student-1',
  role: 'student',
  displayName: '测试学生',
  phoneBound: false,
  privacyAccepted: false,
  profileCompleted: false,
  onboardingStep: 'phone',
  createdAt: '2026-07-11T00:00:00Z',
  updatedAt: '2026-07-11T00:00:00Z',
};

describe('A3 product homepage route boundary', () => {
  it('keeps /a3 public without treating it as an auth-only guest page', () => {
    expect(A3_PUBLIC_PATHS).toEqual(new Set(['/a3']));
    expect(gateSource).toContain('if (isPublicPath)');
    expect(gateSource).toContain('value={user ?? null}');
  });

  it('defines the exact guest and onboarding flow route boundaries', () => {
    expect(A3_GUEST_PATHS).toEqual(
      new Set(['/a3/login', '/a3/register', '/a3/forgot-password']),
    );
    expect(A3_FLOW_PATHS).toEqual(
      new Set([
        '/a3/role-selection',
        '/a3/phone-binding',
        '/a3/welcome',
        '/a3/privacy',
        '/a3/profile-setup',
      ]),
    );
  });

  it('exempts the public homepage before authentication and onboarding redirects', () => {
    expect(getA3AuthTarget('/a3', undefined)).toBeNull();
    expect(getA3AuthTarget('/a3', null)).toBeNull();
    expect(getA3AuthTarget('/a3', onboardingUser)).toBeNull();
    expect(gateSource.indexOf('if (isPublicPath)')).toBeLessThan(
      gateSource.indexOf('if (user === undefined || target)'),
    );
  });

  it('sends anonymous protected routes to login with a safe next path', () => {
    expect(getA3AuthTarget('/a3/coaching', null)).toBe(
      '/a3/login?next=%2Fa3%2Fcoaching',
    );
    expect(getA3AuthTarget('/a3/login', null)).toBeNull();
  });

  it('bypasses the learning workspace shell on the public homepage', () => {
    expect(A3_SHELL_BYPASS_PATHS).toEqual(
      new Set([...A3_PUBLIC_PATHS, ...A3_GUEST_PATHS, ...A3_FLOW_PATHS]),
    );
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
