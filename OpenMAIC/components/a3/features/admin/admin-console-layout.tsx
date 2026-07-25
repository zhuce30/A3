'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot,
  BookOpen,
  Database,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { cn } from '@/lib/utils';

const ADMIN_SIDEBAR_STORAGE_KEY = 'a3-admin-sidebar-collapsed';

const adminNavItems = [
  { href: '/a3/admin/overview', label: '运行总览', icon: LayoutDashboard },
  { href: '/a3/admin/users', label: '用户管理', icon: Users },
  { href: '/a3/admin/conversations', label: '对话记录', icon: MessageSquareText },
  { href: '/a3/admin/catalog', label: '课程与知识库', icon: BookOpen },
  { href: '/a3/admin/tasks', label: '资源任务', icon: Database },
  { href: '/a3/admin/agents', label: 'Agent 运行', icon: Bot },
  { href: '/a3/admin/safety', label: '内容安全', icon: ShieldCheck },
  { href: '/a3/admin/settings', label: '系统配置', icon: Settings },
  { href: '/a3/admin/audit', label: '审计日志', icon: ScrollText },
] as const;

export function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useA3CurrentUser();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSidebarCollapsed(window.localStorage.getItem(ADMIN_SIDEBAR_STORAGE_KEY) === '1');
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMobileOpen(false));
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(ADMIN_SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }

  const currentItem =
    adminNavItems.find(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    ) ?? adminNavItems[0];
  const displayName = user?.displayName?.trim() || '系统管理员';

  return (
    <div
      data-a3-admin-console
      className="min-h-[100dvh] bg-[#f7f5ee] text-[#183229] [--admin-accent:#9b7b2f] [--admin-border:#d9d6c9] [--admin-green:#143f32] [--admin-muted:#64736c] [--admin-surface:#fffdf7]"
    >
      {mobileOpen ? (
        <button
          type="button"
          aria-label="关闭管理导航"
          className="fixed inset-0 z-40 bg-[#102b22]/35 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        id="a3-admin-sidebar"
        data-collapsed={sidebarCollapsed ? 'true' : 'false'}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col border-r border-[var(--admin-border)] bg-[var(--admin-surface)] transition-[transform,width] duration-200 md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          sidebarCollapsed ? 'md:w-[72px]' : 'md:w-[264px]',
        )}
      >
        <div className={cn('flex h-[72px] items-center border-b border-[var(--admin-border)]', sidebarCollapsed ? 'md:justify-center md:px-2' : 'px-5')}>
          <div className={cn('min-w-0', sidebarCollapsed && 'md:hidden')}>
            <div className="truncate text-[15px] font-semibold text-[var(--admin-green)]">
              智学引擎 · 管理后台
            </div>
            <div className="mt-1 truncate text-xs text-[var(--admin-muted)]">A3 Operations Console</div>
          </div>
          <button
            type="button"
            aria-label="关闭管理导航"
            className="ml-auto flex size-9 items-center justify-center rounded-md text-[var(--admin-muted)] hover:bg-[#efede4] md:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <X className="size-5" />
          </button>
          <ShieldCheck className={cn('hidden size-6 text-[var(--admin-accent)]', sidebarCollapsed && 'md:block')} />
        </div>

        <nav className={cn('min-h-0 flex-1 space-y-1 overflow-y-auto py-3', sidebarCollapsed ? 'md:px-2' : 'px-3')} aria-label="管理后台导航">
          {adminNavItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={sidebarCollapsed ? item.label : undefined}
                className={cn(
                  'flex h-10 items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--admin-accent)]',
                  sidebarCollapsed ? 'md:justify-center md:px-0' : 'gap-3 px-3',
                  active
                    ? 'bg-[var(--admin-green)] font-semibold text-[#fffdf7]'
                    : 'text-[#40554c] hover:bg-[#efede4] hover:text-[var(--admin-green)]',
                )}
              >
                <Icon className={cn('size-[18px] shrink-0', active && 'text-[#d7bd72]')} />
                <span className={cn('truncate', sidebarCollapsed && 'md:hidden')}>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={cn('border-t border-[var(--admin-border)] py-4', sidebarCollapsed ? 'md:px-2' : 'px-4')}>
          <div className={cn('min-w-0', sidebarCollapsed && 'md:text-center')}>
            <div className={cn('truncate text-sm font-semibold text-[var(--admin-green)]', sidebarCollapsed && 'md:hidden')}>
              {displayName}
            </div>
            <div className={cn('mt-1 text-xs text-[var(--admin-muted)]', sidebarCollapsed && 'md:hidden')}>管理员会话</div>
            <div className={cn('hidden size-9 items-center justify-center rounded-md bg-[#e7e1cf] text-sm font-semibold text-[var(--admin-green)]', sidebarCollapsed && 'md:inline-flex')}>
              {displayName.slice(0, 1)}
            </div>
          </div>
        </div>
      </aside>

      <div className={cn('transition-[padding] duration-200', sidebarCollapsed ? 'md:pl-[72px]' : 'md:pl-[264px]')}>
        <header className="sticky top-0 z-30 flex h-[64px] items-center justify-between gap-3 border-b border-[var(--admin-border)] bg-[#fffdf7]/95 px-4 backdrop-blur md:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="打开管理导航"
              aria-controls="a3-admin-sidebar"
              aria-expanded={mobileOpen}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-[var(--admin-border)] text-[var(--admin-green)] hover:bg-[#efede4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--admin-accent)] md:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-5" />
            </button>
            <button
              type="button"
              aria-label={sidebarCollapsed ? '展开管理侧栏' : '收起管理侧栏'}
              aria-controls="a3-admin-sidebar"
              aria-expanded={!sidebarCollapsed}
              className="hidden size-9 shrink-0 items-center justify-center rounded-md border border-[var(--admin-border)] text-[var(--admin-green)] hover:bg-[#efede4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--admin-accent)] md:flex"
              onClick={toggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
            </button>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--admin-green)]">{currentItem.label}</div>
              <div className="hidden text-xs text-[var(--admin-muted)] sm:block">管理后台</div>
            </div>
          </div>
          <div className="shrink-0 border-l border-[var(--admin-border)] pl-3 text-right">
            <div className="max-w-36 truncate text-sm font-medium text-[var(--admin-green)]">{displayName}</div>
            <div className="text-xs text-[var(--admin-muted)]">Admin</div>
          </div>
        </header>

        <main className="mx-auto min-w-0 max-w-[1720px] p-4 sm:p-5 xl:p-6">{children}</main>
      </div>
    </div>
  );
}
