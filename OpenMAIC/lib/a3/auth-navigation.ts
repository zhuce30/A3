import type { A3PublicUser } from '@/lib/a3/auth-types';

export const A3_PUBLIC_PATHS: ReadonlySet<string> = new Set(['/a3']);
export const A3_GUEST_PATHS: ReadonlySet<string> = new Set([
  '/a3/login',
  '/a3/register',
  '/a3/forgot-password',
]);
export const A3_FLOW_PATHS: ReadonlySet<string> = new Set([
  '/a3/role-selection',
  '/a3/phone-binding',
  '/a3/welcome',
  '/a3/privacy',
  '/a3/profile-setup',
]);

export const A3_SHELL_BYPASS_PATHS: ReadonlySet<string> = new Set([
  ...A3_PUBLIC_PATHS,
  ...A3_GUEST_PATHS,
  ...A3_FLOW_PATHS,
]);

const blockedReturnPaths = new Set([
  '/a3',
  '/a3/login',
  '/a3/register',
  '/a3/forgot-password',
]);

const returnPathBase = 'https://a3.local';

type A3AuthPathState = {
  isPublicPath: boolean;
  isGuestPath: boolean;
  isFlowPath: boolean;
};

function nextPathForUser(user: A3PublicUser) {
  if (!user.role) return '/a3/role-selection';
  if (user.onboardingStep === 'role') return '/a3/role-selection';
  if (!user.phoneBound) return '/a3/phone-binding';
  if (user.onboardingStep === 'welcome') return '/a3/welcome';
  if (!user.privacyAccepted) return '/a3/privacy';
  if (!user.profileCompleted) return '/a3/profile-setup';
  return '/a3/dashboard';
}

export function normalizeA3ReturnPath(value?: string | null): string | null {
  if (
    !value ||
    value !== value.trim() ||
    !value.startsWith('/a3/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, returnPathBase);
  } catch {
    return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (
    parsed.origin !== returnPathBase ||
    !pathname.startsWith('/a3/') ||
    blockedReturnPaths.has(pathname)
  ) {
    return null;
  }

  return value;
}

export function getA3AuthTarget(
  pathname: string,
  user: A3PublicUser | null | undefined,
  pathState: A3AuthPathState = {
    isPublicPath: A3_PUBLIC_PATHS.has(pathname),
    isGuestPath: A3_GUEST_PATHS.has(pathname),
    isFlowPath: A3_FLOW_PATHS.has(pathname),
  },
): string | null {
  if (pathState.isPublicPath) return null;
  if (user === undefined) return null;

  if (!user) {
    if (pathState.isGuestPath) return null;
    const returnPath = normalizeA3ReturnPath(pathname);
    return returnPath ? `/a3/login?next=${encodeURIComponent(returnPath)}` : '/a3/login';
  }

  const nextPath = nextPathForUser(user);
  if (pathState.isGuestPath) return nextPath;
  if (!pathState.isFlowPath && nextPath !== '/a3/dashboard') return nextPath;
  return null;
}
