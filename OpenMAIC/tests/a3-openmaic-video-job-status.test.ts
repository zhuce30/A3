import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchA3DjangoJson = vi.fn();
const postA3DjangoJson = vi.fn();

vi.mock('@/lib/server/a3-django-api', () => ({
  fetchA3DjangoJson,
  postA3DjangoJson,
}));

const routePath = path.resolve(process.cwd(), 'app/api/a3/resources/openmaic-video/route.ts');
const recommendationsPath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fetchA3DjangoJson.mockResolvedValue({ success: true, user: { id: 'student-1' } });
});

describe('A3 OpenMAIC video job polling contract', () => {
  it('proxies durable video job creation instead of storing jobs in process memory', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).not.toContain('new Map<');
    expect(source).not.toContain('const videoJobs');
    expect(source).toContain("`/api/resources/packs/${resourcePackId}/video-jobs/`");
    expect(source).toContain('postA3DjangoJson<DjangoVideoJobResponse>');
    expect(source).toContain('segments: segmentRequests.map');
    expect(source).toContain('jobId: String(body.jobId');
    expect(source).toContain('export async function GET');
    expect(source).toContain('pollUrl');
    expect(source).toContain('pollIntervalMs');
    expect(source).toContain('}, 202)');
  });

  it('proxies durable job list, detail, and failed-only retry endpoints', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain("'/api/resources/video-jobs/'");
    expect(source).toContain('`/api/resources/video-jobs/${encodeURIComponent(jobId)}/`');
    expect(source).toContain('export async function PATCH');
    expect(source).toContain('`/api/resources/video-jobs/${encodeURIComponent(jobId)}/retry-failed/`');
    expect(source).toContain("action !== 'retry-failed'");
    expect(source).toContain("action === 'import-legacy-failures'");
    expect(source).toContain('`/api/resources/packs/${resourcePackId}/video-jobs/import-legacy/`');
    expect(source).not.toContain('body.videoUrl');
    expect(source).not.toContain('body.segments');
    expect(source).toContain("fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/'");
    expect(source).toContain("apiError('UNAUTHORIZED', 401");
  });

  it('imports legacy failures through the pack endpoint with server-built sanitized segments', async () => {
    postA3DjangoJson.mockResolvedValue({
      success: true,
      importedSucceeded: 4,
      queuedFailed: 2,
      job: {
        jobId: 'a3_legacy_video_job',
        status: 'queued',
        progress: 66,
        stage: 'queued',
        message: 'queued',
        done: false,
        resourcePackId: 'pack-1',
      },
    });
    const { PATCH } = await import('@/app/api/a3/resources/openmaic-video/route');
    const { buildSegmentedVideoRequests } = await import('@/lib/server/a3-video-prompt');
    const response = await PATCH(new NextRequest('https://a3.zhuce.work/api/a3/resources/openmaic-video', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        action: 'import-legacy-failures',
        resourcePackId: 'pack-1',
        prompt: 'Explain operating-system deadlocks',
        provider: 'seedance',
        aspectRatio: '9:16',
        resolution: '720p',
        videoUrl: 'https://browser.invalid/forged.mp4',
        segments: [{ index: 1, videoUrl: 'https://browser.invalid/segment.mp4' }],
      }),
    }));
    const payload = await response.json();
    const expectedSegments = buildSegmentedVideoRequests({
      prompt: 'Explain operating-system deadlocks',
      duration: 60,
      aspectRatio: '9:16',
      resolution: '720p',
    }).map((segment, index) => ({
      index: index + 1,
      title: segment.title,
      prompt: segment.prompt,
      duration: segment.duration,
    }));

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({
      success: true,
      jobId: 'a3_legacy_video_job',
      importedSucceeded: 4,
      queuedFailed: 2,
    });
    expect(postA3DjangoJson).toHaveBeenCalledWith(
      '/api/resources/packs/pack-1/video-jobs/import-legacy/',
      'sessionid=test',
      {
        provider: 'seedance',
        resourceType: 'micro_video_script',
        duration: 60,
        aspectRatio: '9:16',
        resolution: '720p',
        segments: expectedSegments,
      },
    );
    expect(JSON.stringify(postA3DjangoJson.mock.calls[0]?.[2])).not.toContain('browser.invalid');
  });

  it.each([
    { resourcePackId: '', prompt: 'prompt' },
    { resourcePackId: 'pack-1', prompt: '' },
  ])('rejects legacy imports with missing resource pack or prompt', async ({ resourcePackId, prompt }) => {
    const { PATCH } = await import('@/app/api/a3/resources/openmaic-video/route');
    const response = await PATCH(new NextRequest('https://a3.zhuce.work/api/a3/resources/openmaic-video', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({ action: 'import-legacy-failures', resourcePackId, prompt }),
    }));

    expect(response.status).toBe(400);
    expect(postA3DjangoJson).not.toHaveBeenCalled();
  });

  it('surfaces an upstream legacy import error without reporting success', async () => {
    postA3DjangoJson.mockResolvedValue({ success: false, error: 'Legacy artifact is not eligible' });
    const { PATCH } = await import('@/app/api/a3/resources/openmaic-video/route');
    const response = await PATCH(new NextRequest('https://a3.zhuce.work/api/a3/resources/openmaic-video', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({
        action: 'import-legacy-failures',
        resourcePackId: 'pack-1',
        prompt: 'Explain deadlocks',
      }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({ success: false, error: 'Legacy artifact is not eligible' });
  });

  it('rejects unsupported PATCH actions', async () => {
    const { PATCH } = await import('@/app/api/a3/resources/openmaic-video/route');
    const response = await PATCH(new NextRequest('https://a3.zhuce.work/api/a3/resources/openmaic-video', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({ action: 'replace-all' }),
    }));

    expect(response.status).toBe(400);
    expect(postA3DjangoJson).not.toHaveBeenCalled();
  });

  it('polls the video job from the recommendations page before showing success', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('pollOpenMAICVideoJob');
    expect(source).toContain("'/api/a3/resources/openmaic-video'");
    expect(source).toContain("await pollOpenMAICVideoJob(result)");
    expect(source).toContain('normalizeOpenMAICVideoPollUrl');
    expect(source).toContain('job.progress');
    expect(source).toContain('job.stage');
    expect(source).toContain("a3GetJson<A3OpenMAICBridgeResponse>('/api/a3/resources/openmaic-video')");
    expect(source).toContain('视频仍在后台生成');
    expect(source).toContain('sessionStorage');
    expect(source).toContain('getOrCreateVideoJobId');
    expect(source).toContain('jobId: videoJobId');
  });

  it('shows provider segment failures without marking A3 writeback as failed', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('buildVideoArtifactProgress');
    expect(source).toContain("setError(`视频生成未成功：");
    expect(source).toContain("label === '写回 A3 资源包' ? 'succeeded'");
  });
});
