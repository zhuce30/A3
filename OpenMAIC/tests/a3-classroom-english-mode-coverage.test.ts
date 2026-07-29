import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const shellPath = path.resolve(process.cwd(), 'components/a3/layout/a3-shell.tsx');
const i18nPath = path.resolve(process.cwd(), 'lib/a3/i18n.ts');
const redesignPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view-redesign.tsx');

describe('A3 classroom English mode coverage', () => {
  it('maps A3 child navigation labels through locale messages instead of static labels', () => {
    const shell = fs.readFileSync(shellPath, 'utf8');
    const i18n = fs.readFileSync(i18nPath, 'utf8');

    expect(shell).toContain("'/a3/profile-setup': messages.navProfileSetup");
    expect(shell).toContain("'/a3/resources': messages.navResourceRecords");
    expect(i18n).toContain("navProfileSetup: 'Learning Profile'");
    expect(i18n).toContain("navResourceRecords: 'Resource Records'");
  });

  it('keeps redesigned classroom chrome translatable while preserving backend data', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain('useA3Locale');
    expect(source).toContain('classroomCopy');
    expect(source).toContain("classroomConversations: 'Classroom conversations'");
    expect(source).toContain("newDialogue: 'New chat'");
    expect(source).toContain("searchHistory: 'Search history'");
    expect(source).toContain("drawerTitle: 'Classroom side panel'");
    expect(source).toContain("practiceTab: 'Practice'");
    expect(source).toContain("actionsTab: 'Actions'");
    expect(source).toContain("historyTab: 'History'");
    expect(source).toContain("openClassroom: 'Open classroom'");
    expect(source).toContain("fastAnswer: 'Fast answer'");
    expect(source).toContain("deepRetrieval: 'Deep retrieval'");
    expect(source).toContain("send: 'Send'");
    expect(source).toContain("completeAndSync: 'Complete and sync'");
    expect(source).toContain('target?.title');
    expect(source).toContain('source.title');
  });

  it('keeps the focused shell header inside its fixed-height row at constrained widths', () => {
    const shell = fs.readFileSync(shellPath, 'utf8');
    const focusedStart = shell.indexOf('{focusedHeader && (');
    const focusedEnd = shell.indexOf('{pageTitle && (', focusedStart);
    const focusedHeader = shell.slice(focusedStart, focusedEnd);

    expect(shell).toContain('className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden"');
    expect(shell).toContain(
      "const focusedPageTitle = pathname === '/a3/coaching' ? messages.coachingTitle : messages.classroomTitle;",
    );
    expect(focusedHeader.match(/<h1\b/g)).toHaveLength(1);
    expect(focusedHeader).toContain('<h1 className="sr-only md:not-sr-only md:min-w-0 md:truncate md:whitespace-nowrap');
    expect(focusedHeader).toContain('{focusedPageTitle}</h1>');
    expect(focusedHeader).toContain('hidden min-w-0 shrink overflow-hidden xl:block');
    expect(focusedHeader).not.toContain('items-center gap-3 md:flex');
  });
});
