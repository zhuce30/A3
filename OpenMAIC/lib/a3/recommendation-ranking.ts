import type { RecommendationProfileSignal } from './recommendation-types';

type RankingBasis = {
  label: string;
  value: string | number | boolean | null;
};

export type RecommendationRankingTone = RecommendationProfileSignal['tone'];

export function getRecommendationRankingTone(basis: RankingBasis): RecommendationRankingTone {
  if (basis.label.includes('测评错题回流') && basis.value === true) return 'orange';
  if (basis.label.includes('薄弱点') && basis.value === true) return 'red';
  if (basis.label.includes('知识库相似度')) return 'green';
  if (basis.label.includes('画像')) return 'blue';
  return 'slate';
}

export function formatRecommendationEvidenceValue(value: RankingBasis['value']) {
  if (value === null) return '待计算';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
