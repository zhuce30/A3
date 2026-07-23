import { detectDocumentRegions, preloadOpenCvDocumentDetector } from './opencv-document-detector';
import type {
  BrowserDetectionFrame,
  BrowserObjectDetectorAdapter,
  RawBrowserDetectionCandidate,
} from './detector-types';

type DetectorWorkerMessage =
  | { type: 'loaded'; backend: 'mediapipe-gpu' | 'mediapipe-cpu' }
  | { type: 'result'; requestId: number; candidates: RawBrowserDetectionCandidate[] }
  | { type: 'error'; requestId?: number; message: string };

type DetectorWorkerLike = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<DetectorWorkerMessage>) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent<DetectorWorkerMessage>) => void) => void;
  terminate: () => void;
};

type MediaPipeAdapterOptions = {
  createWorker?: () => DetectorWorkerLike;
  createBitmap?: (video: HTMLVideoElement, width: number, height: number) => Promise<ImageBitmap>;
  detectDocuments?: (video: HTMLVideoElement) => RawBrowserDetectionCandidate[];
};

export const A3_BROWSER_VISION_ASSETS = {
  modelUrl: '/models/a3-detection/efficientdet-lite0-int8-v1.tflite',
  wasmRoot: '/vendor/mediapipe/tasks-vision/0.10.35/wasm',
  workerUrl: '/vendor/a3-browser-vision/1.0.0/a3-object-detector.worker.js',
} as const;

type MediaPipeDetectionResultLike = {
  detections?: Array<{
    boundingBox?: { originX: number; originY: number; width: number; height: number };
    categories?: Array<{ categoryName?: string; score?: number }>;
  }>;
};

export function mapMediaPipeDetections(
  result: MediaPipeDetectionResultLike,
  frame: { width: number; height: number },
): RawBrowserDetectionCandidate[] {
  if (frame.width <= 0 || frame.height <= 0) return [];
  return (result.detections || []).flatMap((detection): RawBrowserDetectionCandidate[] => {
    const boundingBox = detection.boundingBox;
    const category = detection.categories?.[0];
    if (!boundingBox || !category?.categoryName || !Number.isFinite(category.score)) return [];
    return [{
      category: category.categoryName.toLowerCase(),
      confidence: category.score as number,
      region: {
        x: boundingBox.originX / frame.width,
        y: boundingBox.originY / frame.height,
        width: boundingBox.width / frame.width,
        height: boundingBox.height / frame.height,
      },
    }];
  });
}

export function computeDetectorFrameSize(width: number, height: number, maxEdge = 416) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function createMediaPipeObjectDetectorAdapter(
  options: MediaPipeAdapterOptions = {},
): BrowserObjectDetectorAdapter {
  let worker: DetectorWorkerLike | null = null;
  let loaded = false;
  let backend: 'mediapipe-gpu' | 'mediapipe-cpu' = 'mediapipe-cpu';
  let lastDocumentDetectionAt = Number.NEGATIVE_INFINITY;
  let nextRequestId = 1;
  let loadResolve: ((value: { backend: 'mediapipe-gpu' | 'mediapipe-cpu' }) => void) | null = null;
  let loadReject: ((reason: Error) => void) | null = null;
  const pending = new Map<number, {
    resolve: (candidates: RawBrowserDetectionCandidate[]) => void;
    reject: (reason: Error) => void;
  }>();

  const handleMessage = (event: MessageEvent<DetectorWorkerMessage>) => {
    const message = event.data;
    if (message.type === 'loaded') {
      loaded = true;
      backend = message.backend;
      loadResolve?.({ backend });
      loadResolve = null;
      loadReject = null;
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.message || 'Browser detector worker failed');
      if (message.requestId !== undefined) {
        pending.get(message.requestId)?.reject(error);
        pending.delete(message.requestId);
      } else {
        loadReject?.(error);
        loadResolve = null;
        loadReject = null;
      }
      return;
    }
    const request = pending.get(message.requestId);
    request?.resolve(message.candidates);
    pending.delete(message.requestId);
  };

  const ensureWorker = (): DetectorWorkerLike => {
    if (worker) return worker;
    const currentWorker = options.createWorker?.() ?? new Worker(
      A3_BROWSER_VISION_ASSETS.workerUrl,
      { name: 'a3-object-detector' },
    ) as unknown as DetectorWorkerLike;
    currentWorker.addEventListener('message', handleMessage);
    worker = currentWorker;
    return currentWorker;
  };

  const createBitmap = options.createBitmap ?? (async (video: HTMLVideoElement, width: number, height: number) => {
    return createImageBitmap(video, 0, 0, video.videoWidth, video.videoHeight, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'low',
    });
  });
  const detectDocuments = options.detectDocuments ?? detectDocumentRegions;

  return {
    async load() {
      if (loaded) return { backend };
      const currentWorker = ensureWorker();
      const loadPromise = new Promise<{ backend: 'mediapipe-gpu' | 'mediapipe-cpu' }>((resolve, reject) => {
        loadResolve = resolve;
        loadReject = reject;
      });
      currentWorker.postMessage({ type: 'load', assets: A3_BROWSER_VISION_ASSETS });
      if (!options.detectDocuments) void preloadOpenCvDocumentDetector().catch(() => undefined);
      return loadPromise;
    },

    async detect(frame: BrowserDetectionFrame, timestampMs: number) {
      if (!loaded) throw new Error('Detector is not loaded');
      const currentWorker = ensureWorker();
      const size = computeDetectorFrameSize(frame.width, frame.height);
      const bitmap = await createBitmap(frame.video, size.width, size.height);
      const requestId = nextRequestId++;
      const objectCandidates = new Promise<RawBrowserDetectionCandidate[]>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try {
          currentWorker.postMessage({
            type: 'detect',
            requestId,
            bitmap,
            width: bitmap.width,
            height: bitmap.height,
            timestampMs,
          }, [bitmap]);
        } catch (error) {
          pending.delete(requestId);
          bitmap.close();
          reject(error instanceof Error ? error : new Error('Unable to transfer detector frame'));
        }
      });
      const shouldDetectDocument = timestampMs - lastDocumentDetectionAt >= 1_000;
      const documentCandidates = shouldDetectDocument ? detectDocuments(frame.video) : [];
      if (shouldDetectDocument) lastDocumentDetectionAt = timestampMs;
      return [...await objectCandidates, ...documentCandidates];
    },

    dispose() {
      if (!worker) return;
      worker.removeEventListener('message', handleMessage);
      worker.postMessage({ type: 'dispose' });
      worker.terminate();
      worker = null;
      loaded = false;
      loadReject?.(new Error('Detector disposed'));
      loadResolve = null;
      loadReject = null;
      pending.forEach((request) => request.reject(new Error('Detector disposed')));
      pending.clear();
    },
  };
}
