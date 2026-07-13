import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchA3DjangoJson = vi.fn();
const postA3DjangoJson = vi.fn();

vi.mock('@/lib/server/a3-django-api', () => ({
  fetchA3DjangoJson,
  postA3DjangoJson,
}));

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/a3/coaching/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: 'sessionid=test',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/a3/coaching/session', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    postA3DjangoJson.mockReset();
  });

  it('proxies the latest persisted coaching session from Django', async () => {
    fetchA3DjangoJson.mockResolvedValue({
      success: true,
      session: {
        id: 'session-1',
        schemaVersion: 'a3.coaching-session.v1',
        messages: [{ id: 'assistant-1', role: 'assistant', content: '继续讲反馈控制。' }],
        summary: '围绕反馈控制答疑',
        updatedAt: '2026-07-04T10:00:00+08:00',
      },
    });
    const { GET } = await import('@/app/api/a3/coaching/session/route');

    const response = await GET(new Request('http://localhost/api/a3/coaching/session', {
      headers: { cookie: 'sessionid=test' },
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.session.messages[0].content).toBe('继续讲反馈控制。');
    expect(fetchA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/session/', 'sessionid=test');
  });

  it('persists appended coaching messages through Django', async () => {
    postA3DjangoJson.mockResolvedValue({
      success: true,
      session: {
        id: 'session-1',
        schemaVersion: 'a3.coaching-session.v1',
        messages: [{ id: 'user-1', role: 'user', content: '反馈控制是什么？' }],
        summary: '',
        updatedAt: '2026-07-04T10:01:00+08:00',
      },
    });
    const { POST } = await import('@/app/api/a3/coaching/session/route');

    const response = await POST(jsonRequest({
      messages: [{ id: 'user-1', role: 'user', content: '反馈控制是什么？' }],
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.session.messages).toHaveLength(1);
    expect(postA3DjangoJson).toHaveBeenCalledWith(
      '/api/learning/coaching/session/',
      'sessionid=test',
      { messages: [{ id: 'user-1', role: 'user', content: '反馈控制是什么？' }] },
    );
  });

  it('ends the active coaching session through Django', async () => {
    postA3DjangoJson.mockResolvedValue({
      success: true,
      session: {
        id: 'session-1',
        schemaVersion: 'a3.coaching-session.v1',
        messages: [],
        summary: '',
        updatedAt: '2026-07-04T10:02:00+08:00',
        status: 'ended',
      },
    });
    const { POST } = await import('@/app/api/a3/coaching/session/end/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/session/end', {
      method: 'POST',
      headers: { cookie: 'sessionid=test' },
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.session.status).toBe('ended');
    expect(postA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/session/end/', 'sessionid=test', {});
  });
});

describe('/api/a3/coaching/respond', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    postA3DjangoJson.mockReset();
    delete process.env.A3_VISION_COACHING_API_KEY;
    delete process.env.A3_COACHING_API_KEY;
    delete process.env.QWEN_API_KEY;
    delete process.env.ASR_QWEN_API_KEY;
  });

  it('uses the current message as the upstream retrieval question', async () => {
    fetchA3DjangoJson
      .mockResolvedValueOnce({ success: true, user: { id: 'u1' } })
      .mockResolvedValueOnce({
        success: true,
        answer: '反馈控制会比较目标与输出。',
        verified: true,
        citations: [],
        claims: [],
        modelRuntime: { provider: 'dashscope', model: 'qwen-plus', fallback: false },
      });
    const { POST } = await import('@/app/api/a3/coaching/respond/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        message: '它和开环控制有什么区别？',
        history: [
          { role: 'user', content: '反馈控制是什么？' },
          { role: 'assistant', content: '反馈控制会把输出回送。' },
        ],
      }),
    }) as never);

    expect(response.status).toBe(200);
    const payload = await response.clone().json();
    expect(payload.modelRuntime).toEqual({ provider: 'dashscope', model: 'qwen-plus', fallback: false });
    const upstreamPath = fetchA3DjangoJson.mock.calls[1][0] as string;
    expect(decodeURIComponent(upstreamPath)).not.toContain('最近对话：');
    expect(decodeURIComponent(upstreamPath)).toContain('它和开环控制有什么区别？');
    expect(decodeURIComponent(upstreamPath)).not.toContain('学生：反馈控制是什么？');
    expect(decodeURIComponent(upstreamPath)).not.toContain('小智：反馈控制会把输出回送。');
  });

  it('falls back to text QA when visual evidence answering fails', async () => {
    process.env.A3_VISION_COACHING_API_KEY = 'test-key';
    fetchA3DjangoJson.mockImplementation((path: string) => {
      if (path === '/api/auth/me/') return Promise.resolve({ success: true, user: { id: 'u1' } });
      if (path === '/api/learning/classroom/') return Promise.reject(new Error('visual evidence unavailable'));
      if (path.startsWith('/api/v1/qa/interact/')) {
        return Promise.resolve({
          success: true,
          answer: '杆件的几何要素包括轴线、横截面形状和尺寸等。',
          verified: true,
          citations: [],
          claims: [],
        });
      }
      return Promise.resolve({ success: true, results: [] });
    });
    const { POST } = await import('@/app/api/a3/coaching/respond/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        message: '杆件的几何要素有哪些？',
        history: [],
      }),
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.reply).toContain('杆件的几何要素');
    const qaCall = fetchA3DjangoJson.mock.calls.find((call) => String(call[0]).startsWith('/api/v1/qa/interact/'));
    expect(qaCall?.[0]).toEqual(expect.stringContaining('/api/v1/qa/interact/'));
    expect(qaCall?.[1]).toBe('sessionid=test');
  });

  it('forwards deep retrieval mode and material scope to backend QA', async () => {
    fetchA3DjangoJson
      .mockResolvedValueOnce({ success: true, user: { id: 'u1' } })
      .mockResolvedValueOnce({
        success: true,
        answer: '根轨迹法来自你上传的 PPTX 资料。',
        verified: true,
        citations: [{ title: '4. 根轨迹法.pptx', sourceScope: 'personal' }],
        claims: [],
        retrievalMode: 'indexed_blocks_deep',
        traceId: 'trace-deep-personal',
      });
    const { POST } = await import('@/app/api/a3/coaching/respond/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        message: '从我上传的 PPTX 里解释根轨迹法',
        mode: 'deep',
        scope: 'personal',
        history: [],
      }),
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.retrievalMode).toBe('indexed_blocks_deep');
    expect(payload.traceId).toBe('trace-deep-personal');
    expect(fetchA3DjangoJson).toHaveBeenCalledTimes(2);
    expect(fetchA3DjangoJson).not.toHaveBeenCalledWith('/api/learning/classroom/', 'sessionid=test');
    const upstreamPath = fetchA3DjangoJson.mock.calls[1][0] as string;
    const upstreamUrl = new URL(upstreamPath, 'http://localhost');
    expect(upstreamUrl.pathname).toBe('/api/v1/qa/interact/');
    expect(upstreamUrl.searchParams.get('mode')).toBe('deep');
    expect(upstreamUrl.searchParams.get('scope')).toBe('personal');
    expect(upstreamUrl.searchParams.get('q')).toBe('从我上传的 PPTX 里解释根轨迹法');
  });

  it('returns a retryable timeout error instead of fake fallback for deep personal retrieval', async () => {
    fetchA3DjangoJson
      .mockResolvedValueOnce({ success: true, user: { id: 'u1' } })
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const { POST } = await import('@/app/api/a3/coaching/respond/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        message: '请从我上传的资料里检索这个概念',
        mode: 'deep',
        scope: 'personal',
        history: [],
      }),
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe('UPSTREAM_TIMEOUT');
    expect(payload.retrievalMode).not.toBe('timeout_fallback');

    const upstreamPath = fetchA3DjangoJson.mock.calls[1][0] as string;
    const upstreamUrl = new URL(upstreamPath, 'http://localhost');
    expect(upstreamUrl.pathname).toBe('/api/v1/qa/interact/');
    expect(upstreamUrl.searchParams.get('mode')).toBe('deep');
    expect(upstreamUrl.searchParams.get('scope')).toBe('personal');
  });

  it('returns a retryable timeout error instead of fake fallback for default classroom retrieval', async () => {
    fetchA3DjangoJson.mockImplementation((path: string) => {
      if (path === '/api/auth/me/') return Promise.resolve({ success: true, user: { id: 'u1' } });
      if (path === '/api/learning/classroom/') return Promise.reject(new Error('visual evidence unavailable'));
      if (path.startsWith('/api/v1/qa/interact/')) {
        return Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      }
      return Promise.resolve({ success: true, results: [] });
    });
    const { POST } = await import('@/app/api/a3/coaching/respond/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        message: '请从我上传的资料里检索这个概念',
        history: [],
      }),
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe('UPSTREAM_TIMEOUT');
    expect(payload.retrievalMode).not.toBe('timeout_fallback');

    const qaCall = fetchA3DjangoJson.mock.calls.find((call) => String(call[0]).startsWith('/api/v1/qa/interact/'));
    const upstreamUrl = new URL(qaCall?.[0] as string, 'http://localhost');
    expect(upstreamUrl.searchParams.get('mode')).toBe('fast');
    expect(upstreamUrl.searchParams.get('scope')).toBe('all');
  });
});
