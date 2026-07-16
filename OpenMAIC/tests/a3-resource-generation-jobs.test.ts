import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/resources/jobs/route.ts');
const recommendationsPath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');
const djangoApiPath = path.resolve(process.cwd(), 'lib/server/a3-django-api.ts');

describe('A3 generic resource generation jobs', () => {
  it('exposes a Next job/status endpoint for non-video resource generation', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain('export async function POST');
    expect(source).toContain('export async function GET');
    expect(source).not.toContain('runResourceGenerationJob');
    expect(source).toContain('persistResourceGenerationJob');
    expect(source).toContain("'/api/resources/jobs/'");
    expect(source).toContain("workflow: 'resource_generate'");
    expect(source).not.toContain('void runResourceGenerationJob');
    expect(source).toContain('pollUrl');
    expect(source).toContain('pollIntervalMs');
    expect(source).toContain('progress');
    expect(source).not.toContain('const resourceGenerationJobs = new Map');
  });

  it('routes full-pack and single-resource generation through job polling in recommendations', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('pollResourceGenerationJob');
    expect(source).toContain("'/api/a3/resources/jobs'");
    expect(source).toContain('await pollResourceGenerationJob(result)');
    expect(source).toContain('normalizeResourceGenerationPollUrl');
    expect(source).toContain("buildProgress('resource'");
    expect(source).not.toContain("a3PostJson<A3ResourceGenerateResponse>('/api/resources/generate/'");
  });

  it('keeps lecture document generation loading separate from classroom ppt generation', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('!isPpt && !isVideo && entry.resourceType && singleGeneratingType === entry.resourceType');
    expect(source).toContain("entry.key !== 'ppt' && entry.key !== 'video' && singleGeneratingType === entry.resourceType");
    expect(source).toContain("entry.key === 'ppt' && generatingClassroom");
  });

  it('refreshes csrf before server-side Django POST retry', () => {
    const source = fs.readFileSync(djangoApiPath, 'utf8');

    expect(source).toContain('resolveCsrfForServerPost');
    expect(source).toContain("'/api/auth/csrf/'");
    expect(source).toContain('response.status === 403');
    expect(source).toContain('upsertCookie');
  });
});
