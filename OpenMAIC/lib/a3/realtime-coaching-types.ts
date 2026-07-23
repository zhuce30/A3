export type A3RealtimeProvider =
  | 'openai_realtime_webrtc'
  | 'dashscope_qwen_omni_realtime'
  | 'local_fallback_record_then_respond';

export type A3RealtimeStatus =
  | 'idle'
  | 'requesting_permission'
  | 'connecting'
  | 'live'
  | 'visual_focus'
  | 'degraded'
  | 'ending'
  | 'ended'
  | 'error';

export type A3RealtimeConnection = {
  type: 'webrtc' | 'webrtc_proxy' | 'websocket_proxy' | 'fallback';
  clientSecret?: string;
  connectionUrl?: string;
  expiresAt?: number;
  readyForBrowserMedia: boolean;
};

export type A3RealtimeEvidence = {
  title: string;
  location?: string;
  snippet?: string;
  score?: number | null;
  previewUrl?: string;
  sourceType?: 'text' | 'visual' | 'mixed';
};

export type A3RealtimeTranscriptEvent = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  final: boolean;
  createdAt: string;
  citations?: A3RealtimeEvidence[];
  verified?: boolean;
};

export type A3RealtimeCoachingSession = {
  success: boolean;
  error?: string;
  provider: A3RealtimeProvider;
  model: string;
  connection: A3RealtimeConnection;
  coachingSessionId: string;
  fallbackReason?: string;
  instructions: {
    targetTitle: string;
    safetyPolicyVersion: string;
    retrievalPolicyVersion: string;
  };
};

export type A3RealtimeFramePayload = {
  coachingSessionId: string;
  imageDataUrl: string;
  source: 'camera' | 'screen' | 'upload';
  prompt?: string;
  fast?: boolean;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  };
};
