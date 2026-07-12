import { describe, expect, it } from 'vitest';

async function loadAssetPipeline() {
  return (await import('../scripts/a3-homepage-asset-pipeline.mjs')) as {
    validateTeacherEvidenceText: (input: {
      emptyStates: number;
      taskRows: number;
      text: string;
      weakPointRows: number;
    }) => { visibleTextCount: number };
  };
}

describe('A3 homepage teacher evidence capture', () => {
  it('rejects heading-only teacher cards', async () => {
    const { validateTeacherEvidenceText } = await loadAssetPipeline();

    expect(() =>
      validateTeacherEvidenceText({
        emptyStates: 0,
        taskRows: 0,
        text: '班级薄弱知识点\n课堂任务队列',
        weakPointRows: 0,
      }),
    ).toThrow(/具体条目|明确空状态/);
  });

  it('accepts concrete weak-point and task evidence from the real DOM', async () => {
    const { validateTeacherEvidenceText } = await loadAssetPipeline();

    expect(
      validateTeacherEvidenceText({
        emptyStates: 0,
        taskRows: 1,
        text: '班级薄弱知识点\n处理机调度算法\n处理机调度与死锁\n课堂任务队列\n生成专项练习\n执行',
        weakPointRows: 1,
      }),
    ).toEqual({ visibleTextCount: 6 });
  });
});
