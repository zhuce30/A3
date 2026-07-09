import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

describe('A3 profile-driven rationale in daily learning flows', () => {
  it('shows task-level profile rationale in today and study plan pages', () => {
    const today = read('components/a3/features/today-learning-view.tsx');
    const studyPlan = read('components/a3/features/study-plan-view.tsx');

    for (const source of [today, studyPlan]) {
      expect(source).toContain("'/api/profiles/dynamic-profile/'");
      expect(source).toContain('buildTaskProfileRationale');
      expect(source).toContain('data-testid="a3-task-profile-rationale"');
      expect(source).toContain('/a3/profile-setup');
    }
  });

  it('shows recommendation-level profile rationale next to recommendation actions', () => {
    const recommendations = read('components/a3/features/recommendations-view.tsx');

    expect(recommendations).toContain("'/api/profiles/dynamic-profile/'");
    expect(recommendations).toContain('buildRecommendationProfileRationale');
    expect(recommendations).toContain('data-testid="a3-recommendation-profile-rationale"');
    expect(recommendations).toContain('/a3/profile-setup');
  });

  it('keeps profile rationale helpers evidence-based', () => {
    const insights = read('lib/a3/learning-flow-insights.ts');

    expect(insights).toContain('buildTaskProfileRationale');
    expect(insights).toContain('buildRecommendationProfileRationale');
    expect(insights).toContain('summarizeProfileTimelineEntry');
    expect(insights).toContain('profileDimensionLabel');
    expect(insights).toContain('confidence');
  });
});
