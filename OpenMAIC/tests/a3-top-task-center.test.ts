import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startA3TaskStream } from '@/lib/a3/task-stream-client';

const topActionsPath = path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx');

describe('A3 top task center panel', () => {
  it('surfaces unified long-running tasks in the global top bar without mojibake copy', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain("type Panel = 'tasks' | 'notifications' | 'help' | 'language' | null");
    expect(source).toContain('data-testid="a3-top-tasks-trigger"');
    expect(source).toContain('data-testid="a3-top-tasks-panel"');
    expect(source).toContain('data-testid="a3-top-task-item"');
    expect(source).toContain('任务中心');
    expect(source).toContain('formatTaskStatus');
    expect(source).not.toMatch(/[�]|锟|鍥|璇|瀹|涓€|闄|鏆|绯|鎬|杩|浠诲姟|璧勬簮|鐭ヨ瘑|瑙嗛/);
  });

  it('renders real knowledge-base progress details from backend task payloads', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain('progressDetail?: A3TaskProgressDetail');
    expect(source).toContain('data-testid="a3-top-task-progress-detail"');
    expect(source).toContain('data-testid="a3-top-task-progress-event"');
    expect(source).toContain('renderProgressCounters');
    expect(source).toContain('recentEvents');
  });

  it('lets owners cancel queued or running resource generation tasks', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain('canCancel?: boolean');
    expect(source).toContain('data-testid="a3-top-task-cancel"');
    expect(source).toContain('`/api/resources/jobs/${encodeURIComponent(task.id)}/cancel/`');
    expect(source).toContain('取消任务');
  });

  it('keeps the task list scrollable inside the viewport', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain('data-testid="a3-top-tasks-panel"');
    expect(source).toContain('fixed inset-x-2 top-[68px]');
    expect(source).toContain('max-h-[calc(100dvh-88px)]');
    expect(source).toContain('sm:absolute sm:inset-x-auto sm:right-0 sm:top-12');
    expect(source).toContain('data-testid="a3-top-tasks-scroll"');
    expect(source).toContain('aria-label="任务列表"');
    expect(source).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.latest = null;
  });

  it('polls every 15 seconds only while the SSE connection is not live', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.stubGlobal('EventSource', FakeEventSource);
    const fallbackLoad = vi.fn().mockResolvedValue({ success: true, source: 'fallback' });
    const onTasks = vi.fn();
    const stop = startA3TaskStream({
      loadTasks: fallbackLoad,
      parseTasksEvent,
      onTasks,
      onStateChange: vi.fn(),
    });
    const eventSource = FakeEventSource.latest!;

    await vi.advanceTimersByTimeAsync(0);
    expect(fallbackLoad).toHaveBeenCalledTimes(1);

    eventSource.emit('tasks', JSON.stringify({ success: true, source: 'sse' }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fallbackLoad).toHaveBeenCalledTimes(1);

    eventSource.emitError();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fallbackLoad).toHaveBeenCalledTimes(2);

    eventSource.emit('open');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fallbackLoad).toHaveBeenCalledTimes(2);

    stop();
    expect(eventSource.close).toHaveBeenCalledOnce();
  });

  it('serializes fallback loads and aborts the outstanding load on cleanup', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.stubGlobal('EventSource', FakeEventSource);
    const firstLoad = deferred<{ success: boolean }>();
    const secondLoad = deferred<{ success: boolean }>();
    const signals: AbortSignal[] = [];
    const loadTasks = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? firstLoad.promise : secondLoad.promise;
    });
    const stop = startA3TaskStream({ loadTasks, parseTasksEvent, onTasks: vi.fn(), onStateChange: vi.fn() });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(loadTasks).toHaveBeenCalledTimes(1);

    firstLoad.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(loadTasks).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    stop();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('aborts and ignores a stale fallback response after SSE recovery', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.stubGlobal('EventSource', FakeEventSource);
    const fallbackLoad = deferred<{ success: boolean; source: string }>();
    let fallbackSignal: AbortSignal | undefined;
    const onTasks = vi.fn();
    const stop = startA3TaskStream({
      loadTasks(signal: AbortSignal) {
        fallbackSignal = signal;
        return fallbackLoad.promise;
      },
      parseTasksEvent,
      onTasks,
      onStateChange: vi.fn(),
    });
    const eventSource = FakeEventSource.latest!;
    await vi.advanceTimersByTimeAsync(0);

    eventSource.emitError();
    eventSource.emit('tasks', JSON.stringify({ success: true, source: 'sse' }));
    expect(fallbackSignal?.aborted).toBe(true);
    expect(onTasks).toHaveBeenCalledTimes(1);
    expect(onTasks).toHaveBeenLastCalledWith({ success: true, source: 'sse' }, 'sse');

    fallbackLoad.resolve({ success: true, source: 'stale-fallback' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onTasks).toHaveBeenCalledTimes(1);

    stop();
  });
});

function parseTasksEvent(data: string) {
  try {
    return JSON.parse(data) as { success: boolean; source?: string };
  } catch {
    return null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeEventSource {
  static latest: FakeEventSource | null = null;

  readonly close = vi.fn();
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: unknown) => void>();

  constructor() {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data?: string) {
    this.listeners.get(type)?.({ data });
  }

  emitError() {
    this.onerror?.();
  }
}
