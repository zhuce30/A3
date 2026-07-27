'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  A3TutorPersonaId,
  A3TutorVoicePreviewState,
} from '@/lib/a3/tutor-persona-types';

const IDLE_STATE: A3TutorVoicePreviewState = {
  personaId: null,
  status: 'idle',
  error: '',
};
const FALLBACK_ERROR = '音色试听失败，请稍后重试';
const PLAYBACK_ERROR = '音频播放失败，请重试';
const SENSITIVE_ERROR_PATTERN = /api[\s_-]*key|bearer|secret|token|https?:\/\/|[a-z]:\\|\/app\/|traceback/i;

export function useTutorVoicePreview() {
  const [state, setState] = useState<A3TutorVoicePreviewState>(IDLE_STATE);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const activePersonaRef = useRef<A3TutorPersonaId | null>(null);
  const requestVersionRef = useRef(0);

  const releaseResources = useCallback(() => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();

    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }

    const objectUrl = objectUrlRef.current;
    objectUrlRef.current = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, []);

  const stopPreview = useCallback(() => {
    requestVersionRef.current += 1;
    activePersonaRef.current = null;
    releaseResources();
    setState(IDLE_STATE);
  }, [releaseResources]);

  const togglePreview = useCallback(async (personaId: A3TutorPersonaId) => {
    if (activePersonaRef.current === personaId) {
      stopPreview();
      return;
    }

    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    releaseResources();
    activePersonaRef.current = personaId;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ personaId, status: 'loading', error: '' });

    const isCurrent = () => (
      requestVersionRef.current === requestVersion
      && activePersonaRef.current === personaId
    );
    let playbackPhase = false;

    try {
      const response = await fetch('/api/a3/tutors/voice-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personaId }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(await readSafeResponseError(response));

      const blob = await response.blob();
      if (!isCurrent()) return;
      abortRef.current = null;

      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      playbackPhase = true;
      const audio = new Audio(objectUrl);
      audioRef.current = audio;

      const finishPlayback = (nextState: A3TutorVoicePreviewState) => {
        if (!isCurrent()) return;
        requestVersionRef.current += 1;
        activePersonaRef.current = null;
        releaseResources();
        setState(nextState);
      };
      audio.onended = () => finishPlayback(IDLE_STATE);
      audio.onerror = () => finishPlayback({
        personaId,
        status: 'error',
        error: PLAYBACK_ERROR,
      });

      await audio.play();
      if (isCurrent()) setState({ personaId, status: 'playing', error: '' });
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) return;
      requestVersionRef.current += 1;
      activePersonaRef.current = null;
      releaseResources();
      setState({
        personaId,
        status: 'error',
        error: playbackPhase ? PLAYBACK_ERROR : safeErrorMessage(error),
      });
    }
  }, [releaseResources, stopPreview]);

  useEffect(() => () => {
    requestVersionRef.current += 1;
    activePersonaRef.current = null;
    releaseResources();
  }, [releaseResources]);

  return { state, togglePreview, stopPreview };
}

async function readSafeResponseError(response: Response) {
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('application/json')) return FALLBACK_ERROR;
  try {
    const body = await response.json() as { error?: unknown };
    return sanitizeServerError(body?.error);
  } catch {
    return FALLBACK_ERROR;
  }
}

function sanitizeServerError(value: unknown) {
  if (typeof value !== 'string') return FALLBACK_ERROR;
  const message = value.replace(/\s+/g, ' ').trim();
  if (!message || message.length > 80 || SENSITIVE_ERROR_PATTERN.test(message)) {
    return FALLBACK_ERROR;
  }
  return message;
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return sanitizeServerError(error.message);
  return FALLBACK_ERROR;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}
