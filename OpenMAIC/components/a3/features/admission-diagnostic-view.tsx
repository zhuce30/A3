'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, CheckCircle2, Loader2, RotateCcw, Sparkles, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type {
  A3ApiResponse,
  AdmissionDiagnosticBlueprint,
  AdmissionDiagnosticQuestion,
  AdmissionDiagnosticResult,
  LearningPath,
  StudyPlan,
} from '@/lib/a3/learning-types';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';

type DiagnosticBlueprintResponse = A3ApiResponse<{
  current: AdmissionDiagnosticResult | null;
  questions: AdmissionDiagnosticQuestion[];
  diagnosticBlueprint?: AdmissionDiagnosticBlueprint;
  suggestedDurations: number[];
  goals: string[];
  dailyMinutes: number[];
}>;

type DiagnosticSubmitResponse = A3ApiResponse<{
  diagnostic: AdmissionDiagnosticResult;
  path: LearningPath;
  plan: StudyPlan;
}>;

const foundationLevels = ['薄弱', '基础', '中等', '进阶'];

export function AdmissionDiagnosticView() {
  const [questions, setQuestions] = useState<AdmissionDiagnosticQuestion[]>([]);
  const [blueprint, setBlueprint] = useState<AdmissionDiagnosticBlueprint | null>(null);
  const [goals, setGoals] = useState<string[]>([]);
  const [durations, setDurations] = useState<number[]>([7, 14, 30]);
  const [minuteOptions, setMinuteOptions] = useState<number[]>([20, 30, 45, 60, 90]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [goal, setGoal] = useState('期末复习');
  const [foundationLevel, setFoundationLevel] = useState('基础');
  const [dailyMinutes, setDailyMinutes] = useState(45);
  const [durationDays, setDurationDays] = useState(14);
  const [examDate, setExamDate] = useState('');
  const [current, setCurrent] = useState<AdmissionDiagnosticResult | null>(null);
  const [result, setResult] = useState<DiagnosticSubmitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      const response = await a3GetJson<DiagnosticBlueprintResponse>('/api/learning/admission-diagnostic/');
      if (!active) return;
      setLoading(false);
      if (!response.success) {
        setError(response.error ?? '诊断题加载失败');
        return;
      }
      setQuestions(response.questions);
      setBlueprint(response.diagnosticBlueprint ?? null);
      setGoals(response.goals);
      setDurations(response.suggestedDurations);
      setMinuteOptions(response.dailyMinutes);
      setCurrent(response.current);
      if (response.current) {
        setGoal(response.current.goal || '期末复习');
        setDailyMinutes(response.current.dailyMinutes || 45);
        setDurationDays(response.current.durationDays || 14);
        setExamDate(response.current.examDate || '');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const answeredCount = useMemo(() => questions.filter((question) => answers[question.id] !== undefined).length, [answers, questions]);
  const canSubmit = questions.length > 0 && answeredCount === questions.length && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    const response = await a3PostJson<DiagnosticSubmitResponse>('/api/learning/admission-diagnostic/', {
      goal,
      foundationLevel,
      dailyMinutes,
      durationDays,
      examDate,
      answers: questions.map((question) => ({ questionId: question.id, selectedIndex: answers[question.id] })),
    });
    setSubmitting(false);
    if (!response.success) {
      setError(response.error ?? '诊断提交失败');
      return;
    }
    setResult(response);
    setCurrent(response.diagnostic);
  }

  function reset() {
    setAnswers({});
    setResult(null);
    setError('');
  }

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-sm text-[var(--a3-text-muted)]">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在准备入学诊断
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="a3-admission-diagnostic-view">
      <section className="overflow-hidden rounded-[18px] border border-blue-100 bg-[linear-gradient(135deg,oklch(0.98_0.012_235),oklch(0.94_0.032_255))] p-6 shadow-[0_18px_42px_rgba(37,99,235,0.12)]">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div>
            <A3Pill tone="blue">PlacementAgent</A3Pill>
            <h1 className="mt-4 text-3xl font-semibold tracking-normal text-[var(--a3-text)]">入学诊断与计划生成</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--a3-text-muted)]">
              DiagnosticAgent 会先读取画像里的目标、基础和薄弱点，再安排诊断题。提交后系统会刷新学习画像、学习路径和每日计划。
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <HeaderStep icon={Target} title="目标" text={goal} />
              <HeaderStep icon={CalendarDays} title="周期" text={`${durationDays} 天，每天 ${dailyMinutes} 分钟`} />
              <HeaderStep icon={Sparkles} title="诊断" text={`${answeredCount}/${questions.length} 已完成`} />
            </div>
          </div>
          <div className="rounded-2xl border border-white/70 bg-white/75 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--a3-text)]">诊断依据</div>
              <A3Pill tone={blueprint?.degraded ? 'orange' : 'green'}>{blueprint?.agent ?? 'DiagnosticAgent'}</A3Pill>
            </div>
            <BlueprintSummary blueprint={blueprint} />
          </div>
        </div>
      </section>

      <section className="rounded-[18px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-[var(--a3-text)]">最近一次诊断</div>
            <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">作答完成后，这里会显示水平、薄弱点和写回证据。</p>
          </div>
          {current && (
            <A3Pill tone={current.score >= 65 ? 'green' : current.score >= 40 ? 'orange' : 'red'}>
              {current.level.code} · {current.level.label}
            </A3Pill>
          )}
        </div>
            {current ? (
              <div className="mt-4 grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-4xl font-semibold text-blue-700">{current.score}</div>
                    <div className="text-xs text-[var(--a3-text-muted)]">诊断分</div>
                  </div>
                </div>
                <div>
                  <p className="text-sm leading-6 text-[var(--a3-text-muted)]">{current.level.description}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {current.weakPoints.length ? current.weakPoints.map((point) => <A3Pill key={point} tone="orange">{point}</A3Pill>) : <A3Pill tone="green">暂无明显薄弱点</A3Pill>}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm leading-6 text-[var(--a3-text-muted)]">完成第一次诊断后，这里会显示等级、得分和薄弱点。</p>
            )}
      </section>

      {error && <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      {result ? (
        <ResultPanel result={result} onReset={reset} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <A3Card title="计划参数" subtitle="这些信息会写入学习画像，用于生成每日任务。">
            <div className="space-y-5">
              <ChoiceGroup title="学习目标" options={goals} value={goal} onChange={setGoal} />
              <ChoiceGroup title="当前基础" options={foundationLevels} value={foundationLevel} onChange={setFoundationLevel} />
              <NumberChoiceGroup title="每日时间" suffix="分钟" options={minuteOptions} value={dailyMinutes} onChange={setDailyMinutes} />
              <NumberChoiceGroup title="计划周期" suffix="天" options={durations} value={durationDays} onChange={setDurationDays} />
              <label className="block">
                <span className="text-sm font-semibold text-[var(--a3-text)]">目标日期，可选</span>
                <input
                  type="date"
                  value={examDate}
                  onChange={(event) => setExamDate(event.target.value)}
                  className="mt-2 h-10 w-full rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm outline-none focus:border-blue-400"
                />
              </label>
            </div>
          </A3Card>

          <A3Card
            title="快速诊断题"
            subtitle={blueprint?.degraded ? (blueprint.degradationReason || '画像不足时使用课程核心题库。') : '题目顺序已根据画像薄弱点、目标和基础水平调整。'}
            action={<A3Pill tone={answeredCount === questions.length ? 'green' : 'blue'}>{answeredCount}/{questions.length}</A3Pill>}
          >
            <div className="space-y-4">
              {questions.map((question, index) => (
                <QuestionBlock
                  key={question.id}
                  index={index + 1}
                  question={question}
                  selected={answers[question.id]}
                  onSelect={(selectedIndex) => setAnswers((previous) => ({ ...previous, [question.id]: selectedIndex }))}
                />
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--a3-surface-muted)] p-4">
              <div className="text-sm text-[var(--a3-text-muted)]">完成后会自动刷新学习画像、路径顺序和每日计划。</div>
              <Button data-testid="a3-admission-diagnostic-submit" onClick={submit} disabled={!canSubmit} className="bg-blue-600 hover:bg-blue-700">
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                生成我的计划
              </Button>
            </div>
          </A3Card>
        </div>
      )}
    </div>
  );
}

