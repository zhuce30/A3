import { describe, expect, it } from 'vitest';
import { formatReportMetricDelta } from '@/lib/a3/report-delta';

describe('formatReportMetricDelta', () => {
  it('formats positive report metric changes with a plus sign', () => {
    expect(formatReportMetricDelta(45, 52, '%')).toBe('+7%');
  });

  it('formats negative report metric changes', () => {
    expect(formatReportMetricDelta(6, 4)).toBe('-2');
  });

  it('marks unchanged report metrics as stable', () => {
    expect(formatReportMetricDelta(20, 20, '%')).toBe('持平');
  });

  it('does not show a delta when the previous value is unavailable', () => {
    expect(formatReportMetricDelta(null, 20, '%')).toBe('本次');
  });
});
