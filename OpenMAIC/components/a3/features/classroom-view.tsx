'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, ClipboardCheck, ExternalLink, FileText, Image as ImageIcon, Library, Loader2, Mic, MicOff, RefreshCw, Route, Send, Settings, ShieldCheck, Star, Target, UploadCloud, UserRound, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProfileUpdateCandidatePanel } from '@/components/a3/profile/profile-update-candidate-panel';
import { a3GetJson, a3PostJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import type { AnswerFeedback, AssessmentSession } from '@/lib/a3/assessment-types';
import { buildPracticeSyncEvidence, buildPracticeWritebackPayload, findPracticePlanTaskForRecommendation } from '@/lib/a3/classroom-practice';
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import { buildClassroomContextInsight } from '@/lib/a3/learning-flow-insights';
import type { A3ApiResponse, StudyPlan, StudyPlanTaskFeedback } from '@/lib/a3/learning-types';
import type { DynamicProfileFeedResponse } from '@/lib/a3/profile-timeline';
import type { A3OpenMAICClassroomArtifact, A3ResourcePacksResponse } from '@/lib/a3/recommendation-types';
import { normalizeASRUploadAudio } from '@/lib/audio/wav-utils';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';
import { A3SpeechControls } from '../ui/a3-speech-controls';

type ClassroomResponse = { success: boolean; error?: string; classroom: ClassroomContext };
type FavoriteResponse = { success: boolean; error?: string };
type Citation = { id?: string; title?: string; location?: string; type?: string; sourceTypeLabel?: string; sourceOrigin?: string; sourceScope?: string; score?: number | null; snippet?: string; previewUrl?: string };
type Claim = { id: string; text: string; verified: boolean; overlap?: number; citation?: Citation | null };
type SafetyStatus = { safe: boolean; category: string; reason: string };
type FollowUpSuggestion = { label: string; question: string; type: string; reason?: string };
type ClassroomRetrievalMode = 'fast' | 'deep';
type ClassroomRetrievalScope = 'all' | 'personal' | 'teacher' | 'class' | 'global';
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  verified?: boolean;
  citations?: Citation[];
  claims?: Claim[];
  safety?: SafetyStatus;
  refusalReason?: string;
  degraded?: boolean;
  retrievalMode?: string;
  traceId?: string;
  followUps?: FollowUpSuggestion[];
  createdAt?: string;
};
type CoachingResponse = {
  success: boolean;
  reply?: string;
  error?: string;
  verified?: boolean;
  citations?: Citation[];
  claims?: Claim[];
  safety?: SafetyStatus;
  refusalReason?: string;
  degraded?: boolean;
  retrievalMode?: string;
  traceId?: string;
  followUps?: FollowUpSuggestion[];
};
type ClassroomHistorySession = { id: string; title: string; summary?: string; messageCount?: number; messages: ChatMessage[]; updatedAt?: string };
type ClassroomHistoryResponse = { success: boolean; error?: string; messages: ChatMessage[]; sessions?: ClassroomHistorySession[]; activeSessionId?: string };
type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan; feedback?: StudyPlanTaskFeedback }>;
type AssessmentStartResponse = A3ApiResponse<{ session: AssessmentSession }>;
type AssessmentGradeResponse = A3ApiResponse<AnswerFeedback>;
type EmbeddedPracticeState = {
  key: string;
  href: string;
  session: AssessmentSession;
  selectedAnswer: string;
  feedback: AnswerFeedback | null;
  planFeedback: StudyPlanTaskFeedback | null;
  error: string;
  starting: boolean;
  submitting: boolean;
};
type ClassroomImageAttachment = {
  type: 'image';
  name: string;
  mediaType: string;
  dataUrl: string;
  size: number;
};
type TranscriptionResponse = { success?: boolean; text?: string; error?: string; details?: string };

const MAX_CLASSROOM_IMAGE_BYTES = 6 * 1024 * 1024;
const CLASSROOM_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const CLASSROOM_ASR_PROVIDER_ID = 'qwen-asr';
const CLASSROOM_ASR_MODEL_ID = 'qwen3-asr-flash';

function appendVoiceTranscript(current: string, transcript: string) {
  const normalized = transcript.trim();
  if (!normalized) return current;
  const separator = current.trim() ? (/[，。！？,.!?]$/.test(current.trim()) ? ' ' : '，') : '';
  return `${current.trim()}${separator}${normalized}`;
}

function buildClassroomWelcomeMessage(target: ClassroomContext['target'] | null | undefined): ChatMessage {
  return {
    id: 'welcome',
    role: 'assistant',
    content: target
      ? '我们现在学习《' + target.title + '》。我会先讲清概念，再结合本地知识库和错题记录安排练习。'
      : '请先生成学习路径，系统会根据当前节点创建 AI 课堂。',
  };
}

