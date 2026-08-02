// @vitest-environment jsdom

import React, { act } from 'react';
import NotesPage from '@/app/a3/notes/page';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { NoteEditor } from '@/components/a3/notes/note-editor';
import { NoteAttachments } from '@/components/a3/notes/note-attachments';
import { NoteConflictDialog } from '@/components/a3/notes/note-conflict-dialog';
import { NoteHistoryDialog } from '@/components/a3/notes/note-history-dialog';
import { NotesWorkspace } from '@/components/a3/notes/notes-workspace';
import {
  createAttachmentReference,
  noteEditorSchema,
  parseNoteDocument,
  parseNoteHtml,
} from '@/lib/a3/notes/editor-schema';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { AutosaveEvent, NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import { NotesAutosaveController as RealNotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import { DexieNotesDraftPersistence, NotesDraftDatabase, NotesDraftStore } from '@/lib/a3/notes/draft-store';
import type { NoteAttachment, NoteDetail } from '@/lib/a3/notes/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const draftDatabases: NotesDraftDatabase[] = [];

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  for (const database of draftDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

const now = '2026-08-02T08:00:00.000Z';
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
});
const note = (id = 'note-1', version = 3): NoteDetail => ({
  id,
  title: '操作系统复习',
  content: doc('进程与线程'),
  contentText: '进程与线程',
  version,
  notebook: null,
  tags: [],
  isPinned: false,
  lastEditedAt: now,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});

function workspaceClient(overrides: Partial<NotesClient> = {}) {
  return {
    listNotebooks: vi.fn().mockResolvedValue({ success: true, notebooks: [] }),
    listTags: vi.fn().mockResolvedValue({ success: true, tags: [] }),
    searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [] }),
    createNote: vi.fn().mockResolvedValue({ success: true, note: note() }),
    getNote: vi.fn().mockResolvedValue({ success: true, note: note() }),
    listAttachments: vi.fn().mockResolvedValue({ success: true, attachments: [] }),
    restoreNote: vi.fn().mockResolvedValue({ success: true, note: note() }),
    saveNote: vi.fn(),
    ...overrides,
  } as unknown as NotesClient;
}

