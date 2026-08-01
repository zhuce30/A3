import type {
  PageReplacementAlgorithm,
  PageReplacementInput,
  SimulationRun,
  SimulationStep,
} from './contracts';
import { validatePageReplacementInput } from './validators';

export interface PageReplacementState {
  referenceIndex: number;
  currentPage: number;
  frames: Array<number | null>;
  hit: boolean;
  evictedPage: number | null;
  fifoQueue: number[];
  recentUseOrder: number[];
  nextUseByPage: Record<string, number | null>;
}

export interface PageReplacementMetrics {
  pageFaults: number;
  hits: number;
  faultRate: number;
  evictions: number;
  finalFrames: Array<number | null>;
}

const PAGE_ALGORITHMS: readonly PageReplacementAlgorithm[] = ['fifo', 'lru', 'opt'];

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const roundToTwo = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const fingerprintDigest = (value: string): string => {
  const states = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const multipliers = [0x01000193, 0x27d4eb2d, 0x165667b1, 0x85ebca77];

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let lane = 0; lane < states.length; lane += 1) {
      states[lane] ^= code + Math.imul(index + 1, lane + 1);
      states[lane] = Math.imul(states[lane], multipliers[lane]);
      states[lane] ^= states[lane] >>> (11 + lane);
    }
  }

  return states
    .map((state, lane) => {
      let mixed = state ^ (value.length + lane);
      mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b);
      mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);
      mixed ^= mixed >>> 16;
      return (mixed >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
};

const nextUse = (references: number[], page: number, fromIndex: number): number | null => {
  const nextIndex = references.indexOf(page, fromIndex);
  return nextIndex === -1 ? null : nextIndex;
};

const createNextUseByPage = (
  references: number[],
  currentIndex: number,
  frames: Array<number | null>,
): Record<string, number | null> => {
  const pages = frames.filter((page): page is number => page !== null);
  return Object.fromEntries(
    pages.map((page) => [String(page), nextUse(references, page, currentIndex + 1)]),
  );
};

const createFingerprint = (
  input: PageReplacementInput,
  algorithm: PageReplacementAlgorithm,
  steps: Array<SimulationStep<PageReplacementState, PageReplacementMetrics>>,
  metrics: PageReplacementMetrics,
): string => {
  const canonicalResult = {
    algorithm,
    input: { referenceString: [...input.referenceString], frameCount: input.frameCount },
    events: steps.map((step) => ({
      index: step.state.referenceIndex,
      page: step.state.currentPage,
      frames: step.state.frames,
      hit: step.state.hit,
      evictedPage: step.state.evictedPage,
      fifoQueue: step.state.fifoQueue,
      recentUseOrder: step.state.recentUseOrder,
      nextUseByPage: step.state.nextUseByPage,
    })),
    finalMetrics: metrics,
  };
  return `page:${fingerprintDigest(JSON.stringify(canonicalResult))}`;
};

