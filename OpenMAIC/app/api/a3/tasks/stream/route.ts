import { NextRequest } from 'next/server';

const TASKS_EVENT = 'event: tasks';
const HEARTBEAT_EVENT = 'event: heartbeat';

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let snapshot: ReturnType<typeof setInterval> | null = null;

  const clearTaskStreamTimers = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (snapshot) clearInterval(snapshot);
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
        try {
          const response = await fetch(new URL('/api/a3/tasks', request.nextUrl.origin), {
            headers: request.headers.get('cookie') ? { cookie: request.headers.get('cookie') || '' } : {},
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => ({ success: false, error: '任务快照解析失败' }));
          send('tasks', payload);
        } catch (error) {
          send('tasks', {
            success: false,
            error: error instanceof Error ? error.message : '任务快照读取失败',
          });
        }
      };

      await pushTasks();
      if (closed) return;
      heartbeat = windowlessSetInterval(() => send('heartbeat', { now: new Date().toISOString() }), 15000);
      snapshot = windowlessSetInterval(() => void pushTasks(), 2500);
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
