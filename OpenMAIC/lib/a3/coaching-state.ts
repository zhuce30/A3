import type { ClassroomContext } from '@/lib/a3/classroom-types';
import type { CoachingMessage, CoachingSessionListItem, CoachingUiState } from './coaching-types';

export function coachingUiStateLabel(state: CoachingUiState) {
  const labels: Record<CoachingUiState, string> = {
    idle: '等待提问',
    restoring: '正在恢复辅导记录',
    recording: '正在录音',
    transcribing: '正在识别语音',
    answering: 'AI 正在组织回答',
    speaking: '正在语音播报',
    saving: '正在保存记录',
    ended: '本次辅导已结束',
    error: '需要处理异常',
  };
  return labels[state];
}

export function getCoachingControlState(state: CoachingUiState) {
  const busy = state === 'restoring' || state === 'recording' || state === 'transcribing' || state === 'answering' || state === 'speaking' || state === 'saving';
  return {
    canRecord: !busy && state !== 'ended',
    canAskText: !busy && state !== 'ended',
    canAskWithCamera: !busy && state !== 'ended',
    canToggleMedia: state !== 'saving',
    canEnd: state !== 'restoring' && state !== 'saving',
  };
}

export function buildCoachingWelcomeMessage(classroom: ClassroomContext | null): CoachingMessage {
  const target = classroom?.target;
  return {
    id: 'welcome',
    role: 'assistant',
    content: target
      ? `你好，我是 AI 助教小智。当前面对面辅导主题是《${target.title}》，我会结合学习路径、知识库来源和错题记录回答。`
      : '你好，我是 AI 助教小智。请先生成学习路径，再开始面对面辅导。',
    createdAt: new Date().toISOString(),
  };
}

export function buildSessionSummaryText(target: string | undefined, messages: CoachingMessage[]) {
  const userQuestions = messages.filter((message) => message.role === 'user');
  const verifiedReplies = messages.filter((message) => message.role === 'assistant' && message.verified).length;
  const recentQuestions = userQuestions.slice(-3).map((message) => message.content);
  return `${target ?? '面对面辅导'}：已完成 ${userQuestions.length} 次有效提问，${verifiedReplies} 条回答完成引用验证。${recentQuestions.length ? `最近问题：${recentQuestions.join('；')}` : '暂无学生提问。'}`;
}

export function coachingStatusTone(state: CoachingUiState): 'blue' | 'orange' | 'red' | 'slate' {
  if (state === 'error') return 'red';
  if (state === 'recording' || state === 'transcribing' || state === 'answering' || state === 'saving') return 'orange';
  if (state === 'ended') return 'slate';
  return 'blue';
}

export function formatCoachingSessionMeta(session: CoachingSessionListItem) {
  return `${session.questionCount} 次提问 / ${session.verifiedReplyCount} 条已验证 / ${session.citationCount} 个引用`;
}

export function deriveCoachingUiState(flags: {
  loadingSession?: boolean;
  recorderIsRecording?: boolean;
  recorderIsProcessing?: boolean;
  asking?: boolean;
  speaking?: boolean;
  saving?: boolean;
  ended?: boolean;
  error?: string;
}): CoachingUiState {
  if (flags.error) return 'error';
  if (flags.loadingSession) return 'restoring';
  if (flags.saving) return 'saving';
  if (flags.recorderIsProcessing) return 'transcribing';
  if (flags.recorderIsRecording) return 'recording';
  if (flags.asking) return 'answering';
  if (flags.speaking) return 'speaking';
  if (flags.ended) return 'ended';
  return 'idle';
}

export function answerNextActions(message: CoachingMessage) {
  const base = [{ label: '继续追问', href: '/a3/coaching', kind: 'follow-up' as const }];
  if (message.verified) {
    return [
      ...base,
      { label: '生成练习', href: '/a3/assessment', kind: 'assessment' as const },
      { label: '加入复习', href: '/a3/wrong-notebook', kind: 'review' as const },
      { label: '保存笔记', href: '/a3/favorites', kind: 'note' as const },
    ];
  }
  return [
    ...base,
    { label: '补充资料', href: '/a3/knowledge-base', kind: 'knowledge-base' as const },
    { label: '保存笔记', href: '/a3/favorites', kind: 'note' as const },
  ];
}
