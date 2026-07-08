import { describe, expect, it } from 'vitest';
import {
  buildA3OpenMAICClassroomRequirement,
  buildA3OpenMAICArtifactPayload,
  buildA3OpenMAICInteractionPayload,
  buildA3OpenMAICPPTXExportPayload,
  buildA3OpenMAICVideoPayload,
  buildOpenMAICClassroomUrlWithA3Context,
  getA3OpenMAICContextFromUrl,
  writeBackA3OpenMAICInteraction,
} from '@/lib/a3/openmaic-classroom-bridge';

describe('A3 OpenMAIC classroom bridge', () => {
  it('builds a personalized classroom requirement from A3 resource pack context', () => {
    const requirement = buildA3OpenMAICClassroomRequirement({
      goal: '根轨迹分析',
      learnerProfileSnapshot: {
        grade: '大二',
        majorDirection: '自动化',
        foundationLevel: '基础一般',
        weakPoints: ['根轨迹', '频率响应'],
        resourcePreferences: ['动画演示', '例题推导'],
      },
      citations: [
        {
          title: '根轨迹讲义',
          snippet: '根轨迹描述闭环极点随参数变化的轨迹。',
        },
      ],
    });

    expect(requirement).toContain('A3 个性化学习课堂');
    expect(requirement).toContain('根轨迹分析');
    expect(requirement).toContain('大二');
    expect(requirement).toContain('根轨迹、频率响应');
    expect(requirement).toContain('根轨迹讲义');
    expect(requirement).toContain('生成可导出 PPTX 的互动课堂');
  });

  it('normalizes succeeded classroom job into Django artifact payload', () => {
    const payload = buildA3OpenMAICArtifactPayload({
      jobId: 'job-001',
      status: 'succeeded',
      result: {
        classroomId: 'classroom-001',
        url: '/classroom/classroom-001',
        scenesCount: 5,
      },
    }, 1234);

    expect(payload).toEqual({
      jobId: 'job-001',
      status: 'succeeded',
      classroomId: 'classroom-001',
      classroomUrl: '/classroom/classroom-001',
      scenesCount: 5,
      pptxExportable: true,
      provider: 'openmaic-generate-classroom',
      elapsedMs: 1234,
      degradedReason: '',
    });
  });

  it('normalizes classroom artifact urls with resource-pack writeback context when requested', () => {
    const payload = buildA3OpenMAICArtifactPayload({
      jobId: 'job-001',
      status: 'succeeded',
      result: {
        classroomId: 'classroom-001',
        url: '/classroom/classroom-001',
        scenesCount: 5,
      },
    }, 1234, { resourcePackId: 'pack-001' });

    expect(payload.classroomUrl).toBe('/classroom/classroom-001?a3PackId=pack-001&a3ClassroomJobId=job-001&a3ClassroomId=classroom-001');
  });

  it('adds A3 resource-pack context to OpenMAIC classroom urls', () => {
    const url = buildOpenMAICClassroomUrlWithA3Context('/classroom/classroom-001?view=student', {
      resourcePackId: 'pack-001',
      classroomJobId: 'job-classroom-001',
      classroomId: 'classroom-001',
    });

    expect(url).toBe('/classroom/classroom-001?view=student&a3PackId=pack-001&a3ClassroomJobId=job-classroom-001&a3ClassroomId=classroom-001');
  });

  it('extracts A3 classroom writeback context from a classroom url', () => {
    const context = getA3OpenMAICContextFromUrl('http://localhost:3002/classroom/classroom-001?a3PackId=pack-001&a3ClassroomJobId=job-classroom-001');

    expect(context).toEqual({
      resourcePackId: 'pack-001',
      classroomJobId: 'job-classroom-001',
      classroomId: 'classroom-001',
      classroomUrl: '/classroom/classroom-001?a3PackId=pack-001&a3ClassroomJobId=job-classroom-001',
    });
  });

  it('builds a PPTX export artifact payload from the A3 classroom context', () => {
    const payload = buildA3OpenMAICPPTXExportPayload({
      context: {
        resourcePackId: 'pack-001',
        classroomJobId: 'job-classroom-001',
        classroomId: 'classroom-001',
        classroomUrl: '/classroom/classroom-001?a3PackId=pack-001',
      },
      fileName: 'root-locus.pptx',
      slidesCount: 6,
      elapsedMs: 320,
      exportedAtMs: 4102444800000,
    });

    expect(payload).toEqual({
      resourcePackId: 'pack-001',
      jobId: 'pptx-job-classroom-001-4102444800000',
      status: 'succeeded',
      classroomId: 'classroom-001',
      classroomUrl: '/classroom/classroom-001?a3PackId=pack-001',
      fileName: 'root-locus.pptx',
      slidesCount: 6,
      provider: 'openmaic-pptx-export',
      elapsedMs: 320,
      degradedReason: '',
    });
  });

  it('builds a classroom interaction writeback payload from the A3 classroom context', () => {
    const payload = buildA3OpenMAICInteractionPayload({
      context: {
        resourcePackId: 'pack-001',
        classroomJobId: 'job-classroom-001',
        classroomId: 'classroom-001',
        classroomUrl: '/classroom/classroom-001?a3PackId=pack-001',
      },
      eventType: 'action_completed',
      sceneId: 'scene-003',
      sceneTitle: 'Root locus walkthrough',
      actionType: 'play_video',
      actionId: 'video-demo-1',
      progress: 0.6,
      elapsedMs: 2400,
    });

    expect(payload).toEqual({
      resourcePackId: 'pack-001',
      eventType: 'action_completed',
      classroomId: 'classroom-001',
      classroomJobId: 'job-classroom-001',
      classroomUrl: '/classroom/classroom-001?a3PackId=pack-001',
      sceneId: 'scene-003',
      sceneTitle: 'Root locus walkthrough',
      actionType: 'play_video',
      actionId: 'video-demo-1',
      progress: 0.6,
      elapsedMs: 2400,
    });
  });

  it('posts classroom interaction only when A3 context exists in the url', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const posted = await writeBackA3OpenMAICInteraction({
      urlValue: 'http://localhost:3002/classroom/classroom-001?a3PackId=pack-001&a3ClassroomJobId=job-classroom-001',
      eventType: 'action_completed',
      actionType: 'speech',
      actionId: 'speech-1',
      progress: 0.25,
      elapsedMs: 500,
      fetcher,
    });
    const skipped = await writeBackA3OpenMAICInteraction({
      urlValue: 'http://localhost:3002/classroom/classroom-001',
      eventType: 'action_completed',
      actionType: 'speech',
      fetcher,
    });

    expect(posted).toBe(true);
    expect(skipped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/a3/resources/openmaic-interaction');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      resourcePackId: 'pack-001',
      classroomId: 'classroom-001',
      classroomJobId: 'job-classroom-001',
      eventType: 'action_completed',
      actionType: 'speech',
      actionId: 'speech-1',
      progress: 0.25,
    });
  });

  it('marks failed jobs as non-exportable with a degradation reason', () => {
    const payload = buildA3OpenMAICArtifactPayload({
      jobId: 'job-002',
      status: 'failed',
      error: 'No API key configured',
    }, 20);

    expect(payload.status).toBe('failed');
    expect(payload.pptxExportable).toBe(false);
    expect(payload.degradedReason).toContain('No API key configured');
  });

  it('normalizes generated video results into a resource pack artifact', () => {
    const payload = buildA3OpenMAICVideoPayload({
      provider: 'seedance',
      status: 'succeeded',
      resourceType: 'micro_video_script',
      result: {
        url: 'https://cdn.example.com/video.mp4',
        duration: 5,
        width: 1280,
        height: 720,
      },
    }, 2400);

    expect(payload).toMatchObject({
      type: 'openmaic_video',
      status: 'succeeded',
      provider: 'seedance',
      resourceType: 'micro_video_script',
      videoUrl: 'https://cdn.example.com/video.mp4',
      duration: 5,
      width: 1280,
      height: 720,
      degradedReason: '',
    });
  });

  it('marks missing video provider key as an explicit degraded artifact', () => {
    const payload = buildA3OpenMAICVideoPayload({
      provider: 'seedance',
      status: 'failed',
      resourceType: 'micro_video_script',
      error: 'No API key configured for video provider: seedance',
    }, 10);

    expect(payload.status).toBe('failed');
    expect(payload.videoUrl).toBe('');
    expect(payload.degradedReason).toContain('No API key configured');
  });
});
