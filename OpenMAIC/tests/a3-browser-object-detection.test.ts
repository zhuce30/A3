import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeObjectDetectionController,
  normalizeDetectionFps,
  sanitizeDetectionCandidates,
} from '@/lib/a3/browser-vision/detector-controller';
import {
  buildDocumentProposals,
  type DocumentContourCandidate,
} from '@/lib/a3/browser-vision/document-proposals';
import {
  A3_BROWSER_VISION_ASSETS,
  computeDetectorFrameSize,
  createMediaPipeObjectDetectorAdapter,
  mapMediaPipeDetections,
} from '@/lib/a3/browser-vision/mediapipe-object-detector';
import type {
  BrowserDetectionFrame,
  BrowserObjectDetectorAdapter,
  RawBrowserDetectionCandidate,
} from '@/lib/a3/browser-vision/detector-types';

function createFrame(source: 'camera' | 'screen' = 'camera'): BrowserDetectionFrame {
  return {
    source,
    video: {} as HTMLVideoElement,
    width: 640,
    height: 360,
  };
}

function createAdapter(detect: BrowserObjectDetectorAdapter['detect'] = vi.fn().mockResolvedValue([])) {
  return {
    load: vi.fn().mockResolvedValue({ backend: 'mediapipe-cpu' as const }),
    detect,
    dispose: vi.fn(),
  } satisfies BrowserObjectDetectorAdapter;
}

describe('A3 browser object detection controller', () => {
  it('does not load the detector before the user enables it', async () => {
    const adapter = createAdapter();
    const controller = new RealtimeObjectDetectionController(adapter);

    expect(controller.getState().status).toBe('idle');
    expect(adapter.load).not.toHaveBeenCalled();

    await controller.enable();

    expect(adapter.load).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ status: 'ready', backend: 'mediapipe-cpu' });
  });

  it('caps detection at five FPS and drops frames while inference is running', async () => {
    let resolveDetection: ((value: RawBrowserDetectionCandidate[]) => void) | undefined;
    const detect = vi.fn().mockImplementation(() => new Promise<RawBrowserDetectionCandidate[]>((resolve) => {
      resolveDetection = resolve;
    }));
    const adapter = createAdapter(detect);
    const controller = new RealtimeObjectDetectionController(adapter, { fps: 30 });
    await controller.enable();

    const first = controller.detect(createFrame(), 1_000);
    const overlapping = await controller.detect(createFrame(), 1_250);

    expect(normalizeDetectionFps(30)).toBe(5);
    expect(overlapping).toEqual({ accepted: false, reason: 'in_flight', candidates: [] });
    expect(detect).toHaveBeenCalledTimes(1);

    resolveDetection?.([]);
    await first;
    const tooSoon = await controller.detect(createFrame(), 1_100);
    const accepted = controller.detect(createFrame(), 1_250);

    expect(tooSoon).toEqual({ accepted: false, reason: 'throttled', candidates: [] });
    expect(detect).toHaveBeenCalledTimes(2);
    resolveDetection?.([]);
    await accepted;
  });

  it('stops on hidden pages, focus exit, locked selection and disposal', async () => {
    const adapter = createAdapter();
    const controller = new RealtimeObjectDetectionController(adapter);
    await controller.enable();

    controller.setContext({ active: false, hidden: false, locked: false });
    expect(await controller.detect(createFrame(), 1_000)).toMatchObject({ accepted: false, reason: 'inactive' });
    controller.setContext({ active: true, hidden: true, locked: false });
    expect(await controller.detect(createFrame(), 1_500)).toMatchObject({ accepted: false, reason: 'hidden' });
    controller.setContext({ active: true, hidden: false, locked: true });
    expect(await controller.detect(createFrame(), 2_000)).toMatchObject({ accepted: false, reason: 'locked' });

    controller.dispose();

    expect(adapter.dispose).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe('idle');
  });

  it('filters unsupported classes and preserves conservative labels', () => {
    const candidates = sanitizeDetectionCandidates([
      { category: 'person', confidence: 0.92, region: { x: -0.1, y: 0.1, width: 0.45, height: 0.7 } },
      { category: 'book', confidence: 0.83, region: { x: 0.45, y: 0.35, width: 0.35, height: 0.4 } },
      { category: 'dog', confidence: 0.99, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      { category: 'cell phone', confidence: 0.2, region: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } },
    ], { minimumConfidence: 0.5, maxResults: 4 });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ label: '人物', method: 'object_detection', confidence: 0.92 });
    expect(candidates[0].region).toEqual({ x: 0, y: 0.1, width: 0.35, height: 0.7, label: '人物', confidence: 0.92, method: 'object_detection' });
    expect(candidates[1]).toMatchObject({ label: '书本或学习资料' });
  });

  it('enters an explicit error state without disabling manual selection', async () => {
    const adapter = createAdapter();
    adapter.load.mockRejectedValueOnce(new Error('model unavailable'));
    const controller = new RealtimeObjectDetectionController(adapter);

    await expect(controller.enable()).resolves.toBe(false);

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: '自动识别暂不可用，请使用手动画框。',
      manualSelectionAvailable: true,
    });
  });
});

