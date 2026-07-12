import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A3_HOMEPAGE_TEACHER_DEMO_DURATION_MS,
  resolveTeacherDemoPhase,
} from '@/components/a3/marketing/a3-homepage-teacher-stage';

describe('A3 homepage teacher demo timeline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the four silent demo phases at stable boundaries', () => {
    expect(resolveTeacherDemoPhase(0)).toBe('appear');
    expect(resolveTeacherDemoPhase(1_799)).toBe('appear');
    expect(resolveTeacherDemoPhase(1_800)).toBe('listen');
    expect(resolveTeacherDemoPhase(3_599)).toBe('listen');
    expect(resolveTeacherDemoPhase(3_600)).toBe('question');
    expect(resolveTeacherDemoPhase(7_999)).toBe('question');
    expect(resolveTeacherDemoPhase(A3_HOMEPAGE_TEACHER_DEMO_DURATION_MS)).toBe('complete');
    expect(resolveTeacherDemoPhase(60_000)).toBe('complete');
  });

  it('advances once from appearance to the readable final state in eight seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T00:00:00Z'));
    const startedAt = Date.now();
    const phase = () => resolveTeacherDemoPhase(Date.now() - startedAt);

    expect(phase()).toBe('appear');
    vi.advanceTimersByTime(1_800);
    expect(phase()).toBe('listen');
    vi.advanceTimersByTime(1_800);
    expect(phase()).toBe('question');
    vi.advanceTimersByTime(4_400);
    expect(phase()).toBe('complete');
    vi.advanceTimersByTime(8_000);
    expect(phase()).toBe('complete');
  });
});
