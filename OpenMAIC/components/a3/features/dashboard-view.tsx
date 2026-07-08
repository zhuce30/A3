'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Award,
  BookOpen,
  Bot,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  Flame,
  Loader2,
  MessageCircle,
  Send,
  Target,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { DynamicProfileInsightPanel, type DynamicProfileInsight } from '@/components/a3/profile/dynamic-profile-insight-panel';
import { a3GetJson } from '@/lib/a3/api-client';
import type { LearningReport } from '@/lib/a3/assessment-types';
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import type { A3ApiResponse, LearningPath, MotivationSummary, PathItem, StudyPlan } from '@/lib/a3/learning-types';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';

type DashboardResponse = A3ApiResponse<{ path: LearningPath | null; currentItem: PathItem | null; motivation?: MotivationSummary }>;
type ReportResponse = { success: boolean; error?: string; report: LearningReport };
type ClassroomResponse = { success: boolean; error?: string; classroom: ClassroomContext };
type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan }>;
type StudyPlanRelationship = NonNullable<StudyPlan['planContext']>['relationship'];
type ProfileSnapshotResponse = {
  success: boolean;
  error?: string;
  profile?: {
    extraProfile?: {
      dynamicProfile?: DynamicProfileInsight;
    };
  };
};

type DashboardTask = {
  key: string;
  title: string;
  subtitle: string;
  href: string;
  done: boolean;
};

const metricTone = {
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-emerald-50 text-emerald-700',
  violet: 'bg-violet-50 text-violet-700',
  orange: 'bg-orange-50 text-orange-700',
};

