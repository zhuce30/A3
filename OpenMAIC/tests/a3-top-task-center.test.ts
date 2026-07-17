import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeToA3TaskStream } from '@/components/a3/layout/a3-top-actions';

const topActionsPath = path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx');

describe('A3 top task center panel', () => {
  it('surfaces unified long-running tasks in the global top bar without mojibake copy', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain("type Panel = 'tasks' | 'notifications' | 'help' | 'language' | null");
    expect(source).toContain("fetch('/api/a3/tasks'");
    expect(source).toContain("new EventSource('/api/a3/tasks/stream'");
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
    const fallbackFetch = vi.fn();
    const stop = subscribeToA3TaskStream({
      loadTasks: fallbackFetch,
      onTasks: vi.fn(),
      onStateChange: vi.fn(),
    });
    const eventSource = FakeEventSource.latest!;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);

    eventSource.emit('open');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);

    eventSource.emit('tasks', JSON.stringify({ success: true, tasks: [], summary: { total: 0, running: 0, failed: 0, succeeded: 0 } }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);

    eventSource.emitError();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fallbackFetch).toHaveBeenCalledTimes(2);

    stop();
    expect(eventSource.close).toHaveBeenCalledOnce();
  });
});

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
