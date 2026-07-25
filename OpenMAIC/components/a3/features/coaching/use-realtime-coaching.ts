'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  A3DigitalHumanSpeechCue,
  A3DigitalHumanSpeechViseme,
} from '@/lib/a3/digital-human-types';
import type {
  A3RealtimeCoachingSession,
  A3RealtimeEvidence,
  A3RealtimeFramePayload,
  A3RealtimeStatus,
  A3RealtimeTranscriptEvent,
} from '@/lib/a3/realtime-coaching-types';
import { captureRealtimeVideoFrame } from '@/lib/a3/realtime-frame-capture';
import type { NormalizedMediaRegion } from '@/lib/a3/realtime-media-focus';

type ToolResponse = {
  success: boolean;
  error?: string;
  evidence?: A3RealtimeEvidence[];
};

type FrameResponse = {
  success: boolean;
  error?: string;
  reply?: string;
  verified?: boolean;
  citations?: A3RealtimeEvidence[];
  visualContextPersisted?: boolean;
};

type SdpResponse = {
  success: boolean;
  error?: string;
  answerSdp?: string;
};

type RealtimeSummary = {
  schemaVersion?: string;
  questionCount?: number;
  assistantReplyCount?: number;
  verifiedReplyCount?: number;
  citationCount?: number;
  visualEvidenceCount?: number;
  latestQuestions?: string[];
  recommendedReviewTasks?: Array<{ title?: string; href?: string; reason?: string }>;
  nextAction?: { label?: string; href?: string; reason?: string };
  generatedAt?: string;
};

type EndResponse = {
  success: boolean;
  error?: string;
  summary?: RealtimeSummary | null;
};

type BrowserAudioContext = typeof AudioContext;
type RetrievalProgress = {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  message: string;
  sourceCount?: number;
};

type ProviderSpeechCueItem = {
  viseme?: string;
  phoneme?: string;
  start_ms?: number;
  duration_ms?: number;
  startMs?: number;
  durationMs?: number;
  weights?: Partial<Record<A3DigitalHumanSpeechViseme, number>>;
};

const REALTIME_FRAME_SLOW_FEEDBACK_MS = 8000;

function isLoopbackHostname(hostname: string) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

export function localizeRealtimeWebSocketUrl(connectionUrl: string, pageHostname: string) {
  if (!isLoopbackHostname(pageHostname)) return connectionUrl;
  try {
    const parsed = new URL(connectionUrl);
    if (isLoopbackHostname(parsed.hostname) && parsed.hostname !== pageHostname) {
      parsed.hostname = pageHostname;
      return parsed.toString();
    }
  } catch {
    return connectionUrl;
  }
  return connectionUrl;
}

type RemoteAudioSpeakingTarget = {
  addEventListener: (eventName: string, listener: EventListener) => void;
  removeEventListener: (eventName: string, listener: EventListener) => void;
};

type RemoteAudioPlaybackTarget = RemoteAudioSpeakingTarget & {
  play: () => Promise<void>;
  pause: () => void;
  remove: () => void;
  srcObject: MediaProvider | null;
};

export type RealtimeStartOperation = {
  generation: number;
  controller: AbortController;
};

export function createRealtimeStartOperationController() {
  let generation = 0;
  let current: RealtimeStartOperation | null = null;

  const isCurrent = (operation: RealtimeStartOperation) => (
    current === operation && !operation.controller.signal.aborted
  );

  return {
    begin() {
      current?.controller.abort();
      current = { generation: ++generation, controller: new AbortController() };
      return current;
    },
    invalidate() {
      generation += 1;
      current?.controller.abort();
      current = null;
    },
    isCurrent,
  };
}

export async function runRealtimeStartStep<T>(
  operation: RealtimeStartOperation,
  isCurrent: (operation: RealtimeStartOperation) => boolean,
  task: () => Promise<T>,
  onError?: (error: Error) => void,
): Promise<{ committed: true; value: T } | { committed: false }> {
  try {
    const value = await task();
    if (!isCurrent(operation)) return { committed: false };
    return { committed: true, value };
  } catch (error) {
    if (isCurrent(operation)) {
      onError?.(error instanceof Error ? error : new Error('实时辅导启动失败'));
    }
    return { committed: false };
  }
}

export async function acquireRealtimeStartResource<T>(
  operation: RealtimeStartOperation,
  isCurrent: (operation: RealtimeStartOperation) => boolean,
  acquire: () => Promise<T>,
  release: (resource: T) => void,
) {
  const resource = await acquire();
  if (isCurrent(operation)) return resource;
  release(resource);
  return null;
}

export function canStartRealtimeCall(status: A3RealtimeStatus) {
  return status !== 'requesting_permission'
    && status !== 'connecting'
    && status !== 'live'
    && status !== 'ending';
}

export async function runRealtimeEndLifecycle<T>({
  operation,
  isCurrent,
  stopMedia,
  persist,
  requestEnd,
  commit,
  onError,
}: {
  operation: RealtimeStartOperation;
  isCurrent: (operation: RealtimeStartOperation) => boolean;
  stopMedia: () => void;
  persist: () => Promise<void>;
  requestEnd: () => Promise<T>;
  commit: (result: T) => void;
  onError?: (error: Error) => void;
}) {
  stopMedia();
  try {
    await persist();
    if (!isCurrent(operation)) return false;
    const result = await requestEnd();
    if (!isCurrent(operation)) return false;
    commit(result);
    return true;
  } catch (error) {
    if (isCurrent(operation)) {
      onError?.(error instanceof Error ? error : new Error('实时辅导结束失败'));
    }
    return false;
  }
}

export function bindRemoteAudioSpeakingState(
  audio: RemoteAudioSpeakingTarget,
  onSpeakingChange: (speaking: boolean) => void,
) {
  const handlePlaying = () => onSpeakingChange(true);
  const handleStopped = () => onSpeakingChange(false);
  const playingEvents = ['play', 'playing'] as const;
  const stoppedEvents = ['pause', 'ended', 'emptied'] as const;

  playingEvents.forEach((eventName) => audio.addEventListener(eventName, handlePlaying));
  stoppedEvents.forEach((eventName) => audio.addEventListener(eventName, handleStopped));

  return () => {
    playingEvents.forEach((eventName) => audio.removeEventListener(eventName, handlePlaying));
    stoppedEvents.forEach((eventName) => audio.removeEventListener(eventName, handleStopped));
    onSpeakingChange(false);
  };
}