export function ClassroomView() {
  const [classroom, setClassroom] = useState<ClassroomContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [savingNoteId, setSavingNoteId] = useState('');
  const [savingSourceId, setSavingSourceId] = useState('');
  const [sourceFavoriteMessage, setSourceFavoriteMessage] = useState('');
  const [sourceFavoriteSuccess, setSourceFavoriteSuccess] = useState(false);
  const [openmaicClassroomArtifact, setOpenmaicClassroomArtifact] = useState<A3OpenMAICClassroomArtifact | null>(null);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [savingPracticeId, setSavingPracticeId] = useState('');
  const [practiceFeedback, setPracticeFeedback] = useState<StudyPlanTaskFeedback | null>(null);
  const [embeddedPractice, setEmbeddedPractice] = useState<EmbeddedPracticeState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [classroomSessions, setClassroomSessions] = useState<ClassroomHistorySession[]>([]);
  const [viewingHistoryId, setViewingHistoryId] = useState('');
  const [imageAttachment, setImageAttachment] = useState<ClassroomImageAttachment | null>(null);
  const [imageAttachmentError, setImageAttachmentError] = useState('');
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [retrievalMode, setRetrievalMode] = useState<ClassroomRetrievalMode>('fast');
  const [retrievalScope, setRetrievalScope] = useState<ClassroomRetrievalScope>('all');
  const [profileFeed, setProfileFeed] = useState<DynamicProfileFeedResponse | null>(null);
  const chatRef = useRef(chat);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const hasUserQuestion = chat.some((item) => item.role === 'user');
  const hasAssistantAnswer = chat.some((item) => (
    item.role === 'assistant'
    && item.id !== 'welcome'
    && (
      Boolean(item.traceId)
      || Boolean(item.citations?.length)
      || Boolean(item.claims?.length)
      || Boolean(item.followUps?.length)
    )
  ));
  const showLessonRunway = !viewingHistoryId && !hasUserQuestion && !hasAssistantAnswer;

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    setVoiceSupported(Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined');
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      voiceStreamRef.current = null;
    };
  }, []);

  const loadClassroom = useCallback(async () => {
    setLoading(true);
    const [result, packsResult, historyResult, planResult, profileFeedResult] = await Promise.all([
      a3GetJson<ClassroomResponse>('/api/learning/classroom/'),
      a3GetJson<A3ResourcePacksResponse>('/api/resources/packs/'),
      a3GetJson<ClassroomHistoryResponse>('/api/learning/classroom/history/'),
      a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1'),
      a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/'),
    ]);
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '课堂上下文加载失败');
      return;
    }
    if (packsResult.success) {
      setOpenmaicClassroomArtifact(findLatestOpenMAICClassroomArtifact(packsResult.resourcePacks));
    }
    if (planResult.success) setStudyPlan(planResult.plan);
    if (profileFeedResult.success) setProfileFeed(profileFeedResult);
    setClassroom(result.classroom);
    setMessage('');
    const target = result.classroom.target;
    const restoredMessages = historyResult.success ? normalizeClassroomMessages(historyResult.messages) : [];
    setClassroomSessions(historyResult.success ? normalizeClassroomSessions(historyResult.sessions ?? []) : []);
    setViewingHistoryId('');
    setChat((current) => current.length ? current : (restoredMessages.length ? restoredMessages : [buildClassroomWelcomeMessage(target)]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadClassroom();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadClassroom]);

  async function askQuestion(question = input) {
    const normalized = question.trim() || (imageAttachment ? '请解答图片里的题目，并说明关键步骤。' : '');
    if (!normalized || asking) return;
    const attachmentForRequest = imageAttachment;
    setInput('');
    setAsking(true);
    setMessage('');
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: attachmentForRequest ? `${normalized}\n\n[图片附件：${attachmentForRequest.name}]` : normalized,
      createdAt: new Date().toISOString(),
    };
    setChat((current) => [...current, userMessage]);
    try {
      const response = await fetch('/api/a3/coaching/respond', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: normalized,
          history: chatRef.current.map(({ role, content }) => ({ role, content })),
          mode: retrievalMode,
          scope: retrievalScope,
          attachments: imageAttachment ? [{
            type: 'image',
            name: imageAttachment.name,
            mediaType: imageAttachment.mediaType,
            dataUrl: imageAttachment.dataUrl,
          }] : undefined,
        }),
      });
      const result = await response.json() as CoachingResponse;
      if (!response.ok || !result.success || !result.reply) throw new Error(result.error || 'AI 课堂回复失败');
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.reply!,
        verified: Boolean(result.verified),
        citations: result.citations ?? [],
        claims: result.claims ?? [],
        safety: result.safety,
        refusalReason: result.refusalReason ?? '',
        degraded: Boolean(result.degraded),
        retrievalMode: result.retrievalMode ?? '',
        traceId: result.traceId ?? '',
        followUps: Array.isArray(result.followUps) ? result.followUps : [],
        createdAt: new Date().toISOString(),
      };
      setChat((current) => [...current, assistantMessage]);
      void a3PostJson('/api/learning/classroom/history/', { messages: [userMessage, assistantMessage] });
      const feedResponse = await a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/');
      if (feedResponse.success) setProfileFeed(feedResponse);
      setImageAttachment(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'AI 课堂服务暂时不可用');
    } finally {
      setAsking(false);
    }
  }

  function stopVoiceInput() {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      return;
    }
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaRecorderRef.current = null;
    voiceStreamRef.current = null;
    setVoiceListening(false);
    setVoiceDraft('');
  }

  async function transcribeClassroomAudio(audioBlob: Blob) {
    setVoiceTranscribing(true);
    setVoiceError('');
    setVoiceDraft('正在调用阿里云语音识别...');
    try {
      const uploadAudio = await normalizeASRUploadAudio(CLASSROOM_ASR_PROVIDER_ID, audioBlob);
      const formData = new FormData();
      formData.append('audio', uploadAudio.blob, uploadAudio.fileName);
      formData.append('providerId', CLASSROOM_ASR_PROVIDER_ID);
      formData.append('modelId', CLASSROOM_ASR_MODEL_ID);
      formData.append('language', 'zh');
      const response = await fetch('/api/transcription', {
        method: 'POST',
        body: formData,
      });
      const result = await response.json().catch(() => ({})) as TranscriptionResponse;
      if (!response.ok || result.success === false) {
        throw new Error(result.details || result.error || '语音识别接口调用失败');
      }
      const text = result.text?.trim();
      if (!text) {
        setVoiceError('没有识别到有效语音，请靠近麦克风后重试。');
        return;
      }
      setInput((current) => appendVoiceTranscript(current, text));
      setMessage('已通过阿里云 ASR 识别语音，可继续编辑后发送。');
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : '语音识别失败，请重试或改用键盘输入。');
    } finally {
      setVoiceTranscribing(false);
      setVoiceDraft('');
    }
  }

  async function toggleVoiceInput() {
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    if (asking || voiceTranscribing || !target || viewingHistoryId) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceSupported(false);
      setVoiceError('当前浏览器不支持录音上传，请使用 Chrome 或 Edge，或改用键盘输入。');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      voiceChunksRef.current = [];
      voiceStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setVoiceError('录音失败，请检查麦克风设备后重试。');
        setVoiceListening(false);
      };
      recorder.onstop = () => {
        const chunks = voiceChunksRef.current;
        voiceChunksRef.current = [];
        stream.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
        mediaRecorderRef.current = null;
        setVoiceListening(false);
        if (!chunks.length) {
          setVoiceError('没有录到声音，请重试。');
          setVoiceDraft('');
          return;
        }
        const audioBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        void transcribeClassroomAudio(audioBlob);
      };
      recorder.start();
      setVoiceListening(true);
      setVoiceDraft('正在录音，再点一次麦克风结束并识别。');
      setVoiceError('');
      setMessage('');
    } catch (error) {
      setVoiceListening(false);
      setVoiceDraft('');
      setVoiceError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '浏览器没有麦克风权限，请允许麦克风后再试。'
        : '录音启动失败，请检查麦克风权限和设备。');
    }
  }

  async function handleImageUpload(file?: File) {
    setImageAttachmentError('');
    if (!file) return;
    try {
      const attachment = await readImageAttachment(file);
      setImageAttachment(attachment);
    } catch (error) {
      setImageAttachment(null);
      setImageAttachmentError(error instanceof Error ? error.message : '图片读取失败，请重新选择。');
    }
  }

  function readImageAttachment(file: File): Promise<ClassroomImageAttachment> {
    if (!CLASSROOM_IMAGE_TYPES.has(file.type)) {
      return Promise.reject(new Error('仅支持 PNG、JPG、JPEG 或 WebP 图片。'));
    }
    if (file.size > MAX_CLASSROOM_IMAGE_BYTES) {
      return Promise.reject(new Error('图片不能超过 6MB，请压缩后再上传。'));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl.startsWith('data:image/')) {
          reject(new Error('图片格式不正确，请重新选择。'));
          return;
        }
        resolve({
          type: 'image',
          name: file.name,
          mediaType: file.type,
          dataUrl,
          size: file.size,
        });
      };
      reader.readAsDataURL(file);
    });
  }

  async function startNewClassroomDialogue() {
    if (asking) return;
    stopVoiceInput();
    window.speechSynthesis?.cancel();
    const welcomeMessage = buildClassroomWelcomeMessage(classroom?.target);
    setChat([welcomeMessage]);
    setViewingHistoryId('');
    setInput('');
    setImageAttachment(null);
    setImageAttachmentError('');
    if (imageInputRef.current) imageInputRef.current.value = '';
    const result = await a3PostJson<ClassroomHistoryResponse>('/api/learning/classroom/history/', { startNew: true });
    if (result.success) setClassroomSessions(normalizeClassroomSessions(result.sessions ?? []));
    setMessage(result.success ? '已新建课堂对话，之前的对话已保留在历史对话中。' : result.error ?? '新建对话失败，请稍后重试');
  }

  function viewClassroomHistory(session: ClassroomHistorySession) {
    stopVoiceInput();
    window.speechSynthesis?.cancel();
    setViewingHistoryId(session.id);
    setChat(normalizeClassroomMessages(session.messages));
    setInput('');
    setMessage('正在回看历史对话；如需继续提问，请新建对话。');
  }

  const target = classroom?.target;

  async function saveAsNote(item: ChatMessage) {
    if (item.role !== 'assistant') return;
    setSavingNoteId(item.id);
    setMessage('');
    const result = await a3PostJson<{ success: boolean; error?: string }>('/api/engagement/favorites/create/', {
      type: 'note',
      title: `课堂笔记：${target?.title ?? 'AI 课堂回答'}`,
      source: item.verified ? 'AI 课堂 / VerifierAgent 已验证' : 'AI 课堂 / 未验证回答',
      url: '/a3/classroom',
      group: 'AI 课堂笔记',
      metadata: {
        content: item.content,
        target,
        verified: item.verified,
        citations: item.citations ?? [],
        claims: item.claims ?? [],
      },
    });
    setSavingNoteId('');
    setMessage(result.success ? '已保存为课堂笔记，可在“我的收藏”中查看。' : result.error ?? '课堂笔记保存失败');
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
      url: '/a3/classroom',
      group: '知识库来源',
      metadata: {
        ...source,
        target,
      },
    });
    setSavingSourceId('');
    setSourceFavoriteSuccess(result.success);
    setSourceFavoriteMessage(result.success ? '已收藏知识库来源，可在“我的收藏”中查看。' : result.error ?? '知识库来源收藏失败');
  }

  async function completePracticeRecommendation(resource: ClassroomContext['recommended'][number]) {
    const match = findPracticePlanTaskForRecommendation(resource, studyPlan);
    if (!match || match.completed) return;
    setSavingPracticeId(resource.href);
    setMessage('');
    const response = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/tasks/complete/', {
      dayIndex: match.dayIndex,
      taskId: match.taskId,
    });
    setSavingPracticeId('');
    if (!response.success) {
      setMessage(response.error ?? '课堂练习回写失败，请到学习计划页确认任务状态。');
      return;
    }
    setStudyPlan(response.plan);
    setPracticeFeedback(response.feedback ?? response.plan.lastTaskFeedback ?? null);
    setMessage('推荐练习已完成，进度已回写到今日任务、学习计划和学习报告。');
  }

  async function startEmbeddedPractice(resource: ClassroomContext['recommended'][number]) {
    const key = classroomPracticeKey(resource);
    setEmbeddedPractice((current) => current?.key === key ? { ...current, starting: true, error: '' } : null);
    setMessage('');
    const result = await a3PostJson<AssessmentStartResponse>('/api/assessments/start/', {
      mode: 'practice',
      knowledgePoint: resource.title,
      limit: 1,
    });
    if (!result.success) {
      setEmbeddedPractice({
        key,
        href: resource.href,
        session: emptyAssessmentSession(resource.title),
        selectedAnswer: '',
        feedback: null,
        planFeedback: null,
        error: result.error ?? '课堂内练习启动失败，请进入测评页完成。',
        starting: false,
        submitting: false,
      });
      return;
    }
    setEmbeddedPractice({
      key,
      href: resource.href,
      session: result.session,
      selectedAnswer: '',
      feedback: null,
      planFeedback: null,
      error: '',
      starting: false,
      submitting: false,
    });
  }

  function selectEmbeddedPracticeAnswer(answer: string) {
    setEmbeddedPractice((current) => current ? { ...current, selectedAnswer: answer } : current);
  }

  async function submitEmbeddedPractice(resource: ClassroomContext['recommended'][number]) {
    if (!embeddedPractice?.session || !embeddedPractice.selectedAnswer) return;
    setEmbeddedPractice((current) => current ? { ...current, submitting: true, error: '' } : current);
    const grade = await a3PostJson<AssessmentGradeResponse>('/api/assess/grade/', {
      sessionId: embeddedPractice.session.id,
      selectedAnswer: embeddedPractice.selectedAnswer,
    });
    if (!grade.success) {
      setEmbeddedPractice((current) => current ? { ...current, submitting: false, error: grade.error ?? '课堂内练习判分失败' } : current);
      return;
    }

    let planFeedback: StudyPlanTaskFeedback | null = null;
    const writeback = buildPracticeWritebackPayload({ recommendation: resource, plan: studyPlan, graded: true });
    if (writeback) {
      const planResponse = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/tasks/complete/', writeback);
      if (planResponse.success) {
        setStudyPlan(planResponse.plan);
        planFeedback = planResponse.feedback ?? planResponse.plan.lastTaskFeedback ?? null;
        setPracticeFeedback(planFeedback);
      }
    }

    setEmbeddedPractice((current) => current ? {
      ...current,
      submitting: false,
      feedback: grade,
      planFeedback,
      session: grade.session,
      error: writeback || planFeedback ? '' : '已完成判分并同步错题/画像；未匹配到今日计划任务，未回写学习计划。',
    } : current);
  }

  return (
    <div className="grid gap-5 2xl:grid-cols-[340px_minmax(0,1fr)_390px]" data-testid="a3-classroom-view">
      <aside className="space-y-5 2xl:sticky 2xl:top-4 2xl:self-start">
        <CurrentTargetCard loading={loading} target={target ?? null} graphSummary={classroom?.graphSummary ?? null} />
        <ClassroomContextCard studyPlan={studyPlan} />
        <ClassroomHistoryCard sessions={classroomSessions} activeId={viewingHistoryId} onOpen={viewClassroomHistory} />
        <OpenMAICClassroomCard artifact={openmaicClassroomArtifact} />
        <AgentsCard classroom={classroom} />
      </aside>

      <section className="min-w-0 self-start rounded-[18px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-[var(--a3-shadow)]">
        <LessonHeader
          target={target ?? null}
          classroom={classroom}
          loading={loading}
          onRefresh={() => void loadClassroom()}
        />
        <div className="grid min-h-[640px] grid-rows-[auto_minmax(260px,1fr)_auto]">
          <LearningEvidenceStrip classroom={classroom} artifact={openmaicClassroomArtifact} />
          <div className="flex flex-col gap-5 overflow-y-auto px-5 py-6 md:px-7" data-testid="a3-classroom-dialogue">
            {showLessonRunway && (
              <LessonRunwayPanel
                target={target ?? null}
                asking={asking}
                sourceCount={classroom?.sources.length ?? 0}
                exerciseCount={classroom?.recommended.length ?? 0}
                onAsk={askQuestion}
              />
            )}
            {chat.map((item) => (
              <ChatBubble
                key={item.id}
                item={item}
                savingNoteId={savingNoteId}
                onSaveNote={saveAsNote}
                onFollowUp={(question) => void askQuestion(question)}
              />
            ))}
            {asking && (
              <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800" data-testid="a3-classroom-asking">
                <Loader2 className="size-4 animate-spin" />
                AI 正在结合学习目标、知识库引用和错题记录回答
              </div>
            )}
          </div>

          <div className="border-t border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-5 py-4 md:px-7">
            {message && <ClassroomMessage message={message} />}
            <div className="flex flex-wrap gap-2 pb-3">
              <RetrievalModeBar
                mode={retrievalMode}
                scope={retrievalScope}
                sources={classroom?.sources ?? []}
                disabled={asking || Boolean(viewingHistoryId)}
                onModeChange={setRetrievalMode}
                onScopeChange={setRetrievalScope}
              />
            </div>
            <div className="flex flex-wrap gap-2 pb-3">
              <Button data-testid="a3-classroom-new-dialogue" type="button" size="sm" variant="outline" disabled={asking} onClick={() => void startNewClassroomDialogue()}>
                <RefreshCw className="size-4" />
                新建对话
              </Button>
              {buildQuickPrompts(target ?? null).map((item) => (
                <Button key={item.label} size="sm" variant="outline" disabled={asking || !target} title={!target ? '请先生成学习路径目标' : item.detail} onClick={() => askQuestion(item.prompt)}>
                  {item.icon}
                  {item.label}
                </Button>
              ))}
            </div>
            {imageAttachment && (
              <div data-testid="a3-classroom-image-preview" className="mb-3 flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-2 text-xs text-blue-800">
                <div className="size-12 shrink-0 rounded-lg bg-cover bg-center" style={{ backgroundImage: `url(${imageAttachment.dataUrl})` }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{imageAttachment.name}</div>
                  <div>{Math.max(1, Math.round(imageAttachment.size / 1024))} KB</div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="a3-classroom-image-remove"
                  onClick={() => {
                    setImageAttachment(null);
                    setImageAttachmentError('');
                    if (imageInputRef.current) imageInputRef.current.value = '';
                  }}
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
            {imageAttachmentError && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{imageAttachmentError}</div>}
            {(voiceListening || voiceTranscribing || voiceDraft || voiceError || !voiceSupported) && (
              <div
                className={cn(
                  'mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
                  voiceError || !voiceSupported
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-blue-50 text-blue-800',
                )}
                data-testid="a3-classroom-voice-status"
              >
                {voiceTranscribing ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" /> : voiceListening ? <Mic className="mt-0.5 size-4 shrink-0" /> : <MicOff className="mt-0.5 size-4 shrink-0" />}
                <div className="min-w-0">
                  {voiceError || (!voiceSupported ? '当前浏览器不支持录音上传，请使用 Chrome 或 Edge，或改用键盘输入。' : '')}
                  {!voiceError && voiceSupported && voiceListening && !voiceDraft && '正在录音，再点一次麦克风结束并识别。'}
                  {!voiceError && voiceTranscribing && !voiceDraft && '正在调用阿里云语音识别。'}
                  {!voiceError && voiceDraft && (
                    <>
                      <span className="font-medium">{voiceTranscribing ? '转写中：' : '录音中：'}</span>
                      <span>{voiceDraft}</span>
                    </>
                  )}
                </div>
              </div>
            )}
            <form onSubmit={(event) => { event.preventDefault(); void askQuestion(); }} className="flex items-center gap-3">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                data-testid="a3-classroom-image-upload"
                onChange={(event) => void handleImageUpload(event.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                disabled={asking || !target}
                className="h-12 rounded-xl bg-white px-3"
                title="上传本地图片题目"
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={asking || voiceTranscribing || !target || Boolean(viewingHistoryId)}
                aria-pressed={voiceListening}
                data-testid="a3-classroom-voice-input"
                className={cn(
                  'h-12 rounded-xl px-3 transition',
                  voiceListening
                    ? 'border-blue-300 bg-blue-50 text-blue-700 shadow-[0_0_0_4px_rgba(59,130,246,0.12)]'
                    : 'bg-white',
                )}
                title={voiceListening ? '结束录音并识别' : '语音输入'}
                onClick={toggleVoiceInput}
              >
                {voiceTranscribing ? <Loader2 className="size-4 animate-spin" /> : voiceListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                data-testid="a3-classroom-input"
                className="h-12 flex-1 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-4 text-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                placeholder={target ? `围绕“${target.title}”提问，回答会进行引用验证` : '请先生成学习路径后再开始课堂提问'}
                disabled={!target || Boolean(viewingHistoryId)}
              />
              <Button data-testid="a3-classroom-submit" type="submit" disabled={asking || !target || Boolean(viewingHistoryId) || (!input.trim() && !imageAttachment)} className="h-12 rounded-xl bg-blue-600 px-4 hover:bg-blue-700">
                {asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </form>
          </div>
        </div>
      </section>

      <aside className="space-y-5 2xl:sticky 2xl:top-4 2xl:self-start">
        <div data-testid="a3-flow-profile-candidates">
          <ProfileUpdateCandidatePanel
            feed={profileFeed}
            profileHref="/a3/profile-setup"
            testId="a3-profile-update-candidate-panel"
            title="本次课堂问答让画像发生了变化"
            subtitle="课堂追问、讲解偏好和学习阻塞已生成画像候选，确认后会影响后续课堂讲解和资源推荐。"
          />
        </div>
        <SourcesCard
          classroom={classroom}
          target={target ?? null}
          savingSourceId={savingSourceId}
          sourceFavoriteMessage={sourceFavoriteMessage}
          sourceFavoriteSuccess={sourceFavoriteSuccess}
          onSaveSource={saveSourceFavorite}
        />
        <RecommendedPracticeCard
          classroom={classroom}
          studyPlan={studyPlan}
          savingPracticeId={savingPracticeId}
          practiceFeedback={practiceFeedback}
          embeddedPractice={embeddedPractice}
          onCompletePractice={completePracticeRecommendation}
          onStartEmbeddedPractice={startEmbeddedPractice}
          onSelectEmbeddedPracticeAnswer={selectEmbeddedPracticeAnswer}
          onSubmitEmbeddedPractice={submitEmbeddedPractice}
        />
        <NextActionsCard classroom={classroom} />
      </aside>
    </div>
  );
}

function LessonHeader({
  target,
  classroom,
  loading,
  onRefresh,
}: {
  target: ClassroomContext['target'];
  classroom: ClassroomContext | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="border-b border-[var(--a3-border)] px-5 py-5 md:px-7">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <A3Pill tone="blue">AI 多智能体课堂</A3Pill>
            {classroom?.course && <A3Pill tone="slate">{classroom.course.title}</A3Pill>}
            {target && <A3Pill tone={target.wrongCount ? 'orange' : 'green'}>{target.wrongCount ? '错题驱动' : '按路径推进'}</A3Pill>}
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-normal text-[var(--a3-text)] md:text-3xl">
            {target?.title ?? '等待学习路径目标'}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--a3-text-muted)]">
            {target
              ? target.reason || target.description || '围绕当前知识点进行讲解、追问、引用验证和练习推荐。'
              : '先生成个性化学习路径，课堂会自动读取当前节点、知识库引用、错题记录和推荐练习。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" className="bg-white">
            <Link href="/a3/learning-path">
              <Route className="size-4" />
              学习路径
            </Link>
          </Button>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading} className="bg-white">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新上下文
          </Button>
        </div>
      </div>
    </div>
  );
}

function RetrievalModeBar({
  mode,
  scope,
  sources,
  disabled,
  onModeChange,
  onScopeChange,
}: {
  mode: ClassroomRetrievalMode;
  scope: ClassroomRetrievalScope;
  sources: Citation[];
  disabled: boolean;
  onModeChange: (mode: ClassroomRetrievalMode) => void;
  onScopeChange: (scope: ClassroomRetrievalScope) => void;
}) {
  const sourceCount = sources.length;
  const scopeOptions: Array<{ value: ClassroomRetrievalScope; label: string; disabled?: boolean }> = [
    { value: 'all', label: '全部资料' },
    { value: 'personal', label: '我的资料' },
    { value: 'teacher', label: '教师资料' },
    { value: 'class', label: '班级资料' },
    { value: 'global', label: '全局库' },
  ];
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-[var(--a3-border)] bg-white px-3 py-3 md:flex-row md:items-center md:justify-between" data-testid="a3-classroom-retrieval-controls">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-semibold text-[var(--a3-text-muted)]">
          <Settings className="size-3.5" />
          回答模式
        </span>
        <SegmentButton active={mode === 'fast'} disabled={disabled} onClick={() => onModeChange('fast')}>
          快速回答
        </SegmentButton>
        <SegmentButton active={mode === 'deep'} disabled={disabled} onClick={() => onModeChange('deep')}>
          深度检索
        </SegmentButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-[var(--a3-text-muted)]">资料范围，当前 {sourceCount} 条</span>
        {scopeOptions.map((option) => (
          <SegmentButton
            key={option.value}
            active={scope === option.value}
            disabled={disabled || option.disabled}
            onClick={() => onScopeChange(option.value)}
          >
            {option.label}
          </SegmentButton>
        ))}
      </div>
    </div>
  );
}

function SegmentButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-8 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45',
        active ? 'border-blue-600 bg-blue-600 text-white' : 'border-[var(--a3-border)] bg-white text-[var(--a3-text)] hover:border-blue-300 hover:bg-blue-50',
      )}
    >
      {children}
    </button>
  );
}

