'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BellRing,
  Bot,
  ClipboardCheck,
  FileSearch,
  Gauge,
  GraduationCap,
  Loader2,
  Play,
  RefreshCw,
  Route,
  ShieldCheck,
  UserRoundSearch,
  type LucideIcon,
} from 'lucide-react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3ApiResponse, LearningPath, StudyPlan } from '@/lib/a3/learning-types';
import { buildOpenMAICAcceptanceSummary } from '@/lib/a3/openmaic-acceptance';
import { buildOpenMAICDemoFlowSteps } from '@/lib/a3/openmaic-demo-flow';
import { A3_OPENMAIC_PAGE_OWNERSHIP } from '@/lib/a3/openmaic-page-ownership';
import { buildOpenMAICVerificationSummary } from '@/lib/a3/openmaic-verification-status';
import type { RecommendationResponse } from '@/lib/a3/recommendation-types';
import type { TeacherWorkbench, TeacherWorkbenchStudent } from '@/lib/a3/teacher-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type ProfileExtractResponse = {
  success: boolean;
  error?: string;
  profile?: {
    grade: string;
    majorDirection: string;
    foundationLevel: string;
    weakPoints: string[];
    learningGoals: string[];
    expectedResources: string[];
  } | null;
};

type QaResponse = {
  success: boolean;
  error?: string;
  answer: string;
  citations: Array<{ id: string; title: string; location: string; score: number | null; snippet: string }>;
  verified: boolean;
};

type DemoStatusResponse = {
  success: boolean;
  error?: string;
  productReadiness?: {
    score: number;
    status: string;
    readyCount: number;
    total: number;
    blockers: Array<{ key: string; title: string; href: string }>;
  };
  apis?: Array<{ group: string; method: string; path: string; status: string }>;
  evaluation?: {
    totalCases?: number;
    groundedCases?: number;
    unsafeCases?: number;
    targetCases?: number;
    scaleReady?: boolean;
    latestMetricsFile?: string;
    metrics?: Record<string, number | string | boolean>;
  };
  agentRuns?: Array<{ traceId?: string; workflow: string; status: string; latencyMs: number }>;
};

type DemoValidateResponse = {
  success: boolean;
  error?: string;
  validation?: {
    overallStatus: 'pass' | 'warn' | 'fail';
    checks: Array<{ name: string; status: string; message: string; detail: Record<string, unknown> }>;
  };
  reportPath?: string;
  reportMarkdown?: string;
};

type NotificationResponse = {
  success: boolean;
  error?: string;
  notifications: Array<{
    id: string;
    title: string;
    detail: string;
    actionUrl: string;
    payload: Record<string, unknown>;
  }>;
};

type TeacherWorkbenchResponse = {
  success: boolean;
  error?: string;
  workbench: TeacherWorkbench;
};

type ExecuteTaskResponse = {
  success: boolean;
  error?: string;
  result?: {
    createdNotifications: number;
    targetStudentName?: string;
    actionUrl?: string;
  };
};

const sampleProfileText =
  '我是计算机专业大二学生，正在学习操作系统。进程调度、同步互斥和虚拟内存掌握不牢，希望每天学习 60 分钟，通过课件讲义、练习题、代码实验和知识卡片补齐薄弱点。';

const scriptSteps = [
  { time: '00:00', title: '首启与画像', desc: '展示用户目标、基础水平、薄弱点和资源偏好如何抽取为结构化画像。', href: '/a3/profile-setup' },
  { time: '00:45', title: '诊断到计划', desc: '入学诊断刷新路径和 7/14/30 天计划，首页明确今天要做什么。', href: '/a3/admission-diagnostic' },
  { time: '01:45', title: '今日任务执行', desc: '完成学习任务后更新路径进度，反馈下一步，并触发学习报告变化。', href: '/a3/today' },
  { time: '02:45', title: 'RAG 推荐与辅导', desc: '推荐带排序理由和引用来源，AI 课堂回答经过验证和安全过滤。', href: '/a3/classroom' },
  { time: '04:00', title: '错题复盘闭环', desc: '通知提醒、错题本、报告 insight 和 CSV 导出共同证明复习闭环。', href: '/a3/notifications' },
  { time: '05:00', title: '教师干预闭环', desc: '教师看到风险学生，一键下发定制任务，学生通知中心收到可执行提醒。', href: '/a3/teacher' },
];

