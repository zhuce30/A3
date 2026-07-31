import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectLatestResumeLabId } from '@/components/a3/features/algorithm-lab/algorithm-lab-catalog-view';
import {
  algorithmLabReducer,
  createAlgorithmLabState,
} from '@/components/a3/features/algorithm-lab/algorithm-lab-workbench';
import type { SimulationRun } from '@/lib/a3/algorithm-lab/contracts';

const root = process.cwd();
const catalogPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx');
const routePath = join(root, 'app/a3/labs/[labId]/page.tsx');
const workbenchPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx');
const layoutPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-layout.tsx');
const controlsPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-controls.tsx');
const explanationPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-step-explanation.tsx');

describe('algorithm lab UI', () => {
  it('has catalog loading, error, empty, progress and resume states', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('正在读取实验进度');
    expect(source).toContain('重新加载');
    expect(source).toContain('暂无可用实验');
    expect(source).toContain('继续上次实验');
    expect(source).toContain('verifiedRuns');
  });

  it('recovers and clears local unfinished sessions without persisting steps', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('loadLabSession');
    expect(source).toContain('clearLabSession');
    expect(source).toContain('清除记录');
    expect(source).not.toContain('session.steps');
  });

  it('selects the most recently started unfinished session', () => {
    expect(selectLatestResumeLabId(
      [{ id: 'cpu-scheduling' }, { id: 'page-replacement' }],
      {
        'cpu-scheduling': { startedAt: '2026-07-31T08:00:00.000Z' },
        'page-replacement': { startedAt: '2026-07-31T09:00:00.000Z' },
      },
    )).toBe('page-replacement');
  });

  it('orders recommended labs first and renders repeated lab items with one clear action', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('recommended');
    expect(source).toContain('sortedLabs.map');
    expect(source).toContain('data-testid="a3-algorithm-lab-item"');
    expect(source).toContain('data-testid="a3-algorithm-lab-action"');
  });

  it('defines the complete reducer-owned workbench phase and state contract', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    for (const phase of ['idle', 'configured', 'predicted', 'running', 'paused', 'completed', 'submitted']) {
      expect(source).toContain(`'${phase}'`);
    }
    for (const field of [
      'selectedAlgorithms',
      'prediction',
      'runs',
      'currentStepIndex',
      'speed',
      'checkpointAnswers',
      'replayCount',
      'reviewedStepIndexes',
      'syncState',
      'startedAt',
    ]) {
      expect(source).toContain(field);
    }
  });

  it('invalidates old runs on configure and seeks without recomputing runs', () => {
    const initial = createAlgorithmLabState('cpu-scheduling');
    const runs: SimulationRun[] = [{
      algorithm: 'fcfs',
      steps: [{ index: 0, time: 0, label: 'start', explanation: '', state: {}, metrics: {} }],
      finalMetrics: {},
      resultFingerprint: 'cpu:test',
    }];
    const running = algorithmLabReducer(initial, { type: 'start', runs });
    const sought = algorithmLabReducer(running, { type: 'seek', index: 0 });
    expect(sought.runs).toBe(running.runs);

    const configured = algorithmLabReducer(sought, {
      type: 'configure',
      input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }], timeQuantum: 1 },
      algorithms: ['fcfs'],
    });
    expect(configured.phase).toBe('configured');
    expect(configured.runs).toEqual([]);
    expect(configured.currentStepIndex).toBe(0);
  });

  it('renders a safe dynamic route and a real unknown-lab recovery link', () => {
    const route = readFileSync(routePath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');

    expect(route).toContain('params: Promise<{ labId: string }>');
    expect(route).toContain('<AlgorithmLabWorkbench labId={labId} />');
    expect(workbench).toContain('未找到该实验');
    expect(workbench).toContain('href="/a3/labs"');
  });

  it('uses one cleaned-up playback timer and compact local recovery', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    expect(source.match(/setInterval\(/g)).toHaveLength(1);
    expect(source).toContain('clearInterval');
    expect(source).toContain('}, [finalStepIndex, state.phase, state.speed]);');
    expect(source).toContain('loadLabSession');
    expect(source).toContain('saveLabSession');
    expect(source).toContain('simulateCpuScheduling');
    expect(source).toContain('simulatePageReplacement');
    expect(source).toContain('trackAlgorithmLabStarted');
    expect(source).not.toContain('steps: state.runs');
  });

  it('clears persisted recovery and started-event state on reset', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    expect(source).toContain('function resetWorkbench()');
    expect(source).toContain('clearLabSession(labId);');
    expect(source).toContain('startedEventSent.current = false;');
    expect(source).toContain('onReset={resetWorkbench}');
  });

  it('provides the desktop, tablet and mobile workbench layouts', () => {
    const source = readFileSync(layoutPath, 'utf8');

    expect(source).toContain('grid-cols-[280px_minmax(0,1fr)_300px]');
    expect(source).toContain('min-h-[430px]');
    expect(source).toContain('输入');
    expect(source).toContain('运行');
    expect(source).toContain('结果');
    expect(source).toContain('details');
  });

  it('exposes accessible playback controls and a collapsed scrolling explanation', () => {
    const controls = readFileSync(controlsPath, 'utf8');
    const explanation = readFileSync(explanationPath, 'utf8');

    for (const label of ['播放', '暂停', '上一步', '下一步', '重置', '全屏画布']) {
      expect(controls).toContain(`aria-label="${label}"`);
    }
    expect(explanation).toContain('<details');
    expect(explanation).toContain('overflow-y-auto');
  });
});