export function simulatePageReplacement(
  input: PageReplacementInput,
  algorithm: PageReplacementAlgorithm,
): SimulationRun<PageReplacementState, PageReplacementMetrics> {
  const validation = validatePageReplacementInput(input);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  if (!PAGE_ALGORITHMS.includes(algorithm)) {
    throw new Error(`Unsupported page replacement algorithm: ${String(algorithm)}`);
  }

  const references = [...input.referenceString];
  const frames: Array<number | null> = Array(input.frameCount).fill(null);
  const fifoQueue: number[] = [];
  const recentUseOrder: number[] = [];
  const steps: Array<SimulationStep<PageReplacementState, PageReplacementMetrics>> = [];
  let pageFaults = 0;
  let hits = 0;
  let evictions = 0;

  for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex += 1) {
    const currentPage = references[referenceIndex];
    const existingFrameIndex = frames.indexOf(currentPage);
    const hit = existingFrameIndex !== -1;
    let evictedPage: number | null = null;
    let selectedFrameIndex = existingFrameIndex;
    let optVictimNextUse: number | null = null;
    let optVictimDistance: number | null = null;

    if (hit) {
      hits += 1;
    } else {
      pageFaults += 1;
      selectedFrameIndex = frames.indexOf(null);

      if (selectedFrameIndex === -1) {
        if (algorithm === 'fifo') {
          const victim = fifoQueue.shift()!;
          selectedFrameIndex = frames.indexOf(victim);
        } else if (algorithm === 'lru') {
          const victim = recentUseOrder[0];
          selectedFrameIndex = frames.indexOf(victim);
        } else {
          let farthest = -1;
          for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
            const page = frames[frameIndex]!;
            const useIndex = nextUse(references, page, referenceIndex + 1);
            const distance = useIndex === null ? Number.POSITIVE_INFINITY : useIndex;
            // A single reference index names one page; only never-used pages can tie.
            if (distance > farthest) {
              farthest = distance;
              selectedFrameIndex = frameIndex;
            }
          }
        }
        evictedPage = frames[selectedFrameIndex];
        evictions += 1;
        if (algorithm === 'opt' && evictedPage !== null) {
          optVictimNextUse = nextUse(references, evictedPage, referenceIndex + 1);
          optVictimDistance =
            optVictimNextUse === null ? null : optVictimNextUse - referenceIndex;
        }
        if (algorithm === 'lru' && evictedPage !== null) {
          const victimPosition = recentUseOrder.indexOf(evictedPage);
          if (victimPosition !== -1) recentUseOrder.splice(victimPosition, 1);
        }
      }

      frames[selectedFrameIndex] = currentPage;
      if (algorithm === 'fifo') fifoQueue.push(currentPage);
    }

    if (algorithm === 'lru') {
      const priorPosition = recentUseOrder.indexOf(currentPage);
      if (priorPosition !== -1) recentUseOrder.splice(priorPosition, 1);
      recentUseOrder.push(currentPage);
    }

    const metrics: PageReplacementMetrics = {
      pageFaults,
      hits,
      faultRate: roundToTwo((pageFaults / (referenceIndex + 1)) * 100),
      evictions,
      finalFrames: [...frames],
    };
    const evidence =
      algorithm === 'fifo'
        ? `FIFO 队列从旧到新：[${fifoQueue.join(', ')}]`
        : algorithm === 'lru'
          ? `LRU 最近最少使用顺序从旧到新：[${recentUseOrder.join(', ')}]`
          : `OPT 驻留页下次使用索引：${JSON.stringify(
              createNextUseByPage(references, referenceIndex, frames),
            )}`;
    const outcome = hit ? '命中' : '缺页';
    const victim =
      evictedPage === null
        ? '无淘汰页'
        : algorithm === 'opt'
          ? optVictimNextUse === null
            ? `淘汰页 ${evictedPage}，之后不再使用（下次使用索引 null，距离无穷）`
            : `淘汰页 ${evictedPage}，下次使用索引 ${optVictimNextUse}，距离 ${optVictimDistance}`
          : `淘汰页 ${evictedPage}`;
    const state: PageReplacementState = {
      referenceIndex,
      currentPage,
      frames: [...frames],
      hit,
      evictedPage,
      fifoQueue: [...fifoQueue],
      recentUseOrder: [...recentUseOrder],
      nextUseByPage: createNextUseByPage(references, referenceIndex, frames),
    };
    steps.push(
      deepFreeze({
        index: referenceIndex,
        time: referenceIndex,
        label: `页面 ${currentPage}`,
        explanation: `页面 ${currentPage}：${outcome}；${victim}；${evidence}。`,
        state: deepFreeze(state),
        metrics: deepFreeze(metrics),
      }),
    );
  }

  const finalFrames = [...frames];
  const finalMetrics = deepFreeze({
    pageFaults,
    hits,
    faultRate: roundToTwo((pageFaults / references.length) * 100),
    evictions,
    finalFrames,
  });
  return deepFreeze({
    algorithm,
    steps,
    finalMetrics,
    resultFingerprint: createFingerprint(input, algorithm, steps, finalMetrics),
  });
}