const openmaicDemoSteps = buildOpenMAICDemoFlowSteps(A3_OPENMAIC_PAGE_OWNERSHIP);
const openmaicAcceptanceSummary = buildOpenMAICAcceptanceSummary(
  A3_OPENMAIC_PAGE_OWNERSHIP,
  buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, false),
);

export function DemoFlowView() {
  const currentUser = useA3CurrentUser();
  const [profileText, setProfileText] = useState(sampleProfileText);
  const [profile, setProfile] = useState<ProfileExtractResponse['profile']>(null);
  const [path, setPath] = useState<LearningPath | null>(null);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [recommendation, setRecommendation] = useState<RecommendationResponse | null>(null);
  const [qa, setQa] = useState<QaResponse | null>(null);
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [validation, setValidation] = useState<DemoValidateResponse | null>(null);
  const [teacher, setTeacher] = useState<TeacherWorkbench | null>(null);
  const [notifications, setNotifications] = useState<NotificationResponse['notifications']>([]);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const targetStudent = useMemo(() => pickTargetStudent(teacher?.students ?? []), [teacher?.students]);
  const hasInterventionNotification = useMemo(
    () => notifications.some((notification) => notification.payload.targetedByTeacher === true),
    [notifications],
  );
  const progress = useMemo(() => {
    const checks = [
      Boolean(profile),
      Boolean(path),
      Boolean(plan?.days?.length),
      Boolean(recommendation?.recommendations?.length),
      Boolean(qa),
      Boolean(teacher?.students?.length),
      Boolean(notifications.length),
      validation?.validation?.overallStatus === 'pass' || (status?.productReadiness?.score ?? 0) >= 70,
    ];
    return Math.round((checks.filter(Boolean).length * 100) / checks.length);
  }, [profile, path, plan, recommendation, qa, teacher, notifications.length, validation?.validation?.overallStatus, status?.productReadiness?.score]);

  const evaluationMetrics = status?.evaluation?.metrics ?? {};
  const evaluationTotalCases = status?.evaluation?.totalCases ?? Number(evaluationMetrics.totalCases ?? 0);
  const evaluationTargetCases = status?.evaluation?.targetCases ?? 50;
  const evaluationScaleReady = Boolean(status?.evaluation?.scaleReady ?? evaluationTotalCases >= evaluationTargetCases);

  const loadSnapshot = useCallback(async () => {
    setLoadingStep('snapshot');
    const canReadTeacherWorkbench = currentUser?.role === 'teacher' || currentUser?.role === 'admin';
    const [pathResult, planResult, recResult, statusResult, teacherResult, notificationResult] = await Promise.all([
      a3GetJson<A3ApiResponse<{ path: LearningPath | null }>>('/api/learning/paths/current/'),
      a3GetJson<A3ApiResponse<{ plan: StudyPlan }>>('/api/learning/study-plan/?auto=1'),
      a3PostJson<RecommendationResponse>('/api/recommend/', { goal: '进程调度与虚拟内存薄弱点', topK: 5 }),
      a3GetJson<DemoStatusResponse>('/api/demo/status/'),
      canReadTeacherWorkbench
        ? a3GetJson<TeacherWorkbenchResponse>('/api/learning/teacher/workbench/')
        : Promise.resolve({ success: false } as TeacherWorkbenchResponse),
      a3GetJson<NotificationResponse>('/api/engagement/notifications/'),
    ]);
    setLoadingStep(null);
    if (pathResult.success) setPath(pathResult.path);
    if (planResult.success) setPlan(planResult.plan);
    if (recResult.success) setRecommendation(recResult);
    if (statusResult.success) setStatus(statusResult);
    if (teacherResult.success) setTeacher(teacherResult.workbench);
    if (notificationResult.success) setNotifications(notificationResult.notifications);
  }, [currentUser?.role]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSnapshot();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSnapshot]);

  async function runProfileExtract() {
    setLoadingStep('profile');
    setMessage('');
    const result = await a3PostJson<ProfileExtractResponse>('/api/profile/extract/', { text: profileText });
    setLoadingStep(null);
    if (!result.success) {
      setMessage(result.error ?? '画像抽取失败');
      return;
    }
    setProfile(result.profile ?? null);
    await refreshRecommendations(profileText);
  }

  async function runPathAndPlan() {
    setLoadingStep('path');
    setMessage('');
    const [pathResult, planResult] = await Promise.all([
      a3PostJson<A3ApiResponse<{ path: LearningPath }>>('/api/path/generate/', { force: true }),
      a3PostJson<A3ApiResponse<{ plan: StudyPlan }>>('/api/learning/study-plan/generate/', { durationDays: 14, force: true }),
    ]);
    setLoadingStep(null);
    if (!pathResult.success || !planResult.success) {
      setMessage(pathResult.error ?? planResult.error ?? '路径或计划生成失败');
      return;
    }
    setPath(pathResult.path);
    setPlan(planResult.plan);
    await refreshRecommendations(pathResult.path.items[0]?.knowledgePoint.title ?? profileText);
  }

  async function refreshRecommendations(goal = profileText) {
    setLoadingStep('recommend');
    const result = await a3PostJson<RecommendationResponse>('/api/recommend/', { goal, topK: 5 });
    setLoadingStep(null);
    if (!result.success) {
      setMessage(result.error ?? '推荐刷新失败');
      return;
    }
    setRecommendation(result);
  }

  async function runQaVerify() {
    setLoadingStep('qa');
    setMessage('');
    const target = path?.items.find((item) => item.status === 'current')?.knowledgePoint.title || recommendation?.target?.title || '处理机调度';
    const result = await a3GetJson<QaResponse>(`/api/v1/qa/interact/?q=${encodeURIComponent(`请解释 ${target}，并给出课程来源。`)}`);
    setLoadingStep(null);
    if (!result.success) {
      setMessage(result.error ?? '溯源问答失败');
      return;
    }
    setQa(result);
  }

  async function runTeacherIntervention() {
    if (!targetStudent) {
      setMessage('当前教师工作台没有可干预学生，请先初始化演示数据或切换教师账号。');
      return;
    }
    setLoadingStep('teacher');
    setMessage('');
    const result = await a3PostJson<ExecuteTaskResponse>('/api/learning/teacher/tasks/execute/', {
      type: targetStudent.interventionAction?.type ?? 'intervention',
      studentId: targetStudent.id,
      message: `${targetStudent.prescription?.title ?? '教师学习提醒'}：${targetStudent.prescription?.reason ?? '请优先完成今日任务和错题复盘。'}`,
    });
    const notificationResult = await a3GetJson<NotificationResponse>('/api/engagement/notifications/?action=review');
    setLoadingStep(null);
    if (!result.success || !result.result) {
      setMessage(result.error ?? '教师干预任务下发失败');
      return;
    }
    if (notificationResult.success) setNotifications(notificationResult.notifications);
    setMessage(`教师已向 ${result.result.targetStudentName ?? targetStudent.name} 下发定制任务`);
  }

  async function runValidationReport() {
    setLoadingStep('validate');
    setMessage('');
    const result = await a3PostJson<DemoValidateResponse>('/api/demo/validate/', {});
    setLoadingStep(null);
    if (!result.success) {
      setMessage(result.error ?? '演示验收失败');
      return;
    }
    setValidation(result);
    setMessage(`验收报告已生成：${result.reportPath ?? 'backend/tmp/demo_validation_report.md'}`);
  }

  async function loadValidationReport() {
    setLoadingStep('report');
    const result = await a3GetJson<DemoValidateResponse>('/api/demo/report/');
    setLoadingStep(null);
    if (!result.success) {
      setMessage(result.error ?? '验收报告尚未生成');
      return;
    }
    setValidation(result);
    setMessage(`已读取最新验收报告：${result.reportPath ?? 'backend/tmp/demo_validation_report.md'}`);
  }

  async function copyValidationReport() {
    const text = validation?.reportMarkdown;
    if (!text) {
      setMessage('请先生成或读取验收报告。');
      return;
    }
    await navigator.clipboard.writeText(text);
    setMessage('验收报告已复制，可直接粘贴到答辩材料。');
  }

  async function runFullFlow() {
    await runProfileExtract();
    await runPathAndPlan();
    await refreshRecommendations(profileText);
    await runQaVerify();
    await runTeacherIntervention();
    await runValidationReport();
    await loadSnapshot();
  }

  return (
    <div className="space-y-5" data-testid="a3-demo-flow">
      <section className="grid gap-5 xl:grid-cols-[1.35fr_0.8fr]">
        <div className="rounded-[20px] border border-slate-800 bg-slate-950 p-6 text-slate-50 shadow-[0_22px_60px_rgba(15,23,42,0.24)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-4xl">
              <A3Pill tone="green">竞赛固定演示</A3Pill>
              <h1 className="mt-5 text-3xl font-semibold tracking-normal">6 分钟跑通个性化学习闭环</h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
                这不是静态清单。页面会调用真实后端接口，现场展示画像、路径、计划、推荐、验证、报告、教师干预和通知回流。
              </p>
            </div>
            <div className="rounded-2xl bg-slate-900 px-5 py-4 text-right ring-1 ring-white/10">
              <div className="text-xs text-slate-400">演示闭环完成度</div>
              <div className="mt-2 text-4xl font-semibold">{progress}%</div>
            </div>
          </div>
          <div className="mt-6 h-2 rounded-full bg-white/10">
            <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={runFullFlow} disabled={Boolean(loadingStep)} className="h-10 bg-emerald-500 text-slate-950 hover:bg-emerald-400">
              {loadingStep ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              一键跑通闭环
            </Button>
            <Button onClick={runValidationReport} disabled={Boolean(loadingStep)} variant="outline" className="h-10 border-white/20 bg-white/10 text-white hover:bg-white/15">
              <ClipboardCheck className="size-4" />
              生成验收报告
            </Button>
            <Button asChild variant="outline" className="h-10 border-white/20 bg-white/10 text-white hover:bg-white/15">
              <Link href="/a3/today">进入今日任务<ArrowRight className="size-4" /></Link>
            </Button>
            <Button asChild variant="outline" className="h-10 border-white/20 bg-white/10 text-white hover:bg-white/15">
              <Link href="/a3/teacher">教师工作台<GraduationCap className="size-4" /></Link>
            </Button>
          </div>
        </div>

        <A3Card title="验收状态" action={loadingStep === 'snapshot' ? <Loader2 className="size-4 animate-spin text-blue-600" /> : <Gauge className="size-4 text-blue-600" />}>
          <div className="grid grid-cols-2 gap-3">
            <Signal label="产品就绪度" value={`${status?.productReadiness?.score ?? 0}%`} />
            <Signal label="API 数量" value={`${status?.apis?.length ?? 0}`} />
            <Signal label="最近通知" value={`${notifications.length}`} />
            <Signal label="验收状态" value={validation?.validation?.overallStatus ?? '未运行'} />
          </div>
          {message && <div className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">{message}</div>}
          <Button variant="outline" className="mt-4 w-full" onClick={() => void loadSnapshot()} disabled={Boolean(loadingStep)}>
            <RefreshCw className="size-4" />
            刷新演示快照
          </Button>
        </A3Card>
      </section>

      <A3Card title="答辩脚本">
        <div
          data-testid="a3-defense-script-entry"
          className="mb-4 grid gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 md:grid-cols-[1fr_auto] md:items-center"
        >
          <div>
            <div className="text-sm font-semibold text-blue-950">6 分钟答辩脚本</div>
            <p className="mt-2 text-xs leading-5 text-blue-800">
              现场答辩按本文档执行：先跑 `/a3/demo-flow`，再展示 `/a3/capabilities`、验收报告和 50 条评测指标。
            </p>
            <div className="mt-3 rounded-lg bg-white px-3 py-2 font-mono text-[11px] text-blue-900">
              docs/A3_6分钟答辩脚本.md
            </div>
          </div>
          <Button asChild variant="outline" className="border-blue-200 bg-white text-blue-800 hover:bg-blue-100">
            <Link href="/a3/capabilities">
              打开证据页
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {scriptSteps.map((step, index) => (
            <Link key={step.title} href={step.href} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition hover:border-blue-200 hover:bg-blue-50">
              <div className="flex items-center justify-between">
                <A3Pill tone={index < 2 ? 'blue' : index < 4 ? 'orange' : 'green'}>{step.time}</A3Pill>
                <ArrowRight className="size-4 text-[var(--a3-text-muted)]" />
              </div>
              <div className="mt-3 text-sm font-semibold text-[var(--a3-text)]">{step.title}</div>
              <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{step.desc}</p>
            </Link>
          ))}
        </div>
        <OpenMAICDemoSection />
      </A3Card>

      <A3Card
        title="评测证据与答辩定位"
        subtitle="答辩时先说明评测规模、达标指标和复现命令，再跳转能力页展示完整证据板。"
        action={<A3Pill tone={evaluationScaleReady ? 'green' : 'orange'}>{evaluationTotalCases || '--'}/{evaluationTargetCases}</A3Pill>}
      >
        <div data-testid="a3-demo-evaluation-evidence" className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className={evaluationScaleReady ? 'rounded-2xl border border-emerald-200 bg-emerald-50 p-5' : 'rounded-2xl border border-orange-200 bg-orange-50 p-5'}>
            <div className={evaluationScaleReady ? 'text-sm font-semibold text-emerald-950' : 'text-sm font-semibold text-orange-950'}>50 条评测集规模</div>
            <p className={evaluationScaleReady ? 'mt-2 text-xs leading-6 text-emerald-800' : 'mt-2 text-xs leading-6 text-orange-800'}>
              当前 {evaluationTotalCases || '--'} 条，目标 {evaluationTargetCases} 条；其中 grounded {status?.evaluation?.groundedCases ?? '--'} 条，unsafe {status?.evaluation?.unsafeCases ?? '--'} 条。
            </p>
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              <Signal label="Top3 命中率" value={formatMetricPercent(evaluationMetrics.retrievalTop3HitRate)} />
              <Signal label="验证覆盖率" value={formatMetricPercent(evaluationMetrics.verifiedCoverage)} />
              <Signal label="安全拒答率" value={formatMetricPercent(evaluationMetrics.safetyRefusalRate)} />
              <Signal label="Top1 命中率" value={formatMetricPercent(evaluationMetrics.retrievalTop1HitRate)} />
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-5">
            <div className="text-sm font-semibold text-[var(--a3-text)]">答辩话术</div>
            <p className="mt-2 text-xs leading-6 text-[var(--a3-text-muted)]">
              本系统不是静态 demo：评测集由后端命令生成，指标文件保存在 {status?.evaluation?.latestMetricsFile ?? 'backend/tmp/demo_retrieval_metrics.json'}，能力页可查看 market readiness、evidence board 和 Agent trace。
            </p>
            <CommandLine text="backend\\.venv\\Scripts\\python.exe backend\\manage.py evaluate_demo_retrieval --top-k 3 --json --output backend\\tmp\\demo_retrieval_metrics.json" />
            <Button asChild variant="outline" className="mt-4 w-full">
              <Link href="/a3/capabilities">
                打开 /a3/capabilities 完整证据页
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </A3Card>

      <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <A3Card title="1. 画像抽取" action={<Button size="sm" onClick={runProfileExtract} disabled={Boolean(loadingStep)}><UserRoundSearch className="size-4" />抽取画像</Button>}>
          <textarea
            value={profileText}
            onChange={(event) => setProfileText(event.target.value)}
            className="min-h-[140px] w-full resize-none rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-3 text-sm leading-7 outline-none focus:border-blue-400"
          />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Signal label="年级" value={profile?.grade || '待抽取'} />
            <Signal label="基础" value={profile?.foundationLevel || '待抽取'} />
            <Signal label="方向" value={profile?.majorDirection || '待抽取'} />
            <Signal label="资源偏好" value={profile?.expectedResources?.slice(0, 2).join('、') || '待抽取'} />
          </div>
          <TagList items={profile?.weakPoints ?? ['处理机调度算法', '虚拟内存与页面置换']} tone="orange" />
        </A3Card>

        <A3Card title="2. 路径和计划" action={<Button size="sm" variant="outline" onClick={runPathAndPlan} disabled={Boolean(loadingStep)}><Route className="size-4" />重新生成</Button>}>
          <div className="rounded-2xl bg-[var(--a3-surface-muted)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-[var(--a3-text-muted)]">当前学习路径</div>
                <div className="mt-1 text-lg font-semibold text-[var(--a3-text)]">{path?.title || '尚未生成'}</div>
              </div>
              <A3Pill tone="blue">{path?.progress ?? 0}%</A3Pill>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {(path?.items ?? []).slice(0, 6).map((item) => (
                <div key={item.id} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3">
                  <div className="text-xs text-[var(--a3-text-muted)]">#{item.order}</div>
                  <div className="mt-1 line-clamp-2 text-sm font-semibold text-[var(--a3-text)]">{item.knowledgePoint.title}</div>
                  <div className="mt-2 text-xs text-[var(--a3-text-muted)]">难度 {item.knowledgePoint.difficulty} · {item.status}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <Signal label="计划周期" value={`${plan?.durationDays ?? 0} 天`} />
            <Signal label="每日时长" value={`${plan?.dailyMinutes ?? 0} 分钟`} />
            <Signal label="今日任务" value={`${plan?.days?.[0]?.tasks?.length ?? 0} 项`} />
          </div>
        </A3Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <A3Card title="3. 推荐与引用验证" action={<Button size="sm" variant="outline" onClick={() => refreshRecommendations()} disabled={Boolean(loadingStep)}><FileSearch className="size-4" />刷新推荐</Button>}>
          <div className="grid gap-3 md:grid-cols-2">
            {(recommendation?.recommendations ?? []).slice(0, 4).map((item) => (
              <Link key={item.id} href={item.href} className="rounded-2xl border border-[var(--a3-border)] p-4 hover:bg-blue-50">
                <div className="flex items-center justify-between gap-3">
                  <A3Pill tone={item.citation ? 'green' : 'slate'}>{item.type}</A3Pill>
                  <span className="text-2xl font-semibold text-blue-700">{item.score}</span>
                </div>
                <div className="mt-3 line-clamp-2 text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.reason}</p>
              </Link>
            ))}
          </div>
        </A3Card>

        <A3Card title="4. AI 课堂验证" action={<Button size="sm" onClick={runQaVerify} disabled={Boolean(loadingStep)}><Bot className="size-4" />验证回答</Button>}>
          {qa ? (
            <div className="space-y-3">
              <A3Pill tone={qa.verified ? 'green' : 'orange'}>{qa.verified ? '已验证' : '未验证'}</A3Pill>
              <p className="line-clamp-5 text-sm leading-7 text-[var(--a3-text)]">{qa.answer}</p>
              <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3 text-xs leading-5 text-[var(--a3-text-muted)]">
                引用数量：{qa.citations.length}
              </div>
            </div>
          ) : (
            <EmptyHint icon={ShieldCheck} text="点击验证回答后，系统会调用真实 QA 兼容接口，并展示引用或未验证状态。" />
          )}
        </A3Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <A3Card
          title="5. 教师干预"
          action={
            <div className="flex items-center gap-2">
              {hasInterventionNotification && <A3Pill tone="green">已下发</A3Pill>}
              <Button size="sm" onClick={runTeacherIntervention} disabled={Boolean(loadingStep)}>
                <GraduationCap className="size-4" />
                {hasInterventionNotification ? '重新下发' : '下发定制任务'}
              </Button>
            </div>
          }
        >
          {targetStudent ? (
            <div className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-[var(--a3-text)]">{targetStudent.name}</div>
                  <p className="mt-1 text-xs text-[var(--a3-text-muted)]">{targetStudent.currentPoint} · 进度 {targetStudent.progress}%</p>
                </div>
                <A3Pill tone={targetStudent.riskLevel === 'high' ? 'red' : targetStudent.riskLevel === 'medium' ? 'orange' : 'green'}>
                  {targetStudent.riskLevel === 'high' ? '需干预' : targetStudent.riskLevel === 'medium' ? '需跟进' : '稳定'}
                </A3Pill>
              </div>
              {targetStudent.riskReason && (
                <p className="mt-2 text-xs leading-5 text-rose-700">{targetStudent.riskReason}</p>
              )}
              <div className="mt-4 rounded-xl bg-[var(--a3-surface-muted)] p-3">
                <div className="text-sm font-semibold text-[var(--a3-text)]">{targetStudent.prescription?.title ?? '学习处方'}</div>
                <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">{targetStudent.prescription?.reason ?? '按当前学习路径完成任务。'}</p>
              </div>
            </div>
          ) : (
            <EmptyHint icon={GraduationCap} text="当前没有可展示学生。请使用教师账号或初始化演示数据。" />
          )}
        </A3Card>

        <A3Card title="6. 学生通知回流" action={<Button asChild size="sm" variant="outline"><Link href="/a3/notifications"><BellRing className="size-4" />打开通知中心</Link></Button>}>
          <div className="grid gap-3 md:grid-cols-2">
            {notifications.slice(0, 4).map((item) => (
              <Link key={item.id} href={item.actionUrl || '/a3/notifications'} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 hover:bg-blue-50">
                <div className="flex items-center gap-2">
                  <BellRing className="size-4 text-blue-600" />
                  <div className="line-clamp-1 text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
              </Link>
            ))}
            {!notifications.length && <EmptyHint icon={BellRing} text="暂无通知。运行完整闭环后会展示学生端可执行提醒。" />}
          </div>
        </A3Card>
      </section>

      <A3Card title="验收报告与接口覆盖" action={<Button size="sm" data-testid="a3-run-validation" onClick={runValidationReport} disabled={Boolean(loadingStep)}><ClipboardCheck className="size-4" />运行验收</Button>}>
        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-3">
            <CommandLine text="backend\\.venv\\Scripts\\python.exe backend\\manage.py validate_demo_flow --skip-seed --strict --report-output backend\\tmp\\demo_validation_report.md" />
            <CommandLine text="backend\\.venv\\Scripts\\python.exe backend\\manage.py evaluate_demo_retrieval --top-k 3 --json --output backend\\tmp\\demo_retrieval_metrics.json" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={loadValidationReport} disabled={Boolean(loadingStep)}>
                <RefreshCw className="size-4" />
                读取最新报告
              </Button>
              <Button size="sm" variant="outline" onClick={copyValidationReport} disabled={!validation?.reportMarkdown}>
                <ClipboardCheck className="size-4" />
                复制报告
              </Button>
            </div>
            {validation?.reportMarkdown && (
              <div data-testid="a3-validation-report" className="max-h-72 overflow-auto rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4 text-xs leading-6 text-[var(--a3-text)]">
                <pre className="whitespace-pre-wrap font-sans">{validation.reportMarkdown}</pre>
              </div>
            )}
          </div>
          <ApiCoverageList apis={status?.apis ?? []} />
        </div>
      </A3Card>
    </div>
  );
}

function OpenMAICDemoSection() {
  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4" data-testid="a3-openmaic-demo-flow">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
        <div>
          <div className="text-sm font-semibold text-slate-950">OpenMAIC 接入演示路径</div>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            这条路径专门回答“开源项目接到 A3 哪些页面、谁负责、证据在哪”。A3 页面保留学习软件主流程，OpenMAIC 能力通过 bridge API 接入。
          </p>
        </div>
        <A3Pill tone="green">{openmaicDemoSteps.length} pages</A3Pill>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {openmaicDemoSteps.map((step) => (
          <Link
            key={step.href}
            href={step.href}
            className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-blue-300 hover:bg-blue-50"
            data-testid="a3-openmaic-demo-step"
          >
            <div className="flex items-center justify-between gap-2">
              <A3Pill tone="blue">#{step.order}</A3Pill>
              <ArrowRight className="size-4 text-slate-400" />
            </div>
            <div className="mt-3 text-sm font-semibold text-slate-950">{step.title}</div>
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600">{step.capability}</p>
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
              {step.evidence.slice(0, 2).join(' / ')}
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{step.handoffRule}</p>
          </Link>
        ))}
      </div>
      <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4" data-testid="a3-openmaic-acceptance-checklist">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <div className="text-sm font-semibold text-emerald-950">OpenMAIC 接入验收清单</div>
            <p className="mt-1 text-xs leading-5 text-emerald-800">
              这份清单定义“开源项目已经接到 A3”的最低验收标准：页面归属、artifact 写回、历史审计、课堂/PPT 边界、教师效果和视频 provider smoke。
            </p>
          </div>
          <A3Pill tone={openmaicAcceptanceSummary.warnings > 0 ? 'orange' : 'green'}>
            {openmaicAcceptanceSummary.ready}/{openmaicAcceptanceSummary.total} ready
          </A3Pill>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {openmaicAcceptanceSummary.items.map((item) => (
            <Link
              key={item.key}
              href={item.ownerPage.replace('[packId]', 'latest')}
              className="rounded-xl border border-emerald-100 bg-white p-4 transition hover:border-emerald-300 hover:bg-emerald-50"
              data-testid="a3-openmaic-acceptance-item"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-emerald-950">{item.title}</span>
                <A3Pill tone={item.status === 'ready' ? 'green' : 'orange'}>{item.status}</A3Pill>
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-emerald-800">{item.standard}</p>
              <div className="mt-3 rounded-lg bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 text-emerald-200">{item.command}</div>
              <div className="mt-2 line-clamp-2 text-xs leading-5 text-emerald-700">证据：{item.evidence.join(' / ')}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function ApiCoverageList({ apis }: { apis: Array<{ group: string; method: string; path: string; status: string }> }) {
  const grouped = apis.reduce<Record<string, Array<{ group: string; method: string; path: string; status: string }>>>((acc, api) => {
    if (!acc[api.group]) acc[api.group] = [];
    acc[api.group].push(api);
    return acc;
  }, {});
  return (
    <div className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-[var(--a3-border)] p-2">
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group}>
          <div className="sticky top-0 bg-[var(--a3-surface)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--a3-text-muted)]">{group}</div>
          {(items ?? []).map((api) => (
            <div key={`${api.method}-${api.path}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--a3-surface-muted)]">
              <span className="truncate text-[var(--a3-text)]">{api.path}</span>
              <A3Pill tone={api.method === 'DELETE' ? 'red' : api.method === 'CLI' ? 'violet' : api.method === 'GET' ? 'blue' : 'green'}>{api.method}</A3Pill>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function pickTargetStudent(students: TeacherWorkbenchStudent[]) {
  return [...students].sort((left, right) => {
    const riskWeight = { high: 0, medium: 1, low: 2 };
    return riskWeight[left.riskLevel] - riskWeight[right.riskLevel] || left.progress - right.progress;
  })[0] ?? null;
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function formatMetricPercent(value: number | string | boolean | undefined) {
  if (typeof value === 'number') return `${Math.round(value)}%`;
  if (typeof value === 'string' && value.trim()) return value.endsWith('%') ? value : `${value}%`;
  return '--';
}

function TagList({ items, tone }: { items: string[]; tone: 'orange' | 'blue' | 'green' }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <A3Pill key={item} tone={tone}>{item}</A3Pill>
      ))}
    </div>
  );
}

function EmptyHint({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-[var(--a3-surface-muted)] p-4 text-sm leading-6 text-[var(--a3-text-muted)]">
      <Icon className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <span>{text}</span>
    </div>
  );
}

function CommandLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-slate-950 px-4 py-3 font-mono text-xs text-slate-100">
      <ClipboardCheck className="size-4 shrink-0 text-emerald-400" />
      <span className="break-all">{text}</span>
    </div>
  );
}
