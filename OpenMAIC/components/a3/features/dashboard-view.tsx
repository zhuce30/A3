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
import type { A3ProfileSnapshot } from '@/lib/a3/auth-types';
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
      profileSnapshot?: A3ProfileSnapshot;
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
  const [profileSnapshot, setProfileSnapshot] = useState<A3ProfileSnapshot | null>(null);
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
      if (profileResult.success) {
        setDynamicProfile(profileResult.profile?.extraProfile?.dynamicProfile ?? null);
        setProfileSnapshot(profileResult.profile?.extraProfile?.profileSnapshot ?? null);
      }
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
  const weakSuggestions = report?.suggestions ?? [];
  const resources = classroom?.recommended ?? [];
  const planRelationship = studyPlan?.planContext?.relationship;
  const primaryAction = motivation?.primaryAction ?? {
    label: currentItem ? '继续学习' : '生成学习路径',
    href: currentItem ? '/a3/learning-path' : '/a3/courses',
    reason: currentItem ? `先推进《${currentItem.knowledgePoint.title}》，完成后会回写路径进度。` : '先建立学习路径，后续计划和今日任务才有依据。',
  };

  return (
    <div className="min-w-0 space-y-5">
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
        <div className="flex min-w-0 items-center gap-3 rounded-[14px] border border-blue-100 bg-blue-50 px-4 py-3">
          <Bot className="size-5 text-blue-700" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-blue-900">AI 辅导可用</div>
            <div className="text-xs leading-5 text-blue-700">基于当前节点、知识库和引用验证回答</div>
          </div>
        </div>
      </section>

      <div
        data-testid="a3-dashboard-action-zone"
        className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"
      >
        <TodayActionHub
          tasks={tasks}
          loading={loading}
          motivation={motivation}
          primaryAction={primaryAction}
          relationship={planRelationship}
        />
        <div data-testid="a3-dashboard-momentum-rail" className="grid min-w-0 gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <LearningMomentum motivation={motivation} />
          <LearningBadgeSummary motivation={motivation} />
        </div>
      </div>

      <div
        data-testid="a3-dashboard-path-profile-zone"
        className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"
      >
        <PathCard activePath={activePath} currentItem={currentItem} completedCount={completedCount} />
        <LearnerSnapshot displayName={displayName} majorText={majorText} userRole={user?.role} report={report} />
      </div>

      <DynamicProfileInsightPanel
        dynamicProfile={dynamicProfile}
        profileSnapshot={profileSnapshot}
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
          <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(260px,300px)]">
            <div className="min-w-0">
              <p className="text-sm leading-7 text-[var(--a3-text-muted)]">{report.weeklyPrescription?.diagnosis?.summary ?? report.actionLoop?.primaryReason ?? ''}</p>
              <EvidenceList items={(report.weeklyPrescription?.diagnosis?.evidence ?? []).slice(0, 3)} />
            </div>
            <div className="min-w-0 space-y-2">
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

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.35fr)]">
        <LearningOverview report={report} />
        <WeakPointPanel suggestions={weakSuggestions} />
        <ResourcePanel resources={resources} />
      </div>

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.35fr)]">
        <CoachEntry currentItem={currentItem} />
        <UpcomingTasks tasks={tasks} />
        <AssessmentPanel report={report} />
      </div>
    </div>
  );
}

function LearnerSnapshot({ displayName, majorText, userRole, report }: { displayName: string; majorText: string; userRole?: string; report: LearningReport | null }) {
  return (
    <A3Card>
      <div className="flex min-w-0 gap-4">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-full bg-blue-50">
          <Image src="/avatars/learner.svg" alt="学生头像" fill className="object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-xl font-semibold text-[var(--a3-text)]">{displayName}</h2>
            <A3Pill tone="violet">{userRole === 'teacher' ? '教师' : '学生'}</A3Pill>
          </div>
          <p className="mt-2 break-words text-sm leading-5 text-[var(--a3-text-muted)]">{majorText}</p>
          <p className="mt-3 text-sm leading-6 text-[var(--a3-text-muted)]">画像会随路径进度、测评表现和错题记录动态更新。</p>
          <Button asChild className="mt-4 h-9" variant="outline">
            <Link href="/a3/settings">编辑资料</Link>
          </Button>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-3 divide-x divide-[var(--a3-border)] rounded-[14px] bg-[var(--a3-surface-muted)] p-4 text-center">
        <ProfileStat value={`${report?.metrics.studyDays ?? 0}`} label="学习天数" tone="blue" />
        <ProfileStat value={`${report?.metrics.answeredQuestions ?? 0}`} label="答题数" tone="green" />
        <ProfileStat value={`${report?.metrics.accuracy ?? 0}%`} label="正确率" tone="violet" />
      </div>
    </A3Card>
  );
}

