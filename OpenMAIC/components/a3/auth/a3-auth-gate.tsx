'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { a3GetJson } from '@/lib/a3/api-client';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import {
  A3_FLOW_PATHS,
  A3_GUEST_PATHS,
  A3_PUBLIC_PATHS,
  getA3AuthTarget,
} from '@/lib/a3/auth-navigation';

const publicPaths = A3_PUBLIC_PATHS;
const guestPaths = A3_GUEST_PATHS;
const flowPaths = A3_FLOW_PATHS;

const A3CurrentUserContext = createContext<A3PublicUser | null>(null);

export function useA3CurrentUser() {
  return useContext(A3CurrentUserContext);
}

export function A3AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<A3PublicUser | null | undefined>(undefined);

  const isPublicPath = publicPaths.has(pathname);
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

  const target = useMemo(
    () =>
      getA3AuthTarget(pathname, user, {
        isPublicPath,
        isGuestPath,
        isFlowPath,
      }),
    [isFlowPath, isGuestPath, isPublicPath, pathname, user],
  );

  useEffect(() => {
    if (target && target !== pathname) router.replace(target);
  }, [pathname, router, target]);

  if (isPublicPath) {
    return (
      <A3CurrentUserContext.Provider value={user ?? null}>
        {children}
      </A3CurrentUserContext.Provider>
    );
  }

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

export { A3_SHELL_BYPASS_PATHS } from '@/lib/a3/auth-navigation';
