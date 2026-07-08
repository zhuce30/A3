import type { LearningReport } from './assessment-types';

type CsvCell = string | number | null | undefined;

export function buildLearningReportCsv(report: LearningReport) {
  const rows: CsvCell[][] = [
    ['指标', '数值'],
    ['学习时长（分钟）', report.metrics.studyMinutes],
    ['学习天数', report.metrics.studyDays],
    ['已掌握知识点', report.metrics.masteredKnowledgePoints],
    ['作答题数', report.metrics.answeredQuestions],
    ['正确率（%）', report.metrics.accuracy],
    ['待巩固错题', report.metrics.activeWrongQuestions],
    ['路径进度（%）', report.metrics.pathProgress],
  ];

  const wrongReviewInsight = report.wrongReviewInsight;
  if (wrongReviewInsight) {
    rows.push(
      [],
      ['错题复盘洞察'],
      ['错题复盘结论', wrongReviewInsight.headline],
      ['错题复盘说明', wrongReviewInsight.summary],
      ['待巩固错题', wrongReviewInsight.activeWrongQuestions],
      ['已掌握错题', wrongReviewInsight.masteredWrongQuestions],
      ['最近错题知识点', wrongReviewInsight.recentKnowledgePoints.join(' / ') || '暂无'],
      ['错题复盘下一步', wrongReviewInsight.nextAction.label],
      ['错题复盘下一步原因', wrongReviewInsight.nextAction.reason],
    );
  }

  const diagnosis = report.weeklyPrescription?.diagnosis;
  if (diagnosis) {
    rows.push(
      [],
      ['学情诊断'],
      ['诊断结论', diagnosis.headline],
      ['诊断说明', diagnosis.summary],
      ...diagnosis.evidence.map((ev, i) => [`诊断依据${i + 1}`, ev]),
    );
  }

  const prescription = report.weeklyPrescription;
  if (prescription?.primaryAction) {
    rows.push(
      ['下周首要行动', prescription.primaryAction.label],
      ['行动理由', prescription.primaryAction.reason],
    );
  }

  const effect = report.resourcePackEffect;
  if (effect) {
    rows.push(
      ['资源包闭环率（%）', effect.conversionRate],
      ['完成资源包次数', effect.totalRuns],
      ['资源包验证来源数', effect.verifiedSourceCount],
      ['资源包专项练习次数', effect.practiceStartedCount],
      ['最近资源包目标', effect.latestRun?.learningGoal || '暂无'],
      ['资源包转化说明', effect.conversionMessage],
      ['资源包下一步', effect.nextAction.label],
      ['资源包下一步原因', effect.nextAction.reason],
    );
    if (effect.recentRuns.length > 0) {
      rows.push(
        [],
        ['资源包运行明细'],
        ['序号', '任务ID', '任务标题', '学习目标', '验证来源数', '置信度', '来源', '完成时间', '练习入口', '下一步理由'],
        ...effect.recentRuns.map((run, index) => [
          index + 1,
          run.taskId,
          run.taskTitle || '暂无',
          run.learningGoal,
          run.verifiedSourceCount,
          run.confidence,
          run.source || 'resource_pack',
          run.completedAt,
          run.practiceHref,
          run.nextStepReason || '继续专项练习，把资源包学习转化为测评反馈。',
        ]),
      );
    }
  }

  return `\uFEFF${rows.map((row) => row.map(formatCsvCell).join(',')).join('\n')}`;
}

function formatCsvCell(cell: CsvCell) {
  const value = cell == null ? '' : String(cell);
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
