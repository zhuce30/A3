import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchA3DjangoJson = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/a3-django-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/a3-django-api')>();
  return {
    ...actual,
    fetchA3DjangoJson,
  };
});

const tasksRoutePath = path.resolve(process.cwd(), 'app/api/a3/tasks/route.ts');
const tasksStreamRoutePath = path.resolve(process.cwd(), 'app/api/a3/tasks/stream/route.ts');
const resourceJobsRoutePath = path.resolve(process.cwd(), 'app/api/a3/resources/jobs/route.ts');
const topActionsPath = path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx');

describe('A3 unified task APIs', () => {
  it('exposes a unified task list endpoint across resource, video, and knowledge workflows', () => {
    const source = fs.readFileSync(tasksRoutePath, 'utf8');

    expect(source).toContain('export async function GET');
    expect(source).toContain("'/api/resources/jobs/'");
    expect(source).toContain("'/api/kb/jobs/'");
    expect(source).toContain("'/api/a3/resources/openmaic-video'");
    expect(source).toContain('normalizeResourceGenerationTask');
    expect(source).toContain('normalizeKnowledgeIndexTask');
    expect(source).toContain('normalizeOpenMAICVideoTask');
    expect(source).toContain('progressDetail');
    expect(source).toContain('normalizeProgressDetail');
    expect(source).toContain('actionUrl');
    expect(source).toContain('safeDjangoTaskRequest');
    expect(source).toContain('degraded');
    expect(source).toContain('canCancel: Boolean(job.canCancel)');
    expect(source).not.toMatch(/[�]|锟|鍥|璇|瀹|涓€|闄|鏆|绯|鎬|杩|浠诲姟|璧勬簮|鐭ヨ瘑|瑙嗛|鐢熸垚/);
  });

  it('exposes an SSE task stream endpoint with heartbeat and task snapshots', () => {
    const source = fs.readFileSync(tasksStreamRoutePath, 'utf8');

    expect(source).toContain('export async function GET');
    expect(source).toContain('text/event-stream');
    expect(source).toContain('ReadableStream');
    expect(source).toContain('event: tasks');
    expect(source).toContain('event: heartbeat');
    expect(source).toContain("'/api/a3/tasks'");
    expect(source).toContain('cancel()');
    expect(source).toContain('clearTaskStreamTimers');
  });

  it('persists resource generation jobs through Django instead of only storing them in memory', () => {
    const source = fs.readFileSync(resourceJobsRoutePath, 'utf8');

    expect(source).toContain("'/api/resources/jobs/'");
    expect(source).toContain("`/api/resources/jobs/${encodeURIComponent(jobId)}/`");
    expect(source).toContain('persistResourceGenerationJob');
    expect(source).not.toContain('patchResourceGenerationJob');
    expect(source).not.toContain('void runResourceGenerationJob');
    expect(source).not.toContain('const resourceGenerationJobs = new Map');
  });

  it('does not poll protected task or notification APIs before login', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain('useA3CurrentUser');
    expect(source).toContain('if (!currentUser) return;');
    expect(source).toContain('}, [currentUser]);');
  });
});

