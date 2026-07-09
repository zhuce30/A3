'use client';

import { useCallback, useRef, useState } from 'react';
import type {
  A3RealtimeCoachingSession,
  A3RealtimeEvidence,
  A3RealtimeFramePayload,
  A3RealtimeStatus,
  A3RealtimeTranscriptEvent,
} from '@/lib/a3/realtime-coaching-types';

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

export function useRealtimeCoaching() {
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
  const [summary, setSummary] = useState<RealtimeSummary | null>(null);
  const [retrievalProgress, setRetrievalProgress] = useState<RetrievalProgress>({
    status: 'idle',
    message: '等待检索本地资料',
  });
  const coachingSessionId = session?.coachingSessionId;
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSilenceGainRef = useRef<GainNode | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const activePlaybackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const audioSequenceRef = useRef(0);
  const audioStreamingRef = useRef(false);
  const audioSpeechActiveRef = useRef(false);
  const audioSilenceChunksRef = useRef(0);
  const pendingSpeechCommitRef = useRef(false);
  const speechCommitTimerRef = useRef<number | null>(null);
  const lastAudioLevelUpdateRef = useRef(0);

  const attachCameraStream = useCallback(() => {
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = cameraStreamRef.current;
  }, []);

  const attachScreenStream = useCallback(() => {
    if (screenVideoRef.current) screenVideoRef.current.srcObject = screenStreamRef.current;
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
    setAssistantSpeaking(true);
    source.onended = () => {
      activePlaybackSourcesRef.current.delete(source);
      if (!activePlaybackSourcesRef.current.size) setAssistantSpeaking(false);
    };
    const startAt = Math.max(audioContext.currentTime + 0.02, playbackCursorRef.current);
    source.start(startAt);
    playbackCursorRef.current = startAt + audioBuffer.duration;
  }, []);

  const stopRealtimePlayback = useCallback(() => {
    activePlaybackSourcesRef.current.forEach((source) => {
      try {
        source.stop(0);
      } catch {
        // Source may already have ended.
      }
    });
    activePlaybackSourcesRef.current.clear();
    playbackCursorRef.current = 0;
    setAssistantSpeaking(false);
  }, []);

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
      };
      const eventType = event.type || '';
      if (eventType === 'input_audio_buffer.committed' || eventType === 'response.created') {
        markProviderAudioCommitted();
      }
      const audioDelta = eventType.includes('audio.delta') ? event.delta || event.audio || '' : '';
      if (audioDelta) playRealtimeAudioDelta(audioDelta);
      const itemTranscript = event.item?.content?.map((item) => item.transcript || item.text || '').join('');
      const content = event.transcript || event.text || event.response?.output_text || event.delta || itemTranscript || '';
      if (!content || eventType.includes('audio.delta')) return;
      const role = eventType.includes('input') || eventType.includes('user') ? 'user' : 'assistant';
      appendTranscriptEvent(role, content, !eventType.includes('delta'));
    } catch {
      // Ignore non-JSON provider events.
    }
  }, [appendTranscriptEvent, markProviderAudioCommitted, playRealtimeAudioDelta]);

  const ensureAudioStream = useCallback(async () => {
    if (!cameraStreamRef.current || cameraStreamRef.current.getAudioTracks().length === 0) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: cameraEnabled });
      attachCameraStream();
    }
    setMicrophoneEnabled(true);
    return cameraStreamRef.current;
  }, [attachCameraStream, cameraEnabled]);

  const exchangePeerSdp = useCallback(async (peer: RTCPeerConnection, realtime: A3RealtimeCoachingSession) => {
    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await peer.setLocalDescription(offer);
    await waitForIceGatheringComplete(peer);
    const response = await fetch(realtime.connection.connectionUrl || '/api/a3/coaching/realtime/sdp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: realtime.provider,
        model: realtime.model,
        offerSdp: peer.localDescription?.sdp || offer.sdp,
      }),
    });
    const result = await response.json().catch(() => ({})) as SdpResponse;
    if (!response.ok || !result.success || !result.answerSdp) {
      throw new Error(result.error || '实时 provider SDP 交换失败，已降级到录音/文字辅导。');
    }
    await peer.setRemoteDescription({ type: 'answer', sdp: result.answerSdp });
  }, []);

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

  const connectRealtimePeer = useCallback(async (realtime: A3RealtimeCoachingSession) => {
    try {
      if (!('RTCPeerConnection' in window)) {
        setError('当前浏览器不支持 WebRTC 实时通话');
        return false;
      }
      const audioStream = await ensureAudioStream();
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      audioStream.getAudioTracks().forEach((track) => peer.addTrack(track, audioStream));
      const activeVideo = getActiveVideoTrack();
      if (activeVideo?.track && activeVideo.stream) {
        videoSenderRef.current = peer.addTrack(activeVideo.track, activeVideo.stream);
      }
      peer.ontrack = (event) => {
        const audio = remoteAudioRef.current || document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = event.streams[0];
        if (!remoteAudioRef.current) {
          audio.style.display = 'none';
          document.body.appendChild(audio);
          remoteAudioRef.current = audio;
        }
      };
      const dataChannel = peer.createDataChannel('a3-realtime-events');
      dataChannelRef.current = dataChannel;
      dataChannel.onmessage = (event) => handleRealtimeEvent(event.data);
      await exchangePeerSdp(peer, realtime);
      return true;
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : '实时 WebRTC 连接失败，已降级到录音/文字辅导。');
      peerRef.current?.close();
      peerRef.current = null;
      videoSenderRef.current = null;
      return false;
    }
  }, [ensureAudioStream, exchangePeerSdp, getActiveVideoTrack, handleRealtimeEvent]);

  const stopDashScopeAudioStreaming = useCallback(() => {
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
    setAssistantSpeaking(false);
    setAudioLevel(0);
  }, [clearManualAudioCommitTimer]);

  const startDashScopeAudioStreaming = useCallback(async (socket: WebSocket) => {
    if (audioStreamingRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持麦克风访问');
      return false;
    }
    const stream = await ensureAudioStream();
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
  }, [clearManualAudioCommitTimer, ensureAudioStream, scheduleManualAudioCommit]);

  const connectRealtimeWebSocket = useCallback(async (realtime: A3RealtimeCoachingSession) => {
    return new Promise<boolean>((resolve) => {
      try {
        const connectionUrl = realtime.connection.connectionUrl;
        if (!connectionUrl) {
          setError('实时 WebSocket proxy 地址未配置，已降级到录音/文字辅导。');
          resolve(false);
          return;
        }
        const socket = new WebSocket(connectionUrl);
        websocketRef.current = socket;
        const timeout = window.setTimeout(() => {
          setError('实时 WebSocket proxy 连接超时，已降级到录音/文字辅导。');
          socket.close();
          resolve(false);
        }, 8000);
        socket.onopen = async () => {
          window.clearTimeout(timeout);
          const audioStarted = await startDashScopeAudioStreaming(socket).catch((audioError) => {
            setError(audioError instanceof Error ? audioError.message : '麦克风实时音频采集失败');
            return false;
          });
          if (!audioStarted) {
            socket.close();
            resolve(false);
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
          resolve(true);
        };
        socket.onmessage = (event) => {
          handleRealtimeEvent(typeof event.data === 'string' ? event.data : '');
        };
        socket.onerror = () => {
          window.clearTimeout(timeout);
          stopDashScopeAudioStreaming();
          setError('实时 WebSocket proxy 连接失败，请确认 pnpm realtime:dashscope-proxy 已启动。');
          resolve(false);
        };
        socket.onclose = () => {
          stopDashScopeAudioStreaming();
          websocketRef.current = null;
        };
      } catch (connectError) {
        setError(connectError instanceof Error ? connectError.message : '实时 WebSocket proxy 连接失败，已降级到录音/文字辅导。');
        resolve(false);
      }
    });
  }, [handleRealtimeEvent, startDashScopeAudioStreaming, stopDashScopeAudioStreaming]);

  const start = useCallback(async () => {
    setStatus('connecting');
    setError('');
    setSummary(null);
    const response = await fetch('/api/a3/coaching/realtime/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'voice_video' }),
    });
    const result = await response.json().catch(() => ({})) as A3RealtimeCoachingSession;
    if (!response.ok || !result.success) {
      setStatus('error');
      setError(result.error || '实时面对面辅导会话创建失败');
      return;
    }
    setSession(result);
    await fetch('/api/a3/coaching/realtime/message', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
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
    }).catch(() => undefined);
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
      ? await connectRealtimeWebSocket(result)
      : await connectRealtimePeer(result);
    setStatus(connected ? 'live' : 'degraded');
  }, [connectRealtimePeer, connectRealtimeWebSocket]);

  const stopMediaTracks = useCallback(() => {
    stopRealtimePlayback();
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    peerRef.current?.close();
    websocketRef.current?.close();
    stopDashScopeAudioStreaming();
    remoteAudioRef.current?.remove();
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    peerRef.current = null;
    websocketRef.current = null;
    videoSenderRef.current = null;
    dataChannelRef.current = null;
    remoteAudioRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    setCameraEnabled(false);
    setMicrophoneEnabled(false);
    setScreenEnabled(false);
  }, [stopDashScopeAudioStreaming, stopRealtimePlayback]);

  const persistRealtimeTranscript = useCallback(async () => {
    if (!session?.coachingSessionId) return;
    const messages = transcript
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
            provider: session.provider,
            model: session.model,
            coachingSessionId: session.coachingSessionId,
          },
        },
      }));
    if (!messages.length) return;
    await fetch('/api/a3/coaching/realtime/message', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        summary: `${session.instructions.targetTitle}：实时辅导进行中`,
      }),
    }).catch(() => undefined);
  }, [session, transcript]);

  const end = useCallback(async () => {
    setStatus('ending');
    sendRealtimeCancel();
    await persistRealtimeTranscript();
    stopMediaTracks();
    if (session?.coachingSessionId) {
      const response = await fetch('/api/a3/coaching/realtime/end', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coachingSessionId: session.coachingSessionId }),
      }).catch(() => null);
      const result = response ? await response.json().catch(() => ({})) as EndResponse : null;
      if (response?.ok && result?.success && result.summary) {
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
      } else if (result?.error) {
        setError(result.error);
      }
    }
    setStatus('ended');
  }, [persistRealtimeTranscript, sendRealtimeCancel, session, stopMediaTracks]);

  const endWithoutSummary = useCallback(() => {
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
      attachScreenStream();
      setScreenEnabled(true);
      await syncOutgoingVideoTrack();
    } catch {
      setError('屏幕共享被取消或浏览器权限不可用。');
    }
  }, [attachScreenStream, syncOutgoingVideoTrack]);

  const sendFrame = useCallback(async (payload: Omit<A3RealtimeFramePayload, 'coachingSessionId'>) => {
    if (!session?.coachingSessionId) {
      setError('请先开始实时辅导会话');
      return;
    }
    setStatus('visual_focus');
    const response = await fetch('/api/a3/coaching/realtime/frame', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, coachingSessionId: session.coachingSessionId }),
    });
    const result = await response.json().catch(() => ({})) as FrameResponse;
    if (!response.ok || !result.success) {
      setError(result.error || '实时视觉帧理解失败');
      setStatus('degraded');
      return;
    }
    setEvidence(result.citations || []);
    if (result.reply) {
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
      ]);
    }
    setStatus(session.connection.readyForBrowserMedia ? 'live' : 'degraded');
  }, [session]);

  const captureFrame = useCallback(async () => {
    const screenVideo = screenEnabled ? screenVideoRef.current : null;
    const cameraVideo = cameraEnabled ? cameraVideoRef.current : null;
    const video = screenVideo && screenVideo.videoWidth ? screenVideo : cameraVideo;
    const source = screenVideo && screenVideo.videoWidth ? 'screen' : 'camera';
    if (!video || !video.videoWidth || !video.videoHeight) {
      setError('请先开启摄像头或屏幕共享，并等待画面加载后再点击“看这里”。');
      return;
    }
    const canvas = document.createElement('canvas');
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      setError('当前浏览器无法读取画面帧');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    await sendFrame({
      imageDataUrl: canvas.toDataURL('image/jpeg', 0.82),
      source,
      prompt: '请看这里，识别当前画面中的题目、公式、图表或板书，并结合本地知识库证据讲解。',
    });
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
