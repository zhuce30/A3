import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchA3DjangoJson = vi.fn();
const postA3DjangoJson = vi.fn();

vi.mock('@/lib/server/a3-django-api', () => ({
  fetchA3DjangoJson,
  postA3DjangoJson,
}));

describe('/api/a3/coaching/sessions', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    postA3DjangoJson.mockReset();
  });

  it('proxies recent coaching sessions from Django', async () => {
    fetchA3DjangoJson.mockResolvedValue({
      success: true,
      sessions: [{ id: 'session-1', topicTitle: '反馈控制结构', questionCount: 2 }],
    });
    const { GET } = await import('@/app/api/a3/coaching/sessions/route');

    const response = await GET(new Request('http://localhost/api/a3/coaching/sessions?limit=10', {
      headers: { cookie: 'sessionid=test' },
    }) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      sessions: [{ id: 'session-1', topicTitle: '反馈控制结构', questionCount: 2 }],
    });
    expect(fetchA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/sessions/?limit=10', 'sessionid=test');
  });
});

describe('/api/a3/coaching/session/[sessionId]', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    postA3DjangoJson.mockReset();
  });

  it('proxies a single session detail from Django', async () => {
    fetchA3DjangoJson.mockResolvedValue({
      success: true,
      session: { id: 'session-1', messages: [{ id: 'm1', role: 'user', content: '反馈控制是什么？' }] },
    });
    const { GET } = await import('@/app/api/a3/coaching/session/[sessionId]/route');

    const response = await GET(new Request('http://localhost/api/a3/coaching/session/session-1', {
      headers: { cookie: 'sessionid=test' },
    }) as never, { params: Promise.resolve({ sessionId: 'session-1' }) });

    expect(response.status).toBe(200);
    expect(fetchA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/sessions/session-1/', 'sessionid=test');
  });
});

describe('/api/a3/coaching/session/summary', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    postA3DjangoJson.mockReset();
  });

  it('requests backend-owned summary generation', async () => {
    postA3DjangoJson.mockResolvedValue({
      success: true,
      summary: { questionCount: 1, nextAction: { label: '生成随堂测评', href: '/a3/assessment' } },
    });
    const { POST } = await import('@/app/api/a3/coaching/session/summary/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/session/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    }) as never);

    expect(response.status).toBe(201);
    expect(postA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/sessions/session-1/summary/', 'sessionid=test', {});
  });
});
