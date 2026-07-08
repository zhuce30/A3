'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useCoachingMedia() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [starting, setStarting] = useState(false);

  const attachStream = useCallback((stream: MediaStream | null) => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, []);

  const startSession = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError('当前浏览器不支持摄像头和麦克风访问。');
      return false;
    }
    if (streamRef.current) return true;

    setStarting(true);
    setMediaError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      attachStream(stream);
      setSessionActive(true);
      setCameraEnabled(stream.getVideoTracks().some((track) => track.enabled));
      setMicrophoneEnabled(stream.getAudioTracks().some((track) => track.enabled));
      return true;
    } catch (error) {
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      setMediaError(denied ? '摄像头或麦克风权限被拒绝，请在浏览器地址栏重新授权。' : '无法启动音视频设备，请检查设备是否被其他程序占用。');
      return false;
    } finally {
      setStarting(false);
    }
  }, [attachStream]);

  const toggleCamera = useCallback(async () => {
    if (!streamRef.current && !(await startSession())) return;
    const tracks = streamRef.current?.getVideoTracks() ?? [];
    const nextEnabled = !tracks.some((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    setCameraEnabled(nextEnabled);
  }, [startSession]);

  const toggleMicrophone = useCallback(async () => {
    if (!streamRef.current && !(await startSession())) return;
    const tracks = streamRef.current?.getAudioTracks() ?? [];
    const nextEnabled = !tracks.some((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    setMicrophoneEnabled(nextEnabled);
  }, [startSession]);

  const endSession = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    attachStream(null);
    setSessionActive(false);
    setCameraEnabled(false);
    setMicrophoneEnabled(false);
  }, [attachStream]);

  useEffect(() => endSession, [endSession]);

  return {
    videoRef,
    sessionActive,
    cameraEnabled,
    microphoneEnabled,
    mediaError,
    starting,
    startSession,
    toggleCamera,
    toggleMicrophone,
    endSession,
  };
}
