'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Bell, Check, CircleCheck, Globe2, LockKeyhole, LogOut, Moon, Repeat2, Save, ServerCog, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { a3GetJson, a3PatchJson, a3PostJson } from '@/lib/a3/api-client';
import { getA3LocaleLabel, useA3Locale, type A3Locale } from '@/lib/a3/i18n';
import type { A3SystemCheck, A3SystemCheckStatus, A3SystemHealthResponse } from '@/lib/a3/system-types';
import { cn } from '@/lib/utils';

type ConsentState = {
  courseNotifications: boolean;
  reportNotifications: boolean;
  learningData: boolean;
  recommendation: boolean;
};

type ProfileResponse = {
  success: boolean;
  error?: string;
  user?: {
    displayName?: string;
    email?: string;
    studentId?: string;
    school?: string;
  };
  profile?: {
    extraProfile?: {
      consents?: Partial<ConsentState>;
    };
  } | null;
};

const defaultConsents: ConsentState = {
  courseNotifications: true,
  reportNotifications: true,
  learningData: true,
  recommendation: true,
};

function SettingPanel({ title, description, icon: Icon, children }: { title: string; description: string; icon: typeof UserRound; children: React.ReactNode }) {
  return (
    <section className="rounded-[16px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-[var(--a3-shadow)]">
      <div className="flex items-start gap-3 border-b border-[var(--a3-border)] px-5 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200">
          <Icon className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-[var(--a3-text)]">{title}</h2>
          <p className="mt-1 text-sm text-[var(--a3-text-muted)]">{description}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function ToggleRow({ title, description, checked, disabled, onChange }: { title: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-5 rounded-xl bg-[var(--a3-surface-muted)] px-4 py-3">
      <div>
        <div className="font-medium text-[var(--a3-text)]">{title}</div>
        <div className="mt-1 text-sm text-[var(--a3-text-muted)]">{description}</div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60', checked ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700')}
        aria-pressed={checked}
      >
        <span className={cn('absolute top-1 size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
      </button>
    </div>
  );
}

function statusLabel(status: A3SystemCheckStatus) {
  if (status === 'ok') return '正常';
  if (status === 'warning') return '需配置';
  return '异常';
}

function statusClassName(status: A3SystemCheckStatus) {
  if (status === 'ok') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200';
  if (status === 'warning') return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-200';
  return 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200';
}

function StatusBadge({ status }: { status: A3SystemCheckStatus }) {
  const Icon = status === 'ok' ? CircleCheck : AlertTriangle;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', statusClassName(status))}>
      <Icon className="size-3.5" />
      {statusLabel(status)}
    </span>
  );
}

function SystemCheckList({ title, response, loading }: { title: string; response: A3SystemHealthResponse | null; loading: boolean }) {
  const checks = response?.checks ?? [];
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-[var(--a3-text)]">{title}</h3>
        {loading ? <span className="text-xs text-[var(--a3-text-muted)]">检查中</span> : response ? <StatusBadge status={response.overallStatus} /> : <StatusBadge status="error" />}
      </div>
      {response?.error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{response.error}</div>}
      <div className="space-y-2">
        {checks.map((item) => (
          <SystemCheckItem key={item.name} item={item} />
        ))}
        {!loading && !checks.length && !response?.error && (
          <div className="rounded-lg bg-[var(--a3-surface-solid)] px-3 py-4 text-center text-sm text-[var(--a3-text-muted)]">暂无自检结果</div>
        )}
      </div>
    </div>
  );
}

