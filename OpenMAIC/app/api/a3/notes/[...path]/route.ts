import type { NextRequest } from 'next/server';

import { resolveA3DjangoCsrf, resolveA3DjangoEndpoint } from '@/lib/server/a3-django-api';

const ALLOWED_ROOTS = new Set([
  'notes',
  'notebooks',
  'tags',
  'attachments',
  'exports',
  'search',
  'assistant',
  'ai-sessions',
  'digests',
  'memories',
]);
const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'x-csrftoken',
  'x-csrf-token',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
] as const;
const RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'etag',
  'last-modified',
] as const;

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

type ProxyMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type NodeRequestInit = RequestInit & { duplex?: 'half' };

async function proxy(request: NextRequest, context: RouteContext, method: ProxyMethod) {
  if (!request.headers.get('cookie')) {
    return Response.json({ success: false, code: 'authentication_required', error: '请先登录' }, { status: 401 });
  }
  const { path } = await context.params;
  const safePath = canonicalizePath(path);
  if (!safePath) {
    return Response.json({ success: false, code: 'invalid_notes_proxy_path', error: '笔记请求路径不安全' }, { status: 400 });
  }
  const headers = forwardedRequestHeaders(request.headers);
  if (method !== 'GET' && !headers['X-CSRFToken'] && !headers['X-CSRF-Token']) {
    const csrf = await resolveA3DjangoCsrf(headers.Cookie ?? null);
    if (csrf.cookieHeader) headers.Cookie = csrf.cookieHeader;
    if (csrf.token) headers['X-CSRFToken'] = csrf.token;
  }
  const init: NodeRequestInit = {
    method,
    headers,
    cache: 'no-store',
    signal: request.signal,
  };
  if (method !== 'GET' && request.body) {
    if ((request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      init.body = await request.arrayBuffer();
    } else {
      init.body = request.body;
      init.duplex = 'half';
    }
  }
  const query = request.nextUrl.search;
  const upstream = await fetch(resolveA3DjangoEndpoint(`/api/notes/${safePath}/${query}`), init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers),
  });
}

function canonicalizePath(path: string[]) {
  if (!Array.isArray(path) || path.length === 0) return null;
  const canonical: string[] = [];
  for (const rawSegment of path) {
    if (!rawSegment) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment).normalize('NFKC');
    } catch {
      return null;
    }
    if (
      !segment
      || segment === '.'
      || segment === '..'
      || segment.includes('%')
      || segment.includes('/')
      || segment.includes('\\')
      || segment.includes(':')
      || [...segment].some((character) => {
        const code = character.charCodeAt(0);
        return code === 0 || code < 32 || code === 127;
      })
    ) {
      return null;
    }
    canonical.push(segment);
  }
  if (!ALLOWED_ROOTS.has(canonical[0])) return null;
  return canonical.map(encodeURIComponent).join('/');
}

function forwardedRequestHeaders(source: Headers) {
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = source.get(name);
    if (value) headers[canonicalHeaderName(name)] = value;
  }
  return headers;
}

function forwardedResponseHeaders(source: Headers) {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function canonicalHeaderName(name: typeof REQUEST_HEADERS[number]) {
  const names: Record<typeof REQUEST_HEADERS[number], string> = {
    accept: 'Accept',
    'content-type': 'Content-Type',
    cookie: 'Cookie',
    origin: 'Origin',
    referer: 'Referer',
    'x-csrftoken': 'X-CSRFToken',
    'x-csrf-token': 'X-CSRF-Token',
    'idempotency-key': 'Idempotency-Key',
    'if-match': 'If-Match',
    'if-none-match': 'If-None-Match',
    'if-modified-since': 'If-Modified-Since',
    'if-unmodified-since': 'If-Unmodified-Since',
  };
  return names[name];
}

export const GET = (request: NextRequest, context: RouteContext) => proxy(request, context, 'GET');
export const POST = (request: NextRequest, context: RouteContext) => proxy(request, context, 'POST');
export const PATCH = (request: NextRequest, context: RouteContext) => proxy(request, context, 'PATCH');
export const DELETE = (request: NextRequest, context: RouteContext) => proxy(request, context, 'DELETE');