describe('A3 document proposals', () => {
  it('turns a large convex quadrilateral into a conservative document proposal', () => {
    const contours: DocumentContourCandidate[] = [
      { x: 120, y: 60, width: 360, height: 240, area: 80_000, convex: true, vertices: 4 },
      { x: 4, y: 4, width: 20, height: 10, area: 150, convex: true, vertices: 4 },
    ];

    expect(buildDocumentProposals(contours, { width: 640, height: 360 })).toEqual([
      expect.objectContaining({
        label: '可能的文档区域',
        method: 'document_proposal',
        region: expect.objectContaining({ x: 0.1875, y: 0.166667, width: 0.5625, height: 0.666667 }),
      }),
    ]);
  });
});

describe('A3 MediaPipe adapter mapping', () => {
  it('uses immutable same-origin assets and maps pixel boxes to normalized candidates', () => {
    expect(A3_BROWSER_VISION_ASSETS.modelUrl).toMatch(/^\/models\/a3-detection\/efficientdet-lite0-int8-v1\.tflite$/);
    expect(A3_BROWSER_VISION_ASSETS.wasmRoot).toBe('/vendor/mediapipe/tasks-vision/0.10.35/wasm');
    expect(A3_BROWSER_VISION_ASSETS.workerUrl).toBe('/vendor/a3-browser-vision/1.0.0/a3-object-detector.worker.js');
    expect(mapMediaPipeDetections({
      detections: [{
        boundingBox: { originX: 64, originY: 36, width: 320, height: 180 },
        categories: [{ categoryName: 'person', score: 0.91 }],
      }],
    }, { width: 640, height: 360 })).toEqual([
      {
        category: 'person',
        confidence: 0.91,
        region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      },
    ]);
  });

  it('downscales large media frames without upscaling small ones', () => {
    expect(computeDetectorFrameSize(1920, 1080)).toEqual({ width: 416, height: 234 });
    expect(computeDetectorFrameSize(320, 180)).toEqual({ width: 320, height: 180 });
  });

  it('runs model inference through a transferable worker protocol', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const worker = {
      postMessage: vi.fn((rawMessage: unknown) => {
        const message = rawMessage as { type: string; requestId?: number };
        queueMicrotask(() => {
          const data = message.type === 'load'
            ? { type: 'loaded', backend: 'mediapipe-cpu' }
            : {
                type: 'result',
                requestId: message.requestId,
                candidates: [{
                  category: 'person',
                  confidence: 0.9,
                  region: { x: 0.1, y: 0.1, width: 0.4, height: 0.8 },
                }],
              };
          listeners.get('message')?.forEach((listener) => listener({ data } as MessageEvent));
        });
      }),
      addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
        const handlers = listeners.get(type) ?? new Set();
        handlers.add(listener);
        listeners.set(type, handlers);
      }),
      removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => listeners.get(type)?.delete(listener)),
      terminate: vi.fn(),
    };
    const bitmap = { width: 320, height: 180, close: vi.fn() } as unknown as ImageBitmap;
    const adapter = createMediaPipeObjectDetectorAdapter({
      createWorker: () => worker,
      createBitmap: vi.fn().mockResolvedValue(bitmap),
      detectDocuments: () => [],
    });

    await expect(adapter.load()).resolves.toEqual({ backend: 'mediapipe-cpu' });
    await expect(adapter.detect(createFrame(), 1_000)).resolves.toEqual([
      expect.objectContaining({ category: 'person', confidence: 0.9 }),
    ]);
    adapter.dispose();

    expect(worker.postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'load' }));
    expect(worker.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'detect', bitmap, width: 320, height: 180 }),
      [bitmap],
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects model loading when the worker crashes', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const worker = createEventWorker(listeners);
    const adapter = createMediaPipeObjectDetectorAdapter({
      createWorker: () => worker,
      detectDocuments: () => [],
      loadTimeoutMs: 30_000,
    });

    const loading = adapter.load();
    listeners.get('error')?.forEach((listener) => listener({
      message: 'worker bootstrap failed',
      preventDefault: vi.fn(),
    } as unknown as Event));

    await expect(loading).rejects.toThrow('worker bootstrap failed');
    adapter.dispose();
  });

  it('times out model loading instead of remaining pending forever', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const worker = createEventWorker(listeners);
    const adapter = createMediaPipeObjectDetectorAdapter({
      createWorker: () => worker,
      detectDocuments: () => [],
      loadTimeoutMs: 25_000,
    });

    const loading = adapter.load();
    const rejection = expect(loading).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25_000);

    await rejection;
    adapter.dispose();
    vi.useRealTimers();
  });
});

function createEventWorker(listeners: Map<string, Set<(event: Event) => void>>) {
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    terminate: vi.fn(),
  };
}
