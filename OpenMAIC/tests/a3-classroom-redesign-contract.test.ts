import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'app/a3/classroom/page.tsx');
const redesignPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view-redesign.tsx');

describe('A3 classroom redesigned workspace contract', () => {
  it('routes the classroom page through the redesigned workspace without deleting the legacy view', () => {
    const page = fs.readFileSync(pagePath, 'utf8');
    const legacyExists = fs.existsSync(path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx'));

    expect(page).toContain("components/a3/features/classroom-view-redesign");
    expect(page).toContain('ClassroomViewRedesign');
    expect(legacyExists).toBe(true);
  });

  it('keeps classroom data and coaching retrieval wired to real backend contracts', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain("'/api/learning/classroom/'");
    expect(source).toContain("'/api/resources/packs/'");
    expect(source).toContain("'/api/learning/classroom/history/'");
    expect(source).toContain("'/api/learning/study-plan/?auto=1'");
    expect(source).toContain("'/api/a3/coaching/respond'");
    expect(source).toContain('mode: retrievalMode');
    expect(source).toContain('scope: retrievalScope');
    expect(source).toContain("type ClassroomRetrievalMode = 'fast' | 'deep'");
    expect(source).toContain("type ClassroomRetrievalScope = 'all' | 'personal' | 'teacher' | 'class' | 'global'");
    expect(source).toContain("'/api/assessments/start/'");
    expect(source).toContain("'/api/assess/grade/'");
    expect(source).toContain("'/api/learning/study-plan/tasks/complete/'");
  });

  it('adds ChatGPT-style user message actions without bypassing the real composer flow', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain('data-testid="a3-classroom-user-copy"');
    expect(source).toContain('data-testid="a3-classroom-user-edit"');
    expect(source).toContain('navigator.clipboard.writeText');
    expect(source).toContain('onEditUserMessage(item.content)');
    expect(source).toContain('setInput(content)');
    expect(source).toContain("'/api/a3/coaching/respond'");
  });

  it('lets the dialogue and composer expand when classroom side panels are collapsed', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain('resolveClassroomContentWidthClass(historyOpen, drawerOpen)');
    expect(source).toContain('resolveClassroomBubbleWidthClass(historyOpen, drawerOpen)');
    expect(source).toContain("return 'max-w-[min(1320px,calc(100vw-120px))]'");
    expect(source).toContain("return 'max-w-[min(1040px,92%)]'");
    expect(source).toContain('contentWidthClass={contentWidthClass}');
    expect(source).toContain('widthClassName={bubbleWidthClass}');
    expect(source).toContain("cn('mx-auto w-full transition-[max-width] duration-200 ease-out', contentWidthClass)");
  });

  it('uses the available viewport height for courseware instead of a locked dialogue height', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).not.toContain('h-[calc(100dvh-310px)]');
    expect(source).toContain('grid h-[calc(100dvh-104px)] min-h-[640px]');
    expect(source).toContain('flex min-h-0 min-w-0 flex-col overflow-hidden');
    expect(source).toContain('grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]');
    expect(source).toContain("window.matchMedia('(min-width: 1280px)')");
    expect(source).toContain("document.documentElement.style.overflowY = 'hidden'");
    expect(source).toContain("document.body.style.overflowY = 'hidden'");
    expect(source).toContain('document.documentElement.style.overflowY = previousHtmlOverflowY');
    expect(source).toContain('document.body.style.overflowY = previousBodyOverflowY');
  });
});
