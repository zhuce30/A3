import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInteractiveLabHref, type InteractiveLabAction } from '@/lib/a3/recommendation-types';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('algorithm lab learning-loop entry points', () => {
  const recommendationTypes = read('lib/a3/recommendation-types.ts');
  const learningTypes = read('lib/a3/learning-types.ts');
  const recommendations = read('components/a3/features/recommendations-view.tsx');
  const today = read('components/a3/features/today-learning-view.tsx');
  const learningPath = read('components/a3/features/learning-path-view.tsx');
  const resourceDetail = read('components/a3/features/resource-standalone-view.tsx');

  it('defines additive interactive lab actions and optional related labs', () => {
    expect(recommendationTypes).toContain("kind: 'interactive_lab'");
    expect(recommendationTypes).toContain("labId: 'cpu-scheduling' | 'page-replacement'");
    expect(recommendationTypes).toContain('presetId?: string');
    expect(recommendationTypes).toContain('action?: InteractiveLabAction');
    expect(recommendationTypes).toContain('relatedLab?: InteractiveLabAction');
    expect(learningTypes).toContain("| 'interactive_lab'");
    expect(learningTypes).toContain('relatedLab?: InteractiveLabAction');
  });

  it('appends a preset query only when the backend action has a preset id', () => {
    expect(recommendationTypes).toContain('export function buildInteractiveLabHref');
    const action: InteractiveLabAction = {
      kind: 'interactive_lab',
      label: '进入 CPU 调度实验',
      href: '/a3/labs/cpu-scheduling',
      labId: 'cpu-scheduling',
      reason: '对比调度策略。',
    };

    expect(buildInteractiveLabHref(action)).toBe('/a3/labs/cpu-scheduling');
    expect(buildInteractiveLabHref({ ...action, presetId: 'cpu misconception' })).toBe(
      '/a3/labs/cpu-scheduling?preset=cpu%20misconception',
    );
  });

  it('renders one consistent deep-green lab command on all four pages', () => {
    for (const source of [recommendations, today, learningPath, resourceDetail]) {
      expect(source).toContain('FlaskConical');
      expect(source).toContain('bg-emerald-800');
      expect(source).toContain('buildInteractiveLabHref');
    }
  });

  it('keeps today completion separate and exposes path and code-lab actions as secondary links', () => {
    expect(today).toContain('a3-today-task-complete');
    expect(today).toContain("task.type === 'interactive_lab'");
    expect(today).toContain('const activeTaskHref =');
    expect(today).toContain('href={activeTaskHref}');
    expect(learningPath).toContain('item.relatedLab');
    expect(resourceDetail).toContain("resource.type === 'code_lab' && resource.relatedLab");
    expect(resourceDetail).toContain('相关交互实验');
  });
});
