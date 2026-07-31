import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  simulatePageReplacement,
  type PageReplacementMetrics,
  type PageReplacementState,
} from '@/lib/a3/algorithm-lab/page-replacement';
import type { PageReplacementAlgorithm, PageReplacementInput, SimulationRun } from '@/lib/a3/algorithm-lab/contracts';

const canonicalInput = (): PageReplacementInput => ({
  referenceString: [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2],
  frameCount: 3,
});

const finalState = (run: SimulationRun<PageReplacementState, PageReplacementMetrics>) =>
  run.steps.at(-1)!.state;

describe('deterministic page replacement kernel', () => {
  it('exports the typed simulation contract', () => {
    const run = simulatePageReplacement({ referenceString: [1], frameCount: 1 }, 'fifo');
    expectTypeOf(run).toEqualTypeOf<SimulationRun<PageReplacementState, PageReplacementMetrics>>();
  });

  it.each([
    ['fifo', 10, [0, 2, 3]],
    ['lru', 9, [0, 3, 2]],
    ['opt', 7, [2, 0, 3]],
  ] as const)('%s computes canonical faults and final frames', (algorithm, pageFaults, frames) => {
    const run = simulatePageReplacement(canonicalInput(), algorithm);
    expect(run.finalMetrics).toEqual({
      pageFaults,
      hits: 13 - pageFaults,
      faultRate: Number(((pageFaults / 13) * 100).toFixed(2)),
      evictions: pageFaults - 3,
      finalFrames: frames,
    });
    expect(finalState(run).frames).toEqual(frames);
  });

  it('creates one immutable step per reference with cumulative metrics', () => {
    const run = simulatePageReplacement(canonicalInput(), 'fifo');

    expect(run.steps).toHaveLength(13);
    expect(run.steps.map((step) => step.state.currentPage)).toEqual(canonicalInput().referenceString);
    expect(run.steps.every((step) => step.state.frames.length === 3)).toBe(true);
    expect(run.steps.every((step) => step.state.frames.filter((page) => page !== null).length <= 3)).toBe(true);
    expect(run.steps.at(-1)!.metrics).toEqual(run.finalMetrics);
    expect(run.steps.map((step) => step.metrics.pageFaults)).toEqual([
      1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 10, 10,
    ]);
  });

  it('records policy-specific eviction evidence and deterministic tie breaks', () => {
    const fifo = simulatePageReplacement(canonicalInput(), 'fifo');
    const lru = simulatePageReplacement(canonicalInput(), 'lru');
    const opt = simulatePageReplacement(canonicalInput(), 'opt');
    expect(fifo.steps.map((step) => step.state.evictedPage)).toEqual([
      null, null, null, 7, null, 0, 1, 2, 3, 0, 4, null, null,
    ]);
    expect(lru.steps.map((step) => step.state.evictedPage)).toEqual([
      null, null, null, 7, null, 1, null, 2, 3, 0, 4, null, null,
    ]);
    expect(opt.steps.map((step) => step.state.evictedPage)).toEqual([
      null, null, null, 7, null, 1, null, 0, null, null, 4, null, null,
    ]);
    expect(fifo.steps[3].explanation).toContain('FIFO 队列');
    expect(lru.steps[3].explanation).toContain('最近最少使用');
    expect(opt.steps[3].explanation).toContain('下次使用');
    expect(opt.steps[3].explanation).toContain('之后不再使用');
    expect(Object.keys(opt.steps[3].state.nextUseByPage)).toEqual(['0', '1', '2']);
    for (const step of opt.steps) {
      expect(step.explanation).toContain(`页面 ${step.state.currentPage}`);
      expect(step.explanation).toMatch(/命中|缺页/);
    }

    const tie = simulatePageReplacement({ referenceString: [1, 2, 3, 4], frameCount: 3 }, 'opt');
    expect(tie.steps.at(-1)!.state.evictedPage).toBe(1);
    expect(tie.steps.at(-1)!.state.frames).toEqual([4, 2, 3]);
  });

  it('updates repeated hits without eviction and fills empty frames first', () => {
    const repeated = simulatePageReplacement({ referenceString: [1, 1, 1], frameCount: 2 }, 'lru');
    expect(repeated.finalMetrics).toEqual({
      pageFaults: 1,
      hits: 2,
      faultRate: 33.33,
      evictions: 0,
      finalFrames: [1, null],
    });
    const fill = simulatePageReplacement({ referenceString: [1, 2, 3], frameCount: 3 }, 'fifo');
    expect(fill.steps.map((step) => step.state.evictedPage)).toEqual([null, null, null]);
  });

  it('does not mutate input and returns deeply independent frozen output', () => {
    const input = canonicalInput();
    const before = structuredClone(input);
    const run = simulatePageReplacement(input, 'opt');
    expect(input).toEqual(before);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.steps)).toBe(true);
    expect(Object.isFrozen(run.finalMetrics)).toBe(true);
    expect(Object.isFrozen(run.finalMetrics.finalFrames)).toBe(true);
    expect(Object.isFrozen(run.steps[0].state)).toBe(true);
    expect(Object.isFrozen(run.steps[0].state.frames)).toBe(true);
    expect(run.steps[0].state).not.toBe(run.steps[1].state);
    expect(run.steps[0].state.frames).not.toBe(run.steps[1].state.frames);
    expect(() => run.steps.pop()).toThrow(TypeError);
    expect(() => run.finalMetrics.finalFrames.push(99)).toThrow(TypeError);
  });

  it('throws the shared Chinese validation errors for malformed input', () => {
    expect(() => simulatePageReplacement({ referenceString: [], frameCount: 3 }, 'fifo')).toThrowError(
      new Error('页面引用串长度必须是 1 到 60'),
    );
    expect(() => simulatePageReplacement({ referenceString: [1], frameCount: 9 }, 'fifo')).toThrowError(
      new Error('页框数必须是 1 到 8 之间的整数'),
    );
    expect(() => simulatePageReplacement({ referenceString: [undefined], frameCount: 1 } as unknown as PageReplacementInput, 'fifo')).toThrowError(
      new Error('页面编号必须是 0 到 999 之间的整数'),
    );
  });

  it('handles boundaries, long input, and stable distinct fingerprints', () => {
    const input = { referenceString: Array.from({ length: 60 }, (_, index) => index % 8), frameCount: 8 };
    const first = simulatePageReplacement(input, 'fifo');
    const repeated = simulatePageReplacement(structuredClone(input), 'fifo');
    expect(first.steps).toHaveLength(60);
    expect(first.resultFingerprint).toMatch(/^page:[0-9a-f]{32}$/);
    expect(repeated.resultFingerprint).toBe(first.resultFingerprint);
    expect(
      simulatePageReplacement(
        { referenceString: input.referenceString.map((page) => (page + 1) % 8), frameCount: 8 },
        'fifo',
      ).resultFingerprint,
    ).not.toBe(first.resultFingerprint);
    expect(simulatePageReplacement(input, 'lru').resultFingerprint).not.toBe(first.resultFingerprint);
    expect(simulatePageReplacement({ ...input, frameCount: 7 }, 'fifo').resultFingerprint).not.toBe(first.resultFingerprint);
    expect(simulatePageReplacement({ referenceString: [5], frameCount: 1 }, 'opt').finalMetrics.finalFrames).toEqual([5]);
  });
});
