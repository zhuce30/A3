'use client';

export type A3TaskStreamState = 'live' | 'fallback';
export type A3TaskUpdateSource = 'sse' | 'fallback';

export function startA3TaskStream<T>({
  loadTasks,
  parseTasksEvent,
  onTasks,
  onStateChange,
}: {
  loadTasks: (signal: AbortSignal) => Promise<T | null>;
  parseTasksEvent: (data: string) => T | null;
  onTasks: (result: T, source: A3TaskUpdateSource) => void;
  onStateChange: (state: A3TaskStreamState) => void;
}) {
  let closed = false;
  let streamLive = false;
  let fallbackInFlight = false;
  let fallbackController: AbortController | null = null;

  const abortFallback = () => {
    fallbackController?.abort();
  };

  const runFallback = async () => {
    if (closed || streamLive || fallbackInFlight) return;
    const controller = new AbortController();
    fallbackController = controller;
    fallbackInFlight = true;
    try {
      const result = await loadTasks(controller.signal);
      if (closed || streamLive || controller.signal.aborted || result === null) return;
      onTasks(result, 'fallback');
    } finally {
      if (fallbackController === controller) fallbackController = null;
      fallbackInFlight = false;
    }
  };

  const markStreamLive = () => {
    streamLive = true;
    abortFallback();
    onStateChange('live');
  };

  const eventSource = new EventSource('/api/a3/tasks/stream', { withCredentials: true });
  eventSource.addEventListener('open', () => {
    if (closed) return;
    markStreamLive();
  });
  eventSource.addEventListener('tasks', (event) => {
    const result = parseTasksEvent((event as MessageEvent).data);
    if (!result || closed) return;
    markStreamLive();
    onTasks(result, 'sse');
  });
  eventSource.onerror = () => {
    if (closed) return;
    streamLive = false;
    onStateChange('fallback');
  };

  const fallbackTimer = window.setInterval(() => void runFallback(), 15_000);
  void runFallback();

  return () => {
    closed = true;
    abortFallback();
    eventSource.close();
    window.clearInterval(fallbackTimer);
  };
}
