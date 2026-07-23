import { describe, expect, it } from 'vitest';

describe('A3 system health status labels', () => {
  it('distinguishes configured Celery services without heartbeat monitoring', async () => {
    const settingsView = (await import('@/components/a3/features/settings-view')) as unknown as {
      statusLabel: (status: 'ok' | 'warning' | 'error', checkName?: string) => string;
    };

    expect(typeof settingsView.statusLabel).toBe('function');
    expect(settingsView.statusLabel('warning', 'celery')).toBe('已配置 · 未监控');
    expect(settingsView.statusLabel('warning', 'celeryBeat')).toBe('已配置 · 未监控');
    expect(settingsView.statusLabel('warning', 'smsVerification')).toBe('需配置');
    expect(settingsView.statusLabel('ok', 'celery')).toBe('正常');
    expect(settingsView.statusLabel('error', 'celery')).toBe('异常');
  }, 20_000);
});