export function DashboardView() {
  const user = useA3CurrentUser();
  const [learningSummary, setLearningSummary] = useState<{ path: LearningPath | null; currentItem: PathItem | null }>({ path: null, currentItem: null });
  const [report, setReport] = useState<LearningReport | null>(null);
  const [classroom, setClassroom] = useState<ClassroomContext | null>(null);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [motivation, setMotivation] = useState<MotivationSummary | null>(null);
  const [dynamicProfile, setDynamicProfile] = useState<DynamicProfileInsight | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      const [dashboardResult, reportResult, classroomResult, planResult, profileResult] = await Promise.all([
        a3GetJson<DashboardResponse>('/api/learning/dashboard/'),
        a3GetJson<ReportResponse>('/api/assessments/report/'),
        a3GetJson<ClassroomResponse>('/api/learning/classroom/'),
        a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1'),
        a3GetJson<ProfileSnapshotResponse>('/api/profiles/me/'),
      ]);
      if (!active) return;
      if (dashboardResult.success) {
        setLearningSummary({ path: dashboardResult.path, currentItem: dashboardResult.currentItem });
        setMotivation(dashboardResult.motivation ?? null);
      }
      if (reportResult.success) setReport(reportResult.report);
      if (classroomResult.success) setClassroom(classroomResult.classroom);
      if (planResult.success) setStudyPlan(planResult.plan);
      if (profileResult.success) setDynamicProfile(profileResult.profile?.extraProfile?.dynamicProfile ?? null);
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const displayName = user?.displayName?.trim() || '同学';
  const majorText = user?.school ? `${user.school} · 操作系统方向` : '计算机专业 · 操作系统方向';
  const activePath = learningSummary.path;
  const currentItem = learningSummary.currentItem;
  const completedCount = activePath?.items.filter((item) => item.status === 'completed').length ?? 0;
  const tasks = useMemo(() => buildTasks(activePath, currentItem, report, studyPlan), [activePath, currentItem, report, studyPlan]);
  const doneTasks = tasks.filter((task) => task.done).length;
  const weakSuggestions = report?.suggestions ?? [];
  const resources = classroom?.recommended ?? [];
  const planRelationship = studyPlan?.planContext?.relationship;
  const primaryAction = motivation?.primaryAction ?? {
    label: currentItem ? '继续学习' : '生成学习路径',
    href: currentItem ? '/a3/learning-path' : '/a3/courses',
    reason: currentItem ? `先推进《${currentItem.knowledgePoint.title}》，完成后会回写路径进度。` : '先建立学习路径，后续计划和今日任务才有依据。',
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            <Database className="size-3.5" />
            数据来自学习路径、计划、测评、课堂和画像接口
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-normal text-[var(--a3-text)]">早上好，{displayName}</h1>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">
            当前路径进度 <span className="font-semibold text-blue-700">{activePath?.progress ?? 0}%</span>。今天先完成最小可执行任务，再回写报告和错题复习。
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-[14px] border border-blue-100 bg-blue-50 px-4 py-3">
          <Bot className="size-5 text-blue-700" />
          <div>
            <div className="text-sm font-semibold text-blue-900">AI 辅导可用</div>
            <div className="text-xs text-blue-700">基于当前节点、知识库和引用验证回答</div>
          </div>
        </div>
      </section>

      <A3Card className="overflow-hidden">
        <div className="grid gap-5 xl:grid-cols-[240px_1fr_260px]">
          <section className="rounded-[14px] bg-orange-50 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-orange-800">
              <Flame className="size-4" />
              连续学习
            </div>
            <div className="mt-4 flex items-end gap-2 text-orange-700">
              <span className="text-5xl font-semibold leading-none">{motivation?.streakDays ?? 0}</span>
              <span className="pb-1 text-base">天</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-orange-800">{motivation?.nudge ?? '完成一个任务即可建立今天的学习记录。'}</p>
          </section>

          <section className="rounded-[14px] bg-blue-50 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-blue-950">{motivation?.weeklyTarget.label ?? '完成今日学习任务'}</div>
                <p className="mt-2 text-sm leading-6 text-blue-800">
                  本周完成 {motivation?.weeklyCompletedTasks ?? motivation?.weeklyTarget.current ?? 0} 个任务，今日剩余约 {motivation?.todayRemainingMinutes ?? 0} 分钟，已完成 {motivation?.todayCompletedTasks ?? doneTasks}/{motivation?.todayTotalTasks ?? tasks.length} 个任务。
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-blue-700">
                {motivation?.weeklyTarget.current ?? doneTasks}/{motivation?.weeklyTarget.target ?? tasks.length}
              </span>
            </div>
            <div className="mt-4 h-3 rounded-full bg-white">
              <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${motivation?.weeklyTarget.progress ?? taskProgress(doneTasks, tasks.length)}%` }} />
            </div>
            <div className="mt-5 rounded-xl bg-white p-4">
              <div className="text-xs font-semibold text-blue-950">现在最该做</div>
              <p className="mt-1 text-xs leading-5 text-blue-800">{primaryAction.reason}</p>
              <RelationshipActionContext relationship={planRelationship} testId="a3-dashboard-relationship-action-context" />
              <Button asChild size="sm" className="mt-3 bg-blue-600 hover:bg-blue-700">
                <Link href={primaryAction.href}>{primaryAction.label}</Link>
              </Button>
            </div>
          </section>

          <section className="rounded-[14px] bg-emerald-50 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <Award className="size-4" />
              学习徽章
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(motivation?.badges ?? [{ id: 'first-step', title: '今日起步', detail: '完成一个任务即可点亮', earned: false }]).map((badge) => (
                <A3Pill key={badge.id} tone={badge.earned ? 'green' : 'slate'}>
                  {badge.title}
                </A3Pill>
              ))}
            </div>
            <p className="mt-3 text-sm leading-6 text-emerald-800">徽章只由任务、复盘和计划进度触发，不做前端假点亮。</p>
            <Button asChild size="sm" variant="outline" className="mt-4 w-full bg-white">
              <Link href="/a3/notifications">查看提醒{motivation?.newReminders ? ` · 新增 ${motivation.newReminders}` : ''}</Link>
            </Button>
          </section>
        </div>
      </A3Card>

      <div className="grid gap-5 xl:grid-cols-[1fr_1.05fr_1.35fr]">
        <LearnerSnapshot displayName={displayName} majorText={majorText} userRole={user?.role} report={report} />
        <TodayTasks tasks={tasks} loading={loading} />
        <PathCard activePath={activePath} currentItem={currentItem} completedCount={completedCount} />
      </div>

      <DynamicProfileInsightPanel
        dynamicProfile={dynamicProfile}
        compact
        title="首页画像信号"
        subtitle="今日任务、推荐资源和学情诊断会读取这组动态画像。"
      />

      {(report?.weeklyPrescription?.diagnosis || report?.actionLoop) && (
        <A3Card
          title="学情诊断"
          subtitle={report.weeklyPrescription?.diagnosis?.headline ?? report.actionLoop?.continuityMessage ?? ''}
          action={<A3Pill tone={(report?.metrics.accuracy ?? 0) >= 70 ? 'green' : 'orange'}>{(report?.metrics.accuracy ?? 0) >= 70 ? '稳定' : '需关注'}</A3Pill>}
        >
          <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
            <div>
              <p className="text-sm leading-7 text-[var(--a3-text-muted)]">{report.weeklyPrescription?.diagnosis?.summary ?? report.actionLoop?.primaryReason ?? ''}</p>
              <EvidenceList items={(report.weeklyPrescription?.diagnosis?.evidence ?? []).slice(0, 3)} />
            </div>
            <div className="space-y-2">
              {(report.weeklyPrescription?.focusAreas ?? []).slice(0, 3).map((area) => (
                <Link key={area.href} href={area.href} className="flex items-center justify-between rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-3 hover:bg-blue-50">
                  <div className="min-w-0">
                    <A3Pill tone={area.priority === 'high' ? 'orange' : 'blue'}>{area.priority === 'high' ? '优先' : '建议'}</A3Pill>
                    <div className="mt-2 truncate text-xs font-medium text-[var(--a3-text)]">{area.title}</div>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-[var(--a3-text-muted)]" />
                </Link>
              ))}
            </div>
          </div>
          {report.actionLoop && (
            <div className="mt-4 space-y-3">
              <RelationshipActionContext relationship={planRelationship} testId="a3-dashboard-diagnosis-relationship" />
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
                  <Link href={report.actionLoop.primaryAction.href}>{report.actionLoop.primaryAction.label}</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/a3/report">查看完整报告</Link>
                </Button>
              </div>
            </div>
          )}
        </A3Card>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_1.05fr_1.35fr]">
        <LearningOverview report={report} />
        <WeakPointPanel suggestions={weakSuggestions} />
        <ResourcePanel resources={resources} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_1.05fr_1.35fr]">
        <CoachEntry currentItem={currentItem} />
        <UpcomingTasks tasks={tasks} />
        <AssessmentPanel report={report} />
      </div>
    </div>
  );
}

function LearnerSnapshot({ displayName, majorText, userRole, report }: { displayName: string; majorText: string; userRole?: string; report: LearningReport | null }) {
  return (
    <A3Card className="min-h-[326px]">
      <div className="flex gap-5">
        <div className="relative size-24 shrink-0 overflow-hidden rounded-full bg-blue-50">
          <Image src="/avatars/learner.svg" alt="学生头像" fill className="object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-[var(--a3-text)]">{displayName}</h2>
            <A3Pill tone="violet">{userRole === 'teacher' ? '教师' : '学生'}</A3Pill>
          </div>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{majorText}</p>
          <p className="mt-3 text-sm leading-6 text-[var(--a3-text-muted)]">画像会随路径进度、测评表现和错题记录动态更新。</p>
          <Button asChild className="mt-4 h-9" variant="outline">
            <Link href="/a3/settings">编辑资料</Link>
          </Button>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-3 divide-x divide-[var(--a3-border)] rounded-[14px] bg-[var(--a3-surface-muted)] p-5 text-center">
        <ProfileStat value={`${report?.metrics.studyDays ?? 0}`} label="学习天数" tone="blue" />
        <ProfileStat value={`${report?.metrics.answeredQuestions ?? 0}`} label="答题数" tone="green" />
        <ProfileStat value={`${report?.metrics.accuracy ?? 0}%`} label="正确率" tone="violet" />
      </div>
    </A3Card>
  );
}

function TodayTasks({ tasks, loading }: { tasks: DashboardTask[]; loading: boolean }) {
  return (
    <A3Card title="今日任务" action={loading ? <Loader2 className="size-4 animate-spin text-blue-600" /> : <span className="text-sm font-semibold text-blue-700">{tasks.filter((task) => task.done).length}/{tasks.length} 已完成</span>} className="min-h-[326px]">
      <div className="space-y-3">
        {tasks.map((task, index) => (
          <Link key={task.key} href={task.href} className="flex items-center gap-3 rounded-xl p-2 hover:bg-blue-50">
            <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px] text-white', index === 0 ? 'bg-blue-500' : index === 1 ? 'bg-emerald-500' : 'bg-violet-500')}>
              <CalendarDays className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-[var(--a3-text)]">{task.title}</div>
              <div className="mt-0.5 text-xs text-[var(--a3-text-muted)]">{task.subtitle}</div>
            </div>
            {task.done ? <CheckCircle2 className="size-5 text-blue-600" /> : <span className="size-5 rounded-full border-2 border-slate-300" />}
          </Link>
        ))}
      </div>
      <Button asChild className="mt-3 h-9 w-full" variant="outline">
        <Link href="/a3/study-plan">查看完整计划</Link>
      </Button>
    </A3Card>
  );
}

function PathCard({ activePath, currentItem, completedCount }: { activePath: LearningPath | null; currentItem: PathItem | null; completedCount: number }) {
  return (
    <A3Card
      title="当前学习路径"
      subtitle={currentItem ? `第 ${currentItem.knowledgePoint.chapter.order} 章 · ${currentItem.knowledgePoint.chapter.title}` : '尚未生成学习路径'}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/a3/courses">切换路径</Link>
        </Button>
      }
      className="min-h-[326px]"
    >
      <div className="rounded-[14px] bg-[var(--a3-surface-muted)] p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold text-[var(--a3-text)]">{activePath?.course.title || '操作系统'}</span>
          <span className="text-[var(--a3-text-muted)]">
            学习进度 <b className="text-blue-700">{activePath?.progress ?? 0}%</b>
          </span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${activePath?.progress ?? 0}%` }} />
        </div>
        <div className="mt-5 grid grid-cols-4 divide-x divide-[var(--a3-border)] text-center text-sm">
          <PathStat value={`${completedCount}/${activePath?.items.length ?? 0}`} label="已学知识点" />
          <PathStat value={activePath ? '学习中' : '待规划'} label="状态" />
          <PathStat value={`V${activePath?.version ?? 0}`} label="路径版本" />
          <PathStat value={`${currentItem?.progress ?? 0}%`} label="当前节点" />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm text-[var(--a3-text-muted)]">
        <span>下一站：{currentItem?.knowledgePoint.title || '生成个性化路径'}</span>
        <span>预计 {currentItem?.estimatedMinutes ?? 0} 分钟</span>
      </div>
      <Button asChild className="mt-4 h-10 w-full bg-blue-600 hover:bg-blue-700">
        <Link href={activePath ? '/a3/learning-path' : '/a3/courses'}>{activePath ? '继续学习' : '生成学习路径'}</Link>
      </Button>
    </A3Card>
  );
}

