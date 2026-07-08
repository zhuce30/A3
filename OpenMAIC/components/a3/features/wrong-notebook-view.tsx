'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BookMarked, CheckCircle2, ChevronDown, ChevronUp, Loader2, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { WrongQuestion, WrongReviewSummary, WrongRetryFeedback } from '@/lib/a3/assessment-types';
import { getReviewStatusMeta } from '@/lib/a3/review-status';
import type { A3ApiResponse } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type RetryResult = {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
  wrongQuestion: WrongQuestion;
} & WrongRetryFeedback;

type WrongQuestionsResponse = {
  wrongQuestions: WrongQuestion[];
  reviewSummary: WrongReviewSummary;
};

export function WrongNotebookView() {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<WrongQuestion[]>([]);
  const [reviewSummary, setReviewSummary] = useState<WrongReviewSummary | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, RetryResult>>({});
  const [focusedReviewId, setFocusedReviewId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState('');
  const [error, setError] = useState('');
  const reportSource = searchParams.get('source') === 'report';
  const reportFocus = searchParams.get('focus')?.trim();
  const reportPeriod = searchParams.get('period')?.trim();

  useEffect(() => {
    let active = true;
    void a3GetJson<A3ApiResponse<WrongQuestionsResponse>>('/api/assessments/wrong-questions/').then((result) => {
      if (!active) return;
      if (result.success) {
        setItems(result.wrongQuestions);
        setReviewSummary(result.reviewSummary);
      } else {
        setError(result.error || '错题加载失败');
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function retry(item: WrongQuestion) {
    const answer = selected[item.id];
    if (!answer) return;
    setSubmitting(item.id);
    setError('');
    const result = await a3PostJson<A3ApiResponse<RetryResult>>(`/api/assessments/wrong-questions/${item.id}/retry/`, { selectedAnswer: answer });
    if (result.success) {
      setResults((current) => ({ ...current, [item.id]: result }));
      setItems((current) => current.map((entry) => (entry.id === item.id ? result.wrongQuestion : entry)));
      setReviewSummary((current) => current ? {
        ...current,
        activeCount: Math.max(0, current.activeCount + (result.wrongQuestion.mastered ? -1 : 0)),
        masteredCount: current.masteredCount + (result.wrongQuestion.mastered ? 1 : 0),
      } : current);
    } else {
      setError(result.error || '重练提交失败');
    }
    setSubmitting('');
  }

  function focusReviewItem(itemId: string) {
    setExpanded(itemId);
    setFocusedReviewId(itemId);
    window.requestAnimationFrame(() => {
      document.getElementById(`wrong-review-${itemId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在加载错题本
      </div>
    );
  }

  const activeCount = items.filter((item) => !item.mastered).length;
  const masteredCount = items.filter((item) => item.mastered).length;
  const dueItems = sortWrongItems(items.filter(isDueForReview));
  const upcomingItems = sortWrongItems(items.filter((item) => !item.mastered && !isDueForReview(item)));
  const visibleItems = sortWrongItems(items);

  return (
    <div className="space-y-5" data-testid="a3-wrong-notebook-view">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">错题本</h1>
          <p className="mt-1 text-sm text-slate-500">错题来自真实测评记录，连续答对两次后完成巩固。</p>
        </div>
        <Button asChild>
          <Link href="/a3/assessment">
            <RefreshCcw className="mr-2 size-4" />
            进入阶段测评
          </Link>
        </Button>
      </div>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      {reportSource && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          来自学习报告钻取：正在按{reportFocus ? `「${reportFocus}」` : '能力雷达'}排查错题复盘线索
          {reportPeriod ? `，范围 ${reportPeriodLabel(reportPeriod)}` : ''}。
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Summary value={reviewSummary?.todayCount ?? activeCount} label="今日复习" tone="orange" />
        <Summary value={masteredCount} label="已掌握" tone="green" />
        <Summary value={reviewSummary?.overdueCount ?? 0} label="逾期复习" tone="slate" />
      </div>

      {reviewSummary && (
        <A3Card title="复习节奏" subtitle={reviewSummary.nextAction.reason} action={<A3Pill tone={reviewSummary.todayCount ? 'orange' : 'green'}>{reviewSummary.todayCount ? '需要处理' : '节奏正常'}</A3Pill>}>
          <div className="grid gap-3 md:grid-cols-3">
            <ScheduleMetric label="待巩固" value={reviewSummary.activeCount} />
            <ScheduleMetric label="今日到期" value={reviewSummary.todayCount} />
            <ScheduleMetric label="后续复习" value={reviewSummary.upcomingCount} />
          </div>
          <Button asChild className="mt-4">
            <Link href={reviewSummary.nextAction.href}>{reviewSummary.nextAction.label}</Link>
          </Button>
        </A3Card>
      )}

      {dueItems.length > 0 && (
        <A3Card
          title="今日待复盘"
          subtitle={`优先处理 ${dueItems.length} 道到期错题，完成后再进入新内容。`}
          action={<A3Pill tone={reviewSummary?.overdueCount ? 'red' : 'orange'}>{reviewSummary?.overdueCount ? '有逾期' : '今日到期'}</A3Pill>}
        >
          <div data-testid="a3-wrong-due-review-panel" className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {uniqueKnowledgePoints(dueItems).map((point) => (
                <span key={point} className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                  {point}
                </span>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {dueItems.slice(0, 4).map((item) => {
                const status = getReviewStatusMeta(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => focusReviewItem(item.id)}
                    className="rounded-xl border border-orange-200 bg-orange-50/70 p-4 text-left transition-colors hover:border-orange-300 hover:bg-orange-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-950">{item.question.knowledgePoint.title}</div>
                        <div className="mt-1 text-xs text-slate-600">{status.description}</div>
                      </div>
                      <A3Pill tone={status.tone}>{status.label}</A3Pill>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-700">{item.question.stem}</p>
                    <div className="mt-2 text-xs font-medium text-orange-700">查看并重练</div>
                  </button>
                );
              })}
            </div>
          </div>
        </A3Card>
      )}

      <A3Card title="今日复习队列" subtitle="优先处理逾期和今天到期的错题。">
        {items.length === 0 ? (
          <div className="py-14 text-center">
            <CheckCircle2 className="mx-auto size-11 text-emerald-600" />
            <h2 className="mt-4 font-semibold text-slate-900">当前没有待巩固错题</h2>
            <p className="mt-2 text-sm text-slate-500">完成阶段测评后，答错题目会自动出现在这里。</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {(dueItems.length ? dueItems : visibleItems).map((item) => {
              const isOpen = expanded === item.id;
              const result = results[item.id];
              const status = getReviewStatusMeta(item);
              return (
                <div
                  key={item.id}
                  id={`wrong-review-${item.id}`}
                  data-testid="a3-wrong-question-item"
                  data-focused-review={focusedReviewId === item.id ? 'true' : undefined}
                  className={`py-5 first:pt-0 last:pb-0 ${focusedReviewId === item.id ? 'rounded-xl bg-orange-50/80 px-4 ring-1 ring-orange-200' : ''}`}
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-slate-950">{item.question.knowledgePoint.title}</h3>
                        <A3Pill tone={status.tone}>{status.label}</A3Pill>
                        <A3Pill tone={item.mastered ? 'green' : 'red'}>{item.mastered ? '已掌握' : `错误 ${item.wrongCount} 次`}</A3Pill>
                      </div>
                      <p className="mt-2 max-w-[75ch] text-sm leading-6 text-slate-600">{item.question.stem}</p>
                      <p className="mt-1 text-xs text-slate-500">{status.description} 下次复习：{formatReviewTime(item.reviewAfter)}</p>
                      <p className="mt-1 text-xs text-orange-700">错因：{item.errorCause || '待进一步分析'}</p>
                    </div>
                    <Button size="sm" variant="outline" data-testid="a3-wrong-question-expand" onClick={() => setExpanded(isOpen ? null : item.id)}>
                      <BookMarked className="mr-2 size-4" />
                      {isOpen ? '收起' : '查看并重练'}
                      {isOpen ? <ChevronUp className="ml-2 size-4" /> : <ChevronDown className="ml-2 size-4" />}
                    </Button>
                  </div>

                  {isOpen && (
                    <div className="mt-5 rounded-lg bg-slate-50 p-4">
                      <div className="grid gap-2 md:grid-cols-2">
                        {item.question.options.map((option) => {
                          const chosen = selected[item.id] === option.key;
                          const correct = result?.correctAnswer === option.key;
                          return (
                            <button
                              type="button"
                              key={option.key}
                              data-testid="a3-wrong-option"
                              disabled={Boolean(result)}
                              onClick={() => setSelected((current) => ({ ...current, [item.id]: option.key }))}
                              className={`rounded-lg border px-3 py-3 text-left text-sm ${correct ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : chosen ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300'}`}
                            >
                              <span className="mr-2 text-slate-400">{option.key}.</span>
                              {option.text}
                            </button>
                          );
                        })}
                      </div>
                      {result && (
                        <div
                          data-testid="a3-wrong-retry-result"
                          className={`mt-4 rounded-lg p-3 text-sm ${result.isCorrect ? 'bg-emerald-100 text-emerald-900' : 'bg-orange-100 text-orange-900'}`}
                        >
                          <div className="font-semibold">
                            {result.isCorrect ? `回答正确，连续答对 ${result.wrongQuestion.consecutiveCorrect}/2 次` : `回答错误，正确答案为 ${result.correctAnswer}`}
                          </div>
                          <p className="mt-1 leading-6">{result.explanation}</p>
                          {result.retryFeedback && (
                            <div className="mt-3 rounded-lg bg-white/85 p-3 text-slate-700" data-testid="a3-wrong-retry-feedback">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <div className="font-semibold text-slate-950">{result.retryFeedback.headline}</div>
                                  <div className="mt-1 text-xs leading-5 text-slate-600">{result.retryFeedback.reviewPlan}</div>
                                </div>
                                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                                  {result.retryFeedback.reward.label} {result.retryFeedback.reward.value}
                                </span>
                              </div>
                              <div className="mt-3 grid gap-2 md:grid-cols-3">
                                {result.retryFeedback.motivators.map((motivator) => (
                                  <MiniMetric key={`${motivator.label}-${motivator.detail}`} label={motivator.label} value={motivator.detail} />
                                ))}
                              </div>
                              <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                                <span className="font-semibold text-slate-800">错因变化：</span>
                                {result.retryFeedback.errorCauseChange}
                              </div>
                              <div className="mt-2 text-xs text-slate-500" data-testid="a3-wrong-next-review">
                                下次复习：{formatReviewTime(result.retryFeedback.nextReviewAt)}
                              </div>
                            </div>
                          )}
                          {result.nextAction && (
                            <div className="mt-3 rounded-lg bg-white/80 p-3 text-slate-700" data-testid="a3-wrong-next-action">
                              <div className="font-semibold text-slate-900">{result.nextAction.label}</div>
                              <div className="mt-1 text-xs leading-5">{result.nextAction.reason}</div>
                              <Button asChild size="sm" variant="outline" className="mt-3 bg-white">
                                <Link href={result.nextAction.href}>执行下一步</Link>
                              </Button>
                            </div>
                          )}
                          {result.studyPlan && (
                            <div className="mt-3 rounded-lg bg-white/80 p-3 text-slate-700" data-testid="a3-wrong-study-plan-sync">
                              <div className="font-semibold text-slate-900">计划已刷新</div>
                              <div className="mt-1 text-xs leading-5">
                                今日计划：{result.studyPlan.days[0]?.focus ?? result.studyPlan.title} · {result.studyPlan.days[0]?.estimatedMinutes ?? result.studyPlan.dailyMinutes} 分钟
                              </div>
                            </div>
                          )}
                          {result.report && (
                            <div className="mt-3 grid gap-2 text-xs text-slate-700 md:grid-cols-3" data-testid="a3-wrong-report-sync">
                              <MiniMetric label="正确率" value={`${result.report.metrics.accuracy}%`} />
                              <MiniMetric label="活跃错题" value={`${result.report.metrics.activeWrongQuestions}`} />
                              <MiniMetric label="已掌握错题" value={`${result.report.metrics.masteredWrongQuestions}`} />
                            </div>
                          )}
                          <div className="mt-3 rounded-lg bg-white/80 p-3 text-slate-700" data-testid="a3-wrong-loop-evidence">
                            <div className="font-semibold text-slate-900">本次重练写回</div>
                            <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                              <MiniMetric label="复习队列" value={result.retryFeedback?.masteryStatus === 'mastered' ? '移出或降权' : '继续保留'} />
                              <MiniMetric label="下次复习" value={formatReviewTime(result.retryFeedback?.nextReviewAt ?? result.wrongQuestion.reviewAfter)} />
                              <MiniMetric label="学习计划" value={result.studyPlan ? '已刷新' : '按需刷新'} />
                              <MiniMetric label="报告指标" value={result.report ? '已返回' : '打开报告实时计算'} />
                            </div>
                            {result.nextAction && (
                              <div className="mt-2 text-xs leading-5 text-slate-600">
                                下一步：{result.nextAction.label}，{result.nextAction.reason}
                              </div>
                            )}
                          </div>
                          {!result.wrongQuestion.mastered && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-3 bg-white"
                              onClick={() => {
                                setResults((current) => {
                                  const next = { ...current };
                                  delete next[item.id];
                                  return next;
                                });
                                setSelected((current) => ({ ...current, [item.id]: '' }));
                              }}
                            >
                              再次巩固
                            </Button>
                          )}
                        </div>
                      )}
                      {!result && (
                        <div className="mt-4 flex justify-end">
                          <Button size="sm" data-testid="a3-wrong-retry-submit" onClick={() => retry(item)} disabled={!selected[item.id] || submitting === item.id}>
                            {submitting === item.id && <Loader2 className="mr-2 size-4 animate-spin" />}
                            提交重练
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </A3Card>

      {upcomingItems.length > 0 && (
        <A3Card title="后续复习" subtitle="这些错题还未到复习时间，系统会按间隔复习节奏提醒。">
          <div className="grid gap-3 md:grid-cols-2">
            {upcomingItems.slice(0, 6).map((item) => (
              <div key={item.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="font-semibold text-slate-900">{item.question.knowledgePoint.title}</div>
                  <A3Pill tone={getReviewStatusMeta(item).tone}>{getReviewStatusMeta(item).label}</A3Pill>
                </div>
                <div className="mt-1 text-xs text-slate-500">下次复习：{formatReviewTime(item.reviewAfter)}</div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">{item.question.stem}</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">{getReviewStatusMeta(item).description}</p>
              </div>
            ))}
          </div>
        </A3Card>
      )}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/80 p-2">
      <div className="font-semibold text-slate-900">{value}</div>
      <div className="mt-0.5 text-slate-500">{label}</div>
    </div>
  );
}

function isDueForReview(item: WrongQuestion) {
  if (item.mastered) return false;
  if (!item.reviewAfter) return true;
  return new Date(item.reviewAfter).getTime() <= Date.now();
}

function sortWrongItems(items: WrongQuestion[]) {
  return [...items].sort((a, b) => {
    const aDue = a.reviewAfter ? new Date(a.reviewAfter).getTime() : 0;
    const bDue = b.reviewAfter ? new Date(b.reviewAfter).getTime() : 0;
    return aDue - bDue || b.wrongCount - a.wrongCount;
  });
}

function uniqueKnowledgePoints(items: WrongQuestion[]) {
  return Array.from(new Set(items.map((item) => item.question.knowledgePoint.title).filter(Boolean)));
}

function formatReviewTime(value: string | null) {
  if (!value) return '立即复习';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function reportPeriodLabel(value: string) {
  if (value === '7d') return '近 7 天';
  if (value === '30d') return '近 30 天';
  if (value === 'term') return '本学期';
  return value;
}

function ScheduleMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <div className="text-2xl font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-sm text-slate-500">{label}</div>
    </div>
  );
}

function Summary({ value, label, tone }: { value: number; label: string; tone: 'orange' | 'green' | 'slate' }) {
  const styles = {
    orange: 'bg-orange-50 text-orange-700',
    green: 'bg-emerald-50 text-emerald-700',
    slate: 'bg-slate-100 text-slate-700',
  };
  return (
    <div className={`rounded-lg px-5 py-4 ${styles[tone]}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm opacity-80">{label}</div>
    </div>
  );
}
