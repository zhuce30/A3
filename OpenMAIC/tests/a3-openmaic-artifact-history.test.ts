import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterOpenMAICArtifactHistory,
  sortOpenMAICArtifactHistory,
  summarizeOpenMAICArtifactHistory,
  teacherArtifactCountsToSummary,
} from '@/lib/a3/openmaic-artifact-history';

describe('A3 OpenMAIC artifact history', () => {
  it('sorts artifacts by latest writeback time and keeps full history', () => {
    const artifacts = sortOpenMAICArtifactHistory([
      {
        type: 'openmaic_video',
        status: 'failed',
        provider: 'seedance',
        createdAt: '2026-06-27T08:00:00Z',
        degradedReason: 'No API key configured',
      },
      {
        type: 'openmaic_classroom',
        status: 'succeeded',
        provider: 'openmaic-generate-classroom',
        createdAt: '2026-06-27T09:00:00Z',
      },
      {
        type: 'openmaic_classroom',
        status: 'queued',
        provider: 'openmaic-generate-classroom',
        createdAt: '2026-06-27T07:00:00Z',
      },
    ]);

    expect(artifacts).toHaveLength(3);
    expect(artifacts[0].type).toBe('openmaic_classroom');
    expect(artifacts[0].status).toBe('succeeded');
    expect(artifacts[2].status).toBe('queued');
  });

  it('summarizes classroom/video/pptx success and degradation for detail pages', () => {
    const summary = summarizeOpenMAICArtifactHistory([
      { type: 'openmaic_classroom', status: 'succeeded', createdAt: '2026-06-27T09:00:00Z' },
      { type: 'openmaic_video', status: 'succeeded', createdAt: '2026-06-27T09:01:00Z' },
      { type: 'openmaic_video', status: 'failed', degradedReason: 'provider not configured', createdAt: '2026-06-27T09:02:00Z' },
      { type: 'openmaic_pptx_export', status: 'succeeded', createdAt: '2026-06-27T09:03:00Z' },
    ]);

    expect(summary).toMatchObject({
      total: 4,
      classroom: 1,
      classroomSucceeded: 1,
      video: 2,
      videoSucceeded: 1,
      pptxExport: 1,
      pptxExportSucceeded: 1,
      degraded: 1,
      latestAt: '2026-06-27T09:03:00Z',
    });
  });

  it('filters resource-pack artifact history by type and degraded status', () => {
    const artifacts = [
      { type: 'openmaic_classroom', status: 'succeeded', createdAt: '2026-06-27T09:00:00Z' },
      { type: 'openmaic_video', status: 'succeeded', createdAt: '2026-06-27T09:01:00Z' },
      { type: 'openmaic_video', status: 'failed', degradedReason: 'provider not configured', createdAt: '2026-06-27T09:02:00Z' },
      { type: 'openmaic_classroom', status: 'queued', createdAt: '2026-06-27T09:03:00Z' },
      { type: 'openmaic_pptx_export', status: 'succeeded', createdAt: '2026-06-27T09:04:00Z' },
    ];

    expect(filterOpenMAICArtifactHistory(artifacts, 'all')).toHaveLength(5);
    expect(filterOpenMAICArtifactHistory(artifacts, 'classroom').map((item) => item.type)).toEqual([
      'openmaic_classroom',
      'openmaic_classroom',
    ]);
    expect(filterOpenMAICArtifactHistory(artifacts, 'video').map((item) => item.type)).toEqual([
      'openmaic_video',
      'openmaic_video',
    ]);
    expect(filterOpenMAICArtifactHistory(artifacts, 'pptx').map((item) => item.type)).toEqual([
      'openmaic_pptx_export',
    ]);
    expect(filterOpenMAICArtifactHistory(artifacts, 'degraded').map((item) => item.status)).toEqual([
      'failed',
      'queued',
    ]);
  });

  it('uses teacher backend aggregate counts while preserving latest artifact timestamp', () => {
    const summary = teacherArtifactCountsToSummary(
      {
        classroom: 2,
        classroomSucceeded: 1,
        video: 3,
        videoSucceeded: 2,
        videoDegraded: 1,
        pptxExport: 1,
        pptxExportSucceeded: 1,
      },
      [
        { type: 'openmaic_video', status: 'failed', completedAt: '2026-06-27T10:00:00Z' },
        { type: 'openmaic_pptx_export', status: 'succeeded', completedAt: '2026-06-27T11:00:00Z' },
        { type: 'openmaic_classroom', status: 'succeeded', completedAt: '2026-06-27T09:00:00Z' },
      ],
    );

    expect(summary.total).toBe(6);
    expect(summary.degraded).toBe(2);
    expect(summary.pptxExportSucceeded).toBe(1);
    expect(summary.latestAt).toBe('2026-06-27T11:00:00Z');
  });

  it('guards teacher artifact cards against duplicate React keys for repeated videos in one pack', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/teacher-workbench-view.tsx'),
      'utf8',
    );

    expect(source).toContain('buildTeacherArtifactCardKey');
    expect(source).not.toContain('key={`${artifact.type}-${artifact.jobId || artifact.resourcePackId || index}`}');
    expect(source).toContain('artifact.videoUrl');
    expect(source).toContain('artifact.completedAt');
    expect(source).toContain('artifact.createdAt');
  });
});