function mount(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

function clickByName(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name);
  expect(button, `button ${name}`).toBeTruthy();
  act(() => button!.click());
  return button!;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function autosaveStub(schedule = vi.fn().mockResolvedValue(undefined)) {
  return {
    schedule,
    flush: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    initialize: vi.fn().mockResolvedValue({ account: { kind: 'ready', warningRequired: false }, replay: [] }),
    confirmAccountSwitch: vi.fn(),
    dispose: vi.fn(),
  } as unknown as NotesAutosaveController;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function realAutosave(response: unknown) {
  const database = new NotesDraftDatabase(`note-editor-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
  draftDatabases.push(database);
  const store = new NotesDraftStore(new DexieNotesDraftPersistence(database));
  const saveNote = vi.fn().mockResolvedValue(response);
  const controller = new RealNotesAutosaveController({
    store,
    client: { saveNote },
    userId: 'student-1',
    debounceMs: 1,
    onlineEvents: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  return { controller, store, saveNote };
}

describe('personal note ProseMirror document contract', () => {
  it('serializes backend-valid table, formula, code, image, and attachment nodes', () => {
    const value = noteEditorSchema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'code_block', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1' }] },
        { type: 'math_display', attrs: { latex: 'E=mc^2' } },
        {
          type: 'table',
          content: [{
            type: 'table_row',
            content: [{
              type: 'table_cell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '单元格' }] }],
            }],
          }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'https://example.com/figure.png', alt: '示意图' } },
            createAttachmentReference({ id: 'attachment-1', label: '讲义.pdf', kind: 'file', mimeType: 'application/pdf' }),
          ],
        },
      ],
    }).toJSON();

    expect(value.content?.map((item: { type: string }) => item.type)).toEqual(['code_block', 'math_display', 'table', 'paragraph']);
    expect(value.content?.[3]?.content?.[1]).toMatchObject({
      type: 'attachment_reference',
      attrs: { attachmentId: 'attachment-1', label: '讲义.pdf' },
    });
  });

  it('schema-parses pasted HTML and rejects unsafe link and image schemes', () => {
    const parsed = parseNoteHtml(`
      <p><strong>保留</strong><script>alert(1)</script>
      <a href="javascript:alert(1)">危险链接</a>
      <a href="https://example.com/safe">安全链接</a>
      <img src="data:image/png;base64,abc">
      <img src="https://example.com/safe.png" alt="安全图片"></p>
    `).toJSON();
    const paragraph = parsed.content?.[0];
    const serialized = JSON.stringify(parsed);

    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('<script>');
    expect(paragraph?.content?.some((item: { type: string; attrs?: { src?: string } }) => item.type === 'image' && item.attrs?.src === 'https://example.com/safe.png')).toBe(true);
    expect(serialized).toContain('https://example.com/safe');
  });

  it('sanitizes unsafe schemes in recovered JSON drafts', () => {
    const recovered = parseNoteDocument({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '危险', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
          { type: 'image', attrs: { src: 'file:///etc/passwd' } },
          { type: 'text', text: '安全', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        ],
      }],
    }).toJSON();
    const serialized = JSON.stringify(recovered);

    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('file:');
    expect(serialized).toContain('https://example.com');
    expect(serialized).toContain('危险');
  });
});

describe('document-first note editor lifecycle and save state', () => {
  it('keeps one dominant editor view, emits JSON to autosave, and destroys it on note switch and unmount', async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const autosave = autosaveStub(schedule);
    const client = {} as NotesClient;
    const views: EditorView[] = [];
    const container = mount(
      <NoteEditor note={note()} client={client} autosave={autosave} attachments={[]} onEditorReady={(view) => views.push(view)} />,
    );

    expect(container.querySelector('[data-testid="note-editor-canvas"]')?.className).toContain('min-h-');
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1);
    const first = views[0]!;
    const firstDestroy = vi.spyOn(first, 'destroy');
    act(() => first.dispatch(first.state.tr.insertText('新内容')));
    await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
    expect(schedule.mock.calls.at(-1)?.[0]).toMatchObject({
      noteId: 'note-1',
      baseVersion: 3,
      content: { type: 'doc' },
    });
    expect(JSON.stringify(schedule.mock.calls.at(-1)?.[0].content)).not.toContain('<p>');

    const equivalentAutosave = autosaveStub();
    act(() => root!.render(
      <NoteEditor note={{ ...note() }} client={client} autosave={equivalentAutosave} attachments={[]} onEditorReady={(next) => views.push(next)} />,
    ));
    expect(views).toHaveLength(1);
    expect(firstDestroy).not.toHaveBeenCalled();
    expect(first.state.doc.textContent).toContain('新内容');

    act(() => root!.render(
      <NoteEditor note={note('note-2')} client={client} autosave={equivalentAutosave} attachments={[]} onEditorReady={(view) => views.push(view)} />,
    ));
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1);
    expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('未修改');

    const secondDestroy = vi.spyOn(views[1]!, 'destroy');
    act(() => root!.unmount());
    root = null;
    expect(secondDestroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['saving', '正在保存'],
    ['saved', '已保存'],
    ['offline', '离线待同步'],
    ['conflict', '存在冲突'],
  ] as const)('shows truthful %s state in the compact toolbar', (saveState, label) => {
    const container = mount(
      <NoteEditor
        note={note()}
        client={{} as NotesClient}
        autosave={autosaveStub()}
        attachments={[]}
        saveState={saveState}
      />,
    );
    expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain(label);
    if (saveState === 'offline') expect(container.textContent).toContain('重试');
  });

  it('offers local draft recovery explicitly instead of replacing server content', () => {
    const schedule = vi.fn();
    const container = mount(
      <NoteEditor
        note={note()}
        client={{} as NotesClient}
        autosave={autosaveStub(schedule)}
        attachments={[]}
        recoverableDraft={{ noteId: 'note-1', content: doc('本地草稿'), baseVersion: 2, clientMutationId: 'draft-1', updatedAt: now }}
      />,
    );
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('进程与线程');
    expect(container.textContent).toContain('发现本地草稿');
    clickByName('恢复草稿');
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('本地草稿');
  });

  it('renders formulas with KaTeX while preserving LaTeX in editor JSON', () => {
    const formulaNote = { ...note(), content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'math_inline', attrs: { latex: 'E=mc^2' } }] },
      { type: 'math_display', attrs: { latex: 'x^2+y^2=z^2' } },
    ] } };
    const views: EditorView[] = [];
    const container = mount(<NoteEditor note={formulaNote} client={{} as NotesClient} autosave={autosaveStub()} attachments={[]} onEditorReady={(view) => views.push(view)} />);

    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(views[0]?.state.doc.toJSON()).toMatchObject({
      content: [
        { content: [{ type: 'math_inline', attrs: { latex: 'E=mc^2' } }] },
        { type: 'math_display', attrs: { latex: 'x^2+y^2=z^2' } },
      ],
    });
  });

  it('does not carry one note save lifecycle state into another note', () => {
    let listener: ((event: { type: 'scheduled'; noteId: string; clientMutationId: string }) => void) | undefined;
    const firstAutosave = {
      schedule: vi.fn(), flush: vi.fn(),
      subscribe: vi.fn((_noteId: string, next: typeof listener) => { listener = next; return () => undefined; }),
    } as unknown as NotesAutosaveController;
    const container = mount(<NoteEditor note={note()} client={{} as NotesClient} autosave={firstAutosave} attachments={[]} />);
    act(() => listener?.({ type: 'scheduled', noteId: 'note-1', clientMutationId: 'mutation-1' }));
    expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('等待保存');

    act(() => root!.render(<NoteEditor note={note('note-2')} client={{} as NotesClient} autosave={autosaveStub()} attachments={[]} />));
    expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('未修改');
  });

  it('does not show saved for an older ACK while a newer mutation remains pending', () => {
    let listener: ((event: AutosaveEvent) => void) | undefined;
    const autosave = {
      schedule: vi.fn(), flush: vi.fn(),
      subscribe: vi.fn((_noteId: string, next: typeof listener) => { listener = next; return () => undefined; }),
    } as unknown as NotesAutosaveController;
    const container = mount(<NoteEditor note={note()} client={{} as NotesClient} autosave={autosave} attachments={[]} />);

    act(() => listener?.({ type: 'scheduled', noteId: 'note-1', clientMutationId: 'new' }));
    act(() => listener?.({
      type: 'saved', noteId: 'note-1', resultingVersion: 4, idempotent: false, pendingMutationId: 'new',
    }));

    expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('等待保存');
    expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).not.toContain('已保存');
  });

  it('derives saved and conflict states from real autosave outcomes', async () => {
    const savedSetup = realAutosave({ success: true, note: note('note-1', 4), resultingVersion: 4, idempotent: false });
    const savedViews: EditorView[] = [];
    const container = mount(<NoteEditor note={note()} client={{} as NotesClient} autosave={savedSetup.controller} draftStore={savedSetup.store} attachments={[]} onEditorReady={(view) => savedViews.push(view)} />);
    act(() => savedViews[0]!.dispatch(savedViews[0]!.state.tr.insertText('已保存内容')));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('已保存'));

    act(() => root!.unmount());
    root = null;
    savedSetup.controller.dispose();

    const serverNote = { ...note('note-2', 4), content: doc('服务器版本') };
    const conflictSetup = realAutosave({ success: false, status: 409, code: 'note_version_conflict', error: '版本冲突', serverVersion: 4, serverNote });
    const conflictViews: EditorView[] = [];
    const conflictContainer = mount(<NoteEditor note={note('note-2')} client={{ createNote: vi.fn() } as unknown as NotesClient} autosave={conflictSetup.controller} draftStore={conflictSetup.store} attachments={[]} onEditorReady={(view) => conflictViews.push(view)} />);
    act(() => conflictViews[0]!.dispatch(conflictViews[0]!.state.tr.insertText('本地版本')));
    await vi.waitFor(() => expect(conflictContainer.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('存在冲突'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('笔记版本冲突'));
    conflictSetup.controller.dispose();
  });

  it('keeps the latest local document through ACK, equivalent rerender, and a later 409', async () => {
    const serverV5 = { ...note('note-1', 5), content: doc('服务器 v5') };
    const setup = realAutosave(null);
    setup.saveNote
      .mockReset()
      .mockResolvedValueOnce({ success: true, note: note('note-1', 4), resultingVersion: 4, idempotent: false })
      .mockResolvedValueOnce({
        success: false,
        status: 409,
        code: 'note_version_conflict',
        error: '版本冲突',
        serverVersion: 5,
        serverNote: serverV5,
      });
    const createNote = vi.fn().mockResolvedValue({ success: true, note: note('copy-1', 1) });
    const client = { createNote } as unknown as NotesClient;
    const views: EditorView[] = [];
    const container = mount(
      <NoteEditor note={note()} client={client} autosave={setup.controller} draftStore={setup.store} attachments={[]} onEditorReady={(view) => views.push(view)} />,
    );
    const view = views[0]!;
    const replaceDocument = (text: string) => {
      const replacement = noteEditorSchema.nodeFromJSON(doc(text));
      act(() => view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, replacement.content)));
    };

    replaceDocument('编辑 A');
    await vi.waitFor(() => expect(container.querySelector('[data-testid="note-save-status"]')?.textContent).toContain('已保存'));
    expect(setup.saveNote.mock.calls[0]?.[1]).toMatchObject({ baseVersion: 3, content: doc('编辑 A') });

    act(() => root!.render(
      <NoteEditor note={{ ...note() }} client={client} autosave={setup.controller} draftStore={setup.store} attachments={[]} onEditorReady={(next) => views.push(next)} />,
    ));
    expect(views).toEqual([view]);
    expect(view.state.doc.textContent).toBe('编辑 A');

    replaceDocument('编辑 B');
    await vi.waitFor(() => expect(setup.saveNote).toHaveBeenCalledTimes(2));
    expect(setup.saveNote.mock.calls[1]?.[1]).toMatchObject({ baseVersion: 4, content: doc('编辑 B') });
    await vi.waitFor(() => expect(document.body.textContent).toContain('笔记版本冲突'));
    clickByName('关闭');
    expect(document.querySelector('[aria-label="版本差异"]')).toBeNull();
    expect(document.querySelector('button[aria-label="重新打开冲突处理"]')).toBeTruthy();

    replaceDocument('编辑 C');
    clickByName('重新打开冲突处理');
    clickByName('查看差异');
    const localDiff = document.querySelector('[aria-label="版本差异"] section');
    expect(localDiff?.textContent).toContain('编辑 C');
    expect(localDiff?.textContent).not.toContain('编辑 B');
    expect(localDiff?.textContent).not.toContain('编辑 A');

    clickByName('保留为副本');
    await vi.waitFor(() => expect(createNote).toHaveBeenCalled());
    expect(createNote.mock.calls[0]?.[0].content).toMatchObject({ type: 'doc' });
    expect(JSON.stringify(createNote.mock.calls[0]?.[0].content)).toContain('编辑 C');
    expect(JSON.stringify(createNote.mock.calls[0]?.[0].content)).not.toContain('编辑 B');
    expect(JSON.stringify(createNote.mock.calls[0]?.[0].content)).not.toContain('编辑 A');
    setup.controller.dispose();
  });
});

describe('revision and conflict actions', () => {
  it('loads real revision history and restores only after explicit confirmation and server ACK', async () => {
    const listRevisions = vi.fn().mockResolvedValue({
      success: true,
      revisions: [{ id: 'revision-1', noteId: 'note-1', version: 2, source: 'manual', title: '旧标题', content: doc('旧内容'), contentText: '旧内容预览', createdAt: now }],
    });
    const restoreRevision = vi.fn().mockResolvedValue({ success: true, note: note('note-1', 4), resultingVersion: 4, idempotent: false });
    const restored = vi.fn();
    mount(<NoteHistoryDialog open note={note()} client={{ listRevisions, restoreRevision } as unknown as NotesClient} onOpenChange={() => undefined} onRestored={restored} />);
    await vi.waitFor(() => expect(document.body.textContent).toContain('旧内容预览'));
    clickByName('恢复此版本');
    expect(restoreRevision).not.toHaveBeenCalled();
    clickByName('确认恢复');
    await vi.waitFor(() => expect(restoreRevision).toHaveBeenCalledWith('note-1', 'revision-1', expect.objectContaining({ baseVersion: 3 })));
    expect(restored).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));
  });

  it('preserves a 409 draft and exposes exactly the three non-preselected conflict actions', async () => {
    const createNote = vi.fn().mockResolvedValue({ success: true, note: note('copy-1', 1) });
    const resolveNoteConflict = vi.fn().mockResolvedValue(undefined);
    const adopted = vi.fn();
    mount(
      <NoteConflictDialog
        open
        note={note()}
        localContent={doc('本地未保存内容')}
        serverNote={{ ...note('note-1', 4), content: doc('服务器内容') }}
        client={{ createNote } as unknown as NotesClient}
        draftStore={{ resolveNoteConflict } as never}
        onOpenChange={() => undefined}
        onAdoptServer={adopted}
      />,
    );
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-conflict-action]')];
    expect(actions.map((item) => item.textContent?.trim())).toEqual(['查看差异', '保留为副本', '采用服务器版本']);
    expect(actions.every((item) => item.getAttribute('aria-pressed') !== 'true')).toBe(true);

    clickByName('保留为副本');
    await vi.waitFor(() => expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ content: doc('本地未保存内容') })));
    await vi.waitFor(() => expect(document.body.textContent).toContain('已创建独立副本'));
    expect(resolveNoteConflict).not.toHaveBeenCalled();
    expect(adopted).not.toHaveBeenCalled();

    clickByName('采用服务器版本');
    expect(resolveNoteConflict).not.toHaveBeenCalled();
    clickByName('确认采用');
    await vi.waitFor(() => expect(resolveNoteConflict).toHaveBeenCalledWith('note-1', { kind: 'discard' }));
    expect(adopted).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));
  });
});

describe('note attachments', () => {
  const attachment: NoteAttachment = {
    id: 'attachment-1', noteId: 'note-1', kind: 'file', displayName: '讲义.pdf', mimeType: 'application/pdf',
    sizeBytes: 2048, parseStatus: 'failed', parseGeneration: 1, parseStartedAt: null,
    errorCode: 'parse_failed', errorMessage: '解析失败', createdAt: now, updatedAt: now,
  };

  it('uses compact rows with stream download, insert, retry, upload, link, and confirmed delete controls', async () => {
    const reparseAttachment = vi.fn().mockResolvedValue({ success: true, attachment: { ...attachment, parseStatus: 'pending' } });
    const deleteAttachment = vi.fn().mockResolvedValue({ success: true, deleted: true });
    const uploadAttachment = vi.fn().mockResolvedValue({ success: true, attachment });
    const createLinkAttachment = vi.fn().mockResolvedValue({ success: true, attachment: { ...attachment, id: 'link-1', kind: 'link' } });
    const inserted = vi.fn();
    const attachmentClient = { reparseAttachment, deleteAttachment, uploadAttachment, createLinkAttachment } as unknown as NotesClient;
    function AttachmentHarness() {
      const [values, setValues] = React.useState([attachment]);
      return <NoteAttachments noteId="note-1" attachments={values} client={attachmentClient} onInsert={inserted} onChange={setValues} />;
    }
    const container = mount(<AttachmentHarness />);
    const row = container.querySelector('[data-testid="note-attachment-row"]')!;
    expect(row.className).toContain('h-');
    expect(row.querySelector<HTMLAnchorElement>('a[download]')?.href).toContain('/api/a3/notes/attachments/attachment-1/download/');
    clickByName('插入附件引用');
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ type: 'attachment_reference' }));
    clickByName('重试解析');
    await vi.waitFor(() => expect(reparseAttachment).toHaveBeenCalledWith('attachment-1'));
    await vi.waitFor(() => expect(container.textContent).toContain('等待解析'));
    clickByName('删除附件');
    expect(deleteAttachment).not.toHaveBeenCalled();
    clickByName('确认删除');
    await vi.waitFor(() => expect(deleteAttachment).toHaveBeenCalledWith('attachment-1'));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(uploadAttachment).toHaveBeenCalledWith('note-1', file);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="note-attachment-row"]')?.textContent).toContain('讲义.pdf'));
    expect(container.querySelector('[data-testid="note-upload-row"]')).toBeNull();
    expect(container.textContent).not.toContain('100%');
  });

  it('shows a fixed-height truthful temporary upload row and a retry action after failure', async () => {
    let release: ((value: unknown) => void) | undefined;
    const uploadAttachment = vi.fn().mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const container = mount(<NoteAttachments noteId="note-1" attachments={[]} client={{ uploadAttachment } as unknown as NotesClient} onInsert={() => undefined} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['draft'], '草稿.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));

    const temporary = container.querySelector('[data-testid="note-upload-row"]');
    expect(temporary?.className).toContain('h-12');
    expect(temporary?.textContent).toContain('草稿.txt');
    expect(temporary?.textContent).toContain('上传中');
    expect(temporary?.textContent).not.toContain('100%');

    await act(async () => release?.({ success: false, error: '网络中断' }));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="note-upload-row"]')?.textContent).toContain('上传失败'));
    expect(container.querySelector('button[aria-label="重试上传"]')).toBeTruthy();
  });

  it('uses newer server attachment props after a local reparse action', async () => {
    const pending = { ...attachment, parseStatus: 'pending' as const };
    const succeeded = { ...attachment, parseStatus: 'succeeded' as const, parseGeneration: 2 };
    const reparseAttachment = vi.fn().mockResolvedValue({ success: true, attachment: pending });
    const client = { reparseAttachment } as unknown as NotesClient;
    const renderAttachments = (value: NoteAttachment[]) => (
      <NoteAttachments noteId="note-1" attachments={value} client={client} onInsert={() => undefined} onChange={() => undefined} />
    );
    const container = mount(renderAttachments([attachment]));
    clickByName('重试解析');
    await act(async () => vi.waitFor(() => expect(reparseAttachment).toHaveBeenCalled()));
    await act(async () => vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="删除附件"]')?.disabled).toBe(false)));
    act(() => root!.render(renderAttachments([succeeded])));

    expect(container.textContent).toContain('已解析');
    expect(container.textContent).not.toContain('解析失败');
  });

  it('keeps overlapping upload and link successes when they complete out of order', async () => {
    let releaseUpload: ((value: unknown) => void) | undefined;
    let releaseLink: ((value: unknown) => void) | undefined;
    const uploaded = { ...attachment, id: 'upload-1', displayName: '并发上传.txt', parseStatus: 'pending' as const };
    const linked = { ...attachment, id: 'link-1', kind: 'link' as const, displayName: '并发链接', parseStatus: 'succeeded' as const };
    const uploadAttachment = vi.fn(() => new Promise((resolve) => { releaseUpload = resolve; }));
    const createLinkAttachment = vi.fn(() => new Promise((resolve) => { releaseLink = resolve; }));
    const client = { uploadAttachment, createLinkAttachment } as unknown as NotesClient;
    function AttachmentHarness() {
      const [values, setValues] = React.useState<NoteAttachment[]>([]);
      return <NoteAttachments noteId="note-1" attachments={values} client={client} onInsert={() => undefined} onChange={setValues} />;
    }
    const container = mount(<AttachmentHarness />);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['concurrent'], '并发上传.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    clickByName('链接');
    changeInput(container.querySelector<HTMLInputElement>('input[aria-label="链接地址"]')!, 'https://example.com/reference');
    changeInput(container.querySelector<HTMLInputElement>('input[aria-label="链接名称"]')!, '并发链接');
    clickByName('添加');
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(createLinkAttachment).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseLink?.({ success: true, attachment: linked });
      await Promise.resolve();
      releaseUpload?.({ success: true, attachment: uploaded });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.querySelectorAll('[data-testid="note-attachment-row"]')).toHaveLength(2));
    expect(container.textContent).toContain('并发上传.txt');
    expect(container.textContent).toContain('并发链接');
  });
});

describe('personal notes route and responsive workspace', () => {
  const notebook = { id: 'book-1', name: '课程笔记', sortOrder: 0, isArchived: false, noteCount: 1, createdAt: now, updatedAt: now };
  const tag = { id: 'tag-1', name: '期末复习', color: '#2563eb', createdAt: now, updatedAt: now };

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    window.history.replaceState(null, '', '/');
  });

  it('assembles the top-level notes route and creates the first real note from the empty state', async () => {
    expect(React.isValidElement(NotesPage())).toBe(true);
    const client = workspaceClient();
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(container.textContent).toContain('还没有笔记'));
    clickByName('新建笔记');

    await vi.waitFor(() => expect(client.createNote).toHaveBeenCalledWith({ title: '无标题笔记' }));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="note-editor-canvas"]')).toBeTruthy());
  });

  it('uses editor-dominant desktop tracks and does not render a Phase 1 AI rail', async () => {
    const client = workspaceClient({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [note()] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(container.querySelector('[data-testid="notes-workspace"]')).toBeTruthy());
    expect(container.querySelector('[data-testid="notes-workspace"]')?.className).toContain('min-[1028px]:grid-cols-[220px_minmax(560px,1fr)]');
    expect(container.querySelector('[data-testid="notes-workspace"]')?.className).not.toContain('md:grid-cols');
    expect(container.querySelector('[data-testid="notes-editor-pane"]')?.className).toContain('min-h-0');
    expect(container.querySelector('[data-testid="notes-editor-pane"]')?.className).toContain('[&>section]:!min-h-0');
    expect(container.querySelector('[data-testid="notes-ai-rail"]')).toBeNull();
    expect(container.querySelector('[data-page-card]')).toBeNull();
  });

  it('keeps 1027px tablets in a single view and enables two columns at 1028px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1027 });
    const client = workspaceClient({ searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [note()] }) });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view="list"]')).toBeTruthy());
    expect(container.querySelector('[data-notes-mobile-view="editor"]')).toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1028 });
    act(() => window.dispatchEvent(new Event('resize')));
    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view]')).toBeNull());
  });

  it('loads persisted attachments on initial load and each note switch', async () => {
    const first = note('note-1');
    const second = { ...note('note-2'), title: '第二篇笔记' };
    const attachmentFor = (noteId: string) => ({
      id: `attachment-${noteId}`, noteId, kind: 'file' as const, displayName: `${noteId}.txt`, mimeType: 'text/plain',
      sizeBytes: 4, parseStatus: 'succeeded' as const, parseGeneration: 1, parseStartedAt: null,
      errorCode: '', errorMessage: '', createdAt: now, updatedAt: now,
    });
    const client = workspaceClient({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [first, second] }),
      getNote: vi.fn(async (noteId: string) => ({ success: true as const, note: noteId === first.id ? first : second })),
      listAttachments: vi.fn(async (noteId: string) => ({ success: true as const, attachments: [attachmentFor(noteId)] })),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(client.listAttachments).toHaveBeenCalledWith('note-1', expect.anything()));
    clickByName('附件');
    await vi.waitFor(() => expect(container.textContent).toContain('note-1.txt'));
    clickByName('第二篇笔记');
    await vi.waitFor(() => expect(client.listAttachments).toHaveBeenCalledWith('note-2', expect.anything()));
    await vi.waitFor(() => expect(container.textContent).toContain('note-2.txt'));
    expect(container.textContent).not.toContain('note-1.txt');
  });

  it('ignores a stale note detail response after a newer selection resolves', async () => {
    const first = { ...note('note-1'), title: '较慢笔记' };
    const second = { ...note('note-2'), title: '最新笔记' };
    const slow = deferred<{ success: true; note: NoteDetail }>();
    const fast = deferred<{ success: true; note: NoteDetail }>();
    const getNote = vi.fn((noteId: string) => noteId === first.id ? slow.promise : fast.promise);
    const client = workspaceClient({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [first, second] }),
      getNote,
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith('note-1', expect.anything()));
    clickByName('最新笔记');
    fast.resolve({ success: true, note: second });
    await vi.waitFor(() => expect(container.textContent).toContain('最新笔记'));
    slow.resolve({ success: true, note: first });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).toContain('最新笔记');
    expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).not.toContain('较慢笔记');
  });

  it('ignores a stale filtered list after a newer filter resolves', async () => {
    const notebookResult = deferred<{ success: true; notes: NoteDetail[] }>();
    const tagResult = deferred<{ success: true; notes: NoteDetail[] }>();
    const initial = { ...note('initial'), title: '初始笔记' };
    const oldFiltered = { ...note('old-filter'), title: '过期列表结果' };
    const latestFiltered = { ...note('latest-filter'), title: '最新列表结果' };
    const searchNotes = vi.fn((query: URLSearchParams) => {
      if (query.has('notebookId')) return notebookResult.promise;
      if (query.has('tag')) return tagResult.promise;
      return Promise.resolve({ success: true as const, notes: [initial] });
    });
    const client = workspaceClient({
      listNotebooks: vi.fn().mockResolvedValue({ success: true, notebooks: [notebook] }),
      listTags: vi.fn().mockResolvedValue({ success: true, tags: [tag] }),
      searchNotes,
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);
    await vi.waitFor(() => expect(container.textContent).toContain('初始笔记'));
    clickByName('课程笔记');
    await vi.waitFor(() => expect(searchNotes.mock.calls.some(([query]) => query.has('notebookId'))).toBe(true));
    clickByName('期末复习');
    tagResult.resolve({ success: true, notes: [latestFiltered] });
    await vi.waitFor(() => expect(container.textContent).toContain('最新列表结果'));
    notebookResult.resolve({ success: true, notes: [oldFiltered] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('最新列表结果');
    expect(container.textContent).not.toContain('过期列表结果');
  });

  it('retries the failed note id after selection changes', async () => {
    const first = { ...note('note-1'), title: '已加载笔记' };
    const second = { ...note('note-2'), title: '失败笔记' };
    const getNote = vi.fn()
      .mockResolvedValueOnce({ success: true, note: first })
      .mockResolvedValueOnce({ success: false, error: '第二篇加载失败' })
      .mockResolvedValueOnce({ success: true, note: second });
    const client = workspaceClient({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [first, second] }),
      getNote,
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);
    await vi.waitFor(() => expect(container.textContent).toContain('已加载笔记'));
    clickByName('失败笔记');
    await vi.waitFor(() => expect(container.textContent).toContain('第二篇加载失败'));
    clickByName('重试');
    await vi.waitFor(() => expect(getNote).toHaveBeenLastCalledWith('note-2', expect.anything()));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).toContain('失败笔记'));
  });

  it('retries the initially failed note id when no note has been selected yet', async () => {
    const first = { ...note('note-1'), title: '首次失败笔记' };
    const getNote = vi.fn()
      .mockResolvedValueOnce({ success: false, error: '首次加载失败' })
      .mockResolvedValueOnce({ success: true, note: first });
    const client = workspaceClient({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [first] }),
      getNote,
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(container.textContent).toContain('首次加载失败'));
    clickByName('重试');
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).toContain('首次失败笔记'));
  });

  it('shows an initialization error and retries IndexedDB startup', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('IndexedDB unavailable'))
      .mockResolvedValueOnce({ account: { kind: 'ready', warningRequired: false }, replay: [] });
    const autosave = { ...autosaveStub(), initialize } as unknown as NotesAutosaveController;
    const container = mount(<NotesWorkspace client={workspaceClient()} userId="student-1" autosave={autosave} />);

    await vi.waitFor(() => expect(container.textContent).toContain('本地草稿存储初始化失败'));
    clickByName('重试本地存储');
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container.textContent).toContain('还没有笔记'));
  });

  it('sends notebook and tag filters through the typed search client', async () => {
    const searchNotes = vi.fn().mockResolvedValue({ success: true, notes: [note()] });
    const client = workspaceClient({
      listNotebooks: vi.fn().mockResolvedValue({ success: true, notebooks: [notebook] }),
      listTags: vi.fn().mockResolvedValue({ success: true, tags: [tag] }),
      searchNotes,
    });
    mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);
    await vi.waitFor(() => expect(document.body.textContent).toContain('课程笔记'));

    clickByName('课程笔记');
    await vi.waitFor(() => expect(searchNotes.mock.calls.some(([query]) => query.toString().includes('notebookId=book-1'))).toBe(true));
    clickByName('期末复习');
    await vi.waitFor(() => expect(searchNotes.mock.calls.some(([query]) => query.toString().includes('tag=tag-1'))).toBe(true));
  });

  it('loads the trash smart view and restores through the backend client', async () => {
    const deleted = { ...note(), deletedAt: now };
    const searchNotes = vi.fn(async (query: URLSearchParams) => ({
      success: true as const,
      notes: query.toString().includes('view=trash') ? [deleted] : [],
    }));
    const restoreNote = vi.fn().mockResolvedValue({ success: true, note: { ...deleted, deletedAt: null } });
    mount(<NotesWorkspace client={workspaceClient({ searchNotes, restoreNote })} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(document.body.textContent).toContain('还没有笔记'));
    clickByName('回收站');
    await vi.waitFor(() => expect(document.body.textContent).toContain(deleted.title));
    clickByName('恢复笔记');
    await vi.waitFor(() => expect(restoreNote).toHaveBeenCalledWith('note-1'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('回收站为空'));
  });

  it('renders one mobile view, updates browser history, and restores list focus on back', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const client = workspaceClient({ searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [note()] }) });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view="list"]')).toBeTruthy());
    await vi.waitFor(() => expect(container.querySelector(`button[aria-label="${note().title}"]`)).toBeTruthy());
    expect(container.querySelector('[data-notes-mobile-view="editor"]')).toBeNull();
    clickByName(note().title);
    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view="editor"]')).toBeTruthy());
    expect(window.location.search).toContain('note=note-1');
    expect(container.querySelector('[data-notes-mobile-view="list"]')).toBeNull();

    clickByName('返回笔记列表');
    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view="list"]')).toBeTruthy());
    await vi.waitFor(() => expect(window.location.search).toBe(''));
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain(note().title));
  });

  it('returns a directly opened mobile note to the list without leaving a stale note query', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.history.replaceState(null, '', '/a3/notes?note=note-1');
    const client = workspaceClient({ searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [note()] }) });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} />);

    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view="editor"]')).toBeTruthy());
    clickByName('返回笔记列表');
    await vi.waitFor(() => expect(container.querySelector('[data-notes-mobile-view="list"]')).toBeTruthy());
    expect(window.location.search).toBe('');
  });

  it('offers the real IndexedDB draft after the workspace reloads a note', async () => {
    const recoverable = { noteId: 'note-1', content: doc('离线草稿'), baseVersion: 2, clientMutationId: 'offline-1', updatedAt: now };
    const draftStore = { getDraft: vi.fn().mockResolvedValue(recoverable) } as unknown as NotesDraftStore;
    const client = workspaceClient({ searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [note()] }) });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} draftStore={draftStore} />);

    await vi.waitFor(() => expect(container.textContent).toContain('发现本地草稿'));
    expect(draftStore.getDraft).toHaveBeenCalledWith('note-1');
  });
});
