'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Bell,
  ChartNoAxesCombined,
  Check,
  Lock,
  Phone,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { A3TopActions } from '@/components/a3/layout/a3-top-actions';
import { a3PatchJson } from '@/lib/a3/api-client';
import { cn } from '@/lib/utils';

type ConsentKey = 'learning' | 'notifications' | 'recommendation';
type ApiResult = {
  success: boolean;
  error?: string;
  user?: {
    privacyAccepted?: boolean;
    onboardingStep?: string;
  };
};

const permissionItems = [
  {
    key: 'account',
    title: '账号基础信息',
    desc: '用于创建和管理你的账号，保障账号安全与登录体验。',
    detail: '包含手机号、登录状态、角色身份、账号创建时间等最小必要信息。这部分信息是登录、找回密码和账号安全所必需。',
    tag: '必需',
    icon: User,
    tone: 'blue',
    locked: true,
  },
  {
    key: 'phone',
    title: '手机号',
    desc: '用于账号安全验证、找回密码及重要通知发送。',
    detail: '手机号仅用于登录验证、验证码发送、账号找回和必要安全提醒，不会公开展示给其他用户。',
    tag: '必需',
    icon: Phone,
    tone: 'emerald',
    locked: true,
  },
  {
    key: 'learning',
    title: '学习行为数据',
    desc: '记录学习进度、练习情况，帮助分析学习效果并优化内容。',
    detail: '包含学习时长、完成任务、测评结果、错题记录和知识点掌握情况，用于生成学习路径和成长报告。',
    tag: '可选',
    icon: ChartNoAxesCombined,
    tone: 'violet',
    locked: false,
  },
  {
    key: 'notifications',
    title: '通知提醒',
    desc: '接收课程更新、学习提醒、系统通知等重要信息。',
    detail: '开启后会接收课程更新、活动预约、学习报告和薄弱知识点提醒。你可以之后在系统设置中关闭。',
    tag: '可选',
    icon: Bell,
    tone: 'orange',
    locked: false,
  },
  {
    key: 'recommendation',
    title: '个性化推荐',
    desc: '基于兴趣与学习行为，为你推荐更合适的课程与内容。',
    detail: '开启后系统会结合学习画像、进度和测评结果推荐视频、题库、知识卡片和课堂资源。',
    tag: '可选',
    icon: Sparkles,
    tone: 'amber',
    locked: false,
  },
] as const;

const protectionItems = [
  { title: '数据加密存储', desc: '采用标准加密技术，保障数据在存储与传输过程中的安全。', icon: Lock, tone: 'blue' },
  { title: '最小必要授权', desc: '只在功能需要的范围内使用数据，不会过度获取你的信息。', icon: ShieldCheck, tone: 'emerald' },
  { title: '可随时撤回授权', desc: '你可以在系统设置中重新管理通知、推荐和学习行为数据授权。', icon: RefreshCw, tone: 'violet' },
] as const;

const toneClass = {
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-200',
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-200',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-200',
  orange: 'bg-orange-50 text-orange-500 dark:bg-orange-950/50 dark:text-orange-200',
  amber: 'bg-amber-50 text-amber-500 dark:bg-amber-950/50 dark:text-amber-200',
} as const;

