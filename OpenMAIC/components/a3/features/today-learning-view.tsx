'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bell, BookOpenCheck, CheckCircle2, ChevronDown, Clock3, Loader2, MessageCircle, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { buildProfileChangeInsight, buildTaskProfileRationale, buildTodayFlowInsights, type LearningFlowInsight } from '@/lib/a3/learning-flow-insights';
import { trackLearningEvent, trackPageView } from '@/lib/a3/learning-event-client';
import type { LearningReport } from '@/lib/a3/assessment-types';
import type { A3ApiResponse, DailyReflection, StudyPlan, StudyPlanDay, StudyPlanTask, StudyPlanTaskFeedback } from '@/lib/a3/learning-types';
import type { DynamicProfileFeedResponse } from '@/lib/a3/profile-timeline';
import { formatReportMetricDelta } from '@/lib/a3/report-delta';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';

type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan; feedback?: StudyPlanTaskFeedback }>;
type ReflectionResponse = A3ApiResponse<{ reflection: DailyReflection; recent: DailyReflection[] }>;
type ReportResponse = { success: boolean; error?: string; report: LearningReport };
type ProfileFeedResponse = DynamicProfileFeedResponse;

const taskCopy: Record<StudyPlanTask['type'], { label: string; action: string; tone: 'blue' | 'green' | 'orange' | 'violet' }> = {
  learn: { label: '讲解', action: '进入 AI 课堂', tone: 'blue' },
  practice: { label: '练习', action: '去做题', tone: 'green' },
  review: { label: '复习', action: '看错题', tone: 'orange' },
  summary: { label: '复盘', action: '写总结', tone: 'violet' },
  resource_pack: { label: '资源包', action: '去专项练习', tone: 'violet' },
};

const policyLabel: Record<NonNullable<StudyPlan['adaptivePolicy']>['mode'], string> = {
  reduced_load: '降负荷',
  accelerated: '加速推进',
  standard: '标准节奏',
};

const resourceFeedbackStrategyLabel: Record<string, string> = {
  increase_practice: '增加专项练习',
  reduce_load: '降低今日负荷',
  keep_current_pace: '保持当前节奏',
};

const PROFILE_SETUP_HREF = '/a3/profile-setup';

