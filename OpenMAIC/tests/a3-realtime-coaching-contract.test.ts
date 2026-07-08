import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const typesPath = path.resolve(root, 'lib/a3/realtime-coaching-types.ts');
const providerPath = path.resolve(root, 'lib/server/a3-realtime-provider.ts');
const openaiProviderPath = path.resolve(root, 'lib/server/a3-openai-realtime.ts');
const dashscopeProviderPath = path.resolve(root, 'lib/server/a3-dashscope-realtime.ts');
const sessionRoutePath = path.resolve(root, 'app/api/a3/coaching/realtime/session/route.ts');
const toolRoutePath = path.resolve(root, 'app/api/a3/coaching/realtime/tool/route.ts');
const frameRoutePath = path.resolve(root, 'app/api/a3/coaching/realtime/frame/route.ts');
const messageRoutePath = path.resolve(root, 'app/api/a3/coaching/realtime/message/route.ts');
const endRoutePath = path.resolve(root, 'app/api/a3/coaching/realtime/end/route.ts');
const sdpRoutePath = path.resolve(root, 'app/api/a3/coaching/realtime/sdp/route.ts');
const sdpProviderPath = path.resolve(root, 'lib/server/a3-realtime-sdp.ts');
const dashscopeProxyPath = path.resolve(root, 'scripts/a3-dashscope-realtime-proxy.mjs');
const packagePath = path.resolve(root, 'package.json');
const callComponentPath = path.resolve(root, 'components/a3/features/coaching/realtime-coaching-call.tsx');
const hookPath = path.resolve(root, 'components/a3/features/coaching/use-realtime-coaching.ts');
const coachingViewPath = path.resolve(root, 'components/a3/features/coaching-view.tsx');

function read(filePath: string) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('A3 realtime coaching contracts', () => {
  it('defines provider-neutral realtime coaching types', () => {
    const source = read(typesPath);
    expect(source).toContain('export type A3RealtimeProvider');
    expect(source).toContain('openai_realtime_webrtc');
    expect(source).toContain('dashscope_qwen_omni_realtime');
    expect(source).toContain('local_fallback_record_then_respond');
    expect(source).toContain('export type A3RealtimeConnection');
    expect(source).toContain('export type A3RealtimeCoachingSession');
    expect(source).toContain('coachingSessionId');
    expect(source).toContain('fallbackReason');
    expect(source).toContain('previewUrl');
  });

  it('keeps realtime provider secrets on the server', () => {
    const provider = read(providerPath);
    const openai = read(openaiProviderPath);
    const dashscope = read(dashscopeProviderPath);
    expect(provider).toContain('selectA3RealtimeProvider');
    expect(provider).toContain('createA3RealtimeSession');
    expect(openai).toContain('process.env.OPENAI_API_KEY');
    expect(dashscope).toContain('process.env.DASHSCOPE_API_KEY');
    expect(dashscope).toContain('DASHSCOPE_REALTIME_URL');
    expect(dashscope).toContain('websocket_proxy');
    expect(`${provider}\n${openai}\n${dashscope}`).not.toContain('NEXT_PUBLIC_OPENAI_API_KEY');
    expect(`${provider}\n${openai}\n${dashscope}`).not.toContain('NEXT_PUBLIC_DASHSCOPE_API_KEY');
  });

  it('exposes realtime coaching API routes', () => {
    expect(read(sessionRoutePath)).toContain('createA3RealtimeSession');
    expect(read(toolRoutePath)).toContain('retrieve_learning_evidence');
    expect(read(toolRoutePath)).toContain('/api/kb/search/');
    expect(read(toolRoutePath)).toContain('includeVisualEvidence');
    expect(read(frameRoutePath)).toContain('answerA3VisionQuestion');
    expect(read(frameRoutePath)).toContain('imageDataUrl');
    expect(read(messageRoutePath)).toContain('/api/learning/coaching/session/');
    expect(read(endRoutePath)).toContain('/api/learning/coaching/sessions/');
    expect(read(sdpRoutePath)).toContain('exchangeRealtimeSdp');
    expect(read(sdpRoutePath)).toContain('offerSdp');
    expect(read(sdpRoutePath)).toContain('/api/auth/me/');
  });

  it('wires the realtime call UI into the coaching page', () => {
    const hook = read(hookPath);
    const component = read(callComponentPath);
    expect(hook).toContain('useRealtimeCoaching');
    expect(hook).toContain('RTCPeerConnection');
    expect(hook).toContain('/api/a3/coaching/realtime/sdp');
    expect(hook).toContain('connectRealtimeWebSocket');
    expect(hook).toContain('new WebSocket(connectionUrl)');
    expect(hook).toContain('input_audio_buffer.append');
    expect(hook).toContain('input_audio_buffer.commit');
    expect(hook).toContain('response.create');
    expect(hook).toContain('scheduleManualAudioCommit');
    expect(hook).toContain('interruptAssistant');
    expect(hook).toContain('endWithoutSummary');
    expect(hook).toContain('response.cancel');
    expect(hook).toContain('activePlaybackSourcesRef');
    expect(hook).toContain('audioLevel');
    expect(hook).toContain('sampleRate: 16000');
    expect(hook).toContain('encodePcm16Base64');
    expect(hook).toContain('playRealtimeAudioDelta');
    expect(hook).toContain('decodePcm16Base64');
    expect(hook).toContain("eventType.includes('audio.delta')");
    expect(hook).toContain('appendTranscriptEvent');
    expect(hook).toContain('peer.addTrack(activeVideo.track');
    expect(hook).toContain('replaceTrack(activeVideo?.track || null)');
    expect(hook).toContain('captureFrame');
    expect(component).toContain('data-testid="a3-realtime-coaching-call"');
    expect(component).toContain('data-testid="a3-realtime-start"');
    expect(component).toContain('data-testid="a3-realtime-end-only"');
    expect(component).toContain('data-testid="a3-realtime-interrupt"');
    expect(component).toContain('data-testid="a3-realtime-capture-frame"');
    expect(component).toContain('data-testid="a3-realtime-audio-level"');
    expect(component).toContain('previewUrl');
    expect(read(coachingViewPath)).toContain('RealtimeCoachingCall');
  });

  it('uses server-side realtime SDP proxy endpoints without exposing provider keys', () => {
    const source = read(sdpProviderPath);
    expect(source).toContain('https://api.openai.com/v1/realtime/calls');
    expect(source).toContain('FormData');
    expect(source).toContain('OpenAI-Safety-Identifier');
    expect(source).toContain('DASHSCOPE_REALTIME_WEBRTC_ENDPOINT');
    expect(source).not.toContain('NEXT_PUBLIC_OPENAI_API_KEY');
    expect(source).not.toContain('NEXT_PUBLIC_DASHSCOPE_API_KEY');
  });

  it('ships a DashScope WebSocket proxy instead of exposing the upstream URL to browsers', () => {
    const proxy = read(dashscopeProxyPath);
    const packageJson = read(packagePath);
    expect(proxy).toContain('WebSocketServer');
    expect(proxy).toContain('DASHSCOPE_REALTIME_URL');
    expect(proxy).toContain('Authorization: `Bearer ${dashScopeApiKey}`');
    expect(proxy).toContain("input_audio_format: 'pcm'");
    expect(proxy).toContain("turn_detection");
    expect(proxy).toContain('/api/auth/me/');
    expect(proxy).toContain('/a3/realtime/ws');
    expect(packageJson).toContain('realtime:dashscope-proxy');
    expect(proxy).not.toContain('NEXT_PUBLIC_DASHSCOPE_API_KEY');
  });
});
