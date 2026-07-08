import { NextRequest } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';

const MAX_IMAGE_DATA_URL_LENGTH = 7_000_000;

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json().catch(() => ({})) as {
      coachingSessionId?: string;
      imageDataUrl?: string;
      source?: 'camera' | 'screen' | 'upload';
      prompt?: string;
    };
    const imageDataUrl = String(body.imageDataUrl || '').trim();
    if (!imageDataUrl.startsWith('data:image/')) {
      return apiError('INVALID_REQUEST', 400, '请提供摄像头、屏幕或上传图片帧');
    }
    if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      return apiError('INVALID_REQUEST', 400, '图片帧过大，请压缩后重试');
    }
    const source = body.source || 'camera';
    const prompt = String(body.prompt || '').trim() || '请识别当前画面中的题目、公式、图表或板书，并结合本地知识库证据给出辅导建议。';
    return answerA3VisionQuestion({
      cookieHeader,
      image: imageDataUrl,
      message: [
        `实时面对面辅导视觉帧来源：${source}`,
        body.coachingSessionId ? `会话 ID：${body.coachingSessionId}` : '',
        prompt,
      ].filter(Boolean).join('\n'),
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时视觉帧理解失败', error instanceof Error ? error.message : undefined);
  }
}
