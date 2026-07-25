import type { A3PublicUser, A3UserRole } from '@/lib/a3/auth-types';

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

const A3_ROLE_HOME: Record<A3UserRole, string> = {
  student: '/a3/today',
  teacher: '/a3/teacher',
  admin: '/a3/admin/overview',
};

export function isA3PublicPath(pathname: string) {
  return A3_PUBLIC_PATHS.has(pathname) || pathname === '/a3/help' || pathname.startsWith('/a3/help/');
}

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
  return A3_ROLE_HOME[user.role];
}

function loginReturnPath(currentPath: string, user: A3PublicUser): string | null {
  if (!isA3OnboardingComplete(user)) return null;

  try {
    const parsed = new URL(currentPath, returnPathBase);
    if (parsed.origin !== returnPathBase || parsed.pathname !== '/a3/login') return null;
    return getRoleCompatibleA3ReturnPath(parsed.searchParams.get('next'), user.role);
  } catch {
    return null;
  }
}

export function resolveA3LoginDestination(
  user: A3PublicUser,
  returnTo?: string | null,
): string {
  const nextPath = getA3NextPathForUser(user);
  if (!isA3OnboardingComplete(user)) return nextPath;
  return getRoleCompatibleA3ReturnPath(returnTo, user.role) ?? nextPath;
}

function isA3OnboardingComplete(user: A3PublicUser) {
  return Boolean(
    user.role &&
      user.onboardingStep !== 'role' &&
      user.phoneBound &&
      user.onboardingStep !== 'welcome' &&
      user.privacyAccepted &&
      user.profileCompleted,
  );
}

function getRoleCompatibleA3ReturnPath(value: string | null | undefined, role: A3UserRole) {
  const returnPath = normalizeA3ReturnPath(value);
  if (!returnPath) return null;

  const pathname = new URL(returnPath, returnPathBase).pathname.replace(/\/+$/, '') || '/';
  const isAdminPath = pathname === '/a3/admin' || pathname.startsWith('/a3/admin/');
  const isTeacherPath = pathname === '/a3/teacher' || pathname.startsWith('/a3/teacher/');

  if (role === 'student') return isAdminPath || isTeacherPath ? null : returnPath;
  if (role === 'teacher') return isAdminPath ? null : returnPath;
  return returnPath;
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
    isPublicPath: isA3PublicPath(pathname),
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
  if (!pathState.isFlowPath && !isA3OnboardingComplete(user)) return nextPath;
  return null;
}
