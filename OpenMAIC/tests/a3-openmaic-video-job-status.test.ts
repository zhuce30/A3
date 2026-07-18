import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/resources/openmaic-video/route.ts');
const recommendationsPath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');

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
    expect(source).toContain("fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/'");
    expect(source).toContain("apiError('UNAUTHORIZED', 401");
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