function LearningOverview({ report }: { report: LearningReport | null }) {
  const metrics = [
    { label: '学习时长', value: `${Math.round(((report?.metrics.studyMinutes ?? 0) / 60) * 10) / 10} 小时`, source: '已完成路径节点', tone: 'blue' as const, icon: Clock3 },
    { label: '完成率', value: `${report?.metrics.pathProgress ?? 0}%`, source: '当前学习路径', tone: 'green' as const, icon: Target },
    { label: '正确率', value: `${report?.metrics.accuracy ?? 0}%`, source: '阶段测评', tone: 'violet' as const, icon: CheckCircle2 },
    { label: '错题数', value: `${report?.metrics.activeWrongQuestions ?? 0}`, source: '待巩固题目', tone: 'orange' as const, icon: BookOpen },
  ];
  return (
    <A3Card title="学习数据概览" subtitle="全部来自后端报告和学习路径，不使用前端假数。" action={<span className="text-xs text-[var(--a3-text-muted)]">实时数据</span>}>
      <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
        {metrics.map((metric) => (
          <MiniMetric key={metric.label} {...metric} />
        ))}
      </div>
      <div className="mt-4 flex h-16 items-end gap-5 px-2">
        {(report?.trends ?? []).map((item) => (
          <div key={item.label} className="flex flex-1 flex-col items-center gap-2">
            <div className="w-2 rounded-full bg-blue-500" style={{ height: Math.max(8, item.accuracy / 2) }} />
            <span className="text-xs text-[var(--a3-text-muted)]">{item.label.slice(0, 5)}</span>
          </div>
        ))}
      </div>
    </A3Card>
  );
}

