import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const smokeScriptPath = path.resolve(process.cwd(), 'scripts', 'a3-real-video-smoke.mjs');

describe('A3 real video smoke script', () => {
  it('redacts signed video urls from console summaries', async () => {
    const script = await import('../scripts/a3-real-video-smoke.mjs') as {
      sanitizeReportForConsole: (report: Record<string, unknown>) => Record<string, unknown>;
    };

    const summary = script.sanitizeReportForConsole({
      schemaVersion: 'a3.openmaic-video-smoke-report.v1',
      status: 'succeeded',
      success: true,
      provider: 'happyhorse',
      videoUrl: 'https://example.com/signed-video.mp4?Expires=999&Signature=secret',
      duration: 5,
    });

    expect(summary).not.toHaveProperty('videoUrl');
    expect(JSON.stringify(summary)).not.toContain('Signature=secret');
    expect(summary).toMatchObject({
      status: 'succeeded',
      success: true,
      provider: 'happyhorse',
      hasVideoUrl: true,
    });
  });

  it('writes a skipped smoke report when the real provider smoke gate is disabled', () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-video-smoke-'));
    const reportPath = path.resolve(tempCwd, 'tmp', 'a3-openmaic-smoke-report.json');
    fs.rmSync(reportPath, { force: true });
    const output = execFileSync('node', [smokeScriptPath], {
      cwd: tempCwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        A3_RUN_REAL_VIDEO_SMOKE: '',
        A3_VIDEO_SMOKE_API_KEY: '',
        VIDEO_SEEDANCE_API_KEY: '',
      },
    });

    expect(output).toContain('SKIP');
    expect(output).toContain('tmp/a3-openmaic-smoke-report.json');
    expect(output).not.toContain(process.cwd());
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      schemaVersion: string;
      status: string;
      success: boolean;
      provider: string;
      reason: string;
      reportPath: string;
    };
    expect(report.schemaVersion).toBe('a3.openmaic-video-smoke-report.v1');
    expect(report.status).toBe('skipped');
    expect(report.success).toBe(false);
    expect(report.provider).toBe('seedance');
    expect(report.reason).toContain('A3_RUN_REAL_VIDEO_SMOKE=1');
    expect(report.reportPath).toBe('tmp/a3-openmaic-smoke-report.json');
  });
});
