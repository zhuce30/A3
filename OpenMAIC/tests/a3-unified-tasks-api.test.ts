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
    expect(source).toContain('patchResourceGenerationJob');
    expect(source).not.toContain('const resourceGenerationJobs = new Map');
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
