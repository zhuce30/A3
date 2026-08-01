import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  algorithmLabRegistry,
  getAlgorithmLabDefinition,
  getAlgorithmLabPreset,
} from '@/lib/a3/algorithm-lab/registry';
import {
  validateCpuSchedulingInput,
  validatePageReplacementInput,
} from '@/lib/a3/algorithm-lab/validators';
import type {
  AlgorithmLabDefinition,
  AlgorithmLabDefinitionFor,
  AlgorithmLabPreset,
  CpuSchedulingInput,
  PageReplacementInput,
  SimulationRun,
} from '@/lib/a3/algorithm-lab/contracts';

const validCpuInput = (): CpuSchedulingInput => ({
  processes: [
    { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 1 },
    { processId: 'P2', arrivalTime: 2, burstTime: 3, priority: 2 },
  ],
  timeQuantum: 2,
});

const typedSimulationRun: SimulationRun<{ current: number }, { completed: number }> = {
  algorithm: 'fcfs',
  steps: [
    {
      index: 0,
      time: 0,
      label: 'start',
      explanation: '开始',
      state: { current: 0 },
      metrics: { completed: 0 },
    },
  ],
  finalMetrics: { completed: 1 },
  resultFingerprint: 'run-1',
};

describe('algorithm lab registry', () => {
  it('contains exactly the two P0 labs in stable order with semantic versions', () => {
    expect(algorithmLabRegistry.map((lab) => lab.id)).toEqual([
      'cpu-scheduling',
      'page-replacement',
    ]);
    expect(algorithmLabRegistry).toHaveLength(2);
    expect(algorithmLabRegistry.every((lab) => /^\d+\.\d+\.\d+$/.test(lab.version))).toBe(true);
    expect(algorithmLabRegistry.every((lab) => lab.version === '1.0.0')).toBe(true);
  });

  it('provides at least three presets and all required difficulties for each lab', () => {
    for (const lab of algorithmLabRegistry) {
      expect(lab.presets.length).toBeGreaterThanOrEqual(3);
      expect(new Set(lab.presets.map((preset) => preset.difficulty))).toEqual(
        new Set(['foundation', 'misconception', 'comparison']),
      );
    }

    expect(getAlgorithmLabPreset('cpu-scheduling', 'cpu-foundation', '1.0.0')).not.toBeNull();
    expect(getAlgorithmLabPreset('cpu-scheduling', 'cpu-misconception', '1.0.0')).not.toBeNull();
    expect(getAlgorithmLabPreset('page-replacement', 'page-foundation', '1.0.0')).not.toBeNull();
    expect(getAlgorithmLabPreset('page-replacement', 'page-misconception', '1.0.0')).not.toBeNull();
  });

  it('returns null for unknown labs and presets', () => {
    expect(getAlgorithmLabDefinition('not-a-lab')).toBeNull();
    expect(getAlgorithmLabPreset('cpu-scheduling', 'missing', '1.0.0')).toBeNull();
    expect(getAlgorithmLabPreset('cpu-scheduling', 'cpu-foundation', '9.9.9')).toBeNull();
  });

  it('preserves literal correlations while accepting dynamic lab IDs', () => {
    const cpuDefinition = getAlgorithmLabDefinition('cpu-scheduling');
    const pageDefinition = getAlgorithmLabDefinition('page-replacement');
    const cpuPreset = getAlgorithmLabPreset('cpu-scheduling', 'cpu-foundation', '1.0.0');
    const pagePreset = getAlgorithmLabPreset('page-replacement', 'page-foundation', '1.0.0');
    const dynamicLabId: string = 'cpu-scheduling';
    const dynamicDefinition = getAlgorithmLabDefinition(dynamicLabId);
    const dynamicPreset = getAlgorithmLabPreset(dynamicLabId, 'cpu-foundation', '1.0.0');

    expectTypeOf(cpuDefinition).toEqualTypeOf<
      AlgorithmLabDefinitionFor<'cpu-scheduling'> | null
    >();
    expectTypeOf(pageDefinition).toEqualTypeOf<
      AlgorithmLabDefinitionFor<'page-replacement'> | null
    >();
    expectTypeOf(cpuPreset).toEqualTypeOf<AlgorithmLabPreset<CpuSchedulingInput> | null>();
    expectTypeOf(pagePreset).toEqualTypeOf<AlgorithmLabPreset<PageReplacementInput> | null>();
    expectTypeOf(dynamicDefinition).toEqualTypeOf<AlgorithmLabDefinition | null>();
    expectTypeOf(dynamicPreset).toEqualTypeOf<AlgorithmLabPreset | null>();
    expect(dynamicDefinition?.id).toBe('cpu-scheduling');
    expect(getAlgorithmLabDefinition('unknown-dynamic-id')).toBeNull();
    expect(getAlgorithmLabPreset('unknown-dynamic-id', 'missing', '1.0.0')).toBeNull();
  });

  it('keeps canonical definitions immutable and returns safe lookup clones', () => {
    expect(typedSimulationRun.algorithm).toBe('fcfs');
    expect(Object.isFrozen(algorithmLabRegistry)).toBe(true);
    for (const lab of algorithmLabRegistry) {
      expect(Object.isFrozen(lab)).toBe(true);
      expect(Object.isFrozen(lab.knowledgePointCodes)).toBe(true);
      expect(Object.isFrozen(lab.algorithms)).toBe(true);
      expect(Object.isFrozen(lab.presets)).toBe(true);
      for (const labPreset of lab.presets) {
        expect(Object.isFrozen(labPreset)).toBe(true);
        expect(Object.isFrozen(labPreset.input)).toBe(true);
      }
      if (lab.id === 'cpu-scheduling') {
        for (const labPreset of lab.presets) {
          expect(Object.isFrozen(labPreset.input.processes)).toBe(true);
          expect(labPreset.input.processes.every((process) => Object.isFrozen(process))).toBe(true);
        }
      } else {
        for (const labPreset of lab.presets) {
          expect(Object.isFrozen(labPreset.input.referenceString)).toBe(true);
        }
      }
    }

    const definition = getAlgorithmLabDefinition('cpu-scheduling');
    const preset = getAlgorithmLabPreset('cpu-scheduling', 'cpu-foundation', '1.0.0');
    const otherPreset = getAlgorithmLabPreset('cpu-scheduling', 'cpu-foundation', '1.0.0');
    expect(definition).not.toBeNull();
    expect(preset).not.toBeNull();
    expect(otherPreset).not.toBeNull();
    expect(otherPreset).not.toBe(preset);
    expect(otherPreset!.input).not.toBe(preset!.input);

    definition!.presets[0].title = 'changed definition';
    const mutableInput = preset!.input;
    mutableInput.processes[0].burstTime = 99;

    expect(getAlgorithmLabDefinition('cpu-scheduling')!.presets[0].title).not.toBe(
      'changed definition',
    );
    expect(
      getAlgorithmLabPreset('cpu-scheduling', 'cpu-foundation', '1.0.0')!.input.processes[0]
        .burstTime,
    ).not.toBe(99);
    expect(otherPreset!.input.processes[0].burstTime).toBe(5);
  });
});