function formatRetrievalModeLabel(mode: string) {
  if (mode === 'indexed_blocks_deep') return '深度检索';
  if (mode === 'indexed_blocks_fast') return '快速检索';
  if (mode === 'hybrid_visual') return '视觉证据';
  if (mode === 'realtime_rag') return '实时 RAG';
  if (mode === 'classroom_context_fast') return '课堂上下文';
  return mode || '未知检索';
}

function LearningEvidenceStrip({ classroom, artifact }: { classroom: ClassroomContext | null; artifact: A3OpenMAICClassroomArtifact | null }) {
  const sourceCount = classroom?.sources.length ?? 0;
  const exerciseCount = classroom?.recommended.length ?? 0;
  const agentCount = classroom?.agents.filter((agent) => agent.status === 'active').length ?? 0;
  return (
    <div className="grid gap-3 border-b border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-5 py-4 md:grid-cols-4 md:px-7">
      <EvidenceMetric icon={<Target className="size-4" />} label="路径掌握" value={`${classroom?.graphSummary.masteryRate ?? 0}%`} detail={`${classroom?.graphSummary.learning ?? 0} 个学习中`} />
      <EvidenceMetric icon={<Library className="size-4" />} label="知识引用" value={`${sourceCount}`} detail={sourceCount ? '可收藏溯源' : '等待知识库'} />
      <EvidenceMetric icon={<ClipboardCheck className="size-4" />} label="推荐练习" value={`${exerciseCount}`} detail={exerciseCount ? '可进入测评' : '等待路径'} />
      <EvidenceMetric icon={<Zap className="size-4" />} label="课堂资源" value={artifact?.status === 'succeeded' ? '已生成' : '待生成'} detail={`${agentCount} 个 Agent 在线`} />
    </div>
  );
}

