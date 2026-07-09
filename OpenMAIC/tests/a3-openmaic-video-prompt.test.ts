import { describe, expect, it } from 'vitest';
import { buildSegmentedVideoRequests, hardenVideoPromptForProvider } from '@/app/api/a3/resources/openmaic-video/route';
import { buildA3OpenMAICVideoPayload } from '@/lib/a3/openmaic-classroom-bridge';

describe('A3 OpenMAIC video prompt safety', () => {
  it('adds provider-level constraints that prevent generated frame text', () => {
    const prompt = hardenVideoPromptForProvider('画面：白板上写出“什么是操作系统”；字幕显示定义。');

    expect(prompt).toContain('Do not render any readable text');
    expect(prompt).toContain('No Chinese characters');
    expect(prompt).toContain('whiteboard writing');
    expect(prompt).toContain('garbled text');
    expect(prompt).toContain('Spoken narration or the webpage subtitle layer will carry all text content');
  });

  it('keeps empty prompts empty so request validation still works', () => {
    expect(hardenVideoPromptForProvider('   ')).toBe('');
  });

  it('splits a one minute teaching video into six ten second provider requests', () => {
    const requests = buildSegmentedVideoRequests({
      prompt: '主题：操作系统死锁。按分镜解释必要条件、资源分配图和避免策略。',
      duration: 60,
      aspectRatio: '16:9',
      resolution: '1080p',
    });

    expect(requests).toHaveLength(6);
    expect(requests.every((request) => request.duration === 10)).toBe(true);
    expect(requests[0].prompt).toContain('第 1/6 段');
    expect(requests[5].prompt).toContain('第 6/6 段');
    expect(requests[0].prompt).toContain('导入');
    expect(requests[5].prompt).toContain('收束');
    expect(requests.every((request) => request.prompt.includes('Do not render any readable text'))).toBe(true);
  });

  it('preserves partial segmented video degradation evidence even when a playable segment exists', () => {
    const payload = buildA3OpenMAICVideoPayload({
      provider: 'seedance',
      status: 'partial',
      resourceType: 'micro_video_script',
      result: { url: 'https://example.com/segment-1.mp4', duration: 50, width: 1920, height: 1080 },
      segments: [
        { index: 1, title: '导入', status: 'succeeded', videoUrl: 'https://example.com/segment-1.mp4', duration: 10, width: 1920, height: 1080, degradedReason: '' },
        { index: 2, title: '概念', status: 'failed', videoUrl: '', duration: 10, width: 0, height: 0, degradedReason: 'provider timeout' },
      ],
      error: '1 分钟视频分段生成完成：1/2 段成功',
    }, 12000);

    expect(payload.status).toBe('partial');
    expect(payload.videoUrl).toBe('https://example.com/segment-1.mp4');
    expect(payload.segments).toHaveLength(2);
    expect(payload.degradedReason).toContain('1/2 段成功');
  });
});
