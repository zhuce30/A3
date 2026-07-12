'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  FileText,
  Loader2,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { AnswerFeedback, AssessmentSession } from '@/lib/a3/assessment-types';
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';
import { RealtimeCoachingCall } from './coaching/realtime-coaching-call';

type TranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  verified?: boolean;
  citations?: Citation[];
  claims?: Claim[];
  safety?: SafetyStatus | null;
  refusalReason?: string;
  degraded?: boolean;
  createdAt?: string;
};

type Citation = { id?: string; title?: string; location?: string; type?: string; sourceTypeLabel?: string; sourceOrigin?: string; score?: number | null; snippet?: string };
type Claim = { id: string; text: string; verified: boolean; overlap?: number; citation?: Citation | null };
type SafetyStatus = { safe: boolean; category: string; reason: string };

type CoachingSessionResponse = {
  success: boolean;
  error?: string;
  session?: {
    schemaVersion: string;
    id?: string;
    status?: string;
    messages: TranscriptMessage[];
    summary: string;
    updatedAt: string;
  };
};
type CoachingSessionRow = { id: string; status: string; topicTitle?: string; summary?: string; questionCount?: number; updatedAt?: string };
type CoachingSessionsResponse = { success: boolean; error?: string; sessions: CoachingSessionRow[] };
type ClassroomResponse = { success: boolean; error?: string; classroom: ClassroomContext };
type AssessmentResponse = { success: boolean; error?: string; session: AssessmentSession };
type AnswerResponse = { success: boolean; error?: string } & Partial<AnswerFeedback>;
type FavoriteResponse = { success: boolean; error?: string };

const tabs = ['知识溯源', '推荐资源', '随堂测验', '课堂总结'] as const;