export function PrivacyConsentPage() {
  const router = useRouter();
  const [accepted, setAccepted] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [documentPanel, setDocumentPanel] = useState<'user' | 'privacy' | null>(null);
  const [optionalConsents, setOptionalConsents] = useState<Record<ConsentKey, boolean>>({
    learning: true,
    notifications: true,
    recommendation: true,
  });
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(value: boolean) {
    setSubmitting(true);
    setMessage('');
    const consents = value
      ? {
          learningData: optionalConsents.learning,
          courseNotifications: optionalConsents.notifications,
          reportNotifications: optionalConsents.notifications,
          recommendation: optionalConsents.recommendation,
        }
      : {
          learningData: false,
          courseNotifications: false,
          reportNotifications: false,
          recommendation: false,
        };
    const result = await a3PatchJson<ApiResult>('/api/profiles/me/', { privacyAccepted: value, consents });
    setSubmitting(false);

    if (!result.success) {
      setMessage(result.error ?? '保存授权状态失败，请确认后端服务正常');
      return;
    }

    if (result.user) {
      window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: result.user }));
    }
    router.push('/a3/profile-setup');
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_10%_100%,rgba(37,99,235,0.10),transparent_32%),radial-gradient(circle_at_86%_92%,rgba(124,58,237,0.08),transparent_30%),linear-gradient(135deg,var(--a3-bg-soft)_0%,var(--a3-bg)_48%,var(--a3-bg-soft)_100%)] text-[var(--a3-text)]">
      <header className="flex h-[88px] items-center justify-between border-b border-[var(--a3-border)] bg-[var(--a3-surface)] px-4 backdrop-blur-xl md:px-8 xl:px-11">
        <Link href="/a3/login" className="flex items-center gap-3">
          <div className="size-12 overflow-hidden rounded-[14px] shadow-[0_14px_30px_rgba(37,99,235,0.24)]">
            <Image src="/a3-brand-icon.png" alt="" width={48} height={48} className="size-full object-cover" priority unoptimized />
          </div>
          <div>
            <div className="text-[22px] font-semibold leading-tight">智学引擎</div>
            <div className="text-xs font-medium text-[var(--a3-text-muted)]">AI Learning</div>
          </div>
        </Link>
        <div className="hidden md:block"><A3TopActions /></div>
      </header>

      <main className="mx-auto max-w-[1500px] px-3 py-6 sm:px-6 xl:px-8">
        <section className="rounded-[24px] border border-[var(--a3-border)] bg-[var(--a3-surface)] p-4 shadow-[var(--a3-shadow)] sm:p-6 xl:rounded-[28px] xl:p-8">
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_430px]">
            <div className="min-w-0">
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
                <div className="flex size-16 shrink-0 items-center justify-center rounded-[22px] bg-gradient-to-br from-blue-500 to-violet-600 text-white shadow-[0_20px_44px_rgba(37,99,235,0.24)] sm:size-[96px] sm:rounded-[28px]">
                  <Check className="size-10 sm:size-14" />
                </div>
                <div>
                  <h1 className="text-3xl font-semibold leading-tight sm:text-[40px]">隐私授权说明</h1>
                  <p className="mt-3 text-base leading-7 text-[var(--a3-text-muted)] sm:text-lg">授权结果会写回个人资料接口，用于决定后续画像、提醒和推荐能力是否启用。</p>
                </div>
              </div>

              <div className="space-y-3">
                {permissionItems.map((item) => {
                  const Icon = item.icon;
                  const enabled = item.locked || optionalConsents[item.key as ConsentKey];
                  const isExpanded = expanded === item.key;
                  return (
                    <div key={item.key} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-4 py-4 shadow-[0_8px_26px_rgba(30,64,175,0.04)] sm:px-5">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
                        <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
                          <span className={`flex size-12 shrink-0 items-center justify-center rounded-full sm:size-14 ${toneClass[item.tone]}`}>
                            <Icon className="size-6 sm:size-7" />
                          </span>
                          <div className="min-w-0">
                            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold sm:text-xl">
                              {item.title}
                              <span className="rounded-lg bg-blue-50 px-2.5 py-1 text-sm font-semibold text-blue-600 dark:bg-blue-950/50 dark:text-blue-200">{item.tag}</span>
                            </h2>
                            <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{item.desc}</p>
                          </div>
                        </div>
                        <div className="flex w-full shrink-0 items-center justify-between gap-3 border-t border-[var(--a3-border)] pt-3 sm:w-auto sm:justify-end sm:border-t-0 sm:pt-0">
                          <button
                            type="button"
                            onClick={() => setExpanded(isExpanded ? null : item.key)}
                            className="whitespace-nowrap text-sm font-medium text-blue-600 hover:text-blue-700"
                          >
                            {isExpanded ? '收起详情' : '查看详情'}
                          </button>
                          {item.locked ? (
                            <span className="flex size-10 items-center justify-center rounded-full bg-blue-600 text-white">
                              <Check className="size-5" />
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                const key = item.key as ConsentKey;
                                setOptionalConsents((current) => ({ ...current, [key]: !current[key] }));
                              }}
                              className={cn('relative h-8 w-14 rounded-full transition-colors', enabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700')}
                              aria-label={`${item.title}授权开关`}
                              aria-pressed={enabled}
                            >
                              <span className={cn('absolute top-1 size-6 rounded-full bg-white shadow transition-transform', enabled ? 'translate-x-7' : 'translate-x-1')} />
                            </button>
                          )}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="mt-4 rounded-xl bg-[var(--a3-surface-muted)] px-4 py-3 text-sm leading-6 text-[var(--a3-text-muted)]">
                          {item.detail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {documentPanel && (
                <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/70 p-5 text-sm leading-7 text-slate-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100">
                  <div className="mb-2 text-base font-semibold text-slate-950 dark:text-blue-50">
                    {documentPanel === 'user' ? '用户协议摘要' : '隐私政策摘要'}
                  </div>
                  {documentPanel === 'user'
                    ? '你需要遵守账号安全、学习资源使用、课堂互动规范等约定。平台会保护你的账号权益，也会对异常使用行为进行必要限制。'
                    : '平台只会在学习服务所需范围内处理数据，并提供授权管理、撤回和账号资料修改能力。可选授权会写入个人资料设置，后续可在设置页重新调整。'}
                </div>
              )}
            </div>

            <aside className="min-w-0">
              <div className="sticky top-6 rounded-[24px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-6 shadow-[var(--a3-shadow)]">
                <div className="mx-auto h-[170px] max-w-[330px]">
                  <img src="/a3/assets/onboarding/privacy-shield-hero.webp" alt="数据安全保护盾牌" className="h-full w-full object-contain" />
                </div>
                <h2 className="mt-3 text-2xl font-semibold">我们如何保护你的数据</h2>
                <div className="mt-5 rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-5">
                  {protectionItems.map((item, index) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.title} className={`grid grid-cols-[48px_1fr] gap-4 py-5 ${index ? 'border-t border-[var(--a3-border)]' : ''}`}>
                        <span className={`flex size-11 items-center justify-center rounded-full ${toneClass[item.tone]}`}>
                          <Icon className="size-6" />
                        </span>
                        <div>
                          <h3 className="font-semibold">{item.title}</h3>
                          <p className="mt-1 text-sm leading-6 text-[var(--a3-text-muted)]">{item.desc}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>
          </div>

          <div className="mt-8 flex flex-col gap-4 border-t border-[var(--a3-border)] pt-6 xl:flex-row xl:items-center xl:justify-between">
            <label className="flex min-w-0 items-start gap-3 text-sm leading-6 text-[var(--a3-text-muted)]">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1 size-5 shrink-0 accent-blue-600" />
              <span>
                我已阅读并同意
                <button type="button" onClick={() => setDocumentPanel('user')} className="mx-1 font-semibold text-blue-600">《用户协议》</button>
                <button type="button" onClick={() => setDocumentPanel('privacy')} className="font-semibold text-blue-600">《隐私政策》</button>
              </span>
            </label>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
              <Button disabled={!accepted || submitting} onClick={() => submit(true)} className="h-12 min-w-[240px] rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 text-base">
                {submitting ? '正在保存...' : '同意并继续'}
              </Button>
              <Button variant="outline" disabled={submitting} onClick={() => submit(false)} className="h-12 min-w-[180px] rounded-lg border-blue-200 bg-white text-base text-slate-700">
                暂不授权
              </Button>
            </div>
          </div>

          {message && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
              {message}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