function EvidenceMetric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-white px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--a3-text-muted)]">
        <span className="text-blue-600">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold text-[var(--a3-text)]">{value}</div>
      <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{detail}</div>
    </div>
  );
}

function buildQuickPrompts(target: ClassroomContext['target']) {
  const title = target?.title ?? '当前知识点';
  return [
    { label: '讲清概念', detail: '调用 AI 课堂回答并展示引用验证', prompt: `请用循序渐进的方式讲清楚：${title}`, icon: <Bot className="size-4" /> },
    { label: '生成练习', detail: '调用 AI 课堂生成针对性练习', prompt: `围绕“${title}”生成一道带解析的练习题，并说明考查点。`, icon: <ClipboardCheck className="size-4" /> },
    { label: '错因拆解', detail: '调用 AI 课堂结合错题和薄弱点分析', prompt: `结合我的薄弱点，分析学习“${title}”最容易出错的原因和纠正方法。`, icon: <ShieldCheck className="size-4" /> },
    { label: '推荐资源', detail: '调用 AI 课堂基于知识库来源推荐资源', prompt: `请基于知识库引用，为“${title}”推荐下一步学习资源和使用顺序。`, icon: <Library className="size-4" /> },
  ];
}

function emptyAssessmentSession(knowledgePoint: string): AssessmentSession {
  return {
    id: '',
    mode: 'practice',
    focus: { knowledgePoint },
    status: 'in_progress',
    currentIndex: 0,
    answeredCount: 0,
    totalQuestions: 1,
    score: 0,
    startedAt: '',
    completedAt: null,
    currentQuestion: null,
  };
}

function LessonRunwayPanel({
  target,
  asking,
  sourceCount,
  exerciseCount,
  onAsk,
}: {
  target: ClassroomContext['target'];
  asking: boolean;
  sourceCount: number;
  exerciseCount: number;
  onAsk: (question: string) => void;
}) {
  const title = target?.title ?? '当前知识点';
  const steps = [
    {
      title: '先把概念问清楚',
      detail: `围绕《${title}》用定义、例子和易错点开始，适合第一次进入本节。`,
      action: '开始讲解',
      prompt: `请按“定义、关键公式、适用条件、常见误区”的结构讲解：${title}`,
      icon: <Bot className="size-5" />,
      meta: target ? '推荐第一步' : '等待学习目标',
    },
    {
      title: '先看资料依据',
      detail: sourceCount ? `当前有 ${sourceCount} 条资料可验证回答，适合先确认来源。` : '当前缺少可引用资料，建议先补充课件或笔记。',
      action: sourceCount ? '验证来源' : '补充资料',
      prompt: `请为“${title}”列出本地知识库中的支撑来源，并说明哪些结论已验证、哪些未验证。`,
      icon: <ShieldCheck className="size-5" />,
      meta: sourceCount ? `${sourceCount} 条引用` : '证据不足',
      href: sourceCount ? undefined : '/a3/knowledge-base',
    },
    {
      title: '做一次小练习',
      detail: exerciseCount ? `已有 ${exerciseCount} 项课堂练习，完成后会回写计划和错题本。` : '还没有课堂练习，可以先进入测评生成掌握度证据。',
      action: exerciseCount ? '生成练习' : '进入测评',
      prompt: `请围绕“${title}”生成一道适合我当前水平的练习题，附答案、解析和错因提示。`,
      icon: <ClipboardCheck className="size-5" />,
      meta: exerciseCount ? `${exerciseCount} 项练习` : '待生成练习',
      href: exerciseCount ? undefined : '/a3/assessment',
    },
  ];
  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4" data-testid="a3-classroom-runway">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-semibold text-blue-950">从这里开始本节课堂</div>
          <p className="mt-1 text-xs leading-5 text-blue-800">选一个入口开始，系统会结合路径、资料和错题记录回答。</p>
        </div>
        <Button asChild size="sm" variant="outline" className="bg-white">
          <Link href="/a3/assessment">进入测评</Link>
        </Button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {steps.map((step) => (
          <div key={step.title} className="rounded-xl border border-blue-100 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-blue-700">
                {step.icon}
                <div className="text-sm font-semibold text-blue-950">{step.title}</div>
              </div>
              <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">{step.meta}</span>
            </div>
            <p className="mt-2 min-h-12 text-xs leading-5 text-[var(--a3-text-muted)]">{step.detail}</p>
            {step.href ? (
              <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
                <Link href={step.href}>{step.action}</Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={asking || !target} title={!target ? '请先生成学习路径目标' : step.detail} className="mt-3 w-full bg-white" onClick={() => onAsk(step.prompt)}>
                {step.action}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CurrentTargetCard({ loading, target, graphSummary }: { loading: boolean; target: ClassroomContext['target']; graphSummary: ClassroomContext['graphSummary'] | null }) {
  return (
    <A3Card title="当前学习目标" action={loading ? <Loader2 className="size-4 animate-spin text-blue-600" /> : <A3Pill tone="blue">{graphSummary?.nextCount ?? 0} 个后续节点</A3Pill>}>
      {target ? (
        <>
          <div className="flex items-center gap-2">
            <A3Pill tone="blue">第 {target.chapter.order} 章</A3Pill>
            <A3Pill tone={target.wrongCount ? 'red' : 'green'}>{target.wrongCount ? `错题 ${target.wrongCount}` : '状态正常'}</A3Pill>
            <A3Pill tone="slate">{target.estimatedMinutes} 分钟</A3Pill>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">{target.title}</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--a3-text-muted)]">{target.description || target.reason || '当前节点暂无描述。'}</p>
          <div className="mt-4 h-2 rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-blue-600" style={{ width: `${target.progress}%` }} />
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="font-semibold text-blue-700">学习进度 {target.progress}%</span>
            <span className="text-[var(--a3-text-muted)]">{target.chapter.title}</span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-blue-50 px-2 py-2 text-blue-700">
              <div className="font-semibold">{graphSummary?.mastered ?? 0}</div>
              <div>已掌握</div>
            </div>
            <div className="rounded-lg bg-orange-50 px-2 py-2 text-orange-700">
              <div className="font-semibold">{graphSummary?.weak ?? 0}</div>
              <div>薄弱</div>
            </div>
            <div className="rounded-lg bg-slate-100 px-2 py-2 text-slate-600">
              <div className="font-semibold">{graphSummary?.locked ?? 0}</div>
              <div>锁定</div>
            </div>
          </div>
        </>
      ) : (
        <div className="text-sm leading-6 text-[var(--a3-text-muted)]">
          暂无学习目标，请先生成个性化学习路径。
          <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
            <Link href="/a3/learning-path">生成或查看学习路径</Link>
          </Button>
        </div>
      )}
    </A3Card>
  );
}

function ClassroomContextCard({ studyPlan }: { studyPlan: StudyPlan | null }) {
  const insight = buildClassroomContextInsight({ plan: studyPlan });
  return (
    <A3Card title="课堂会怎么辅导" action={<A3Pill tone="violet">路径上下文</A3Pill>}>
      <div className="rounded-xl border border-violet-100 bg-violet-50 p-4" data-testid="a3-classroom-flow-context">
        <div className="text-sm font-semibold leading-5 text-violet-950">{insight.title}</div>
        <p className="mt-2 text-xs leading-5 text-violet-800">{insight.detail}</p>
        <div className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs leading-5 text-violet-800">依据：{insight.evidence}</div>
        <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
          <Link href={insight.href}>查看关联任务</Link>
        </Button>
      </div>
    </A3Card>
  );
}

function ClassroomHistoryCard({
  sessions,
  activeId,
  onOpen,
}: {
  sessions: ClassroomHistorySession[];
  activeId: string;
  onOpen: (session: ClassroomHistorySession) => void;
}) {
  return (
    <div data-testid="a3-classroom-history-panel">
      <A3Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[var(--a3-text)]">历史对话</h3>
            <p className="mt-1 text-xs text-[var(--a3-text-muted)]">新建对话不会删除之前的课堂问答。</p>
          </div>
          <FileText className="size-5 text-blue-600" />
        </div>
        <div className="mt-4 space-y-2">
          {sessions.length ? sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid="a3-classroom-history-session"
              onClick={() => onOpen(session)}
              className={cn(
                'w-full rounded-xl border p-3 text-left text-sm transition hover:border-blue-300 hover:bg-blue-50',
                activeId === session.id ? 'border-blue-300 bg-blue-50' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)]',
              )}
            >
              <div className="line-clamp-1 font-semibold text-[var(--a3-text)]">{session.title || '课堂对话'}</div>
              <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{session.summary || `${session.messageCount ?? session.messages.length} 条消息`}</div>
            </button>
          )) : (
            <div className="rounded-xl border border-dashed border-[var(--a3-border)] p-3 text-sm text-[var(--a3-text-muted)]">
              暂无历史对话。完成一次提问后，新建对话会把旧内容保留在这里。
            </div>
          )}
        </div>
      </A3Card>
    </div>
  );
}

function OpenMAICClassroomCard({ artifact }: { artifact: A3OpenMAICClassroomArtifact | null }) {
  return (
    <A3Card title="OpenMAIC 资源课堂" action={<A3Pill tone={artifact?.status === 'succeeded' ? 'green' : 'orange'}>{artifact?.status ?? '未生成'}</A3Pill>}>
      <div className="space-y-3" data-testid="a3-classroom-openmaic-entry">
        {artifact ? (
          <>
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs leading-5 text-blue-900">
              <div className="flex items-center gap-2 font-semibold">
                <FileText className="size-4" />
                来自 A3 资源包的课堂证据
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <MiniDatum label="job" value={artifact.jobId || '--'} />
                <MiniDatum label="场景" value={`${artifact.scenesCount || 0}`} />
                <MiniDatum label="provider" value={artifact.provider || 'openmaic'} />
                <MiniDatum label="PPTX" value={artifact.pptxExportable ? '可导出' : '待生成'} />
              </div>
              {artifact.degradedReason && <div className="mt-1 text-orange-700">降级原因：{artifact.degradedReason}</div>}
            </div>
            {artifact.classroomUrl ? (
              <Button asChild size="sm" className="w-full bg-blue-600 text-white hover:bg-blue-700" data-testid="a3-classroom-openmaic-open">
                <Link href={artifact.classroomUrl}>
                  <ExternalLink className="size-4" />
                  打开 OpenMAIC 课堂
                </Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline" className="w-full">
                <Link href="/a3/recommendations">去资源页重新生成课堂</Link>
              </Button>
            )}
            <p className="text-xs leading-5 text-[var(--a3-text-muted)]" data-testid="a3-classroom-openmaic-pptx-hint">
              PPTX 导出请在打开的 OpenMAIC 课堂顶部使用导出按钮；A3 只负责资源包、任务状态和学习证据回写。
            </p>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-[var(--a3-text-muted)]">
            <div className="flex items-center gap-2 font-semibold text-[var(--a3-text)]">
              <UploadCloud className="size-4 text-blue-600" />
              还没有资源包课堂
            </div>
            <p className="mt-2">先到推荐页生成 A3 七类资源包，再点击“生成个性化课堂/PPT”。</p>
            <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
              <Link href="/a3/recommendations">去生成资源包课堂</Link>
            </Button>
          </div>
        )}
      </div>
    </A3Card>
  );
}

function MiniDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-white/80 px-2 py-2">
      <div className="text-[10px] uppercase text-blue-500">{label}</div>
      <div className="mt-0.5 truncate font-semibold text-blue-950">{value}</div>
    </div>
  );
}

