import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
