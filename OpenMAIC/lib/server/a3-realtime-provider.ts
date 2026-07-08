import type { A3RealtimeCoachingSession, A3RealtimeProvider } from '@/lib/a3/realtime-coaching-types';
import { createDashScopeRealtimeSession } from '@/lib/server/a3-dashscope-realtime';
import { createOpenAIRealtimeSession } from '@/lib/server/a3-openai-realtime';

type CreateRealtimeSessionInput = {
  userId: string;
  coachingSessionId: string;
  targetTitle: string;
  preferredProvider?: A3RealtimeProvider;
};

export async function createA3RealtimeSession(input: CreateRealtimeSessionInput): Promise<A3RealtimeCoachingSession> {
  const provider = selectA3RealtimeProvider(input.preferredProvider);
  if (provider === 'openai_realtime_webrtc') return createOpenAIRealtimeSession(input);
  if (provider === 'dashscope_qwen_omni_realtime') return createDashScopeRealtimeSession(input);
  return {
    success: true,
    provider: 'local_fallback_record_then_respond',
    model: 'a3-local-fallback',
    connection: { type: 'fallback', readyForBrowserMedia: false },
    coachingSessionId: input.coachingSessionId,
    fallbackReason: '实时 provider 未配置，已降级到录音转写和普通问答。',
    instructions: {
      targetTitle: input.targetTitle || '面对面辅导',
      safetyPolicyVersion: 'a3.realtime-safety.v1',
      retrievalPolicyVersion: 'a3.hybrid-rag.v1',
    },
  };
}

export function selectA3RealtimeProvider(preferredProvider?: A3RealtimeProvider): A3RealtimeProvider {
  if (preferredProvider === 'openai_realtime_webrtc' || preferredProvider === 'dashscope_qwen_omni_realtime') {
    return preferredProvider;
  }
  const configured = process.env.A3_REALTIME_PROVIDER;
  if (configured === 'openai_realtime_webrtc' || configured === 'dashscope_qwen_omni_realtime') return configured;
  if (process.env.DASHSCOPE_API_KEY) return 'dashscope_qwen_omni_realtime';
  if (process.env.OPENAI_API_KEY) return 'openai_realtime_webrtc';
  return 'local_fallback_record_then_respond';
}