function AgentsCard({ classroom }: { classroom: ClassroomContext | null }) {
  const agents = classroom?.agents ?? [];
  const activeAgents = agents.filter((agent) => agent.status === 'active');
  const sourceCount = classroom?.sources.length ?? 0;
  const exerciseCount = classroom?.recommended.length ?? 0;
  const weakCount = classroom?.graphSummary.weak ?? 0;
  const targetTitle = classroom?.target?.title ?? '当前知识点';
  const completedSteps = [Boolean(classroom?.target), sourceCount > 0, exerciseCount > 0].filter(Boolean).length;
  const readiness = completedSteps === 3 ? '可以闭环' : completedSteps === 2 ? '差一次练习' : sourceCount > 0 ? '先问清概念' : '先补证据';
  const progress = Math.round((completedSteps / 3) * 100);
  const workflow: Array<{
    key: string;
    label: string;
    detail: string;
    icon: ReactNode;
    done: boolean;
    actionLabel: string;
    href: string;
  }> = [
    {
      key: 'teach',
      label: '问清这个知识点',
      detail: classroom?.target ? `围绕《${targetTitle}》先问定义、场景和易错点。` : '还没有同步到当前路径节点，先刷新课堂上下文。',
      icon: <Bot className="size-4" />,
      done: Boolean(classroom?.target),
      actionLabel: '在中间提问',
      href: '#a3-classroom-input',
    },
    {
      key: 'evidence',
      label: '看引用依据',
      detail: sourceCount ? `${sourceCount} 条资料可用于验证回答，优先看来源和片段。` : '还缺可引用资料，回答会更容易变成泛泛讲解。',
      icon: <ShieldCheck className="size-4" />,
      done: sourceCount > 0,
      actionLabel: '补充资料',
      href: '/a3/knowledge-base',
    },
    {
      key: 'practice',
      label: '做一次练习',
      detail: exerciseCount ? `${exerciseCount} 项练习可执行，完成后会回写测评、错题和计划。` : '还没有课堂练习，先进入测评生成掌握度证据。',
      icon: <ClipboardCheck className="size-4" />,
      done: exerciseCount > 0,
      actionLabel: '进入测评',
      href: '/a3/assessment',
    },
  ];

  return (
    <A3Card
      title="本节学习进度"
      subtitle="围绕当前知识点完成提问、证据和练习，完成后会回写学习计划。"
      action={<A3Pill tone={completedSteps === 3 ? 'green' : 'orange'}>{readiness}</A3Pill>}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-blue-950">{targetTitle}</div>
              <p className="mt-1 text-xs leading-5 text-blue-800">
                先把概念问清楚，再看引用依据，最后做一次练习。系统会把练习结果同步到今日任务和错题本。
              </p>
            </div>
            <div className="shrink-0 rounded-lg bg-white px-3 py-2 text-right shadow-sm">
              <div className="text-base font-semibold text-blue-700">{progress}%</div>
              <div className="text-[11px] text-blue-600">本节进度</div>
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
            <div className="h-full rounded-full bg-blue-600 transition-[width] duration-200" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <MiniSignal label="引用" value={sourceCount} tone={sourceCount ? 'blue' : 'slate'} />
            <MiniSignal label="练习" value={exerciseCount} tone={exerciseCount ? 'green' : 'slate'} />
            <MiniSignal label="薄弱" value={weakCount} tone={weakCount ? 'orange' : 'green'} />
          </div>
        </div>

        <div className="space-y-2">
          {workflow.map((step) => (
            <div key={step.key} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3 transition-colors duration-150 hover:border-blue-200 hover:bg-blue-50/40">
              <div className="flex items-start gap-3">
              <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', step.done ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500')}>
                {step.done ? <CheckCircle2 className="size-4" /> : step.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-[var(--a3-text)]">{step.label}</div>
                  <A3Pill tone={step.done ? 'green' : 'slate'}>{step.done ? '已就绪' : '待完成'}</A3Pill>
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">{step.detail}</p>
              </div>
              </div>
              <Button asChild size="sm" variant={step.done ? 'outline' : 'default'} className={cn('mt-3 w-full', step.done ? 'bg-white' : 'bg-blue-600 text-white hover:bg-blue-700')}>
                <Link href={step.href}>{step.actionLabel}</Link>
              </Button>
            </div>
          ))}
        </div>

        <details className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <summary className="cursor-pointer font-semibold text-slate-900">
            查看协作证据{activeAgents.length ? `，${activeAgents.length} 个模块在线` : ''}
          </summary>
          <div className="mt-3 space-y-2">
            {agents.slice(0, 3).map((agent) => (
              <div key={agent.id} className="flex items-center gap-3 rounded-lg bg-white px-3 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-white" style={{ backgroundColor: agent.color }}>
                  <Bot className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-[var(--a3-text)]">{agent.name}</div>
                  <div className="truncate text-[11px] text-[var(--a3-text-muted)]">{agent.role}</div>
                </div>
                <A3Pill tone={agent.status === 'active' ? 'blue' : 'slate'}>{agent.status === 'active' ? '工作中' : '候场'}</A3Pill>
              </div>
            ))}
            {!agents.length && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-xs leading-5 text-[var(--a3-text-muted)]">
                暂无协作记录，刷新课堂后会重新读取。
              </div>
            )}
          </div>
        </details>

        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <Button asChild variant="outline" className="bg-white">
            <Link href="/a3/knowledge-base"><Library className="size-4" />补充资料</Link>
          </Button>
          <Button asChild className="bg-blue-600 text-white hover:bg-blue-700">
            <Link href="/a3/assessment"><ClipboardCheck className="size-4" />进入测评</Link>
          </Button>
        </div>
      </div>
    </A3Card>
  );
}

function MiniSignal({ label, value, tone }: { label: string; value: number; tone: 'blue' | 'green' | 'orange' | 'slate' }) {
  const toneClass = {
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-emerald-100 text-emerald-700',
    orange: 'bg-orange-100 text-orange-700',
    slate: 'bg-slate-100 text-slate-600',
  }[tone];
  return (
    <div className={cn('rounded-lg px-2 py-2 text-center', toneClass)}>
      <div className="font-semibold">{value}</div>
      <div className="mt-0.5">{label}</div>
    </div>
  );
}

