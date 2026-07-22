import { NextRequest } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { resolveA3DjangoEndpoint } from '@/lib/server/a3-django-api';

const ALLOWED_ASSETS = new Set(['final', 'narration', 'subtitles', 'audio']);

export async function GET(request: NextRequest, context: { params: Promise<{ asset: string }> }) {
  const { asset } = await context.params;
  if (!ALLOWED_ASSETS.has(asset)) return apiError('INVALID_REQUEST', 404, '不支持的媒体文件');
  const jobId = String(request.nextUrl.searchParams.get('jobId') || '').trim();
  const playbackId = String(request.nextUrl.searchParams.get('playbackId') || '').trim();
  let path = '';
  if (asset === 'audio') {
    if (!/^[0-9a-f-]{36}$/i.test(playbackId)) return apiError('INVALID_REQUEST', 400, '无效的音频标识');
    path = `/api/resources/video-audio/${encodeURIComponent(playbackId)}/`;
  } else {
    if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');
    path = `/api/resources/video-jobs/${encodeURIComponent(jobId)}/composition/assets/${asset}/`;
  }
  const upstream = await fetch(resolveA3DjangoEndpoint(path), {
    headers: {
      ...(request.headers.get('cookie') ? { Cookie: request.headers.get('cookie') as string } : {}),
      ...(request.headers.get('range') ? { Range: request.headers.get('range') as string } : {}),
    },
    cache: 'no-store',
  });
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
