import type { A3RealtimeCoachingSession } from '@/lib/a3/realtime-coaching-types';
import type { A3TutorPersona } from '@/lib/a3/tutor-persona-types';
import { resolveA3TutorPersonaRuntime, toPublicTutorPersona } from '@/lib/server/a3-tutor-persona-runtime';

type CreateRealtimeSessionInput = {
  coachingSessionId: string;
  targetTitle: string;
  resolvedPersona: A3TutorPersona;
};

export async function createDashScopeRealtimeSession(input: CreateRealtimeSessionInput): Promise<A3RealtimeCoachingSession> {
  const apiKey = process.env.DASHSCOPE_API_KEY
    || process.env.A3_COACHING_API_KEY
    || process.env.QWEN_API_KEY
    || process.env.ASR_QWEN_API_KEY;
  const model = process.env.DASHSCOPE_REALTIME_MODEL || 'qwen3.5-omni-plus-realtime';
  const websocketUrl = process.env.DASHSCOPE_REALTIME_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
  const proxyUrl = process.env.A3_REALTIME_WS_PROXY_URL || 'ws://127.0.0.1:3003/a3/realtime/ws';
  const webrtcEndpoint = process.env.DASHSCOPE_REALTIME_WEBRTC_ENDPOINT;
  const runtime = resolveA3TutorPersonaRuntime(input.resolvedPersona.id);
  if (!apiKey) {
    return buildDashScopeFallback(input, 'DASHSCOPE_API_KEY 未配置，已降级到录音转写问答');
  }

  if (websocketUrl) {
    const connectionUrl = appendCoachingSessionId(proxyUrl, input.coachingSessionId);
    return {
      success: true,
      provider: 'dashscope_qwen_omni_realtime',
      model,
      connection: {
        type: 'websocket_proxy',
        connectionUrl,
        readyForBrowserMedia: true,
      },
      coachingSessionId: input.coachingSessionId,
      resolvedPersona: toPublicTutorPersona(runtime),
      personaFallbackUsed: runtime.fallbackUsed,
      instructions: {
        targetTitle: input.targetTitle || '面对面辅导',
        safetyPolicyVersion: 'a3.realtime-safety.v1',
        retrievalPolicyVersion: 'a3.hybrid-rag.v1',
      },
    };
  }

  return {
    success: true,
    provider: 'dashscope_qwen_omni_realtime',
    model,
    connection: {
      type: 'webrtc_proxy',
      connectionUrl: '/api/a3/coaching/realtime/sdp',
      readyForBrowserMedia: Boolean(webrtcEndpoint),
    },
    coachingSessionId: input.coachingSessionId,
    resolvedPersona: toPublicTutorPersona(runtime),
    personaFallbackUsed: runtime.fallbackUsed,
    fallbackReason: webrtcEndpoint
      ? ''
      : 'DashScope API key 已配置，但未配置 WebRTC SDP endpoint。当前不伪装 live，可继续使用录音、视觉帧和 RAG 降级链路。',
    instructions: {
      targetTitle: input.targetTitle || '面对面辅导',
      safetyPolicyVersion: 'a3.realtime-safety.v1',
      retrievalPolicyVersion: 'a3.hybrid-rag.v1',
    },
  };
}

function buildDashScopeFallback(input: CreateRealtimeSessionInput, reason: string): A3RealtimeCoachingSession {
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
    instructions: {
      targetTitle: input.targetTitle || '面对面辅导',
      safetyPolicyVersion: 'a3.realtime-safety.v1',
      retrievalPolicyVersion: 'a3.hybrid-rag.v1',
    },
  };
}

function appendCoachingSessionId(proxyUrl: string, coachingSessionId: string) {
  const separator = proxyUrl.includes('?') ? '&' : '?';
  return `${proxyUrl}${separator}coachingSessionId=${encodeURIComponent(coachingSessionId)}`;
}
