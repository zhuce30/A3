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

const blockedReturnPaths = new Set(['/a3', '/a3/login', '/a3/register', '/a3/forgot-password']);

const returnPathBase = 'https://a3.local';

type A3SearchParams = Pick<URLSearchParams, 'toString'> | string | null | undefined;

type A3AuthPathState = {
  isPublicPath: boolean;
  isGuestPath: boolean;
  isFlowPath: boolean;
};

export function getA3NextPathForUser(user: A3PublicUser) {
  if (!user.role) return '/a3/role-selection';
  if (user.onboardingStep === 'role') return '/a3/role-selection';
  if (!user.phoneBound) return '/a3/phone-binding';
  if (user.onboardingStep === 'welcome') return '/a3/welcome';
  if (!user.privacyAccepted) return '/a3/privacy';
  if (!user.profileCompleted) return '/a3/profile-setup';
  return '/a3/dashboard';
}

function loginReturnPath(currentPath: string, user: A3PublicUser): string | null {
  if (getA3NextPathForUser(user) !== '/a3/dashboard') return null;

  try {
    const parsed = new URL(currentPath, returnPathBase);
    if (parsed.origin !== returnPathBase || parsed.pathname !== '/a3/login') return null;
    return normalizeA3ReturnPath(parsed.searchParams.get('next'));
  } catch {
    return null;
  }
}

export function resolveA3LoginDestination(
  user: A3PublicUser,
  returnTo?: string | null,
): string {
  const nextPath = getA3NextPathForUser(user);
  const safeReturnTo = normalizeA3ReturnPath(returnTo);
  return nextPath === '/a3/dashboard' && safeReturnTo ? safeReturnTo : nextPath;
}

export function getInitialA3Hash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

export function buildA3CurrentPath(
  pathname: string,
  searchParams?: A3SearchParams,
  hash = '',
): string {
  const search = (
    typeof searchParams === 'string' ? searchParams : (searchParams?.toString() ?? '')
  ).replace(/^\?/, '');
  const normalizedHash = hash && hash !== '#' ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  return `${pathname}${search ? `?${search}` : ''}${normalizedHash}`;
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

  const nextPath = getA3NextPathForUser(user);
  if (pathState.isGuestPath) return loginReturnPath(pathname, user) ?? nextPath;
  if (!pathState.isFlowPath && nextPath !== '/a3/dashboard') return nextPath;
  return null;
}
