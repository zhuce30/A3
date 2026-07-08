import type { A3RealtimeProvider } from '@/lib/a3/realtime-coaching-types';

type ExchangeRealtimeSdpInput = {
  provider: A3RealtimeProvider;
  model: string;
  offerSdp: string;
  safetyIdentifier?: string;
};

export async function exchangeRealtimeSdp({ provider, model, offerSdp, safetyIdentifier }: ExchangeRealtimeSdpInput) {
  if (provider === 'openai_realtime_webrtc') return exchangeOpenAIRealtimeSdp(model, offerSdp, safetyIdentifier);
  if (provider === 'dashscope_qwen_omni_realtime') return exchangeDashScopeRealtimeSdp(model, offerSdp);
  return { success: false, error: '当前 provider 不支持实时 WebRTC SDP 交换' };
}

async function exchangeOpenAIRealtimeSdp(model: string, offerSdp: string, safetyIdentifier?: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, error: 'OPENAI_API_KEY 未配置' };
  const endpoint = process.env.OPENAI_REALTIME_SDP_ENDPOINT || 'https://api.openai.com/v1/realtime/calls';
  const sessionConfig = {
    type: 'realtime',
    model: model || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
    audio: { output: { voice: process.env.OPENAI_REALTIME_VOICE || 'marin' } },
  };
  const formData = new FormData();
  formData.set('sdp', offerSdp);
  formData.set('session', JSON.stringify(sessionConfig));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(safetyIdentifier ? { 'OpenAI-Safety-Identifier': safetyIdentifier } : {}),
    },
    body: formData,
  });
  const answerSdp = await response.text();
  if (!response.ok) return { success: false, error: answerSdp || `OpenAI SDP 交换失败：${response.status}` };
  return { success: true, answerSdp };
}

async function exchangeDashScopeRealtimeSdp(model: string, offerSdp: string) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const endpoint = process.env.DASHSCOPE_REALTIME_WEBRTC_ENDPOINT;
  if (!apiKey) return { success: false, error: 'DASHSCOPE_API_KEY 未配置' };
  if (!endpoint) return { success: false, error: 'DASHSCOPE_REALTIME_WEBRTC_ENDPOINT 未配置，无法进行 DashScope WebRTC SDP 交换' };
  const url = endpoint.includes('model=')
    ? endpoint
    : endpoint.includes('?')
    ? `${endpoint}&model=${encodeURIComponent(model || 'qwen3.5-omni-plus-realtime')}`
    : `${endpoint}?model=${encodeURIComponent(model || 'qwen3.5-omni-plus-realtime')}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/sdp',
    },
    body: offerSdp,
  });
  const answerSdp = await response.text();
  if (!response.ok) return { success: false, error: answerSdp || `DashScope SDP 交换失败：${response.status}` };
  return { success: true, answerSdp };
}