function HeaderStep({ icon: Icon, title, text }: { icon: typeof Target; title: string; text: string }) {
  return (
    <div className="rounded-xl bg-white/70 p-4">
      <Icon className="size-5 text-blue-700" />
      <div className="mt-3 text-xs text-[var(--a3-text-muted)]">{title}</div>
      <div className="mt-1 text-sm font-semibold text-[var(--a3-text)]">{text}</div>
    </div>
  );
}

function BlueprintSummary({ blueprint }: { blueprint: AdmissionDiagnosticBlueprint | null }) {
  const inputs = blueprint?.profileInputs;
  const weakPoints = inputs?.weakPoints?.slice(0, 2).join('、') || '待画像补充';
  const goals = inputs?.learningGoals?.slice(0, 2).join('、') || '待画像补充';
  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-xl bg-white/70 p-3">
        <div className="text-xs text-[var(--a3-text-muted)]">画像输入</div>
        <div className="mt-1 text-sm font-semibold leading-6 text-[var(--a3-text)]">
          {inputs?.foundationLevel || '待判断'} · {inputs?.dailyStudyTime || '--'} 分钟/天
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        <EvidenceChip label="优先薄弱点" value={weakPoints} />
        <EvidenceChip label="学习目标" value={goals} />
      </div>
      <div className={blueprint?.degraded ? 'rounded-xl border border-orange-100 bg-orange-50 p-3 text-xs leading-5 text-orange-800' : 'rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800'}>
        {blueprint?.degraded ? (blueprint.degradationReason || '画像字段不足，先使用课程核心题。') : '已按画像薄弱点优先、课程核心覆盖和基础水平调整题目。'}
      </div>
    </div>
  );
}

function EvidenceChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/70 p-3">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold leading-6 text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function ChoiceGroup({ title, options, value, onChange }: { title: string; options: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <div className="text-sm font-semibold text-[var(--a3-text)]">{title}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              'rounded-lg border px-3 py-2 text-sm transition-colors',
              value === option ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-[var(--a3-border)] text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)]',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberChoiceGroup({ title, suffix, options, value, onChange }: { title: string; suffix: string; options: number[]; value: number; onChange: (value: number) => void }) {
  return <ChoiceGroup title={title} options={options.map((option) => `${option} ${suffix}`)} value={`${value} ${suffix}`} onChange={(next) => onChange(Number.parseInt(next, 10))} />;
}

function QuestionBlock({ index, question, selected, onSelect }: { index: number; question: AdmissionDiagnosticQuestion; selected?: number; onSelect: (index: number) => void }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4" data-testid="a3-admission-question">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-semibold text-blue-700">{index}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--a3-text)]">{question.title}</h3>
            <A3Pill tone="slate">{question.knowledgePoint}</A3Pill>
            <A3Pill tone={question.difficulty === 'challenge' ? 'orange' : question.difficulty === 'foundation' ? 'green' : 'blue'}>
              {formatDiagnosticDifficulty(question.difficulty)}
            </A3Pill>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{question.prompt}</p>
          {question.reason && (
            <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
              {question.reason}
            </div>
          )}
          <div className="mt-4 grid gap-2 lg:grid-cols-2">
            {question.options.map((option, optionIndex) => (
              <button
                key={option}
                type="button"
                onClick={() => onSelect(optionIndex)}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-3 text-left text-sm transition-colors',
                  selected === optionIndex ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-[var(--a3-border)] hover:bg-[var(--a3-surface-muted)]',
                )}
              >
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]', selected === optionIndex ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 text-slate-500')}>
                  {String.fromCharCode(65 + optionIndex)}
                </span>
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDiagnosticDifficulty(difficulty?: string) {
  if (difficulty === 'foundation') return '基础校准';
  if (difficulty === 'challenge') return '进阶挑战';
  if (difficulty === 'standard') return '标准题';
  return difficulty || '标准题';
}

