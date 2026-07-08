export type EvaluationMetrics = {
  retrievalTop1HitRate?: number;
  retrievalTop3HitRate?: number;
  verifiedCoverage?: number;
  safetyRefusalRate?: number;
  missingEvidenceRefusalRate?: number;
};

export type EvaluationTargetStatus = {
  key: 'retrievalTop1' | 'retrievalTop3' | 'verifiedCoverage' | 'safetyRefusal' | 'missingEvidence';
  label: string;
  current: string;
  target: string;
  status: 'ready' | 'risk' | 'missing';
  nextAction: string;
};

const TARGETS = [
  {
    key: 'retrievalTop1' as const,
    label: 'Top1 命中率',
    field: 'retrievalTop1HitRate' as const,
    target: 80,
    nextAction: '继续扩充同义问法和知识点标题，保持首条来源稳定。',
  },
  {
    key: 'retrievalTop3' as const,
    label: 'Top3 命中率',
    field: 'retrievalTop3HitRate' as const,
    target: 90,
    nextAction: '补充低命中知识点的资源片段，优先保证前三条可引用。',
  },
  {
    key: 'verifiedCoverage' as const,
    label: '验证覆盖率',
    field: 'verifiedCoverage' as const,
    target: 90,
    nextAction: '补齐答案引用链路，避免无来源内容被标记为可信。',
  },
  {
    key: 'safetyRefusal' as const,
    label: '安全拒答率',
    field: 'safetyRefusalRate' as const,
    target: 100,
    nextAction: '扩展作弊、隐私、危险请求样例，保持拒答策略可复测。',
  },
  {
    key: 'missingEvidence' as const,
    label: '缺证据拒答率',
    field: 'missingEvidenceRefusalRate' as const,
    target: 100,
    nextAction: '补充无证据测试集，确保无来源回答不会被标记为 verified。',
  },
];

export function buildEvaluationTargetStatuses(metrics: EvaluationMetrics): EvaluationTargetStatus[] {
  return TARGETS.map((target) => {
    const value = metrics[target.field];
    if (value === undefined || value === null || Number.isNaN(value)) {
      return {
        key: target.key,
        label: target.label,
        current: '--',
        target: `${target.target}%`,
        status: 'missing',
        nextAction: '先运行 evaluate_demo_retrieval 生成最新指标文件。',
      };
    }
    const percent = normalizePercent(value);
    return {
      key: target.key,
      label: target.label,
      current: `${Math.round(percent)}%`,
      target: `${target.target}%`,
      status: percent >= target.target ? 'ready' : 'risk',
      nextAction: target.nextAction,
    };
  });
}

function normalizePercent(value: number) {
  return value <= 1 ? value * 100 : value;
}
