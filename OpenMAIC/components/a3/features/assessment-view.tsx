'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  FileQuestion,
  FlaskConical,
  Layers3,
  Lightbulb,
  Loader2,
  RotateCcw,
  Search,
  Target,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import { trackLearningEvent, trackPageView, trackPracticeSubmit } from '@/lib/a3/learning-event-client';
import type { AnswerFeedback, AssessmentQuestion, AssessmentSession, PracticeSuggestion } from '@/lib/a3/assessment-types';
import type { A3ApiResponse } from '@/lib/a3/learning-types';
import type { A3Recommendation, RecommendationResponse } from '@/lib/a3/recommendation-types';
import { A3Pill } from '../ui/a3-card';

export function AssessmentView() {
  const searchParams = useSearchParams();
  const [session, setSession] = useState<AssessmentSession | null>(null);
  const [selected, setSelected] = useState('');
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [nextRecommendations, setNextRecommendations] = useState<RecommendationResponse | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [practicePoint, setPracticePoint] = useState('');
  const [practiceSuggestions, setPracticeSuggestions] = useState<PracticeSuggestion[]>([]);
  const reportSource = searchParams.get('source') === 'report';
  const reportLabel = searchParams.get('label')?.trim();
  const reportStart = searchParams.get('start')?.trim();
  const reportEnd = searchParams.get('end')?.trim();

  useEffect(() => {
    void trackPageView('/a3/assessment', {
      page: 'assessment',
      source: searchParams.get('source') ?? '',
      practice: searchParams.get('practice') ?? '',
    });

    let active = true;
    const practice = searchParams.get('practice')?.trim();
    const load = practice
      ? a3PostJson<A3ApiResponse<{ session: AssessmentSession; practiceSuggestions?: PracticeSuggestion[] }>>('/api/assessments/start/', {
          mode: 'practice',
          knowledgePoint: practice,
          limit: 6,
        })
      : a3GetJson<A3ApiResponse<{ session: AssessmentSession; practiceSuggestions?: PracticeSuggestion[] }>>('/api/assessments/current/');

    void load.then((result) => {
      if (!active) return;
      if (result.success) {
        setSession(result.session);
        setPracticeSuggestions(result.practiceSuggestions ?? []);
        if (practice) setPracticePoint(practice);
      } else {
        setError(result.error || '测评加载失败');
      }
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [searchParams]);

  async function submit(skipped = false) {
    if (!session || (!selected && !skipped)) return;
    const submittedQuestion = session.currentQuestion;
    setSubmitting(true);
    setError('');
    setNextRecommendations(null);

    const result = await a3PostJson<A3ApiResponse<AnswerFeedback>>('/api/assess/grade/', {
      sessionId: session.id,
      selectedAnswer: selected,
      skipped,
    });

    if (result.success) {
      setFeedback(result);
      void trackAssessmentSubmitEvents(session, submittedQuestion, result, selected, skipped);
      const weakPoints = result.profileUpdate?.weakPoints ?? [];
      if (weakPoints.length) void loadNextRecommendations(weakPoints);
    } else {
      setError(result.error || '答案提交失败');
    }
    setSubmitting(false);
  }

  async function loadNextRecommendations(weakPoints: string[]) {
    setRecommendationLoading(true);
    const result = await a3PostJson<RecommendationResponse>('/api/recommend/', {
      goal: weakPoints.slice(0, 3).join(' '),
      topK: 3,
    });
    if (result.success) setNextRecommendations(result);
    setRecommendationLoading(false);
  }

  function nextQuestion() {
    if (!feedback) return;
    setSession(feedback.session);
    setFeedback(null);
    setSelected('');
    setNextRecommendations(null);
  }

  async function restart() {
    setSubmitting(true);
    setError('');
    setNextRecommendations(null);
    const result = await a3PostJson<A3ApiResponse<{ session: AssessmentSession; practiceSuggestions?: PracticeSuggestion[] }>>('/api/assessments/start/', {});
    if (result.success) {
      setSession(result.session);
      setPracticeSuggestions(result.practiceSuggestions ?? []);
      setFeedback(null);
      setSelected('');
    } else {
      setError(result.error || '无法开始新测评');
    }
    setSubmitting(false);
  }

  async function startPractice(point: string) {
    const focusPoint = point.trim();
    if (!focusPoint) return;
    setSubmitting(true);
    setError('');
    setNextRecommendations(null);
    const result = await a3PostJson<A3ApiResponse<{ session: AssessmentSession; practiceSuggestions?: PracticeSuggestion[] }>>('/api/assessments/start/', {
      mode: 'practice',
      knowledgePoint: focusPoint,
      limit: 6,
    });
    if (result.success) {
      setSession(result.session);
      setPracticeSuggestions(result.practiceSuggestions ?? []);
      setFeedback(null);
      setSelected('');
      setPracticePoint(focusPoint);
    } else {
      setError(result.error || '无法开始专项练习');
    }
    setSubmitting(false);
  }

  const quickPracticePoints = useMemo(
    () =>
      (practiceSuggestions.length
        ? practiceSuggestions.map((item) => item.knowledgePoint)
        : ['进程管理', '进程调度', '处理机调度']).slice(0, 5),
    [practiceSuggestions],
  );

  if (loading) return <LoadingState label="正在准备测评" />;

  if (!session) {
    return (
      <EmptyAssessmentState
        error={error}
        submitting={submitting}
        onRestart={restart}
      />
    );
  }

  const question = session.currentQuestion;
  const total = Math.max(session.totalQuestions || 0, 1);
  const currentQuestionNumber = Math.min(total, Math.max(1, session.currentIndex + 1));
  const positionProgress = Math.round((currentQuestionNumber * 100) / total);
  const completionProgress = Math.round((session.answeredCount * 100) / total);
  const masteredLabel = feedback
    ? feedback.isCorrect
      ? '已掌握'
      : '待巩固'
    : session.score > 0
      ? '进行中'
      : '标准题库';

  return (
    <div data-testid="a3-assessment-view" className="space-y-4">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-blue-100 bg-blue-50 text-blue-600 shadow-sm">
            <ClipboardCheck className="size-8" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">学情诊断与测评</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
              系统基于学习路径、错题本与知识图谱生成个性化测评，精准定位知识薄弱点。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 self-start lg:self-center">
          <Button asChild variant="outline" className="border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-950">
            <Link href="/a3/labs">
              <FlaskConical className="size-4" />
              交互实验
            </Link>
          </Button>
          <Button variant="outline" onClick={restart} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            重新测评
          </Button>
        </div>
      </section>

      {reportSource ? (
        <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          来自学习报告钻取：{reportLabel || '趋势数据'}
          {reportStart && reportEnd ? `，${reportStart} 至 ${reportEnd}` : ''}。继续作答后会回写报告、错题本和学习计划。
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{error}</span>
          <Button size="sm" variant="outline" className="border-rose-300 bg-white text-rose-700 hover:bg-rose-50" onClick={() => void submit()}>
            重新提交
          </Button>
        </div>
      ) : null}

      <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1fr)_400px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <main className="flex min-w-0">
          {session.status === 'completed' || !question ? (
            <CompletedPanel feedback={feedback} session={session} submitting={submitting} onRestart={restart} />
          ) : (
            <section className="flex min-h-[650px] w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm xl:min-h-[calc(100vh-230px)]">
              <div className="border-b border-slate-200 px-6 py-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="text-base font-semibold text-slate-950">
                    第 {currentQuestionNumber} 题 <span className="text-slate-400">/ 共 {total} 题</span>
                  </div>
                  <div className="h-2 min-w-32 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${positionProgress}%` }} />
                  </div>
                  <span className="w-10 text-right text-xs font-medium text-slate-500">{positionProgress}%</span>
                  <A3Pill tone="blue">难度 {question.difficulty}</A3Pill>
                  <A3Pill tone={feedback?.isCorrect ? 'green' : 'slate'}>{masteredLabel}</A3Pill>
                </div>
              </div>

              <div className="flex flex-1 flex-col px-6 py-6">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="text-blue-600">{question.knowledgePoint.chapter}</span>
                  <span className="text-slate-300">/</span>
                  <span className="text-slate-500">{question.knowledgePoint.title}</span>
                </div>
                <p data-testid="a3-assessment-question" className="mt-5 max-w-4xl text-xl font-semibold leading-8 text-slate-950">
                  {question.stem}
                </p>
                <QuestionEvidenceStrip question={question} />

                <div className="mt-8 grid gap-4 md:grid-cols-2">
                  {question.options.map((option) => {
                    const isSelected = selected === option.key;
                    const correct = feedback?.correctAnswer === option.key;
                    const wrongSelected = feedback && isSelected && !feedback.isCorrect;
                    return (
                      <button
                        data-testid="a3-assessment-option"
                        type="button"
                        key={option.key}
                        disabled={Boolean(feedback)}
                        onClick={() => setSelected(option.key)}
                        className={[
                          'flex min-h-24 items-center gap-4 rounded-xl border px-4 py-4 text-left text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                          correct
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                            : wrongSelected
                              ? 'border-rose-300 bg-rose-50 text-rose-800'
                              : isSelected
                                ? 'border-blue-500 bg-blue-50 text-blue-800'
                                : 'border-slate-200 bg-white text-slate-800 hover:border-blue-300 hover:bg-blue-50/50',
                        ].join(' ')}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-base font-semibold text-blue-600">
                          {option.key}
                        </span>
                        <span>{option.text}</span>
                      </button>
                    );
                  })}
                </div>

                {feedback ? <FeedbackPanel feedback={feedback} nextRecommendations={nextRecommendations} recommendationLoading={recommendationLoading} /> : null}

                <div className="mt-auto flex justify-end gap-3 pt-8">
                  {!feedback ? (
                    <>
                      <Button data-testid="a3-assessment-skip" variant="outline" onClick={() => submit(true)} disabled={submitting}>
                        跳过
                      </Button>
                      <Button data-testid="a3-assessment-submit" onClick={() => submit(false)} disabled={!selected || submitting} className="min-w-36 bg-blue-600 hover:bg-blue-700">
                        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                        提交答案
                      </Button>
                    </>
                  ) : (
                    <Button data-testid="a3-assessment-next-question" onClick={nextQuestion} className="min-w-36">
                      {feedback.session.status === 'completed' ? '查看结果' : '下一题'}
                    </Button>
                  )}
                </div>
              </div>
            </section>
          )}
        </main>

        <aside className="space-y-3 xl:sticky xl:top-4">
          <AssessmentSummaryCard session={session} progress={completionProgress} />
          <PracticeCard
            practicePoint={practicePoint}
            suggestions={practiceSuggestions}
            quickPoints={quickPracticePoints}
            submitting={submitting}
            onChangePracticePoint={setPracticePoint}
            onStartPractice={startPractice}
          />
          <SuggestionCard feedback={feedback} recommendations={nextRecommendations} loading={recommendationLoading} />
          <DataFlowCard />
        </aside>
      </div>
    </div>
  );
}

function trackAssessmentSubmitEvents(
  session: AssessmentSession,
  question: AssessmentQuestion | null,
  feedback: AnswerFeedback,
  selectedAnswer: string,
  skipped: boolean,
) {
  const score = skipped ? 0 : feedback.isCorrect ? 100 : 0;
  const knowledgePointId = question?.knowledgePoint.id ?? session.focus?.knowledgePoint ?? '';
  void trackLearningEvent({
    eventId: `question_${session.id}_${question?.id ?? session.currentIndex}_answered`,
    eventType: 'question_answered',
    sourcePage: '/a3/assessment',
    targetType: 'assessment_question',
    targetId: question?.id ?? '',
    knowledgePointId,
    score,
    quality: {
      isCorrect: feedback.isCorrect,
      skipped,
    },
    metadata: {
      sessionId: session.id,
      mode: session.mode ?? 'assessment',
      selectedAnswer,
      correctAnswer: feedback.correctAnswer,
      questionTitle: question?.stem ?? '',
    },
  });
  void trackPracticeSubmit({
    eventId: `practice_${session.id}_${feedback.session.answeredCount}_submitted`,
    sourcePage: '/a3/assessment',
    targetType: 'assessment_session',
    targetId: session.id,
    knowledgePointId,
    score,
    quality: {
      isCorrect: feedback.isCorrect,
      skipped,
      sessionCompleted: feedback.session.status === 'completed',
    },
    metadata: {
      mode: session.mode ?? 'assessment',
      answeredCount: feedback.session.answeredCount,
      totalQuestions: feedback.session.totalQuestions,
    },
  });
}

function AssessmentSummaryCard({ session, progress }: { session: AssessmentSession; progress: number }) {
  return (
    <Panel title="本次测评">
      {session.mode === 'practice' && session.focus?.knowledgePoint ? (
        <div data-testid="a3-assessment-practice-focus" className="mb-3 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          专项练习：{session.focus.knowledgePoint}
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        <Metric icon={Target} value={`${session.score}`} label="当前得分" />
        <Metric icon={FileQuestion} value={`${session.totalQuestions}`} label="题目数" />
        <Metric icon={Clock} value={`${session.answeredCount}`} label="已作答" />
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-2 text-right text-xs font-medium text-slate-500">完成 {progress}%</div>
    </Panel>
  );
}

function PracticeCard({
  practicePoint,
  suggestions,
  quickPoints,
  submitting,
  onChangePracticePoint,
  onStartPractice,
}: {
  practicePoint: string;
  suggestions: PracticeSuggestion[];
  quickPoints: string[];
  submitting: boolean;
  onChangePracticePoint: (value: string) => void;
  onStartPractice: (value: string) => void;
}) {
  return (
    <Panel title="专项练习">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <input
          data-testid="a3-assessment-practice-input"
          value={practicePoint}
          onChange={(event) => onChangePracticePoint(event.target.value)}
          placeholder="搜索知识点或专题"
          className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-400"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {quickPoints.map((point) => (
          <button
            key={point}
            type="button"
            onClick={() => onChangePracticePoint(point)}
            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-blue-300 hover:bg-blue-50"
          >
            {point}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {(suggestions.length ? suggestions : fallbackSuggestions).slice(0, 3).map((item) => (
          <button
            data-testid="a3-assessment-practice-suggestion"
            key={item.knowledgePoint}
            type="button"
            onClick={() => onStartPractice(item.knowledgePoint)}
            className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-blue-300 hover:bg-blue-50/50"
          >
            <BookOpen className="size-4 shrink-0 text-blue-600" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-slate-900">{item.knowledgePoint}</span>
              <span className="block truncate text-xs text-slate-500">{item.reason}</span>
            </span>
            <A3Pill tone={item.wrongCount ? 'orange' : 'green'}>{item.wrongCount ? '薄弱' : '推荐'}</A3Pill>
            <ChevronRight className="size-4 shrink-0 text-slate-400" />
          </button>
        ))}
      </div>
      <Button data-testid="a3-assessment-practice-start" onClick={() => onStartPractice(practicePoint || '处理机调度算法')} disabled={submitting} className="mt-3 w-full bg-blue-600 hover:bg-blue-700">
        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
        开始专项练习
      </Button>
    </Panel>
  );
}

function FeedbackPanel({
  feedback,
  nextRecommendations,
  recommendationLoading,
}: {
  feedback: AnswerFeedback;
  nextRecommendations: RecommendationResponse | null;
  recommendationLoading: boolean;
}) {
  return (
    <div
      data-testid="a3-assessment-feedback"
      className={`mt-6 rounded-2xl border p-4 ${feedback.isCorrect ? 'border-emerald-200 bg-emerald-50' : 'border-orange-200 bg-orange-50'}`}
    >
      <div className="flex items-center gap-2 font-semibold text-slate-950">
        {feedback.isCorrect ? <CheckCircle2 className="size-5 text-emerald-600" /> : <XCircle className="size-5 text-orange-600" />}
        {feedback.isCorrect ? '回答正确' : `回答错误，正确答案为 ${feedback.correctAnswer}`}
      </div>
      <p data-testid="a3-assessment-explanation" className="mt-2 text-sm leading-6 text-slate-700">{feedback.explanation}</p>
      {feedback.errorCause ? <p data-testid="a3-assessment-error-cause" className="mt-2 text-sm text-orange-800">错因提示：{feedback.errorCause}</p> : null}

      {feedback.profileUpdate?.weakPoints?.length ? (
        <div data-testid="a3-assessment-profile-sync" className="mt-3 rounded-xl bg-white/80 p-3 text-sm leading-6 text-slate-700">
          <div className="font-semibold text-slate-900">画像薄弱点已同步</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {feedback.profileUpdate.weakPoints.slice(0, 6).map((item) => (
              <A3Pill key={item} tone="orange">{item}</A3Pill>
            ))}
          </div>
        </div>
      ) : null}

      {feedback.studyPlan ? (
        <div data-testid="a3-assessment-plan-sync" className="mt-3 rounded-xl bg-white/80 p-3 text-sm leading-6 text-slate-700">
          <div className="font-semibold text-slate-900">学习计划已自动刷新</div>
          <div className="mt-1 text-slate-600">
            今日重点：{feedback.studyPlan.days[0]?.focus ?? feedback.studyPlan.title}，{feedback.studyPlan.days[0]?.estimatedMinutes ?? feedback.studyPlan.dailyMinutes} 分钟
          </div>
          <Button asChild size="sm" variant="outline" className="mt-3">
            <Link href="/a3/study-plan">查看新计划</Link>
          </Button>
        </div>
      ) : null}

      <LoopEvidencePanel feedback={feedback} nextRecommendations={nextRecommendations} recommendationLoading={recommendationLoading} />
    </div>
  );
}

function LoopEvidencePanel({
  feedback,
  nextRecommendations,
  recommendationLoading,
}: {
  feedback: AnswerFeedback;
  nextRecommendations: RecommendationResponse | null;
  recommendationLoading: boolean;
}) {
  return (
    <div data-testid="a3-assessment-loop-evidence" className="mt-3 rounded-xl bg-white/80 p-3 text-xs leading-5 text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-slate-900">本题写回去向</div>
        {feedback.loopEvidence ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{feedback.loopEvidence.schemaVersion}</span> : null}
      </div>
      {feedback.loopEvidence ? (
        <>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {feedback.loopEvidence.writeBacks.map((item) => (
              <LoopEvidenceItem
                key={`${item.target}-${item.status}`}
                label={formatLoopTarget(item.target)}
                status={formatLoopStatus(item.status)}
                detail={item.summary}
              />
            ))}
          </div>
          <div className="mt-2 text-slate-600">下一步：{feedback.loopEvidence.nextAction.label}</div>
        </>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <LoopEvidenceItem label="错题本" status={feedback.isCorrect ? '未新增' : '已加入'} detail={feedback.isCorrect ? '本题正确，不新增错题记录。' : feedback.errorCause || '答错题目已进入错题本。'} />
          <LoopEvidenceItem label="学习画像" status={feedback.profileUpdate?.weakPoints?.length ? '已更新' : '已检查'} detail={feedback.profileUpdate?.weakPoints?.slice(0, 3).join('、') || '本题没有新增薄弱点。'} />
          <LoopEvidenceItem label="学习计划" status={feedback.studyPlan ? '已刷新' : '按需刷新'} detail={feedback.studyPlan?.days[0]?.focus ?? '计划会在下一次获取时读取最新测评结果。'} />
          <LoopEvidenceItem label="推荐资源" status={nextRecommendations?.recommendations?.length ? '已刷新' : recommendationLoading ? '刷新中' : '等待信号'} detail={nextRecommendations?.query || '出现薄弱点后会调用推荐接口生成下一步资源。'} />
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  feedback,
  recommendations,
  loading,
}: {
  feedback: AnswerFeedback | null;
  recommendations: RecommendationResponse | null;
  loading: boolean;
}) {
  const items = recommendations?.recommendations ?? [];
  return (
    <Panel title="学习建议">
      {loading ? (
        <CompactHint icon={Loader2} title="正在刷新建议" detail="根据本题表现生成下一步资源。" spin />
      ) : items.length ? (
        <div className="space-y-2">
          {items.slice(0, 3).map((item) => <RecommendationMiniRow key={item.id} item={item} />)}
        </div>
      ) : (
        <div className="space-y-2">
          <CompactHint icon={Lightbulb} title="复习核心概念" detail={feedback?.errorCause || '优先巩固当前章节的定义、条件和适用场景。'} />
          <CompactHint icon={BarChart3} title="加强专项练习" detail="完成本节测评后，可进入薄弱知识点练习。" />
          <CompactHint icon={CheckCircle2} title="完成后看报告" detail="测评结果会同步到学习报告和错题本。" />
        </div>
      )}
      {recommendations?.query ? <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">推荐查询：{recommendations.query}</div> : null}
    </Panel>
  );
}

function DataFlowCard() {
  return (
    <Panel title="学习数据">
      <div className="space-y-2">
        <CompactHint icon={XCircle} title="错题自动入本" detail="答错题目会进入错题本，方便针对性复习。" tone="red" />
        <CompactHint icon={BarChart3} title="报告同步更新" detail="测评得分会同步到学习看板，追踪学习成长。" tone="blue" />
        <CompactHint icon={Layers3} title="推荐自动刷新" detail="系统会根据学习表现更新个性化学习推荐。" tone="green" />
      </div>
    </Panel>
  );
}

function CompletedPanel({
  feedback,
  session,
  submitting,
  onRestart,
}: {
  feedback: AnswerFeedback | null;
  session: AssessmentSession;
  submitting: boolean;
  onRestart: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
      <h2 className="mt-4 text-xl font-semibold text-slate-950">本次测评已完成</h2>
      <p className="mt-2 text-sm text-slate-500">诊断得分 {session.score} 分，答案已计入学习报告。</p>
      {feedback?.report ? (
        <div className="mx-auto mt-5 grid max-w-xl gap-3 rounded-xl bg-slate-50 p-4 text-left md:grid-cols-3">
          <ReportMetric label="正确率" value={`${feedback.report.metrics.accuracy}%`} />
          <ReportMetric label="活跃错题" value={`${feedback.report.metrics.activeWrongQuestions}`} />
          <ReportMetric label="路径进度" value={`${feedback.report.metrics.pathProgress}%`} />
        </div>
      ) : null}
      <div className="mt-6 flex justify-center gap-3">
        <Button data-testid="a3-assessment-restart" onClick={onRestart} disabled={submitting}>
          <RotateCcw className="size-4" />
          重新测评
        </Button>
        <Button asChild variant="outline">
          <Link data-testid="a3-assessment-wrong-notebook" href="/a3/wrong-notebook">查看错题本</Link>
        </Button>
      </div>
      {feedback?.nextAction ? (
        <div className="mx-auto mt-5 max-w-xl rounded-xl border border-blue-100 bg-blue-50 p-4 text-left text-sm text-blue-800">
          <div className="font-semibold">{feedback.nextAction.label}</div>
          <div className="mt-1">{feedback.nextAction.reason}</div>
          <Button asChild size="sm" className="mt-3">
            <Link href={feedback.nextAction.href}>执行下一步</Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function EmptyAssessmentState({ error, submitting, onRestart }: { error: string; submitting: boolean; onRestart: () => void }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <FileQuestion className="mx-auto size-12 text-slate-300" />
      <p className="mt-4 text-sm font-semibold text-slate-950">{error ? '测评启动失败' : '暂无可用测评'}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
        {error || '完成入学诊断或学习路径后，系统会根据当前节点生成诊断题目。'}
      </p>
      <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
        <Button onClick={onRestart} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {error ? '重新尝试' : '开始测评'}
        </Button>
        <Button asChild variant="outline">
          <Link href="/a3/admission-diagnostic">入学诊断</Link>
        </Button>
        <Button asChild variant="outline" className="border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-950">
          <Link href="/a3/labs">
            <FlaskConical className="size-4" />
            交互实验
          </Link>
        </Button>
      </div>
    </section>
  );
}

function QuestionEvidenceStrip({ question }: { question: AssessmentQuestion }) {
  const evidence = question.evidence ?? [];
  const primary = evidence[0];
  const source = question.source;
  const personalization = question.personalization;
  const profileSignals = personalization?.profileSignals;
  const weakPoints = profileSignals?.weakPoints ?? [];
  const recentErrorCauses = profileSignals?.recentErrorCauses ?? [];
  const sourceEvidence = personalization?.sourceEvidence ?? [];
  if (!primary && !source && !personalization) return null;
  return (
    <div data-testid="a3-assessment-question-source" className="mt-5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-500">题目来源</div>
          <div className="mt-1 text-sm font-semibold text-slate-950">
            {source?.resourceTitle || primary?.resourceTitle || getQuestionSourceLabel(source?.type)}
            {primary?.pageNumber ? `，第 ${primary.pageNumber} 页` : ''}
          </div>
          {primary?.quote ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{primary.quote}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {source ? <A3Pill tone={source.reviewStatus === 'approved' ? 'green' : 'orange'}>{getQuestionReviewLabel(source.reviewStatus)}</A3Pill> : null}
          {source ? <A3Pill tone={source.type === 'personal_generated' ? 'violet' : 'slate'}>{getQuestionSourceLabel(source.type)}</A3Pill> : null}
          {personalization?.questionKind ? <A3Pill tone="violet">{getQuestionKindLabel(personalization.questionKind)}</A3Pill> : null}
          {primary?.previewUrl ? <img src={resolveA3Endpoint(primary.previewUrl)} alt="" className="h-14 w-20 shrink-0 rounded-lg border border-slate-200 object-cover" /> : null}
        </div>
      </div>
      {personalization ? (
        <div data-testid="a3-assessment-personalization" className="mt-3 rounded-lg border border-blue-100 bg-white px-3 py-3 text-xs leading-5 text-slate-600">
          <div className="font-semibold text-slate-900">为什么给你出这题</div>
          {personalization.generationReason ? <p className="mt-1">{personalization.generationReason}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {personalization.generationMode === 'grounded_llm' ? <A3Pill tone="green">证据约束模型生成</A3Pill> : null}
            {personalization.reasoningForm ? <A3Pill tone="violet">推理：{getReasoningFormLabel(personalization.reasoningForm)}</A3Pill> : null}
            {personalization.variantIndex ? <A3Pill tone="violet">变式版本：#{personalization.variantIndex}</A3Pill> : null}
            {personalization.variantContext?.scenario ? <A3Pill tone="slate">场景：{personalization.variantContext.scenario}</A3Pill> : null}
            {personalization.variantContext?.parameter ? <A3Pill tone="slate">参数：{personalization.variantContext.parameter}</A3Pill> : null}
            {personalization.foundationLevel ? <A3Pill tone="blue">基础：{personalization.foundationLevel}</A3Pill> : null}
            {weakPoints.slice(0, 3).map((item) => (
              <A3Pill key={`weak-${item}`} tone="orange">薄弱点：{item}</A3Pill>
            ))}
            {recentErrorCauses.slice(0, 2).map((item) => (
              <A3Pill key={`cause-${item}`} tone="red">错因：{item}</A3Pill>
            ))}
            {sourceEvidence[0]?.resourceTitle ? <A3Pill tone="green">来源：{sourceEvidence[0].resourceTitle}</A3Pill> : null}
          </div>
        </div>
      ) : null}
      {source?.reviewStatus === 'auto_verified' ? (
        <div className="mt-2 text-xs text-orange-700">这道题来自自动验证的个人练习题，不会用于正式测评。</div>
      ) : null}
    </div>
  );
}

function getReasoningFormLabel(value: string) {
  return ({
    concept_boundary: '概念边界',
    parameter_change: '参数变化',
    scenario_transfer: '场景迁移',
    judgement_and_correction: '判断纠错',
    error_diagnosis: '错因诊断',
    evidence_application: '证据应用',
  } as Record<string, string>)[value] ?? value;
}

function getQuestionKindLabel(kind = '') {
  return {
    concept: '概念辨析',
    scenario: '场景题',
    judgement_correction: '判断纠错',
    application: '应用题',
    wrong_variant: '错题变式',
  }[kind] ?? '个性化题';
}

function RecommendationMiniRow({ item }: { item: A3Recommendation }) {
  return (
    <Link href={item.href || '/a3/recommendations'} className="block rounded-xl border border-slate-200 bg-white p-3 transition hover:border-blue-300 hover:bg-blue-50/40">
      <div className="flex items-center justify-between gap-3">
        <A3Pill tone="blue">{item.type}</A3Pill>
        <span className="text-xs font-semibold text-blue-700">{String(item.score)}</span>
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-semibold text-slate-900">{item.title}</div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{item.reason}</p>
      <div className="mt-2 inline-flex items-center text-xs font-medium text-blue-700">
        打开资源
        <ArrowRight className="ml-1 size-3" />
      </div>
    </Link>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-950">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Metric({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-center">
      <Icon className="mx-auto size-5 text-blue-600" />
      <div className="mt-2 text-xl font-semibold text-slate-950">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function CompactHint({
  icon: Icon,
  title,
  detail,
  tone = 'blue',
  spin = false,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  tone?: 'blue' | 'green' | 'red';
  spin?: boolean;
}) {
  const toneClass = {
    blue: 'text-blue-600 bg-blue-50',
    green: 'text-emerald-600 bg-emerald-50',
    red: 'text-rose-600 bg-rose-50',
  }[tone];
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${toneClass}`}>
        <Icon className={`size-4 ${spin ? 'animate-spin' : ''}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-900">{title}</span>
        <span className="block truncate text-xs text-slate-500">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-slate-400" />
    </div>
  );
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function LoopEvidenceItem({ label, status, detail }: { label: string; status: string; detail: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-900">{label}</span>
        <span className="rounded-full bg-white px-2 py-0.5 text-slate-600">{status}</span>
      </div>
      <div className="mt-1 text-slate-600">{detail}</div>
    </div>
  );
}

function getQuestionSourceLabel(type = '') {
  return {
    seeded: '标准题库',
    teacher: '教师题库',
    kb_generated: '知识库生成',
    personal_generated: '我的资料生成',
    variant: '错题变式',
  }[type] ?? '题库';
}

function getQuestionReviewLabel(status = '') {
  return {
    approved: '已审核',
    auto_verified: '自动验证',
    draft: '草稿',
    rejected: '已拒绝',
    disabled: '已停用',
  }[status] ?? '题库题';
}

function formatLoopTarget(target: string) {
  return {
    learner_profile: '学习画像',
    learning_path: '学习路径',
    study_plan: '学习计划',
    wrong_notebook: '错题本',
    review_queue: '复习队列',
    report: '学习报告',
    notifications: '通知提醒',
  }[target] ?? target;
}

function formatLoopStatus(status: string) {
  return {
    updated: '已更新',
    created: '已创建',
    checked: '已检查',
    refreshed: '已刷新',
    derived: '实时计算',
    not_applicable: '本次不适用',
  }[status] ?? status;
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-80 items-center justify-center text-sm text-slate-500">
      <Loader2 className="mr-2 size-5 animate-spin" />
      {label}
    </div>
  );
}

const fallbackSuggestions: PracticeSuggestion[] = [
  { knowledgePoint: '进程管理', reason: '来自学习画像薄弱点', wrongCount: 1, priority: 1, href: '/a3/assessment?practice=进程管理' },
  { knowledgePoint: '进程调度', reason: '来自学习画像薄弱点', wrongCount: 1, priority: 2, href: '/a3/assessment?practice=进程调度' },
  { knowledgePoint: '处理机调度', reason: '来自学习画像薄弱点', wrongCount: 1, priority: 3, href: '/a3/assessment?practice=处理机调度' },
];