function ResultPanel({ result, onReset }: { result: DiagnosticSubmitResponse; onReset: () => void }) {
  const weakPoints = result.diagnostic.weakPoints;
  const evidence = result.diagnostic.loopEvidence;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
      <A3Card title="诊断完成" subtitle={result.diagnostic.nextAction} action={<A3Pill tone="green">已生成</A3Pill>}>
        <div className="grid gap-4 md:grid-cols-4">
          <ResultMetric label="诊断分" value={`${result.diagnostic.score}`} />
          <ResultMetric label="等级" value={`${result.diagnostic.level.code} ${result.diagnostic.level.label}`} />
          <ResultMetric label="计划周期" value={`${result.plan.durationDays} 天`} />
          <ResultMetric label="每日任务" value={`${result.plan.dailyMinutes} 分钟`} />
        </div>
        <div className="mt-5 rounded-xl bg-[var(--a3-surface-muted)] p-4">
          <div className="text-sm font-semibold text-[var(--a3-text)]">AI 教练建议</div>
          <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{result.plan.coachTip}</p>
        </div>
        {evidence && (
          <div className="mt-5 rounded-xl border border-emerald-100 bg-emerald-50 p-4" data-testid="a3-admission-loop-evidence">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-emerald-950">本次诊断已写回</div>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  {evidence.schemaVersion} / 诊断 ID：{String(evidence.subject.diagnosticId ?? result.diagnostic.diagnosticId)}
                </p>
              </div>
              <A3Pill tone="green">{evidence.trigger}</A3Pill>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {evidence.writeBacks.map((item) => (
                <div key={`${item.target}-${item.status}`} className="rounded-lg bg-white/80 p-3 text-xs leading-5 text-emerald-800">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-emerald-950">{formatLoopTarget(item.target)}</span>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">{formatLoopStatus(item.status)}</span>
                  </div>
                  <div className="mt-1">{item.summary}</div>
                </div>
              ))}
            </div>
            <Button asChild size="sm" className="mt-4 bg-emerald-600 hover:bg-emerald-700">
              <Link href={evidence.nextAction.href}>
                {evidence.nextAction.label}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild className="bg-emerald-600 hover:bg-emerald-700">
            <Link href="/a3/today">
              开始今日学习
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button asChild className="bg-blue-600 hover:bg-blue-700">
            <Link href="/a3/study-plan">
              查看每日学习计划
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/a3/learning-path">查看学习路径</Link>
          </Button>
          <Button variant="ghost" onClick={onReset}>
            <RotateCcw className="size-4" />
            重新诊断
          </Button>
        </div>
      </A3Card>

      <A3Card title="薄弱点与今日计划">
        <div className="space-y-4">
          <div>
            <div className="text-sm font-semibold text-[var(--a3-text)]">薄弱点</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {weakPoints.length ? weakPoints.map((point) => <A3Pill key={point} tone="orange">{point}</A3Pill>) : <A3Pill tone="green">暂无明显薄弱点</A3Pill>}
            </div>
          </div>
          <div className="space-y-3">
            {(result.plan.days[0]?.tasks ?? []).map((task) => (
              <Link key={task.id} href={task.href} className="block rounded-xl border border-[var(--a3-border)] p-3 hover:bg-blue-50">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-[var(--a3-text)]">{task.title}</span>
                  <CheckCircle2 className="size-4 text-slate-300" />
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{task.subtitle}</p>
              </Link>
            ))}
          </div>
        </div>
      </A3Card>
    </div>
  );
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--a3-surface-muted)] p-4">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-2 text-xl font-semibold text-[var(--a3-text)]">{value}</div>
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
