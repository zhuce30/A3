'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { a3GetJson } from '@/lib/a3/api-client';
import type { A3PublicUser } from '@/lib/a3/auth-types';

const guestPaths = new Set(['/a3/login', '/a3/register', '/a3/forgot-password']);
const flowPaths = new Set([
  '/a3/role-selection',
  '/a3/phone-binding',
  '/a3/welcome',
  '/a3/privacy',
  '/a3/profile-setup',
]);

const A3CurrentUserContext = createContext<A3PublicUser | null>(null);

export function useA3CurrentUser() {
  return useContext(A3CurrentUserContext);
}

function nextPathForUser(user: A3PublicUser) {
  if (!user.role) return '/a3/role-selection';
  if (user.onboardingStep === 'role') return '/a3/role-selection';
  if (!user.phoneBound) return '/a3/phone-binding';
  if (user.onboardingStep === 'welcome') return '/a3/welcome';
  if (!user.privacyAccepted) return '/a3/privacy';
  if (!user.profileCompleted) return '/a3/profile-setup';
  return '/a3/dashboard';
}

export function A3AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<A3PublicUser | null | undefined>(undefined);

  const isGuestPath = guestPaths.has(pathname);
  const isFlowPath = flowPaths.has(pathname);

  useEffect(() => {
    let alive = true;
    a3GetJson<{ user?: A3PublicUser | null }>('/api/auth/me/')
      .then((data) => {
        if (alive) setUser(data.user ?? null);
      })
      .catch(() => {
        if (alive) setUser(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function handleUserUpdated(event: Event) {
      const updatedUser = (event as CustomEvent<Partial<A3PublicUser> | null>).detail;
      if (updatedUser === null) {
        setUser(null);
        return;
      }
      setUser((current) => (current ? { ...current, ...updatedUser } : (updatedUser as A3PublicUser)));
    }

    window.addEventListener('a3-auth-user-updated', handleUserUpdated);
    return () => window.removeEventListener('a3-auth-user-updated', handleUserUpdated);
  }, []);

  const target = useMemo(() => {
    if (user === undefined) return null;
    if (!user) return isGuestPath ? null : '/a3/login';
    const nextPath = nextPathForUser(user);
    if (isGuestPath) return nextPath;
    if (!isFlowPath && nextPath !== '/a3/dashboard') return nextPath;
    return null;
  }, [isFlowPath, isGuestPath, user]);

  useEffect(() => {
    if (target && target !== pathname) router.replace(target);
  }, [pathname, router, target]);

  if (user === undefined || target) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f7fc] text-sm text-slate-500">
        正在进入智学引擎...
      </div>
    );
  }

  return (
    <A3CurrentUserContext.Provider value={user}>
      {children}
    </A3CurrentUserContext.Provider>
  );
}

export const A3_AUTH_FLOW_PATHS = new Set([...guestPaths, ...flowPaths]);