export function createRemoteAudioSpeakingController(
  onSpeakingChange: (speaking: boolean) => void,
) {
  let generation = 0;
  let activeAudio: RemoteAudioPlaybackTarget | null = null;
  let removeSpeakingListeners: (() => void) | null = null;

  const releaseAudio = (audio: RemoteAudioPlaybackTarget) => {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  };

  return {
    attach(audio: RemoteAudioPlaybackTarget) {
      const currentGeneration = ++generation;
      removeSpeakingListeners?.();
      if (activeAudio && activeAudio !== audio) releaseAudio(activeAudio);
      activeAudio = audio;
      removeSpeakingListeners = bindRemoteAudioSpeakingState(audio, (speaking) => {
        if (generation === currentGeneration && activeAudio === audio) {
          onSpeakingChange(speaking);
        }
      });
      void audio.play().catch(() => {
        if (generation === currentGeneration && activeAudio === audio) {
          onSpeakingChange(false);
        }
      });
    },
    dispose(notify = true) {
      generation += 1;
      removeSpeakingListeners?.();
      removeSpeakingListeners = null;
      if (activeAudio) releaseAudio(activeAudio);
      activeAudio = null;
      if (notify) onSpeakingChange(false);
    },
  };
}

export function useRealtimeCoaching(personaId: string = '') {
  const [status, setStatus] = useState<A3RealtimeStatus>('idle');
  const [session, setSession] = useState<A3RealtimeCoachingSession | null>(null);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState<A3RealtimeEvidence[]>([]);
  const [transcript, setTranscript] = useState<A3RealtimeTranscriptEvent[]>([]);
  const [toolQuery, setToolQuery] = useState('');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [speechCues, setSpeechCues] = useState<A3DigitalHumanSpeechCue[]>([]);
  const [summary, setSummary] = useState<RealtimeSummary | null>(null);
  const [retrievalProgress, setRetrievalProgress] = useState<RetrievalProgress>({
    status: 'idle',
    message: '等待检索本地资料',
  });
  const mountedRef = useRef(true);
  const startOperationControllerRef = useRef(createRealtimeStartOperationController());
  const assistantSpeakingRef = useRef(false);
  const coachingSessionId = session?.coachingSessionId;
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteAudioSpeakingControllerRef = useRef<ReturnType<
    typeof createRemoteAudioSpeakingController
  > | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSilenceGainRef = useRef<GainNode | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const activePlaybackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const audioSequenceRef = useRef(0);
  const speechCueSequenceRef = useRef(0);
  const audioStreamingRef = useRef(false);
  const audioSpeechActiveRef = useRef(false);
  const audioSilenceChunksRef = useRef(0);
  const pendingSpeechCommitRef = useRef(false);
  const speechCommitTimerRef = useRef<number | null>(null);
  const lastAudioLevelUpdateRef = useRef(0);

  const updateAssistantSpeaking = useCallback((speaking: boolean) => {
    assistantSpeakingRef.current = speaking;
    if (mountedRef.current) setAssistantSpeaking(speaking);
  }, []);

  const isStartOperationCurrent = useCallback((operation: RealtimeStartOperation) => (
    mountedRef.current && Boolean(startOperationControllerRef.current?.isCurrent(operation))
  ), []);

  const attachCameraStream = useCallback(() => {
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = cameraStreamRef.current;
  }, []);

  const attachScreenStream = useCallback(() => {
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = screenStreamRef.current;
      void screenVideoRef.current.play().catch(() => {
        // The explicit play call is best-effort; autoplay handles the common path.
      });
    }
  }, []);

  const appendTranscriptEvent = useCallback((role: A3RealtimeTranscriptEvent['role'], content: string, final: boolean) => {
    const normalized = content.trim();
    if (!normalized) return;
    setTranscript((items) => {
      const latest = items.at(-1);
      if (latest && latest.role === role && !latest.final) {
        const mergedContent = final ? normalized : `${latest.content}${normalized}`;
        return [
          ...items.slice(0, -1),
          {
            ...latest,
            content: mergedContent,
            final,
          },
        ];
      }
      return [
        ...items,
        {
          id: crypto.randomUUID(),
          role,
          content: normalized,
          final,
          createdAt: new Date().toISOString(),
        },
      ];
    });
  }, []);

  const appendAudioEnergySpeechCue = useCallback((startAtSeconds: number, durationSeconds: number, audioContextCurrentTime: number, energy: number) => {
    const startsAtMs = performance.now() + Math.max(0, startAtSeconds - audioContextCurrentTime) * 1000;
    const endsAtMs = startsAtMs + Math.max(60, durationSeconds * 1000);
    const cueIndex = speechCueSequenceRef.current++;
    const visemeCycle: A3DigitalHumanSpeechViseme[] = ['aa', 'ih', 'ou', 'ee', 'oh'];
    const viseme = visemeCycle[cueIndex % visemeCycle.length];
    const nextCue: A3DigitalHumanSpeechCue = {
      id: `audio-energy-${cueIndex}`,
      source: 'audio_energy',
      startsAtMs,
      endsAtMs,
      viseme,
      energy: Math.max(0.08, Math.min(1, energy * 10)),
    };
    setSpeechCues((items) => [...items.filter((item) => item.endsAtMs > startsAtMs - 4000), nextCue].slice(-48));
  }, []);

  const playRealtimeAudioDelta = useCallback((audioBase64: string) => {
    const pcm = decodePcm16Base64(audioBase64);
    if (!pcm.length) return;
    const AudioContextCtor = (window.AudioContext || (window as unknown as { webkitAudioContext?: BrowserAudioContext }).webkitAudioContext);
    if (!AudioContextCtor) return;
    const audioContext = playbackAudioContextRef.current || new AudioContextCtor({ sampleRate: 24000 });
    playbackAudioContextRef.current = audioContext;
    const audioBuffer = audioContext.createBuffer(1, pcm.length, 24000);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, pcm[index] / 0x8000));
    }
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    activePlaybackSourcesRef.current.add(source);
    updateAssistantSpeaking(true);
    source.onended = () => {
      activePlaybackSourcesRef.current.delete(source);
      if (!activePlaybackSourcesRef.current.size) updateAssistantSpeaking(false);
    };
    const startAt = Math.max(audioContext.currentTime + 0.02, playbackCursorRef.current);
    appendAudioEnergySpeechCue(startAt, audioBuffer.duration, audioContext.currentTime, calculatePcm16Rms(pcm));
    source.start(startAt);
    playbackCursorRef.current = startAt + audioBuffer.duration;
  }, [appendAudioEnergySpeechCue, updateAssistantSpeaking]);

  const stopRealtimePlayback = useCallback((resetUi = true) => {
    activePlaybackSourcesRef.current.forEach((source) => {
      try {
        source.stop(0);
      } catch {
        // Source may already have ended.
      }
    });
    activePlaybackSourcesRef.current.clear();
    playbackCursorRef.current = 0;
    if (resetUi) {
      updateAssistantSpeaking(false);
      setSpeechCues([]);
    }
  }, [updateAssistantSpeaking]);

  const sendRealtimeCancel = useCallback(() => {
    const event = JSON.stringify({
      event_id: `a3_response_cancel_${Date.now()}`,
      type: 'response.cancel',
    });
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(event);
    }
    if (dataChannelRef.current?.readyState === 'open') {
      dataChannelRef.current.send(event);
    }
  }, []);

  const sendRealtimeVisualContext = useCallback((context: {
    source: 'camera' | 'screen' | 'upload';
    prompt?: string;
    reply: string;
    citations?: A3RealtimeEvidence[];
  }) => {
    const citationText = (context.citations || [])
      .slice(0, 3)
      .map((citation, index) => `${index + 1}. ${citation.title || '视觉证据'} ${citation.location || ''} ${citation.snippet || ''}`.trim())
      .join('\n');
    const text = [
      context.source === 'screen' ? '[A3_SCREEN_CONTEXT]' : '[A3_CAMERA_CONTEXT]',
      context.source === 'screen'
        ? '用户刚共享了一帧屏幕画面，下面是视觉模型对该屏幕的识别结果。后续回答必须把它当作你已经看到的屏幕上下文，不要再说你看不到共享屏幕。'
        : '用户刚发送了一帧摄像头/画面截图，下面是视觉模型识别结果。',
      context.prompt ? `用户视觉请求：${context.prompt}` : '',
      `视觉识别结果：${context.reply}`,
      citationText ? `可用证据：\n${citationText}` : '',
    ].filter(Boolean).join('\n');
    const contextEvent = JSON.stringify({
      event_id: `a3_visual_context_${Date.now()}`,
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    const responseEvent = JSON.stringify({
      event_id: `a3_visual_response_${Date.now()}`,
      type: 'response.create',
    });
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(contextEvent);
      websocketRef.current.send(responseEvent);
    }
    if (dataChannelRef.current?.readyState === 'open') {
      dataChannelRef.current.send(contextEvent);
      dataChannelRef.current.send(responseEvent);
    }
  }, []);

  const clearManualAudioCommitTimer = useCallback(() => {
    if (speechCommitTimerRef.current !== null) {
      window.clearTimeout(speechCommitTimerRef.current);
      speechCommitTimerRef.current = null;
    }
  }, []);

  const markProviderAudioCommitted = useCallback(() => {
    pendingSpeechCommitRef.current = false;
    audioSpeechActiveRef.current = false;
    audioSilenceChunksRef.current = 0;
    clearManualAudioCommitTimer();
  }, [clearManualAudioCommitTimer]);

  const scheduleManualAudioCommit = useCallback((socket: WebSocket) => {
    if (speechCommitTimerRef.current !== null) return;
    speechCommitTimerRef.current = window.setTimeout(() => {
      speechCommitTimerRef.current = null;
      if (!pendingSpeechCommitRef.current || socket.readyState !== WebSocket.OPEN) return;
      pendingSpeechCommitRef.current = false;
      audioSpeechActiveRef.current = false;
      audioSilenceChunksRef.current = 0;
      socket.send(JSON.stringify({
        event_id: `a3_audio_commit_${Date.now()}`,
        type: 'input_audio_buffer.commit',
      }));
      socket.send(JSON.stringify({
        event_id: `a3_response_${Date.now()}`,
        type: 'response.create',
      }));
    }, 900);
  }, []);

  const handleRealtimeEvent = useCallback((raw: string) => {
    try {
      const event = JSON.parse(raw) as {
        type?: string;
        delta?: string;
        audio?: string;
        transcript?: string;
        text?: string;
        response?: { output_text?: string };
        item?: { content?: Array<{ transcript?: string; text?: string }> };
        viseme?: string;
        phoneme?: string;
        start_ms?: number;
        duration_ms?: number;
        visemes?: Array<{ viseme?: string; phoneme?: string; start_ms?: number; duration_ms?: number; startMs?: number; durationMs?: number; weights?: Partial<Record<A3DigitalHumanSpeechViseme, number>> }>;
        phonemes?: Array<{ phoneme?: string; start_ms?: number; duration_ms?: number; startMs?: number; durationMs?: number }>;
      };
      const eventType = event.type || '';
      if (eventType === 'input_audio_buffer.committed' || eventType === 'response.created') {
        markProviderAudioCommitted();
      }
      const audioDelta = eventType.includes('audio.delta') ? event.delta || event.audio || '' : '';
      if (audioDelta) playRealtimeAudioDelta(audioDelta);
      const providerSpeechCues = extractProviderSpeechCues(event);
      if (providerSpeechCues.length) {
        setSpeechCues((items) => [...items.filter((item) => item.endsAtMs > performance.now() - 4000), ...providerSpeechCues].slice(-64));
      }
      const itemTranscript = event.item?.content?.map((item) => item.transcript || item.text || '').join('');
      const content = event.transcript || event.text || event.response?.output_text || event.delta || itemTranscript || '';
      if (!content || eventType.includes('audio.delta')) return;
      const role = eventType.includes('input') || eventType.includes('user') ? 'user' : 'assistant';
      appendTranscriptEvent(role, content, !eventType.includes('delta'));
    } catch {
      // Ignore non-JSON provider events.
    }
  }, [appendTranscriptEvent, markProviderAudioCommitted, playRealtimeAudioDelta]);

  const ensureAudioStream = useCallback(async (operation?: RealtimeStartOperation) => {
    if (!cameraStreamRef.current || cameraStreamRef.current.getAudioTracks().length === 0) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      const acquire = () => navigator.mediaDevices.getUserMedia({ audio: true, video: cameraEnabled });
      const nextStream = operation
        ? await acquireRealtimeStartResource(
          operation,
          isStartOperationCurrent,
          acquire,
          (stream) => stream.getTracks().forEach((track) => track.stop()),
        )
        : await acquire();
      if (!nextStream) return null;
      cameraStreamRef.current = nextStream;
      attachCameraStream();
    }
    if (operation && !isStartOperationCurrent(operation)) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      return null;
    }
    setMicrophoneEnabled(true);
    return cameraStreamRef.current;
  }, [attachCameraStream, cameraEnabled, isStartOperationCurrent]);

  const exchangePeerSdp = useCallback(async (
    peer: RTCPeerConnection,
    realtime: A3RealtimeCoachingSession,
    operation?: RealtimeStartOperation,
  ) => {
    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    if (operation && !isStartOperationCurrent(operation)) return false;
    await peer.setLocalDescription(offer);
    if (operation && !isStartOperationCurrent(operation)) return false;
    await waitForIceGatheringComplete(peer);
    if (operation && !isStartOperationCurrent(operation)) return false;
    const response = await fetch(realtime.connection.connectionUrl || '/api/a3/coaching/realtime/sdp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal: operation?.controller.signal,
      body: JSON.stringify({
        provider: realtime.provider,
        model: realtime.model,
        offerSdp: peer.localDescription?.sdp || offer.sdp,
        coachingSessionId: realtime.coachingSessionId,
      }),
    });
    if (operation && !isStartOperationCurrent(operation)) return false;
    const result = await response.json() as SdpResponse;
    if (operation && !isStartOperationCurrent(operation)) return false;
    if (!response.ok || !result.success || !result.answerSdp) {
      throw new Error(result.error || '实时 provider SDP 交换失败，已降级到录音/文字辅导。');
    }
    await peer.setRemoteDescription({ type: 'answer', sdp: result.answerSdp });
    if (operation && !isStartOperationCurrent(operation)) return false;
    return true;
  }, [isStartOperationCurrent]);

  const getActiveVideoTrack = useCallback(() => {
    const screenTrack = screenStreamRef.current?.getVideoTracks().find((track) => track.readyState === 'live' && track.enabled);
    if (screenTrack) return { track: screenTrack, stream: screenStreamRef.current };
    const cameraTrack = cameraStreamRef.current?.getVideoTracks().find((track) => track.readyState === 'live' && track.enabled);
    if (cameraTrack) return { track: cameraTrack, stream: cameraStreamRef.current };
    return null;
  }, []);

  const syncOutgoingVideoTrack = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer || !session || session.provider === 'local_fallback_record_then_respond' || !session.connection.readyForBrowserMedia) return;
    const activeVideo = getActiveVideoTrack();
    if (videoSenderRef.current) {
      await videoSenderRef.current.replaceTrack(activeVideo?.track || null);
    } else if (activeVideo?.track && activeVideo.stream) {
      videoSenderRef.current = peer.addTrack(activeVideo.track, activeVideo.stream);
    }
    if (!activeVideo?.track || peer.signalingState !== 'stable') return;
    try {
      await exchangePeerSdp(peer, session);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : '实时视频轨道同步失败，已保留截图辅导链路。');
    }
  }, [exchangePeerSdp, getActiveVideoTrack, session]);

  const connectRealtimePeer = useCallback(async (
    realtime: A3RealtimeCoachingSession,
    operation: RealtimeStartOperation,
  ) => {
    let peer: RTCPeerConnection | null = null;
    try {
      if (!isStartOperationCurrent(operation)) return false;
      if (!('RTCPeerConnection' in window)) {
        setError('当前浏览器不支持 WebRTC 实时通话');
        return false;
      }
      const audioStream = await ensureAudioStream(operation);
      if (!audioStream || !isStartOperationCurrent(operation)) return false;
      peer = new RTCPeerConnection();
      if (!isStartOperationCurrent(operation)) {
        peer.close();
        return false;
      }
      const activePeer = peer;
      peerRef.current = activePeer;
      audioStream.getAudioTracks().forEach((track) => activePeer.addTrack(track, audioStream));
      const activeVideo = getActiveVideoTrack();
      if (activeVideo?.track && activeVideo.stream) {
        videoSenderRef.current = activePeer.addTrack(activeVideo.track, activeVideo.stream);
      }
      activePeer.ontrack = (event) => {
        const audio = remoteAudioRef.current || document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = event.streams[0];
        const speakingController =
          remoteAudioSpeakingControllerRef.current ||
          createRemoteAudioSpeakingController(updateAssistantSpeaking);
        remoteAudioSpeakingControllerRef.current = speakingController;
        if (!remoteAudioRef.current) {
          audio.style.display = 'none';
          document.body.appendChild(audio);
          remoteAudioRef.current = audio;
        }
        speakingController.attach(audio);
      };
      const dataChannel = activePeer.createDataChannel('a3-realtime-events');
      dataChannelRef.current = dataChannel;
      dataChannel.onmessage = (event) => handleRealtimeEvent(event.data);
      const exchanged = await exchangePeerSdp(activePeer, realtime, operation);
      if (!exchanged || !isStartOperationCurrent(operation)) {
        activePeer.close();
        if (peerRef.current === activePeer) peerRef.current = null;
        return false;
      }
      return true;
    } catch (connectError) {
      if (isStartOperationCurrent(operation)) {
        setError(connectError instanceof Error ? connectError.message : '实时 WebRTC 连接失败，已降级到录音/文字辅导。');
      }
      peer?.close();
      if (peerRef.current === peer) peerRef.current = null;
      videoSenderRef.current = null;
      return false;
    }
  }, [
    ensureAudioStream,
    exchangePeerSdp,
    getActiveVideoTrack,
    handleRealtimeEvent,
    isStartOperationCurrent,
    updateAssistantSpeaking,
  ]);

  const stopDashScopeAudioStreaming = useCallback((resetUi = true) => {
    audioStreamingRef.current = false;
    clearManualAudioCommitTimer();
    pendingSpeechCommitRef.current = false;
    audioSpeechActiveRef.current = false;
    audioSilenceChunksRef.current = 0;
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    audioSilenceGainRef.current?.disconnect();
    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioSilenceGainRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    playbackAudioContextRef.current?.close().catch(() => undefined);
    playbackAudioContextRef.current = null;
    playbackCursorRef.current = 0;
    activePlaybackSourcesRef.current.clear();
    if (resetUi) {
      updateAssistantSpeaking(false);
      setSpeechCues([]);
      setAudioLevel(0);
    }
  }, [clearManualAudioCommitTimer, updateAssistantSpeaking]);

  const startDashScopeAudioStreaming = useCallback(async (
    socket: WebSocket,
    operation?: RealtimeStartOperation,
  ) => {
    if (audioStreamingRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持麦克风访问');
      return false;
    }
    const stream = await ensureAudioStream(operation);
    if (!stream || (operation && !isStartOperationCurrent(operation))) return false;
    const AudioContextCtor = (window.AudioContext || (window as unknown as { webkitAudioContext?: BrowserAudioContext }).webkitAudioContext);
    if (!AudioContextCtor) {
      setError('当前浏览器不支持实时音频采集');
      return false;
    }
    const audioContext = new AudioContextCtor({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silenceGain = audioContext.createGain();
    silenceGain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!audioStreamingRef.current || socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const rms = calculateRms(input);
      const now = Date.now();
      if (now - lastAudioLevelUpdateRef.current > 120) {
        lastAudioLevelUpdateRef.current = now;
        setAudioLevel(Math.min(1, rms * 12));
      }
      if (rms > 0.008) {
        pendingSpeechCommitRef.current = true;
        audioSpeechActiveRef.current = true;
        audioSilenceChunksRef.current = 0;
        clearManualAudioCommitTimer();
      } else if (audioSpeechActiveRef.current) {
        audioSilenceChunksRef.current += 1;
        if (audioSilenceChunksRef.current >= 5) {
          scheduleManualAudioCommit(socket);
        }
      }
      const pcmBase64 = encodePcm16Base64(input, audioContext.sampleRate, 16000);
      if (!pcmBase64) return;
      socket.send(JSON.stringify({
        event_id: `a3_audio_${Date.now()}_${audioSequenceRef.current++}`,
        type: 'input_audio_buffer.append',
        audio: pcmBase64,
      }));
    };
    source.connect(processor);
    processor.connect(silenceGain);
    silenceGain.connect(audioContext.destination);
    audioContextRef.current = audioContext;
    audioSourceRef.current = source;
    audioProcessorRef.current = processor;
    audioSilenceGainRef.current = silenceGain;
    audioStreamingRef.current = true;
    setMicrophoneEnabled(true);
    return true;
  }, [clearManualAudioCommitTimer, ensureAudioStream, isStartOperationCurrent, scheduleManualAudioCommit]);

  const connectRealtimeWebSocket = useCallback(async (
    realtime: A3RealtimeCoachingSession,
    operation: RealtimeStartOperation,
  ) => {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let socket: WebSocket | null = null;
      let timeout: number | null = null;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) window.clearTimeout(timeout);
        operation.controller.signal.removeEventListener('abort', handleAbort);
        resolve(connected);
      };
      const handleAbort = () => {
        socket?.close();
        finish(false);
      };
      try {
        if (!isStartOperationCurrent(operation)) {
          finish(false);
          return;
        }
        const connectionUrl = realtime.connection.connectionUrl;
        if (!connectionUrl) {
          setError('实时 WebSocket proxy 地址未配置，已降级到录音/文字辅导。');
          finish(false);
          return;
        }
        const localizedConnectionUrl = localizeRealtimeWebSocketUrl(
          connectionUrl,
          window.location.hostname,
        );
        socket = new WebSocket(localizedConnectionUrl);
        websocketRef.current = socket;
        operation.controller.signal.addEventListener('abort', handleAbort, { once: true });
        timeout = window.setTimeout(() => {
          if (isStartOperationCurrent(operation)) {
            setError('实时 WebSocket proxy 连接超时，已降级到录音/文字辅导。');
          }
          socket?.close();
          finish(false);
        }, 8000);
        socket.onopen = async () => {
          if (timeout !== null) window.clearTimeout(timeout);
          if (!socket || !isStartOperationCurrent(operation)) {
            socket?.close();
            finish(false);
            return;
          }
          const activeSocket = socket;
          const audioStarted = await startDashScopeAudioStreaming(activeSocket, operation).catch((audioError) => {
            if (isStartOperationCurrent(operation)) {
              setError(audioError instanceof Error ? audioError.message : '麦克风实时音频采集失败');
            }
            return false;
          });
          if (!audioStarted || !isStartOperationCurrent(operation)) {
            activeSocket.close();
            finish(false);
            return;
          }
          setTranscript((items) => [
            ...items,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `已连接 DashScope WebSocket proxy：${realtime.model}`,
              final: true,
              createdAt: new Date().toISOString(),
            },
          ]);
          finish(true);
        };
        socket.onmessage = (event) => {
          if (!isStartOperationCurrent(operation)) return;
          handleRealtimeEvent(typeof event.data === 'string' ? event.data : '');
        };
        socket.onerror = () => {
          if (timeout !== null) window.clearTimeout(timeout);
          stopDashScopeAudioStreaming();
          if (isStartOperationCurrent(operation)) {
            setError('实时 WebSocket proxy 连接失败，请确认实时代理服务已启动。');
          }
          finish(false);
        };
        socket.onclose = () => {
          stopDashScopeAudioStreaming();
          if (websocketRef.current === socket) websocketRef.current = null;
          finish(false);
        };
      } catch (connectError) {
        if (isStartOperationCurrent(operation)) {
          setError(connectError instanceof Error ? connectError.message : '实时 WebSocket proxy 连接失败，已降级到录音/文字辅导。');
        }
        socket?.close();
        finish(false);
      }
    });
  }, [handleRealtimeEvent, isStartOperationCurrent, startDashScopeAudioStreaming, stopDashScopeAudioStreaming]);

  const stopMediaTracks = useCallback((resetUi = true, invalidateOperation = true) => {
    if (invalidateOperation) startOperationControllerRef.current?.invalidate();
    stopRealtimePlayback(resetUi);
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (peerRef.current) peerRef.current.ontrack = null;
    peerRef.current?.close();
    if (dataChannelRef.current) dataChannelRef.current.onmessage = null;
    dataChannelRef.current?.close();
    if (websocketRef.current) {
      websocketRef.current.onopen = null;
      websocketRef.current.onmessage = null;
      websocketRef.current.onerror = null;
      websocketRef.current.onclose = null;
    }
    websocketRef.current?.close();
    stopDashScopeAudioStreaming(resetUi);
    if (remoteAudioSpeakingControllerRef.current) {
      remoteAudioSpeakingControllerRef.current.dispose();
    } else if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current.remove();
    }
    remoteAudioSpeakingControllerRef.current = null;
    updateAssistantSpeaking(false);
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    peerRef.current = null;
    websocketRef.current = null;
    videoSenderRef.current = null;
    dataChannelRef.current = null;
    remoteAudioRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    if (resetUi) {
      setCameraEnabled(false);
      setMicrophoneEnabled(false);
      setScreenEnabled(false);
    }
  }, [stopDashScopeAudioStreaming, stopRealtimePlayback, updateAssistantSpeaking]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopMediaTracks(false);
    };
  }, [stopMediaTracks]);

  const start = useCallback(async () => {
    const lifecycle = startOperationControllerRef.current;
    if (!lifecycle) return;
    const operation = lifecycle.begin();
    setStatus('connecting');
    setError('');
    setSummary(null);

    try {
      let startFailure: Error | null = null;
      const sessionRequest = await runRealtimeStartStep(
        operation,
        isStartOperationCurrent,
        () => fetch('/api/a3/coaching/realtime/session', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: operation.controller.signal,
          body: JSON.stringify({ mode: 'voice_video', personaId }),
        }),
        (error) => { startFailure = error; },
      );
      if (!sessionRequest.committed) {
        if (startFailure && isStartOperationCurrent(operation)) {
          throw startFailure;
        }
        return;
      }
      const response = sessionRequest.value;

      const sessionJson = await runRealtimeStartStep(
        operation,
        isStartOperationCurrent,
        () => response.json() as Promise<A3RealtimeCoachingSession>,
        (error) => { startFailure = error; },
      );
      if (!sessionJson.committed) {
        if (startFailure && isStartOperationCurrent(operation)) {
          throw startFailure;
        }
        return;
      }
      const result = sessionJson.value;
      if (!response.ok || !result.success) {
        setStatus('error');
        setError(result.error || '实时面对面辅导会话创建失败，请稍后重试。');
        return;
      }

      setSession(result);
      try {
        await fetch('/api/a3/coaching/realtime/message', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: operation.controller.signal,
          body: JSON.stringify({
            messages: [{
              id: crypto.randomUUID(),
              role: 'assistant',
              content: result.fallbackReason || `实时 provider 已准备：${result.provider}`,
              degraded: result.provider === 'local_fallback_record_then_respond' || !result.connection.readyForBrowserMedia,
              metadata: {
                realtime: {
                  provider: result.provider,
                  model: result.model,
                  readyForBrowserMedia: result.connection.readyForBrowserMedia,
                },
              },
            }],
            summary: `${result.instructions.targetTitle}：实时 provider ${result.provider}`,
          }),
        });
      } catch (persistError) {
        if (!isStartOperationCurrent(operation)) return;
        if (persistError instanceof DOMException && persistError.name === 'AbortError') return;
        // Session persistence is best-effort; the live transport can still start.
      }
      if (!isStartOperationCurrent(operation)) return;

      setTranscript((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: result.fallbackReason || `已创建 ${result.provider} 会话`,
          final: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (result.provider === 'local_fallback_record_then_respond' || !result.connection.readyForBrowserMedia) {
        setStatus('degraded');
        return;
      }

      const connected = result.connection.type === 'websocket_proxy'
        ? await connectRealtimeWebSocket(result, operation)
        : await connectRealtimePeer(result, operation);
      if (!isStartOperationCurrent(operation)) return;
      setStatus(connected ? 'live' : 'degraded');
    } catch (startError) {
      if (!isStartOperationCurrent(operation)) return;
      stopMediaTracks();
      if (!mountedRef.current) return;
      setStatus('error');
      setError(
        startError instanceof SyntaxError
          ? '实时辅导服务返回了无法解析的数据，请稍后重试。'
          : '实时面对面辅导连接失败，请检查网络后重试。',
      );
    }
  }, [connectRealtimePeer, connectRealtimeWebSocket, isStartOperationCurrent, personaId, stopMediaTracks]);

  const persistRealtimeTranscript = useCallback(async (
    sessionSnapshot: A3RealtimeCoachingSession | null,
    transcriptSnapshot: A3RealtimeTranscriptEvent[],
    signal?: AbortSignal,
  ) => {
    if (!sessionSnapshot?.coachingSessionId) return;
    const messages = transcriptSnapshot
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .filter((item) => item.content.trim())
      .slice(-8)
      .map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        verified: item.verified,
        citations: item.citations || [],
        createdAt: item.createdAt,
        metadata: {
          realtime: {
            provider: sessionSnapshot.provider,
            model: sessionSnapshot.model,
            coachingSessionId: sessionSnapshot.coachingSessionId,
          },
        },
      }));
    if (!messages.length) return;
    await fetch('/api/a3/coaching/realtime/message', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        messages,
        summary: `${sessionSnapshot.instructions.targetTitle}：实时辅导进行中`,
      }),
    }).catch(() => undefined);
  }, []);

  const end = useCallback(async () => {
    const lifecycle = startOperationControllerRef.current;
    const sessionSnapshot = session;
    const transcriptSnapshot = [...transcript];
    setStatus('ending');
    sendRealtimeCancel();
    lifecycle.invalidate();
    const operation = lifecycle.begin();
    await runRealtimeEndLifecycle({
      operation,
      isCurrent: isStartOperationCurrent,
      stopMedia: () => stopMediaTracks(true, false),
      persist: () => persistRealtimeTranscript(
        sessionSnapshot,
        transcriptSnapshot,
        operation.controller.signal,
      ),
      requestEnd: async () => {
        if (!sessionSnapshot?.coachingSessionId) return null;
        const response = await fetch('/api/a3/coaching/realtime/end', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: operation.controller.signal,
          body: JSON.stringify({ coachingSessionId: sessionSnapshot.coachingSessionId }),
        });
        if (!isStartOperationCurrent(operation)) return null;
        const result = await response.json().catch(() => ({})) as EndResponse;
        if (!isStartOperationCurrent(operation)) return null;
        return { response, result };
      },
      commit: (payload) => {
        if (!payload) return;
        const { response, result } = payload;
        if (response.ok && result.success && result.summary) {
          const summaryPayload = result.summary;
        setSummary(summaryPayload);
        setTranscript((items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `本次总结已生成：${summaryPayload.questionCount ?? 0} 次提问，${summaryPayload.verifiedReplyCount ?? 0} 条回答已验证，下一步建议：${summaryPayload.nextAction?.label || '继续学习计划'}。`,
            final: true,
            createdAt: new Date().toISOString(),
          },
        ]);
        } else if (result.error) {
          setError(result.error);
        }
      },
      onError: () => setError('实时辅导已结束，但本次总结生成失败，请稍后在历史记录中重试。'),
    });
    if (isStartOperationCurrent(operation)) setStatus('ended');
  }, [isStartOperationCurrent, persistRealtimeTranscript, sendRealtimeCancel, session, stopMediaTracks, transcript]);

  const endWithoutSummary = useCallback(() => {
    startOperationControllerRef.current?.invalidate();
    setStatus('ending');
    setSummary(null);
    sendRealtimeCancel();
    stopMediaTracks();
    setTranscript((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: '已结束实时通话，未生成本次总结。',
        final: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStatus('ended');
  }, [sendRealtimeCancel, stopMediaTracks]);

  const interruptAssistant = useCallback(() => {
    stopRealtimePlayback();
    sendRealtimeCancel();
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = true;
      window.setTimeout(() => {
        if (remoteAudioRef.current) remoteAudioRef.current.muted = false;
      }, 600);
    }
    setTranscript((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: '已打断 AI 发言，可以继续提问。',
        final: true,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, [sendRealtimeCancel, stopRealtimePlayback]);

  const retrieveEvidence = useCallback(async (query: string) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;
    setToolQuery(normalizedQuery);
    setError('');
    setRetrievalProgress({ status: 'running', message: `正在检索本地资料：${normalizedQuery}` });
    try {
      const response = await fetch('/api/a3/coaching/realtime/tool', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coachingSessionId,
          toolName: 'retrieve_learning_evidence',
          query: normalizedQuery,
          topK: 5,
          includeVisualEvidence: true,
        }),
      });
      const result = await response.json().catch(() => ({})) as ToolResponse;
      if (!response.ok || !result.success) {
        const message = result.error || '实时辅导知识库检索失败';
        setRetrievalProgress({ status: 'failed', message: `检索失败：${message}` });
        setError(message);
        return;
      }
      const nextEvidence = result.evidence || [];
      setEvidence(nextEvidence);
      setRetrievalProgress({
        status: 'succeeded',
        message: `已找到 ${nextEvidence.length} 条本地资料证据`,
        sourceCount: nextEvidence.length,
      });
    } catch (retrieveError) {
      const message = retrieveError instanceof Error ? retrieveError.message : '实时辅导知识库检索失败';
      setRetrievalProgress({ status: 'failed', message: `检索失败：${message}` });
      setError(message);
    }
  }, [coachingSessionId]);

  const toggleMic = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持麦克风访问');
        return;
      }
      if (!cameraStreamRef.current) {
        cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        attachCameraStream();
      }
      const nextEnabled = !microphoneEnabled;
      cameraStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = nextEnabled;
      });
      setMicrophoneEnabled(nextEnabled);
      if (websocketRef.current?.readyState === WebSocket.OPEN) {
        if (nextEnabled) {
          await startDashScopeAudioStreaming(websocketRef.current);
        } else {
          stopDashScopeAudioStreaming();
        }
      }
    } catch {
      setError('麦克风权限被拒绝或设备不可用，请检查浏览器权限。');
    }
  }, [attachCameraStream, microphoneEnabled, startDashScopeAudioStreaming, stopDashScopeAudioStreaming]);

  const toggleCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持摄像头访问');
        return;
      }
      if (!cameraStreamRef.current || cameraStreamRef.current.getVideoTracks().length === 0) {
        cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
        cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        attachCameraStream();
      }
      const nextEnabled = !cameraEnabled;
      cameraStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = nextEnabled;
      });
      setCameraEnabled(nextEnabled);
      setMicrophoneEnabled(cameraStreamRef.current.getAudioTracks().some((track) => track.enabled));
      await syncOutgoingVideoTrack();
    } catch {
      setError('摄像头权限被拒绝或设备不可用，请检查浏览器权限。');
    }
  }, [attachCameraStream, cameraEnabled, syncOutgoingVideoTrack]);

  const sendFrame = useCallback(async (payload: Omit<A3RealtimeFramePayload, 'coachingSessionId'>) => {
    if (!session?.coachingSessionId) {
      setError('请先开始实时辅导会话');
      return;
    }
    const sourceLabel = payload.source === 'screen' ? '屏幕画面' : '摄像头画面';
    let slowFeedbackShown = false;
    setStatus('visual_focus');
    setError('');
    setTranscript((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: `已截取${sourceLabel}，正在发送给视觉模型识别；识别完成后会同步给实时模型上下文。`,
        final: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    const slowFeedbackTimer = window.setTimeout(() => {
      slowFeedbackShown = true;
      setTranscript((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: '视觉模型响应较慢，画面已发送成功，请稍等；如果一直没有结果，可以再次点击“看这里/截屏分析”重试。',
          final: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    }, REALTIME_FRAME_SLOW_FEEDBACK_MS);
    try {
      const response = await fetch('/api/a3/coaching/realtime/frame', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, coachingSessionId: session.coachingSessionId }),
      });
      window.clearTimeout(slowFeedbackTimer);
      const result = await response.json().catch(() => ({})) as FrameResponse;
      if (!response.ok || !result.success) {
        const message = result.error || '实时视觉帧理解失败';
        setError(message);
        setTranscript((items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `视觉分析失败：${message}`,
            final: true,
            createdAt: new Date().toISOString(),
          },
        ]);
        setStatus('degraded');
        return;
      }
      setEvidence(result.citations || []);
      if (result.reply) {
        sendRealtimeVisualContext({
          source: payload.source,
          prompt: payload.prompt,
          reply: result.reply,
          citations: result.citations,
        });
        setTranscript((items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: result.reply || '',
            final: true,
            verified: Boolean(result.verified),
            citations: result.citations,
            createdAt: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: result.visualContextPersisted
              ? '视觉分析结果已写入辅导会话，并同步给实时模型上下文。'
              : slowFeedbackShown
                ? '视觉分析已完成，结果已同步给实时模型上下文。'
                : '视觉分析结果已同步给实时模型上下文。',
            final: true,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      setStatus(session.connection.readyForBrowserMedia ? 'live' : 'degraded');
    } catch (frameError) {
      window.clearTimeout(slowFeedbackTimer);
      const message = frameError instanceof Error ? frameError.message : '实时视觉帧理解失败';
      setError(message);
      setTranscript((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `视觉分析请求失败：${message}`,
          final: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatus('degraded');
    }
  }, [sendRealtimeVisualContext, session]);

  const shareScreen = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setError('当前浏览器不支持屏幕共享');
        return;
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => track.stop());
        screenStreamRef.current = null;
        setScreenEnabled(false);
        await syncOutgoingVideoTrack();
        return;
      }
      screenStreamRef.current = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => setScreenEnabled(false), { once: true });
      });
      attachScreenStream();
      setScreenEnabled(true);
      await syncOutgoingVideoTrack();
      setTranscript((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: '屏幕共享已开启。需要 AI 分析当前画面时，请点击“看这里/截屏分析”。',
          final: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch {
      setError('屏幕共享被取消或浏览器权限不可用。');
    }
  }, [attachScreenStream, syncOutgoingVideoTrack]);

  const captureFrame = useCallback(async (options?: {
    source?: 'camera' | 'screen';
    region?: NormalizedMediaRegion;
    prompt?: string;
    fast?: boolean;
  }) => {
    const requestedSource = options?.source;
    const screenVideo = screenEnabled ? screenVideoRef.current : null;
    const cameraVideo = cameraEnabled ? cameraVideoRef.current : null;
    const video = requestedSource === 'screen'
      ? screenVideo
      : requestedSource === 'camera'
        ? cameraVideo
        : screenVideo && screenVideo.videoWidth
          ? screenVideo
          : cameraVideo;
    const source = requestedSource || (screenVideo && screenVideo.videoWidth ? 'screen' : 'camera');
    if (!video || !video.videoWidth || !video.videoHeight) {
      setError('请先开启摄像头或屏幕共享，并等待画面加载后再点击“看这里”。');
      return;
    }
    try {
      const maxWidth = 960;
      const frame = captureRealtimeVideoFrame(video, options?.region, undefined, maxWidth);
      await sendFrame({
        imageDataUrl: frame.imageDataUrl,
        source,
        prompt: options?.prompt || (options?.region
          ? '请重点分析用户框选区域中的题目、公式、图表、作业或板书，并给出有证据的辅导建议。'
          : '请看这里，识别当前画面中的题目、公式、图表或板书，并结合本地知识库证据讲解。'),
        fast: options?.fast ?? true,
        ...(options?.region ? { region: options.region } : {}),
      });
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : '当前浏览器无法读取画面帧');
    }
  }, [cameraEnabled, screenEnabled, sendFrame]);

  return {
    status,
    session,
    error,
    evidence,
    transcript,
    toolQuery,
    cameraVideoRef,
    screenVideoRef,
    cameraEnabled,
    microphoneEnabled,
    screenEnabled,
    audioLevel,
    assistantSpeaking,
    speechCues,
    summary,
    retrievalProgress,
    setError,
    setToolQuery,
    start,
    end,
    endWithoutSummary,
    interruptAssistant,
    retrieveEvidence,
    toggleMic,
    toggleCamera,
    shareScreen,
    captureFrame,
    sendFrame,
  };
}