describe('CPU scheduling input validation', () => {
  it('accepts a valid input without mutating it', () => {
    const input = validCpuInput();
    const snapshot = structuredClone(input);

    expect(validateCpuSchedulingInput(input)).toEqual({ valid: true, errors: [] });
    expect(input).toEqual(snapshot);
  });

  it('accepts exact lower and upper CPU boundaries', () => {
    const lower: CpuSchedulingInput = {
      processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }],
      timeQuantum: 1,
    };
    const upper: CpuSchedulingInput = {
      processes: Array.from({ length: 12 }, (_, index) => ({
        processId: `P${index + 1}`,
        arrivalTime: 100,
        burstTime: 100,
        priority: 99,
      })),
      timeQuantum: 20,
    };

    expect(validateCpuSchedulingInput(lower).valid).toBe(true);
    expect(validateCpuSchedulingInput(upper).valid).toBe(true);
  });

  it('rejects an empty process list', () => {
    expect(validateCpuSchedulingInput({ processes: [], timeQuantum: 2 }).errors).toContain(
      '进程数量必须是 1 到 12 个',
    );
  });

  it('rejects zero time quantum with the required message', () => {
    const input = validCpuInput();
    input.timeQuantum = 0;

    expect(validateCpuSchedulingInput(input).errors).toContain(
      '时间片必须是 1 到 20 之间的整数',
    );
  });

  it('rejects blank and duplicate process IDs', () => {
    const blank = validCpuInput();
    blank.processes[0].processId = '   ';
    expect(validateCpuSchedulingInput(blank).errors).toContain('进程编号不能为空');

    const duplicate = validCpuInput();
    duplicate.processes[1].processId = 'P1';
    expect(validateCpuSchedulingInput(duplicate).errors).toContain('进程编号不能重复');
  });

  it.each(['idle', 'IDLE', ' Idle '])('rejects the reserved CPU process ID %s', (processId) => {
    const input = validCpuInput();
    input.processes[0].processId = processId;

    expect(validateCpuSchedulingInput(input).errors).toContain('进程编号不能使用保留值 idle');
  });

  it.each([
    ['arrivalTime', -1, '到达时间必须是 0 到 100 之间的整数'],
    ['arrivalTime', 101, '到达时间必须是 0 到 100 之间的整数'],
    ['arrivalTime', 1.5, '到达时间必须是 0 到 100 之间的整数'],
    ['burstTime', 0, '运行时间必须是 1 到 100 之间的整数'],
    ['burstTime', 101, '运行时间必须是 1 到 100 之间的整数'],
    ['burstTime', 1.5, '运行时间必须是 1 到 100 之间的整数'],
    ['priority', -1, '优先级必须是 0 到 99 之间的整数'],
    ['priority', 100, '优先级必须是 0 到 99 之间的整数'],
    ['priority', 1.5, '优先级必须是 0 到 99 之间的整数'],
  ] as const)('rejects %s value %s', (field, value, message) => {
    const input = validCpuInput();
    input.processes[0][field] = value;

    expect(validateCpuSchedulingInput(input).errors).toContain(message);
  });

  it.each([0, 21, 1.5])('rejects invalid time quantum %s', (timeQuantum) => {
    const input = validCpuInput();
    input.timeQuantum = timeQuantum;

    expect(validateCpuSchedulingInput(input).errors).toContain(
      '时间片必须是 1 到 20 之间的整数',
    );
  });

  it('rejects more than twelve processes', () => {
    const input = validCpuInput();
    input.processes = Array.from({ length: 13 }, (_, index) => ({
      processId: `P${index + 1}`,
      arrivalTime: 0,
      burstTime: 1,
      priority: 0,
    }));

    expect(validateCpuSchedulingInput(input).errors).toContain('进程数量必须是 1 到 12 个');
  });

  it.each([null, undefined, 1, 'input', [], { processes: null, timeQuantum: 2 }])(
    'returns valid false for malformed CPU root %s',
    (input) => {
      expect(validateCpuSchedulingInput(input).valid).toBe(false);
    },
  );

  it('rejects null, primitive, and sparse CPU process rows', () => {
    const malformedProcesses: unknown[] = [null, 1, []];
    const input = {
      processes: malformedProcesses,
      timeQuantum: 2,
    };
    const sparse = { processes: new Array(1), timeQuantum: 2 };

    expect(validateCpuSchedulingInput(input).valid).toBe(false);
    expect(validateCpuSchedulingInput(sparse).valid).toBe(false);
    expect(validateCpuSchedulingInput({ processes: [{}], timeQuantum: 2 }).valid).toBe(false);
  });
});

