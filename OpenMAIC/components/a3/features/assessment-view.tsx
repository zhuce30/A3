'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  FileQuestion,
  Loader2,
  RotateCcw,
  Sparkles,
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
import { A3Card, A3Pill } from '../ui/a3-card';

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
      if (weakPoints.length) {
        void loadNextRecommendations(weakPoints);
      }
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

  if (loading) return <LoadingState label="正在准备测评" />;
  if (!session) {
    return (
      <A3Card>
        <div className="py-10 text-center">
          <FileQuestion className="mx-auto size-12 text-slate-300" />
          <p className="mt-4 text-sm font-semibold text-[var(--a3-text)]">{error ? '测评启动失败' : '暂无可用测评'}</p>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">
            {error || '完成入学诊断或学习路径后，系统会根据当前节点生成诊断题目。'}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <Button onClick={restart} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {error ? '重新尝试' : '开始测评'}
            </Button>
            <Button asChild variant="outline">
              <Link href="/a3/admission-diagnostic">入学诊断</Link>
            </Button>
          </div>
        </div>
      </A3Card>
    );
  }

  const question = session.currentQuestion;
  const progress = session.totalQuestions ? Math.round((session.answeredCount * 100) / session.totalQuestions) : 0;

  return (
    <div data-testid="a3-assessment-view" className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">学情诊断与测评</h1>
          <p className="mt-1 text-sm text-slate-500">题目来自当前学习路径，作答结果会同步到错题本、学习报告和个人画像。</p>
        </div>

        {reportSource && (
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            来自学习报告钻取：{reportLabel || '趋势数据'}
            {reportStart && reportEnd ? `（${reportStart} 至 ${reportEnd}）` : ''}。继续作答后会回写报告、错题本和学习计划。
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <span>{error}</span>
            <Button size="sm" variant="outline" className="border-rose-300 bg-white text-rose-700 hover:bg-rose-50" onClick={() => void submit()}>
              重新提交
            </Button>
          </div>
        )}

        {session.status === 'completed' || !question ? (
          <A3Card>
            <div className="py-10 text-center">
              <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
              <h2 className="mt-4 text-xl font-semibold">本次测评已完成</h2>
              <p className="mt-2 text-sm text-slate-500">诊断得分 {session.score} 分，答案已计入学习报告。</p>
              {feedback?.report && (
                <div className="mx-auto mt-5 grid max-w-xl gap-3 rounded-xl bg-slate-50 p-4 text-left md:grid-cols-3">
                  <ReportMetric label="正确率" value={`${feedback.report.metrics.accuracy}%`} />
                  <ReportMetric label="活跃错题" value={`${feedback.report.metrics.activeWrongQuestions}`} />
                  <ReportMetric label="路径进度" value={`${feedback.report.metrics.pathProgress}%`} />
                </div>
              )}
              <div className="mt-6 flex justify-center gap-3">
                <Button data-testid="a3-assessment-restart" onClick={restart} disabled={submitting}>
                  <RotateCcw className="mr-2 size-4" />
                  重新测评
                </Button>
                <Button asChild variant="outline">
                  <Link data-testid="a3-assessment-wrong-notebook" href="/a3/wrong-notebook">查看错题本</Link>
                </Button>
              </div>
              {feedback?.nextAction && (
                <div className="mx-auto mt-5 max-w-xl rounded-xl border border-blue-100 bg-blue-50 p-4 text-left text-sm text-blue-800">
                  <div className="font-semibold">{feedback.nextAction.label}</div>
                  <div className="mt-1">{feedback.nextAction.reason}</div>
                  <Button asChild size="sm" className="mt-3">
                    <Link href={feedback.nextAction.href}>执行下一步</Link>
                  </Button>
                </div>
              )}
            </div>
          </A3Card>
        ) : (
          <A3Card
            title={`第 ${session.currentIndex + 1} 题`}
            subtitle={`${question.knowledgePoint.chapter} / ${question.knowledgePoint.title}`}
            action={<QuestionSourceBadges question={question} />}
          >
            <p data-testid="a3-assessment-question" className="max-w-[70ch] text-base font-medium leading-8 text-slate-800">{question.stem}</p>
            <QuestionEvidenceStrip question={question} />
            <div className="mt-6 grid gap-3 md:grid-cols-2">
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
                      'min-h-14 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                      correct
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : wrongSelected
                          ? 'border-rose-300 bg-rose-50 text-rose-800'
                          : isSelected
                            ? 'border-blue-500 bg-blue-50 text-blue-800'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50/50',
                    ].join(' ')}
                  >
                    <span className="mr-3 text-slate-400">{option.key}.</span>
                    {option.text}
                  </button>
                );
              })}
            </div>

            {feedback && (
              <div
                data-testid="a3-assessment-feedback"
                className={`mt-6 rounded-lg border p-4 ${feedback.isCorrect ? 'border-emerald-200 bg-emerald-50' : 'border-orange-200 bg-orange-50'}`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {feedback.isCorrect ? <CheckCircle2 className="size-5 text-emerald-600" /> : <XCircle className="size-5 text-orange-600" />}
                  {feedback.isCorrect ? '回答正确' : `回答错误，正确答案为 ${feedback.correctAnswer}`}
                </div>
                <p data-testid="a3-assessment-explanation" className="mt-2 text-sm leading-6 text-slate-700">{feedback.explanation}</p>
                {feedback.errorCause && <p data-testid="a3-assessment-error-cause" className="mt-2 text-sm text-orange-800">错因提示：{feedback.errorCause}</p>}
                {feedback.profileUpdate?.weakPoints?.length ? (
                  <div data-testid="a3-assessment-profile-sync" className="mt-3 rounded-lg bg-white/70 p-3 text-sm leading-6 text-slate-700">
                    <div className="font-semibold text-slate-900">画像薄弱点已同步</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {feedback.profileUpdate.weakPoints.slice(0, 6).map((item) => (
                        <A3Pill key={item} tone="orange">
                          {item}
                        </A3Pill>
                      ))}
                    </div>
                  </div>
                ) : null}
                {feedback.studyPlan && (
                  <div data-testid="a3-assessment-plan-sync" className="mt-3 rounded-lg bg-white/80 p-3 text-sm leading-6 text-slate-700">
                    <div className="font-semibold text-slate-900">学习计划已自动刷新</div>
                    <div className="mt-1 text-slate-600">
                      今日重点：{feedback.studyPlan.days[0]?.focus ?? feedback.studyPlan.title} · {feedback.studyPlan.days[0]?.estimatedMinutes ?? feedback.studyPlan.dailyMinutes} 分钟
                    </div>
                    <Button asChild size="sm" variant="outline" className="mt-3">
                      <Link href="/a3/study-plan">查看新计划</Link>
                    </Button>
                  </div>
                )}
                <div data-testid="a3-assessment-loop-evidence" className="mt-3 rounded-lg bg-white/80 p-3 text-xs leading-5 text-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-900">本题写回去向</div>
                    {feedback.loopEvidence && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{feedback.loopEvidence.schemaVersion}</span>
                    )}
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
                      <div className="mt-2 text-slate-600">
                        下一步：{feedback.loopEvidence.nextAction.label}
                      </div>
                    </>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <LoopEvidenceItem
                        label="错题本"
                        status={feedback.isCorrect ? '未新增' : '已加入复习队列'}
                        detail={feedback.isCorrect ? '本题正确，不新增错题记录。' : feedback.errorCause || '答错题目已进入错题本。'}
                      />
                      <LoopEvidenceItem
                        label="学习画像"
                        status={feedback.profileUpdate?.weakPoints?.length ? '已更新' : '已检查'}
                        detail={feedback.profileUpdate?.weakPoints?.slice(0, 3).join('、') || '本题没有新增薄弱点。'}
                      />
                      <LoopEvidenceItem
                        label="学习计划"
                        status={feedback.studyPlan ? '已刷新' : '按需刷新'}
                        detail={feedback.studyPlan?.days[0]?.focus ?? '计划会在下一次获取时读取最新测评结果。'}
                      />
                      <LoopEvidenceItem
                        label="推荐资源"
                        status={nextRecommendations?.recommendations?.length ? '已刷新' : recommendationLoading ? '刷新中' : '等待错题信号'}
                        detail={nextRecommendations?.query || '出现薄弱点后会调用推荐接口生成下一步资源。'}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              {!feedback ? (
                <>
                  <Button data-testid="a3-assessment-skip" variant="outline" onClick={() => submit(true)} disabled={submitting}>跳过</Button>
                  <Button data-testid="a3-assessment-submit" onClick={() => submit(false)} disabled={!selected || submitting} className="bg-blue-600 hover:bg-blue-700">
                    {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                    提交答案
                  </Button>
                </>
              ) : (
                <Button data-testid="a3-assessment-next-question" onClick={nextQuestion}>{feedback.session.status === 'completed' ? '查看结果' : '下一题'}</Button>
              )}
            </div>
          </A3Card>
        )}
      </div>

      <div className="space-y-5">
        <A3Card title="本次测评">
          {session.mode === 'practice' && session.focus?.knowledgePoint && (
            <div data-testid="a3-assessment-practice-focus" className="mb-4 rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">
              当前为专项练习：{session.focus.knowledgePoint}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 text-center">
            <Metric icon={Target} value={`${session.score}`} label="当前得分" />
            <Metric icon={FileQuestion} value={`${session.totalQuestions}`} label="题目数" />
            <Metric icon={Clock} value={`${session.answeredCount}`} label="已作答" />
          </div>
          <div className="mt-5 h-2 rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-2 text-right text-xs text-slate-500">完成 {progress}%</div>
        </A3Card>

        <A3Card title="专项练习" subtitle="按薄弱知识点直接开一组练习。">
          <div className="space-y-3">
            <input
              data-testid="a3-assessment-practice-input"
              value={practicePoint}
              onChange={(event) => setPracticePoint(event.target.value)}
              placeholder="例如：处理机调度"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
            />
            <div className="flex flex-wrap gap-2">
              {(practiceSuggestions.length ? practiceSuggestions.map((item) => item.knowledgePoint) : ['处理机调度算法', '同步互斥与信号量', '虚拟内存与页面置换']).slice(0, 5).map((point) => (
                <button
                  key={point}
                  type="button"
                  onClick={() => setPracticePoint(point)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-blue-300 hover:bg-blue-50"
                >
                  {point}
                </button>
              ))}
            </div>
            {practiceSuggestions.length > 0 && (
              <div className="space-y-2">
                {practiceSuggestions.slice(0, 3).map((item) => (
                  <button
                    data-testid="a3-assessment-practice-suggestion"
                    key={item.knowledgePoint}
                    type="button"
                    onClick={() => startPractice(item.knowledgePoint)}
                    className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left hover:border-blue-300 hover:bg-blue-50/50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-900">{item.knowledgePoint}</span>
                      <A3Pill tone={item.wrongCount ? 'orange' : 'blue'}>{item.wrongCount ? `错 ${item.wrongCount}` : '画像'}</A3Pill>
                    </div>
                    <div className="mt-1 text-xs leading-5 text-slate-500">{item.reason}</div>
                  </button>
                ))}
              </div>
            )}
            <Button data-testid="a3-assessment-practice-start" onClick={() => startPractice(practicePoint || '处理机调度算法')} disabled={submitting} className="w-full">
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              开始专项练习
            </Button>
          </div>
        </A3Card>

        <RecommendationPanel loading={recommendationLoading} data={nextRecommendations} />

        <A3Card title="数据去向">
          <ul className="space-y-3 text-sm leading-6 text-slate-600">
            <li>答错或跳过的题目自动进入错题本。</li>
            <li>测评正确率实时计入学习报告。</li>
            <li>薄弱知识点通过 /api/assess/grade/ 同步到学习画像。</li>
            <li>画像更新后自动调用 /api/recommend/ 生成下一步资源。</li>
          </ul>
        </A3Card>
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

function RecommendationPanel({ loading, data }: { loading: boolean; data: RecommendationResponse | null }) {
  const items = data?.recommendations ?? [];
  return (
    <A3Card
      title="下一步推荐"
      subtitle="根据本题暴露的薄弱点实时生成。"
      action={loading ? <Loader2 className="size-4 animate-spin text-blue-600" /> : <Sparkles className="size-4 text-blue-600" />}
    >
      {loading && <p className="text-sm leading-6 text-slate-500">正在根据画像变化刷新推荐...</p>}
      {!loading && !items.length && <p className="text-sm leading-6 text-slate-500">提交错题或跳过题目后，这里会展示匹配新薄弱点的课程、练习和资料。</p>}
      <div className="space-y-3">
        {items.map((item) => (
          <RecommendationMiniRow key={item.id} item={item} />
        ))}
      </div>
      {data?.query && <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">推荐查询：{data.query}</div>}
    </A3Card>
  );
}

function QuestionSourceBadges({ question }: { question: AssessmentQuestion }) {
  const source = question.source;
  const sourceLabel = getQuestionSourceLabel(source?.type);
  const reviewLabel = getQuestionReviewLabel(source?.reviewStatus);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <A3Pill tone="blue">难度 {question.difficulty}</A3Pill>
      {source ? <A3Pill tone={source.reviewStatus === 'approved' ? 'green' : 'orange'}>{reviewLabel}</A3Pill> : null}
      {source ? <A3Pill tone={source.type === 'personal_generated' ? 'violet' : 'slate'}>{sourceLabel}</A3Pill> : null}
    </div>
  );
}

function QuestionEvidenceStrip({ question }: { question: AssessmentQuestion }) {
  const evidence = question.evidence ?? [];
  const primary = evidence[0];
  const source = question.source;
  if (!primary && !source) return null;
  return (
    <div data-testid="a3-assessment-question-source" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">题目来源</div>
          <div className="mt-1 text-sm font-medium text-slate-900">
            {source?.resourceTitle || primary?.resourceTitle || getQuestionSourceLabel(source?.type)}
            {primary?.pageNumber ? ` · 第 ${primary.pageNumber} 页` : ''}
          </div>
          {primary?.quote ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{primary.quote}</p> : null}
        </div>
        {primary?.previewUrl ? (
          <img src={resolveA3Endpoint(primary.previewUrl)} alt="" className="h-16 w-24 shrink-0 rounded-lg border border-slate-200 object-cover" />
        ) : null}
      </div>
      {source?.reviewStatus === 'auto_verified' && (
        <div className="mt-2 text-xs text-orange-700">这道题来自自动验证的个人练习题，不会用于正式测评。</div>
      )}
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

function RecommendationMiniRow({ item }: { item: A3Recommendation }) {
  return (
    <Link href={item.href} className="block rounded-xl border border-slate-200 bg-white p-3 transition-colors hover:border-blue-300 hover:bg-blue-50/40">
      <div className="flex items-center justify-between gap-3">
        <A3Pill tone="blue">{item.type}</A3Pill>
        <span className="text-xs font-semibold text-blue-700">{item.score}</span>
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

function Metric({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <div>
      <Icon className="mx-auto size-5 text-blue-600" />
      <div className="mt-2 text-xl font-semibold">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
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
