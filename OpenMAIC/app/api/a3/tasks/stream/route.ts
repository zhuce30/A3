import { NextRequest } from 'next/server';
import { resolveA3InternalFrontendEndpoint } from '@/lib/server/a3-django-api';

const TASKS_EVENT = 'event: tasks';
const HEARTBEAT_EVENT = 'event: heartbeat';
const ACTIVE_TASK_SNAPSHOT_INTERVAL_MS = 5_000;
const IDLE_TASK_SNAPSHOT_INTERVAL_MS = 60_000;
const TASK_SNAPSHOT_RETRY_MS = 30_000;

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;
  let snapshotInFlight = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let snapshot: ReturnType<typeof setTimeout> | null = null;

  const clearTaskStreamTimers = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (snapshot) clearTimeout(snapshot);
    heartbeat = null;
    snapshot = null;
  };

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearTaskStreamTimers();
        try {
          controller.close();
        } catch {
          // The client may have already closed the connection.
        }
      });

      const send = (event: string, data: unknown) => {
        if (closed) return;
        const eventPrefix = event === 'tasks' ? TASKS_EVENT : event === 'heartbeat' ? HEARTBEAT_EVENT : `event: ${event}`;
        controller.enqueue(encoder.encode(`${eventPrefix}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const pushTasks = async () => {
        if (closed || snapshotInFlight) return TASK_SNAPSHOT_RETRY_MS;
        snapshotInFlight = true;
        try {
          const response = await fetch(resolveA3InternalFrontendEndpoint('/api/a3/tasks', request.nextUrl.origin), {
            headers: request.headers.get('cookie') ? { cookie: request.headers.get('cookie') || '' } : {},
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => ({ success: false, error: '任务快照解析失败' }));
          send('tasks', payload);
          if (!response.ok || payload.success !== true) return TASK_SNAPSHOT_RETRY_MS;
          return Number(payload.summary?.running) > 0
            ? ACTIVE_TASK_SNAPSHOT_INTERVAL_MS
            : IDLE_TASK_SNAPSHOT_INTERVAL_MS;
        } catch (error) {
          send('tasks', {
            success: false,
            error: error instanceof Error ? error.message : '任务快照读取失败',
          });
          return TASK_SNAPSHOT_RETRY_MS;
        } finally {
          snapshotInFlight = false;
        }
      };

      const scheduleSnapshot = (delay: number) => {
        if (closed) return;
        snapshot = windowlessSetTimeout(async () => {
          snapshot = null;
          const nextDelay = await pushTasks();
          scheduleSnapshot(nextDelay);
        }, delay);
      };

      const nextDelay = await pushTasks();
      if (closed) return;
      heartbeat = windowlessSetInterval(() => send('heartbeat', { now: new Date().toISOString() }), 15000);
      scheduleSnapshot(nextDelay);
    },
    cancel() {
      closed = true;
      clearTaskStreamTimers();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function windowlessSetInterval(callback: () => void, ms: number) {
  return setInterval(callback, ms);
}

function windowlessSetTimeout(callback: () => void, ms: number) {
  return setTimeout(callback, ms);
}
