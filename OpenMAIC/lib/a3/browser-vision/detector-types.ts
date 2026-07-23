import type { NormalizedMediaRegion } from '../realtime-media-focus';

export type BrowserDetectionSource = 'camera' | 'screen';
export type BrowserDetectionBackend = 'mediapipe-gpu' | 'mediapipe-cpu';

export type BrowserDetectionFrame = {
  source: BrowserDetectionSource;
  video: HTMLVideoElement;
  width: number;
  height: number;
};

export type RawBrowserDetectionCandidate = {
  category: string;
  confidence: number;
  region: Pick<NormalizedMediaRegion, 'x' | 'y' | 'width' | 'height'>;
  method?: 'object_detection' | 'document_proposal';
};

export type BrowserDetectionCandidate = {
  id: string;
  category: string;
  label: string;
  confidence: number;
  method: 'object_detection' | 'document_proposal';
  region: NormalizedMediaRegion;
};

export type BrowserObjectDetectorAdapter = {
  load: () => Promise<{ backend: BrowserDetectionBackend }>;
  detect: (frame: BrowserDetectionFrame, timestampMs: number) => Promise<RawBrowserDetectionCandidate[]>;
  dispose: () => void;
};

export type BrowserDetectionState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  backend?: BrowserDetectionBackend;
  error?: string;
  manualSelectionAvailable: true;
};

export type BrowserDetectionResult = {
  accepted: boolean;
  reason?: 'not_ready' | 'in_flight' | 'throttled' | 'inactive' | 'hidden' | 'locked' | 'failed';
  candidates: BrowserDetectionCandidate[];
};
