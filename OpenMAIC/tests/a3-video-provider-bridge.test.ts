import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submitSeedanceTask = vi.fn();
const pollSeedanceTask = vi.fn();

vi.mock('@/lib/media/adapters/seedance-adapter', () => ({
  submitSeedanceTask,
  pollSeedanceTask,
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveVideoApiKey: () => 'provider-secret-key',
  resolveVideoBaseUrl: () => 'https://ark.example.invalid',
}));

describe('A3 internal video provider bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.A3_VIDEO_WORKER_TOKEN = 'worker-secret-token';
  });

  afterEach(() => {
    delete process.env.A3_VIDEO_WORKER_TOKEN;
  });

  it('rejects requests without the internal worker token', async () => {
    const { POST } = await import('@/app/api/internal/a3-video-provider/route');
    const response = await POST(new Request('http://localhost/api/internal/a3-video-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'submit', provider: 'seedance', prompt: 'test' }),
    }) as never);

    expect(response.status).toBe(403);
    expect(submitSeedanceTask).not.toHaveBeenCalled();
  });

  it('submits a Seedance task and returns only its durable task ID', async () => {
    submitSeedanceTask.mockResolvedValue('seedance-task-001');
    const { POST } = await import('@/app/api/internal/a3-video-provider/route');
    const response = await POST(new Request('http://localhost/api/internal/a3-video-provider', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-a3-video-worker-token': 'worker-secret-token',
      },
      body: JSON.stringify({
        action: 'submit',
        provider: 'seedance',
        prompt: '解释进程同步',
        duration: 10,
        aspectRatio: '16:9',
        resolution: '1080p',
      }),
    }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ success: true, providerTaskId: 'seedance-task-001', status: 'queued' });
    expect(JSON.stringify(payload)).not.toContain('provider-secret-key');
  });

  it('polls an existing Seedance task without submitting another task', async () => {
    pollSeedanceTask.mockResolvedValue({
      url: 'https://example.invalid/video.mp4',
      duration: 10,
      width: 1920,
      height: 1080,
    });
    const { POST } = await import('@/app/api/internal/a3-video-provider/route');
    const response = await POST(new Request('http://localhost/api/internal/a3-video-provider', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-a3-video-worker-token': 'worker-secret-token',
      },
      body: JSON.stringify({ action: 'poll', provider: 'seedance', providerTaskId: 'seedance-task-001' }),
    }) as never);
    const payload = await response.json();

    expect(payload).toMatchObject({ success: true, status: 'succeeded', result: { duration: 10 } });
    expect(pollSeedanceTask).toHaveBeenCalledTimes(1);
    expect(submitSeedanceTask).not.toHaveBeenCalled();
  });
});
