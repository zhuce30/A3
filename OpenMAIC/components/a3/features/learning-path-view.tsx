'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleDot, ClipboardCheck, FlaskConical, Loader2, Lock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentDecisionEvidence } from '@/components/a3/ui/agent-decision-evidence';
import { a3GetJson, a3PatchJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3ApiResponse, LearningPath, PathItem, StudyPlan } from '@/lib/a3/learning-types';
import { buildInteractiveLabHref } from '@/lib/a3/recommendation-types';
import { A3Card, A3Pill } from '../ui/a3-card';

export function LearningPathView() {
  const [path, setPath] = useState<LearningPath | null>(null);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function loadPlanContext() {
    const result = await a3GetJson<A3ApiResponse<{ plan: StudyPlan }>>('/api/learning/study-plan/?auto=1');
    if (result.success) setPlan(result.plan);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const current = await a3GetJson<A3ApiResponse<{ path: LearningPath | null }>>('/api/learning/paths/current/');
      if (!active) return;
      if (current.success && current.path) {
        setPath(current.path);
      } else if (current.success) {
        const created = await a3PostJson<A3ApiResponse<{ path: LearningPath }>>('/api/learning/paths/generate/', { force: false });
        if (!active) return;
        if (created.success) setPath(created.path);
        else setError(created.error || '学习路径生成失败');
      } else {
        setError(current.error || '学习路径加载失败');
      }
      if (active) void loadPlanContext();
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function generate(force: boolean) {
    setSubmitting(true);
    setError('');
    const result = await a3PostJson<A3ApiResponse<{ path: LearningPath }>>('/api/learning/paths/generate/', { force });
    if (result.success) setPath(result.path);
    else setError(result.error || '学习路径生成失败');
    if (result.success) void loadPlanContext();
    setSubmitting(false);
  }

  async function complete(item: PathItem) {
    setSubmitting(true);
    setError('');
    const result = await a3PatchJson<A3ApiResponse<{ path: LearningPath }>>(`/api/learning/path-items/${item.id}/progress/`, { progress: 100 });
    if (result.success) setPath(result.path);
    else setError(result.error || '进度保存失败');
    if (result.success) void loadPlanContext();
    setSubmitting(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-slate-500">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在生成个性化路径地图
      </div>
    );
  }

  const rationale = path?.rationale;
  const todayBindings = plan?.planContext?.todayBindings ?? [];
  const currentItem = path?.items.find((item) => item.status === 'current') ?? path?.items.find((item) => item.status !== 'completed') ?? null;
  const weakPointText = rationale?.weakPoints?.length ? rationale.weakPoints.join('、') : '暂无明显薄弱点';
  const goalText = rationale?.learningGoals?.length ? rationale.learningGoals.join('、') : plan?.title || '当前课程目标';

  return (
    <div className="space-y-5">
      <A3Card>
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <div>
            <A3Pill tone="blue">个性化路径地图 · 版本 {path?.version ?? 1}</A3Pill>
            <h1 className="mt-3 text-2xl font-semibold tracking-normal">个性化路径地图</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              这不是固定目录。路径由 ProfileAgent 的画像输入、DiagnosticAgent 的诊断判断、错题记录和课程先修关系共同决定，并写回到学习计划和今日任务。
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <Summary label="当前课程" value={path?.course.title ?? plan?.course.title ?? '--'} />
              <Summary label="当前节点" value={currentItem?.knowledgePoint.title ?? plan?.planContext?.learningPath.currentItem?.title ?? '待生成'} />
              <Summary label="路径进度" value={`${path?.progress ?? 0}%`} />
            </div>
          </div>
          <AgentDecisionEvidence
            compact
            title="路径生成证据"
            items={[
              {
                agent: 'ProfileAgent',
                input: `基础 ${rationale?.foundationLevel ?? plan?.explanation?.profileSignals.foundationLevel ?? '--'}，每日 ${rationale?.dailyStudyTime ?? plan?.dailyMinutes ?? 0} 分钟，目标 ${goalText}`,
                output: `学习节奏 ${rationale?.pace ?? plan?.explanation?.profileSignals.pace ?? 'standard'}`,
                evidence: `画像薄弱点：${weakPointText}`,
              },
              {
                agent: 'DiagnosticAgent',
                input: `诊断等级 ${plan?.level.label ?? '--'}，错题压力 ${plan?.level.wrongPressure ?? 0}`,
                output: `优先处理 ${weakPointText}`,
                evidence: plan?.explanation?.weakPointPolicy.reason ?? '来自诊断、错题和掌握度记录',
              },
              {
                agent: 'PlannerAgent',
                input: `路径节点 ${path?.items.length ?? 0} 个，今日绑定 ${todayBindings.length} 个任务`,
                output: `当前节点写入周期计划：${plan?.planContext?.learningPath.currentItem?.title ?? currentItem?.knowledgePoint.title ?? '--'}`,
                evidence: plan?.planContext?.schemaVersion ?? 'a3.study-plan-context.v1',
              },
            ]}
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => generate(true)} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
            {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
            根据最新画像重排
          </Button>
          <Button asChild variant="outline">
            <Link href="/a3/study-plan">查看规划中枢</Link>
          </Button>
        </div>
      </A3Card>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <A3Card title="路径节点" subtitle={path ? `总体完成 ${path.progress}% · 共 ${path.items.length} 个节点` : undefined}>
          <div className="space-y-1">
            {path?.items.map((item, index) => (
              <PathNode
                key={item.id}
                item={item}
                last={index === path.items.length - 1}
                disabled={submitting}
                binding={todayBindings.find((binding) => binding.pathItemId === item.id || binding.knowledgePointId === item.knowledgePoint.id)}
                rationale={rationale}
                onComplete={() => complete(item)}
              />
            ))}
            {!path?.items.length && <div className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-500">暂无路径节点，请先完成画像输入或入学诊断。</div>}
          </div>
        </A3Card>

        <div className="space-y-5">
          <A3Card title="路径依据">
            <div className="space-y-3 text-sm text-slate-600">
              <Basis label="规划策略" value={path?.rationale.strategy || '先修关系优先，薄弱点提前'} />
              <Basis label="基础水平" value={path?.rationale.foundationLevel || plan?.level.label || '未诊断'} />
              <Basis label="学习节奏" value={path?.rationale.pace || plan?.explanation?.profileSignals.pace || 'standard'} />
              <Basis label="每日时长" value={`${path?.rationale.dailyStudyTime || plan?.dailyMinutes || 60} 分钟`} />
            </div>
          </A3Card>
          <A3Card title="计划联动" subtitle="路径节点会被 StudyPlanAgent 排入周期计划，今日学习完成后写回路径、错题和报告。">
            <div className="space-y-3" data-testid="a3-learning-path-plan-linkage">
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                当前计划：{plan?.durationDays ?? '--'} 天 / 目标 {plan?.targetDate ?? '--'} / 计划进度 {plan?.overallProgress ?? 0}%
              </div>
              {todayBindings.slice(0, 3).map((binding) => (
                <div key={binding.taskId} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="text-sm font-semibold text-slate-900">{binding.title}</div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">
                    {binding.chapter ?? '复习/资源任务'} · 路径进度 {binding.pathProgress}% · {binding.writeback}
                  </div>
                </div>
              ))}
              {!todayBindings.length && <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">暂无今日绑定任务，生成学习计划后会在这里显示。</div>}
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
                  <Link href="/a3/today">执行今日任务</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/a3/study-plan">查看周期计划</Link>
                </Button>
              </div>
            </div>
          </A3Card>
        </div>
      </div>
    </div>
  );
}

function PathNode({
  item,
  last,
  disabled,
  binding,
  rationale,
  onComplete,
}: {
  item: PathItem;
  last: boolean;
  disabled: boolean;
  binding?: NonNullable<StudyPlan['planContext']>['todayBindings'][number];
  rationale?: LearningPath['rationale'];
  onComplete: () => void;
}) {
  const state = item.status === 'completed' ? '已完成' : item.status === 'current' ? '进行中' : '待解锁';
  const tone = item.status === 'completed' ? 'green' : item.status === 'current' ? 'blue' : 'slate';
  const evidence = [
    item.reason,
    rationale?.weakPoints?.length ? `薄弱点：${rationale.weakPoints.slice(0, 2).join('、')}` : '',
    binding ? `今日任务：${binding.title}` : '',
  ].filter(Boolean);

  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-slate-100">
          {item.status === 'completed' ? <CheckCircle2 className="size-5 text-emerald-600" /> : item.status === 'current' ? <CircleDot className="size-5 text-blue-600" /> : <Lock className="size-5 text-slate-400" />}
        </div>
        {!last && <div className="min-h-10 w-px flex-1 bg-slate-200" />}
      </div>
      <div className="mb-4 flex-1 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-semibold">{item.knowledgePoint.title}</div>
            <div className="mt-1 text-xs text-slate-500">
              第 {item.knowledgePoint.chapter.order} 章 · {item.knowledgePoint.chapter.title} · {item.estimatedMinutes} 分钟
            </div>
          </div>
          <A3Pill tone={tone}>{state}</A3Pill>
        </div>
        <div data-testid="a3-learning-path-node-evidence" className="mt-3 rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-900">
          <div className="font-semibold">为什么排在这里</div>
          <div className="mt-1">{evidence.join('；') || '依据课程先修关系和当前学习进度排序。'}</div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {item.status === 'current' && (
            <>
              <Button size="sm" onClick={onComplete} disabled={disabled} className="bg-blue-600 hover:bg-blue-700">
                完成当前节点
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/a3/classroom">
                  <ClipboardCheck className="mr-2 size-4" />
                  去 AI 课堂
                </Link>
              </Button>
            </>
          )}
          {item.status === 'completed' && (
            <Button asChild size="sm" variant="outline">
              <Link href="/a3/wrong-notebook">进入复习队列</Link>
            </Button>
          )}
          {item.status === 'locked' && (
            <Button asChild size="sm" variant="outline">
              <Link href="/a3/study-plan">
                完成前置节点
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          )}
          {item.relatedLab && (
            <Button asChild size="sm" className="bg-emerald-800 text-white hover:bg-emerald-700">
              <Link href={buildInteractiveLabHref(item.relatedLab)}>
                <FlaskConical className="size-4" />
                {item.relatedLab.label}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-slate-900" title={value}>
        {value}
      </div>
    </div>
  );
}

function Basis({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <span className="font-medium text-slate-800">{label}：</span>
      {value}
    </div>
  );
}
