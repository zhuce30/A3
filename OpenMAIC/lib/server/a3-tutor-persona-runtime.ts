import type { A3TutorPersona, A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';

export type A3TutorPersonaRuntime = {
  persona: A3TutorPersona;
  openaiVoice: string;
  dashscopeVoice: string;
  fallbackUsed: boolean;
  instructions: (targetTitle: string) => string;
};

type RuntimePolicy = Omit<A3TutorPersonaRuntime, 'fallbackUsed' | 'instructions'> & {
  strategyInstruction: string;
};

const SCHEMA_VERSION = 'a3.tutor-persona.v1';

const RUNTIME_POLICIES: Record<A3TutorPersonaId, RuntimePolicy> = {
  'structured-teacher': {
    persona: persona('structured-teacher', '结构讲解', '先搭框架，再分步骤讲清概念', 'structured', 'voice-clear-guide'),
    openaiVoice: 'alloy',
    dashscopeVoice: 'Cherry',
    strategyInstruction: '先确认学习目标，再按框架分步骤讲解；每一步都说明与当前目标的关系。',
  },
  'socratic-guide': {
    persona: persona('socratic-guide', '启发追问', '通过关键问题，引导你自己找到答案', 'socratic', 'voice-curious-guide'),
    openaiVoice: 'sage',
    dashscopeVoice: 'Serena',
    strategyInstruction: '一次只提出一个关键问题，先了解学习者当前理解，再逐步提示，不直接代替学习者完成答案。',
  },
  'practice-coach': {
    persona: persona('practice-coach', '例题实战', '用例题、步骤和即时反馈巩固薄弱点', 'practice', 'voice-energetic-coach'),
    openaiVoice: 'coral',
    dashscopeVoice: 'Ethan',
    strategyInstruction: '围绕当前薄弱点安排一题一练，先让学习者作答，再反馈正误、错因和下一步。',
  },
  'foundation-coach': {
    persona: persona('foundation-coach', '基础补强', '从先修概念开始，用短句和小步讲解', 'foundation', 'voice-patient-coach'),
    openaiVoice: 'shimmer',
    dashscopeVoice: 'Chelsie',
    strategyInstruction: '从已确认的先修概念开始，使用短句和小步讲解，每一步都检查是否理解。',
  },
};

export function resolveA3TutorPersonaRuntime(personaId: string | null | undefined): A3TutorPersonaRuntime {
  const normalized = String(personaId || '').trim() as A3TutorPersonaId;
  const policy = RUNTIME_POLICIES[normalized] || RUNTIME_POLICIES['structured-teacher'];
  const fallbackUsed = !RUNTIME_POLICIES[normalized];
  return {
    persona: clonePersona(policy.persona),
    openaiVoice: policy.openaiVoice,
    dashscopeVoice: policy.dashscopeVoice,
    fallbackUsed,
    instructions: (targetTitle: string) => buildInstructions(targetTitle, policy.strategyInstruction),
  };
}

export function toPublicTutorPersona(runtime: A3TutorPersonaRuntime): A3TutorPersona {
  return clonePersona(runtime.persona);
}

function persona(
  id: A3TutorPersonaId,
  name: string,
  shortDescription: string,
  teachingStyle: string,
  voiceProfileId: string,
): A3TutorPersona {
  return {
    id,
    name,
    shortDescription,
    teachingStyle,
    avatarAssetId: 'teacher-default-v1',
    avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
    voiceProfileId,
    voicePreviewEnabled: true,
    allowedWorkflows: ['coaching', 'classroom'],
    schemaVersion: SCHEMA_VERSION,
  };
}

function clonePersona(value: A3TutorPersona): A3TutorPersona {
  return { ...value, allowedWorkflows: [...value.allowedWorkflows] };
}

function buildInstructions(targetTitle: string, strategyInstruction: string) {
  return [
    '你是智学引擎的实时面对面辅导导师，请使用简体中文。',
    `当前学习目标：${targetTitle || '面对面辅导'}`,
    strategyInstruction,
    '优先结合本地知识库检索证据；没有证据时必须明确说明未验证。',
    '不要编造教材、页码、教师要求、实验结果或知识库来源。',
    '拒绝作弊、隐私泄露、危险行为和越权请求。',
    '回答适合语音表达，保持清晰、简洁并给出可执行的下一步。',
  ].join('\n');
}
