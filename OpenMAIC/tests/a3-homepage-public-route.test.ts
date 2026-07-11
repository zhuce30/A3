import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { A3AuthGate } from '@/components/a3/auth/a3-auth-gate';
import { A3Shell } from '@/components/a3/layout/a3-shell';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import {
  A3_FLOW_PATHS,
  A3_GUEST_PATHS,
  A3_PUBLIC_PATHS,
  A3_SHELL_BYPASS_PATHS,
  buildA3CurrentPath,
  getA3AuthTarget,
  getInitialA3Hash,
  normalizeA3ReturnPath,
} from '@/lib/a3/auth-navigation';

const navigationState = vi.hoisted(() => ({
  pathname: '/a3',
  search: '',
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () => new URLSearchParams(navigationState.search),
  useRouter: () => ({ replace: navigationState.replace }),
}));

vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: vi.fn(() => new Promise(() => undefined)),
  a3PostJson: vi.fn(),
}));

const root = process.cwd();
const gateSource = fs.readFileSync(path.join(root, 'components/a3/auth/a3-auth-gate.tsx'), 'utf8');
const shellSource = fs.readFileSync(path.join(root, 'components/a3/layout/a3-shell.tsx'), 'utf8');

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
  it('renders the public homepage immediately while authentication is pending', () => {
    navigationState.pathname = '/a3';
    navigationState.search = '';

    const markup = renderToStaticMarkup(
      createElement(
        A3AuthGate,
        null,
        createElement('div', { 'data-testid': 'public-homepage' }, '公共产品首页'),
      ),
    );

    expect(markup).toContain('data-testid="public-homepage"');
    expect(markup).toContain('公共产品首页');
    expect(markup).not.toContain('正在进入智学引擎');
  });

  it('keeps /a3 public without treating it as an auth-only guest page', () => {
    expect(A3_PUBLIC_PATHS).toEqual(new Set(['/a3']));
    expect(gateSource).toContain('if (isPublicPath)');
    expect(gateSource).toContain('value={user ?? null}');
  });

  it('defines the exact guest and onboarding flow route boundaries', () => {
    expect(A3_GUEST_PATHS).toEqual(new Set(['/a3/login', '/a3/register', '/a3/forgot-password']));
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
    const currentPath = buildA3CurrentPath(
      '/a3/coaching',
      new URLSearchParams('source=home&topic=进程调度'),
      '#citations',
    );

    expect(currentPath).toBe(
      '/a3/coaching?source=home&topic=%E8%BF%9B%E7%A8%8B%E8%B0%83%E5%BA%A6#citations',
    );
    expect(getA3AuthTarget(currentPath, null)).toBe(
      `/a3/login?next=${encodeURIComponent(currentPath)}`,
    );
    expect(getA3AuthTarget('/a3/login', null)).toBeNull();
  });

  it('reads the initial hash safely on the server and in the browser', () => {
    expect(getInitialA3Hash()).toBe('');

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { hash: '#review-evidence' } },
    });
    try {
      expect(getInitialA3Hash()).toBe('#review-evidence');
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('bypasses the learning workspace shell on the public homepage', () => {
    expect(A3_SHELL_BYPASS_PATHS).toEqual(
      new Set([...A3_PUBLIC_PATHS, ...A3_GUEST_PATHS, ...A3_FLOW_PATHS]),
    );
    expect(shellSource).toContain('A3_SHELL_BYPASS_PATHS.has(pathname)');

    navigationState.pathname = '/a3';
    const markup = renderToStaticMarkup(
      createElement(A3Shell, null, createElement('span', null, '无工作区外壳')),
    );
    expect(markup).toBe('<span>无工作区外壳</span>');
  });

  it('accepts internal A3 return paths and preserves query and hash', () => {
    expect(normalizeA3ReturnPath('/a3/coaching')).toBe('/a3/coaching');
    expect(normalizeA3ReturnPath('/a3/classroom?source=home')).toBe('/a3/classroom?source=home');
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
