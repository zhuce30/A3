'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  RefreshCw,
  Send,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { AnswerFeedback, AssessmentSession } from '@/lib/a3/assessment-types';
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import { useBrowserASR } from '@/lib/hooks/use-browser-asr';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';
import { commitRealtimeEndedSession, createCoachingSessionLoader } from './coaching/coaching-session-loader';
import { RealtimeCoachingCall } from './coaching/realtime-coaching-call';
import { isTutorFeedbackVisible, TutorFeedbackPanel } from './coaching/tutor-feedback-panel';
import { TutorPersonaSelector } from './tutor-persona/tutor-persona-selector';
import { useTutorPersona } from './tutor-persona/use-tutor-persona';
import type { A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';

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
  modelRuntime?: ModelRuntime;
  createdAt?: string;
};

type Citation = { id?: string; title?: string; location?: string; type?: string; sourceTypeLabel?: string; sourceOrigin?: string; score?: number | null; snippet?: string };
type Claim = { id: string; text: string; verified: boolean; overlap?: number; citation?: Citation | null };
type SafetyStatus = { safe: boolean; category: string; reason: string };
type ModelRuntime = { provider?: string; model?: string; fallback?: boolean };

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
type CoachingReplyResponse = {
  success: boolean;
  error?: string;
  reply?: string;
  verified?: boolean;
  citations?: Citation[];
  claims?: Claim[];
  safety?: SafetyStatus | null;
  refusalReason?: string;
  degraded?: boolean;
  modelRuntime?: ModelRuntime;
};
type CoachingNotice = {
  text: string;
  tone: 'error' | 'success';
  recovery?: 'camera' | 'microphone' | 'vision' | 'respond' | 'saved';
};

const tabs = ['知识溯源', '推荐资源', '随堂测验', '课堂总结'] as const;

