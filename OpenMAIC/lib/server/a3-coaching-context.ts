import type { ClassroomContext } from '@/lib/a3/classroom-types';

type CoachingContext = Pick<ClassroomContext, 'target' | 'sources'>;

export const A3_COACHING_SYSTEM_PROMPT = `你是“智学引擎”的自动控制原理面对面 AI 助教，请使用简体中文回答。
要求：
1. 围绕当前学习目标讲解，先给结论，再解释条件，最后给一个可练习动作。
2. 如果提供了知识库来源，只能基于来源回答，不要编造教材、页码或出处。
3. 回答控制在 180 字以内，使用“概念、例子、下一步”三段式。
4. 信息不足时要明确说缺少什么，并给出合规的学习替代路径。
5. 公式格式必须稳定：中文解释、标题、结论、表格文字不能包在 $$ 中；短公式用 $...$，独立公式块只在整块完全是公式时使用 $$...$$。
6. 涉及考查点、对比维度、评分标准或步骤清单时，使用标准 Markdown 表格，例如 | 列名 | 列名 | 后接 | --- | --- |，每一行单独换行，不要把竖线表格写成普通段落。`;

export function buildA3CoachingContextPrompt(context?: CoachingContext | null) {
  if (!context) return '';
  const target = context.target;
  const targetText = target?.title
    ? `当前学习目标：${target.title}。章节：第 ${target.chapter?.order ?? '?'} 章 ${target.chapter?.title ?? ''}。进度：${target.progress ?? 0}%。未掌握错题数：${target.wrongCount ?? 0}。说明：${target.description ?? '暂无'}。`
    : '';
  const sources = (context.sources ?? []).slice(0, 3).map((source, index) => {
    return `[${index + 1}] ${source.title ?? '知识库片段'}，位置：${source.location ?? '未知'}，内容：${source.snippet ?? ''}`;
  }).join('\n');
  return [targetText, sources ? `知识库来源：\n${sources}` : ''].filter(Boolean).join('\n');
}

export function buildA3CoachingFallbackReply(message: string, context?: CoachingContext | null) {
  const target = context?.target;
  const sources = (context?.sources ?? []).filter((source) => source.snippet).slice(0, 2);
  const lead = target?.title ? `围绕当前目标“${target.title}”，` : '';
  const conciseQuestion = message.length > 36 ? `${message.slice(0, 36)}...` : message;
  const evidence = sources.map((source, index) => `[${index + 1}] ${source.snippet}`).join('；');
  const sourceTitle = sources[0]?.title ? `主要依据：${sources[0].title}。` : '';

  if (evidence) {
    return `${lead}你的问题是“${conciseQuestion}”。概念上先抓定义、适用条件和典型题型三步：${evidence} ${sourceTitle}下一步建议你追问一道例题，我会带你拆解。`;
  }
  return `${lead}你的问题是“${conciseQuestion}”。当前知识库证据不足，我只能给学习建议：先补齐概念定义、适用条件和一个例题，再进入练习。请上传或索引课程资料后再要求引用验证。`;
}

export function buildA3VisionFallbackReply(message: string, context?: CoachingContext | null) {
  const target = context?.target;
  const sources = (context?.sources ?? []).filter((source) => source.snippet).slice(0, 2);
  const targetText = target?.title ? `当前主题是“${target.title}”。` : '当前还没有明确学习主题。';
  const evidence = sources.map((source, index) => `[${index + 1}] ${source.snippet}`).join('；');
  const prompt = message.length > 42 ? `${message.slice(0, 42)}...` : message;
  if (evidence) {
    return `视觉模型暂未配置，我无法识别摄像头画面。${targetText}可先按课堂资料继续：${evidence} 下一步请把画面中的公式或题干手动输入，我会继续带你拆解。`;
  }
  return `视觉模型暂未配置，我无法识别摄像头画面。你的请求是“${prompt}”。建议先输入题干、公式或截图中的关键词；系统会结合当前学习路径和知识库继续辅导。`;
}