function WeakPointPanel({ suggestions }: { suggestions: LearningReport['suggestions'] }) {
  return (
    <A3Card
      title="薄弱知识点提醒"
      action={
        <Button asChild size="sm" variant="ghost">
          <Link href="/a3/wrong-notebook">查看全部</Link>
        </Button>
      }
    >
      <div className="space-y-3">
        {suggestions.slice(0, 3).map((item, index) => (
          <div key={`${item.title}-${item.detail}-${index}`} className="grid grid-cols-[1fr_88px] items-center gap-3 rounded-xl bg-[var(--a3-surface-muted)] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <A3Pill tone={index === 0 ? 'orange' : 'blue'}>{index === 0 ? '优先' : '巩固'}</A3Pill>
                <span className="truncate text-sm font-medium text-[var(--a3-text)]">{item.title}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/a3/wrong-notebook">去巩固</Link>
            </Button>
          </div>
        ))}
        {!suggestions.length && <p className="rounded-xl bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]">暂无薄弱点建议，完成测评后会自动生成。</p>}
      </div>
    </A3Card>
  );
}

function ResourcePanel({ resources }: { resources: ClassroomContext['recommended'] }) {
  return (
    <A3Card
      title={
        <span className="flex items-center gap-2">
          <MessageCircle className="size-4 text-blue-600" />
          推荐资源
        </span>
      }
      subtitle="来自课堂上下文和当前知识点，不是静态资源列表。"
      action={
        <Button asChild size="sm" variant="ghost">
          <Link href="/a3/classroom">进入课堂</Link>
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        {resources.slice(0, 3).map((resource, index) => (
          <Link key={`${resource.title}-${resource.href}-${index}`} href={resource.href} className="rounded-[12px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3 hover:bg-blue-50">
            <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <FileText className="size-4" />
            </div>
            <div className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--a3-text)]">{resource.title}</div>
            <div className="mt-2 text-xs text-[var(--a3-text-muted)]">{resource.meta}</div>
          </Link>
        ))}
        {!resources.length && <p className="col-span-3 rounded-xl bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]">暂无推荐资源，进入课堂后会按当前知识点生成。</p>}
      </div>
    </A3Card>
  );
}

