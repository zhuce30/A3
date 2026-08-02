// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';

import { NoteEditor } from '@/components/a3/notes/note-editor';
import { NoteAttachments } from '@/components/a3/notes/note-attachments';
import { NoteConflictDialog } from '@/components/a3/notes/note-conflict-dialog';
import { NoteHistoryDialog } from '@/components/a3/notes/note-history-dialog';
import {
  createAttachmentReference,
  noteEditorSchema,
  parseNoteDocument,
  parseNoteHtml,
} from '@/lib/a3/notes/editor-schema';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import type { NoteAttachment, NoteDetail } from '@/lib/a3/notes/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
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
    const autosave = { schedule, flush: vi.fn(), dispose: vi.fn() } as unknown as NotesAutosaveController;
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

    act(() => root!.render(
      <NoteEditor note={note('note-2')} client={client} autosave={autosave} attachments={[]} onEditorReady={(view) => views.push(view)} />,
    ));
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1);

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
        autosave={{ schedule: vi.fn() } as unknown as NotesAutosaveController}
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
        autosave={{ schedule } as unknown as NotesAutosaveController}
        attachments={[]}
        recoverableDraft={{ noteId: 'note-1', content: doc('本地草稿'), baseVersion: 2, clientMutationId: 'draft-1', updatedAt: now }}
      />,
    );
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('进程与线程');
    expect(container.textContent).toContain('发现本地草稿');
    clickByName('恢复草稿');
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('本地草稿');
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
    const container = mount(
      <NoteAttachments
        noteId="note-1"
        attachments={[attachment]}
        client={{ reparseAttachment, deleteAttachment, uploadAttachment, createLinkAttachment } as unknown as NotesClient}
        onInsert={inserted}
      />,
    );
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
    expect(container.textContent).not.toContain('100%');
  });
});
