import { NextRequest } from 'next/server';

import { apiError } from '@/lib/server/api-response';
import { resolveA3DjangoEndpoint } from '@/lib/server/a3-django-api';


type RouteContext = {
  params: Promise<{ playbackId: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORWARDED_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
] as const;

export async function GET(request: NextRequest, context: RouteContext) {
  const { playbackId } = await context.params;
  if (!UUID_PATTERN.test(playbackId)) {
    return apiError('INVALID_REQUEST', 400, '视频播放标识无效');
  }

  const cookie = request.headers.get('cookie');
  const range = request.headers.get('range');
  const upstream = await fetch(
    resolveA3DjangoEndpoint(`/api/resources/video-playback/${encodeURIComponent(playbackId)}/`),
    {
      method: 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(range ? { Range: range } : {}),
        Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.1',
      },
      cache: 'no-store',
    },
  );

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, no-store');
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
