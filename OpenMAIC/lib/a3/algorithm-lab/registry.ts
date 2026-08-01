import type {
  AlgorithmLabDefinition,
  AlgorithmLabDefinitionFor,
  AlgorithmLabId,
  AlgorithmLabInputById,
  AlgorithmLabPreset,
} from './contracts';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

const LAB_VERSION = '1.0.0';

const cpuSchedulingDefinition: AlgorithmLabDefinition<'cpu-scheduling'> = {
  id: 'cpu-scheduling',
  version: LAB_VERSION,
  title: 'CPU 调度算法实验',
  description: '比较不同调度策略对等待时间、周转时间和响应时间的影响。',
  estimatedMinutes: 25,
  knowledgePointCodes: ['OS.CPU.SCHEDULING', 'OS.CPU.PERFORMANCE'],
  algorithms: ['fcfs', 'sjf', 'priority', 'rr'],
  presets: [
    {
      id: 'cpu-foundation',
      version: LAB_VERSION,
      title: '基础调度过程',
      description: '使用简单到达序列观察四种调度算法的执行顺序。',
      difficulty: 'foundation',
      input: {
        processes: [
          { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 2 },
          { processId: 'P2', arrivalTime: 1, burstTime: 3, priority: 1 },
          { processId: 'P3', arrivalTime: 2, burstTime: 4, priority: 3 },
        ],
        timeQuantum: 2,
      },
    },
    {
      id: 'cpu-misconception',
      version: LAB_VERSION,
      title: '短作业不一定先执行',
      description: '辨析到达时间对短作业优先调度结果的影响。',
      difficulty: 'misconception',
      input: {
        processes: [
          { processId: 'P1', arrivalTime: 0, burstTime: 7, priority: 2 },
          { processId: 'P2', arrivalTime: 2, burstTime: 1, priority: 1 },
          { processId: 'P3', arrivalTime: 3, burstTime: 2, priority: 0 },
        ],
        timeQuantum: 2,
      },
    },
    {
      id: 'cpu-comparison',
      version: LAB_VERSION,
      title: '调度策略对比',
      description: '在长短作业混合场景中比较吞吐量和平均等待时间。',
      difficulty: 'comparison',
      input: {
        processes: [
          { processId: 'P1', arrivalTime: 0, burstTime: 8, priority: 3 },
          { processId: 'P2', arrivalTime: 0, burstTime: 2, priority: 0 },
          { processId: 'P3', arrivalTime: 1, burstTime: 5, priority: 2 },
          { processId: 'P4', arrivalTime: 3, burstTime: 1, priority: 1 },
        ],
        timeQuantum: 3,
      },
    },
  ],
};

const pageReplacementDefinition: AlgorithmLabDefinition<'page-replacement'> = {
  id: 'page-replacement',
  version: LAB_VERSION,
  title: '页面置换算法实验',
  description: '跟踪页框状态，比较不同置换策略的缺页次数和命中率。',
  estimatedMinutes: 20,
  knowledgePointCodes: ['OS.MEMORY.VIRTUAL', 'OS.MEMORY.PAGE_REPLACEMENT'],
  algorithms: ['fifo', 'lru', 'opt'],
  presets: [
    {
      id: 'page-foundation',
      version: LAB_VERSION,
      title: '基础页面置换',
      description: '通过短引用串理解装入、命中和置换过程。',
      difficulty: 'foundation',
      input: {
        referenceString: [7, 0, 1, 2, 0, 3, 0, 4],
        frameCount: 3,
      },
    },
    {
      id: 'page-misconception',
      version: LAB_VERSION,
      title: '更多页框不总是更少缺页',
      description: '使用经典引用串观察 FIFO 算法的 Belady 异常。',
      difficulty: 'misconception',
      input: {
        referenceString: [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5],
        frameCount: 3,
      },
    },
    {
      id: 'page-comparison',
      version: LAB_VERSION,
      title: '置换策略对比',
      description: '比较 FIFO、LRU 和 OPT 在局部性引用串中的表现。',
      difficulty: 'comparison',
      input: {
        referenceString: [2, 3, 2, 1, 5, 2, 4, 5, 3, 2, 5, 2],
        frameCount: 3,
      },
    },
  ],
};

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
  }
  return value as DeepReadonly<T>;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, deepClone(child)]),
    ) as T;
  }
  return value;
}

const canonicalAlgorithmLabRegistry = [
  cpuSchedulingDefinition,
  pageReplacementDefinition,
] as const;

export const algorithmLabRegistry = deepFreeze(canonicalAlgorithmLabRegistry);

export function getAlgorithmLabDefinition<TLabId extends AlgorithmLabId>(
  labId: TLabId,
): AlgorithmLabDefinitionFor<TLabId> | null;
export function getAlgorithmLabDefinition(labId: string): AlgorithmLabDefinition | null;
export function getAlgorithmLabDefinition(labId: string): AlgorithmLabDefinition | null {
  const definition = algorithmLabRegistry.find((lab) => lab.id === labId);
  return definition ? (deepClone(definition) as AlgorithmLabDefinition) : null;
}

export function getAlgorithmLabPreset<TLabId extends AlgorithmLabId>(
  labId: TLabId,
  presetId: string,
  presetVersion: string,
): AlgorithmLabPreset<AlgorithmLabInputById[TLabId]> | null;
export function getAlgorithmLabPreset(
  labId: string,
  presetId: string,
  presetVersion: string,
): AlgorithmLabPreset | null;
export function getAlgorithmLabPreset(
  labId: string,
  presetId: string,
  presetVersion: string,
): AlgorithmLabPreset | null {
  const definition = algorithmLabRegistry.find((lab) => lab.id === labId);
  const preset = definition?.presets.find(
    (candidate) => candidate.id === presetId && candidate.version === presetVersion,
  );
  return preset ? (deepClone(preset) as AlgorithmLabPreset) : null;
}
