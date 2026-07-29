'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, CircleHelp, LogOut, PanelLeftClose, PanelLeftOpen, Repeat2, Settings, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  A3_SHELL_BYPASS_PATHS,
  useA3CurrentUser,
} from '@/components/a3/auth/a3-auth-gate';
import { A3GlobalSearch } from '@/components/a3/layout/a3-global-search';
import { A3TopActions } from '@/components/a3/layout/a3-top-actions';
import { a3PostJson } from '@/lib/a3/api-client';
import { useA3Locale } from '@/lib/a3/i18n';
import { isA3PublicPath } from '@/lib/a3/auth-navigation';
import { a3GetActiveNavHref, a3NavItems } from '@/lib/a3/navigation';
import { cn } from '@/lib/utils';

const A3_SIDEBAR_STORAGE_KEY = 'a3-sidebar-collapsed';

export function A3Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useA3CurrentUser();
  const { messages } = useA3Locale();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeNavHref = a3GetActiveNavHref(pathname);
  const [navDisclosure, setNavDisclosure] = useState<{ activeHref: string; expanded: Set<string> }>(() => {
    const activeItem = a3NavItems.find((item) => item.href === activeNavHref);
    return {
      activeHref: activeNavHref,
      expanded: activeItem?.children?.length ? new Set([activeNavHref]) : new Set(),
    };
  });
  const activeItem = a3NavItems.find((item) => item.href === activeNavHref);
  const expandedNavGroups = navDisclosure.activeHref === activeNavHref || !activeItem?.children?.length
    ? navDisclosure.expanded
    : new Set([...navDisclosure.expanded, activeNavHref]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSidebarCollapsed(window.localStorage.getItem(A3_SIDEBAR_STORAGE_KEY) === '1');
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (A3_SHELL_BYPASS_PATHS.has(pathname) || isA3PublicPath(pathname)) return <>{children}</>;

  const displayName = user?.displayName?.trim() || messages.unnamedUser;
  const userInitial = displayName.slice(0, 1);
  const studyGroup = user?.school ? `${user.school}${messages.studyGroupSuffix}` : messages.defaultStudyGroup;
  const focusedHeader = pathname === '/a3/classroom' || pathname === '/a3/coaching';
  const focusedPageTitle = pathname === '/a3/coaching' ? messages.coachingTitle : messages.classroomTitle;
  const pageTitle = pathname === '/a3/report' ? messages.reportTitle : pathname === '/a3/help' ? messages.helpCenter : '';
  const compactHeader = pathname === '/a3/dashboard' || Boolean(pageTitle);
  const visibleNavItems = a3NavItems.filter((item) => !item.roles || (user?.role && item.roles.includes(user.role)));
  const navLabels: Record<string, string> = {
    '/a3/dashboard': messages.navDashboard,
    '/a3/today': messages.navToday,
    '/a3/admission-diagnostic': messages.navAdmissionDiagnostic,
    '/a3/profile-setup': messages.navProfileSetup,
    '/a3/demo-flow': messages.navDemoFlow,
    '/a3/capabilities': messages.navCapabilities,
    '/a3/study-plan': messages.navStudyPlan,
    '/a3/learning-path': messages.navLearningPath,
    '/a3/courses': messages.navCourses,
    '/a3/knowledge-graph': messages.navKnowledgeGraph,
    '/a3/recommendations': messages.navRecommendations,
    '/a3/library': messages.navSystemLibrary,
    '/a3/assessment': messages.navAssessment,
    '/a3/wrong-notebook': messages.navWrongNotebook,
    '/a3/report': messages.navReport,
    '/a3/classroom': messages.navClassroom,
    '/a3/coaching': messages.navCoaching,
    '/a3/resources': messages.navResourceRecords,
    '/a3/favorites': messages.navFavorites,
    '/a3/notifications': messages.navNotifications,
    '/a3/teacher': messages.navTeacher,
    '/a3/knowledge-base': messages.navKnowledgeBase,
    '/a3/settings': messages.navSettings,
    '/a3/admin/overview': '系统管理',
    '/a3/admin/users': '用户管理',
  };
  const ownerPageLabels: Record<string, string> = {
    '/a3/today': messages.navTodayTasks,
    '/a3/study-plan': messages.navPlanOverview,
    '/a3/assessment': messages.navPracticeCenter,
    '/a3/classroom': messages.navAiClassroom,
    '/a3/knowledge-base': messages.navKnowledgeBaseHome,
    '/a3/admin/overview': '运行总览',
  };

  function toggleNavGroup(href: string) {
    const next = new Set(expandedNavGroups);
    if (next.has(href)) next.delete(href);
    else next.add(href);
    setNavDisclosure({ activeHref: activeNavHref, expanded: next });
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(A3_SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }

  async function logout() {
    await a3PostJson('/api/auth/logout/', {});
    window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: null }));
    setUserMenuOpen(false);
    window.location.assign('/a3/login');
  }

  async function switchAccount() {
    await a3PostJson('/api/auth/logout/', {});
    window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: null }));
    setUserMenuOpen(false);
    window.location.assign('/a3/login?switch=1');
  }

  return (
    <div data-a3-shell className="min-h-screen bg-[var(--a3-bg)] text-[var(--a3-text)]">
      <aside
        id="a3-primary-sidebar"
        data-testid="a3-primary-sidebar"
        data-collapsed={sidebarCollapsed ? 'true' : 'false'}
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden border-r border-[var(--a3-border)] bg-[var(--a3-surface-solid)] transition-[width] duration-300 ease-out md:block',
          sidebarCollapsed ? 'w-20' : 'w-[248px]',
        )}
      >
        <div className={cn('flex h-20 items-center gap-3 transition-[padding] duration-300', sidebarCollapsed ? 'justify-center px-0' : 'px-5')}>
          <div className="size-12 overflow-hidden rounded-[14px] shadow-[0_10px_22px_rgba(37,99,235,0.22)]">
            <Image src="/a3-brand-icon.png" alt="" width={48} height={48} className="size-full object-cover" priority unoptimized />
          </div>
          <div className={cn('min-w-0 transition-opacity duration-200', sidebarCollapsed && 'hidden opacity-0')}>
            <div className="text-[22px] font-semibold leading-tight text-[var(--a3-text)]">{messages.appName}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {messages.appNameEn}
            </div>
          </div>
        </div>

        <nav className={cn('max-h-[calc(100vh-176px)] space-y-2 overflow-y-auto pb-4 transition-[padding] duration-300', sidebarCollapsed ? 'px-3' : 'px-4')}>
          {visibleNavItems.map((item) => {
            const active = activeNavHref === item.href;
            const Icon = item.icon;
            const itemChildren = item.children ?? [];
            const grouped = itemChildren.length > 0;
            const expanded = grouped && expandedNavGroups.has(item.href);
            const childrenId = `a3-sidebar-children-${item.href.replaceAll('/', '-')}`;
            const itemLabel = navLabels[item.href] ?? item.label;
            if (sidebarCollapsed) {
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={itemLabel}
                  aria-label={itemLabel}
                  data-testid={`a3-sidebar-collapsed-${item.href.replaceAll('/', '-')}`}
                  className={cn(
                    'flex h-12 w-full items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    active
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                  )}
                >
                  <Icon className="size-5" />
                </Link>
              );
            }
            return (
              <div key={item.href} className="space-y-1">
                {grouped ? (
                  <button
                    type="button"
                    data-testid={`a3-sidebar-group-${item.href.replaceAll('/', '-')}`}
                    aria-expanded={expanded}
                    aria-controls={childrenId}
                    onClick={() => toggleNavGroup(item.href)}
                    className={cn(
                      'flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                      active
                        ? 'bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200'
                        : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', active && 'text-blue-600 dark:text-blue-300')} />
                    <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
                    <ChevronDown className={cn('size-4 shrink-0 transition-transform duration-200', expanded && 'rotate-180')} />
                  </button>
                ) : (
                  <Link
                    href={item.href}
                    data-testid={`a3-sidebar-page-${item.href.replaceAll('/', '-')}`}
                    className={cn(
                      'flex h-11 items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                      active
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
                  </Link>
                )}
                {grouped && expanded ? (
                  <div id={childrenId} className="space-y-1 pl-6" data-testid={childrenId}>
                    {itemChildren.map((child) => {
                      const childActive = pathname === child.href || pathname.startsWith(`${child.href}/`);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            'flex h-10 items-center rounded-lg px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                            childActive
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                          )}
                        >
                          <span className="truncate">{ownerPageLabels[child.href] ?? navLabels[child.href] ?? child.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <Link
          href="/a3/help"
          data-testid="a3-sidebar-help-link"
          title={sidebarCollapsed ? '帮助与手册' : undefined}
          className={cn(
            'absolute inset-x-3 bottom-[100px] flex h-11 items-center rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] text-sm font-medium text-[var(--a3-text-muted)] transition-colors hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
            sidebarCollapsed ? 'justify-center px-0' : 'gap-3 px-3',
          )}
        >
          <CircleHelp className="size-4 shrink-0" />
          <span className={cn('truncate', sidebarCollapsed && 'hidden')}>帮助与手册</span>
        </Link>

        <div
          title={sidebarCollapsed ? `${displayName} · ${studyGroup}` : undefined}
          className={cn('absolute inset-x-3 bottom-4 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] transition-[padding] duration-300', sidebarCollapsed ? 'p-2' : 'p-4')}
        >
          <div className={cn('flex items-center gap-3', sidebarCollapsed && 'justify-center')}>
            <div className="flex size-10 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
              {userInitial}
            </div>
            <div className={cn('min-w-0', sidebarCollapsed && 'hidden')}>
              <div className="truncate text-sm font-semibold">{displayName}</div>
              <div className="truncate text-xs text-[var(--a3-text-muted)]">{studyGroup}</div>
            </div>
          </div>
        </div>
      </aside>

      <div className={cn('transition-[padding] duration-300 ease-out', sidebarCollapsed ? 'md:pl-20' : 'md:pl-[248px]')}>
        <header className="sticky top-0 z-40 flex h-[72px] min-w-0 items-center justify-between gap-2 border-b border-[var(--a3-border)] bg-[var(--a3-surface)] px-3 backdrop-blur sm:px-4 md:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-controls="a3-primary-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              data-testid="a3-sidebar-toggle"
              className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] text-[var(--a3-text-muted)] transition-colors hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 md:flex"
            >
              {sidebarCollapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
            </button>
            <div className="md:hidden">
              <div className="size-10 overflow-hidden rounded-xl shadow-[0_10px_22px_rgba(37,99,235,0.22)]">
                <Image src="/a3-brand-icon.png" alt="" width={40} height={40} className="size-full object-cover" priority unoptimized />
              </div>
            </div>
            {focusedHeader && (
              <>
                <div className="hidden min-w-0 shrink overflow-hidden xl:block">
                  <div className="truncate whitespace-nowrap text-xl font-semibold">{messages.appName}</div>
                  <div className="truncate whitespace-nowrap text-xs font-medium uppercase tracking-wide text-[var(--a3-text-muted)]">
                    {messages.appNameEn}
                  </div>
                </div>
                <div className="ml-2 hidden h-8 w-px shrink-0 bg-[var(--a3-border)] xl:block 2xl:ml-8" />
                <h1 className="sr-only md:not-sr-only md:min-w-0 md:truncate md:whitespace-nowrap md:text-lg md:font-semibold md:text-[var(--a3-text)] xl:mr-4 2xl:mr-8">{focusedPageTitle}</h1>
              </>
            )}
            {pageTitle && (
              <h1 className="hidden text-xl font-semibold text-[var(--a3-text)] md:block">{pageTitle}</h1>
            )}
            <A3GlobalSearch className={cn((focusedHeader || compactHeader) && 'md:hidden')} />
          </div>

          <div className="flex min-w-0 shrink-0 items-center gap-1 text-[var(--a3-text-muted)] sm:gap-2">
            <A3TopActions compact />
            <div className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((open) => !open)}
                className="ml-0 flex items-center gap-1 rounded-lg px-1.5 py-1.5 hover:bg-[var(--a3-surface-muted)] sm:ml-1 sm:gap-2 sm:px-2"
                aria-expanded={userMenuOpen}
                aria-label={messages.openUserMenu}
              >
                <div className="flex size-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
                  {userInitial}
                </div>
                <span className="hidden text-sm font-medium text-[var(--a3-text)] sm:inline">{displayName}</span>
                <ChevronDown className={cn('hidden size-4 transition-transform sm:block', userMenuOpen && 'rotate-180')} />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-12 z-50 w-[260px] rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3 shadow-[var(--a3-shadow)]">
                  <div className="mb-2 flex items-center gap-3 rounded-xl bg-[var(--a3-surface-muted)] px-3 py-3">
                    <div className="flex size-10 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
                      {userInitial}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[var(--a3-text)]">{displayName}</div>
                      <div className="truncate text-xs text-[var(--a3-text-muted)]">{studyGroup}</div>
                    </div>
                  </div>
                  <Link
                    href="/a3/profile-setup"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]"
                  >
                    <UserRound className="size-4" />
                    {messages.profile}
                  </Link>
                  <Link
                    href="/a3/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]"
                  >
                    <Settings className="size-4" />
                    {messages.accountSettings}
                  </Link>
                  <button
                    type="button"
                    onClick={switchAccount}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]"
                  >
                    <Repeat2 className="size-4" />
                    {messages.switchAccount}
                  </button>
                  <button
                    type="button"
                    onClick={logout}
                    className="mt-2 flex w-full items-center gap-2 rounded-xl border border-rose-100 px-3 py-2 text-left text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:hover:bg-rose-950/40"
                  >
                    <LogOut className="size-4" />
                    {messages.logout}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className={cn('mx-auto max-w-[1720px] p-5 xl:p-6', focusedHeader && 'max-w-[1840px]')}>
          {children}
        </main>
      </div>
    </div>
  );
}
