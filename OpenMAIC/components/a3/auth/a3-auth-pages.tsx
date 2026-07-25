'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  ChevronDown,
  Check,
  Clock3,
  Eye,
  EyeOff,
  GraduationCap,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  Phone,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  Target,
  User,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { A3ReviewLoginPanel } from '@/components/a3/auth/a3-review-login-panel';
import { A3TopActions } from '@/components/a3/layout/a3-top-actions';
import { useVerificationCode } from '@/components/a3/auth/use-verification-code';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { a3GetJson, a3PatchJson, a3PostJson } from '@/lib/a3/api-client';
import { getA3NextPathForUser, resolveA3LoginDestination } from '@/lib/a3/auth-navigation';
import {
  createEmptyLearningProfile,
  getMissingLearningProfileFields,
  mergeInterviewProfile,
  normalizeLearningProfileForOptions,
  transitionProfileInterviewUiState,
} from '@/lib/a3/profile-setup';
import {
  profileDimensionLabel,
  profileSourceLabel,
  profileStatusLabel,
  profileStatusTone,
  summarizeProfileTimelineEntry,
  summarizeProfileUpdateEvidence,
  type DynamicProfileFeedResponse,
  type ProfileTimelineEntry,
} from '@/lib/a3/profile-timeline';
import type {
  A3LearningProfile,
  A3PublicUser,
  A3UserRole,
  LearningProfileOptions,
  LearningProfileOptionsResponse,
  ProfileOption,
} from '@/lib/a3/auth-types';

type ApiResult = {
  success: boolean;
  error?: string;
  user?: Partial<A3PublicUser> & { onboardingStep?: string; profileCompleted?: boolean };
  profileReadiness?: {
    score: number;
    status: 'ready' | 'partial' | 'incomplete';
    summary: string;
    missingFields?: Array<{ field: string; label: string }>;
  };
  nextAction?: { label: string; href: string; reason?: string };
  generated?: { path: boolean; studyPlan: boolean };
  planningDeferred?: boolean;
  planningDeferredReason?: string;
  personalizationImpact?: {
    profileInputs: {
      foundationLevel?: string;
      dailyStudyTime?: number;
      pace?: string;
      weakPoints?: string[];
      learningGoals?: string[];
      learningPreferences?: string[];
    };
    pathFocus: Array<{ title: string; reason: string; order: number }>;
    plan: {
      dailyMinutes?: number;
      durationDays?: number;
      mode?: string;
      reason?: string;
    };
    explanation?: string;
  };
  generationError?: string;
};

type ProfileInterviewResult = {
  success: boolean;
  error?: string;
  traceId?: string;
  user?: Partial<A3PublicUser> & { onboardingStep?: string; profileCompleted?: boolean };
  profile?: {
    grade?: string;
    majorDirection?: string;
    foundationLevel?: string;
    dailyMinutes?: number;
    learningGoals?: string[];
    weakPoints?: string[];
    resourcePreferences?: string[];
    cognitiveStyle?: string;
    learningHistory?: string;
    motivationRisk?: string;
  };
  profileReadiness?: {
    dimensionCount?: number;
    status?: 'ready' | 'partial' | string;
    missingDimensions?: Array<{ field: string; label: string }>;
    interviewComplete?: boolean;
  };
  missingDimensions?: Array<{ field: string; label: string }>;
  askFields?: Array<{ field: string; label: string }>;
  askStrategy?: ProfileInterviewAskStrategy;
  nextQuestion?: string;
  interviewComplete?: boolean;
  profileCommitted?: boolean;
  planningDeferred?: boolean;
  planningDeferredReason?: string;
  interviewSession?: ProfileInterviewSession;
  generated?: {
    path?: unknown;
    studyPlan?: boolean;
  };
};

type ProfileInterviewSession = {
  schemaVersion?: string;
  turnCount?: number;
  latestTraceId?: string;
  profileSnapshot?: ProfileInterviewResult['profile'];
  profileReadiness?: ProfileInterviewResult['profileReadiness'];
  missingDimensions?: Array<{ field: string; label: string }>;
  askFields?: Array<{ field: string; label: string }>;
  askStrategy?: ProfileInterviewAskStrategy;
  nextQuestion?: string;
  interviewComplete?: boolean;
  profileCommitted?: boolean;
  planningDeferred?: boolean;
  planningDeferredReason?: string;
  generated?: ProfileInterviewResult['generated'];
  confirmedAt?: string;
  messages?: Array<{ role?: string; content?: string; createdAt?: string }>;
  updatedAt?: string;
};

type ProfileInterviewAskStrategy = {
  name?: string;
  priorityOrder?: string[];
  reason?: string;
};

type ProfileInterviewSessionResult = {
  success: boolean;
  error?: string;
  interviewSession?: ProfileInterviewSession;
};

type ProfileInterviewMessage = {
  role: 'agent' | 'user';
  content: string;
};

const defaultLearningProfileOptions: LearningProfileOptions = {
  majorDirections: ['计算机科学与技术', '软件工程', '网络工程', '信息安全', '人工智能'],
  grades: ['大一', '大二', '大三', '大四', '研究生', '其他'],
  foundationLevels: ['基础较弱', '基础一般', '基础较好', '基础扎实'],
  learningGoals: ['掌握操作系统', '应对课程考试', '补齐进程与内存管理', '完成课程实验', '准备考研专业课'],
  learningPreferences: ['课堂讲解', '图解流程', '例题推导', '动画演示', '互动练习', '错题复盘', '代码实验'],
  expectedResources: ['视频课程', '课件讲义', '练习题库', '知识卡片', '算法演示', '代码实验'],
  dailyStudyTimes: ['30', '60', '120', '180'],
  paces: [
    { value: 'relaxed', label: '稳扎稳打' },
    { value: 'standard', label: '标准节奏' },
    { value: 'intensive', label: '强化提升' },
  ],
  weakPoints: [
    { value: '处理机调度算法', label: '处理机调度算法', chapter: '第 3 章 · 处理机调度与死锁', difficulty: 3 },
    { value: '同步互斥与信号量', label: '同步互斥与信号量', chapter: '第 4 章 · 进程同步与互斥', difficulty: 4 },
    { value: '虚拟内存与页面置换', label: '虚拟内存与页面置换', chapter: '第 6 章 · 虚拟内存管理', difficulty: 4 },
  ],
};

function normalizeMultiSelection(selected: unknown, values: string[]) {
  const allowed = new Set(values);
  const source = Array.isArray(selected)
    ? selected
    : selected && typeof selected === 'object'
      ? Object.values(selected).flatMap((value) => (Array.isArray(value) ? value : [value]))
      : [];
  const next = source.map((item) => String(item).trim()).filter((item) => allowed.has(item));
  return next;
}

function buildProfileInterviewExample(courseTitle: string) {
  return `我正在学习${courseTitle || '当前课程'}，基础一般，目标是补齐核心概念并能完成课程练习。每天大约 40 分钟，喜欢图解、例题、实验和错题复盘。现在最不确定的是课程里的关键概念、典型题型和实践应用。`;
}

function buildProfileInterviewPlaceholder(courseTitle: string) {
  return `例如：我正在学习${courseTitle || '当前课程'}，基础一般，目标是期末复习或考研，每天 40 分钟，喜欢图解、例题和实验，请说明你最薄弱的知识点。`;
}

async function postJson(url: string, body: unknown): Promise<ApiResult> {
  return a3PostJson<ApiResult>(url, body);
}

async function patchJson(url: string, body: unknown): Promise<ApiResult> {
  return a3PatchJson<ApiResult>(url, body);
}

function syncA3User(user?: ApiResult['user']) {
  if (user) window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: user }));
}

