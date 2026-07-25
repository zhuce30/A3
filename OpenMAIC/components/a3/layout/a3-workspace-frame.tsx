'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { AdminConsoleLayout } from '@/components/a3/features/admin/admin-console-layout';
import { A3GuidedTourProvider } from '@/components/a3/guided-tour/guided-tour-provider';
import { A3Shell } from '@/components/a3/layout/a3-shell';
import { a3PostJson } from '@/lib/a3/api-client';
import { isA3PublicPath } from '@/lib/a3/auth-navigation';

export function A3WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useA3CurrentUser();

  useEffect(() => {
    if (!user?.id || !pathname.startsWith('/a3') || isA3PublicPath(pathname)) return;
    let inFlight = false;
    const sendHeartbeat = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        await a3PostJson('/api/auth/presence/heartbeat/', { path: pathname });
      } finally {
        inFlight = false;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void sendHeartbeat();
    };
    void sendHeartbeat();
    const interval = window.setInterval(() => void sendHeartbeat(), 60_000);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [pathname, user?.id]);

  if (pathname === '/a3/admin' || pathname.startsWith('/a3/admin/')) {
    return <AdminConsoleLayout>{children}</AdminConsoleLayout>;
  }

  return (
    <A3GuidedTourProvider>
      <A3Shell>{children}</A3Shell>
    </A3GuidedTourProvider>
  );
}
