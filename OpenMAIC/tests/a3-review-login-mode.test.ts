import fs from 'node:fs';
import path from 'node:path';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { A3PublicUser } from '@/lib/a3/auth-types';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/components/a3/layout/a3-top-actions', () => ({
  A3TopActions: () => null,
}));

type TestElementProps = {
  children?: ReactNode;
  'data-testid'?: string;
  onClick?: () => void;
};

function findByTestId(node: ReactNode, testId: string): ReactElement<TestElementProps> | null {
  if (!isValidElement<TestElementProps>(node)) return null;
  if (node.props['data-testid'] === testId) return node;

  for (const child of Children.toArray(node.props.children)) {
    const match = findByTestId(child, testId);
    if (match) return match;
  }

  return null;
}

describe('A3 review login mode', () => {
  it('derives review mode and a safe return target from async search params', async () => {
    const { default: A3LoginPage } = await import('@/app/a3/login/page');

    const regular = await A3LoginPage({ searchParams: Promise.resolve({}) });
    expect(regular.props).toMatchObject({ reviewMode: false, returnTo: null });

    const review = await A3LoginPage({
      searchParams: Promise.resolve({
        mode: 'review',
        next: '/a3/coaching?source=homepage#citations',
      }),
    });
    expect(review.props).toMatchObject({
      reviewMode: true,
      returnTo: '/a3/coaching?source=homepage#citations',
    });

    const unsafe = await A3LoginPage({
      searchParams: Promise.resolve({ mode: 'review', next: 'https://evil.example/a3' }),
    });
    expect(unsafe.props.returnTo).toBeNull();
  });

  it('shows the review panel only in review mode', async () => {
    const { LoginPage } = await import('@/components/a3/auth/a3-auth-pages');

    const regularMarkup = renderToStaticMarkup(createElement(LoginPage));
    expect(regularMarkup).toContain('欢迎回来');
    expect(regularMarkup).not.toContain('data-testid="a3-review-login-panel"');
    expect(regularMarkup).not.toContain('13800000001');
    expect(regularMarkup).not.toContain('Demo@123456');

    const reviewMarkup = renderToStaticMarkup(createElement(LoginPage, { reviewMode: true }));
    expect(reviewMarkup).toContain('进入评审体验');
    expect(reviewMarkup).toContain('data-testid="a3-review-login-panel"');
    expect(reviewMarkup).toContain('登录仍会调用真实认证接口');
  });

  it('fills the existing login fields with the review account', async () => {
    const panelPath = path.resolve(process.cwd(), 'components/a3/auth/a3-review-login-panel.tsx');
    expect(fs.existsSync(panelPath), 'review-only panel should exist').toBe(true);

    const { A3ReviewLoginPanel } = await import('@/components/a3/auth/a3-review-login-panel');
    const onFill = vi.fn();
    const panel = A3ReviewLoginPanel({ onFill });
    const fillButton = findByTestId(panel, 'a3-review-fill-account');

    expect(fillButton).not.toBeNull();
    fillButton?.props.onClick?.();
    expect(onFill).toHaveBeenCalledOnce();
    expect(onFill).toHaveBeenCalledWith({
      identifier: '13800000001',
      password: 'Demo@123456',
    });
  });

  it('lets the auth gate prefer an approved return target only after onboarding', async () => {
    const { getA3AuthTarget } = await import('@/lib/a3/auth-navigation');
    const guestState = { isPublicPath: false, isGuestPath: true, isFlowPath: false };
    const completedUser: A3PublicUser = {
      id: 'review-student',
      role: 'student' as const,
      displayName: '评审学生',
      phoneBound: true,
      privacyAccepted: true,
      profileCompleted: true,
      onboardingStep: 'complete',
      createdAt: '2026-07-11T00:00:00Z',
      updatedAt: '2026-07-11T00:00:00Z',
    };

    expect(
      getA3AuthTarget('/a3/login?mode=review&next=%2Fa3%2Fcoaching', completedUser, guestState),
    ).toBe('/a3/coaching');
    expect(
      getA3AuthTarget('/a3/login?next=https%3A%2F%2Fevil.example%2Fa3', completedUser, guestState),
    ).toBe('/a3/dashboard');
    expect(
      getA3AuthTarget(
        '/a3/login?next=%2Fa3%2Fcoaching',
        {
          ...completedUser,
          privacyAccepted: false,
          profileCompleted: false,
          onboardingStep: 'privacy',
        },
        guestState,
      ),
    ).toBe('/a3/privacy');
  });

  it('keeps fixed review credentials in the review-only component', () => {
    const authPages = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx'),
      'utf8',
    );
    expect(authPages).not.toContain("'13800000001'");
    expect(authPages).not.toContain("'Demo@123456'");
  });
});