function CoachEntry({ currentItem }: { currentItem: PathItem | null }) {
  const prompts = [`讲解${currentItem?.knowledgePoint.title ?? '当前知识点'}`, '分析错题原因', '制定本周计划', '推荐练习题'];
  return (
    <section className="rounded-[14px] border border-blue-100 bg-blue-50 p-5 text-blue-950 shadow-[var(--a3-shadow)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xl font-semibold">
            AI 助学助手<span className="rounded-full bg-blue-100 px-2 py-1 text-xs text-blue-700">进入辅导</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-blue-800">这里是辅导入口。真正对话会进入面对面辅导页，并结合学习路径、知识库溯源和引用验证。</p>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {prompts.map((item) => (
              <Link key={item} href="/a3/coaching" className="rounded-full bg-white px-3 py-2 text-left text-blue-800 hover:bg-blue-100">
                {item}
              </Link>
            ))}
          </div>
        </div>
        <div className="hidden size-20 shrink-0 items-center justify-center rounded-full bg-white lg:flex">
          <Bot className="size-11 text-blue-600" />
        </div>
      </div>
      <Link href="/a3/coaching" className="mt-5 flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm text-slate-500">
        输入你的问题...
        <Send className="ml-auto size-4 text-blue-600" />
      </Link>
    </section>
  );
}

