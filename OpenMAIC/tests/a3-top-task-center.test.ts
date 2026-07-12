import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const topActionsPath = path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx');

describe('A3 top task center panel', () => {
  it('surfaces unified long-running tasks in the global top bar without mojibake copy', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain("type Panel = 'tasks' | 'notifications' | 'help' | 'language' | null");
    expect(source).toContain("fetch('/api/a3/tasks'");
    expect(source).toContain("new EventSource('/api/a3/tasks/stream'");
    expect(source).toContain('data-testid="a3-top-tasks-trigger"');
    expect(source).toContain('data-testid="a3-top-tasks-panel"');
    expect(source).toContain('data-testid="a3-top-task-item"');
    expect(source).toContain('任务中心');
    expect(source).toContain('formatTaskStatus');
    expect(source).not.toMatch(/[�]|锟|鍥|璇|瀹|涓€|闄|鏆|绯|鎬|杩|浠诲姟|璧勬簮|鐭ヨ瘑|瑙嗛/);
  });

  it('renders real knowledge-base progress details from backend task payloads', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain('progressDetail?: A3TaskProgressDetail');
    expect(source).toContain('data-testid="a3-top-task-progress-detail"');
    expect(source).toContain('data-testid="a3-top-task-progress-event"');
    expect(source).toContain('renderProgressCounters');
    expect(source).toContain('recentEvents');
  });
});
