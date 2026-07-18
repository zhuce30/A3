import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/resources/openmaic-video/route.ts');
const recommendationsPath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');

describe('A3 OpenMAIC video job polling contract', () => {
  it('creates video jobs immediately and exposes a GET status endpoint', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain('const videoJobs');
    expect(source).toContain('export async function GET');
    expect(source).toContain('runOpenMAICVideoJob');
    expect(source).toContain("status: 'queued'");
    expect(source).toContain("status: 'running'");
    expect(source).toContain('pollUrl');
    expect(source).toContain('pollIntervalMs');
    expect(source).toContain('progress');
    expect(source).toContain('stage');
    expect(source).toContain('apiSuccess({');
    expect(source).toContain('}, 202)');
  });

  it('calls the video provider through the configured internal frontend endpoint', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain('resolveA3InternalFrontendEndpoint');
    expect(source).toContain("resolveA3InternalFrontendEndpoint('/api/generate/video', input.origin)");
    expect(source).not.toContain("new URL('/api/generate/video', input.origin)");
  });

  it('polls the video job from the recommendations page before showing success', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('pollOpenMAICVideoJob');
    expect(source).toContain("'/api/a3/resources/openmaic-video'");
    expect(source).toContain("await pollOpenMAICVideoJob(result)");
    expect(source).toContain('normalizeOpenMAICVideoPollUrl');
    expect(source).toContain('job.progress');
    expect(source).toContain('job.stage');
  });

  it('shows provider segment failures without marking A3 writeback as failed', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('buildVideoArtifactProgress');
    expect(source).toContain("setError(`视频生成未成功：");
    expect(source).toContain("label === '写回 A3 资源包' ? 'succeeded'");
  });
});