function UpcomingTasks({ tasks }: { tasks: DashboardTask[] }) {
  return (
    <A3Card
      title="即将到来的活动"
      action={
        <Button asChild size="sm" variant="ghost">
          <Link href="/a3/notifications">查看全部</Link>
        </Button>
      }
    >
      <div className="space-y-3">
        {tasks.slice(0, 3).map((task, index) => (
          <Link key={`upcoming-${task.key}`} href={task.href} className="flex items-center gap-3 rounded-xl p-2 hover:bg-blue-50">
            <div className="flex size-10 shrink-0 flex-col items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <span className="text-xs">项</span>
              <span className="text-sm font-semibold">{index + 1}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-[var(--a3-text)]">{task.title}</div>
              <div className="mt-1 truncate text-xs text-[var(--a3-text-muted)]">{task.subtitle}</div>
            </div>
            <span className="rounded-md border border-[var(--a3-border)] px-2 py-1 text-xs text-[var(--a3-text)]">处理</span>
          </Link>
        ))}
      </div>
    </A3Card>
  );
}

function AssessmentPanel({ report }: { report: LearningReport | null }) {
  return (
    <A3Card
      title="最近测评表现"
      action={
        <Button asChild size="sm" variant="ghost">
          <Link href="/a3/report">查看报告</Link>
        </Button>
      }
    >
      <div className="grid grid-cols-[140px_1fr] items-center gap-4">
        <div>
          <div className="text-sm text-[var(--a3-text-muted)]">阶段测评</div>
          <div className="mt-3 flex items-end gap-2">
            <span className="text-4xl font-semibold text-blue-700">{report?.metrics.accuracy ?? 0}</span>
            <span className="pb-1 text-sm text-[var(--a3-text-muted)]">%</span>
          </div>
          <A3Pill tone={(report?.metrics.accuracy ?? 0) >= 80 ? 'green' : 'orange'}>{(report?.metrics.accuracy ?? 0) >= 80 ? '优秀' : '待提升'}</A3Pill>
        </div>
        <div className="space-y-3">
          {(report?.capabilityAxes ?? []).map((axis) => (
            <div key={axis.label}>
              <div className="mb-1 flex justify-between text-xs text-[var(--a3-text-muted)]">
                <span>{axis.label}</span>
                <span>{axis.value}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${axis.value}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </A3Card>
  );
}

function MiniMetric({ label, value, source, tone, icon: Icon }: { label: string; value: string; source: string; tone: keyof typeof metricTone; icon: typeof Clock3 }) {
  return (
    <div className="rounded-[10px] bg-[var(--a3-surface-muted)] p-3">
      <div className={cn('mb-2 inline-flex size-8 items-center justify-center rounded-lg', metricTone[tone])}>
        <Icon className="size-4" />
      </div>
      <div className="text-sm font-medium text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 text-[22px] font-semibold leading-none text-[var(--a3-text)]">{value}</div>
      <div className="mt-2 text-xs text-[var(--a3-text-muted)]">{source}</div>
    </div>
  );
}

function ProfileStat({ value, label, tone }: { value: string; label: string; tone: 'blue' | 'green' | 'violet' }) {
  const color = {
    blue: 'text-blue-700',
    green: 'text-emerald-600',
    violet: 'text-violet-600',
  }[tone];
  return (
    <div>
      <div className={cn('text-3xl font-semibold', color)}>{value}</div>
      <div className="mt-1 text-sm text-[var(--a3-text-muted)]">{label}</div>
    </div>
  );
}

function PathStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-lg font-semibold text-[var(--a3-text)]">{value}</div>
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
    </div>
  );
}

function EvidenceList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-3 space-y-1">
      {items.map((item, index) => (
        <li key={`${item}-${index}`} className="flex items-start gap-2 text-xs leading-5 text-[var(--a3-text-muted)]">
          <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-blue-500" />
          {item}
        </li>
      ))}
    </ul>
  );
}

