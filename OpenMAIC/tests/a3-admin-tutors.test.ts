import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { a3GetJson, a3PatchJson } = vi.hoisted(() => ({
  a3GetJson: vi.fn(),
  a3PatchJson: vi.fn(),
}));

vi.mock('../lib/a3/api-client', () => ({ a3GetJson, a3PatchJson }));

import {
  getA3AdminTutors,
  updateA3AdminTutor,
} from '../lib/a3/admin-api';
import {
  createA3AdminTutorRequestCoordinator,
  isA3AdminTutorConflict,
} from '../components/a3/features/admin/admin-tutors-view';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('admin tutor typed API', () => {
  beforeEach(() => {
    a3GetJson.mockReset();
    a3PatchJson.mockReset();
  });

  it('requests only the supported analytics ranges', () => {
    getA3AdminTutors('7d');
    getA3AdminTutors('30d');
    getA3AdminTutors('90d');

    expect(a3GetJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/admin/tutors/?range=7d',
      '/api/admin/tutors/?range=30d',
      '/api/admin/tutors/?range=90d',
    ]);
  });

  it('normalizes the required reason and carries the concurrency timestamp', () => {
    updateA3AdminTutor('structured-teacher', {
      enabled: false,
      reason: '  例行配置调整  ',
      expectedUpdatedAt: '2026-07-27T08:00:00+00:00',
    });

    expect(a3PatchJson).toHaveBeenCalledWith(
      '/api/admin/tutors/personas/structured-teacher/',
      {
        enabled: false,
        reason: '例行配置调整',
        expectedUpdatedAt: '2026-07-27T08:00:00+00:00',
      },
    );
  });

  it('rejects an empty reason before sending a mutation', () => {
    expect(() => updateA3AdminTutor('structured-teacher', {
      enabled: false,
      reason: '   ',
      expectedUpdatedAt: '2026-07-27T08:00:00+00:00',
    })).toThrow('请填写操作原因');
    expect(a3PatchJson).not.toHaveBeenCalled();
  });
});

describe('admin tutor request behavior', () => {
  it('does not let a stale range response overwrite the latest response', async () => {
    const coordinator = createA3AdminTutorRequestCoordinator();
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<string>((resolve) => { resolveSecond = resolve; });
    const committed: string[] = [];

    const firstRun = coordinator.run(() => first, (value) => committed.push(value));
    const secondRun = coordinator.run(() => second, (value) => committed.push(value));
    resolveSecond('90d');
    await secondRun;
    resolveFirst('7d');
    await firstRun;

    expect(committed).toEqual(['90d']);
  });

  it('allows a retry to replace a committed error with fresh data', async () => {
    const coordinator = createA3AdminTutorRequestCoordinator();
    const committed: Array<{ success: boolean }> = [];

    await coordinator.run(async () => ({ success: false }), (value) => committed.push(value));
    await coordinator.run(async () => ({ success: true }), (value) => committed.push(value));

    expect(committed).toEqual([{ success: false }, { success: true }]);
  });

  it('recognizes the backend optimistic-concurrency conflict copy', () => {
    expect(isA3AdminTutorConflict({
      success: false,
      status: 409,
      errorCode: 'stale_update',
      error: '任意后端冲突说明',
    })).toBe(true);
    expect(isA3AdminTutorConflict({
      success: false,
      status: 409,
      errorCode: 'last_enabled_persona',
      error: '不能停用最后一个可用导师人格',
    })).toBe(false);
  });
});

describe('admin tutor workspace contracts', () => {
  const route = () => read('app/a3/admin/tutors/page.tsx');
  const view = () => read('components/a3/features/admin/admin-tutors-view.tsx');
  const layout = () => read('components/a3/features/admin/admin-console-layout.tsx');

  it('uses the existing admin guard and workspace layout with admin-only navigation', () => {
    expect(route()).toContain('AdminTutorsView');
    expect(view()).toContain('AdminAccessGuard');
    expect(layout()).toContain("href: '/a3/admin/tutors'");
    expect(layout()).toContain("label: '导师管理'");
    expect(layout()).not.toContain("href: '/a3/today'");
    expect(layout()).not.toContain("href: '/a3/classroom'");
  });

  it('does not add sensitive tutor internals to the browser view', () => {
    const source = view();
    expect(source).not.toContain('.publicPath');
    expect(source).not.toContain('displayName');
    expect(source).not.toContain('conversation');
    expect(source).not.toContain('openaiVoice');
    expect(source).not.toContain('dashscopeVoice');
    expect(source).not.toContain('providerKey');
  });

  it('keeps the confirmed unframed responsive styling contract', () => {
    const source = view();
    expect(source).toContain('grid-cols-1');
    expect(source).toContain('xl:grid-cols-');
    expect(source).toContain('overflow-x-auto');
    expect(source).toContain('min-w-0');
    expect(source).toContain('break-words');
    expect(source).not.toMatch(/(?:bg|text|border|ring)-blue-/);
  });
});
