import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';

export type PracticeQuestion = {
  id: string;
  type: string;
  knowledgePoint: string;
  difficulty: string;
  stem: string;
  options: string[];
  answer: string;
  explanation: string;
  distractorAnalysis: string[];
  commonMistake: string;
  evaluationRubric: string[];
  sourceIds: string[];
};

export type NormalizedCaseStudy = {
  scenario: string;
  role: string;
  constraints: string[];
  background: string;
  task: string;
  studentPrompt: string;
  materials: Array<{ title: string; snippet: string; sourceId: string }>;
  decisionPoints: string[];
  analysisSteps: string[];
  expertAnalysis: string;
  rubric: string[];
  reflection: string;
  sourceIds: string[];
};

export type NormalizedCodeLab = {
  language: string;
  objective: string;
  environment: string;
  concepts: string[];
  starterCode: string;
  steps: string[];
  expectedOutput: string;
  testCases: Array<{ name: string; stdin: string; expectedStdout: string }>;
  hints: string[];
  commonFailures: string[];
  checkpoints: string[];
  extension: string;
  sourceIds: string[];
};

export function normalizePracticeQuestions(resource: A3ResourcePackV2Resource): PracticeQuestion[] {
  return workbenchRecords(resource.content.questions).map((question, index) => ({
    id: safeWorkbenchText(question.id, `q${index + 1}`),
    type: safeWorkbenchText(question.type, 'analysis'),
    knowledgePoint: safeWorkbenchText(question.knowledgePoint, resource.title),
    difficulty: safeWorkbenchText(question.difficulty, '中等'),
    stem: safeWorkbenchText(question.stem, `题目 ${index + 1}`),
    options: workbenchTextArray(question.options),
    answer: safeWorkbenchText(question.answer, '请根据资料证据完成作答。'),
    explanation: safeWorkbenchText(question.explanation, '请核对适用条件、推理过程和资料证据。'),
    distractorAnalysis: workbenchTextArray(question.distractorAnalysis),
    commonMistake: safeWorkbenchText(question.commonMistake, '只写结论，没有检查题目条件。'),
    evaluationRubric: workbenchTextArray(question.evaluationRubric).length
      ? workbenchTextArray(question.evaluationRubric)
      : ['结论明确', '说明判断条件', '引用资料证据'],
    sourceIds: workbenchTextArray(question.sourceIds),
  }));
}

export function normalizeCaseStudy(resource: A3ResourcePackV2Resource): NormalizedCaseStudy {
  const content = resource.content;
  const analysisSteps = workbenchTextArray(content.analysisSteps).length
    ? workbenchTextArray(content.analysisSteps)
    : workbenchTextArray(content.steps);
  return {
    scenario: safeWorkbenchText(content.scenario, resource.title),
    role: safeWorkbenchText(content.role, '课程问题分析者'),
    constraints: workbenchTextArray(content.constraints),
    background: safeWorkbenchText(content.background, '请结合给定材料理解案例背景。'),
    task: safeWorkbenchText(content.task, '根据材料完成判断并说明依据。'),
    studentPrompt: safeWorkbenchText(content.studentPrompt, safeWorkbenchText(content.task, '写下你的判断和依据。')),
    materials: workbenchRecords(content.materials).map((material, index) => ({
      title: safeWorkbenchText(material.title, `材料 ${index + 1}`),
      snippet: safeWorkbenchText(material.snippet, '暂无材料摘要。'),
      sourceId: safeWorkbenchText(material.sourceId, `S${index + 1}`),
    })),
    decisionPoints: workbenchTextArray(content.decisionPoints),
    analysisSteps,
    expertAnalysis: safeWorkbenchText(content.expertAnalysis, safeWorkbenchText(content.analysis, '暂无专家分析。')),
    rubric: workbenchTextArray(content.rubric),
    reflection: safeWorkbenchText(content.reflection, '完成后记录一个仍需复习的条件。'),
    sourceIds: workbenchTextArray(content.sourceIds),
  };
}

export function normalizeCodeLab(resource: A3ResourcePackV2Resource): NormalizedCodeLab {
  const content = resource.content;
  return {
    language: safeWorkbenchText(content.language, 'Python'),
    objective: safeWorkbenchText(content.objective, resource.title),
    environment: safeWorkbenchText(content.environment, 'Python 3.10+，仅使用标准库。'),
    concepts: workbenchTextArray(content.concepts),
    starterCode: safeWorkbenchText(content.starterCode, "print('ready')"),
    steps: workbenchTextArray(content.steps),
    expectedOutput: safeWorkbenchText(content.expectedOutput, '运行后检查输出是否符合实验目标。'),
    testCases: workbenchRecords(content.testCases)
      .map((item, index) => ({
        name: safeWorkbenchText(item.name, `用例 ${index + 1}`),
        stdin: safeWorkbenchText(item.stdin ?? item.input, ''),
        expectedStdout: safeWorkbenchText(item.expectedStdout ?? item.expectedOutput ?? item.output, ''),
      }))
      .filter((item) => item.expectedStdout),
    hints: workbenchTextArray(content.hints),
    commonFailures: workbenchTextArray(content.commonFailures),
    checkpoints: workbenchTextArray(content.checkpoints),
    extension: safeWorkbenchText(content.extension, '修改一个参数，比较输出变化并解释原因。'),
    sourceIds: workbenchTextArray(content.sourceIds),
  };
}

export function workbenchRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
}

export function workbenchTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeWorkbenchText(item, '')).filter(Boolean);
}

export function safeWorkbenchText(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  return text || fallback;
}
