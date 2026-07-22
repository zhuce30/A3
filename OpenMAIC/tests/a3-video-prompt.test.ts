import { describe, expect, it } from 'vitest';

import { buildA3VideoPrompt, estimateA3VideoDuration } from '@/lib/a3/video-prompt';
import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';

function makeResource(overrides: Partial<A3ResourcePackV2Resource> = {}): A3ResourcePackV2Resource {
  return {
    type: 'micro_video_script',
    title: '死锁形成条件',
    content: {},
    citations: [],
    verified: true,
    personalizationReason: '针对当前薄弱点强化概念联系',
    estimatedMinutes: 8,
    ...overrides,
  };
}

describe('A3 video prompt construction', () => {
  it('includes the goal, narration, limited citations, and no-readable-text constraint', () => {
    const resource = makeResource({
      content: {
        shots: [
          {
            scene: '概念导入',
            visual: '白板标题与四栏表格',
            narration: '先理解互斥条件',
            durationSeconds: 12,
          },
        ],
      },
      citations: [
        { title: '来源一', location: '第一章', snippet: '证据一' },
        { title: '来源二', location: '第二章', snippet: '证据二' },
        { title: '来源三', location: '第三章', snippet: '证据三' },
        { title: '来源四', location: '第四章', snippet: '不应出现' },
      ],
    });

    const prompt = buildA3VideoPrompt('掌握死锁四个必要条件', resource);

    expect(prompt).toContain('主题：掌握死锁四个必要条件');
    expect(prompt).toContain('旁白/字幕 先理解互斥条件');
    expect(prompt).toContain('画面中禁止出现任何可读文字');
    expect(prompt).toContain('来源一：证据一');
    expect(prompt).toContain('来源三：证据三');
    expect(prompt).not.toContain('来源四');
    expect(prompt).not.toContain('白板标题');
    expect(prompt).toContain('无文字图形');
    expect(prompt).toContain('分组图标');
  });

  it('uses the existing fallback prompt and personalization when shots are absent', () => {
    const prompt = buildA3VideoPrompt('', makeResource({ title: '', personalizationReason: '' }));

    expect(prompt).toContain('主题：当前学习目标');
    expect(prompt).toContain('资源标题：教学视频');
    expect(prompt).toContain('个性化原因：根据画像、路径节点和知识库证据生成。');
    expect(prompt).toContain('证据不足时只表达摘要内容，不编造来源。');
    expect(prompt).toContain('画面中禁止出现任何可读文字');
  });

  it('keeps the video duration fixed at 60 seconds', () => {
    expect(estimateA3VideoDuration()).toBe(60);
  });
});
