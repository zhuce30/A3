import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';

type SearchResponse = {
  results?: Array<{
    title?: string;
    resourceName?: string;
    location?: string | { page?: number | null; slide?: number | null };
    snippet?: string;
    text?: string;
    score?: number | null;
    previewUrl?: string;
    modality?: string;
    asset?: { previewUrl?: string } | null;
    metadata?: Record<string, unknown>;
  }>;
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json().catch(() => ({})) as {
      toolName?: string;
      query?: string;
      topK?: number;
      includeVisualEvidence?: boolean;
    };
    if (body.toolName !== 'retrieve_learning_evidence') {
      return apiError('INVALID_REQUEST', 400, '不支持的实时辅导工具');
    }
    const query = String(body.query || '').trim();
    if (!query) return apiError('MISSING_REQUIRED_FIELD', 400, '请提供检索问题');
    const topK = Math.max(1, Math.min(Number(body.topK || 5), 8));
    const includeVisualEvidence = body.includeVisualEvidence !== false;
    const search = await fetchA3DjangoJson<SearchResponse>(
      `/api/kb/search/?q=${encodeURIComponent(query)}&top_k=${topK}&include_assets=${includeVisualEvidence ? '1' : '0'}&fast=1`,
      cookieHeader,
    );
    if (!search.success) return apiError('UPSTREAM_ERROR', 502, search.error || '知识库检索失败');

    return apiSuccess({
      evidence: (search.results || []).slice(0, topK).map((item) => {
        const previewUrl = item.asset?.previewUrl || item.previewUrl || '';
        return {
          title: item.title || item.resourceName || String(item.metadata?.original_name || item.metadata?.title || '本地知识库证据'),
          location: formatLocation(item.location, item.metadata),
          snippet: String(item.snippet || item.text || item.metadata?.snippet || '').slice(0, 600),
          score: item.score ?? null,
          previewUrl,
          sourceType: previewUrl ? 'visual' : item.modality === 'mixed' ? 'mixed' : 'text',
        };
      }),
      safety: { safe: true, category: 'learning', reason: '知识库检索工具调用' },
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时辅导检索工具暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

function formatLocation(location?: string | { page?: number | null; slide?: number | null }, metadata?: Record<string, unknown>) {
  if (typeof location === 'string' && location) return location;
  if (!location || typeof location !== 'object') {
    if (metadata?.display_location) return String(metadata.display_location);
    return '本地知识库';
  }
  if (location?.slide) return `第 ${location.slide} 张幻灯片`;
  if (location?.page) return `第 ${location.page} 页`;
  if (metadata?.display_location) return String(metadata.display_location);
  return '本地知识库';
}