function ChatBubble({
  item,
  savingNoteId,
  onSaveNote,
  onFollowUp,
}: {
  item: ChatMessage;
  savingNoteId: string;
  onSaveNote: (item: ChatMessage) => void;
  onFollowUp: (question: string) => void;
}) {
  return (
    <div className={cn('flex gap-3', item.role === 'user' && 'justify-end')} data-testid={`a3-classroom-message-${item.role}`}>
      {item.role === 'assistant' && <Avatar tone="blue" />}
      <div className={cn('max-w-[680px] rounded-xl p-4 text-sm leading-7', item.role === 'assistant' ? 'bg-[var(--a3-surface-muted)] text-[var(--a3-text)]' : 'bg-blue-600 text-white')}>
        <div className="mb-1 text-xs font-semibold opacity-80">{item.role === 'assistant' ? '主讲教师 Agent' : '你'}</div>
        {item.role === 'assistant' ? (
          <A3Markdown>{item.content}</A3Markdown>
        ) : (
          <p className="whitespace-pre-wrap">{item.content}</p>
        )}
        {item.role === 'assistant' && item.degraded && (
          <div data-testid="a3-classroom-vision-degraded" className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800">
            视觉模型未完成真实识别，已降级为文本学习指导。请检查多模态模型配置，或补充输入题干和公式。
          </div>
        )}
        {item.role === 'assistant' && item.verified !== undefined && (
          <VerificationBadge verified={item.verified} citations={item.citations ?? []} claims={item.claims ?? []} safety={item.safety} refusalReason={item.refusalReason} />
        )}
        {item.role === 'assistant' && (item.retrievalMode || item.traceId) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--a3-text-muted)]" data-testid="a3-classroom-retrieval-status">
            {item.retrievalMode && <A3Pill tone={item.retrievalMode.includes('deep') ? 'blue' : 'slate'}>{formatRetrievalModeLabel(item.retrievalMode)}</A3Pill>}
            {item.traceId && <span>trace {item.traceId.slice(0, 8)}</span>}
          </div>
        )}
        {item.role === 'assistant' && item.followUps?.length ? (
          <div data-testid="a3-classroom-followups" className="mt-3 flex flex-wrap gap-2">
            {item.followUps.slice(0, 3).map((followUp) => (
              <button
                key={`${item.id}-${followUp.type}-${followUp.question}`}
                type="button"
                onClick={() => onFollowUp(followUp.question)}
                className="rounded-full border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold leading-5 text-blue-700 transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                title={followUp.reason || followUp.question}
              >
                {followUp.label}
              </button>
            ))}
          </div>
        ) : null}
        {item.role === 'assistant' && <A3SpeechControls id={item.id} text={item.content} />}
        {item.role === 'assistant' && item.id !== 'welcome' && (
          <Button
            data-testid="a3-classroom-save-note"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={savingNoteId === item.id}
            onClick={() => onSaveNote(item)}
          >
            {savingNoteId === item.id ? <Loader2 className="size-4 animate-spin" /> : <Star className="size-4" />}
            存为笔记
          </Button>
        )}
      </div>
      {item.role === 'user' && (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
          <UserRound className="size-5" />
        </div>
      )}
    </div>
  );
}

function ClassroomMessage({ message }: { message: string }) {
  const saved = message.startsWith('已保存');
  return (
    <div data-testid="a3-classroom-message" className={cn('mt-3 flex flex-col gap-3 rounded-lg px-3 py-2 text-sm md:flex-row md:items-center md:justify-between', saved ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
      <span>{message}</span>
      {saved && (
        <Button asChild size="sm" variant="outline" className="border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100">
          <Link data-testid="a3-classroom-open-favorites" href="/a3/favorites">
            去我的收藏
          </Link>
        </Button>
      )}
    </div>
  );
}

function SourcesCard({
  classroom,
  target,
  savingSourceId,
  sourceFavoriteMessage,
  sourceFavoriteSuccess,
  onSaveSource,
}: {
  classroom: ClassroomContext | null;
  target: ClassroomContext['target'];
  savingSourceId: string;
  sourceFavoriteMessage: string;
  sourceFavoriteSuccess: boolean;
  onSaveSource: (source: Citation) => void;
}) {
  return (
    <A3Card title="知识库溯源" action={<A3Pill tone="blue">{classroom?.sources.length ?? 0} 条引用</A3Pill>}>
      <div className="space-y-3">
        {(classroom?.sources ?? []).map((source, index) => (
          <div key={source.id} className="rounded-xl border border-[var(--a3-border)] p-3" data-testid="a3-classroom-source">
            <div className="flex items-start gap-3">
              <div className="text-sm font-semibold text-blue-700">[{index + 1}]</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--a3-text)]" data-testid="a3-source-title">{source.title}</div>
                <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{source.location}</div>
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{source.snippet}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <CitationScopePill citation={source} />
                    <A3Pill tone="slate">{source.sourceTypeLabel || source.type || '本地资料'}</A3Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    {source.score !== null && <span className="text-xs font-semibold text-blue-700">相关度 {source.score}</span>}
                    <Button
                      data-testid="a3-source-favorite"
                      size="sm"
                      variant="outline"
                      disabled={savingSourceId === (source.id || source.title)}
                      onClick={() => onSaveSource({ ...source, id: source.id || `${target?.id ?? 'source'}-${index}` })}
                    >
                      {savingSourceId === (source.id || source.title) ? <Loader2 className="size-3 animate-spin" /> : <Star className="size-3" />}
                      收藏来源
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
        {!classroom?.sources.length && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-[var(--a3-text-muted)]">
            <div className="flex items-center gap-2 font-semibold text-[var(--a3-text)]">
              <Library className="size-4 text-blue-600" />
              暂无可展示引用
            </div>
            <p className="mt-2">请先上传并索引课程资料，AI 课堂回答会优先使用本地知识库来源。</p>
            <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
              <Link href="/a3/knowledge-base">去维护知识库</Link>
            </Button>
          </div>
        )}
      </div>
      {sourceFavoriteMessage && (
        <div
          className={cn(
            'mt-3 flex flex-col gap-3 rounded-lg px-3 py-2 text-sm md:flex-row md:items-center md:justify-between',
            sourceFavoriteSuccess ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700',
          )}
          data-testid="a3-source-favorite-message"
        >
          <span>{sourceFavoriteMessage}</span>
          {sourceFavoriteSuccess && (
            <Button asChild size="sm" variant="outline" className="border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100">
              <Link data-testid="a3-source-open-favorites" href="/a3/favorites">
                去我的收藏
              </Link>
            </Button>
          )}
        </div>
      )}
    </A3Card>
  );
}

function RecommendedPracticeCard({
  classroom,
  studyPlan,
  savingPracticeId,
  practiceFeedback,
  embeddedPractice,
  onCompletePractice,
  onStartEmbeddedPractice,
  onSelectEmbeddedPracticeAnswer,
  onSubmitEmbeddedPractice,
}: {
  classroom: ClassroomContext | null;
  studyPlan: StudyPlan | null;
  savingPracticeId: string;
  practiceFeedback: StudyPlanTaskFeedback | null;
  embeddedPractice: EmbeddedPracticeState | null;
  onCompletePractice: (resource: ClassroomContext['recommended'][number]) => void;
  onStartEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
  onSelectEmbeddedPracticeAnswer: (answer: string) => void;
  onSubmitEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
}) {
  return (
    <A3Card title="课堂内练习" action={<A3Pill tone="blue">{classroom?.recommended.length ?? 0} 项</A3Pill>}>
      <div className="space-y-3">
        {(classroom?.recommended ?? []).map((resource, index) => {
          const match = findPracticePlanTaskForRecommendation(resource, studyPlan);
          const completed = Boolean(match?.completed);
          const canWriteBack = Boolean(match && !completed);
          const activePractice = embeddedPractice?.key === classroomPracticeKey(resource) ? embeddedPractice : null;
          const question = activePractice?.session.currentQuestion;
          return (
            <div key={`${resource.title}-${index}`} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3" data-testid="a3-classroom-practice-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--a3-text)]">
                    {index + 1}. {resource.title}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">{resource.meta}</div>
                </div>
                <A3Pill tone={completed ? 'green' : resource.progress > 80 ? 'green' : 'orange'}>
                  {completed ? '已回写' : `${resource.progress}%`}
                </A3Pill>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="bg-white"
                  data-testid="a3-classroom-practice-start"
                  disabled={activePractice?.starting || activePractice?.submitting}
                  onClick={() => onStartEmbeddedPractice(resource)}
                >
                  {activePractice?.starting ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
                  课堂内答题
                </Button>
                <Button asChild size="sm" variant="outline" className="bg-white">
                  <Link href={resource.href} data-testid="a3-classroom-practice-open-assessment">
                    <ClipboardCheck className="size-4" />
                    打开测评页
                  </Link>
                </Button>
              </div>
              {activePractice && (
                <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-3" data-testid="a3-classroom-embedded-practice">
                  {activePractice.feedback ? (
                    <div className={cn('rounded-lg p-3 text-xs leading-5', activePractice.feedback.isCorrect ? 'bg-emerald-50 text-emerald-800' : 'bg-orange-50 text-orange-800')} data-testid="a3-classroom-embedded-feedback">
                      <div className="font-semibold">{activePractice.feedback.isCorrect ? '回答正确' : `回答错误，正确答案 ${activePractice.feedback.correctAnswer}`}</div>
                      <p className="mt-1">{activePractice.feedback.explanation}</p>
                      {activePractice.feedback.errorCause && <p className="mt-1">错因：{activePractice.feedback.errorCause}</p>}
                      {activePractice.planFeedback && <p className="mt-2 font-semibold">已回写学习计划：{activePractice.planFeedback.headline}</p>}
                      <PracticeSyncEvidencePanel feedback={activePractice.feedback} planFeedback={activePractice.planFeedback} />
                    </div>
                  ) : question ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <A3Pill tone="blue">课堂内测评</A3Pill>
                        <span className="text-xs text-blue-700">{question.knowledgePoint.chapter} / 难度 {question.difficulty}</span>
                      </div>
                      <div className="mt-3 text-sm font-semibold leading-6 text-blue-950" data-testid="a3-classroom-embedded-question">{question.stem}</div>
                      <div className="mt-3 grid gap-2">
                        {question.options.map((option) => {
                          const selected = activePractice.selectedAnswer === option.key;
                          const correct = activePractice.feedback?.correctAnswer === option.key;
                          const wrongSelected = activePractice.feedback && selected && !activePractice.feedback.isCorrect;
                          return (
                            <button
                              key={option.key}
                              type="button"
                              data-testid="a3-classroom-embedded-option"
                              disabled={Boolean(activePractice.feedback) || activePractice.submitting}
                              onClick={() => onSelectEmbeddedPracticeAnswer(option.key)}
                              className={cn(
                                'rounded-lg border bg-white px-3 py-2 text-left text-xs leading-5 transition',
                                correct ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : wrongSelected ? 'border-rose-300 bg-rose-50 text-rose-800' : selected ? 'border-blue-500 text-blue-800' : 'border-blue-100 text-[var(--a3-text)] hover:border-blue-300',
                              )}
                            >
                              <span className="mr-2 font-semibold">{option.key}.</span>
                              {option.text}
                            </button>
                          );
                        })}
                      </div>
                      <Button
                        size="sm"
                        className="mt-3 w-full bg-blue-600 hover:bg-blue-700"
                        data-testid="a3-classroom-embedded-submit"
                        disabled={!activePractice.selectedAnswer || activePractice.submitting}
                        onClick={() => onSubmitEmbeddedPractice(resource)}
                      >
                        {activePractice.submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                        提交答案并自动回写
                      </Button>
                    </>
                  ) : (
                    <div className="text-xs leading-5 text-blue-800">{activePractice.error || '未拿到可用题目，请打开测评页继续练习。'}</div>
                  )}
                  {activePractice.error && question && (
                    <div className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-orange-700" data-testid="a3-classroom-embedded-error">
                      {activePractice.error}
                    </div>
                  )}
                </div>
              )}
              <div className="mt-3 grid gap-2 sm:grid-cols-1">
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="a3-classroom-practice-complete"
                  disabled={!canWriteBack || savingPracticeId === resource.href}
                  title={match ? completed ? '该计划任务已完成' : '完成后回写今日任务和学习计划' : '未匹配到今日计划任务，请先进入测评'}
                  onClick={() => onCompletePractice(resource)}
                >
                  {savingPracticeId === resource.href ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  {completed ? '已完成' : '完成并回写'}
                </Button>
              </div>
              <div className="mt-3 rounded-lg bg-[var(--a3-surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--a3-text-muted)]">
                {match
                  ? completed
                    ? '该练习已同步到今日任务和学习计划。'
                    : `已匹配今日计划任务 ${match.taskId}，点击后调用任务完成接口回写。`
                  : '未匹配到今日计划任务：可先进入测评练习，或到学习计划页生成今日任务。'}
              </div>
            </div>
          );
        })}
        {practiceFeedback && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800" data-testid="a3-classroom-practice-feedback">
            <div className="font-semibold text-emerald-950">{practiceFeedback.headline}</div>
            <p className="mt-1">{practiceFeedback.celebration}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <MiniDatum label="掌握度" value={`${practiceFeedback.masteryAfter}%`} />
              <MiniDatum label="今日" value={`${practiceFeedback.completedTasks}/${practiceFeedback.totalTasks}`} />
              <MiniDatum label="剩余" value={`${practiceFeedback.remainingTasks}`} />
            </div>
            <Button asChild size="sm" className="mt-3 bg-emerald-600 hover:bg-emerald-700">
              <Link href={practiceFeedback.nextAction.href}>{practiceFeedback.nextAction.label}</Link>
            </Button>
          </div>
        )}
        {!classroom?.recommended.length && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-[var(--a3-text-muted)]">
            <div className="flex items-center gap-2 font-semibold text-[var(--a3-text)]">
              <ClipboardCheck className="size-4 text-blue-600" />
              暂无推荐练习
            </div>
            <p className="mt-2">完成入学诊断或生成学习路径后，系统会按薄弱点推荐练习。</p>
            <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
              <Link href="/a3/assessment">进入测评</Link>
            </Button>
          </div>
        )}
      </div>
    </A3Card>
  );
}

