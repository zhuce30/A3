import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

type WorkerRequest =
  | {
      type: 'load';
      assets: { modelUrl: string; wasmRoot: string };
    }
  | {
      type: 'detect';
      requestId: number;
      bitmap: ImageBitmap;
      width: number;
      height: number;
      timestampMs: number;
    }
  | { type: 'dispose' };

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

const workerScope = self as unknown as WorkerScope;
let detector: ObjectDetector | null = null;

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'load') {
    void loadDetector(message.assets);
    return;
  }
  if (message.type === 'dispose') {
    detector?.close();
    detector = null;
    return;
  }
  void detectFrame(message);
};

async function loadDetector(assets: { modelUrl: string; wasmRoot: string }) {
  try {
    const fileset = await FilesetResolver.forVisionTasks(assets.wasmRoot);
    const common = {
      runningMode: 'VIDEO' as const,
      scoreThreshold: 0.45,
      maxResults: 8,
      categoryAllowlist: ['person', 'book', 'laptop', 'cell phone', 'tv'],
    };
    try {
      detector = await ObjectDetector.createFromOptions(fileset, {
        ...common,
        baseOptions: { modelAssetPath: assets.modelUrl, delegate: 'GPU' },
      });
      workerScope.postMessage({ type: 'loaded', backend: 'mediapipe-gpu' });
    } catch {
      detector = await ObjectDetector.createFromOptions(fileset, {
        ...common,
        baseOptions: { modelAssetPath: assets.modelUrl, delegate: 'CPU' },
      });
      workerScope.postMessage({ type: 'loaded', backend: 'mediapipe-cpu' });
    }
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unable to load object detector',
    });
  }
}

async function detectFrame(message: Extract<WorkerRequest, { type: 'detect' }>) {
  try {
    if (!detector) throw new Error('Detector is not loaded');
    const result = detector.detectForVideo(message.bitmap, message.timestampMs);
    const candidates = (result.detections || []).flatMap((detection) => {
      const boundingBox = detection.boundingBox;
      const category = detection.categories?.[0];
      if (!boundingBox || !category?.categoryName || !Number.isFinite(category.score)) return [];
      return [{
        category: category.categoryName.toLowerCase(),
        confidence: category.score,
        region: {
          x: boundingBox.originX / message.width,
          y: boundingBox.originY / message.height,
          width: boundingBox.width / message.width,
          height: boundingBox.height / message.height,
        },
      }];
    });
    workerScope.postMessage({ type: 'result', requestId: message.requestId, candidates });
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : 'Object detection failed',
    });
  } finally {
    message.bitmap.close();
  }
}