function SystemCheckItem({ item }: { item: A3SystemCheck }) {
  const details = Object.entries(item.detail ?? {}).filter(([, value]) => value !== '');
  return (
    <div className="rounded-lg bg-[var(--a3-surface-solid)] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-[var(--a3-text)]">{item.name}</div>
          <div className="mt-1 text-sm text-[var(--a3-text-muted)]">{item.message}</div>
        </div>
        <StatusBadge status={item.status} />
      </div>
      {details.length > 0 && (
        <div className="mt-2 grid gap-1 text-xs text-[var(--a3-text-muted)]">
          {details.slice(0, 5).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3">
              <span>{key}</span>
              <span className="max-w-[220px] truncate text-right">{Array.isArray(value) ? value.join(', ') : String(value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsView() {
  const router = useRouter();
  const user = useA3CurrentUser();
  const { locale, setLocale } = useA3Locale();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [school, setSchool] = useState(user?.school ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [studentId, setStudentId] = useState(user?.studentId ?? '');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    return window.localStorage.getItem('a3-theme') === 'dark' ? 'dark' : 'light';
  });
  const [consents, setConsents] = useState<ConsentState>(defaultConsents);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);
  const [backendHealth, setBackendHealth] = useState<A3SystemHealthResponse | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<A3SystemHealthResponse | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      const result = await a3GetJson<ProfileResponse>('/api/profiles/me/');
      if (!active || !result.success) return;
      if (result.user) {
        setDisplayName(result.user.displayName ?? '');
        setSchool(result.user.school ?? '');
        setEmail(result.user.email ?? '');
        setStudentId(result.user.studentId ?? '');
      }
      setConsents({ ...defaultConsents, ...(result.profile?.extraProfile?.consents ?? {}) });
    }
    void loadProfile();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function loadHealth() {
      setLoadingHealth(true);
      const [backendResult, runtimeResult] = await Promise.all([
        a3GetJson<A3SystemHealthResponse>('/api/system/health/'),
        fetch('/api/a3/system/runtime', { cache: 'no-store' })
          .then((response) => response.json() as Promise<A3SystemHealthResponse>)
          .catch((error) => ({ success: false, error: error instanceof Error ? error.message : '运行时自检失败', overallStatus: 'error', checks: [] }) as A3SystemHealthResponse),
      ]);
      if (!active) return;
      setBackendHealth(backendResult);
      setRuntimeHealth(runtimeResult);
      setLoadingHealth(false);
    }
    void loadHealth();
    return () => {
      active = false;
    };
  }, []);

  function applyTheme(nextTheme: 'light' | 'dark') {
    setTheme(nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    document.documentElement.dataset.a3Theme = nextTheme;
    window.localStorage.setItem('a3-theme', nextTheme);
  }

  async function saveProfile() {
    setSaving(true);
    setMessage('');
    const result = await a3PatchJson<ProfileResponse>('/api/profiles/me/', { displayName, school, email, studentId });
    setSaving(false);
    if (!result.success) {
      setMessage(result.error ?? '保存失败，请确认后端服务正常');
      return;
    }
    if (result.user) window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: result.user }));
    setMessage('账号资料已保存');
  }

  async function updateConsent(key: keyof ConsentState, value: boolean) {
    const next = { ...consents, [key]: value };
    setConsents(next);
    setSavingConsent(true);
    const result = await a3PatchJson<ProfileResponse>('/api/profiles/me/', { consents: next });
    setSavingConsent(false);
    if (!result.success) {
      setConsents(consents);
      setMessage(result.error ?? '授权设置保存失败');
      return;
    }
    setMessage('授权设置已保存');
  }

  async function logout() {
    await a3PostJson('/api/auth/logout/', {});
    window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: null }));
    window.location.assign('/a3/login');
  }

  async function switchAccount() {
    await a3PostJson('/api/auth/logout/', {});
    window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: null }));
    window.location.assign('/a3/login?switch=1');
  }

  return (
    <div className="mx-auto max-w-[1280px] space-y-5">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="text-3xl font-semibold text-[var(--a3-text)]">系统设置</h1>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">管理账号资料、界面偏好、通知和隐私授权。</p>
        </div>
        {message && <div className={cn('rounded-xl px-4 py-2 text-sm font-medium', message.includes('失败') ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')}>{message}</div>}
      </div>

      <SettingPanel title="运行环境自检" description="检查 Django 后端、知识库、短信验证码和 AI 多模态模型配置，不展示任何密钥。" icon={ServerCog}>
        <div className="grid gap-4 lg:grid-cols-2">
          <SystemCheckList title="Django 后端" response={backendHealth} loading={loadingHealth} />
          <SystemCheckList title="Next.js / AI 运行时" response={runtimeHealth} loading={loadingHealth} />
        </div>
      </SettingPanel>

      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <div className="space-y-5">
          <SettingPanel title="账号资料" description="这些信息会同步到首页、报告页和顶部用户区。" icon={UserRound}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2"><span className="text-sm font-medium text-[var(--a3-text)]">姓名 / 昵称</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="请输入姓名或昵称" /></label>
              <label className="space-y-2"><span className="text-sm font-medium text-[var(--a3-text)]">学校 / 学院</span><Input value={school} onChange={(event) => setSchool(event.target.value)} placeholder="请输入学校或学院" /></label>
              <label className="space-y-2"><span className="text-sm font-medium text-[var(--a3-text)]">邮箱</span><Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="用于通知和找回账号" /></label>
              <label className="space-y-2"><span className="text-sm font-medium text-[var(--a3-text)]">学号 / 工号</span><Input value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="请输入学号或工号" /></label>
            </div>
            <Button disabled={saving} onClick={saveProfile} className="mt-5 h-10 bg-blue-600 hover:bg-blue-700">
              <Save className="mr-2 size-4" />{saving ? '保存中...' : '保存资料'}
            </Button>
          </SettingPanel>

          <SettingPanel title="通知设置" description="控制课程提醒、测评反馈和学习报告推送。" icon={Bell}>
            <div className="space-y-3">
              <ToggleRow title="课程与活动提醒" description="课程更新、预约、学习打卡挑战。" checked={consents.courseNotifications} disabled={savingConsent} onChange={(value) => updateConsent('courseNotifications', value)} />
              <ToggleRow title="学习报告推送" description="周报、月报和薄弱知识点提醒。" checked={consents.reportNotifications} disabled={savingConsent} onChange={(value) => updateConsent('reportNotifications', value)} />
            </div>
          </SettingPanel>

          <SettingPanel title="隐私与数据授权" description="控制个性化学习所需的数据使用范围。" icon={ShieldCheck}>
            <div className="space-y-3">
              <ToggleRow title="学习行为数据" description="用于生成学习路径、测评分析和进度反馈。" checked={consents.learningData} disabled={savingConsent} onChange={(value) => updateConsent('learningData', value)} />
              <ToggleRow title="个性化推荐" description="用于推荐课程、题库、知识卡片和课堂资源。" checked={consents.recommendation} disabled={savingConsent} onChange={(value) => updateConsent('recommendation', value)} />
            </div>
          </SettingPanel>
        </div>

        <div className="space-y-5">
          <SettingPanel title="界面偏好" description="语言和明暗主题会保存到当前浏览器。" icon={Globe2}>
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-sm font-medium text-[var(--a3-text)]">语言</div>
                <div className="grid grid-cols-2 gap-2">
                  {(['zh-CN', 'en-US'] as A3Locale[]).map((item) => (
                    <button key={item} type="button" onClick={() => setLocale(item)} className={cn('flex h-10 items-center justify-center gap-2 rounded-xl border text-sm', locale === item ? 'border-blue-500 bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-200' : 'border-[var(--a3-border)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]')}>
                      {locale === item && <Check className="size-4" />}{getA3LocaleLabel(item)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-sm font-medium text-[var(--a3-text)]">主题</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => applyTheme('light')} className={cn('flex h-10 items-center justify-center gap-2 rounded-xl border text-sm', theme === 'light' ? 'border-blue-500 bg-blue-50 font-semibold text-blue-700' : 'border-[var(--a3-border)] hover:bg-[var(--a3-surface-muted)]')}><Sun className="size-4" />浅色</button>
                  <button type="button" onClick={() => applyTheme('dark')} className={cn('flex h-10 items-center justify-center gap-2 rounded-xl border text-sm', theme === 'dark' ? 'border-blue-500 bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-200' : 'border-[var(--a3-border)] hover:bg-[var(--a3-surface-muted)]')}><Moon className="size-4" />深色</button>
                </div>
              </div>
            </div>
          </SettingPanel>

          <SettingPanel title="账号安全" description="切换账号或退出当前登录状态。" icon={LockKeyhole}>
            <div className="space-y-3">
              <Button variant="outline" onClick={switchAccount} className="h-11 w-full justify-start"><Repeat2 className="mr-2 size-4" />切换账号</Button>
              <Button variant="outline" onClick={() => router.push('/a3/forgot-password')} className="h-11 w-full justify-start"><LockKeyhole className="mr-2 size-4" />修改密码</Button>
              <Button variant="outline" onClick={logout} className="h-11 w-full justify-start border-rose-200 text-rose-600 hover:bg-rose-50"><LogOut className="mr-2 size-4" />退出登录</Button>
            </div>
          </SettingPanel>
        </div>
      </div>
    </div>
  );
}
