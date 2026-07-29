import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'app/a3/classroom/page.tsx');
const redesignPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view-redesign.tsx');
const rootLayoutPath = path.resolve(process.cwd(), 'app/layout.tsx');

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
    expect(source).toContain("window.matchMedia('(min-width: 1280px)')");
    expect(source).toContain("document.documentElement.style.overflowY = 'hidden'");
    expect(source).toContain("document.body.style.overflowY = 'hidden'");
    expect(source).toContain('document.documentElement.style.overflowY = previousHtmlOverflowY');
    expect(source).toContain('document.body.style.overflowY = previousBodyOverflowY');
  });

  it('keeps compact classroom context controls constrained at narrow widths', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');
    const workspaceStart = source.indexOf('function WorkspaceHeader(');
    const openmaicStart = source.indexOf('function OpenMAICInlineBar(');
    const historyStart = source.indexOf('function HistorySidebar(', openmaicStart);
    const workspaceSource = source.slice(workspaceStart, openmaicStart);
    const openmaicSource = source.slice(openmaicStart, historyStart);

    expect(workspaceSource).toContain('className="flex min-w-0 flex-col gap-3 pr-32 lg:flex-row');
    expect(workspaceSource).toContain('className="min-w-0"');
    expect(workspaceSource).toContain('line-clamp-1');
    expect(workspaceSource).toContain('className="flex shrink-0 flex-wrap gap-2"');

    expect(openmaicSource).toContain('className="flex min-w-0 min-h-8 items-center gap-3"');
    expect(openmaicSource).toContain('className="flex min-w-0 flex-1 items-center gap-2"');
    expect(openmaicSource).toContain('className="min-w-0 truncate text-sm');
    expect(openmaicSource).toContain('className="hidden min-w-0 flex-1 truncate text-xs');
    expect(openmaicSource).toContain('title={copy.pptxHint}');
    expect(openmaicSource).toContain('className="shrink-0"');
    expect(openmaicSource).toContain('className="shrink-0 bg-blue-600');
    expect(openmaicSource).toContain("cn('shrink-0', CLASSROOM_OUTLINE_BUTTON_CLASS)");
    expect(openmaicSource).not.toContain('flex flex-col gap-3 lg:flex-row');
    expect(openmaicSource).not.toContain('flex shrink-0 flex-wrap gap-2');
  });

  it('renders the learning drawer as a viewport overlay below xl without adding a grid row', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain("from '@/components/ui/dialog'");
    expect(source).toContain('<Dialog open={drawerOpen} modal');
    expect(source).toContain('data-testid="a3-classroom-drawer-dialog"');
    expect(source).toContain('<DialogTitle');
    expect(source).toContain('onCloseAutoFocus={restoreDrawerFocus}');
    expect(source).toContain('isDesktopDrawer ? (');
    expect(source).toContain('<LearningDrawer');
    expect(source).not.toContain('grid-rows-[minmax(0,1fr)_auto]');
  });

  it('exposes stable classroom panel controls without coupling tests to icon classes', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    for (const testId of [
      'a3-classroom-history-close',
      'a3-classroom-drawer-toggle',
      'a3-classroom-sticky-drawer-toggle',
      'a3-classroom-drawer-close',
    ]) {
      expect(source).toContain(`data-testid="${testId}"`);
    }

    const stickyTestId = 'data-testid="a3-classroom-sticky-drawer-toggle"';
    const stickyTestIdIndex = source.indexOf(stickyTestId);
    const stickyButton = source.slice(
      source.lastIndexOf('<button', stickyTestIdIndex),
      source.indexOf('>', stickyTestIdIndex) + 1,
    );
    expect(stickyButton).toContain('aria-label={copy.sidePanel}');
  });

  it('integrates classroom context into the unique stick-to-bottom dialogue flow', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain("import { useStickToBottom } from 'use-stick-to-bottom'");
    expect(source).toContain('ClassroomContextShell');
    expect(source).toContain('ClassroomStickyContextBar');
    expect(source).toContain('useClassroomContextVisibility');
    expect(source).toContain('useStickToBottom({');
    expect(source).toContain('initial: false');
    expect(source).toContain("resize: { damping: 0.78, stiffness: 0.08, mass: 1 }");
    expect(source).toContain('scrollToBottom');
    expect(source).toContain('isNearBottom');
    expect(source).toContain('initialHistoryPositionPendingRef');
    expect(source).toContain('scrollRootRef: scrollRef');
    expect(source).toContain('ref={scrollRef}');
    expect(source).toContain('ref={contentRef}');
    expect(source).toContain('data-testid="a3-classroom-dialogue-content"');
    expect(source).toContain('data-testid="a3-classroom-context-loading"');
    expect(source).toContain('loading && !classroom ? (');
    expect(source).toContain('copy.chooseTargetFirst');
    expect(source).toContain('copy.viewingHistoryCompact');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('visible={!contextLayout.contextInView}');
    expect(source.match(/data-testid="a3-classroom-dialogue"/g)).toHaveLength(1);
    expect(source.match(/ref=\{scrollRef\}/g)).toHaveLength(1);
    expect(source.match(/ref=\{contentRef\}/g)).toHaveLength(1);
    expect(source).toContain('relative flex min-h-0 flex-1');
    expect(source).toContain('ClassroomComposerFrame');
    expect(source).toContain("'--a3-composer-height': `${composerHeight}px`");
    expect(source).toContain("scrollPaddingBottom: 'calc(var(--a3-composer-height) + 16px)'");
    expect(source).toContain("paddingBottom: 'calc(var(--a3-composer-height) + 16px)'");
    expect(source).toContain('data-testid="a3-classroom-jump-latest"');
    expect(source).toContain('bottom-[calc(var(--a3-composer-height)+12px)]');
    expect(source).toContain("animation: 'smooth'");
    expect(source).toContain('ignoreEscapes: true');
    expect(source.match(/scrollAfterActiveSend\(\);/g)).toHaveLength(2);
    expect(source).not.toContain('dialogueEndRef');
    expect(source).not.toContain('scrollIntoView({ behavior: \'smooth\' });');
    expect(source).not.toContain('grid-rows-[minmax(0,1fr)_auto]');
  });

  it('keeps progressive classroom copy synchronized in zh-CN and en-US', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    for (const englishValue of [
      'Classroom info',
      'Collapse classroom info',
      'Expand classroom info',
      'Jump to latest',
      'Viewing chat history',
      'Loading classroom context',
      'Tutor preference unavailable',
      'Retry tutor preference',
      'Choose a learning target before asking a question',
      'Tutor preference pending',
      'More actions',
    ]) {
      expect(source).toContain(englishValue);
    }

    for (const chineseEntry of [
      "jumpLatest: '回到最新消息'",
      "loadingContext: '正在加载课堂信息'",
      "tutorUnavailable: '导师方式加载失败'",
      "retryTutor: '重试导师方式'",
      "chooseTargetFirst: '请先选择学习目标，再开始提问'",
      "tutorPending: '辅导方式待选择'",
    ]) {
      expect(source).toContain(chineseEntry);
    }

    for (const key of [
      'classroomInfo',
      'collapseClassroomInfo',
      'expandClassroomInfo',
      'jumpLatest',
      'viewingHistoryCompact',
      'loadingContext',
      'tutorUnavailable',
      'retryTutor',
      'chooseTargetFirst',
      'tutorPending',
      'moreActions',
    ]) {
      expect(source.match(new RegExp(`${key}:`, 'g'))).toHaveLength(2);
    }
  });

  it('keeps composer accessibility semantics explicit in both locales', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain("role={voiceError || !voiceSupported ? 'alert' : 'status'}");
    expect(source.match(/removeImage:/g)).toHaveLength(2);
    expect(source).toContain('aria-label={copy.removeImage}');
    expect(source).toContain('title={copy.removeImage}');
  });

  it('keeps retrieval controls on one scrollable row and the send action fixed at 44px', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain("textarea.style.height = '44px'");
    expect(source).toContain('if (!input) return');
    expect(source).toContain('className="flex min-w-0 flex-1 items-end gap-2 overflow-x-auto"');
    expect(source).toContain('className="flex min-w-max flex-nowrap items-center gap-2" data-testid="a3-classroom-retrieval-controls"');
    expect(source).toContain('data-testid="a3-classroom-submit"');
    expect(source).toContain('className="size-11 shrink-0 rounded-lg bg-blue-600 p-0 hover:bg-blue-700"');
  });

  it('keeps safe-area composition active at every breakpoint with cover viewport metadata', () => {
    const source = fs.readFileSync(rootLayoutPath, 'utf8');

    expect(source).toContain("import type { Metadata, Viewport } from 'next'");
    expect(source).toContain('export const viewport: Viewport = {');
    expect(source).toContain("viewportFit: 'cover'");
  });

  it('keeps classroom context collapse state local to the browser session', () => {
    const contextSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/classroom/classroom-context-shell.tsx'),
      'utf8',
    );

    expect(contextSource).toContain('window.sessionStorage.getItem');
    expect(contextSource).toContain('window.sessionStorage.setItem');
    expect(contextSource).toContain('IntersectionObserver');
    expect(contextSource).not.toContain('localStorage');
  });
});