describe('page replacement input validation', () => {
  it('accepts reference string [7, 0, 1] with three frames without mutation', () => {
    const input: PageReplacementInput = { referenceString: [7, 0, 1], frameCount: 3 };
    const snapshot = structuredClone(input);

    expect(validatePageReplacementInput(input)).toEqual({ valid: true, errors: [] });
    expect(input).toEqual(snapshot);
  });

  it('accepts exact lower and upper page replacement boundaries', () => {
    const lower: PageReplacementInput = { referenceString: [0], frameCount: 1 };
    const upper: PageReplacementInput = { referenceString: Array(60).fill(999), frameCount: 8 };

    expect(validatePageReplacementInput(lower).valid).toBe(true);
    expect(validatePageReplacementInput(upper).valid).toBe(true);
  });

  it('rejects an empty reference string', () => {
    expect(validatePageReplacementInput({ referenceString: [], frameCount: 3 }).errors).toContain(
      '页面引用串长度必须是 1 到 60',
    );
  });

  it('rejects nine frames', () => {
    expect(
      validatePageReplacementInput({ referenceString: [7, 0, 1], frameCount: 9 }).errors,
    ).toContain('页框数必须是 1 到 8 之间的整数');
  });

  it.each([-1, 1000, 1.5])('rejects invalid page value %s', (page) => {
    expect(
      validatePageReplacementInput({ referenceString: [7, page, 1], frameCount: 3 }).errors,
    ).toContain('页面编号必须是 0 到 999 之间的整数');
  });

  it('rejects more than sixty references and invalid frame lower/fractional bounds', () => {
    expect(
      validatePageReplacementInput({ referenceString: Array(61).fill(1), frameCount: 3 }).errors,
    ).toContain('页面引用串长度必须是 1 到 60');

    for (const frameCount of [0, 1.5]) {
      expect(
        validatePageReplacementInput({ referenceString: [1], frameCount }).errors,
      ).toContain('页框数必须是 1 到 8 之间的整数');
    }
  });

  it.each([null, undefined, 1, 'input', [], { referenceString: null, frameCount: 3 }])(
    'returns valid false for malformed page root %s',
    (input) => {
      expect(validatePageReplacementInput(input).valid).toBe(false);
    },
  );

  it('rejects sparse page references', () => {
    const sparse = { referenceString: new Array(1), frameCount: 1 };

    expect(validatePageReplacementInput(sparse).valid).toBe(false);
    expect(validatePageReplacementInput({ referenceString: [undefined], frameCount: 1 }).valid).toBe(
      false,
    );
  });
});
