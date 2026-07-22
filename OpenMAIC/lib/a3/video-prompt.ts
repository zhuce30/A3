import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';

export function buildA3VideoPrompt(goal: string, resource: A3ResourcePackV2Resource): string {
  const content = resource.content ?? {};
  const shots = Array.isArray(content.shots) ? content.shots.map((shot) => (typeof shot === 'object' && shot ? shot as Record<string, unknown> : {})) : [];
  const evidence = resource.citations
    .slice(0, 3)
    .map((citation, index) => `${index + 1}. ${sanitizeText(citation.title || citation.location, '本地知识库')}：${sanitizeText(citation.snippet, '')}`)
    .filter((item) => item.trim().length > 3);

  if (shots.length) {
    const shotPlan = shots.slice(0, 8).map((shot, index) => {
      const scene = sanitizeText(shot.scene, `镜头 ${index + 1}`);
      const visual = sanitizeVideoVisualText(shot.visual);
      const narration = sanitizeText(shot.narration, '用一句话解释当前步骤');
      const duration = Number(shot.durationSeconds || 0);
      return `${index + 1}. ${scene}${duration ? `，约 ${Math.min(Math.max(duration, 3), 10)} 秒` : ''}：无文字画面 ${visual}；旁白/字幕 ${narration}`;
    });
    return [
      `生成一个 ${estimateA3VideoDuration()} 秒、16:9、1080p 的中文课程讲解视频。系统会拆成多个 10 秒无文字动画片段连续播放。`,
      `主题：${sanitizeText(goal, '当前学习目标')}。标题：${sanitizeText(resource.title, '教学视频')}。`,
      '画风：干净的现代教育动画，使用人物动作、图标、颜色、流程箭头和抽象示意表达。画面中禁止出现任何可读文字、汉字、英文、公式、标题、板书、白板字、字幕或水印；中文内容只通过旁白/字幕层呈现。',
      '按下面分镜生成，镜头之间自然过渡：',
      ...shotPlan,
      evidence.length ? `知识库证据参考：${evidence.join('；')}` : '证据不足时只表达资源包已有内容，不编造教材页码。',
      '最终效果：学生看完能知道概念关系、步骤顺序和下一步练习动作。',
    ].join('\n');
  }

  return [
    `生成一个 ${estimateA3VideoDuration()} 秒、16:9、1080p 的中文课程讲解视频。系统会拆成多个 10 秒无文字动画片段连续播放。`,
    `主题：${sanitizeText(goal, '当前学习目标')}。资源标题：${sanitizeText(resource.title, '教学视频')}。`,
    `个性化原因：${sanitizeText(resource.personalizationReason, '根据画像、路径节点和知识库证据生成。')}`,
    '画面结构：人物困惑引入、核心概念的无文字图解、步骤或例题的动作演示、最后用图标提示练习动作。画面中禁止出现任何可读文字、汉字、英文、公式、标题、板书、白板字、字幕或水印；中文内容只通过旁白/字幕层呈现。',
    evidence.length ? `知识库证据参考：${evidence.join('；')}` : '证据不足时只表达摘要内容，不编造来源。',
  ].join('\n');
}

export function buildA3VideoStoryboard(goal: string, resource: A3ResourcePackV2Resource) {
  const content = resource.content ?? {};
  const shots = Array.isArray(content.shots)
    ? content.shots.map((shot) => (typeof shot === 'object' && shot ? shot as Record<string, unknown> : {}))
    : [];
  if (!shots.length) return [];
  return shots.slice(0, 6).map((shot, index) => ({
    index: index + 1,
    scene: sanitizeText(shot.scene, `镜头 ${index + 1}`),
    title: sanitizeText(shot.scene, `片段 ${index + 1}`),
    visual: sanitizeVideoVisualText(shot.visual),
    narration: sanitizeText(shot.narration, `围绕${sanitizeText(goal, '当前学习目标')}解释这一阶段。`).slice(0, 2_000),
    durationSeconds: Math.min(Math.max(Number(shot.durationSeconds || 10), 1), 10),
    sourceIds: Array.isArray(shot.sourceIds)
      ? shot.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === 'string').slice(0, 20)
      : [],
    prompt: [
      'Use only people, icons, colors, shapes, objects, and motion to explain the concept.',
      `Topic: ${sanitizeText(goal, 'the learning goal')}.`,
      `Visual direction: ${sanitizeVideoVisualText(shot.visual)}.`,
    ].join(' '),
  }));
}

export function estimateA3VideoDuration(): 60 {
  return 60;
}

function sanitizeVideoVisualText(value: unknown): string {
  const visual = sanitizeText(value, '用人物动作、图标、颜色和箭头表达，不出现文字');
  return visual
    .replace(/标题|字幕|屏幕文字|板书|白板|文字|小字|公式|英文|汉字/g, '无文字图形')
    .replace(/本地资料摘录|资料摘录|文案|题干/g, '资料图标')
    .replace(/四栏|列表|表格/g, '分组图标')
    .slice(0, 160);
}

function sanitizeText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text || hasMojibake(text)) return fallback;
  return text;
}

function hasMojibake(text: string): boolean {
  const markerCodePoints = [0xfffd, 0x951b, 0x7ee1, 0x93ba, 0x74a7, 0x938d, 0x9422, 0x7470, 0x93c1, 0x701b, 0x94d6, 0x95c5, 0x68f0, 0x9352, 0x935b, 0x942d, 0x95bf, 0x7f01, 0x93cc, 0x6fb6, 0x9369, 0x59e3, 0x52ec, 0x9301, 0x20ac];
  return [...text].some((char) => markerCodePoints.includes(char.codePointAt(0) ?? 0));
}
