'use client';

import { ShieldAlert } from 'lucide-react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';

export function AdminAccessGuard({ children }: { children: React.ReactNode }) {
  const user = useA3CurrentUser();
  if (user?.role === 'admin') return <>{children}</>;
  return (
    <section className="border-y border-amber-200 bg-amber-50 px-5 py-14 text-center text-amber-950">
      <ShieldAlert className="mx-auto size-8" />
      <h1 className="mt-4 text-xl font-semibold">无系统管理权限</h1>
      <p className="mt-2 text-sm text-amber-800">该页面仅向管理员开放，教师工作台权限不包含全站用户和运行数据。</p>
    </section>
  );
}
