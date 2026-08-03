export type SegmentedVideoRequest = {
  prompt: string;
  visual: string;
  narration: string;
  sourceIds: string[];
  duration: number;
  aspectRatio: string;
  resolution: string;
  title: string;
};

export function buildSegmentedVideoRequests(input: {
  prompt: string;
  visual?: string;
  narration?: string;
  sourceIds?: string[];
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
}): SegmentedVideoRequest[] {
  const requestedDuration = Number(input.duration || 0);
  if (requestedDuration < 60) return [];
  const stages = [
    '导入：用一个学习困惑或真实场景引出主题',
    '概念：解释核心定义和判断条件',
    '机制：展示关键过程、结构或因果关系',
    '例子：用一个小案例演示推理步骤',
    '误区：突出常见错误和纠正方式',
    '收束：总结要点并提示下一步练习',
  ];
  return stages.map((stage, index) => ({
    prompt: hardenVideoPromptForProvider([
      `第 ${index + 1}/${stages.length} 段，10 秒。`,
      `教学阶段：${stage}。`,
      '这是 1 分钟课程视频的一个连续片段，保持同一画风、角色、色彩和节奏。',
      input.prompt,
    ].join('\n')),
    visual: input.visual || '用人物动作、图标、颜色和箭头表现教学阶段，不出现文字。',
    narration: `${stage}。${input.narration || input.prompt}`.slice(0, 2_000),
    sourceIds: input.sourceIds || [],
    duration: 10,
    aspectRatio: input.aspectRatio || '16:9',
    resolution: input.resolution || '1080p',
    title: stage.split('：')[0],
  }));
}

export function hardenVideoPromptForProvider(prompt: string) {
  const normalized = String(prompt || '').trim();
  if (!normalized) return '';
  return [
    'IMPORTANT VISUAL CONSTRAINT: Do not render any readable text in the video frames. No Chinese characters, English words, formulas, subtitles, captions, whiteboard writing, blackboard writing, labels, UI text, logos, or watermarks inside the generated image. Use only people, icons, arrows, colors, shapes, objects, and motion to explain concepts. Spoken narration or the webpage subtitle layer will carry all text content.',
    normalized,
    'Negative prompt: garbled text, fake letters, pseudo words, unreadable writing, misspelled text, whiteboard text, blackboard text, subtitles, captions, title cards, labels, formulas, watermarks, logos.',
  ].join('\n\n');
}
