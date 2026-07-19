'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, Clock3, Flame, Loader2, RefreshCw, Route, Sparkles, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { buildProfileChangeInsight, buildStudyPlanFlowInsights, buildTaskProfileRationale, type LearningFlowInsight } from '@/lib/a3/learning-flow-insights';
import { trackLearningEvent, trackPageView } from '@/lib/a3/learning-event-client';
import type { A3ApiResponse, StudyPlan, StudyPlanDay, StudyPlanTask } from '@/lib/a3/learning-types';
import type { DynamicProfileFeedResponse } from '@/lib/a3/profile-timeline';
import { getReviewStatusMeta } from '@/lib/a3/review-status';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';

type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan }>;
type ProfileFeedResponse = DynamicProfileFeedResponse;

const taskTone: Record<StudyPlanTask['type'], 'blue' | 'green' | 'orange' | 'violet'> = {
  learn: 'blue',
  practice: 'green',
  review: 'orange',
  summary: 'violet',
  resource_pack: 'violet',
};

const taskLabel: Record<StudyPlanTask['type'], string> = {
  learn: '讲解',
  practice: '练习',
  review: '复习',
  summary: '复盘',
  resource_pack: '资源包',
};

const dayStatusLabel: Record<StudyPlanDay['status'], string> = {
  today: '今天',
  pending: '待开始',
  in_progress: '进行中',
  completed: '完成',
  rolled_over: '已顺延',
};

const adjustmentTone: Record<NonNullable<StudyPlan['adjustmentTimeline']>[number]['type'], 'blue' | 'green' | 'orange' | 'violet'> = {
  policy: 'blue',
  mastery: 'orange',
  review: 'violet',
  rollover: 'green',
  resource_pack: 'violet',
  resource_feedback: 'green',
  learning_effect: 'orange',
};

const PROFILE_SETUP_HREF = '/a3/profile-setup';

