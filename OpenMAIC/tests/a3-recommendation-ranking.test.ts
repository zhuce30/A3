import { describe, expect, it } from 'vitest';
import { formatRecommendationEvidenceValue, getRecommendationRankingTone } from '@/lib/a3/recommendation-ranking';

describe('recommendation ranking helpers', () => {
  it('highlights assessment wrong-question feedback as an urgent ranking signal', () => {
    expect(getRecommendationRankingTone({ label: '测评错题回流', value: true })).toBe('orange');
  });

  it('highlights weak point matches as a risk signal', () => {
    expect(getRecommendationRankingTone({ label: '薄弱点命中', value: true })).toBe('red');
  });

  it('highlights knowledge-base similarity as evidence', () => {
    expect(getRecommendationRankingTone({ label: '知识库相似度', value: 0.92 })).toBe('green');
  });

  it('formats empty and boolean evidence values in readable Chinese', () => {
    expect(formatRecommendationEvidenceValue(null)).toBe('待计算');
    expect(formatRecommendationEvidenceValue(true)).toBe('是');
    expect(formatRecommendationEvidenceValue(false)).toBe('否');
  });
});