export function CoachingView() {
  const tutorPersona = useTutorPersona();
  const [classroom, setClassroom] = useState<ClassroomContext | null>(null);
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('知识溯源');
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [coachingSessions, setCoachingSessions] = useState<CoachingSessionRow[]>([]);
  const [viewingSessionId, setViewingSessionId] = useState('');
  const [feedbackSession, setFeedbackSession] = useState<CoachingSessionRow | null>(null);
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
  const sessionLoaderRef = useRef<ReturnType<typeof createCoachingSessionLoader<CoachingSessionResponse>> | null>(null);
  if (sessionLoaderRef.current == null) {
    sessionLoaderRef.current = createCoachingSessionLoader((sessionId) => (
      a3GetJson<CoachingSessionResponse>(`/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/`)
    ));
  }

  useEffect(() => {
    let mounted = true;
    async function load() {
      const assessmentRequest = a3GetJson<AssessmentResponse>('/api/assessments/current/');
      void assessmentRequest.then((assessment) => {
        if (!mounted) return;
        if (assessment.success) setQuizSession(assessment.session);
        setQuizLoading(false);
      });
      const [classroomResult, sessionResult, sessionsResult] = await Promise.all([
        a3GetJson<ClassroomResponse>('/api/learning/classroom/'),
        a3GetJson<CoachingSessionResponse>('/api/learning/coaching/session/'),
        a3GetJson<CoachingSessionsResponse>('/api/learning/coaching/sessions/?limit=20'),
      ]);
      if (!mounted) return;
      if (classroomResult.success) {
        setClassroom(classroomResult.classroom);
      }

      const persisted = sessionResult.success ? sessionResult.session?.messages ?? [] : [];
      setSessionUpdatedAt(sessionResult.success ? sessionResult.session?.updatedAt ?? '' : '');
      const welcomeMessage = buildWelcomeMessage(classroomResult.success ? classroomResult.classroom : null);
      setMessages(persisted.length ? persisted : [welcomeMessage]);
      setCoachingSessions(sessionsResult.success ? sessionsResult.sessions : []);
      setViewingSessionId('');
      const currentSession = sessionResult.success ? sessionResult.session : undefined;
      setFeedbackSession(currentSession?.id ? { id: currentSession.id, status: currentSession.status ?? 'active' } : null);
    }
    load();
    return () => {
      mounted = false;
      sessionLoaderRef.current?.dispose();
    };
  }, []);

  const target = classroom?.target;

  async function viewCoachingSession(sessionId: string) {
    window.speechSynthesis?.cancel();
    await sessionLoaderRef.current?.load(sessionId, (result) => {
      if (!result.success || !result.session) return;
      setViewingSessionId(sessionId);
      setFeedbackSession({ id: sessionId, status: result.session.status ?? 'active' });
      setMessages(result.session.messages.length ? result.session.messages : [buildWelcomeMessage(classroom)]);
      setSessionUpdatedAt(result.session.updatedAt ?? '');
    });
  }

  const handleRealtimeSessionEnded = useCallback((sessionId: string) => {
    commitRealtimeEndedSession(sessionLoaderRef.current, sessionId, (endedSessionId) => {
      setViewingSessionId(endedSessionId);
      setFeedbackSession({ id: endedSessionId, status: 'ended' });
      setCoachingSessions((sessions) => {
        const matched = sessions.some((session) => session.id === endedSessionId);
        if (matched) {
          return sessions.map((session) => (
            session.id === endedSessionId ? { ...session, status: 'ended' } : session
          ));
        }
        return [{ id: endedSessionId, status: 'ended', topicTitle: target?.title }, ...sessions];
      });
    });
  }, [target?.title]);

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
        <div className="mb-4">
          <TutorPersonaSelector
            personas={tutorPersona.personas}
            selectedPersonaId={tutorPersona.selectedPersonaId}
            recommendedPersonaId={tutorPersona.recommendedPersonaId}
            loading={tutorPersona.loading}
            saving={tutorPersona.saving}
            error={tutorPersona.error}
            onSelect={tutorPersona.selectPersona}
            onRetry={tutorPersona.reload}
          />
        </div>
        <RealtimeCoachingCall
          tutorPersonaId={tutorPersona.selectedPersonaId}
          tutorAvatarAsset={tutorPersona.selectedPersona ? {
            assetId: tutorPersona.selectedPersona.avatarAssetId,
            publicPath: tutorPersona.selectedPersona.avatarPublicPath,
          } : undefined}
          onSessionEnded={handleRealtimeSessionEnded}
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
        {isTutorFeedbackVisible(feedbackSession) && (
          <TutorFeedbackPanel key={feedbackSession?.id} sessionId={feedbackSession?.id ?? ''} />
        )}
        <CoachingTextWorkspace target={target} personaId={tutorPersona.selectedPersonaId} />
      </div>
    </div>
  );
}

const coachingSuggestions = [
  { label: '举例说明', question: '请结合当前学习目标举一个具体例子。' },
  { label: '分步骤解释', question: '可以分步骤解释一下吗？' },
  { label: '常见考法', question: '请说明这个知识点的常见考法和易错点。' },
] as const;