function RelationshipActionContext({ relationship, testId }: { relationship?: StudyPlanRelationship; testId: string }) {
  if (!relationship) return null;
  const rows = [
    { label: '路径', detail: relationship.path },
    { label: '计划', detail: relationship.plan },
    { label: '今日', detail: relationship.today },
    { label: '写回', detail: relationship.writeback },
  ].filter((item) => item.detail);
  if (!rows.length) return null;
  return (
    <div data-testid={testId} className="mt-3 grid gap-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3 md:grid-cols-2 xl:grid-cols-4">
      {rows.map((item) => (
        <div key={item.label} className="min-w-0">
          <div className="text-[11px] font-semibold text-blue-900">{item.label}</div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-blue-800">{item.detail}</p>
        </div>
      ))}
    </div>
  );
}

function buildTasks(path: LearningPath | null, currentItem: PathItem | null, report: LearningReport | null, studyPlan: StudyPlan | null): DashboardTask[] {
  const today = studyPlan?.days.find((day) => day.status === 'today' || day.dayIndex === 1);
  if (today?.tasks.length) {
    return today.tasks.slice(0, 3).map((task, index) => ({
      key: task.id || `${today.dayIndex}-${task.type}-${task.href}-${index}`,
      title: task.title,
      subtitle: `${task.estimatedMinutes} 分钟 · ${task.subtitle}`,
      href: task.href,
      done: task.status === 'completed',
    }));
  }
  return [
    {
      key: currentItem ? `path-${currentItem.id}` : 'path-generate',
      title: currentItem ? `继续学习：${currentItem.knowledgePoint.title}` : '生成个性化学习路径',
      subtitle: currentItem ? `预计 ${currentItem.estimatedMinutes} 分钟` : '完成课程选择后生成',
      href: currentItem ? '/a3/learning-path' : '/a3/courses',
      done: currentItem?.status === 'completed',
    },
    {
      key: 'assessment',
      title: '完成阶段测评',
      subtitle: report?.metrics.answeredQuestions ? `已答 ${report.metrics.answeredQuestions} 题` : '根据当前路径生成题目',
      href: '/a3/assessment',
      done: Boolean(report?.metrics.answeredQuestions),
    },
    {
      key: 'wrong-notebook',
      title: '巩固错题本',
      subtitle: `${report?.metrics.activeWrongQuestions ?? 0} 道待巩固错题`,
      href: '/a3/wrong-notebook',
      done: (report?.metrics.activeWrongQuestions ?? 0) === 0 && Boolean(path),
    },
  ];
}

function taskProgress(done: number, total: number) {
  if (!total) return 0;
  return Math.round((done * 100) / total);
}
