'use client';

import type { BrowserDetectionCandidate } from '@/lib/a3/browser-vision/detector-types';
import { normalizedRegionToViewportRect } from '@/lib/a3/realtime-media-focus';
import { cn } from '@/lib/utils';

type RealtimeDetectionOverlayProps = {
  candidates: BrowserDetectionCandidate[];
  selectedId: string | null;
  onSelect: (candidate: BrowserDetectionCandidate) => void;
  viewport: { width: number; height: number };
  sourceSize: { width: number; height: number };
  fit: 'cover' | 'contain';
  mirrored?: boolean;
};

export function RealtimeDetectionOverlay({
  candidates,
  selectedId,
  onSelect,
  viewport,
  sourceSize,
  fit,
  mirrored = false,
}: RealtimeDetectionOverlayProps) {
  return (
    <div data-testid="a3-realtime-detection-overlay" className="pointer-events-none absolute inset-0 z-30">
      {candidates.map((candidate) => {
        const box = normalizedRegionToViewportRect(candidate.region, {
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          fit,
          mirrored,
        });
        const style = box
          ? { left: box.x, top: box.y, width: box.width, height: box.height }
          : {
              left: `${candidate.region.x * 100}%`,
              top: `${candidate.region.y * 100}%`,
              width: `${candidate.region.width * 100}%`,
              height: `${candidate.region.height * 100}%`,
            };
        const selected = candidate.id === selectedId;
        return (
          <button
            key={candidate.id}
            type="button"
            data-testid={`a3-realtime-detection-${candidate.id}`}
            aria-pressed={selected}
            aria-label={`选择${candidate.label}`}
            onClick={() => onSelect(candidate)}
            className={cn(
              'pointer-events-auto absolute border-2 bg-transparent text-left transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200',
              selected
                ? 'border-amber-300 shadow-[0_0_0_3px_rgba(252,211,77,0.28)]'
                : 'border-emerald-300 hover:border-amber-300',
            )}
            style={style}
          >
            <span className={cn(
              'absolute -top-8 left-0 max-w-[220px] whitespace-nowrap rounded px-2 py-1 text-xs font-semibold shadow-sm',
              selected ? 'bg-amber-300 text-slate-950' : 'bg-emerald-600 text-white',
            )}>
              {candidate.label} · {Math.round(candidate.confidence * 100)}% · 本地识别
            </span>
          </button>
        );
      })}
    </div>
  );
}
