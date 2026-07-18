export const A3_TEACHER_MODEL_VERSION = '20260718-v1';
export const A3_TEACHER_MODEL_PATH = '/a3/assets/teacher-avatar/teacher.optimized.vrm';
export const A3_TEACHER_MODEL_URL = `${A3_TEACHER_MODEL_PATH}?v=${A3_TEACHER_MODEL_VERSION}`;

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
};

type DigitalHumanPreloaderDependencies = {
  loadStage: () => Promise<unknown>;
  fetchModel: () => Promise<unknown>;
};

export function shouldSkipDigitalHumanPreload(connection?: NetworkInformation | null) {
  return Boolean(
    connection?.saveData ||
    connection?.effectiveType === 'slow-2g' ||
    connection?.effectiveType === '2g',
  );
}

export function markDigitalHumanPerformance(name: string) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  performance.mark(name);
}

export function createDigitalHumanPreloader({
  loadStage,
  fetchModel,
}: DigitalHumanPreloaderDependencies) {
  let stagePromise: Promise<unknown> | null = null;
  let modelPromise: Promise<unknown> | null = null;

  return () => {
    stagePromise ??= loadStage().then((module) => {
      markDigitalHumanPerformance('a3-avatar-chunk-ready');
      return module;
    });
    modelPromise ??= fetchModel().then((response) => {
      markDigitalHumanPerformance('a3-avatar-model-response');
      return response;
    });
    return Promise.allSettled([stagePromise, modelPromise]);
  };
}

const preload = createDigitalHumanPreloader({
  loadStage: () => import('@/components/a3/features/coaching/digital-human-three-stage'),
  fetchModel: async () => {
    const response = await fetch(A3_TEACHER_MODEL_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Digital teacher preload failed (${response.status}).`);
    await response.arrayBuffer();
  },
});

export function preloadDigitalHumanAssets() {
  if (typeof window === 'undefined') return;
  const navigatorWithConnection = navigator as Navigator & {
    connection?: NetworkInformation;
  };
  if (shouldSkipDigitalHumanPreload(navigatorWithConnection.connection)) return;
  void preload();
}
