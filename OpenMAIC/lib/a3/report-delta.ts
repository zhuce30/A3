export function formatReportMetricDelta(previous: number | null | undefined, current: number, suffix = '') {
  if (previous === null || previous === undefined) return '本次';
  const delta = current - previous;
  if (delta === 0) return '持平';
  return `${delta > 0 ? '+' : ''}${delta}${suffix}`;
}