function waitForIceGatheringComplete(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, 2500);
    function done() {
      window.clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    }
    function onStateChange() {
      if (peer.iceGatheringState === 'complete') done();
    }
    peer.addEventListener('icegatheringstatechange', onStateChange);
  });
}

function encodePcm16Base64(input: Float32Array, inputSampleRate: number, targetSampleRate: number) {
  const resampled = resampleFloat32(input, inputSampleRate, targetSampleRate);
  if (!resampled.length) return '';
  const pcm = new Int16Array(resampled.length);
  for (let index = 0; index < resampled.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
}

function decodePcm16Base64(audioBase64: string) {
  if (!audioBase64) return new Int16Array();
  const binary = window.atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

function extractProviderSpeechCues(event: {
  viseme?: string;
  phoneme?: string;
  start_ms?: number;
  duration_ms?: number;
  visemes?: ProviderSpeechCueItem[];
  phonemes?: ProviderSpeechCueItem[];
}) {
  const nowMs = performance.now();
  const rawItems: ProviderSpeechCueItem[] = [
    ...(event.visemes || []),
    ...(event.phonemes || []),
    ...(event.viseme || event.phoneme ? [event] : []),
  ];

  return rawItems.flatMap((item, index): A3DigitalHumanSpeechCue[] => {
    const startOffsetMs = item.start_ms ?? item.startMs ?? index * 90;
    const durationMs = item.duration_ms ?? item.durationMs ?? 110;
    const viseme = normalizeProviderViseme(item.viseme);
    const cue: A3DigitalHumanSpeechCue = {
      id: `tts-cue-${Math.round(nowMs)}-${index}`,
      source: item.phoneme && !viseme ? 'tts_phoneme' : 'tts_viseme',
      startsAtMs: nowMs + Math.max(0, startOffsetMs),
      endsAtMs: nowMs + Math.max(0, startOffsetMs) + Math.max(40, durationMs),
      viseme,
      phoneme: item.phoneme,
      weights: item.weights,
      energy: 0.82,
    };
    return cue.viseme || cue.phoneme || cue.weights ? [cue] : [];
  });
}

function normalizeProviderViseme(value?: string): A3DigitalHumanSpeechViseme | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === 'aa' || normalized === 'ih' || normalized === 'ou' || normalized === 'ee' || normalized === 'oh') {
    return normalized;
  }
  return undefined;
}

function calculatePcm16Rms(input: Int16Array) {
  if (!input.length) return 0;
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index] / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / input.length);
}

function calculateRms(input: Float32Array) {
  if (!input.length) return 0;
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    sum += input[index] * input[index];
  }
  return Math.sqrt(sum / input.length);
}

function resampleFloat32(input: Float32Array, inputSampleRate: number, targetSampleRate: number) {
  if (!input.length) return input;
  if (inputSampleRate === targetSampleRate) return input;
  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}
