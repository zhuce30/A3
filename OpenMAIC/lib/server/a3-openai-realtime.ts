import type { A3RealtimeCoachingSession } from '@/lib/a3/realtime-coaching-types';
import type { A3TutorPersona } from '@/lib/a3/tutor-persona-types';
import { resolveA3TutorPersonaRuntime, toPublicTutorPersona } from '@/lib/server/a3-tutor-persona-runtime';

type CreateRealtimeSessionInput = {
  userId: string;
  coachingSessionId: string;
  targetTitle: string;
  resolvedPersona: A3TutorPersona;
};

export async function createOpenAIRealtimeSession(input: CreateRealtimeSessionInput): Promise<A3RealtimeCoachingSession> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2';
  const runtime = resolveA3TutorPersonaRuntime(input.resolvedPersona.id);
  if (!apiKey) return buildOpenAIFallback(input, 'OPENAI_API_KEY 未配置，已降级到录音转写问答');
  return {
    success: true,
    provider: 'openai_realtime_webrtc',
    model,
    connection: {
      type: 'webrtc_proxy',
      connectionUrl: '/api/a3/coaching/realtime/sdp',
      readyForBrowserMedia: true,
    },
    coachingSessionId: input.coachingSessionId,
    resolvedPersona: toPublicTutorPersona(runtime),
    personaFallbackUsed: runtime.fallbackUsed,
    instructions: buildInstructions(input.targetTitle),
  };
}

function buildOpenAIFallback(input: CreateRealtimeSessionInput, reason: string): A3RealtimeCoachingSession {
  const runtime = resolveA3TutorPersonaRuntime(input.resolvedPersona.id);
  return {
    success: true,
    provider: 'local_fallback_record_then_respond',
    model: 'a3-local-fallback',
    connection: { type: 'fallback', readyForBrowserMedia: false },
    coachingSessionId: input.coachingSessionId,
    resolvedPersona: toPublicTutorPersona(runtime),
    personaFallbackUsed: runtime.fallbackUsed,
    fallbackReason: reason,
    instructions: buildInstructions(input.targetTitle),
  };
}

function buildInstructions(targetTitle: string) {
  return {
    targetTitle: targetTitle || '面对面辅导',
    safetyPolicyVersion: 'a3.realtime-safety.v1',
    retrievalPolicyVersion: 'a3.hybrid-rag.v1',
  };
}

export function buildRealtimeInstructions(targetTitle: string) {
  return [
    '你是 A3 智学引擎的实时面对面辅导 Agent，请使用简体中文。',
    `当前学习目标：${targetTitle || '面对面辅导'}`,
    '优先调用本地知识库检索工具获取证据；没有证据时必须说明未验证。',
    '不要编造教材、页码、老师要求或知识库来源。',
    '回答适合语音表达：先给结论，再分步骤讲解。',
  ].join('\n');
}
