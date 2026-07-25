import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { A3PublicUser, A3UserRole } from '@/lib/a3/auth-types';
import {
  getA3AuthTarget,
  getA3NextPathForUser,
  resolveA3LoginDestination,
} from '@/lib/a3/auth-navigation';

const root = process.cwd();

function completedUser(role: A3UserRole): A3PublicUser {
  return {
    id: `${role}-1`,
    role,
    displayName: `测试${role}`,
    phoneBound: true,
    privacyAccepted: true,
    profileCompleted: true,
    onboardingStep: 'complete',
    createdAt: '2026-07-25T00:00:00Z',
    updatedAt: '2026-07-25T00:00:00Z',
  };
}

describe('role-aware A3 login routing', () => {
  it.each([
    ['student', '/a3/today'],
    ['teacher', '/a3/teacher'],
    ['admin', '/a3/admin/overview'],
  ] as const)('routes a completed %s to the correct workspace', (role, destination) => {
    expect(getA3NextPathForUser(completedUser(role))).toBe(destination);
    expect(resolveA3LoginDestination(completedUser(role))).toBe(destination);
  });

  it('keeps onboarding ahead of role workspace routing and explicit next', () => {
    const teacher = completedUser('teacher');
    const admin = completedUser('admin');

    expect(
      resolveA3LoginDestination(
        { ...teacher, phoneBound: false, onboardingStep: 'phone' },
        '/a3/teacher',
      ),
    ).toBe('/a3/phone-binding');
    expect(
      resolveA3LoginDestination(
        { ...admin, privacyAccepted: false, onboardingStep: 'privacy' },
        '/a3/admin/overview',
      ),
    ).toBe('/a3/privacy');
    expect(
      resolveA3LoginDestination(
        { ...admin, profileCompleted: false, onboardingStep: 'profile' },
        '/a3/admin/overview',
      ),
    ).toBe('/a3/profile-setup');
  });

  it('accepts a safe next only when the authenticated role can enter that workspace', () => {
    const student = completedUser('student');
    const teacher = completedUser('teacher');
    const admin = completedUser('admin');

    expect(resolveA3LoginDestination(student, '/a3/coaching?source=review')).toBe(
      '/a3/coaching?source=review',
    );
    expect(resolveA3LoginDestination(student, '/a3/teacher')).toBe('/a3/today');
    expect(resolveA3LoginDestination(student, '/a3/admin/users')).toBe('/a3/today');

    expect(resolveA3LoginDestination(teacher, '/a3/teacher?view=risks')).toBe(
      '/a3/teacher?view=risks',
    );
    expect(resolveA3LoginDestination(teacher, '/a3/coaching')).toBe('/a3/coaching');
    expect(resolveA3LoginDestination(teacher, '/a3/admin/overview')).toBe('/a3/teacher');

    expect(resolveA3LoginDestination(admin, '/a3/admin/users?status=active')).toBe(
      '/a3/admin/users?status=active',
    );
    expect(resolveA3LoginDestination(admin, '/a3/today')).toBe('/a3/today');
  });

  it('treats workspace query as intent without changing the authenticated role', () => {
    const guestState = { isPublicPath: false, isGuestPath: true, isFlowPath: false };

    expect(
      getA3AuthTarget('/a3/login?workspace=admin', completedUser('student'), guestState),
    ).toBe('/a3/today');
    expect(
      getA3AuthTarget('/a3/login?workspace=student', completedUser('teacher'), guestState),
    ).toBe('/a3/teacher');
    expect(
      getA3AuthTarget('/a3/login?workspace=teacher', completedUser('admin'), guestState),
    ).toBe('/a3/admin/overview');
  });
});

describe('independent A3 workspace frame', () => {
  const layoutPath = path.join(root, 'app/a3/layout.tsx');
  const framePath = path.join(root, 'components/a3/layout/a3-workspace-frame.tsx');
  const adminLayoutPath = path.join(
    root,
    'components/a3/features/admin/admin-console-layout.tsx',
  );
  const layoutSource = fs.readFileSync(layoutPath, 'utf8');
  const frameSource = fs.existsSync(framePath) ? fs.readFileSync(framePath, 'utf8') : '';
  const adminLayoutSource = fs.existsSync(adminLayoutPath)
    ? fs.readFileSync(adminLayoutPath, 'utf8')
    : '';

  it('keeps auth at the root and delegates shell selection to the workspace frame', () => {
    expect(layoutSource).toContain('<A3AuthGate>');
    expect(layoutSource).toContain('<A3WorkspaceFrame>{children}</A3WorkspaceFrame>');
    expect(frameSource).toContain("pathname.startsWith('/a3/admin/')");
    expect(frameSource).toContain('<AdminConsoleLayout>{children}</AdminConsoleLayout>');
    expect(frameSource).toContain('<A3GuidedTourProvider>');
    expect(frameSource).toContain('<A3Shell>{children}</A3Shell>');
  });

  it('keeps the authenticated presence heartbeat above both workspace shells', () => {
    expect(frameSource).toContain("'/api/auth/presence/heartbeat/'");
    expect(frameSource).toContain('document.visibilityState');
    expect(frameSource).toContain('window.setInterval');
  });

  it('provides admin-only navigation, active route state, and responsive collapse controls', () => {
    expect(adminLayoutSource).toContain('data-a3-admin-console');
    expect(adminLayoutSource).toContain('智学引擎 · 管理后台');
    expect(adminLayoutSource).toContain("href: '/a3/admin/overview'");
    expect(adminLayoutSource).toContain("href: '/a3/admin/audit'");
    expect(adminLayoutSource).toContain("pathname === item.href || pathname.startsWith");
    expect(adminLayoutSource).toContain('md:hidden');
    expect(adminLayoutSource).toContain('localStorage');
    expect(adminLayoutSource).not.toContain('返回学习空间');
    expect(adminLayoutSource).not.toContain('href="/a3/today"');
    expect(adminLayoutSource).not.toMatch(/(?:bg|text|border|ring)-blue-/);
  });
});

describe('A3 authorization 403 handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not refresh CSRF or replay a write request for a JSON authorization 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'csrf-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: '当前账号无系统管理权限' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { a3PostJson } = await import('@/lib/a3/api-client');

    const result = await a3PostJson<{ success: boolean; error?: string }>(
      '/api/admin/users/42/status/',
      { isActive: false },
    );

    expect(result).toEqual({ success: false, error: '当前账号无系统管理权限' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000/api/admin/users/42/status/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refreshes CSRF once when the 403 response identifies a CSRF failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'csrf-before' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<h1>Forbidden</h1><p>CSRF verification failed.</p>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'csrf-after' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { a3PostJson } = await import('@/lib/a3/api-client');

    const result = await a3PostJson<{ success: boolean }>('/api/admin/users/42/status/', {
      isActive: false,
    });

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8000/api/admin/users/42/status/',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-CSRFToken': 'csrf-after' }),
      }),
    );
  });
});