export function CoachingView() {
  const [classroom, setClassroom] = useState<ClassroomContext | null>(null);
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('知识溯源');
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [coachingSessions, setCoachingSessions] = useState<CoachingSessionRow[]>([]);
  const [viewingSessionId, setViewingSessionId] = useState('');
  const [sessionUpdatedAt, setSessionUpdatedAt] = useState('');
  const [savingSourceId, setSavingSourceId] = useState('');
  const [sourceFavoriteMessage, setSourceFavoriteMessage] = useState('');
  const [sourceFavoriteSuccess, setSourceFavoriteSuccess] = useState(false);
  const [quizSession, setQuizSession] = useState<AssessmentSession | null>(null);
  const [quizFeedback, setQuizFeedback] = useState<AnswerFeedback | null>(null);
  const [quizFeedbackQuestionId, setQuizFeedbackQuestionId] = useState<string | null>(null);
  const [quizLoading, setQuizLoading] = useState(true);
  const [quizSubmitting, setQuizSubmitting] = useState(false);
  const [quizError, setQuizError] = useState('');
  const [lastQuizAnswer, setLastQuizAnswer] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [classroomResult, sessionResult, sessionsResult, assessment] = await Promise.all([
        a3GetJson<ClassroomResponse>('/api/learning/classroom/'),
        a3GetJson<CoachingSessionResponse>('/api/learning/coaching/session/'),
        a3GetJson<CoachingSessionsResponse>('/api/learning/coaching/sessions/?limit=20'),
        a3GetJson<AssessmentResponse>('/api/assessments/current/'),
      ]);
      if (!mounted) return;
      if (classroomResult.success) {
        setClassroom(classroomResult.classroom);
      }
      if (assessment.success) setQuizSession(assessment.session);
      setQuizLoading(false);

      const persisted = sessionResult.success ? sessionResult.session?.messages ?? [] : [];
      setSessionUpdatedAt(sessionResult.success ? sessionResult.session?.updatedAt ?? '' : '');
      const welcomeMessage = buildWelcomeMessage(classroomResult.success ? classroomResult.classroom : null);
      setMessages(persisted.length ? persisted : [welcomeMessage]);
      setCoachingSessions(sessionsResult.success ? sessionsResult.sessions : []);
      setViewingSessionId('');
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  const target = classroom?.target;

  async function viewCoachingSession(sessionId: string) {
    window.speechSynthesis?.cancel();
    const result = await a3GetJson<CoachingSessionResponse>(`/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/`);
    if (!result.success || !result.session) {
      return;
    }
    setViewingSessionId(sessionId);
    setMessages(result.session.messages.length ? result.session.messages : [buildWelcomeMessage(classroom)]);
    setSessionUpdatedAt(result.session.updatedAt ?? '');
  }

  async function saveSourceFavorite(source: Citation) {
    const sourceId = source.id || source.title || source.location || 'source';
    setSavingSourceId(sourceId);
    setSourceFavoriteMessage('');
    setSourceFavoriteSuccess(false);
    const result = await a3PostJson<FavoriteResponse>('/api/engagement/favorites/create/', {
      type: 'knowledge_card',
      title: source.title || '知识库来源',
      source: [source.sourceOrigin || '全量知识库索引', source.sourceTypeLabel || source.type, source.location].filter(Boolean).join(' / ') || '知识库',
      url: '/a3/coaching',
      group: '知识库来源',
      metadata: { ...source, target },
    });
    setSavingSourceId('');
    setSourceFavoriteSuccess(result.success);
    setSourceFavoriteMessage(result.success ? '已收藏知识库来源，可在“我的收藏”中查看' : result.error ?? '知识库来源收藏失败');
  }

  async function submitQuizAnswer(selectedAnswer: string) {
    if (!quizSession?.id || !quizSession.currentQuestion || quizSubmitting) return;
    const answeredQuestionId = quizSession.currentQuestion.id;
    setLastQuizAnswer(selectedAnswer);
    setQuizSubmitting(true);
    setQuizError('');
    const result = await a3PostJson<AnswerResponse>('/api/assess/grade/', { sessionId: quizSession.id, selectedAnswer });
    setQuizSubmitting(false);
    if (!result.success || !result.session || typeof result.isCorrect !== 'boolean') {
      setQuizError(result.error ?? '随堂测验提交失败');
      return;
    }
    setQuizSession(result.session);
    setQuizFeedbackQuestionId(answeredQuestionId);
    setQuizFeedback({
      isCorrect: result.isCorrect,
      selectedAnswer: result.selectedAnswer ?? selectedAnswer,
      correctAnswer: result.correctAnswer ?? '',
      explanation: result.explanation ?? '',
      errorCause: result.errorCause ?? '',
      session: result.session,
    });
  }

  return (
    <div className="grid gap-5" data-testid="a3-coaching-view">
      <div className="min-w-0">
        <RealtimeCoachingCall
          rightRail={(
            <div className="space-y-4">
        <CoachingHistoryCard sessions={coachingSessions} activeId={viewingSessionId} onOpen={viewCoachingSession} />
        <A3Card>
          <div className="mb-5 grid grid-cols-4 gap-1 rounded-[10px] bg-[var(--a3-surface-muted)] p-1 text-center text-xs font-medium text-[var(--a3-text-muted)]">
            {tabs.map((tab) => (
              <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={cn('rounded-lg px-1 py-2', activeTab === tab && 'bg-[var(--a3-surface-solid)] text-blue-700 shadow-sm')}>{tab}</button>
            ))}
          </div>
          {activeTab === '知识溯源' && <KnowledgeSources classroom={classroom} savingSourceId={savingSourceId} message={sourceFavoriteMessage} success={sourceFavoriteSuccess} onFavorite={saveSourceFavorite} />}
          {activeTab === '推荐资源' && <RecommendedResources classroom={classroom} />}
          {activeTab === '随堂测验' && <Quiz target={target?.title} session={quizSession} feedback={quizFeedback} feedbackQuestionId={quizFeedbackQuestionId} error={quizError} lastAnswer={lastQuizAnswer} loading={quizLoading} submitting={quizSubmitting} onAnswer={submitQuizAnswer} />}
          {activeTab === '课堂总结' && <SessionSummary target={target?.title} messages={messages} sessionUpdatedAt={sessionUpdatedAt} />}
        </A3Card>
            </div>
          )}
        />
      </div>
    </div>
  );
}

function buildWelcomeMessage(classroom: ClassroomContext | null): TranscriptMessage {
  const target = classroom?.target;
  return {
    id: 'welcome',
    role: 'assistant',
    content: target
      ? `你好，我是 AI 助教小智。当前面对面辅导主题是《${target.title}》，我会结合学习路径、知识库和错题记录回答。`
      : '你好，我是 AI 助教小智。请先生成学习路径，再开始面对面辅导。',
    createdAt: new Date().toISOString(),
  };
}