describe('A3 unified task API production routing', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    process.env.A3_INTERNAL_FRONTEND_BASE_URL = 'http://127.0.0.1:3000';
  });

  afterEach(() => {
    delete process.env.A3_INTERNAL_FRONTEND_BASE_URL;
    vi.unstubAllGlobals();
  });

  it('uses the internal frontend origin for server-side task aggregation', async () => {
    fetchA3DjangoJson.mockResolvedValue({ success: false, error: '请先登录' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: '请先登录' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/a3/tasks/route');

    await GET({
      headers: new Headers(),
      nextUrl: new URL('https://a3.zhuce.work/api/a3/tasks'),
    } as never);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:3000/api/a3/resources/openmaic-video');
  });

  it('returns a degraded task snapshot when the internal video task source is unreachable', async () => {
    fetchA3DjangoJson.mockRejectedValue(new Error('backend unavailable'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('internal frontend unavailable')));
    const { GET } = await import('@/app/api/a3/tasks/route');

    const response = await GET({
      headers: new Headers(),
      nextUrl: new URL('https://a3.zhuce.work/api/a3/tasks'),
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.degraded).toBe(true);
    expect(payload.tasks).toEqual([]);
  });
});

describe('A3 task stream polling cadence', () => {
  const abortControllers: AbortController[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    abortControllers.splice(0).forEach((controller) => controller.abort());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes active tasks after 5 seconds and idle tasks after 60 seconds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(taskSnapshotResponse(1))
      .mockResolvedValueOnce(taskSnapshotResponse(0))
      .mockResolvedValueOnce(taskSnapshotResponse(0));
    vi.stubGlobal('fetch', fetchMock);
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    await GET(taskStreamRequest(abortController.signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    abortController.abort();
  });

  it('retries unsuccessful task snapshots after 30 seconds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(taskSnapshotResponse(0, false))
      .mockResolvedValueOnce(taskSnapshotResponse(0));
    vi.stubGlobal('fetch', fetchMock);
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    await GET(taskStreamRequest(abortController.signal));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    abortController.abort();
  });

  it('uses the 30 second error cadence for an HTTP 200 logical failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(taskSnapshotResponse(0, false, 200))
      .mockResolvedValueOnce(taskSnapshotResponse(0));
    vi.stubGlobal('fetch', fetchMock);
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    await GET(taskStreamRequest(abortController.signal));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    abortController.abort();
  });

  it('keeps only one task snapshot in flight per connection', async () => {
    let resolveSecondSnapshot!: (response: Response) => void;
    const secondSnapshot = new Promise<Response>((resolve) => {
      resolveSecondSnapshot = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(taskSnapshotResponse(1))
      .mockReturnValueOnce(secondSnapshot);
    vi.stubGlobal('fetch', fetchMock);
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    await GET(taskStreamRequest(abortController.signal));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecondSnapshot(taskSnapshotResponse(1));
    await vi.advanceTimersByTimeAsync(0);
    abortController.abort();
  });

  it('does not reschedule after aborting while a snapshot is in flight', async () => {
    let resolveSecondSnapshot!: (response: Response) => void;
    const secondSnapshot = new Promise<Response>((resolve) => {
      resolveSecondSnapshot = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(taskSnapshotResponse(1))
      .mockReturnValueOnce(secondSnapshot);
    vi.stubGlobal('fetch', fetchMock);
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    await GET(taskStreamRequest(abortController.signal));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upstreamSignal = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.signal;
    expect(upstreamSignal?.aborted).toBe(false);

    abortController.abort();
    expect(upstreamSignal?.aborted).toBe(true);
    resolveSecondSnapshot(taskSnapshotResponse(1));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not reschedule after the stream consumer cancels', async () => {
    let resolveSecondSnapshot!: (response: Response) => void;
    const secondSnapshot = new Promise<Response>((resolve) => {
      resolveSecondSnapshot = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(taskSnapshotResponse(1))
      .mockReturnValueOnce(secondSnapshot);
    vi.stubGlobal('fetch', fetchMock);
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    const response = await GET(taskStreamRequest(abortController.signal));
    const reader = response.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upstreamSignal = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.signal;
    expect(upstreamSignal?.aborted).toBe(false);

    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
    resolveSecondSnapshot(taskSnapshotResponse(1));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('emits the existing tasks event framing with the snapshot payload unchanged', async () => {
    const payload = {
      success: true,
      tasks: [{ id: 'task-1', status: 'running' }],
      summary: { total: 1, running: 1, failed: 0, succeeded: 0 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const abortController = createTaskStreamAbortController(abortControllers);
    const { GET } = await import('@/app/api/a3/tasks/stream/route');

    const response = await GET(taskStreamRequest(abortController.signal));
    const reader = response.body!.getReader();
    const firstEvent = await reader.read();

    expect(firstEvent.done).toBe(false);
    expect(new TextDecoder().decode(firstEvent.value)).toBe(`event: tasks\ndata: ${JSON.stringify(payload)}\n\n`);

    await reader.cancel();
  });
});

function taskSnapshotResponse(running: number, success = true, status = success ? 200 : 503) {
  return new Response(JSON.stringify({
    success,
    tasks: [],
    summary: { total: running, running, failed: 0, succeeded: 0 },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function taskStreamRequest(signal: AbortSignal) {
  return {
    signal,
    headers: new Headers(),
    nextUrl: new URL('https://a3.zhuce.work/api/a3/tasks/stream'),
  } as never;
}

function createTaskStreamAbortController(abortControllers: AbortController[]) {
  const abortController = new AbortController();
  abortControllers.push(abortController);
  return abortController;
}
