'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, LogOut, Repeat2, Settings, UserRound } from 'lucide-react';
import { useState } from 'react';
import {
  A3_SHELL_BYPASS_PATHS,
  useA3CurrentUser,
} from '@/components/a3/auth/a3-auth-gate';
import { A3GlobalSearch } from '@/components/a3/layout/a3-global-search';
import { A3TopActions } from '@/components/a3/layout/a3-top-actions';
import { a3PostJson } from '@/lib/a3/api-client';
import { useA3Locale } from '@/lib/a3/i18n';
import { a3GetActiveNavHref, a3NavItems } from '@/lib/a3/navigation';
import { cn } from '@/lib/utils';

export function A3Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useA3CurrentUser();
  const { messages } = useA3Locale();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  if (A3_SHELL_BYPASS_PATHS.has(pathname)) return <>{children}</>;

  const displayName = user?.displayName?.trim() || messages.unnamedUser;
  const userInitial = displayName.slice(0, 1);
  const studyGroup = user?.school ? `${user.school}${messages.studyGroupSuffix}` : messages.defaultStudyGroup;
  const focusedHeader = pathname === '/a3/classroom' || pathname === '/a3/coaching';
  const pageTitle = pathname === '/a3/report' ? messages.reportTitle : pathname === '/a3/help' ? messages.helpCenter : '';
  const compactHeader = pathname === '/a3/dashboard' || Boolean(pageTitle);
  const visibleNavItems = a3NavItems.filter((item) => !item.roles || (user?.role && item.roles.includes(user.role)));
  const activeNavHref = a3GetActiveNavHref(pathname);
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
  };

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
    <div className="min-h-screen bg-[var(--a3-bg)] text-[var(--a3-text)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-[var(--a3-border)] bg-[var(--a3-surface-solid)] md:block">
        <div className="flex h-20 items-center gap-3 px-5">
          <div className="flex size-12 items-center justify-center rounded-[14px] bg-gradient-to-br from-blue-500 to-violet-600 text-xl font-bold text-white shadow-[0_10px_22px_rgba(37,99,235,0.22)]">
            A
          </div>
          <div>
            <div className="text-[22px] font-semibold leading-tight text-[var(--a3-text)]">{messages.appName}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {messages.appNameEn}
            </div>
          </div>
        </div>

        <nav className="max-h-[calc(100vh-176px)] space-y-2 overflow-y-auto px-4 pb-4">
          {visibleNavItems.map((item) => {
            const active = activeNavHref === item.href;
            const Icon = item.icon;
            return (
              <div key={item.href} className="space-y-1">
                <Link
                  href={item.href}
                  className={cn(
                    'flex h-11 items-center gap-3 rounded-[10px] px-4 text-[15px] font-medium text-[var(--a3-text-muted)] transition-colors',
                    active
                      ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-[0_10px_22px_rgba(37,99,235,0.24)]'
                      : 'hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                  )}
                >
                  <Icon className="size-4" />
                  {navLabels[item.href] ?? item.label}
                </Link>
                {item.children?.length ? (
                  <div className="space-y-1 pl-7" data-testid={`a3-sidebar-children-${item.href.replaceAll('/', '-')}`}>
                    {item.children.map((child) => {
                      const childActive = pathname === child.href || pathname.startsWith(`${child.href}/`);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            'block rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                            childActive
                              ? 'bg-blue-50 text-blue-700'
                              : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                          )}
                        >
                          {navLabels[child.href] ?? child.label}
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <div className="absolute inset-x-3 bottom-4 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
              {userInitial}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{displayName}</div>
              <div className="truncate text-xs text-[var(--a3-text-muted)]">{studyGroup}</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="md:pl-[248px]">
        <header className="sticky top-0 z-40 flex h-[72px] min-w-0 items-center justify-between gap-2 border-b border-[var(--a3-border)] bg-[var(--a3-surface)] px-3 backdrop-blur sm:px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="md:hidden">
              <div className="flex size-10 items-center justify-center rounded-xl bg-blue-600 font-bold text-white shadow-[0_10px_22px_rgba(37,99,235,0.22)]">
                A
              </div>
            </div>
            {focusedHeader && (
              <div className="mr-8 hidden items-center gap-3 md:flex">
                <div>
                  <div className="text-xl font-semibold">{messages.appName}</div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--a3-text-muted)]">
                    {messages.appNameEn}
                  </div>
                </div>
                <div className="ml-8 h-8 w-px bg-[var(--a3-border)]" />
                <div className="text-lg font-semibold text-[var(--a3-text)]">
                  {pathname === '/a3/coaching' ? messages.coachingTitle : messages.classroomTitle}
                </div>
              </div>
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