function PracticeSyncEvidencePanel({ feedback, planFeedback }: { feedback: AnswerFeedback; planFeedback: StudyPlanTaskFeedback | null }) {
  const evidence = buildPracticeSyncEvidence({ feedback, planFeedback });
  return (
    <div className="mt-3 space-y-2" data-testid="a3-classroom-practice-sync-evidence">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-emerald-950">本次判分同步证据</div>
        <div className="text-[11px] text-emerald-700">错题本 / 画像 / 报告已按接口返回更新</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-profile-sync">
          <div className="text-[11px] font-semibold text-emerald-950">画像：weakPoints</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {evidence.weakPoints.length ? (
              evidence.weakPoints.slice(0, 4).map((item) => (
                <span key={item} className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
                  {item}
                </span>
              ))
            ) : (
              <span className="text-[11px] text-emerald-700">无新增薄弱点</span>
            )}
          </div>
        </div>
        <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-wrong-sync">
          <div className="text-[11px] font-semibold text-emerald-950">错题本：复习队列</div>
          <div className="mt-1 text-[11px] leading-4 text-emerald-700">{evidence.wrongNotebookText}</div>
          <Link href="/a3/wrong-notebook" className="mt-1 inline-flex text-[11px] font-semibold text-emerald-800 hover:text-emerald-950">
            查看错题本
          </Link>
        </div>
        <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-plan-sync">
          <div className="text-[11px] font-semibold text-emerald-950">计划回写</div>
          <div className="mt-1 text-[11px] leading-4 text-emerald-700">{evidence.planText}</div>
          <Link href="/a3/study-plan" className="mt-1 inline-flex text-[11px] font-semibold text-emerald-800 hover:text-emerald-950">
            查看计划
          </Link>
        </div>
      </div>
      <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-report-sync">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold text-emerald-950">报告：report.metrics</div>
          <Link href="/a3/report" className="text-[11px] font-semibold text-emerald-800 hover:text-emerald-950">
            打开报告
          </Link>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {evidence.reportMetrics.map((item) => (
            <div key={item.label} className={cn('rounded px-2 py-1', item.available ? 'bg-emerald-50' : 'bg-slate-50')}>
              <div className={cn('text-[10px]', item.available ? 'text-emerald-700' : 'text-slate-500')}>{item.label}</div>
              <div className={cn('mt-0.5 text-xs font-semibold', item.available ? 'text-emerald-950' : 'text-slate-600')}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NextActionsCard({ classroom }: { classroom: ClassroomContext | null }) {
  return (
    <A3Card title="下一步行动" action={<Settings className="size-4 text-[var(--a3-text-muted)]" />}>
      <div className="grid gap-3">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-3">
          <div className="text-xs font-semibold text-blue-950">AI 学习二级入口</div>
          <div className="mt-3 grid gap-2">
            <Link href="/a3/coaching" className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm font-medium text-blue-900 hover:bg-blue-100">
              面对面辅导
              <CheckCircle2 className="size-4 text-blue-600" />
            </Link>
            <Link href="/a3/recommendations" className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm font-medium text-blue-900 hover:bg-blue-100">
              资源包生成
              <CheckCircle2 className="size-4 text-blue-600" />
            </Link>
            <Link href="/a3/favorites" className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm font-medium text-blue-900 hover:bg-blue-100">
              我的收藏
              <CheckCircle2 className="size-4 text-blue-600" />
            </Link>
          </div>
        </div>
        {(classroom?.actions ?? []).map((item) => (
          <Link key={item.title} href={item.href} className="flex items-center justify-between rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 text-left text-sm font-medium text-[var(--a3-text)] hover:border-blue-300 hover:bg-blue-50">
            {item.title}
            <CheckCircle2 className="size-4 text-blue-600" />
          </Link>
        ))}
        {!classroom?.actions.length && (
          <>
            <Link href="/a3/today" className="flex items-center justify-between rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 text-left text-sm font-medium text-[var(--a3-text)] hover:border-blue-300 hover:bg-blue-50">
              回到今日任务
              <CheckCircle2 className="size-4 text-blue-600" />
            </Link>
            <Link href="/a3/report" className="flex items-center justify-between rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 text-left text-sm font-medium text-[var(--a3-text)] hover:border-blue-300 hover:bg-blue-50">
              查看学习报告
              <CheckCircle2 className="size-4 text-blue-600" />
            </Link>
          </>
        )}
      </div>
    </A3Card>
  );
}

function VerificationBadge({ verified, citations, claims, safety, refusalReason }: { verified: boolean; citations: Citation[]; claims: Claim[]; safety?: SafetyStatus; refusalReason?: string }) {
  const verifiedClaims = claims.filter((claim) => claim.verified).length;
  const blocked = safety?.safe === false;
  const claimsWithMapping = claims.filter((claim) => claim.citation);
  const groupedClaimCitations = groupClaimsByCitation(claimsWithMapping);
  const partial = !verified && citations.length > 0 && refusalReason === 'claim_not_supported';
  const statusLabel = verified ? 'VerifierAgent 已验证' : partial ? '部分待核验' : '缺少证据';
  const statusDetail = verified || partial
    ? `引用 ${citations.length} 条 / 句级验证 ${verifiedClaims}/${claims.length || verifiedClaims}`
    : `原因：${refusalReason === 'missing_evidence' ? '当前回答缺少可引用的知识库证据' : safety?.reason || refusalReason || '缺少可支撑证据'}`;
  return (
    <div className="mt-3 rounded-lg border border-white/60 bg-white/70 p-3 text-xs leading-5 text-[var(--a3-text-muted)]" data-testid="a3-classroom-verification">
      <div className="flex flex-wrap items-center gap-2">
        <A3Pill tone={verified ? 'green' : 'orange'}>{statusLabel}</A3Pill>
        <span>{statusDetail}</span>
      </div>
      {blocked && (
        <div data-testid="a3-classroom-safety-status" className="mt-3 rounded-lg bg-orange-50 p-3 text-orange-800">
          <div className="font-semibold">SafetyAgent 已拒答 · {safety.category}</div>
          <div className="mt-1">{safety.reason}</div>
          <div className="mt-1">合规替代：可以改为讲解相关考点、生成练习题、分析错因或制定复习步骤。</div>
        </div>
      )}
      {claimsWithMapping.length > 0 && (
        <EvidenceGallery groups={groupedClaimCitations} />
      )}
      {citations.length > 0 && claimsWithMapping.length === 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {citations.slice(0, 2).map((citation, index) => (
            <div key={`${citation.title}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
              <CitationPreview citation={citation} size="large" />
              <div className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">
                [{index + 1}] {formatCitationLabel(citation)}{citation.score !== null && citation.score !== undefined ? ` / ${citation.score}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CitationPreview({ citation, size = 'compact' }: { citation: Citation; size?: 'compact' | 'thumb' | 'large' | 'hero' }) {
  const [previewAvailable, setPreviewAvailable] = useState(true);
  if (!citation.previewUrl) return null;
  const image = (
    <CitationImage
      citation={citation}
      size={size}
      previewAvailable={previewAvailable}
      onUnavailable={() => setPreviewAvailable(false)}
    />
  );
  if (!previewAvailable) {
    return (
      <div className={cn('block shrink-0', size === 'compact' ? '' : 'w-full')} data-testid="a3-classroom-citation-preview">
        {image}
      </div>
    );
  }
  return (
    <a
      href={resolveCitationPreviewUrl(citation.previewUrl)}
      target="_blank"
      rel="noreferrer"
      className={cn('block shrink-0', size === 'compact' ? '' : 'w-full')}
      data-testid="a3-classroom-citation-preview-link"
    >
      {image}
    </a>
  );
}

function CitationImage({
  citation,
  size = 'compact',
  previewAvailable = true,
  onUnavailable,
}: {
  citation: Citation;
  size?: 'compact' | 'thumb' | 'large' | 'hero';
  previewAvailable?: boolean;
  onUnavailable?: () => void;
}) {
  if (!citation.previewUrl) return null;
  const previewUrl = resolveCitationPreviewUrl(citation.previewUrl);
  const frameClassName = cn(
    'group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50',
    size === 'hero' ? 'h-[220px] w-full' : size === 'large' ? 'h-[168px] w-full md:w-[260px]' : size === 'thumb' ? 'h-[72px] w-full' : 'h-14 w-20',
  );
  if (!previewAvailable) {
    return (
      <div className={frameClassName} data-testid="a3-classroom-citation-preview">
        <span className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] leading-3 text-slate-500">
          预览不可用
        </span>
      </div>
    );
  }
  return (
    <div className={frameClassName} data-testid="a3-classroom-citation-preview">
      <img
        src={previewUrl}
        alt={citation.title || 'knowledge-base citation preview'}
        className="h-full w-full object-contain"
        loading="lazy"
        onError={(event) => {
          event.currentTarget.classList.add('hidden');
          onUnavailable?.();
          const fallback = event.currentTarget.nextElementSibling;
          if (fallback instanceof HTMLElement) fallback.style.display = 'flex';
        }}
      />
      <span className="hidden h-full w-full items-center justify-center px-2 text-center text-[10px] leading-3 text-slate-500 group-hover:text-blue-700">
        打开预览
      </span>
    </div>
  );
}

type EvidenceGroup = { key: string; citation: Citation; claims: Claim[] };

function EvidenceGallery({ groups }: { groups: EvidenceGroup[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeGroup = groups[Math.min(activeIndex, Math.max(groups.length - 1, 0))];
  if (!activeGroup) return null;
  const visibleClaims = activeGroup.claims.slice(0, 3);
  const hiddenClaims = activeGroup.claims.slice(3);
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" data-testid="a3-classroom-claim-citation-map">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="px-4 pt-4">
          <div className="font-semibold text-[var(--a3-text)]">证据画廊</div>
          <p className="mt-1 text-[11px] text-[var(--a3-text-muted)]">先看课件页，再看它支撑了哪些结论。</p>
        </div>
        <div className="px-4 pt-4"><A3Pill tone="green">{groups.length} 个来源</A3Pill></div>
      </div>

      <div className="px-4 pb-3 pt-4">
        {activeGroup.citation.previewUrl ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950 p-2">
            <CitationPreview citation={activeGroup.citation} size="hero" />
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-700">
            {activeGroup.citation.snippet || activeGroup.citation.location || '该证据没有可预览图片，已显示文字来源。'}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-5 text-slate-950">{activeGroup.citation.title || '本地知识库来源'}</div>
            <div className="mt-1 text-[11px] leading-5 text-slate-500">
              {[formatCitationOrigin(activeGroup.citation), activeGroup.citation.sourceTypeLabel || activeGroup.citation.type, activeGroup.citation.location].filter(Boolean).join(' · ')}
              {activeGroup.citation.score !== null && activeGroup.citation.score !== undefined ? ` · 相似度 ${activeGroup.citation.score}` : ''}
            </div>
          </div>
        </div>
      </div>

      {groups.length > 1 && (
        <div className="border-y border-slate-100 bg-slate-50 px-4 py-3">
          <div className="flex gap-2 overflow-x-auto pb-1" role="list" aria-label="课件证据缩略图">
        {groups.map((group, index) => {
          const selected = index === activeIndex;
          return (
            <button
              key={group.key}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={cn(
                'w-[116px] shrink-0 rounded-lg border bg-white p-1.5 text-left transition',
                selected ? 'border-blue-500 shadow-sm ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300',
              )}
              aria-pressed={selected}
            >
              <CitationImage citation={group.citation} size="thumb" />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className={cn('text-[11px] font-semibold', selected ? 'text-blue-700' : 'text-slate-700')}>证据 {index + 1}</span>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{group.claims.length} 句</span>
              </div>
            </button>
          );
        })}
          </div>
        </div>
      )}

      <div className="px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold text-slate-900">支撑要点</div>
          <span className="text-[11px] text-slate-500">{activeGroup.claims.length} 条句级证据</span>
        </div>
        <div className="space-y-2">
          {visibleClaims.map((claim, claimIndex) => (
            <div key={claim.id} className="flex gap-3 rounded-lg bg-emerald-50 px-3 py-2">
              <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-semibold text-emerald-700">{claimIndex + 1}</div>
              <div className="min-w-0">
                <A3Markdown className="text-sm leading-6 text-slate-950">{claim.text}</A3Markdown>
              </div>
            </div>
          ))}
          {hiddenClaims.length > 0 && (
            <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-blue-700">展开其余 {hiddenClaims.length} 条句级证据</summary>
              <div className="mt-2 space-y-2">
                {hiddenClaims.map((claim, claimIndex) => (
                  <div key={claim.id} className="rounded-md bg-white px-3 py-2">
                    <div className="text-[11px] font-semibold text-slate-500">支撑句 {claimIndex + visibleClaims.length + 1}</div>
                    <A3Markdown className="mt-1 text-xs leading-6 text-slate-700">{claim.text}</A3Markdown>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function groupClaimsByCitation(claims: Claim[]) {
  const groups = new Map<string, EvidenceGroup>();
  for (const claim of claims) {
    if (!claim.citation) continue;
    const key = [
      claim.citation.previewUrl,
      claim.citation.title,
      claim.citation.location,
      claim.citation.sourceTypeLabel || claim.citation.type,
    ].filter(Boolean).join('::') || claim.id;
    const existing = groups.get(key);
    if (existing) {
      existing.claims.push(claim);
    } else {
      groups.set(key, { key, citation: claim.citation, claims: [claim] });
    }
  }
  return Array.from(groups.values());
}

function resolveCitationPreviewUrl(previewUrl: string) {
  if (/^https?:\/\//i.test(previewUrl) || previewUrl.startsWith('data:image/')) return previewUrl;
  return resolveA3Endpoint(previewUrl);
}

function CitationScopePill({ citation }: { citation: Citation }) {
  const scope = citation.sourceScope;
  if (scope === 'personal') return <A3Pill tone="green">我的资料</A3Pill>;
  if (scope === 'teacher') return <A3Pill tone="blue">教师资料</A3Pill>;
  if (scope === 'class') return <A3Pill tone="blue">班级资料</A3Pill>;
  if (scope === 'global') return <A3Pill tone="slate">全局知识库</A3Pill>;
  return <A3Pill tone="blue">{citation.sourceOrigin || '全量知识库索引'}</A3Pill>;
}

function formatCitationOrigin(citation: Citation) {
  if (citation.sourceScope === 'personal') return '我的资料';
  if (citation.sourceScope === 'teacher') return '教师资料';
  if (citation.sourceScope === 'class') return '班级资料';
  if (citation.sourceScope === 'global') return '全局知识库';
  return citation.sourceOrigin || '全量知识库索引';
}

function formatCitationLabel(citation: Citation) {
  return `${formatCitationOrigin(citation)} · ${citation.sourceTypeLabel || citation.type || '本地资料'} · ${citation.title || '知识库来源'}${citation.location ? ` · ${citation.location}` : ''}`;
}

function Avatar({ tone }: { tone: 'blue' }) {
  return (
    <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-full text-white', tone === 'blue' && 'bg-blue-600')}>
      <Bot className="size-5" />
    </div>
  );
}

function findLatestOpenMAICClassroomArtifact(resourcePacks: A3ResourcePacksResponse['resourcePacks']) {
  for (const pack of resourcePacks) {
    const artifact = pack.multimodalArtifacts?.find(
      (item): item is A3OpenMAICClassroomArtifact => item.type === 'openmaic_classroom',
    );
    if (artifact) return artifact;
  }
  return null;
}

function normalizeClassroomMessages(messages?: ChatMessage[]) {
  return (messages ?? [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && item.content?.trim())
    .map((item, index) => ({
      ...item,
      id: item.id || `classroom-history-${index}`,
      citations: Array.isArray(item.citations) ? item.citations : [],
      claims: Array.isArray(item.claims) ? item.claims : [],
      refusalReason: item.refusalReason ?? '',
      degraded: Boolean(item.degraded),
      retrievalMode: item.retrievalMode ?? '',
      traceId: item.traceId ?? '',
      followUps: Array.isArray(item.followUps) ? item.followUps : [],
    }));
}

function normalizeClassroomSessions(sessions?: ClassroomHistorySession[]) {
  return (sessions ?? [])
    .filter((session) => session && session.id && Array.isArray(session.messages))
    .map((session) => ({
      ...session,
      title: session.title || '课堂对话',
      summary: session.summary || `${session.messageCount ?? session.messages.length} 条消息`,
      messages: normalizeClassroomMessages(session.messages),
    }))
    .filter((session) => session.messages.length > 0);
}

function classroomPracticeKey(resource: ClassroomContext['recommended'][number]) {
  return `${resource.href}::${resource.title}`;
}