function AuthFrame({ children, variant = 'learning' }: { children: React.ReactNode; variant?: 'learning' | 'secure' }) {
  const secureFeatures: Array<[string, string, LucideIcon]> = [
    ['账号验证', '登录、注册和找回密码都通过真实后端接口校验。', ShieldCheck],
    ['状态续接', '系统按账号的首启进度进入欢迎、隐私授权或画像采集。', Check],
    ['数据边界', '学习画像、计划和报告只在授权后进入个性化流程。', Lock],
  ];

  return (
    <div className="min-h-screen bg-[#f4f7ff] text-slate-950 [--a3-border:rgba(203,213,225,0.9)] [--a3-surface-solid:#ffffff] [--a3-surface-muted:#f8fafc] [--a3-text:#0f172a] [--a3-text-muted:#64748b]">
      <header className="flex h-[88px] items-center justify-between border-b border-slate-200/80 bg-white/75 px-5 backdrop-blur md:px-10">
        <Link href="/a3" className="flex items-center gap-3" aria-label="返回智学引擎首页">
          <div className="size-12 overflow-hidden rounded-[14px] shadow-[0_10px_22px_rgba(37,99,235,0.22)]">
            <Image src="/a3-brand-icon.png" alt="" width={48} height={48} className="size-full object-cover" priority unoptimized />
          </div>
          <div>
            <div className="text-[22px] font-semibold leading-tight">智学引擎</div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">AI Learning</div>
          </div>
        </Link>
        <div className="hidden md:block"><A3TopActions showThemeToggle={false} /></div>
      </header>

      <main className="mx-auto grid min-h-[calc(100vh-88px)] max-w-[1480px] items-center gap-8 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_500px] lg:px-10 xl:gap-12">
        <section className="hidden lg:block">
          {variant === 'learning' ? (
            <LearningPreviewPanel />
          ) : (
            <>
              <div className="max-w-[720px]">
                <p className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-blue-600">ACCOUNT SECURITY</p>
                <h1 className="text-5xl font-semibold leading-tight tracking-[-0.02em]">验证身份后继续学习。</h1>
                <p className="mt-6 text-xl leading-9 text-slate-600">
                  账号、验证码和学习画像按最小必要原则处理，关键操作会写回后端并保留可追踪状态。
                </p>
              </div>
              <div className="mt-10 grid max-w-[860px] grid-cols-3 gap-4">
                {secureFeatures.map(([title, desc, Icon]) => (
                  <div key={title} className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.06)]">
                    <Icon className="size-7 text-blue-600" />
                    <div className="mt-3 text-base font-semibold">{title}</div>
                    <div className="mt-1 text-sm leading-6 text-slate-500">{desc}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
        {children}
      </main>
    </div>
  );
}

function LearningPreviewPanel() {
  const workflow = [
    ['登录续接', '按账号状态进入今日任务、首启流程或教师工作台。', KeyRound],
    ['本地知识库', '上传资料完成索引后，课堂和辅导会带来源引用。', BookOpen],
    ['个性化计划', '画像、诊断和测评结果共同决定学习路径。', Target],
    ['AI 辅导闭环', '提问、练习、错题和报告写回同一学习记录。', Bot],
  ] as const;
  const principles = ['真实接口', '可追踪状态', '授权后个性化'] as const;

  return (
    <div data-testid="a3-login-product-flow" className="max-w-[860px]">
      <div className="mb-7">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-blue-600">A3 LEARNING ENGINE</p>
        <h1 className="max-w-[760px] text-5xl font-semibold leading-tight tracking-[-0.02em]">登录后回到真实的学习闭环。</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {workflow.map(([title, desc, Icon]) => (
          <div key={title} className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-[0_16px_44px_rgba(15,23,42,0.06)]">
            <div className="flex size-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Icon className="size-6" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-slate-950">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{desc}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-[24px] border border-slate-200 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white">
            <ShieldCheck className="size-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">页面展示不替代真实数据。</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              登录后显示的任务、资料、测评和报告都来自后端接口；这里仅说明产品流向，不写死个人学习结果。
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {principles.map((item) => (
            <span key={item} className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function FormCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[22px] border border-slate-200/90 bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.10)] md:p-9">
      <div>
        <h1 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">{title}</h1>
        <p className="mt-3 text-base leading-7 text-slate-500">{subtitle}</p>
      </div>
      <div className="mt-8">{children}</div>
    </section>
  );
}

function FieldIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />;
}

type ErrorAction = {
  label: string;
  href: string;
};

const a3WorkspaceLabels: Record<A3UserRole, string> = {
  student: '学生',
  teacher: '教师',
  admin: '管理员',
};

export function getA3RoleLoginAction(role: A3UserRole): ErrorAction {
  const roleLabel = a3WorkspaceLabels[role];
  return {
    label: `前往${roleLabel}入口`,
    href: `/a3/login?workspace=${role}`,
  };
}

export function ErrorBox({
  message,
  action,
}: {
  message: string;
  action?: ErrorAction | null;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
    >
      <p>{message}</p>
      {action ? (
        <Link
          href={action.href}
          data-testid="a3-login-error-action"
          className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-2 font-semibold text-rose-700 shadow-sm transition hover:border-rose-300 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          {action.label}
          <ArrowRight className="size-4" />
        </Link>
      ) : null}
    </div>
  );
}

type ExecuteA3LoginOptions = {
  request: () => Promise<ApiResult>;
  onSuccess: (result: ApiResult) => void | Promise<void>;
  onError: (message: string) => void;
  onSubmittingChange: (submitting: boolean) => void;
};

export async function executeA3Login({
  request,
  onSuccess,
  onError,
  onSubmittingChange,
}: ExecuteA3LoginOptions) {
  onSubmittingChange(true);
  try {
    const result = await request();
    if (!result.success) {
      onError(result.error ?? '登录失败');
      return;
    }
    await onSuccess(result);
  } catch {
    onError('登录请求失败，请检查网络后重试');
  } finally {
    onSubmittingChange(false);
  }
}

export function LoginPage({
  reviewMode = false,
  returnTo = null,
  workspace = null,
}: {
  reviewMode?: boolean;
  returnTo?: string | null;
  workspace?: A3UserRole | null;
}) {
  const router = useRouter();
  const currentUser = useA3CurrentUser();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState<ErrorAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewAccountFilled, setReviewAccountFilled] = useState(false);
  const workspaceLabel = workspace ? a3WorkspaceLabels[workspace] : '';
  const currentRoleLabel = currentUser?.role ? a3WorkspaceLabels[currentUser.role] : '';

  function showLoginError(message: string) {
    setErrorAction(null);
    setError(message);
  }

  async function submit() {
    setError('');
    setErrorAction(null);
    if (!identifier.trim() || !password.trim()) {
      showLoginError('请输入账号和密码后再登录');
      return;
    }
    await executeA3Login({
      request: () => postJson('/api/auth/login/', { identifier, password }),
      onSubmittingChange: setSubmitting,
      onError: showLoginError,
      onSuccess: async (result) => {
        if (!result.user) {
          showLoginError('登录状态更新失败，请重新登录');
          return;
        }
        const authenticatedUser = result.user as A3PublicUser;
        if (workspace && authenticatedUser.role !== workspace) {
          await postJson('/api/auth/logout/', {});
          window.dispatchEvent(new CustomEvent('a3-auth-user-updated', { detail: null }));
          const actualRole = authenticatedUser.role ? a3WorkspaceLabels[authenticatedUser.role] : '其他身份';
          if (authenticatedUser.role) {
            setErrorAction(getA3RoleLoginAction(authenticatedUser.role));
          }
          setError(`该账号是${actualRole}账号，请从${actualRole}入口登录。`);
          return;
        }
        syncA3User(authenticatedUser);
        router.push(resolveA3LoginDestination(authenticatedUser, returnTo));
      },
    });
  }

  return (
    <AuthFrame>
      <FormCard
        title={reviewMode ? '进入评审体验' : workspace ? `${workspaceLabel}账号登录` : '欢迎回来'}
        subtitle={
          reviewMode
            ? '登录预置学生账号，查看从诊断到反馈的完整学习过程。'
            : workspace
              ? `请使用已开通的${workspaceLabel}账号进入对应工作区。`
              : '使用已开通的学生、教师或管理员账号进入对应学习工作区。'
        }
      >
        {workspace ? (
          <Link
            href="/a3"
            data-testid="a3-back-to-role-selection"
            className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <ArrowLeft className="size-4" />
            返回身份选择
          </Link>
        ) : null}
        {workspace && currentUser?.role && currentUser.role !== workspace ? (
          <div data-testid="a3-account-switch-notice" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            当前登录的是{currentRoleLabel}账号，请输入{workspaceLabel}账号完成切换。
          </div>
        ) : null}
        {reviewMode ? (
          <A3ReviewLoginPanel
            onFill={({ identifier: nextIdentifier, password: nextPassword }) => {
              setIdentifier(nextIdentifier);
              setPassword(nextPassword);
              setError('');
              setErrorAction(null);
              setReviewAccountFilled(true);
            }}
          />
        ) : null}
        {reviewMode ? (
          <p role="status" aria-live="polite" className="sr-only">
            {reviewAccountFilled ? '评审账号已填入，可以登录。' : ''}
          </p>
        ) : null}
        <div className="space-y-5">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">账号</span>
            <div className="relative">
              <FieldIcon icon={User} />
              <Input
                className="h-14 pl-12 text-base"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="手机号 / 邮箱 / 学号"
                autoComplete="username"
                inputMode="email"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">密码</span>
            <div className="relative">
              <FieldIcon icon={Lock} />
              <Input
                className="h-14 pl-12 pr-14 text-base"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
              <button
                type="button"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((current) => !current)}
                className="absolute right-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            </div>
          </label>
          <div className="flex items-center justify-between text-sm">
            <label className="flex items-center gap-2 text-slate-600">
              <input type="checkbox" defaultChecked className="size-4 accent-blue-600" />
              记住我
            </label>
            <Link href="/a3/forgot-password" className="font-medium text-blue-600">忘记密码？</Link>
          </div>
          <ErrorBox message={error} action={errorAction} />
          <Button type="button" disabled={submitting} onClick={() => void submit()} className="h-14 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg hover:from-blue-700 hover:to-violet-700">
            {submitting ? <><Loader2 className="size-4 animate-spin" />登录中...</> : '登录'}
          </Button>
          <div className="text-center text-sm text-slate-500">
            还没有账号？ <Link href="/a3/register" className="font-semibold text-blue-600">立即注册</Link>
          </div>
        </div>
      </FormCard>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [school, setSchool] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const verification = useVerificationCode('register');

  async function submit() {
    setError('');
    if (!code.trim()) return setError('请输入验证码');
    setSubmitting(true);
    const result = await postJson('/api/auth/register/', { role: 'student', displayName, email, code, password, confirmPassword, school });
    setSubmitting(false);
    if (!result.success) return setError(result.error ?? '注册失败');
    if (!result.user) return setError('注册状态更新失败，请重新登录');
    syncA3User(result.user);
    router.push(getA3NextPathForUser(result.user as A3PublicUser));
  }

  return (
    <AuthFrame>
      <FormCard title="创建学习账号" subtitle="注册成功后会进入身份确认、手机绑定、隐私授权和学习画像采集。">
        <div className="space-y-4">
          <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-700">
            当前支持学生账号自助注册；教师和管理员账号由后台开通后登录。
          </div>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">姓名或昵称</span>
            <div className="relative"><FieldIcon icon={User} /><Input className="h-13 pl-12" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="请输入姓名或昵称" autoComplete="name" /></div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">邮箱</span>
            <div className="relative"><FieldIcon icon={Mail} /><Input className="h-13 pl-12" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="用于接收验证码" autoComplete="email" /></div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">邮箱验证码</span>
            <div className="grid grid-cols-[1fr_132px] gap-3">
              <div className="relative"><FieldIcon icon={ShieldCheck} /><Input className="h-13 pl-12" value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 位验证码" inputMode="numeric" autoComplete="one-time-code" /></div>
              <Button variant="outline" disabled={verification.sending || verification.cooldown > 0} onClick={() => verification.sendCode(email)} className="h-13">{verification.buttonLabel}</Button>
            </div>
          </label>
          {verification.message && <div className="text-xs text-blue-600">{verification.message}</div>}
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">密码</span>
            <div className="relative"><FieldIcon icon={Lock} /><Input className="h-13 pl-12" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="设置登录密码" autoComplete="new-password" /></div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">确认密码</span>
            <div className="relative"><FieldIcon icon={Lock} /><Input className="h-13 pl-12" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" /></div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">学校 / 学院</span>
            <div className="relative"><FieldIcon icon={Building2} /><Input className="h-13 pl-12" value={school} onChange={(event) => setSchool(event.target.value)} placeholder="用于后续学习画像，可稍后完善" autoComplete="organization" /></div>
          </label>
          <ErrorBox message={error} />
          <Button disabled={submitting} onClick={submit} className="h-14 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg">
            {submitting ? '创建中...' : '注册并继续'}
          </Button>
          <div className="text-center text-sm text-slate-500">已有账号？ <Link href="/a3/login" className="font-semibold text-blue-600">去登录</Link></div>
        </div>
      </FormCard>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const verification = useVerificationCode('reset');

  async function submit() {
    setMessage('');
    const result = await postJson('/api/auth/reset-password/', { identifier, code, password, confirmPassword });
    if (!result.success) return setMessage(result.error ?? '重置失败');
    router.push('/a3/login');
  }

  return (
    <AuthFrame variant="secure">
      <FormCard title="找回密码" subtitle="验证账号后设置新密码。">
        <div className="space-y-5">
          <div className="relative"><FieldIcon icon={User} /><Input className="h-14 pl-12" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="手机号 / 邮箱" /></div>
          <div className="grid grid-cols-[1fr_150px] gap-3">
            <div className="relative"><FieldIcon icon={ShieldCheck} /><Input className="h-14 pl-12" value={code} onChange={(event) => setCode(event.target.value)} placeholder="验证码" /></div>
            <Button variant="outline" disabled={verification.sending || verification.cooldown > 0} onClick={() => verification.sendCode(identifier)} className="h-14">{verification.buttonLabel}</Button>
          </div>
          <div className="relative"><FieldIcon icon={Lock} /><Input className="h-14 pl-12" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="新密码" /></div>
          <div className="relative"><FieldIcon icon={Lock} /><Input className="h-14 pl-12" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="确认新密码" /></div>
          {(verification.message || message) && <div className="text-sm text-blue-600">{message || verification.message}</div>}
          <Button onClick={submit} className="h-14 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg">重置密码</Button>
          <Link href="/a3/login" className="inline-flex items-center gap-2 text-blue-600"><ArrowLeft className="size-4" />返回登录</Link>
        </div>
      </FormCard>
    </AuthFrame>
  );
}

function SimpleFlowFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f4f7ff] px-5 py-8 text-slate-950 [--a3-border:rgba(203,213,225,0.9)] [--a3-surface-solid:#ffffff] [--a3-surface-muted:#f8fafc] [--a3-text:#0f172a] [--a3-text-muted:#64748b] md:px-10">
      <header className="mx-auto flex max-w-[1500px] items-center justify-between">
        <Link href="/a3/dashboard" className="flex items-center gap-3">
          <div className="size-12 overflow-hidden rounded-[14px]">
            <Image src="/a3-brand-icon.png" alt="" width={48} height={48} className="size-full object-cover" priority unoptimized />
          </div>
          <div>
            <div className="text-[22px] font-semibold leading-tight">智学引擎</div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">AI Learning</div>
          </div>
        </Link>
        <div className="hidden md:block">
          <A3TopActions showThemeToggle={false} />
        </div>
      </header>
      <main className="mx-auto mt-8 max-w-[1500px]">{children}</main>
    </div>
  );
}

export function RoleSelectionPage() {
  const router = useRouter();
  const user = useA3CurrentUser();
  const currentRole = user?.role ?? 'student';
  const [role, setRole] = useState<A3UserRole>(currentRole);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const roles: Array<[A3UserRole, string, string, LucideIcon]> = [
    ['student', '学生', '自主学习、智能练习、个性化提升', GraduationCap],
    ['teacher', '教师', '教学备课、课堂管理、学情分析', Users],
    ['admin', '管理员', '用户管理、数据统计、系统配置', ShieldCheck],
  ];

  async function submit() {
    if (!user || submitting) return;
    setError('');
    setSubmitting(true);
    const result = await patchJson('/api/profiles/me/', { role });
    setSubmitting(false);
    if (!result.success) {
      setError(result.error ?? '身份确认失败，请稍后重试');
      return;
    }
    const nextUser = { ...user, ...result.user, role };
    syncA3User(nextUser);
    router.push(getA3NextPathForUser(nextUser));
  }

  return (
    <SimpleFlowFrame>
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-[-0.03em] md:text-5xl">确认你的身份</h1>
        <p className="mt-4 text-lg text-slate-500">系统会根据角色开放不同工作区；角色变更需由管理员审核。</p>
      </div>
      <div className="mx-auto mt-10 grid max-w-6xl gap-6 md:grid-cols-3">
        {roles.map(([value, title, desc, Icon]) => {
          const authorized = currentRole === value;
          return (
            <button key={value} disabled={!authorized} onClick={() => setRole(value)} className={`relative rounded-[20px] border bg-white p-8 text-center shadow-[0_20px_50px_rgba(15,23,42,0.08)] ${role === value ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200'} ${authorized ? '' : 'cursor-not-allowed opacity-55'}`}>
              {role === value && <span className="absolute right-5 top-5 flex size-9 items-center justify-center rounded-full bg-blue-600 text-white"><Check className="size-5" /></span>}
              {!authorized && <span className="absolute right-5 top-5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">需后台开通</span>}
              <Icon className="mx-auto size-16 text-blue-600" />
              <div className="mt-6 text-2xl font-semibold">{title}</div>
              <div className="mt-3 text-sm leading-6 text-slate-500">{desc}</div>
            </button>
          );
        })}
      </div>
      {error && (
        <div className="mx-auto mt-6 max-w-xl rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="mt-10 text-center">
        <Button disabled={!user || submitting} onClick={submit} className="h-14 w-[420px] max-w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg">
          {submitting ? '正在确认...' : '下一步'}<ArrowRight className="ml-2 size-5" />
        </Button>
      </div>
    </SimpleFlowFrame>
  );
}

export function PhoneBindingPage() {
  const router = useRouter();
  const user = useA3CurrentUser();
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const verification = useVerificationCode('bind');

  async function submit() {
    setError('');
    const result = await patchJson('/api/profiles/me/', { phone, code });
    if (!result.success) return setError(result.error ?? '绑定失败');
    if (!result.user) return setError('绑定状态更新失败，请重新登录');
    syncA3User(result.user);
    router.push(getA3NextPathForUser(result.user as A3PublicUser));
  }

  return (
    <SimpleFlowFrame>
      <div className="mx-auto max-w-xl rounded-[24px] border border-slate-200 bg-white p-8 shadow-[0_24px_70px_rgba(15,23,42,0.10)]">
        <Phone className="size-12 text-blue-600" />
        <h1 className="mt-5 text-3xl font-semibold">绑定手机号</h1>
        <p className="mt-3 text-slate-500">用于登录验证、找回密码和重要学习提醒。</p>
        <div className="mt-8 space-y-4">
          <div className="relative"><FieldIcon icon={Phone} /><Input className="h-14 pl-12" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="手机号" /></div>
          <div className="grid grid-cols-[1fr_150px] gap-3">
            <div className="relative"><FieldIcon icon={ShieldCheck} /><Input className="h-14 pl-12" value={code} onChange={(event) => setCode(event.target.value)} placeholder="验证码" /></div>
            <Button variant="outline" disabled={verification.sending || verification.cooldown > 0} onClick={() => verification.sendCode(phone)} className="h-14">{verification.buttonLabel}</Button>
          </div>
          {(verification.message || error) && <div className="text-sm text-blue-600">{error || verification.message}</div>}
          <Button onClick={submit} className="h-14 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg">完成绑定</Button>
        </div>
      </div>
    </SimpleFlowFrame>
  );
}

export function WelcomePage() {
  const router = useRouter();
  const user = useA3CurrentUser();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const cards = [
    ['了解授权', '查看哪些学习数据会被使用，并自主选择可选授权。', ShieldCheck],
    ['完善画像', '填写目标、基础、时间和薄弱点，让学习安排更适合你。', User],
    ['生成计划', '根据你的画像安排学习路径、周期计划和今日任务。', Target],
    ['开始学习', '完成设置后进入今日任务、课堂和复习。', Clock3],
  ] as const;

  async function start() {
    if (submitting) return;
    setError('');
    setSubmitting(true);
    const result = await patchJson('/api/profiles/me/', { onboardingStep: 'privacy' });
    setSubmitting(false);
    if (!result.success) {
      setError(result.error ?? '首启状态保存失败，请稍后重试');
      return;
    }
    if (!result.user) {
      setError('首启状态更新失败，请重新登录');
      return;
    }
    syncA3User(result.user);
    router.push(getA3NextPathForUser(result.user as A3PublicUser));
  }

  return (
    <SimpleFlowFrame>
      <div className="grid gap-8 rounded-[28px] border border-slate-200 bg-white p-8 shadow-[0_24px_70px_rgba(15,23,42,0.10)] lg:grid-cols-[minmax(0,1fr)_390px]">
        <section>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-blue-600">首次使用</p>
          <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-[-0.02em] md:text-6xl">你好，{user?.displayName || '同学'}。完善几项学习设置。</h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-slate-600">用几分钟确认数据授权并告诉我们你的目标、基础和学习习惯。完成后，你会获得专属学习路径和今日任务。</p>
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {cards.map(([title, desc, Icon], index) => (
              <div key={title} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-white text-sm font-semibold text-blue-700 shadow-sm">{index + 1}</span>
                  <Icon className="size-6 text-blue-600" />
                </div>
                <h2 className="mt-4 font-semibold">{title}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">{desc}</p>
              </div>
            ))}
          </div>
          <ErrorBox message={error} />
        </section>
        <aside className="rounded-[24px] border border-blue-100 bg-blue-50 p-6 text-slate-950">
          <div className="rounded-2xl bg-white p-4 shadow-[0_16px_40px_rgba(37,99,235,0.10)]">
            <img src="/a3/assets/onboarding/welcome-robot.webp" alt="A3 学习引擎助手" className="mx-auto h-40 w-full object-contain" />
          </div>
          <h2 className="mt-6 text-2xl font-semibold leading-tight">接下来先确认数据授权。</h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">你可以查看每项数据的用途，并决定是否开启通知和个性化推荐。</p>
          <Button disabled={submitting} onClick={start} className="mt-8 h-14 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg text-white hover:from-blue-700 hover:to-violet-700">
            {submitting ? '正在进入...' : '开始设置'}<ArrowRight className="ml-2 size-5" />
          </Button>
        </aside>
      </div>
    </SimpleFlowFrame>
  );
}

export function PrivacyPage() {
  const router = useRouter();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const permissions = [
    ['账号基础信息', '用于登录、身份识别和学习空间展示。', '必要'],
    ['学习行为数据', '用于生成计划、推荐资源、错题复盘和学习报告。', '必要'],
    ['通知提醒', '用于发送每日任务、复盘和系统消息。', '可选'],
    ['个性化推荐', '用于根据目标、薄弱点和进度调整内容。', '可选'],
  ];

  async function submit() {
    setError('');
    const result = await patchJson('/api/profiles/me/', {
      privacyAccepted: true,
      consents: { learningAnalytics: true, notifications: true, personalization: true },
    });
    if (!result.success) return setError(result.error ?? '隐私授权保存失败，请稍后重试');
    if (!result.user) return setError('授权状态更新失败，请重新登录');
    syncA3User(result.user);
    router.push(getA3NextPathForUser(result.user as A3PublicUser));
  }

  return (
    <SimpleFlowFrame>
      <div className="mx-auto max-w-5xl rounded-[28px] border border-slate-200 bg-white p-8 shadow-[0_24px_70px_rgba(15,23,42,0.10)]">
        <ShieldCheck className="size-14 text-blue-600" />
        <h1 className="mt-5 text-4xl font-semibold tracking-[-0.03em]">隐私授权说明</h1>
        <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">A3 只收集完成学习闭环所需的数据，学习画像、练习记录和报告用于个性化计划与反馈。</p>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {permissions.map(([title, desc, tag]) => (
            <div key={title} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{title}</h2>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-600">{tag}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500">{desc}</p>
            </div>
          ))}
        </div>
        <label className="mt-8 flex items-start gap-3 text-sm leading-6 text-slate-600">
          <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1 size-5 accent-blue-600" />
          我已阅读并同意《用户协议》《隐私政策》，授权系统处理必要学习数据以生成学习计划、AI 辅导反馈和学习报告。
        </label>
        <ErrorBox message={error} />
        <Button disabled={!accepted} onClick={submit} className="mt-7 h-14 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-lg">同意并继续</Button>
      </div>
    </SimpleFlowFrame>
  );
}

export function ProfileSetupPage() {
  const router = useRouter();
  const currentUser = useA3CurrentUser();
  const [displayName, setDisplayName] = useState(currentUser?.displayName ?? '');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [options, setOptions] = useState<LearningProfileOptions>(defaultLearningProfileOptions);
  const [optionsCourse, setOptionsCourse] = useState('操作系统');
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [profile, setProfile] = useState<A3LearningProfile>(() => createEmptyLearningProfile());
  const [saveResult, setSaveResult] = useState<ApiResult | null>(null);
  const [interviewText, setInterviewText] = useState('');
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [interviewResult, setInterviewResult] = useState<ProfileInterviewResult | null>(null);
  const [interviewMessages, setInterviewMessages] = useState<ProfileInterviewMessage[]>([
    { role: 'agent', content: '先说说你学习这门课最想解决什么问题？可以只回答一个方面，不需要一次把所有信息写完整。' },
  ]);
  const [missingInterviewDimensions, setMissingInterviewDimensions] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [profileFeed, setProfileFeed] = useState<DynamicProfileFeedResponse | null>(null);
  const [profileUpdateBusyId, setProfileUpdateBusyId] = useState('');
  const interviewThreadRef = useRef<HTMLDivElement>(null);
  const optionsLoadRef = useRef<Promise<LearningProfileOptions | null> | null>(null);

  const loadDynamicProfile = useCallback(async () => {
    const result = await a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/');
    if (result.success) {
      setProfileFeed(result);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const optionsRequest = a3GetJson<LearningProfileOptionsResponse>('/api/profiles/options/');
    optionsLoadRef.current = optionsRequest.then((result) => (result.success ? result.options : null));
    async function loadOptions() {
      const result = await optionsRequest;
      if (!active) return;
      setLoadingOptions(false);
      if (!result.success) {
        setMessage(result.error ?? '画像选项加载失败，请确认后端服务正常');
        return;
      }
      setOptions(result.options);
      setOptionsCourse(result.course?.title ?? '当前课程');
      const storedProfile = currentUser?.learningProfile;
      setProfile((current) => normalizeLearningProfileForOptions({
        ...current,
        ...storedProfile,
        learningGoals: normalizeMultiSelection(storedProfile?.learningGoals ?? current.learningGoals, result.options.learningGoals),
        learningPreferences: normalizeMultiSelection(storedProfile?.learningPreferences ?? current.learningPreferences, result.options.learningPreferences),
        weakPoints: normalizeMultiSelection(storedProfile?.weakPoints ?? current.weakPoints, result.options.weakPoints.map((item) => item.value)),
        expectedResources: normalizeMultiSelection(storedProfile?.expectedResources ?? current.expectedResources, result.options.expectedResources),
        dailyStudyTime: String(storedProfile?.dailyStudyTime ?? current.dailyStudyTime ?? ''),
      }, result.options));
    }
    void loadOptions();
    return () => {
      active = false;
    };
  }, [currentUser?.learningProfile]);

  useEffect(() => {
    let active = true;
    a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/').then((result) => {
      if (!active || !result.success) return;
      setProfileFeed(result);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const hasHistory = interviewMessages.some((item) => item.role === 'user') || Boolean(interviewResult?.success);
    if (!hasHistory) return;
    const thread = interviewThreadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'auto' });
  }, [interviewMessages, interviewResult?.success]);

  useEffect(() => {
    let active = true;
    async function loadInterviewSession() {
      const result = await a3GetJson<ProfileInterviewSessionResult>('/api/profile/interview/session/');
      if (!active || !result.success || !result.interviewSession) return;
      const session = result.interviewSession;
      const restoredMessages = normalizeProfileInterviewMessages(session);
      if (restoredMessages.length > 0) {
        setInterviewMessages(restoredMessages);
      }
      const missing = session.missingDimensions?.map((item) => item.label).filter(Boolean) ?? [];
      setMissingInterviewDimensions(missing);
      if ((session.turnCount ?? 0) > 0 || session.profileCommitted || session.planningDeferred) {
        setInterviewResult({
          success: true,
          traceId: session.latestTraceId,
          profile: session.profileSnapshot,
          profileReadiness: session.profileReadiness ?? {
            status: session.interviewComplete ? 'ready' : 'partial',
            missingDimensions: session.missingDimensions,
            interviewComplete: session.interviewComplete,
          },
          missingDimensions: session.missingDimensions,
          askFields: session.askFields,
          askStrategy: session.askStrategy,
          nextQuestion: session.nextQuestion,
          interviewComplete: session.interviewComplete,
          profileCommitted: session.profileCommitted,
          planningDeferred: session.planningDeferred,
          planningDeferredReason: session.planningDeferredReason,
          interviewSession: session,
          generated: session.generated,
        });
      }
    }
    void loadInterviewSession();
    return () => {
      active = false;
    };
  }, []);

  function toggle(key: keyof Pick<A3LearningProfile, 'learningGoals' | 'learningPreferences' | 'weakPoints' | 'expectedResources'>, value: string) {
    setProfile((current) => {
      const list = current[key];
      return { ...current, [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] };
    });
  }

  async function runProfileInterview() {
    if (submitting || interviewLoading || loadingOptions) return;
    const messageText = interviewText.trim();
    if (!messageText) {
      setMessage('请先回答当前问题。');
      return;
    }
    const nextMessages: ProfileInterviewMessage[] = [...interviewMessages, { role: 'user', content: messageText }];
    setInterviewLoading(true);
    setMessage('');
    setInterviewResult(null);
    setInterviewMessages(nextMessages);
    const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { message: messageText });
    setInterviewLoading(false);
    setInterviewResult(result);
    if (!result.success) {
      setMessage(result.error ?? '暂时无法整理这次回答，请稍后重试。');
      return;
    }
    const extracted = result.profile;
    if (extracted) {
      const loadedOptions = await optionsLoadRef.current;
      setProfile((current) => mergeInterviewProfile(current, extracted, loadedOptions ?? options));
    }
    const hasBackendMissingDimensions = Object.prototype.hasOwnProperty.call(result, 'missingDimensions')
      || Boolean(result.profileReadiness && Object.prototype.hasOwnProperty.call(result.profileReadiness, 'missingDimensions'))
      || Boolean(result.interviewSession && Object.prototype.hasOwnProperty.call(result.interviewSession, 'missingDimensions'));
    const backendMissingDimensions = result.missingDimensions ?? result.profileReadiness?.missingDimensions ?? result.interviewSession?.missingDimensions;
    const missing = hasBackendMissingDimensions
      ? (backendMissingDimensions ?? []).map((item) => item.label).filter(Boolean)
      : getMissingProfileDimensions(result.profile);
    setMissingInterviewDimensions(missing);
    const nextPrompt = result.nextQuestion || buildProfileInterviewFollowUp(missing);
    const sessionMessages = normalizeProfileInterviewMessages(result.interviewSession);
    setInterviewMessages(sessionMessages.length ? sessionMessages : [...nextMessages, { role: 'agent', content: nextPrompt }]);
    setInterviewText('');
    void loadDynamicProfile();
  }

  async function submit() {
    setMessage('');
    setSaveResult(null);
    const normalizedProfile = normalizeLearningProfileForOptions(profile, options);
    setProfile(normalizedProfile);
    const missingFields = getMissingLearningProfileFields(normalizedProfile);
    if (missingFields.length > 0) {
      setMessage(`请先补齐：${missingFields.join('、')}`);
      return;
    }
    setSubmitting(true);
    const result = await postJson('/api/profiles/learning-profile/', { ...normalizedProfile, displayName });
    setSubmitting(false);
    if (result.success) {
      syncA3User(result.user);
      setSaveResult(result);
      void loadDynamicProfile();
      return;
    }
    setMessage(result.error ?? '画像保存失败，请确认后端服务和登录状态正常');
  }

  async function confirmProfileInterview() {
    if (!interviewResult || !interviewReadyToConfirm) {
      const missing = interviewResult?.missingDimensions ?? interviewResult?.profileReadiness?.missingDimensions ?? interviewResult?.interviewSession?.missingDimensions ?? [];
      setMissingInterviewDimensions(missing.map((item) => item.label).filter(Boolean));
      setMessage('还需要补充一项信息，请先回答上方问题。');
      return;
    }
    setSubmitting(true);
    setMessage('');
    setSaveResult(null);
    const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { action: 'confirm' });
    setSubmitting(false);
    if (!result.success || !result.profileCommitted) {
      const hasMissingDimensions = Object.prototype.hasOwnProperty.call(result, 'missingDimensions')
        || Boolean(result.profileReadiness && Object.prototype.hasOwnProperty.call(result.profileReadiness, 'missingDimensions'))
        || Boolean(result.interviewSession && Object.prototype.hasOwnProperty.call(result.interviewSession, 'missingDimensions'));
      const incomingMissingDimensions = hasMissingDimensions
        ? (result.missingDimensions ?? result.profileReadiness?.missingDimensions ?? result.interviewSession?.missingDimensions ?? [])
          .map((item) => item.label)
          .filter(Boolean)
        : undefined;
      const sessionMessages = normalizeProfileInterviewMessages(result.interviewSession);
      const transition = transitionProfileInterviewUiState({
        previousResult: interviewResult,
        previousMissingDimensions: missingInterviewDimensions,
        previousMessages: interviewMessages,
        incomingResult: result,
        incomingMissingDimensions,
        incomingMessages: sessionMessages,
      });
      setInterviewResult(transition.result);
      setMissingInterviewDimensions(transition.missingDimensions);
      setInterviewMessages(transition.messages);
      setMessage(result.error ?? '还需要补充一项信息，请先回答上方问题。');
      return;
    }
    setInterviewResult(result);
    if (result.user) syncA3User(result.user);
    const sessionMessages = normalizeProfileInterviewMessages(result.interviewSession);
    if (sessionMessages.length) setInterviewMessages(sessionMessages);
    setMissingInterviewDimensions([]);
    setSaveResult({
      success: true,
      user: result.user,
      profileReadiness: {
        status: result.profileReadiness?.status === 'partial' || result.profileReadiness?.status === 'incomplete' ? result.profileReadiness.status : 'ready',
        score: 100,
        missingFields: [],
        summary: '学习情况已保存，接下来通过几道题确认你的学习起点。',
      },
      generated: { path: Boolean(result.generated?.path), studyPlan: Boolean(result.generated?.studyPlan) },
      planningDeferred: result.planningDeferred,
      planningDeferredReason: result.planningDeferredReason,
      nextAction: { label: '开始入学诊断', href: '/a3/admission-diagnostic', reason: '入学诊断会确认基础和薄弱点，并据此生成后续学习路径和计划。' },
    });
    void loadDynamicProfile();
  }

  async function resolveProfileUpdate(updateId: string, action: 'confirm' | 'reject') {
    setProfileUpdateBusyId(updateId);
    const result = await a3PostJson<DynamicProfileFeedResponse & { update?: ProfileTimelineEntry }>(
      `/api/profiles/profile-updates/${updateId}/${action}/`,
      action === 'reject' ? { reason: '学生在画像页手动忽略' } : {},
    );
    setProfileUpdateBusyId('');
    if (!result.success) {
      setMessage(result.error ?? '画像更新处理失败，请稍后重试。');
      return;
    }
    await loadDynamicProfile();
  }

  const previewRows = [
    ['姓名/昵称', displayName || currentUser?.displayName || '待完善'],
    ['专业方向', profile.majorDirection],
    ['年级', profile.grade],
    ['基础水平', profile.foundationLevel],
    ['学习目标', profile.learningGoals.join('、')],
    ['学习偏好', profile.learningPreferences.join('、')],
    ['每日时间', profile.dailyStudyTime ? `${profile.dailyStudyTime} 分钟` : ''],
    ['薄弱知识点', profile.weakPoints.join('、')],
    ['资源类型', profile.expectedResources.join('、')],
    ['学习节奏', profile.pace ? planModeLabel(profile.pace) : ''],
  ];
  const interviewReadyToConfirm = Boolean(interviewResult?.success && (interviewResult.interviewComplete || interviewResult.interviewSession?.interviewComplete));
  const filledProfileRows = previewRows.filter(([, value]) => value && value !== '待完善').length;
  const profileCompleteness = Math.round((filledProfileRows * 100) / previewRows.length);
  const hasInterviewHistory = interviewMessages.some((item) => item.role === 'user') || Boolean(interviewResult?.success);
  const hasProfileInputData = previewRows.slice(1).some(([, value]) => Boolean(value));
  const hasProfileUpdateData = Boolean(profileFeed?.timeline?.length || profileFeed?.confirmationQueue?.length);
  const showInterviewInsights = hasInterviewHistory || Boolean(interviewResult) || Boolean(saveResult) || hasProfileInputData;
  const showProfileSetupPanels = showInterviewInsights || hasProfileUpdateData;

  function goBack() {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
      return;
    }
    router.push('/a3/dashboard');
  }

  return (
    <SimpleFlowFrame>
      <div data-testid="a3-profile-setup-view">
        <div className="mb-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-end">
          <div data-tour-id="profile-intro">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={goBack}
              className="mb-5 h-9 rounded-full border-slate-200 bg-white/80 px-3 text-slate-700 shadow-sm hover:bg-white"
            >
              <ArrowLeft className="size-4" />
              返回上一页
            </Button>
            <p className="text-sm font-semibold text-blue-600">学习设置</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-normal text-slate-950 md:text-5xl">告诉我们你的学习情况</h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
              不用一次说全。可以先说学习目标、以前学过什么或每天能学多久，系统会根据你的回答逐项追问，并把关键信息整理出来。
            </p>
          </div>
          <div className="flex items-center gap-3 lg:justify-end">
            <span className="text-sm text-slate-500">当前课程</span>
            <span aria-live="polite" className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700">
              {loadingOptions ? '正在加载课程信息' : optionsCourse}
            </span>
          </div>
        </div>
        <section data-tour-id="profile-interview" className="mb-7 overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-4 md:px-6">
            <div className="grid gap-3 sm:grid-cols-3">
              {['说说情况', '回答追问', '确认并开始诊断'].map((label, index) => (
                <div key={label} className="flex items-center gap-3 py-1 sm:border-l sm:border-slate-200 sm:pl-4 first:sm:border-l-0 first:sm:pl-0">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
                    {index + 1}
                  </span>
                  <span className="text-sm font-semibold text-slate-700">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid items-start gap-6 p-6 md:p-8 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-[0_12px_30px_rgba(37,99,235,0.18)]">
                  <Bot className="size-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-semibold tracking-normal text-slate-950">和系统聊聊你的学习情况</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
                    系统会整理你的回答，并在需要时继续追问。
                  </p>
                </div>
              </div>
              <div
                ref={interviewThreadRef}
                className={hasInterviewHistory ? 'mt-5 max-h-[420px] min-h-[240px] space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2' : 'mt-5 max-h-[420px] overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4'}
                data-testid="a3-profile-interview-thread"
              >
                {!hasInterviewHistory && (
                  <div className="rounded-2xl border border-blue-100 bg-white p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
                        <Bot className="size-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-950">先说说你学习这门课最想解决什么问题？</div>
                        <p className="mt-1 text-sm leading-6 text-slate-600">
                          可以只回答一个方面，不需要一次把所有信息写完整。
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                {hasInterviewHistory && interviewMessages.map((item, index) => (
                  <div key={`${item.role}-${index}`} className={item.role === 'user' ? 'w-full rounded-2xl bg-blue-600 px-4 py-3 text-sm leading-6 text-white shadow-[0_12px_24px_rgba(37,99,235,0.18)]' : 'w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600 shadow-sm'}>
                    <div className="mb-1 text-xs font-semibold opacity-70">{item.role === 'user' ? '我' : '画像助手'}</div>
                    {item.content}
                  </div>
                ))}
              </div>
              <textarea
                data-testid="a3-profile-interview-input"
                value={interviewText}
                onChange={(event) => setInterviewText(event.target.value)}
                className="mt-4 min-h-[124px] w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100"
                placeholder={buildProfileInterviewPlaceholder(optionsCourse)}
              />
              {missingInterviewDimensions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2" data-testid="a3-profile-interview-missing-dimensions">
                  {missingInterviewDimensions.map((item) => (
                    <span key={item} className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                      待补充：{item}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <Button data-testid="a3-profile-interview-generate" type="button" disabled={interviewLoading || submitting || loadingOptions} onClick={runProfileInterview} className="h-11 bg-blue-600 px-5 text-white hover:bg-blue-700">
                  {interviewLoading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  发送并整理
                </Button>
                <Button type="button" variant="outline" className="h-11" onClick={() => setInterviewText(buildProfileInterviewExample(optionsCourse))}>
                  <BookOpen className="size-4" />
                  查看示例
                </Button>
                <Button data-testid="a3-profile-interview-confirm" type="button" variant="outline" className="h-11" disabled={submitting || !interviewReadyToConfirm} onClick={confirmProfileInterview} title={!interviewReadyToConfirm ? '先完成画像访谈后再确认' : undefined}>
                  <ArrowRight className="size-4" />
                  确认并开始入学诊断
                </Button>
                {interviewResult?.success && !interviewReadyToConfirm && (
                  <div className="flex min-h-11 items-center rounded-xl bg-amber-50 px-3 text-xs font-semibold text-amber-700">
                    先回答追问，补齐画像后可确认
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-4 xl:sticky xl:top-6">
              {!showProfileSetupPanels ? (
                <div data-testid="a3-profile-progressive-empty" className="flex items-start gap-3 px-1 py-2 text-sm leading-6 text-slate-500">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-blue-600" />
                  <p>系统会整理学习目标、基础、时间和偏好，并用于后续诊断和学习安排。</p>
                </div>
              ) : (
                <>
                  {showInterviewInsights && (
                    <ProfilePlanningImpactPreview
                      courseTitle={optionsCourse}
                      profile={profile}
                      completeness={profileCompleteness}
                      saveResult={saveResult}
                    />
                  )}
                  {hasProfileUpdateData && (
                    <ProfileUpdateTimelinePanel
                      feed={profileFeed}
                      busyId={profileUpdateBusyId}
                      onConfirm={(id) => resolveProfileUpdate(id, 'confirm')}
                      onReject={(id) => resolveProfileUpdate(id, 'reject')}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </section>
        <section className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.06)] md:p-6">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <button
                data-tour-id="profile-manual"
                type="button"
                onClick={() => setAdvancedOpen((value) => !value)}
                className="flex w-full items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-left transition hover:border-blue-200 hover:bg-blue-50/50"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-blue-600 shadow-sm">
                    <SlidersHorizontal className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-lg font-semibold text-slate-950">想自己修改？展开手动填写</span>
                    <span className="mt-1 block text-sm leading-5 text-slate-500">可以补充或修改系统刚才整理的信息。</span>
                  </span>
                </span>
                <ChevronDown className={advancedOpen ? 'size-5 shrink-0 rotate-180 text-slate-500 transition-transform' : 'size-5 shrink-0 text-slate-500 transition-transform'} />
              </button>
              <ProfilePreviewStrip previewRows={previewRows} />
              <ErrorBox message={message} />
            </div>
            <div data-tour-id="profile-save" className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-blue-950">
                <Sparkles className="size-4 text-blue-600" />
                下一步
              </div>
              <p className="mt-2 text-sm leading-6 text-blue-900/75">
                保存后生成诊断、路径和计划。
              </p>
              <Button data-testid="a3-profile-setup-submit" disabled={submitting || loadingOptions} onClick={submit} className="mt-4 h-12 w-full rounded-xl bg-blue-600 text-base hover:bg-blue-700">
                {loadingOptions ? '正在加载课程信息...' : submitting ? '正在保存...' : '保存画像并生成规划'}
              </Button>
              <p className="mt-3 text-xs leading-5 text-blue-900/60">仅用于个性化学习，可随时修改。</p>
            </div>
          </div>
          {advancedOpen && (
            <div className="mt-6 border-t border-slate-200 pt-6">
              <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                <label className="mb-3 block text-lg font-semibold">基础身份信息</label>
                <div className="relative max-w-md">
                  <FieldIcon icon={User} />
                  <Input className="h-13 pl-12" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="请输入姓名或昵称" />
                </div>
              </div>
              <div className="grid gap-5 lg:grid-cols-3">
                <ProfileSection title="专业方向" options={options.majorDirections} active={[profile.majorDirection]} onPick={(value) => setProfile({ ...profile, majorDirection: value })} />
                <ProfileSection title="年级" options={options.grades} active={[profile.grade]} onPick={(value) => setProfile({ ...profile, grade: value })} />
                <ProfileSection title="当前基础水平" options={options.foundationLevels} active={[profile.foundationLevel]} onPick={(value) => setProfile({ ...profile, foundationLevel: value })} />
              </div>
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <ProfileSection title="学习目标" options={options.learningGoals} active={profile.learningGoals} onPick={(value) => toggle('learningGoals', value)} />
                <ProfileSection title="学习偏好" options={options.learningPreferences} active={profile.learningPreferences} onPick={(value) => toggle('learningPreferences', value)} />
                <ProfileSection title="薄弱知识点" options={options.weakPoints} active={profile.weakPoints} onPick={(value) => toggle('weakPoints', value)} />
                <ProfileSection title="期望资源类型" options={options.expectedResources} active={profile.expectedResources} onPick={(value) => toggle('expectedResources', value)} />
              </div>
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <ProfileSection title="每日可投入时间" options={options.dailyStudyTimes} active={[profile.dailyStudyTime]} onPick={(value) => setProfile({ ...profile, dailyStudyTime: value })} suffix="分钟" />
                <ProfileSection title="学习节奏" options={options.paces} active={[profile.pace]} onPick={(value) => setProfile({ ...profile, pace: value })} />
              </div>
            </div>
          )}
          {saveResult?.profileReadiness && (
            <div data-testid="a3-profile-setup-save-result" className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-900">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">画像已保存，完成度 {saveResult.profileReadiness.score}%</div>
                  <div className="mt-1 text-emerald-700">{saveResult.profileReadiness.summary}</div>
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-700">
                  {saveResult.profileReadiness.status === 'ready' ? '可进入诊断' : '需补充'}
                </span>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-emerald-800">
                {saveResult.planningDeferred ? (
                  <div>学习路径和 14 天计划将在入学诊断后生成。</div>
                ) : (
                  <>
                    <div>学习路径：{saveResult.generated?.path ? '已刷新' : '待生成'}</div>
                    <div>14 天学习计划：{saveResult.generated?.studyPlan ? '已生成' : '待生成'}</div>
                  </>
                )}
                {!saveResult.planningDeferred && saveResult.generationError && <div className="text-orange-700">生成提示：{saveResult.generationError}</div>}
                {saveResult.nextAction?.reason && <div>下一步依据：{saveResult.nextAction.reason}</div>}
              </div>
              {saveResult.personalizationImpact && (
                <div data-testid="a3-profile-personalization-impact" className="mt-4 rounded-2xl border border-emerald-200 bg-white/80 p-4">
                  <div className="flex items-center gap-2 font-semibold text-emerald-950">
                    <Target className="size-4" />
                    个性化生成依据
                  </div>
                  <div className="mt-3 grid gap-3 text-xs text-emerald-900">
                    <div className="rounded-xl bg-emerald-50 px-3 py-2">
                      计划节奏：{planModeLabel(saveResult.personalizationImpact.plan.mode)}
                      {saveResult.personalizationImpact.plan.dailyMinutes ? `，每日 ${saveResult.personalizationImpact.plan.dailyMinutes} 分钟` : ''}
                    </div>
                    {saveResult.personalizationImpact.plan.reason && (
                      <div className="rounded-xl bg-emerald-50 px-3 py-2">调整理由：{saveResult.personalizationImpact.plan.reason}</div>
                    )}
                    {saveResult.personalizationImpact.profileInputs.weakPoints?.length ? (
                      <div className="rounded-xl bg-emerald-50 px-3 py-2">
                        薄弱点优先：{saveResult.personalizationImpact.profileInputs.weakPoints.join('、')}
                      </div>
                    ) : null}
                    {saveResult.personalizationImpact.pathFocus.length ? (
                      <div className="rounded-xl bg-emerald-50 px-3 py-2">
                        路径前置：{saveResult.personalizationImpact.pathFocus.map((item) => item.title).join(' → ')}
                      </div>
                    ) : null}
                    {saveResult.personalizationImpact.explanation && (
                      <div className="text-emerald-700">{saveResult.personalizationImpact.explanation}</div>
                    )}
                  </div>
                </div>
              )}
              <Button
                type="button"
                onClick={() => router.push(saveResult.nextAction?.href ?? '/a3/admission-diagnostic')}
                className="mt-4 h-11 w-full rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {saveResult.nextAction?.label ?? '开始入学诊断'}
              </Button>
            </div>
          )}
        </section>
      </div>
    </SimpleFlowFrame>
  );
}

function ProfileUpdateTimelinePanel({
  feed,
  busyId,
  onConfirm,
  onReject,
}: {
  feed: DynamicProfileFeedResponse | null;
  busyId: string;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const queue = feed?.confirmationQueue ?? [];
  const timeline = feed?.timeline ?? [];
  return (
    <section data-testid="a3-profile-update-timeline" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">最近整理的信息</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">确认后会用于后续学习安排。</p>
        </div>
        <span className={queue.length ? 'rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700' : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600'}>
          {queue.length ? `${queue.length} 条待确认` : '无待确认'}
        </span>
      </div>

      {queue.length > 0 ? (
        <div className="mt-4 space-y-3">
          {queue.slice(0, 3).map((item) => (
            <div key={item.id} className="rounded-xl border border-orange-100 bg-orange-50/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-orange-700">{profileDimensionLabel(item.changedDimensions[0] || '')}</span>
                <span className="text-xs font-medium text-orange-800">{profileSourceLabel(item.source)}</span>
                <span className="text-xs text-orange-700">置信度 {Math.round((item.confidence ?? 0) * 100)}%</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-800">{summarizeProfileTimelineEntry(item)}</p>
              <p className="mt-1 text-xs leading-5 text-orange-800">{summarizeProfileUpdateEvidence(item)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button data-testid="a3-profile-update-confirm" type="button" size="sm" disabled={busyId === item.id} onClick={() => onConfirm(item.id)} className="h-8 bg-blue-600 px-3 text-xs text-white hover:bg-blue-700">
                  {busyId === item.id ? '处理中' : '确认更新'}
                </Button>
                <Button data-testid="a3-profile-update-reject" type="button" size="sm" variant="outline" disabled={busyId === item.id} onClick={() => onReject(item.id)} className="h-8 px-3 text-xs">
                  忽略
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-xl bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-600">
          暂无待确认变化。
        </div>
      )}

      {timeline.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <div className="mb-2 text-xs font-semibold text-slate-500">最近变化</div>
          <div className="space-y-2">
            {timeline.slice(0, 4).map((item) => (
              <div key={`${item.id}-${item.versionId || item.createdAt}`} className="rounded-xl bg-slate-50 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900">{profileSourceLabel(item.source)}</span>
                  <span className={profileTimelineStatusClass(item.status)}>{profileStatusLabel(item.status)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{summarizeProfileTimelineEntry(item)}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{summarizeProfileUpdateEvidence(item)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function profileTimelineStatusClass(status: ProfileTimelineEntry['status']) {
  const tone = profileStatusTone(status);
  if (tone === 'green') return 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700';
  if (tone === 'orange') return 'rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700';
  if (tone === 'red') return 'rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700';
  if (tone === 'blue') return 'rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700';
  return 'rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600';
}

function ProfilePreviewStrip({ previewRows }: { previewRows: string[][] }) {
  const featured = previewRows.slice(0, 4);
  const rest = previewRows.slice(4);
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-900">已填写的学习信息</div>
        <span className="text-xs text-slate-500">来自上方对话和手动填写</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {featured.map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-50 px-3 py-2">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-1 line-clamp-2 min-h-5 text-sm font-semibold leading-5 text-slate-950">{value || '待完善'}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {rest.map(([label, value]) => (
          <span key={label} className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
            {label}：<span className="font-semibold text-slate-950">{value || '待完善'}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ProfilePlanningImpactPreview({
  courseTitle,
  profile,
  completeness,
  saveResult,
}: {
  courseTitle: string;
  profile: A3LearningProfile;
  completeness: number;
  saveResult: ApiResult | null;
}) {
  const weakPoints = profile.weakPoints.slice(0, 2).join('、') || '待补充';
  const goals = profile.learningGoals.slice(0, 2).join('、') || '待补充';
  const resources = profile.expectedResources.slice(0, 2).join('、') || '待补充';
  const planPace = profile.dailyStudyTime || profile.pace
    ? `${profile.dailyStudyTime ? `${profile.dailyStudyTime} 分钟/天` : '每日时间待补充'} · ${profile.pace ? planModeLabel(profile.pace) : '学习节奏待补充'}`
    : '待补充每日时间和学习节奏';
  const impactRows = [
    { label: '诊断会优先看', value: weakPoints },
    { label: '路径会从这里排', value: profile.foundationLevel || '待补充基础水平' },
    { label: '计划节奏', value: planPace },
    { label: '资源生成偏好', value: resources },
  ];

  return (
    <div data-testid="a3-profile-planning-preview" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-950">系统会这样安排学习</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">{courseTitle} · 目标：{goals}</div>
        </div>
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{completeness}%</span>
      </div>
      <div className="mt-4 h-2 rounded-full bg-slate-100">
        <div className="h-2 rounded-full bg-blue-600 transition-all" style={{ width: `${Math.min(100, Math.max(0, completeness))}%` }} />
      </div>
      <div className="mt-4 grid gap-2">
        {impactRows.map((row) => (
          <div key={row.label} className="rounded-xl bg-slate-50 px-3 py-2">
            <div className="text-xs font-medium text-slate-500">{row.label}</div>
            <div className="mt-1 text-sm font-semibold leading-5 text-slate-950">{row.value}</div>
          </div>
        ))}
      </div>
      {saveResult?.planningDeferred ? (
        <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
          完成入学诊断后，系统会据此生成学习路径和 14 天计划。
        </div>
      ) : saveResult?.personalizationImpact?.explanation ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
          {saveResult.personalizationImpact.explanation}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
          保存后，学习路径、周期计划和今日任务会根据这些信息自动更新。
        </div>
      )}
    </div>
  );
}

function planModeLabel(mode?: string) {
  if (mode === 'relaxed') return '稳扎稳打';
  if (mode === 'intensive') return '强化提升';
  if (mode === 'reduced_load') return '降低负荷';
  if (mode === 'accelerated') return '强化推进';
  if (mode === 'standard') return '标准节奏';
  return mode || '自动适配';
}

function getMissingProfileDimensions(profile?: ProfileInterviewResult['profile']) {
  const checks: Array<[string, unknown]> = [
    ['年级', profile?.grade],
    ['专业方向', profile?.majorDirection],
    ['基础水平', profile?.foundationLevel],
    ['每天可以学习多久', profile?.dailyMinutes],
    ['学习目标', profile?.learningGoals?.length],
    ['薄弱知识点', profile?.weakPoints?.length],
    ['喜欢的资源类型', profile?.resourcePreferences?.length],
    ['更容易理解的讲解方式', profile?.cognitiveStyle],
    ['以前学过的内容', profile?.learningHistory],
    ['坚持学习时遇到的困难', profile?.motivationRisk],
  ];
  return checks.filter(([, value]) => !value).map(([label]) => label);
}

function normalizeProfileInterviewMessages(session?: ProfileInterviewSession): ProfileInterviewMessage[] {
  const messages = session?.messages ?? [];
  return messages
    .map((item): ProfileInterviewMessage | null => {
      const content = String(item.content ?? '').trim();
      if (!content) return null;
      return { role: item.role === 'user' ? 'user' : 'agent', content };
    })
    .filter((item): item is ProfileInterviewMessage => Boolean(item));
}

function buildProfileInterviewFollowUp(missing: string[]) {
  if (missing.length === 0) {
    return '画像信息已经比较完整。你可以继续补充细节，或直接确认画像并进入入学诊断。';
  }
  const topMissing = missing.slice(0, 3).join('、');
  return `还缺少 ${topMissing}。请补充这些信息，例如“我每天能学 40 分钟，喜欢动画和例题，最近进程调度比较弱”。`;
}

function ProfileSection({
  title,
  options,
  active,
  onPick,
  suffix,
}: {
  title: string;
  options: Array<string | ProfileOption>;
  active: string[];
  onPick: (value: string) => void;
  suffix?: string;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => {
          const item = typeof option === 'string' ? { value: option, label: option } : option;
          const selected = active.includes(item.value);
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => onPick(item.value)}
              className={selected ? 'rounded-lg border border-blue-500 bg-blue-50 px-4 py-2 text-left text-sm font-semibold text-blue-700 shadow-sm' : 'rounded-lg border border-slate-200 bg-white px-4 py-2 text-left text-sm text-slate-600 hover:border-blue-200 hover:bg-blue-50/50'}
            >
              <span>{item.label}{suffix ? ` ${suffix}` : ''}</span>
              {(item.chapter || item.difficulty) && (
                <span className="mt-1 block text-xs font-normal opacity-75">
                  {[item.chapter, item.difficulty ? `难度 ${item.difficulty}` : ''].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
