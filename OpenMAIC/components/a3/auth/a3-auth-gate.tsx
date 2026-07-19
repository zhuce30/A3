'use client';

import { createContext, Suspense, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { a3GetJson } from '@/lib/a3/api-client';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import {
  A3_FLOW_PATHS,
  A3_GUEST_PATHS,
  buildA3CurrentPath,
  getA3AuthTarget,
  getInitialA3Hash,
  isA3PublicPath,
} from '@/lib/a3/auth-navigation';

const guestPaths = A3_GUEST_PATHS;
const flowPaths = A3_FLOW_PATHS;

const A3CurrentUserContext = createContext<A3PublicUser | null>(null);

export function useA3CurrentUser() {
  return useContext(A3CurrentUserContext);
}

export function A3AuthGate({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<A3AuthGateFallback>{children}</A3AuthGateFallback>}>
      <A3AuthGateWithLocation>{children}</A3AuthGateWithLocation>
    </Suspense>
  );
}

function A3AuthGateFallback({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (isA3PublicPath(pathname)) {
    return <A3CurrentUserContext.Provider value={null}>{children}</A3CurrentUserContext.Provider>;
  }
  return <A3AuthLoading />;
}

function A3AuthGateWithLocation({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [user, setUser] = useState<A3PublicUser | null | undefined>(undefined);
  const [initialHash] = useState(getInitialA3Hash);

  const isPublicPath = isA3PublicPath(pathname);
  const isGuestPath = guestPaths.has(pathname);
  const isFlowPath = flowPaths.has(pathname);
  const currentPath = useMemo(
    () => buildA3CurrentPath(pathname, searchParams, initialHash),
    [initialHash, pathname, searchParams],
  );

  useEffect(() => {
    if (isPublicPath) return;
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
  }, [isPublicPath]);

  useEffect(() => {
    function handleUserUpdated(event: Event) {
      const updatedUser = (event as CustomEvent<Partial<A3PublicUser> | null>).detail;
      if (updatedUser === null) {
        setUser(null);
        return;
      }
      setUser((current) =>
        current ? { ...current, ...updatedUser } : (updatedUser as A3PublicUser),
      );
    }

    window.addEventListener('a3-auth-user-updated', handleUserUpdated);
    return () => window.removeEventListener('a3-auth-user-updated', handleUserUpdated);
  }, []);

  const target = useMemo(
    () =>
      getA3AuthTarget(currentPath, user, {
        isPublicPath,
        isGuestPath,
        isFlowPath,
      }),
    [currentPath, isFlowPath, isGuestPath, isPublicPath, user],
  );

  useEffect(() => {
    if (target && target !== pathname) router.replace(target);
  }, [pathname, router, target]);

  if (isPublicPath) {
    return (
      <A3CurrentUserContext.Provider value={user ?? null}>{children}</A3CurrentUserContext.Provider>
    );
  }

  if (user === undefined || target) {
    return <A3AuthLoading />;
  }

  return <A3CurrentUserContext.Provider value={user}>{children}</A3CurrentUserContext.Provider>;
}

function A3AuthLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f7fc] text-sm text-slate-500">
      正在进入智学引擎...
    </div>
  );
}

export { A3_SHELL_BYPASS_PATHS } from '@/lib/a3/auth-navigation';
