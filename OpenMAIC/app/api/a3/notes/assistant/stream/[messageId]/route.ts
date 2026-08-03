import type { NextRequest } from 'next/server';

import { resolveA3DjangoEndpoint } from '@/lib/server/a3-django-api';

const POLL_INTERVAL_MS = 700;
const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 5 * 60_000;

interface RouteContext {
  params: Promise<{ messageId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const cookie = request.headers.get('cookie');
  if (!cookie) {
    return Response.json({ success: false, code: 'authentication_required', error: '请先登录' }, { status: 401 });
  }
  const { messageId: rawMessageId } = await context.params;
  const messageId = canonicalMessageId(rawMessageId);
  if (!messageId) {
    return Response.json({ success: false, code: 'invalid_message_id', error: '消息编号无效' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let maximumTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshot = '';

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        upstreamAbort.abort();
        if (pollTimer) clearTimeout(pollTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (maximumTimer) clearTimeout(maximumTimer);
        pollTimer = null;
        keepaliveTimer = null;
        maximumTimer = null;
      };
      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The browser can close the stream before server cleanup runs.
        }
      };
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      const poll = async () => {
        if (closed) return;
        try {
          const response = await fetch(
            resolveA3DjangoEndpoint(`/api/notes/assistant/messages/${encodeURIComponent(messageId)}/`),
            { headers: { Accept: 'application/json', Cookie: cookie }, cache: 'no-store', signal: upstreamAbort.signal },
          );
          const payload = await response.json().catch(() => ({ success: false, error: 'AI 回答状态解析失败' }));
          if (!response.ok || payload.success !== true || !payload.message) {
            send('stream-error', { success: false, error: payload.error || 'AI 回答状态读取失败' });
            close();
            return;
          }
          const message = payload.message;
          const snapshot = JSON.stringify({ status: message.status, content: message.content });
          const final = message.status === 'succeeded' || message.status === 'failed';
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            send(final ? 'final' : 'status', { success: true, message });
          }
          if (final) {
            close();
            return;
          }
          pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        } catch (error) {
          if (closed || isAbortError(error)) return;
          send('stream-error', { success: false, error: 'AI 回答状态读取失败' });
          close();
        }
      };

      request.signal.addEventListener('abort', close, { once: true });
      keepaliveTimer = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      }, KEEPALIVE_INTERVAL_MS);
      maximumTimer = setTimeout(() => {
        send('stream-error', { success: false, code: 'stream_timeout', error: '回答仍在处理中，请稍后重新连接' });
        close();
      }, MAX_STREAM_DURATION_MS);
      void poll();
    },
    cancel() {
      closed = true;
      upstreamAbort.abort();
      if (pollTimer) clearTimeout(pollTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (maximumTimer) clearTimeout(maximumTimer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function canonicalMessageId(raw: string) {
  let value: string;
  try {
    value = decodeURIComponent(raw).normalize('NFKC');
  } catch {
    return null;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
