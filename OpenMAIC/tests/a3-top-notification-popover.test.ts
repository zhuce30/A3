import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const topActionsPath = path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx');
const shellPath = path.resolve(process.cwd(), 'components/a3/layout/a3-shell.tsx');

describe('A3 top notification popover', () => {
  it('keeps the notification list scrollable inside the viewport', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain('max-h-[calc(100dvh-88px)]');
    expect(source).toContain('data-testid="a3-top-notifications-scroll"');
    expect(source).toContain('overflow-y-auto');
    expect(source).toContain('overscroll-contain');
    expect(source).toContain('fixed inset-x-2 top-[68px]');
    expect(source).toContain('sm:absolute sm:inset-x-auto sm:right-0 sm:top-12');
  });

  it('uses the backend summary for the unread badge and loads enough recent items', () => {
    const source = fs.readFileSync(topActionsPath, 'utf8');

    expect(source).toContain("'/api/engagement/notifications/?limit=10'");
    expect(source).toContain('notificationSummary?.unread');
  });

  it('keeps global header popovers above page-local graph overlays', () => {
    const source = fs.readFileSync(shellPath, 'utf8');

    expect(source).toContain('sticky top-0 z-40');
  });
});