function CoachingTextWorkspace({
  target,
  personaId,
}: {
  target?: ClassroomContext['target'];
  personaId: A3TutorPersonaId | '';
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [visualLoading, setVisualLoading] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [voiceConversationMode, setVoiceConversationMode] = useState(false);
  const [savingNoteId, setSavingNoteId] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  const [notice, setNotice] = useState<CoachingNotice | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const browserASR = useBrowserASR({
    language: 'zh-CN',
    interimResults: true,
    onTranscription: (text) => {
      setInput(text);
      setVoiceConversationMode(false);
      void askQuestion(text);
    },
    onError: () => {
      setVoiceConversationMode(false);
      setNotice({ text: '麦克风或浏览器实时语音识别不可用，请检查权限后重试，或切换为文字提问。', tone: 'error', recovery: 'microphone' });
    },
  });

  useEffect(() => () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function startMedia() {
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = stream;
      setMediaReady(stream.getVideoTracks().length > 0);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch {
      setMediaReady(false);
      setNotice({ text: '无法开启摄像头或麦克风，请检查浏览器权限后重试。', tone: 'error', recovery: 'camera' });
    }
  }

  async function startVoiceInput() {
    if (browserASR.isListening) {
      browserASR.stopListening();
      setVoiceConversationMode(false);
      return;
    }
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!browserASR.isSupported) {
        setNotice({ text: '当前浏览器不支持实时语音识别，请使用上方实时通话或切换为文字提问。', tone: 'error', recovery: 'microphone' });
        return;
      }
      setVoiceConversationMode(true);
      browserASR.startListening();
      setNotice({ text: '已开启实时语音，请直接说出问题；识别完成后会自动提交辅导请求。', tone: 'success' });
    } catch {
      setNotice({ text: '麦克风权限不可用，请授权后重试，或切换为文字提问。', tone: 'error', recovery: 'microphone' });
    }
  }

  async function askQuestion(question = input) {
    const normalized = question.trim();
    if (!normalized || asking) return;
    const userMessage: TranscriptMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: normalized,
      createdAt: new Date().toISOString(),
    };
    setLastQuestion(normalized);
    setInput('');
    setNotice(null);
    setAsking(true);
    setMessages((current) => [...current, userMessage]);
    try {
      const response = await fetch('/api/a3/coaching/respond', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: normalized,
          personaId,
          history: messages.map(({ role, content }) => ({ role, content })),
        }),
      });
      const result = await response.json().catch(() => ({})) as CoachingReplyResponse;
      if (!response.ok || !result.success || !result.reply) throw new Error(result.error || 'AI 辅导服务暂时不可用');
      const assistantMessage: TranscriptMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.reply,
        verified: Boolean(result.verified),
        citations: result.citations ?? [],
        claims: result.claims ?? [],
        safety: result.safety,
        refusalReason: result.refusalReason ?? '',
        degraded: Boolean(result.degraded || result.modelRuntime?.fallback),
        modelRuntime: result.modelRuntime,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, assistantMessage]);
      void a3PostJson('/api/learning/coaching/session/', {
        messages: [userMessage, assistantMessage],
        summary: `围绕${target?.title ? `“${target.title}”` : '当前目标'}完成文字辅导。`,
        tutorPersonaId: personaId,
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'AI 辅导服务暂时不可用',
        tone: 'error',
        recovery: 'respond',
      });
    } finally {
      setAsking(false);
    }
  }

  async function capturePhotoQuestion() {
    const stream = mediaStreamRef.current;
    if (!mediaReady || !stream?.getVideoTracks().length) {
      setNotice({ text: '请先开启摄像头，再拍照提问。', tone: 'error', recovery: 'camera' });
      return;
    }
    setVisualLoading(true);
    setNotice(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current?.videoWidth || 640;
      canvas.height = videoRef.current?.videoHeight || 480;
      const context = canvas.getContext('2d');
      if (context && videoRef.current) context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
      const response = await fetch('/api/a3/coaching/vision', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.8), message: '请识别画面中的题目并分步骤讲解。' }),
      });
      const result = await response.json().catch(() => ({})) as CoachingReplyResponse;
      if (!response.ok || !result.success || !result.reply) throw new Error(result.error || '视觉辅导服务暂时不可用');
      const userMessage: TranscriptMessage = { id: crypto.randomUUID(), role: 'user', content: '[拍照提问] 请识别画面中的题目并分步骤讲解。' };
      const assistantMessage: TranscriptMessage = {
        id: crypto.randomUUID(), role: 'assistant', content: result.reply, verified: Boolean(result.verified),
        citations: result.citations ?? [], claims: result.claims ?? [], safety: result.safety, refusalReason: result.refusalReason ?? '',
      };
      setMessages((current) => [...current, userMessage, assistantMessage]);
      void a3PostJson('/api/learning/coaching/session/', {
        messages: [userMessage, assistantMessage],
        tutorPersonaId: personaId,
      });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : '视觉辅导服务暂时不可用', tone: 'error', recovery: 'vision' });
    } finally {
      setVisualLoading(false);
    }
  }

  async function saveAsNote(message: TranscriptMessage) {
    setSavingNoteId(message.id);
    setNotice(null);
    const result = await a3PostJson<FavoriteResponse>('/api/engagement/favorites/create/', {
      type: 'note',
      title: `辅导笔记：${target?.title ?? 'AI 辅导回答'}`,
      source: message.verified ? 'AI 辅导 / VerifierAgent 已验证' : 'AI 辅导 / 未验证回答',
      url: '/a3/coaching',
      group: 'AI 辅导笔记',
      metadata: {
        content: message.content,
        target,
        verified: message.verified,
        citations: message.citations ?? [],
        claims: message.claims ?? [],
      },
    });
    setSavingNoteId('');
    setNotice({
      text: result.success ? '已保存为辅导笔记，可前往我的收藏继续复习。' : result.error ?? '辅导笔记保存失败',
      tone: result.success ? 'success' : 'error',
      recovery: result.success ? 'saved' : undefined,
    });
  }

  function focusTextInput() {
    inputRef.current?.focus();
  }

  return (
    <section className="mt-5 border-t border-slate-200 pt-5" data-testid="a3-coaching-text-workspace">
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-[var(--a3-text)]">文字与拍照辅导</h2>
              <p className="mt-1 text-sm text-[var(--a3-text-muted)]">围绕当前目标提问，回答会展示引用验证并写入辅导历史。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={startMedia}><Camera className="size-4" />开启音视频</Button>
              <Button data-testid="a3-coaching-photo-question" type="button" size="sm" variant="outline" disabled={visualLoading} onClick={capturePhotoQuestion}>
                {visualLoading ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}拍照提问
              </Button>
              <Button data-testid="a3-coaching-voice-input" type="button" size="sm" variant="outline" onClick={startVoiceInput}><Mic className="size-4" />语音输入</Button>
            </div>
          </div>
          <video ref={videoRef} autoPlay playsInline muted className="sr-only" aria-hidden="true" />
          <div className="mt-4 flex flex-wrap gap-2">
            {coachingSuggestions.map((suggestion) => (
              <Button key={suggestion.label} data-testid="a3-coaching-suggestion" type="button" size="sm" variant="outline" disabled={asking} onClick={() => askQuestion(suggestion.question)}>{suggestion.question}</Button>
            ))}
          </div>
          <div className="mt-4 max-h-[520px] space-y-3 overflow-auto" aria-live="polite">
            {messages.length ? messages.map((message) => (
              <div key={message.id} data-testid={`a3-coaching-message-${message.role}`} className={cn('rounded-xl px-4 py-3 text-sm leading-6', message.role === 'assistant' ? 'bg-slate-100 text-slate-900' : 'ml-auto max-w-[85%] bg-blue-600 text-white')}>
                <div className="text-xs font-semibold opacity-70">{message.role === 'assistant' ? 'CoachAgent' : '你'}</div>
                <div className="mt-1">
                  {message.role === 'assistant' ? <A3Markdown>{message.content}</A3Markdown> : <p className="whitespace-pre-wrap">{message.content}</p>}
                </div>
                {message.role === 'assistant' && message.modelRuntime && (
                  <div className={cn('mt-2 text-xs font-medium', message.modelRuntime.fallback ? 'text-amber-700' : 'text-emerald-700')}>
                    {message.modelRuntime.fallback ? '规则降级' : '模型已接入'} · {message.modelRuntime.provider || 'unknown'} · {message.modelRuntime.model || '未返回模型名'}
                  </div>
                )}
                {message.role === 'assistant' && message.verified !== undefined && <CoachingVerification message={message} />}
                {message.role === 'assistant' && (
                  <Button type="button" size="sm" variant="outline" className="mt-3 bg-white" disabled={savingNoteId === message.id} onClick={() => saveAsNote(message)}>
                    {savingNoteId === message.id ? <Loader2 className="size-4 animate-spin" /> : <Star className="size-4" />}存为笔记
                  </Button>
                )}
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-[var(--a3-text-muted)]">选择一个追问方向，或输入你当前卡住的问题。</div>
            )}
          </div>
          {notice && (
            <div data-testid="a3-coaching-error" className={cn('mt-4 rounded-xl px-4 py-3 text-sm leading-6', notice.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
              <div>{notice.text}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {notice.recovery === 'camera' && <Button data-testid="a3-coaching-start-media-from-error" type="button" size="sm" variant="outline" onClick={startMedia}>开启摄像头</Button>}
                {notice.recovery === 'microphone' && <Button data-testid="a3-coaching-retry-microphone" type="button" size="sm" variant="outline" onClick={startVoiceInput}><RefreshCw className="size-4" />重试麦克风</Button>}
                {notice.recovery === 'vision' && <Button data-testid="a3-coaching-retry-vision" type="button" size="sm" variant="outline" onClick={capturePhotoQuestion}><RefreshCw className="size-4" />重试视觉辅导</Button>}
                {(notice.recovery === 'microphone' || notice.recovery === 'vision') && <Button data-testid="a3-coaching-text-fallback" type="button" size="sm" variant="outline" onClick={focusTextInput}>切换文字提问</Button>}
                {notice.recovery === 'respond' && <Button data-testid="a3-coaching-retry-last-question" type="button" size="sm" variant="outline" disabled={!lastQuestion || asking} onClick={() => askQuestion(lastQuestion)}><RefreshCw className="size-4" />重试上次问题</Button>}
                {notice.recovery === 'respond' && <Button asChild size="sm" variant="outline"><Link data-testid="a3-coaching-open-classroom" href="/a3/classroom">转到 AI 课堂</Link></Button>}
                {notice.recovery === 'saved' && <Button asChild size="sm" variant="outline"><Link data-testid="a3-coaching-open-favorites" href="/a3/favorites">打开我的收藏</Link></Button>}
              </div>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} rows={2} maxLength={2000} placeholder="输入问题，CoachAgent 将结合当前目标和知识库回答" className="min-w-0 flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400" />
            <Button type="button" disabled={!input.trim() || asking} onClick={() => askQuestion()}>{asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}发送</Button>
          </div>
          {voiceConversationMode && (
            <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700" aria-live="polite">
              {browserASR.interimTranscript || '正在聆听，请说出你的问题...'}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ShieldCheck className="size-4 text-emerald-600" />回答质量规则</div>
          <p className="mt-2 text-xs leading-5 text-slate-600">有本地证据时展示引用与验证状态；证据不足时明确标记未验证；安全请求由 SafetyAgent 拦截。</p>
        </div>
      </div>
    </section>
  );
}

function CoachingVerification({ message }: { message: TranscriptMessage }) {
  const partial = !message.verified && message.refusalReason === 'claim_not_supported' && Boolean(message.citations?.length);
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700" data-testid="a3-coaching-verification">
      <div className="font-semibold text-slate-900">{message.verified ? 'VerifierAgent 已验证' : partial ? '部分待核验' : '未验证'}</div>
      {message.safety && !message.safety.safe && (
        <div className="mt-2 rounded-lg bg-rose-50 p-2 text-rose-700" data-testid="a3-coaching-safety-status">
          <div className="font-semibold">SafetyAgent 已拦截 · {message.safety.category}</div>
          <div>{message.refusalReason || message.safety.reason}</div>
          <div className="mt-1 font-semibold">合规替代：可拆解考点、生成练习并解释错因。</div>
        </div>
      )}
      {message.citations?.length ? (
        <div className="mt-2 space-y-1">
          {message.citations.slice(0, 3).map((citation, index) => <div key={`${citation.id || citation.title}-${index}`}>[{index + 1}] {citation.title || '知识库来源'} · {citation.location || '本地知识库'}</div>)}
        </div>
      ) : <div className="mt-1 text-slate-500">暂无可展示引用。</div>}
      {message.claims?.length ? (
        <div className="mt-2 space-y-2">
          {message.claims.slice(0, 3).map((claim) => (
            <div key={claim.id} className={cn('rounded-lg p-2', claim.verified ? 'bg-emerald-50 text-emerald-900' : 'bg-orange-50 text-orange-900')}>
              <A3Markdown className="text-xs leading-6">{claim.text}</A3Markdown>
            </div>
          ))}
        </div>
      ) : null}
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
