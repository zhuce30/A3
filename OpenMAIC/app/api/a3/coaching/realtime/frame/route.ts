import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';
import { postA3DjangoJson } from '@/lib/server/a3-django-api';
import { validateNormalizedRegion } from '@/lib/a3/realtime-media-focus';

const MAX_IMAGE_DATA_URL_LENGTH = 7_000_000;
const FAST_VISION_TIMEOUT_MS = 12_000;

type VisionFrameResponse = {
  success?: boolean;
  reply?: string;
  verified?: boolean;
  citations?: unknown[];
  claims?: unknown[];
  safety?: Record<string, unknown>;
  refusalReason?: string;
  degraded?: boolean;
  followUps?: unknown[];
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json().catch(() => ({})) as {
      coachingSessionId?: string;
      imageDataUrl?: string;
      source?: 'camera' | 'screen' | 'upload';
      prompt?: string;
      fast?: boolean;
      region?: unknown;
    };
    const imageDataUrl = String(body.imageDataUrl || '').trim();
    if (!imageDataUrl.startsWith('data:image/')) {
      return apiError('INVALID_REQUEST', 400, '请提供摄像头、屏幕或上传图片帧');
    }
    if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      return apiError('INVALID_REQUEST', 400, '图片帧过大，请压缩后重试');
    }
    const source = body.source || 'camera';
    if (!['camera', 'screen', 'upload'].includes(source)) {
      return apiError('INVALID_REQUEST', 400, '画面来源无效');
    }
    const region = body.region === undefined ? undefined : validateNormalizedRegion(body.region);
    if (body.region !== undefined && !region) {
      return apiError('INVALID_REQUEST', 400, '分析区域无效，请重新框选');
    }
    const fast = Boolean(body.fast);
    const prompt = String(body.prompt || '').trim() || '请识别当前画面中的题目、公式、图表或板书，并结合本地知识库证据给出辅导建议。';
    const message = [
      `实时面对面辅导视觉帧来源：${source}`,
      fast ? '实时截图快速模式：优先识别画面中可见的题目、公式、图表或板书；不要等待额外检索。' : '',
      body.coachingSessionId ? `会话 ID：${body.coachingSessionId}` : '',
      region ? `用户框选区域（归一化坐标）：x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}` : '',
      prompt,
    ].filter(Boolean).join('\n');
    const visionResponse = await answerA3VisionQuestion({
      cookieHeader,
      image: imageDataUrl,
      message,
      options: fast
        ? {
            timeoutMs: FAST_VISION_TIMEOUT_MS,
            includeKnowledgeEvidence: false,
            verify: false,
          }
        : undefined,
    }).catch((error) => {
      if (!fast) throw error;
      const reason = error instanceof Error && error.name === 'TimeoutError'
        ? '视觉模型超过实时识别阈值'
        : '视觉模型暂时没有返回结果';
      return apiSuccess({
        reply: `${reason}，已收到这帧${source === 'screen' ? '屏幕' : '摄像头'}画面。请让学生指出题目区域，或再次点击“看这里/截屏分析”重试。`,
        verified: false,
        citations: [],
        claims: [],
        safety: { safe: true, category: 'fast_visual_timeout', reason },
        refusalReason: 'fast_visual_timeout',
        degraded: true,
        followUps: [],
      });
    });
    if (!visionResponse.ok) return visionResponse;

    const visionPayload = await visionResponse.json().catch(() => ({})) as VisionFrameResponse;
    if (!visionPayload.success) return apiSuccess({ ...visionPayload, visualContextPersisted: false });

    let visualContextPersisted = false;
    if (body.coachingSessionId && visionPayload.reply) {
      const persisted = await postA3DjangoJson<{ session?: unknown; error?: string }>(
        '/api/learning/coaching/session/',
        cookieHeader,
        {
          messages: [
            {
              id: `visual-frame-${randomUUID()}`,
              role: 'assistant',
              content: visionPayload.reply,
              verified: Boolean(visionPayload.verified),
              citations: Array.isArray(visionPayload.citations) ? visionPayload.citations : [],
              claims: Array.isArray(visionPayload.claims) ? visionPayload.claims : [],
              safety: visionPayload.safety && typeof visionPayload.safety === 'object' ? visionPayload.safety : undefined,
              refusalReason: String(visionPayload.refusalReason || ''),
              degraded: Boolean(visionPayload.degraded),
              metadata: {
                visualEvidence: {
                  source,
                  coachingSessionId: body.coachingSessionId,
                  prompt,
                  citationCount: Array.isArray(visionPayload.citations) ? visionPayload.citations.length : 0,
                  capturedAt: new Date().toISOString(),
                  ...(region ? { region } : {}),
                },
              },
            },
          ],
        },
      );
      visualContextPersisted = Boolean(persisted.success);
    }

    return apiSuccess({
      ...visionPayload,
      visualContextPersisted,
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时视觉帧理解失败', error instanceof Error ? error.message : undefined);
  }
}