export function TodayLearningView() {
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingTask, setSavingTask] = useState('');
  const [feedback, setFeedback] = useState<StudyPlanTaskFeedback | null>(null);
  const [report, setReport] = useState<LearningReport | null>(null);
  const [previousReport, setPreviousReport] = useState<LearningReport | null>(null);
  const [reflectionSummary, setReflectionSummary] = useState('');
  const [reflectionConfusion, setReflectionConfusion] = useState('');
  const [confidence, setConfidence] = useState(3);
  const [reflection, setReflection] = useState<DailyReflection | null>(null);
  const [profileFeed, setProfileFeed] = useState<ProfileFeedResponse | null>(null);
  const [savingReflection, setSavingReflection] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    const [response, reportResponse, profileResponse] = await Promise.all([
      a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1'),
      a3GetJson<ReportResponse>('/api/assessments/report/'),
      a3GetJson<ProfileFeedResponse>('/api/profiles/dynamic-profile/'),
    ]);
    setLoading(false);
    if (!response.success) {
      setError(response.error ?? '今日学习任务加载失败');
      return;
    }
    setPlan(response.plan);
    setFeedback(response.plan.lastTaskFeedback ?? null);
    if (reportResponse.success) setReport(reportResponse.report);
    if (profileResponse.success) setProfileFeed(profileResponse);
  }

  async function completeTask(day: StudyPlanDay, task: StudyPlanTask) {
    setSavingTask(task.id);
    setError('');
    const response = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/tasks/complete/', {
      dayIndex: day.dayIndex,
      taskId: task.id,
    });
    setSavingTask('');
    if (!response.success) {
      setError(response.error ?? '任务完成失败');
      return;
    }
    setPlan(response.plan);
    setFeedback(response.feedback ?? response.plan.lastTaskFeedback ?? null);
    void trackTaskCompletedEvent(day, task, response.plan.planId);
    setPreviousReport(report);
    const reportResponse = await a3GetJson<ReportResponse>('/api/assessments/report/');
    if (reportResponse.success) setReport(reportResponse.report);
  }

  async function submitReflection() {
    setSavingReflection(true);
    setError('');
    const response = await a3PostJson<ReflectionResponse>('/api/learning/study-plan/reflections/', {
      summary: reflectionSummary,
      confusion: reflectionConfusion,
      confidence,
    });
    setSavingReflection(false);
    if (!response.success) {
      setError(response.error ?? '复盘提交失败');
      return;
    }
    setReflection(response.reflection);
  }

  useEffect(() => {
    void trackPageView('/a3/today', { page: 'today_learning' });
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const today = useMemo(() => plan?.days.find((day) => day.status === 'today' || day.dayIndex === 1) ?? null, [plan]);
  const tasks = today?.tasks ?? [];
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const activeTask = tasks.find((task) => task.status !== 'completed') ?? tasks[tasks.length - 1] ?? null;
  const progress = tasks.length ? Math.round((completedCount * 100) / tasks.length) : 0;
  const finished = tasks.length > 0 && completedCount === tasks.length;
  const rolloverCount = tasks.filter((task) => task.rolledOverFrom).length;
  const policy = plan?.adaptivePolicy;
  const reportActionLoop = report?.actionLoop ?? null;
  const resourceFeedbackAdjustment = plan?.lastResourceFeedbackAdjustment;
  const relationship = plan?.planContext?.relationship;
  const todayBindings = plan?.planContext?.todayBindings ?? [];
  const flowInsights = useMemo(() => buildTodayFlowInsights({ plan, today }), [plan, today]);
  const profileChangeInsight = useMemo(() => buildProfileChangeInsight(profileFeed), [profileFeed]);

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-sm text-[var(--a3-text-muted)]">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在生成今日学习会话
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="a3-today-view">
      <section data-tour-id="today-prescription" data-testid="a3-today-hub" className="overflow-hidden rounded-[18px] border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-bg)] p-6 text-[var(--a3-highlight-text)] shadow-[var(--a3-highlight-shadow)]">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <A3Pill tone="green">DailySessionAgent 执行写回</A3Pill>
            <h1 className="mt-4 text-3xl font-semibold tracking-normal">今日学习</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--a3-highlight-muted)]">
              {relationship?.today ?? '今日学习只执行当前日期的计划任务。'}{relationship?.writeback ? ` ${relationship.writeback}` : ' 完成后写回路径进度、错题复习、通知和报告指标。'}
            </p>
            <div data-tour-id="today-plan-relationship" className="mt-4 grid gap-2 md:grid-cols-4" data-testid="a3-today-relationship">
              <TodayLoopStep title="路径" detail={relationship?.path ?? '学习路径决定知识点顺序和先修关系。'} />
              <TodayLoopStep title="计划" detail={relationship?.plan ?? '学习计划把路径节点、错题复习和资源包排到具体日期。'} />
              <TodayLoopStep title="今日" detail={relationship?.today ?? '今日学习只执行当前日期的计划任务。'} />
              <TodayLoopStep title="写回" detail={relationship?.writeback ?? '任务完成后写回路径进度、错题复习、通知和报告指标。'} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-[var(--a3-highlight-surface)] px-3 py-1 text-xs text-[var(--a3-highlight-muted)]">
                策略：{policy ? policyLabel[policy.mode] : '标准节奏'}
              </span>
              <span className="rounded-full bg-[var(--a3-highlight-surface)] px-3 py-1 text-xs text-[var(--a3-highlight-muted)]">
                今日绑定 {todayBindings.length} 个路径/复习任务
              </span>
              {rolloverCount > 0 && (
                <span className="rounded-full bg-orange-100 px-3 py-1 text-xs text-orange-800 dark:bg-orange-950/50 dark:text-orange-200">
                  {rolloverCount} 个任务已顺延到今天
                </span>
              )}
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild className="bg-emerald-500 text-slate-950 hover:bg-emerald-400">
                <Link data-tour-id="today-next-action" href={activeTask?.href ?? '/a3/study-plan'}>
                  {finished ? '查看学习计划' : taskCopy[activeTask?.type ?? 'learn'].action}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="min-w-[104px] justify-center border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10">
                <Link href="/a3/admission-diagnostic">重新诊断</Link>
              </Button>
              <Button onClick={load} variant="outline" className="min-w-[112px] justify-center border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10">
                <RotateCcw className="size-4" />
                刷新任务
              </Button>
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-[var(--a3-highlight-muted)]">今日完成度</div>
                <div className="mt-2 text-5xl font-semibold">{progress}%</div>
              </div>
              <div className="flex size-16 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200">
                <BookOpenCheck className="size-9" />
              </div>
            </div>
            <div className="mt-5 h-3 rounded-full bg-[var(--a3-highlight-border)]">
              <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <SessionMetric label="任务" value={`${completedCount}/${tasks.length}`} />
              <SessionMetric label="预计" value={`${today?.estimatedMinutes ?? 0} 分钟`} />
              <SessionMetric label="等级" value={plan?.level.code ?? '--'} />
            </div>
          </div>
        </div>
      </section>

      {error && <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>}

      <TodayFlowInsightPanel insights={flowInsights} />
      <ProfileChangeReasonCard insight={profileChangeInsight} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
        <A3Card
          title={today ? today.focus : '今日暂无任务'}
          subtitle={today ? `${today.date} · 预计 ${today.estimatedMinutes} 分钟` : '请先生成学习计划'}
          action={<A3Pill tone={finished ? 'green' : 'blue'}>{finished ? '已完成' : '进行中'}</A3Pill>}
        >
          <div data-tour-id="today-task-list">
          {tasks.length ? (
            <div className="space-y-4">
              {tasks.map((task, index) => (
                <SessionTask
                  key={task.id}
                  day={today as StudyPlanDay}
                  task={task}
                  index={index + 1}
                  active={activeTask?.id === task.id && !finished}
                  saving={savingTask === task.id}
                  profileFeed={profileFeed}
                  onComplete={completeTask}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-[var(--a3-surface-muted)] p-8 text-center text-sm text-[var(--a3-text-muted)]">
              还没有今日任务。先完成入学诊断，系统会自动生成每日学习安排。
              <div className="mt-4">
                <Button asChild className="bg-blue-600 hover:bg-blue-700">
                  <Link href="/a3/admission-diagnostic">开始入学诊断</Link>
                </Button>
              </div>
            </div>
          )}
          </div>
        </A3Card>

        <div className="space-y-5">
          <A3Card title="每日复盘" action={<A3Pill tone={finished ? 'green' : 'blue'}>{finished ? '可提交' : '学习中'}</A3Pill>}>
            {reflection ? (
              <div className="rounded-xl bg-emerald-50 p-4">
                <div className="text-sm font-semibold text-emerald-900">复盘已保存</div>
                <p className="mt-2 text-sm leading-6 text-emerald-800">{reflection.summary || reflection.confusion}</p>
                <div className="mt-3 text-xs text-emerald-700">
                  信心分：{reflection.confidence}/5 · 今日进度：{reflection.todayProgress}%
                </div>
              </div>
            ) : (
              <div id="daily-reflection-form" className="space-y-3">
                <textarea
                  value={reflectionSummary}
                  onChange={(event) => setReflectionSummary(event.target.value)}
                  placeholder="今天我真正掌握了什么？"
                  className="min-h-20 w-full rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 py-2 text-sm outline-none focus:border-blue-400"
                />
                <textarea
                  value={reflectionConfusion}
                  onChange={(event) => setReflectionConfusion(event.target.value)}
                  placeholder="还有哪里不确定？可以留空。"
                  className="min-h-16 w-full rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 py-2 text-sm outline-none focus:border-blue-400"
                />
                <div>
                  <div className="mb-2 text-xs text-[var(--a3-text-muted)]">信心分：{confidence}/5</div>
                  <input className="w-full" type="range" min={1} max={5} value={confidence} onChange={(event) => setConfidence(Number(event.target.value))} />
                </div>
                <Button onClick={submitReflection} disabled={savingReflection || (!reflectionSummary.trim() && !reflectionConfusion.trim())} className="w-full bg-blue-600 hover:bg-blue-700">
                  {savingReflection ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  保存今日复盘
                </Button>
              </div>
            )}
          </A3Card>

          <A3Card title="AI 教练提示" action={<Sparkles className="size-4 text-blue-600" />}>
            <p className="text-sm leading-7 text-[var(--a3-text-muted)]">{plan?.coachTip ?? '完成诊断后会生成个性化建议。'}</p>
            {feedback && (
              <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-4" data-testid="a3-today-feedback">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-emerald-900">{feedback.headline}</div>
                    <p className="mt-2 text-sm leading-6 text-emerald-800">{feedback.celebration}</p>
                  </div>
                  <div className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-700">
                    {feedback.reward.label} {feedback.reward.value}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs text-emerald-700">已同步学习计划</span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs text-emerald-700">已生成下一步提醒</span>
                  {feedback.dailyClosed ? (
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs text-emerald-700">今日闭环完成</span>
                  ) : (
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs text-emerald-700">剩余 {feedback.remainingTasks} 项</span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <FeedbackMetric label="掌握度" value={`${feedback.masteryAfter}%`} />
                  <FeedbackMetric label="变化" value={feedback.delta} />
                  <FeedbackMetric label="今日" value={`${feedback.completedTasks}/${feedback.totalTasks}`} />
                </div>
                <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs leading-5 text-emerald-800" data-testid="a3-today-classroom-progress-sync">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-emerald-950">课堂回写进度证据</div>
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800">
                      今日 {feedback.completedTasks}/{feedback.totalTasks}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <FeedbackMetric label="回写任务" value={feedback.title} />
                    <FeedbackMetric label="剩余任务" value={`${feedback.remainingTasks}`} />
                    <FeedbackMetric label="掌握变化" value={`${feedback.masteryAfter}% ${feedback.delta}`} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span>来自课堂/今日任务完成接口，已同步到学习计划和报告。</span>
                    <Link href="/a3/study-plan" className="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:text-emerald-900">
                      查看完整计划
                      <ArrowRight className="size-3" />
                    </Link>
                  </div>
                </div>
                <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs leading-5 text-emerald-800" data-testid="a3-today-feedback-next-reason">
                  <span className="font-semibold">为什么下一步做这个：</span>
                  {feedback.nextStepReason}
                </div>
                <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs leading-5 text-emerald-800" data-testid="a3-today-path-sync">
                  <div className="font-semibold text-emerald-950">学习路径已同步</div>
                  <div className="mt-1">
                    本次任务完成度已回流到学习计划和路径进度，下一次打开路径会继续从当前薄弱点和今日进度排序。
                  </div>
                  <Link href="/a3/learning-path" className="mt-2 inline-flex items-center gap-1 font-semibold text-emerald-700 hover:text-emerald-900">
                    查看学习路径
                    <ArrowRight className="size-3" />
                  </Link>
                </div>
                {feedback.loopEvidence && (
                  <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs leading-5 text-emerald-800" data-testid="a3-today-loop-evidence">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold text-emerald-950">本次按钮写回证据</div>
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800">
                        {feedback.loopEvidence.schemaVersion}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {feedback.loopEvidence.writeBacks.map((item) => (
                        <div key={`${item.target}-${item.status}`} className="rounded-lg bg-white/85 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-emerald-950">{formatLoopTarget(item.target)}</span>
                            <span className="text-emerald-700">{formatLoopStatus(item.status)}</span>
                          </div>
                          <div className="mt-1 text-emerald-700">{item.summary}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-emerald-700">
                      下一步：{feedback.loopEvidence.nextAction.label}
                    </div>
                  </div>
                )}
                {report && (
                  <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs leading-5 text-emerald-800" data-testid="a3-today-report-sync">
                    <div className="font-semibold text-emerald-950">报告指标已更新</div>
                    <div className="mt-1">完成任务后已重新拉取学习报告，下面是当前报告指标快照和本次变化。</div>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <FeedbackMetric label="计划完成率" value={`${report.weeklySummary?.planCompletion ?? progress}%`} delta={formatReportMetricDelta(previousReport?.weeklySummary?.planCompletion, report.weeklySummary?.planCompletion ?? progress, '%')} />
                      <FeedbackMetric label="路径进度" value={`${report.metrics.pathProgress}%`} delta={formatReportMetricDelta(previousReport?.metrics.pathProgress, report.metrics.pathProgress, '%')} />
                      <FeedbackMetric label="活跃错题" value={`${report.metrics.activeWrongQuestions}`} delta={formatReportMetricDelta(previousReport?.metrics.activeWrongQuestions, report.metrics.activeWrongQuestions)} />
                    </div>
                  </div>
                )}
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {feedback.motivators.map((item) => (
                    <div key={`${item.label}-${item.detail}`} className="rounded-lg bg-white/70 p-3">
                      <div className="text-xs font-semibold text-emerald-900">{item.label}</div>
                      <div className="mt-1 text-xs leading-5 text-emerald-700">{item.detail}</div>
                    </div>
                  ))}
                </div>
                {feedback.resourcePack && (
                  <div className="mt-4 rounded-xl border border-violet-100 bg-violet-50 p-4" data-testid="a3-today-resource-pack-feedback">
                    <div className="flex flex-wrap items-center gap-2">
                      <A3Pill tone="violet">推荐资源包已闭环</A3Pill>
                      <span className="text-xs font-medium text-violet-800">
                        {feedback.resourcePack.verifiedSourceCount} 个已验证来源
                      </span>
                    </div>
                    <div className="mt-3 text-sm font-semibold text-violet-950">{feedback.resourcePack.learningGoal}</div>
                    <p className="mt-2 text-xs leading-5 text-violet-800">
                      系统已把本次资源包学习写回今日任务。下一步进入专项练习，让测评结果继续回流到画像、错题和推荐。
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-violet-800">
                        证据置信度：{feedback.resourcePack.confidence}
                      </span>
                      <Button asChild size="sm" className="bg-violet-600 hover:bg-violet-700">
                        <Link href={feedback.resourcePack.practiceHref}>
                          开始专项练习
                          <ArrowRight className="size-4" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button asChild size="sm" className="bg-emerald-600 hover:bg-emerald-700">
                    <Link data-testid="a3-today-feedback-next-action" href={feedback.nextAction.href}>{feedback.nextAction.label}</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" className="border-emerald-200 bg-white text-emerald-800 hover:bg-emerald-50">
                    <Link data-testid="a3-today-feedback-notification-action" href="/a3/notifications">
                      <Bell className="size-4" />
                      查看提醒
                    </Link>
                  </Button>
                </div>
                {reportActionLoop && (
                  <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4" data-testid="a3-today-report-action-loop">
                    <div className="text-sm font-semibold text-blue-950">报告建议的下一步</div>
                    <p className="mt-2 text-xs leading-5 text-blue-800">{reportActionLoop.primaryReason}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {reportActionLoop.steps.map((step, index) => (
                        <Link
                          key={step.kind}
                          href={step.href}
                          data-testid="a3-today-report-loop-step"
                          className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100"
                        >
                          {index + 1}. {step.title}
                        </Link>
                      ))}
                    </div>
                    <Button asChild size="sm" className="mt-4 bg-blue-600 hover:bg-blue-700">
                      <Link data-testid="a3-today-report-primary-action" href={reportActionLoop.primaryAction.href}>
                        {reportActionLoop.primaryAction.label}
                        <ArrowRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                )}
              </div>
            )}
            {finished && (
              <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4">
                <div className="text-sm font-semibold text-blue-950">今日学习闭环已完成</div>
                <p className="mt-2 text-sm leading-6 text-blue-800">
                  现在最有价值的动作是写一句复盘，再查看报告里的下周学习处方。这样系统能把今天的结果回流到计划和推荐。
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-blue-200 bg-white text-blue-800 hover:bg-blue-50"
                    onClick={() => document.getElementById('daily-reflection-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  >
                    写今日复盘
                  </Button>
                  <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
                    <Link href="/a3/report">查看学习报告</Link>
                  </Button>
                </div>
              </div>
            )}
            {policy?.reason && <div className="mt-4 rounded-xl bg-blue-50 p-4 text-sm leading-6 text-blue-800">{policy.reason}</div>}
            {resourceFeedbackAdjustment && (
              <details className="group mt-4 overflow-hidden rounded-xl border border-emerald-100 bg-emerald-50" data-testid="a3-today-resource-feedback-adjustment">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-emerald-950">资源反馈已调整今日任务</div>
                    <p className="mt-1 line-clamp-1 text-xs leading-5 text-emerald-800">
                      {resourceFeedbackAdjustment.reason ?? '系统已根据资源使用反馈刷新学习计划。'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <A3Pill tone="green">
                      {resourceFeedbackStrategyLabel[resourceFeedbackAdjustment.strategy] ?? '计划已调整'}
                    </A3Pill>
                    <ChevronDown className="size-4 text-emerald-700 transition-transform group-open:rotate-180" aria-hidden="true" />
                  </div>
                </summary>
                <div className="border-t border-emerald-100">
                  <div className="max-h-72 overflow-y-auto px-4 py-3">
                    <dl className="space-y-2 text-xs">
                      <div className="rounded-lg bg-white/75 px-3 py-2">
                        <dt className="font-medium text-emerald-700">调整依据</dt>
                        <dd className="mt-1 break-words leading-5 text-emerald-950">
                          {resourceFeedbackAdjustment.reason ?? '系统已根据资源使用反馈刷新学习计划。'}
                        </dd>
                      </div>
                      <div className="rounded-lg bg-white/75 px-3 py-2">
                        <dt className="font-medium text-emerald-700">学习目标</dt>
                        <dd className="mt-1 break-words leading-5 text-emerald-950">
                          {resourceFeedbackAdjustment.evidence?.latestGoal || '暂未关联具体目标'}
                        </dd>
                      </div>
                      <div className="rounded-lg bg-white/75 px-3 py-2">
                        <dt className="font-medium text-emerald-700">反馈均分</dt>
                        <dd className="mt-1 font-semibold text-emerald-950">
                          {typeof resourceFeedbackAdjustment.evidence?.averageFeedbackScore === 'number'
                            ? resourceFeedbackAdjustment.evidence.averageFeedbackScore
                            : '--'}
                        </dd>
                      </div>
                      <div className="rounded-lg bg-white/75 px-3 py-2">
                        <dt className="font-medium text-emerald-700">下一步任务</dt>
                        <dd className="mt-1 break-words leading-5 text-emerald-950">
                          {resourceFeedbackAdjustment.nextAction?.label || '按当前计划继续学习'}
                        </dd>
                      </div>
                    </dl>
                    {resourceFeedbackAdjustment.nextAction && (
                      <Button asChild size="sm" className="mt-3 w-full bg-emerald-600 hover:bg-emerald-700">
                        <Link href={resourceFeedbackAdjustment.nextAction.href}>
                          {resourceFeedbackAdjustment.nextAction.label}
                          <ArrowRight className="size-4" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </div>
              </details>
            )}
            {activeTask && (
              <div className="mt-4 rounded-xl bg-[var(--a3-surface-muted)] p-4">
                <div className="text-sm font-semibold text-[var(--a3-text)]">当前步骤</div>
                <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{activeTask.subtitle}</p>
              </div>
            )}
          </A3Card>

          <A3Card title="下一步入口">
            <div className="space-y-3" data-testid="a3-today-continuity-rail">
              <QuickLink href="/a3/dashboard" title="学习首页" description="查看任务、画像、推荐和报告的概览，不再作为一级入口打断主线。" />
              {feedback && <QuickLink href="/a3/notifications" title="通知中心" description="查看刚生成的下一步提醒，确保任务完成后不断链。" testId="a3-today-continuity-notifications" />}
              <QuickLink href="/a3/classroom" title="AI 课堂讲解" description="围绕当前知识点追问、听讲解、看引用来源。" />
              <QuickLink href="/a3/assessment" title="题库练习" description="完成对应练习后同步更新掌握度。" />
              <QuickLink href="/a3/wrong-notebook" title="错题复习" description="按间隔复习处理高频错因。" />
              <QuickLink href="/a3/report" title="学习报告" description="查看今日任务对周报和薄弱趋势的影响。" testId="a3-today-continuity-report" />
              <QuickLink href="/a3/study-plan" title="完整计划" description="查看当前周期的任务安排。" />
            </div>
          </A3Card>
        </div>
      </div>
    </div>
  );
}

function trackTaskCompletedEvent(day: StudyPlanDay, task: StudyPlanTask, planId: string) {
  return trackLearningEvent({
    eventId: `task_${planId}_${day.dayIndex}_${task.id}_completed`,
    eventType: 'task_completed',
    sourcePage: '/a3/today',
    targetType: 'study_plan_task',
    targetId: task.id,
    knowledgePointId: task.knowledgePointId,
    durationSec: task.estimatedMinutes * 60,
    metadata: {
      planId,
      dayIndex: day.dayIndex,
      taskType: task.type,
      taskTitle: task.title,
      href: task.href,
    },
  });
}

function SessionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--a3-surface-solid)] p-3">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function TodayLoopStep({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-xl bg-[var(--a3-highlight-surface)] px-3 py-2">
      <div className="text-xs font-semibold text-[var(--a3-highlight-accent)]">{title}</div>
      <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-highlight-muted)]" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function TodayFlowInsightPanel({ insights }: { insights: LearningFlowInsight[] }) {
  if (!insights.length) return null;
  return (
    <A3Card
      title="今天为什么这样学"
      subtitle="根据当前路径、今日任务、错题复习和最近学习效果调整。"
      action={<A3Pill tone="blue">实时排程</A3Pill>}
    >
      <div className="grid gap-3 lg:grid-cols-3" data-testid="a3-today-flow-insights">
        {insights.map((item) => (
          <Link
            key={`${item.title}-${item.href}`}
            href={item.href}
            className="group rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition hover:border-blue-300 hover:bg-blue-50/60"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
              <A3Pill tone={item.tone}>{item.meta || '下一步'}</A3Pill>
            </div>
            <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
            <div className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-700 group-hover:text-blue-800">
              查看对应任务
              <ArrowRight className="size-3" />
            </div>
          </Link>
        ))}
      </div>
    </A3Card>
  );
}

function ProfileChangeReasonCard({ insight }: { insight: LearningFlowInsight | null }) {
  if (!insight) return null;
  return (
    <A3Card
      title="本次安排为什么因画像而变"
      subtitle={insight.detail}
      action={<A3Pill tone={insight.tone}>{insight.meta || '画像证据'}</A3Pill>}
    >
      <div data-testid="a3-today-profile-change-reason" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-orange-100 bg-orange-50 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-orange-950">{insight.title}</div>
          <p className="mt-1 text-xs leading-5 text-orange-800">确认或查看画像变化后，今日任务会继续按新的薄弱点、偏好和风险信号调整。</p>
        </div>
        <Button asChild size="sm" variant="outline" className="border-orange-200 bg-white text-orange-800 hover:bg-orange-50">
          <Link href={insight.href}>查看画像变化</Link>
        </Button>
      </div>
    </A3Card>
  );
}

function FeedbackMetric({ label, value, delta }: { label: string; value: string; delta?: string }) {
  return (
    <div className="rounded-lg bg-white/70 p-2">
      <div className="text-[11px] text-emerald-700">{label}</div>
      <div className="mt-1 font-semibold text-emerald-950">{value}</div>
      {delta && <div className="mt-1 text-[11px] text-emerald-700">{delta}</div>}
    </div>
  );
}

function formatLoopTarget(target: string) {
  return {
    learner_profile: '学习画像',
    learning_path: '学习路径',
    study_plan: '学习计划',
    review_queue: '复习队列',
    report: '学习报告',
    notifications: '通知提醒',
    resource_pack_log: '资源记录',
  }[target] ?? target;
}

function formatLoopStatus(status: string) {
  return {
    updated: '已更新',
    created: '已创建',
    checked: '已检查',
    derived: '实时计算',
    not_applicable: '本次不适用',
  }[status] ?? status;
}

function SessionTask({
  day,
  task,
  index,
  active,
  saving,
  profileFeed,
  onComplete,
}: {
  day: StudyPlanDay;
  task: StudyPlanTask;
  index: number;
  active: boolean;
  saving: boolean;
  profileFeed: ProfileFeedResponse | null;
  onComplete: (day: StudyPlanDay, task: StudyPlanTask) => void;
}) {
  const completed = task.status === 'completed';
  const copy = taskCopy[task.type];
  const profileRationale = buildTaskProfileRationale(task, profileFeed);
  return (
    <div
      data-testid="a3-today-task"
      className={cn(
        'grid gap-4 rounded-2xl border p-4 md:grid-cols-[52px_1fr_190px]',
        completed ? 'border-emerald-200 bg-emerald-50/70' : active ? 'border-blue-300 bg-blue-50/60' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)]',
      )}
    >
      <div className={cn('flex size-11 items-center justify-center rounded-xl text-sm font-semibold', completed ? 'bg-emerald-500 text-white' : active ? 'bg-blue-600 text-white' : 'bg-[var(--a3-surface-muted)] text-[var(--a3-text-muted)]')}>
        {completed ? <CheckCircle2 className="size-5" /> : index}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <A3Pill tone={copy.tone}>{copy.label}</A3Pill>
          {task.rolledOverFrom && (
            <A3Pill tone="orange">顺延自第 {task.rolledOverFrom.dayIndex} 天</A3Pill>
          )}
          <span className="inline-flex items-center gap-1 text-xs text-[var(--a3-text-muted)]">
            <Clock3 className="size-3" />
            {task.estimatedMinutes} 分钟
          </span>
        </div>
        <div className="mt-2 text-base font-semibold text-[var(--a3-text)]">{task.title}</div>
        <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{task.subtitle}</p>
        <div data-testid="a3-task-profile-rationale" className="mt-3 min-w-0 break-words rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-orange-950">{profileRationale.label}</span>
            <Link href={profileRationale.href || PROFILE_SETUP_HREF} className="font-semibold text-orange-700 hover:text-orange-900">
              查看画像
            </Link>
          </div>
          <div className="mt-1 break-words">{profileRationale.detail}</div>
          {profileRationale.confidence > 0 && <div className="mt-1 text-orange-700">证据置信度 {profileRationale.confidence}%</div>}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={task.href}>{copy.action}</Link>
        </Button>
        <Button
          size="sm"
          data-testid="a3-today-task-complete"
          disabled={completed || saving}
          onClick={() => onComplete(day, task)}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          {completed ? '已完成' : '完成'}
        </Button>
      </div>
    </div>
  );
}

function QuickLink({ href, title, description, testId }: { href: string; title: string; description: string; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className="flex items-start gap-3 rounded-xl border border-[var(--a3-border)] p-3 hover:bg-blue-50">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
        <MessageCircle className="size-4" />
      </div>
      <div>
        <div className="text-sm font-semibold text-[var(--a3-text)]">{title}</div>
        <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">{description}</p>
      </div>
    </Link>
  );
}
