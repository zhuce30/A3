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

  it('polls the video job from the recommendations page before showing success', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('pollOpenMAICVideoJob');
    expect(source).toContain("'/api/a3/resources/openmaic-video'");
    expect(source).toContain("await pollOpenMAICVideoJob(result)");
    expect(source).toContain('normalizeOpenMAICVideoPollUrl');
    expect(source).toContain('job.progress');
    expect(source).toContain('job.stage');
  });
});