function TodayActionHub({
  tasks,
  loading,
  motivation,
  primaryAction,
  relationship,
}: {
  tasks: DashboardTask[];
  loading: boolean;
  motivation: MotivationSummary | null;
  primaryAction: { label: string; href: string; reason: string };
  relationship?: StudyPlanRelationship;
}) {
  const doneTasks = tasks.filter((task) => task.done).length;
  const completed = motivation?.todayCompletedTasks ?? doneTasks;
  const total = motivation?.todayTotalTasks ?? tasks.length;
  const weeklyProgress = motivation?.weeklyTarget.progress ?? taskProgress(doneTasks, tasks.length);

  return (
    <A3Card
      title="今天先完成这些"
      subtitle="按当前学习路径和复习队列排序，完成后会同步更新报告。"
      action={loading ? <Loader2 className="size-4 animate-spin text-blue-600" /> : <span className="text-sm font-semibold text-blue-700">{completed}/{total} 已完成</span>}
    >
      <div className="rounded-[14px] border border-blue-100 bg-blue-50 p-4 md:p-5">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-blue-950">{motivation?.weeklyTarget.label ?? '完成今日学习任务'}</div>
            <p className="mt-2 text-sm leading-6 text-blue-800">
              今日剩余约 {motivation?.todayRemainingMinutes ?? 0} 分钟，本周已完成 {motivation?.weeklyCompletedTasks ?? motivation?.weeklyTarget.current ?? doneTasks} 项。
            </p>
          </div>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-blue-700">
            {motivation?.weeklyTarget.current ?? doneTasks}/{motivation?.weeklyTarget.target ?? tasks.length}
          </span>
        </div>
        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-white">
          <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${weeklyProgress}%` }} />
        </div>
        <div className="mt-4 rounded-xl bg-white p-4">
          <div className="text-xs font-semibold text-blue-950">现在最该做</div>
          <p className="mt-1 break-words text-sm leading-6 text-blue-800">{primaryAction.reason}</p>
          <RelationshipActionContext relationship={relationship} testId="a3-dashboard-relationship-action-context" />
          <Button asChild size="sm" className="mt-3 bg-blue-600 hover:bg-blue-700">
            <Link href={primaryAction.href}>{primaryAction.label}</Link>
          </Button>
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {tasks.map((task, index) => (
          <Link key={task.key} href={task.href} className="flex min-w-0 items-start gap-3 rounded-xl border border-transparent p-3 transition-colors hover:border-blue-100 hover:bg-blue-50">
            <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-[10px] text-white', index === 0 ? 'bg-blue-500' : index === 1 ? 'bg-emerald-500' : 'bg-violet-500')}>
              <CalendarDays className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div data-testid="a3-dashboard-task-title" className="line-clamp-2 break-words text-sm font-semibold leading-5 text-[var(--a3-text)]">{task.title}</div>
              <div className="mt-1 line-clamp-2 break-words text-xs leading-5 text-[var(--a3-text-muted)]">{task.subtitle}</div>
            </div>
            {task.done ? <CheckCircle2 className="mt-1 size-5 shrink-0 text-blue-600" /> : <span className="mt-1 size-5 shrink-0 rounded-full border-2 border-slate-300" />}
          </Link>
        ))}
      </div>
      <Button asChild className="mt-4 h-9 w-full" variant="outline">
        <Link href="/a3/study-plan">查看完整计划</Link>
      </Button>
    </A3Card>
  );
}

function LearningMomentum({ motivation }: { motivation: MotivationSummary | null }) {
  return (
    <A3Card title="连续学习" action={<Flame className="size-4 text-orange-700" />}>
      <div className="rounded-[14px] bg-orange-50 p-4">
        <div className="flex items-end gap-2 text-orange-700">
          <span className="text-4xl font-semibold leading-none tabular-nums">{motivation?.streakDays ?? 0}</span>
          <span className="pb-1 text-sm">天</span>
        </div>
        <p className="mt-3 break-words text-sm leading-6 text-orange-800">{motivation?.nudge ?? '完成一个任务即可建立今天的学习记录。'}</p>
      </div>
    </A3Card>
  );
}

function LearningBadgeSummary({ motivation }: { motivation: MotivationSummary | null }) {
  return (
    <A3Card title="学习徽章" action={<Award className="size-4 text-emerald-700" />}>
      <div className="flex flex-wrap gap-2">
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
    >
      <div className="rounded-[14px] bg-[var(--a3-surface-muted)] p-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
          <span className="min-w-0 break-words font-semibold text-[var(--a3-text)]">{activePath?.course.title || '操作系统'}</span>
          <span className="shrink-0 text-[var(--a3-text-muted)]">
            学习进度 <b className="text-blue-700">{activePath?.progress ?? 0}%</b>
          </span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${activePath?.progress ?? 0}%` }} />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-y-4 text-center text-sm sm:grid-cols-4 sm:divide-x sm:divide-[var(--a3-border)]">
          <PathStat value={`${completedCount}/${activePath?.items.length ?? 0}`} label="已学知识点" />
          <PathStat value={activePath ? '学习中' : '待规划'} label="状态" />
          <PathStat value={`V${activePath?.version ?? 0}`} label="路径版本" />
          <PathStat value={`${currentItem?.progress ?? 0}%`} label="当前节点" />
        </div>
      </div>
      <div className="mt-4 flex min-w-0 flex-col gap-2 text-sm text-[var(--a3-text-muted)] sm:flex-row sm:items-start sm:justify-between">
        <span className="min-w-0 break-words">下一站：{currentItem?.knowledgePoint.title || '生成个性化路径'}</span>
        <span className="shrink-0">预计 {currentItem?.estimatedMinutes ?? 0} 分钟</span>
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
          <div key={`${item.title}-${item.detail}-${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px] items-center gap-3 rounded-xl bg-[var(--a3-surface-muted)] p-3">
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
          <Link key={`${resource.title}-${resource.href}-${index}`} href={resource.href} className="min-w-0 rounded-[12px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3 hover:bg-blue-50">
            <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <FileText className="size-4" />
            </div>
            <div className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--a3-text)]">{resource.title}</div>
            <div className="mt-2 text-xs text-[var(--a3-text-muted)]">{resource.meta}</div>
          </Link>
        ))}
        {!resources.length && <p className="rounded-xl bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)] md:col-span-3">暂无推荐资源，进入课堂后会按当前知识点生成。</p>}
      </div>
    </A3Card>
  );
}

function CoachEntry({ currentItem }: { currentItem: PathItem | null }) {
  const prompts = [`讲解${currentItem?.knowledgePoint.title ?? '当前知识点'}`, '分析错题原因', '制定本周计划', '推荐练习题'];
  return (
    <section className="min-w-0 rounded-[14px] border border-blue-100 bg-blue-50 p-5 text-blue-950 shadow-[var(--a3-shadow)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            AI 助学助手<span className="rounded-full bg-blue-100 px-2 py-1 text-xs text-blue-700">进入辅导</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-blue-800">这里是辅导入口。真正对话会进入面对面辅导页，并结合学习路径、知识库溯源和引用验证。</p>
          <div className="mt-4 grid min-w-0 gap-2 text-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {prompts.map((item) => (
              <Link key={item} href="/a3/coaching" className="min-w-0 break-words rounded-lg bg-white px-3 py-2 text-left leading-5 text-blue-800 hover:bg-blue-100">
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
          <Link key={`upcoming-${task.key}`} href={task.href} className="flex min-w-0 items-start gap-3 rounded-xl p-2 hover:bg-blue-50">
            <div className="flex size-10 shrink-0 flex-col items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <span className="text-xs">项</span>
              <span className="text-sm font-semibold">{index + 1}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div data-testid="a3-dashboard-upcoming-title" className="line-clamp-2 break-words text-sm font-semibold leading-5 text-[var(--a3-text)]">{task.title}</div>
              <div className="mt-1 line-clamp-2 break-words text-xs leading-5 text-[var(--a3-text-muted)]">{task.subtitle}</div>
            </div>
            <span className="shrink-0 rounded-md border border-[var(--a3-border)] px-2 py-1 text-xs text-[var(--a3-text)]">处理</span>
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
      <div className="grid min-w-0 items-center gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
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
