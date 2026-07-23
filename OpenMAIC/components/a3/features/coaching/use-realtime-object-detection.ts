'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { RealtimeObjectDetectionController } from '@/lib/a3/browser-vision/detector-controller';
import { createMediaPipeObjectDetectorAdapter } from '@/lib/a3/browser-vision/mediapipe-object-detector';
import type {
  BrowserDetectionCandidate,
  BrowserDetectionSource,
  BrowserDetectionState,
} from '@/lib/a3/browser-vision/detector-types';

type UseRealtimeObjectDetectionOptions = {
  enabled: boolean;
  active: boolean;
  source: BrowserDetectionSource | null;
  videoRef: RefObject<HTMLVideoElement | null> | null;
  locked: boolean;
};

const idleState: BrowserDetectionState = {
  status: 'idle',
  manualSelectionAvailable: true,
};

export function useRealtimeObjectDetection({
  enabled,
  active,
  source,
  videoRef,
  locked,
}: UseRealtimeObjectDetectionOptions) {
  const [state, setState] = useState<BrowserDetectionState>(idleState);
  const [result, setResult] = useState<{
    source: BrowserDetectionSource | null;
    candidates: BrowserDetectionCandidate[];
  }>({ source: null, candidates: [] });
  const contextRef = useRef({ active, source, videoRef, locked, hidden: false });

  useEffect(() => {
    contextRef.current = {
      ...contextRef.current,
      active,
      source,
      videoRef,
      locked,
    };
  }, [active, locked, source, videoRef]);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    const controller = new RealtimeObjectDetectionController(
      createMediaPipeObjectDetectorAdapter(),
      {
        fps: 3,
        minimumConfidence: 0.5,
        maxResults: 5,
        onCandidates: (candidates) => {
          if (!stopped) setResult({ source: contextRef.current.source, candidates });
        },
        onStateChange: (nextState) => {
          if (!stopped) setState(nextState);
        },
      },
    );
    const syncContext = () => {
      const current = contextRef.current;
      controller.setContext({
        active: current.active && Boolean(current.source),
        hidden: current.hidden,
        locked: current.locked,
      });
    };
    const handleVisibility = () => {
      contextRef.current.hidden = document.hidden;
      syncContext();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    syncContext();
    void controller.enable();

    const timer = window.setInterval(() => {
      if (stopped) return;
      const current = contextRef.current;
      syncContext();
      const video = current.videoRef?.current;
      if (!current.source || !video?.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      void controller.detect({
        source: current.source,
        video,
        width: video.videoWidth,
        height: video.videoHeight,
      }, performance.now());
    }, 100);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
      controller.dispose();
    };
  }, [enabled]);

  return {
    state: enabled ? state : idleState,
    candidates: enabled && result.source === source ? result.candidates : [],
  };
}