export function StudyPlanView() {
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [durationDays, setDurationDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [savingTask, setSavingTask] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [profileFeed, setProfileFeed] = useState<ProfileFeedResponse | null>(null);

  async function load(auto = true) {
    setLoading(true);
    setError('');
    const result = await a3GetJson<StudyPlanResponse>(`/api/learning/study-plan/${auto ? '?auto=1' : ''}`);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? '学习计划加载失败');
      return;
    }
    setPlan(result.plan);
    setDurationDays(result.plan.durationDays);
    void a3GetJson<ProfileFeedResponse>('/api/profiles/dynamic-profile/').then((profileResponse) => {
      if (profileResponse.success) setProfileFeed(profileResponse);
    });
  }

  async function generate(nextDuration = durationDays) {
    setGenerating(true);
    setError('');
    const result = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/generate/', {
      durationDays: nextDuration,
      force: true,
    });
    setGenerating(false);
    if (!result.success) {
      setError(result.error ?? '学习计划生成失败');
      return;
    }
    setPlan(result.plan);
    setDurationDays(result.plan.durationDays);
  }

  async function completeTask(day: StudyPlanDay, task: StudyPlanTask) {
    setSavingTask(task.id);
    setError('');
    const result = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/tasks/complete/', {
      dayIndex: day.dayIndex,
      taskId: task.id,
    });
    setSavingTask('');
    if (!result.success) {
      setError(result.error ?? '任务完成失败');
      return;
    }
    setPlan(result.plan);
    void trackStudyPlanTaskCompletedEvent(day, task, result.plan.planId);
  }

  useEffect(() => {
    void trackPageView('/a3/study-plan', { page: 'study_plan' });
    const timer = window.setTimeout(() => {
      void load(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const today = useMemo(() => plan?.days.find((day) => day.status === 'today' || day.dayIndex === 1) ?? null, [plan]);
  const planContext = plan?.planContext;
  const currentPathItem = planContext?.learningPath.currentItem ?? null;
  const todayBindings = planContext?.todayBindings ?? [];
  const durationOptions = useMemo(
    () =>
      planContext?.durationOptions?.length
        ? planContext.durationOptions
        : [7, 14, 30].map((days) => ({
            days,
            selected: days === (plan?.durationDays ?? durationDays),
            targetDate: days === (plan?.durationDays ?? durationDays) ? (plan?.targetDate ?? '--') : '--',
            estimatedDailyMinutes: plan?.dailyMinutes ?? 0,
            load: days === (plan?.durationDays ?? durationDays) ? '当前' : '待重排',
            reason: '选择后由 StudyPlanAgent 基于当前路径、错题和画像重新排程。',
          })),
    [durationDays, plan, planContext],
  );
  const weakMastery = useMemo(() => (plan?.mastery ?? []).filter((item) => item.status === 'weak').slice(0, 5), [plan]);
  const reviewQueue = useMemo(
    () => [...(plan?.reviewQueue ?? [])].sort((a, b) => getReviewStatusMeta(a).priority - getReviewStatusMeta(b).priority || new Date(a.reviewAfter).getTime() - new Date(b.reviewAfter).getTime()),
    [plan?.reviewQueue],
  );
  const explanation = plan?.explanation;
  const currentChange = explanation?.currentChange ?? plan?.adjustmentTimeline?.[0];
  const changeNextAction = explanation?.nextAction;
  const resourceFeedbackAdjustment = plan?.lastResourceFeedbackAdjustment;
  const latestTaskFeedback = plan?.lastTaskFeedback ?? null;
  const planPeriodDays = plan?.durationDays ?? durationDays;
  const scheduledDays = plan?.days ?? [];
  const profileSignals = explanation?.profileSignals;
  const primaryGoal = profileSignals?.learningGoals?.[0] ?? plan?.title ?? '当前学习目标';
  const currentWeakPoints = profileSignals?.weakPoints?.length ? profileSignals.weakPoints : weakMastery.map((item) => item.title);
  const todayPrimaryTask = today?.tasks.find((task) => task.status !== 'completed') ?? today?.tasks[0] ?? null;
  const planningReason = currentChange?.reason ?? explanation?.weakPointPolicy.reason ?? plan?.adaptivePolicy?.reason ?? plan?.coachTip ?? '系统会结合画像、诊断、路径进度和错题复习队列安排任务。';
  const planFlowInsights = useMemo(() => buildStudyPlanFlowInsights({ plan }), [plan]);
  const profileChangeInsight = useMemo(() => buildProfileChangeInsight(profileFeed), [profileFeed]);
  const studentPlanReason = buildStudentPlanReason({
    taskTitle: todayPrimaryTask?.title,
    weakPoint: currentWeakPoints[0],
    currentNode: currentPathItem?.title,
    minutes: todayPrimaryTask?.estimatedMinutes ?? plan?.dailyMinutes,
  });

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-sm text-[var(--a3-text-muted)]">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在生成学习计划
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="a3-study-plan-view">
      <section data-testid="a3-study-plan-hub" className="overflow-hidden rounded-[18px] border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-bg)] p-6 text-[var(--a3-highlight-text)] shadow-[var(--a3-highlight-shadow)]">
        <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <div>
            <A3Pill tone="green">学习计划</A3Pill>
            <h1 className="mt-4 text-3xl font-semibold tracking-normal">今天先按这条线学</h1>
            <p className="mt-2 text-sm text-[var(--a3-highlight-muted)]">{plan?.course.title ?? '当前课程'} / {primaryGoal}</p>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--a3-highlight-muted)]">{studentPlanReason}</p>
            <div className="mt-5 grid gap-3 lg:grid-cols-4">
              <HubSignal label="课程" value={plan?.course.title ?? '--'} detail={plan?.course.id ?? 'course'} />
              <HubSignal label="当前节点" value={currentPathItem?.title ?? '待生成路径'} detail={currentPathItem?.chapter ?? '完成画像或诊断后生成'} />
              <HubSignal label="薄弱点" value={currentWeakPoints.slice(0, 2).join('、') || '暂无明显薄弱点'} detail={`复习队列 ${plan?.reviewQueue.length ?? 0} 个`} />
              <HubSignal label="今日安排" value={todayPrimaryTask?.title ?? '暂无今日任务'} detail={todayPrimaryTask ? `${todayPrimaryTask.estimatedMinutes} 分钟` : '查看今日学习'} />
            </div>
            <div className="mt-4 rounded-2xl bg-[var(--a3-highlight-surface)] p-4 text-sm leading-6 text-[var(--a3-highlight-text)]">
              <span className="font-semibold text-[var(--a3-highlight-accent)]">安排依据：</span>
              {shortPlanReason(planningReason)}
            </div>
            <div className="mt-5 grid gap-3 lg:grid-cols-3">
              {durationOptions.map((option) => (
                <Button
                  key={option.days}
                  variant={option.selected ? 'default' : 'outline'}
                  onClick={() => {
                    setDurationDays(option.days);
                    void generate(option.days);
                  }}
                  disabled={generating}
                  className={cn(
                    'h-auto justify-start rounded-xl px-4 py-3 text-left',
                    option.selected ? 'bg-amber-400 text-amber-950 hover:bg-amber-300' : 'border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10',
                  )}
                >
                  <span className="flex flex-col">
                    <span className="font-semibold">{option.days} 天重排{option.selected ? '（当前）' : ''}</span>
                    <span className="mt-1 text-xs opacity-80">
                      {option.load} / 每日约 {option.estimatedDailyMinutes} 分钟 / {option.targetDate}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--a3-highlight-muted)]">
              <span>切换周期会立即重排今日和后续任务。</span>
              <Button onClick={() => void generate(durationDays)} disabled={generating} size="sm" variant="outline" className="border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10">
                {generating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                按当前周期重新排程
              </Button>
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded-2xl border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] p-4">
              <div className="text-sm font-semibold text-[var(--a3-highlight-text)]">计划快照</div>
              <p className="mt-2 text-xs leading-5 text-[var(--a3-highlight-muted)]">今天完成后，学习路径、错题复习和报告会同步更新。</p>
            </div>
            <PlanContextMetric
              icon={Route}
              label="当前路径节点"
              value={currentPathItem?.title ?? '待生成路径'}
              detail={currentPathItem ? `${currentPathItem.chapter} / 路径进度 ${currentPathItem.progress}%` : '完成入学诊断后生成路径'}
            />
            <div className="grid grid-cols-2 gap-3">
              <PlanContextMetric icon={Target} label="当前等级" value={`${plan?.level.code ?? '--'} / ${plan?.level.label ?? '待诊断'}`} detail={`路径 ${planContext?.learningPath.progress ?? plan?.level.pathProgress ?? 0}%`} />
              <PlanContextMetric icon={Clock3} label="每日时长" value={`${plan?.dailyMinutes ?? 0} 分钟`} detail={plan?.adaptivePolicy ? policyLabel(plan.adaptivePolicy.mode) : '标准节奏'} />
              <PlanContextMetric icon={CalendarDays} label="目标日期" value={plan?.targetDate ?? '--'} detail={`${plan?.durationDays ?? 0} 天计划`} />
              <PlanContextMetric icon={Flame} label="今日绑定" value={`${todayBindings.length} 个任务`} detail="完成后写回路径/错题/报告" />
            </div>
          </div>
        </div>
      </section>

      <StudyPlanFlowInsightPanel insights={planFlowInsights} />
      <StudyPlanProfileChangePanel insight={profileChangeInsight} />

      {error && <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]" data-testid="a3-study-plan-continuity">
        <A3Card title="这条计划怎么接上学习" subtitle="从路径到今天任务，完成后自动更新进度。">
          <div className="grid gap-3 md:grid-cols-4">
            <ContinuityStep index={1} title="路径" detail={currentPathItem?.title ?? '完成诊断后生成起点'} href="/a3/learning-path" />
            <ContinuityStep index={2} title="周期" detail={`${plan?.durationDays ?? 14} 天，每天约 ${plan?.dailyMinutes ?? 0} 分钟`} href="/a3/study-plan" />
            <ContinuityStep index={3} title="今天" detail={todayPrimaryTask?.title ?? '查看今日任务'} href="/a3/today" />
            <ContinuityStep index={4} title="报告" detail="完成后同步进度和薄弱点" href="/a3/report" />
          </div>
          <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4 dark:border-blue-900/60 dark:bg-blue-950/35">
            <div className="text-sm font-semibold text-blue-950 dark:text-blue-100">今天要推进的节点</div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {todayBindings.slice(0, 4).map((binding) => (
                <div key={binding.taskId} className="rounded-lg bg-white px-3 py-2 text-xs leading-5 text-blue-900 dark:bg-slate-950/40 dark:text-blue-100">
                  <div className="font-semibold">{binding.title}</div>
                  <div className="mt-1 text-blue-700 dark:text-blue-300">{binding.chapter ?? '复习任务'} · 当前进度 {binding.pathProgress}%</div>
                </div>
              ))}
              {!todayBindings.length && <div className="rounded-lg bg-white px-3 py-2 text-xs text-blue-700 dark:bg-slate-950/40 dark:text-blue-300">暂无今日绑定任务，完成诊断或重新排程后会生成。</div>}
            </div>
          </div>
        </A3Card>

        <A3Card title="后台协作" subtitle="需要答辩说明时再看这里。">
          <div className="space-y-3">
            {(planContext?.agentRoles ?? []).map((agent) => (
              <div key={agent.name} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--a3-text)]">{agent.name}</div>
                  <A3Pill tone="blue">{agent.role}</A3Pill>
                </div>
                <div className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{agent.output}</div>
              </div>
            ))}
          </div>
        </A3Card>
      </section>

      <A3Card title="学习规划二级入口" subtitle="这里统一承接诊断、画像、路径和课程学习，避免在一级菜单里拆成多条孤立入口。">
        <div className="grid gap-3 md:grid-cols-4" data-testid="a3-study-planning-secondary-nav">
          <ContinuityStep index={1} title="入学诊断" detail="重新识别基础水平、薄弱点和适合的起点。" href="/a3/admission-diagnostic" />
          <ContinuityStep index={2} title="学习画像" detail="调整年级、专业方向、目标和每日可用时间。" href="/a3/profile-setup" />
          <ContinuityStep index={3} title="学习路径" detail="查看知识点先修关系、当前节点和路径进度。" href="/a3/learning-path" />
          <ContinuityStep index={4} title="课程学习" detail="进入课程内容，按当前路径继续学习具体章节。" href="/a3/courses" />
        </div>
      </A3Card>

      <div data-testid="a3-study-plan-rationale">
        <A3Card title="为什么今天这样学" subtitle="只看影响今天安排的关键信号。">
          <div className="grid gap-3 md:grid-cols-3">
            <RationaleItem
              label="基础水平"
              value={plan?.level.label ?? '待诊断'}
              detail={plan?.level.description ?? '完成入学诊断后会同步更新学习强度。'}
            />
            <RationaleItem
              label="节奏策略"
              value={plan?.adaptivePolicy ? policyLabel(plan.adaptivePolicy.mode) : '标准节奏'}
              detail={plan?.adaptivePolicy?.reason ?? '结合每日可用时长、错题压力和路径进度安排任务。'}
            />
            <RationaleItem
              label="复习压力"
              value={`${plan?.reviewQueue.length ?? 0} 个待复习`}
              detail="错题会进入分层复习安排，并影响后续讲解、练习和复盘任务。"
            />
          </div>
          <div data-testid="a3-study-plan-explainer" className="mt-4 rounded-[14px] border border-blue-100 bg-blue-50 p-4 dark:border-blue-900/60 dark:bg-blue-950/35">
            <div className="flex items-center gap-2 text-sm font-semibold text-blue-950 dark:text-blue-100">
              <Sparkles className="size-4 text-blue-700 dark:text-blue-300" />
              今天的安排
            </div>
            <div className="mt-3 grid gap-3 text-xs leading-5 text-blue-900 dark:text-blue-100 md:grid-cols-2">
              <PlanExplainItem
                label="画像"
                value={`${explanation?.profileSignals.level.label ?? plan?.level.label ?? '待诊断'}，路径进度 ${explanation?.profileSignals.level.pathProgress ?? plan?.level.pathProgress ?? 0}%`}
                detail={explanation?.profileSignals.level.description ?? plan?.level.description ?? '系统会先读取画像和诊断结果，再决定任务难度。'}
              />
              <PlanExplainItem
                label="薄弱点"
                value={`${explanation?.weakPointPolicy.count ?? weakMastery.length} 个优先强化`}
                detail={explanation?.weakPointPolicy.reason ?? (weakMastery.length ? weakMastery.map((item) => item.title).join('、') : '当前没有明显薄弱点，计划会保持正常推进。')}
              />
              <PlanExplainItem
                label="节奏"
                value={explanation?.loadPolicy ? `${policyLabel(explanation.loadPolicy.mode)}，每日 ${explanation.loadPolicy.dailyMinutes} 分钟` : plan?.adaptivePolicy ? `${policyLabel(plan.adaptivePolicy.mode)}，每日 ${plan.adaptivePolicy.dailyMinutes} 分钟` : `${plan?.dailyMinutes ?? 0} 分钟`}
                detail={explanation?.loadPolicy.reason ?? plan?.adaptivePolicy?.reason ?? '按当前可用学习时间和错题压力生成。'}
              />
              <PlanExplainItem
                label="复习队列"
                value={`${explanation?.reviewPolicy.count ?? plan?.reviewQueue.length ?? 0} 个错题知识点`}
                detail={explanation?.reviewPolicy.reason ?? ((plan?.reviewQueue.length ?? 0) > 0 ? '错题会穿插到每日任务，避免只学新内容不复盘。' : '暂无待复习错题，后续测评会自动进入队列。')}
              />
            </div>
            <div className="mt-3 rounded-lg bg-white/75 px-3 py-2 text-xs leading-5 text-blue-900 dark:bg-slate-950/40 dark:text-blue-100">
              调整记录：{(explanation?.adjustments ?? plan?.adjustmentTimeline ?? []).slice(0, 2).map((event) => event.title).join('、') || '完成任务或测评后会记录计划变化原因'}
            </div>
            {currentChange && (
              <div data-testid="a3-study-plan-current-change" className="mt-3 rounded-xl border border-blue-200 bg-white px-4 py-3 dark:border-blue-900/60 dark:bg-slate-950/40">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-blue-700 dark:text-blue-300">最近任务为什么变了</div>
                    <div className="mt-1 text-sm font-semibold text-blue-950 dark:text-blue-100">{currentChange.title}</div>
                    {currentChange.detail && <p className="mt-2 text-xs leading-5 text-blue-800 dark:text-blue-200">{currentChange.detail}</p>}
                    <p className="mt-2 text-xs leading-5 text-blue-800 dark:text-blue-200">{currentChange.reason}</p>
                    <p className="mt-1 text-xs leading-5 text-blue-700 dark:text-blue-300">{currentChange.impact}</p>
                    {changeNextAction?.reason && <p className="mt-2 text-xs leading-5 text-blue-700 dark:text-blue-300">下一步：{changeNextAction.reason}</p>}
                  </div>
                  {changeNextAction && (
                    <Button asChild size="sm" className="shrink-0 bg-blue-600 hover:bg-blue-700">
                      <Link data-testid="a3-study-plan-current-change-action" href={changeNextAction.href}>{changeNextAction.label}</Link>
                    </Button>
                  )}
                </div>
              </div>
            )}
            {resourceFeedbackAdjustment && (
              <div data-testid="a3-study-plan-resource-feedback-adjustment" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">ResourceFeedbackAgent</div>
                <div className="mt-1 text-sm font-semibold">资源反馈已写回学习计划：{resourceFeedbackAdjustment.strategy}</div>
                <div className="mt-2 grid gap-2 text-xs leading-5 md:grid-cols-3">
                  <span className="rounded-lg bg-white/75 px-3 py-2 dark:bg-slate-950/40">目标：{resourceFeedbackAdjustment.evidence?.latestGoal || '--'}</span>
                  <span className="rounded-lg bg-white/75 px-3 py-2 dark:bg-slate-950/40">反馈均分：{resourceFeedbackAdjustment.evidence?.averageFeedbackScore ?? 0}</span>
                  <span className="rounded-lg bg-white/75 px-3 py-2 dark:bg-slate-950/40">写回任务：{resourceFeedbackAdjustment.taskId ?? '--'}</span>
                </div>
                {resourceFeedbackAdjustment.reason && <p className="mt-2 text-xs leading-5 text-emerald-800">{resourceFeedbackAdjustment.reason}</p>}
                {resourceFeedbackAdjustment.nextAction && (
                  <Button asChild size="sm" className="mt-3 bg-emerald-600 hover:bg-emerald-700">
                    <Link href={resourceFeedbackAdjustment.nextAction.href}>{resourceFeedbackAdjustment.nextAction.label}</Link>
                  </Button>
                )}
              </div>
            )}
          </div>
        </A3Card>
      </div>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="space-y-5">
          <div data-testid="a3-study-plan-today">
            <A3Card
              title="今日计划"
              subtitle={today ? `${today.date} / ${today.focus} / 预计 ${today.estimatedMinutes} 分钟` : '暂无今日计划'}
              action={<A3Pill tone="blue">{today?.progress ?? 0}%</A3Pill>}
            >
              {today ? (
                <div className="space-y-3">
                  {latestTaskFeedback && (
                    <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-900" data-testid="a3-study-plan-classroom-progress-sync">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">课堂回写后的计划进度</div>
                          <p className="mt-1 text-xs leading-5 text-emerald-800">{latestTaskFeedback.headline}</p>
                        </div>
                        <A3Pill tone={latestTaskFeedback.dailyClosed ? 'green' : 'orange'}>
                          今日 {latestTaskFeedback.completedTasks}/{latestTaskFeedback.totalTasks}
                        </A3Pill>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                        <PlanSyncMetric label="回写任务" value={latestTaskFeedback.title} />
                        <PlanSyncMetric label="今日进度" value={`${latestTaskFeedback.dayProgress}%`} />
                        <PlanSyncMetric label="剩余任务" value={`${latestTaskFeedback.remainingTasks}`} />
                        <PlanSyncMetric label="掌握变化" value={`${latestTaskFeedback.masteryAfter}% ${latestTaskFeedback.delta}`} />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-emerald-800">
                        <span>该证据来自任务完成接口，可和课堂练习卡的计划回写状态相互印证。</span>
                        <Link href={latestTaskFeedback.nextAction.href} className="font-semibold text-emerald-700 hover:text-emerald-950">
                          {latestTaskFeedback.nextAction.label}
                        </Link>
                      </div>
                    </div>
                  )}
                  {today.tasks.map((task) => (
                    <TaskRow key={task.id} day={today} task={task} saving={savingTask === task.id} profileFeed={profileFeed} onComplete={completeTask} />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-6 py-8 text-center">
                  <p className="text-sm text-[var(--a3-text-muted)]">今日暂无计划，先完成入学诊断，系统会自动生成每日学习安排。</p>
                  <div className="mt-4 flex justify-center gap-3">
                    <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
                      <Link href="/a3/admission-diagnostic">开始入学诊断</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href="/a3/today">查看今日任务</Link>
                    </Button>
                  </div>
                </div>
              )}
            </A3Card>
          </div>

          <div data-testid="a3-study-plan-period">
            <A3Card
              title={`${planPeriodDays} 天周期计划`}
              subtitle={`已排 ${scheduledDays.length} 天任务，按当前计划周期展示；未完成任务会按策略顺延。`}
            >
              <div className="grid gap-3 lg:grid-cols-2">
                {scheduledDays.map((day) => (
                  <Link key={day.dayIndex} href={day.tasks[0]?.href ?? '/a3/classroom'} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition-colors hover:border-blue-300 hover:bg-blue-50/50 dark:hover:bg-blue-950/30">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--a3-text)]">{day.title}</div>
                        <div className="mt-1 text-xs text-[var(--a3-text-muted)]">
                          {day.date} / {day.focus}
                        </div>
                      </div>
                      <A3Pill tone={day.status === 'completed' ? 'green' : day.status === 'today' ? 'blue' : day.status === 'rolled_over' ? 'orange' : 'slate'}>{dayStatusLabel[day.status]}</A3Pill>
                    </div>
                    <div className="mt-4 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-blue-600" style={{ width: `${day.progress}%` }} />
                    </div>
                    <div className="mt-3 flex justify-between text-xs text-[var(--a3-text-muted)]">
                      <span>{day.tasks.length} 个任务</span>
                      <span>{day.estimatedMinutes} 分钟</span>
                    </div>
                  </Link>
                ))}
                {!scheduledDays.length && (
                  <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-5 text-sm leading-6 text-[var(--a3-text-muted)]">
                    暂无周期任务。完成入学诊断或重新排程后，系统会按当前周期生成每日安排。
                  </div>
                )}
              </div>
            </A3Card>
          </div>
        </div>

        <div className="space-y-5">
          <A3Card title="AI 教练反馈" action={<Sparkles className="size-4 text-blue-600" />}>
            <p className="text-sm leading-7 text-[var(--a3-text-muted)]">{plan?.coachTip ?? '完成一次诊断后生成个性化建议。'}</p>
            <div className="mt-4 rounded-xl bg-[var(--a3-surface-muted)] p-3">
              <div className="text-sm font-semibold text-[var(--a3-text)]">{plan?.level.label ?? '待诊断'}</div>
              <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{plan?.level.description ?? '先完成入学诊断，系统会识别基础水平和薄弱点。'}</p>
            </div>
          </A3Card>

          <div data-testid="a3-study-plan-adjustments">
            <A3Card title="计划调整时间线" action={<Route className="size-4 text-blue-600" />}>
              <div className="space-y-3">
                {(plan?.adjustmentTimeline ?? []).map((event) => (
                  <div key={event.id} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-[var(--a3-text)]">{event.title}</div>
                        <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{event.reason}</p>
                      </div>
                      <A3Pill tone={adjustmentTone[event.type]}>{adjustmentLabel(event.type)}</A3Pill>
                    </div>
                    <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800 dark:bg-blue-950/35 dark:text-blue-200">{event.impact ?? event.detail ?? event.reason}</div>
                  </div>
                ))}
                {!plan?.adjustmentTimeline?.length && (
                  <div className="rounded-xl bg-[var(--a3-surface-muted)] p-5 text-sm leading-6 text-[var(--a3-text-muted)]">
                    暂无调整记录。完成诊断、任务或错题复习后，系统会记录计划变化原因。
                  </div>
                )}
              </div>
            </A3Card>
          </div>

          <div data-testid="a3-study-plan-weak-mastery">
            <A3Card title="薄弱点掌握度">
              <div className="space-y-3">
                {weakMastery.map((item) => (
                  <div key={item.knowledgePointId}>
                    <div className="mb-1 flex justify-between gap-3 text-sm">
                      <span className="truncate text-[var(--a3-text)]">{item.title}</span>
                      <span className="font-semibold text-orange-700">{item.score}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-orange-500" style={{ width: `${item.score}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-[var(--a3-text-muted)]">
                      {item.chapter} / 错题 {item.wrongCount}
                    </div>
                  </div>
                ))}
                {!weakMastery.length && <p className="text-sm leading-6 text-[var(--a3-text-muted)]">当前没有明显薄弱点，建议继续推进综合练习。</p>}
              </div>
            </A3Card>
          </div>

          <div data-testid="a3-study-plan-review-queue">
            <A3Card title="间隔复习队列">
              <div className="space-y-3">
                {reviewQueue.slice(0, 5).map((item) => (
                  <Link key={item.id} href={item.href} className="block rounded-xl bg-[var(--a3-surface-muted)] p-3 hover:bg-blue-50 dark:hover:bg-blue-950/35">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-[var(--a3-text)]">{item.title}</span>
                      <A3Pill tone={getReviewStatusMeta(item).tone}>{getReviewStatusMeta(item).label}</A3Pill>
                      <A3Pill tone="orange">{item.wrongCount} 次</A3Pill>
                    </div>
                    <div className="mt-1 text-xs text-[var(--a3-text-muted)]">复习时间：{new Date(item.reviewAfter).toLocaleDateString('zh-CN')}</div>
                  </Link>
                ))}
                {!plan?.reviewQueue.length && <p className="text-sm leading-6 text-[var(--a3-text-muted)]">暂无待复习错题。</p>}
              </div>
            </A3Card>
          </div>
        </div>
      </section>
    </div>
  );
}

function trackStudyPlanTaskCompletedEvent(day: StudyPlanDay, task: StudyPlanTask, planId: string) {
  return trackLearningEvent({
    eventId: `task_${planId}_${day.dayIndex}_${task.id}_completed_study_plan`,
    eventType: 'task_completed',
    sourcePage: '/a3/study-plan',
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

function adjustmentLabel(type: NonNullable<StudyPlan['adjustmentTimeline']>[number]['type']) {
  if (type === 'policy') return '节奏';
  if (type === 'mastery') return '薄弱点';
  if (type === 'review') return '复习';
  if (type === 'resource_pack') return '资源包';
  if (type === 'resource_feedback') return '资源反馈';
  return '顺延';
}

function policyLabel(mode: NonNullable<StudyPlan['adaptivePolicy']>['mode']) {
  if (mode === 'reduced_load') return '降负荷';
  if (mode === 'accelerated') return '加速推进';
  return '标准节奏';
}

function buildStudentPlanReason({
  taskTitle,
  weakPoint,
  currentNode,
  minutes,
}: {
  taskTitle?: string;
  weakPoint?: string;
  currentNode?: string;
  minutes?: number;
}) {
  if (taskTitle) return `先完成「${taskTitle}」，预计 ${minutes || 30} 分钟。`;
  if (weakPoint) return `当前优先补「${weakPoint}」，完成后会更新后续安排。`;
  if (currentNode) return `从「${currentNode}」继续，按今天可用时间推进。`;
  return '完成入学诊断后，这里会给出今天的第一步。';
}

function shortPlanReason(reason: string) {
  const text = reason.trim();
  if (!text) return '按当前薄弱点和可用时间安排。';
  if (text.length <= 42) return text;
  const firstSentence = text.split(/[。；;]/)[0]?.trim();
  return firstSentence && firstSentence.length <= 42 ? `${firstSentence}。` : `${text.slice(0, 42)}。`;
}

function StudyPlanFlowInsightPanel({ insights }: { insights: LearningFlowInsight[] }) {
  if (!insights.length) return null;
  return (
    <A3Card
      title="计划为什么调整"
      subtitle="这里展示会影响后续任务的学习效果、资源反馈和复习信号。"
      action={<A3Pill tone="green">已进入排程</A3Pill>}
    >
      <div className="grid gap-3 lg:grid-cols-3" data-testid="a3-study-plan-flow-insights">
        {insights.map((item) => (
          <Link
            key={`${item.title}-${item.href}`}
            href={item.href}
            className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition-colors hover:border-blue-300 hover:bg-blue-50/60 dark:hover:bg-blue-950/30"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
              <A3Pill tone={item.tone}>{item.meta || '调整'}</A3Pill>
            </div>
            <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
          </Link>
        ))}
      </div>
    </A3Card>
  );
}

function StudyPlanProfileChangePanel({ insight }: { insight: LearningFlowInsight | null }) {
  if (!insight) return null;
  return (
    <A3Card
      title="计划为什么因画像而变"
      subtitle={insight.detail}
      action={<A3Pill tone={insight.tone}>{insight.meta || '画像时间线'}</A3Pill>}
    >
      <div data-testid="a3-study-plan-profile-change-reason" className="grid gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 dark:border-blue-900/60 dark:bg-blue-950/35 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <div className="text-sm font-semibold text-blue-950 dark:text-blue-100">{insight.title}</div>
          <p className="mt-1 text-xs leading-5 text-blue-800 dark:text-blue-200">计划会把已确认画像用于任务时长、复习队列、资源类型和下一次推荐排序。</p>
        </div>
        <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
          <Link href={insight.href}>查看画像证据</Link>
        </Button>
      </div>
    </A3Card>
  );
}

function RationaleItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-2 text-base font-semibold text-[var(--a3-text)]">{value}</div>
      <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{detail}</p>
    </div>
  );
}

function PlanExplainItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg bg-white/75 px-3 py-2 dark:bg-slate-950/40">
      <div className="font-semibold text-blue-950 dark:text-blue-100">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
      <div className="mt-1 text-blue-700 dark:text-blue-300">{detail}</div>
    </div>
  );
}

function HubSignal({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl bg-[var(--a3-highlight-surface)] p-4">
      <div className="text-xs font-medium text-[var(--a3-highlight-accent)]">{label}</div>
      <div className="mt-2 truncate text-sm font-semibold text-[var(--a3-highlight-text)]" title={value}>
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-[var(--a3-highlight-muted)]" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function ContinuityStep({ index, title, detail, href }: { index: number; title: string; detail: string; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition-colors hover:border-blue-300 hover:bg-blue-50/60 dark:hover:bg-blue-950/30">
      <div className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-semibold text-white">{index}</div>
      <div className="mt-3 text-sm font-semibold text-[var(--a3-text)]">{title}</div>
      <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{detail}</p>
    </Link>
  );
}

function PlanContextMetric({ icon: Icon, label, value, detail }: { icon: typeof Target; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl bg-[var(--a3-highlight-surface)] p-4">
      <Icon className="size-5 text-[var(--a3-highlight-accent)]" />
      <div className="mt-3 text-xs text-[var(--a3-highlight-muted)]">{label}</div>
      <div className="mt-1 truncate text-base font-semibold text-[var(--a3-highlight-text)]" title={value}>
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-[var(--a3-highlight-muted)]" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function PlanSyncMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/75 px-3 py-2 dark:bg-slate-950/40">
      <div className="text-[11px] font-medium text-emerald-700">{label}</div>
      <div className="mt-1 truncate font-semibold text-emerald-950" title={value}>{value}</div>
    </div>
  );
}

function TaskRow({ day, task, saving, profileFeed, onComplete }: { day: StudyPlanDay; task: StudyPlanTask; saving: boolean; profileFeed: ProfileFeedResponse | null; onComplete: (day: StudyPlanDay, task: StudyPlanTask) => void }) {
  const completed = task.status === 'completed';
  const profileRationale = buildTaskProfileRationale(task, profileFeed);
  return (
    <div className={cn('grid gap-4 rounded-xl border p-4 md:grid-cols-[1fr_150px]', completed ? 'border-emerald-200 bg-emerald-50/70' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)]')}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <A3Pill tone={taskTone[task.type]}>{taskLabel[task.type]}</A3Pill>
          <span className="text-xs text-[var(--a3-text-muted)]">{task.estimatedMinutes} 分钟</span>
          {task.rolledOverFrom && (
            <A3Pill tone="orange">顺延自第 {task.rolledOverFrom.dayIndex} 天</A3Pill>
          )}
          {task.source === 'personal_material' && (
            <A3Pill tone="green">来自我的资料</A3Pill>
          )}
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
        {task.source === 'personal_material' && task.sourceResourceName && (
          <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
            来源：{task.sourceResourceName}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={task.href}>开始</Link>
        </Button>
        <Button size="sm" disabled={completed || saving} onClick={() => onComplete(day, task)} className="bg-blue-600 hover:bg-blue-700">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          {completed ? '已完成' : '完成'}
        </Button>
      </div>
    </div>
  );
}
