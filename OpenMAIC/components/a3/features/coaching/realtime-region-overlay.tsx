'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  clientPointToNormalizedRegionPoint,
  normalizedDragRegion,
  normalizedRegionToViewportRect,
  type MediaPoint,
  type NormalizedMediaRegion,
} from '@/lib/a3/realtime-media-focus';
import type { BrowserDetectionCandidate } from '@/lib/a3/browser-vision/detector-types';
import { RealtimeDetectionOverlay } from './realtime-detection-overlay';

type RealtimeRegionOverlayProps = {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  region: NormalizedMediaRegion | null;
  onChange: (region: NormalizedMediaRegion | null) => void;
  fit: 'cover' | 'contain';
  mirrored?: boolean;
  detectionCandidates?: BrowserDetectionCandidate[];
  selectedDetectionId?: string | null;
  onDetectionSelect?: (candidate: BrowserDetectionCandidate) => void;
};

export function RealtimeRegionOverlay({
  enabled,
  videoRef,
  region,
  onChange,
  fit,
  mirrored = false,
  detectionCandidates = [],
  selectedDetectionId = null,
  onDetectionSelect = () => undefined,
}: RealtimeRegionOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<MediaPoint | null>(null);
  const [draft, setDraft] = useState<NormalizedMediaRegion | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      setViewport({ width: root.clientWidth, height: root.clientHeight });
      const video = videoRef.current;
      setSourceSize({ width: video?.videoWidth || 0, height: video?.videoHeight || 0 });
    };
    const video = videoRef.current;
    const frame = window.requestAnimationFrame(update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(root);
    window.addEventListener('resize', update);
    video?.addEventListener('loadedmetadata', update);
    video?.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      video?.removeEventListener('loadedmetadata', update);
      video?.removeEventListener('resize', update);
    };
  }, [videoRef]);

  const toNormalizedPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const video = videoRef.current;
    if (!root || !video?.videoWidth || !video.videoHeight) return null;
    const rect = root.getBoundingClientRect();
    return clientPointToNormalizedRegionPoint(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      {
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        fit,
        mirrored,
      },
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0) return;
    const point = toNormalizedPoint(event);
    if (!point) return;
    dragStartRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft(null);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const point = toNormalizedPoint(event);
    if (point) setDraft(normalizedDragRegion(start, point));
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const point = toNormalizedPoint(event);
    const next = point ? normalizedDragRegion(start, point) : draft;
    setDraft(null);
    if (next) onChange(next);
  };

  const visibleRegion = draft || region;
  const box = visibleRegion && sourceSize.width && sourceSize.height
    ? normalizedRegionToViewportRect(visibleRegion, {
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        fit,
        mirrored,
      })
    : null;

  return (
    <>
      <RealtimeDetectionOverlay
        candidates={enabled ? [] : detectionCandidates}
        selectedId={selectedDetectionId}
        onSelect={onDetectionSelect}
        viewport={viewport}
        sourceSize={sourceSize}
        fit={fit}
        mirrored={mirrored}
      />
      <div
      ref={rootRef}
      data-testid="a3-realtime-region-overlay"
      aria-label="在画面中拖动框选分析区域"
      role="application"
      className={enabled ? 'absolute inset-0 z-20 cursor-crosshair touch-none' : 'pointer-events-none absolute inset-0 z-20'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={() => {
        dragStartRef.current = null;
        setDraft(null);
      }}
    >
      {box ? (
        <div
          data-testid="a3-realtime-selected-region"
          className="pointer-events-none absolute border-2 border-amber-300 bg-amber-300/12 shadow-[0_0_0_9999px_rgba(2,6,23,0.38)]"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        >
          <span className="absolute -top-7 left-0 rounded bg-amber-300 px-2 py-1 text-xs font-semibold text-slate-950">
            分析区域
          </span>
        </div>
      ) : null}
      </div>
    </>
  );
}
