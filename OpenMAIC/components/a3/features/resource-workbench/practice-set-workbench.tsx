'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleHelp, LockKeyhole, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';
import { ResourceLearningRail } from './resource-learning-rail';
import { ResourceWorkbenchShell } from './resource-workbench-shell';
import { normalizePracticeQuestions } from './resource-workbench-utils';

type FeedbackAction = 'completed' | 'skipped' | 'favorited';

export function PracticeSetWorkbench({
  resource,
  feedbackMessage,
  feedbackSaving,
  onFeedback,
}: {
  resource: A3ResourcePackV2Resource;
  feedbackMessage: string;
  feedbackSaving: string;
  onFeedback: (action: FeedbackAction, score?: number | null) => void;
}) {
  const questions = useMemo(() => normalizePracticeQuestions(resource), [resource]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submittedQuestionIds, setSubmittedQuestionIds] = useState<Set<string>>(() => new Set());
  const currentQuestion = questions[activeIndex];
  const currentAnswer = currentQuestion ? answers[currentQuestion.id] ?? '' : '';
  const isCurrentQuestionSubmitted = currentQuestion ? submittedQuestionIds.has(currentQuestion.id) : false;
  const completedCount = submittedQuestionIds.size;
  const progress = questions.length ? Math.round((completedCount / questions.length) * 100) : 0;
  const choiceQuestions = questions.filter((question) => question.options.length > 0);
  const correctChoiceCount = choiceQuestions.filter((question) => submittedQuestionIds.has(question.id) && normalizeAnswer(answers[question.id] ?? '') === normalizeAnswer(question.answer)).length;
  const completionScore = choiceQuestions.length ? Math.round((correctChoiceCount / choiceQuestions.length) * 100) : 0;
  const canComplete = completedCount === questions.length;

  function updateCurrentAnswer(value: string) {
    if (!currentQuestion || isCurrentQuestionSubmitted) return;
    setAnswers((current) => ({ ...current, [currentQuestion.id]: value }));
  }

  function submitCurrentQuestion() {
    if (!currentQuestion || !currentAnswer.trim()) return;
    setSubmittedQuestionIds((current) => new Set(current).add(currentQuestion.id));
  }

  if (!currentQuestion) {
    return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">当前资源没有可练习的题目。</div>;
  }

  const isChoiceQuestion = currentQuestion.options.length > 0;
  const isCorrect = isChoiceQuestion && normalizeAnswer(currentAnswer) === normalizeAnswer(currentQuestion.answer);

  const main = (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" data-testid="a3-practice-set-workbench">
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-blue-700">{currentQuestion.knowledgePoint}</div>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">第 {activeIndex + 1} 题</h2>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-white px-3 py-1 text-slate-600">{currentQuestion.type}</span>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">{currentQuestion.difficulty}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-[128px_minmax(0,1fr)]">
        <QuestionNavigator
          count={questions.length}
          activeIndex={activeIndex}
          submittedQuestionIds={submittedQuestionIds}
          questionIds={questions.map((question) => question.id)}
          onSelect={setActiveIndex}
        />

        <div className="min-w-0">
          <p className="text-base font-medium leading-8 text-slate-950">{currentQuestion.stem}</p>

          {isChoiceQuestion ? (
            <div className="mt-5 grid gap-3">
              {currentQuestion.options.map((option) => {
                const selected = currentAnswer === option;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isCurrentQuestionSubmitted}
                    onClick={() => updateCurrentAnswer(option)}
                    className={`min-h-12 rounded-lg border px-4 py-3 text-left text-sm leading-6 transition ${selected ? 'border-blue-500 bg-blue-50 text-blue-950' : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-blue-300 hover:bg-white'} disabled:cursor-default`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          ) : (
            <textarea
              value={currentAnswer}
              onChange={(event) => updateCurrentAnswer(event.target.value)}
              disabled={isCurrentQuestionSubmitted}
              placeholder="写下你的判断、推理过程和资料依据。"
              className="mt-5 min-h-40 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-7 text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white disabled:cursor-default"
            />
          )}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <Button type="button" variant="outline" disabled={activeIndex === 0} onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}>
              <ArrowLeft className="size-4" />
              上一题
            </Button>
            {!isCurrentQuestionSubmitted ? (
              <Button type="button" disabled={!currentAnswer.trim()} onClick={submitCurrentQuestion} className="bg-blue-600 text-white hover:bg-blue-700">
                提交本题
              </Button>
            ) : (
              <Button type="button" disabled={activeIndex >= questions.length - 1} onClick={() => setActiveIndex((index) => Math.min(questions.length - 1, index + 1))} className="bg-blue-600 text-white hover:bg-blue-700">
                下一题
                <ArrowRight className="size-4" />
              </Button>
            )}
          </div>

          {isCurrentQuestionSubmitted ? (
            <QuestionFeedback question={currentQuestion} isCorrect={isCorrect} isChoiceQuestion={isChoiceQuestion} />
          ) : (
            <div className="mt-5 flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500">
              <LockKeyhole className="size-4" />
              提交当前题后显示答案、解析、错因和资料依据。
            </div>
          )}
        </div>
      </div>
    </section>
  );

  const checkpoints = [
    { label: '完成当前题作答', completed: Boolean(currentAnswer.trim()) },
    { label: '提交后阅读解析', completed: isCurrentQuestionSubmitted },
    { label: '完成整组练习', completed: completedCount === questions.length },
  ];

  return (
    <ResourceWorkbenchShell
      main={main}
      rail={(
        <ResourceLearningRail
          resource={resource}
          progress={progress}
          progressLabel={`已提交 ${completedCount}/${questions.length} 题`}
          steps={['独立完成当前题', '提交并核对解析', '记录错因后进入下一题']}
          checkpoints={checkpoints}
          feedbackMessage={feedbackMessage}
          feedbackSaving={feedbackSaving}
          onFeedback={onFeedback}
          canComplete={canComplete}
          completionScore={completionScore}
          completionHint="完成并提交全部题目后，才能记录本次练习结果。"
        />
      )}
    />
  );
}

function QuestionNavigator({
  count,
  activeIndex,
  submittedQuestionIds,
  questionIds,
  onSelect,
}: {
  count: number;
  activeIndex: number;
  submittedQuestionIds: Set<string>;
  questionIds: string[];
  onSelect: (index: number) => void;
}) {
  return (
    <nav aria-label="题目导航">
      <div className="text-xs font-semibold text-slate-500">题目导航</div>
      <div className="mt-3 grid grid-cols-4 gap-2 lg:grid-cols-2">
        {Array.from({ length: count }, (_, index) => {
          const submitted = submittedQuestionIds.has(questionIds[index]);
          const active = activeIndex === index;
          return (
            <button
              key={questionIds[index]}
              type="button"
              onClick={() => onSelect(index)}
              aria-current={active ? 'true' : undefined}
              aria-label={`第 ${index + 1} 题${submitted ? '，已作答' : '，未作答'}${active ? '，当前题' : ''}`}
              className={`flex aspect-square items-center justify-center rounded-md text-xs font-semibold transition ${active ? 'bg-blue-600 text-white' : submitted ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function QuestionFeedback({ question, isCorrect, isChoiceQuestion }: { question: ReturnType<typeof normalizePracticeQuestions>[number]; isCorrect: boolean; isChoiceQuestion: boolean }) {
  return (
    <div className="mt-5 space-y-4 border-t border-slate-100 pt-5">
      <section className={`rounded-lg border p-4 ${isChoiceQuestion && !isCorrect ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
          {isChoiceQuestion ? (isCorrect ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-amber-600" />) : <CircleHelp className="size-4 text-blue-600" />}
          {isChoiceQuestion ? (isCorrect ? '回答正确' : '请对照解析复盘') : '参考答案'}
        </div>
        <p className="mt-2 text-sm leading-7 text-slate-800">{question.answer}</p>
      </section>
      <FeedbackSection title="解析" items={[question.explanation]} />
      <FeedbackSection title="常见错因" items={[question.commonMistake]} />
      {question.distractorAnalysis.length > 0 && <FeedbackSection title="其他选项为什么不对" items={question.distractorAnalysis} />}
      <FeedbackSection title="自查标准" items={question.evaluationRubric} />
    </div>
  );
}

function FeedbackSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => <p key={`${item}-${index}`} className="text-sm leading-7 text-slate-600">{item}</p>)}
      </div>
    </section>
  );
}

function normalizeAnswer(value: string) {
  const text = value.trim();
  const optionLetter = text.match(/^([A-D])(?:[.、：:]|\s|$)/i)?.[1];
  return optionLetter ? optionLetter.toLowerCase() : text.toLowerCase();
}