function CoachingHistoryCard({
  sessions,
  activeId,
  onOpen,
}: {
  sessions: CoachingSessionRow[];
  activeId: string;
  onOpen: (sessionId: string) => void;
}) {
  return (
    <div data-testid="a3-coaching-history-panel">
      <A3Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--a3-text)]">历史对话</h2>
            <p className="mt-1 text-xs text-[var(--a3-text-muted)]">新建对话不会删除之前的面对面辅导记录。</p>
          </div>
          <FileText className="size-5 text-blue-600" />
        </div>
        <div className="mt-4 space-y-2">
          {sessions.length ? sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid="a3-coaching-history-session"
              onClick={() => onOpen(session.id)}
              className={cn(
                'w-full rounded-xl border p-3 text-left text-sm transition hover:border-blue-300 hover:bg-blue-50',
                activeId === session.id ? 'border-blue-300 bg-blue-50' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)]',
              )}
            >
              <div className="line-clamp-1 font-semibold text-[var(--a3-text)]">{session.topicTitle || '面对面辅导'}</div>
              <div className="mt-1 text-xs text-[var(--a3-text-muted)]">
                {session.summary || `${session.questionCount ?? 0} 次提问`}
              </div>
            </button>
          )) : (
            <div className="rounded-xl border border-dashed border-[var(--a3-border)] p-3 text-sm text-[var(--a3-text-muted)]">
              暂无历史对话。完成一次辅导后，新建对话会把旧内容保留在这里。
            </div>
          )}
        </div>
      </A3Card>
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function KnowledgeSources({ classroom, savingSourceId, message, success, onFavorite }: { classroom: ClassroomContext | null; savingSourceId: string; message: string; success: boolean; onFavorite: (source: Citation) => void }) {
  const sources = classroom?.sources ?? [];
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--a3-text)]">本次讲解涉及的知识来源</h2>
        <A3Pill>{sources.length}</A3Pill>
      </div>
      <div className="space-y-3">
        {sources.map((source) => (
          <div key={source.id} className="rounded-[10px] border border-[var(--a3-border)] p-3" data-testid="a3-coaching-source">
            <div className="flex items-start gap-3">
              <FileText className="mt-0.5 size-4 shrink-0 text-blue-600" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--a3-text)]" data-testid="a3-source-title">{source.title}</div>
                <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{source.location}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <A3Pill tone="blue">{source.sourceOrigin || '全量知识库索引'}</A3Pill>
                  <A3Pill tone="slate">{source.sourceTypeLabel || source.type || '本地资料'}</A3Pill>
                </div>
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{source.snippet}</p>
                <div className="mt-3 flex justify-end">
                  <Button data-testid="a3-source-favorite" size="xs" variant="outline" disabled={savingSourceId === (source.id || source.title)} onClick={() => onFavorite(source)}>
                    {savingSourceId === (source.id || source.title) ? <Loader2 className="size-3 animate-spin" /> : <Star className="size-3" />}
                    收藏来源
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ))}
        {!sources.length && (
          <div className="rounded-lg bg-[var(--a3-surface-muted)] p-4 text-sm leading-6 text-[var(--a3-text-muted)]">
            暂无知识库来源。可以先上传课程资料或生成学习路径，再回到面对面辅导。
            <div className="mt-3">
              <Button asChild size="sm" variant="outline">
                <Link href="/a3/knowledge-base">去本地知识库</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
      {message && (
        <div className={cn('mt-3 flex flex-col gap-3 rounded-lg px-3 py-2 text-sm md:flex-row md:items-center md:justify-between', success ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')} data-testid="a3-source-favorite-message">
          <span>{message}</span>
          {success && (
            <Button asChild size="sm" variant="outline" className="border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100">
              <Link data-testid="a3-source-open-favorites" href="/a3/favorites">去我的收藏</Link>
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function RecommendedResources({ classroom }: { classroom: ClassroomContext | null }) {
  const resources = classroom?.recommended ?? [];
  return (
    <div className="space-y-3">
      {resources.map((resource) => (
        <div key={resource.title} className="rounded-lg bg-[var(--a3-surface-muted)] p-3">
          <div className="text-sm font-medium text-[var(--a3-text)]">{resource.title}</div>
          <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{resource.meta}</div>
        </div>
      ))}
      {!resources.length && <p className="text-sm text-[var(--a3-text-muted)]">暂无推荐资源。</p>}
    </div>
  );
}

function Quiz({ target, session, feedback, feedbackQuestionId, error, lastAnswer, loading, submitting, onAnswer }: { target?: string; session: AssessmentSession | null; feedback: AnswerFeedback | null; feedbackQuestionId: string | null; error: string; lastAnswer: string; loading: boolean; submitting: boolean; onAnswer: (answer: string) => void }) {
  if (loading) {
    return <div className="flex items-center gap-2 rounded-lg bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]"><Loader2 className="size-4 animate-spin text-blue-600" />正在同步题库测验...</div>;
  }
  if (!session) {
    return <p className="rounded-lg bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]">题库暂不可用，请确认后端题库数据已初始化。</p>;
  }
  if (!session.currentQuestion) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700">本轮随堂测验已完成，当前得分 {session.score} 分。答题记录已同步到学习报告。</div>
        {feedback?.explanation && <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3 text-sm leading-6 text-[var(--a3-text-muted)]">最近一题解析：{feedback.explanation}</div>}
      </div>
    );
  }
  const question = session.currentQuestion;
  return (
    <div data-testid="a3-coaching-quiz">
      <div className="mb-3 flex items-center justify-between text-xs text-[var(--a3-text-muted)]">
        <span>{target ? `围绕《${target}》抽题` : '随堂题库抽题'}</span>
        <span>{session.answeredCount + 1} / {session.totalQuestions}</span>
      </div>
      <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3">
        <div className="text-xs font-medium text-blue-600">{question.knowledgePoint.title} / 难度 {question.difficulty}</div>
        <div className="mt-2 text-sm leading-6 text-[var(--a3-text)]" data-testid="a3-coaching-quiz-question">{question.stem}</div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        {question.options.map((option) => (
          <button key={option.key} type="button" data-testid="a3-coaching-quiz-option" disabled={submitting} onClick={() => onAnswer(option.key)} className={cn('rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-70', feedbackQuestionId === question.id && feedback?.selectedAnswer === option.key && (feedback.isCorrect ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-rose-300 bg-rose-50 text-rose-700'))}>
            <span className="font-semibold">{option.key}.</span> {option.text}
          </button>
        ))}
      </div>
      {submitting && <div className="mt-3 flex items-center gap-2 text-sm text-blue-600"><Loader2 className="size-4 animate-spin" />正在判分...</div>}
      {error && (
        <div className="mt-3 rounded-lg bg-rose-50 p-3 text-sm leading-6 text-rose-700" data-testid="a3-coaching-quiz-error">
          <div className="font-semibold">{error}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button data-testid="a3-coaching-quiz-retry" size="sm" variant="outline" disabled={!lastAnswer || submitting} onClick={() => onAnswer(lastAnswer)}>重新提交</Button>
            <Button asChild size="sm" variant="outline"><Link href="/a3/assessment">去练习页</Link></Button>
          </div>
        </div>
      )}
      {feedback && (
        <div className={cn('mt-3 rounded-lg p-3 text-sm leading-6', feedback.isCorrect ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" />{feedback.isCorrect ? '回答正确' : `回答错误，正确答案是 ${feedback.correctAnswer}`}</div>
          {feedback.explanation && <div className="mt-2">{feedback.explanation}</div>}
          {!feedback.isCorrect && feedback.errorCause && <div className="mt-1">易错原因：{feedback.errorCause}</div>}
        </div>
      )}
    </div>
  );
}

function SessionSummary({ target, messages, sessionUpdatedAt }: { target?: string; messages: TranscriptMessage[]; sessionUpdatedAt: string }) {
  const userQuestions = messages.filter((message) => message.role === 'user');
  const verifiedReplies = messages.filter((message) => message.role === 'assistant' && message.verified).length;
  return (
    <div className="space-y-3 text-sm text-[var(--a3-text)]">
      <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3">本次主题：{target ?? '待同步学习目标'}</div>
      <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3">已完成 {userQuestions.length} 次有效提问，{verifiedReplies} 条回答完成引用验证。</div>
      {sessionUpdatedAt && <div className="rounded-lg bg-emerald-50 p-3 text-emerald-700">记录已保存：{formatTime(sessionUpdatedAt)}</div>}
      {userQuestions.length > 0 ? userQuestions.slice(-3).map((message) => <div key={message.id} className="flex gap-2"><span className="text-blue-600">-</span><span>{message.content}</span></div>) : <p className="text-[var(--a3-text-muted)]">完成提问后，这里会整理本次辅导要点。</p>}
    </div>
  );
}
