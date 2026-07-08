import type { LearningReport } from './assessment-types';

export type WeaknessTrendItem = {
  title: string;
  status: 'worsening' | 'watch' | 'improving';
  evidence: string;
  nextAction: string;
  href: string;
};

export function buildWeaknessTrendItems(report: LearningReport): WeaknessTrendItem[] {
  const accuracyDelta = latestAccuracyDelta(report.trends);
  const focusItems = report.weeklyPrescription?.focusAreas.map((area) => ({
    title: area.title,
    status: area.priority === 'high' || accuracyDelta < 0 ? 'worsening' as const : 'watch' as const,
    evidence: focusEvidence(area.reason, accuracyDelta, report.metrics.activeWrongQuestions),
    nextAction: area.href.includes('wrong-notebook') ? '先进入错题本完成错因复盘。' : '按学习路径补齐对应知识点练习。',
    href: area.href,
  })) ?? [];

  const axisItems = report.capabilityAxes
    .filter((axis) => axis.value < 65)
    .map((axis) => ({
      title: axis.label,
      status: axis.value < 45 ? 'worsening' as const : 'watch' as const,
      evidence: `${axis.label}当前 ${Math.round(axis.value)}%，低于 65% 观察线。`,
      nextAction: axis.label.includes('进度') ? '压缩下周任务量，优先完成顺延任务。' : '用阶段测评和错题复盘验证薄弱点是否收敛。',
      href: axis.label.includes('进度') ? '/a3/study-plan' : '/a3/assessment',
    }));

  const combined = [...focusItems, ...axisItems];
  if (combined.length) return combined.slice(0, 4);

  return [{
    title: '保持当前学习节奏',
    status: 'improving',
    evidence: `当前正确率 ${report.metrics.accuracy}%，活跃错题 ${report.metrics.activeWrongQuestions} 道。`,
    nextAction: '继续完成今日任务，并在报告更新后复查趋势。',
    href: '/a3/today',
  }];
}

function latestAccuracyDelta(trends: LearningReport['trends']) {
  if (trends.length < 2) return 0;
  const previous = trends[trends.length - 2]?.accuracy ?? 0;
  const current = trends[trends.length - 1]?.accuracy ?? 0;
  return current - previous;
}

function focusEvidence(reason: string, accuracyDelta: number, activeWrongQuestions: number) {
  const parts = [reason];
  if (accuracyDelta < 0) {
    parts.push(`正确率较上周下降 ${Math.abs(Math.round(accuracyDelta))}%`);
  } else if (accuracyDelta > 0) {
    parts.push(`正确率较上周提升 ${Math.round(accuracyDelta)}%`);
  }
  if (activeWrongQuestions > 0) {
    parts.push(`仍有 ${activeWrongQuestions} 道活跃错题`);
  }
  return parts.join('，');
}
