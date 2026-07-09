import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import { answerA3TextQuestionWithVisualEvidence, answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';
import type { A3PublicUser } from '@/lib/a3/auth-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type BackendQaResponse = {
  answer?: string;
  sources?: Citation[];
  retrievalMode?: string;
  verified?: boolean;
  safety?: {
    safe: boolean;
    category: string;
    reason: string;
  };
  refusalReason?: string;
  claims?: Array<{
    id: string;
    text: string;
    verified: boolean;
    overlap: number;
    citation?: Citation | null;
  }>;
  citations?: Citation[];
  followUps?: FollowUpSuggestion[];
  traceId?: string;
  error?: string;
};

type FollowUpSuggestion = {
  label: string;
  question: string;
  type: 'concept' | 'example' | 'practice' | 'evidence' | 'clarify' | string;
  reason?: string;
};

type Citation = {
  id?: string;
  title?: string;
  location?: string;
  type?: string;
  sourceTypeLabel?: string;
  sourceOrigin?: string;
  sourceScope?: string;
  score?: number | null;
  snippet?: string;
  previewUrl?: string;
  asset?: { previewUrl?: string; mimeType?: string; kind?: string } | null;
  modality?: string;
};

type CoachingHistoryTurn = {
  role?: string;
  content?: string;
};

type CoachingAttachment = {
  type?: string;
  name?: string;
  mediaType?: string;
  dataUrl?: string;
};

type ClassroomRetrievalMode = 'fast' | 'deep';
type ClassroomRetrievalScope = 'all' | 'personal' | 'teacher' | 'class' | 'global';

const DEFAULT_BACKEND_QA_TIMEOUT_MS = 20_000;

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后使用 AI 辅导');
    }

    const body = await request.json() as {
      message?: string;
      history?: CoachingHistoryTurn[];
      attachments?: CoachingAttachment[];
      mode?: ClassroomRetrievalMode;
      scope?: ClassroomRetrievalScope;
      resourceId?: string;
    };
    const message = body.message?.trim();
    if (!message) return apiError('MISSING_REQUIRED_FIELD', 400, '请输入问题');
    if (message.length > 2000) return apiError('INVALID_REQUEST', 400, '问题内容过长');

    const imageAttachment = Array.isArray(body.attachments)
      ? body.attachments.find((item) => item.type === 'image' && typeof item.dataUrl === 'string' && item.dataUrl.trim())
      : undefined;

    if (imageAttachment?.dataUrl) {
      return answerA3VisionQuestion({
        cookieHeader,
        image: imageAttachment.dataUrl,
        message: buildVisionAttachmentQuestion(message, imageAttachment),
      });
    }

    const mode = body.mode === 'deep' ? 'deep' : 'fast';
    const scope = normalizeRetrievalScope(body.scope);
    if (mode === 'fast' && scope === 'all' && !body.resourceId) {
      const visualEvidenceResponse = await tryAnswerWithVisualEvidence(cookieHeader, message);
      if (visualEvidenceResponse) return visualEvidenceResponse;
    }

    const query = new URLSearchParams({
      q: message,
      mode,
      scope,
    });
    const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : '';
    if (resourceId) query.set('resourceId', resourceId);

    const result = await fetchA3DjangoJson<BackendQaResponse>(`/api/v1/qa/interact/?${query.toString()}`, cookieHeader, {
      signal: AbortSignal.timeout(resolveBackendQaTimeoutMs()),
    }).catch((error) => {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return buildBackendQaTimeoutFallback(message);
      }
      throw error;
    });
    if (!result.success || !result.answer) {
      return apiError('UPSTREAM_ERROR', 502, result.error || 'AI 辅导服务请求失败');
    }

    return apiSuccess({
      reply: result.answer,
      verified: Boolean(result.verified),
      citations: result.citations ?? [],
      claims: result.claims ?? [],
      safety: result.safety,
      refusalReason: result.refusalReason ?? '',
      sources: result.sources ?? [],
      retrievalMode: result.retrievalMode ?? 'unknown',
      followUps: normalizeFollowUps(result.followUps),
      traceId: result.traceId ?? '',
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'AI 辅导服务暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

function normalizeRetrievalScope(scope?: string) {
  return scope && ['all', 'personal', 'teacher', 'class', 'global'].includes(scope) ? scope : 'all';
}

function resolveBackendQaTimeoutMs() {
  const value = Number.parseInt(process.env.A3_BACKEND_QA_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BACKEND_QA_TIMEOUT_MS;
}

function buildBackendQaTimeoutFallback(message: string): BackendQaResponse & { success: true } {
  return {
    success: true,
    answer: [
      '当前课堂问答服务响应较慢，先给出可继续学习的降级反馈。',
      '',
      `你的问题是：${message}`,
      '',
      '建议先按三步处理：第一，回到当前学习路径节点确认核心定义；第二，查看右侧知识库来源里的相关片段；第三，完成一题随堂练习验证是否理解。',
      '',
      '这次回答会标记为未充分验证。系统仍会把本次提问写入课堂记录和画像候选，用于后续调整讲解方式。',
    ].join('\n'),
    verified: false,
    citations: [],
    sources: [],
    claims: [],
    safety: {
      safe: true,
      category: 'qa_timeout_fallback',
      reason: '课堂问答服务超时，已降级为学习流程指导',
    },
    refusalReason: 'qa_timeout_fallback',
    retrievalMode: 'timeout_fallback',
    followUps: [
      { label: '看来源', question: '请根据右侧知识库来源重新解释这个问题。', type: 'evidence', reason: '补充可验证证据' },
      { label: '做练习', question: '请围绕这个知识点生成一道随堂练习。', type: 'practice', reason: '用练习验证理解' },
    ],
  };
}

async function tryAnswerWithVisualEvidence(cookieHeader: string | null, message: string) {
  try {
    return await answerA3TextQuestionWithVisualEvidence({
      cookieHeader,
      message,
    });
  } catch {
    return null;
  }
}

function normalizeFollowUps(items?: FollowUpSuggestion[]) {
  return Array.isArray(items)
    ? items
        .filter((item) => item && typeof item.question === 'string' && item.question.trim())
        .slice(0, 3)
        .map((item) => ({
          label: String(item.label || '继续追问').slice(0, 24),
          question: item.question.trim(),
          type: item.type || 'concept',
          reason: item.reason || '',
        }))
    : [];
}

function buildVisionAttachmentQuestion(message: string, attachment: CoachingAttachment) {
  const name = attachment.name?.trim();
  const mediaType = attachment.mediaType?.trim();
  const attachmentMeta = [name ? `文件名：${name}` : '', mediaType ? `类型：${mediaType}` : ''].filter(Boolean).join('，');
  return [
    attachmentMeta ? `学生上传了一张本地图片（${attachmentMeta}）。` : '学生上传了一张本地图片。',
    '请识别图片中的题目、公式、图表、手写步骤或板书内容。',
    `学生文字问题：${message}`,
    '请结合当前课堂目标进行解答，并在证据不足时标注未验证。',
  ].join('\n');
}
