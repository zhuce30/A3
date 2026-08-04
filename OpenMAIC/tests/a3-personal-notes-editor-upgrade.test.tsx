// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';

import { NoteEditor } from '@/components/a3/notes/note-editor';
import type { NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import type { NotesClient } from '@/lib/a3/notes/client';
import { markdownToNoteDocument } from '@/lib/a3/notes/markdown-paste';
import type { NoteDetail } from '@/lib/a3/notes/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const note: NoteDetail = {
  id: 'note-1',
  title: '无标题笔记',
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  contentText: '',
  version: 3,
  notebook: null,
  tags: [],
  isPinned: false,
  lastEditedAt: '2026-08-04T08:00:00.000Z',
  deletedAt: null,
  createdAt: '2026-08-04T08:00:00.000Z',
  updatedAt: '2026-08-04T08:00:00.000Z',
};

function mountEditor(options: { client?: Partial<NotesClient>; schedule?: ReturnType<typeof vi.fn> } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const views: EditorView[] = [];
  const schedule = options.schedule ?? vi.fn().mockResolvedValue(undefined);
  const autosave = {
    schedule,
    flush: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as NotesAutosaveController;
  const client = options.client as NotesClient ?? ({} as NotesClient);
  act(() => root!.render(
    <NoteEditor
      note={note}
      client={client}
      autosave={autosave}
      attachments={[]}
      onEditorReady={(view) => views.push(view)}
    />,
  ));
  return { container, view: views[0]!, schedule };
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('personal notes editor usability upgrade', () => {
  it('converts pasted Markdown into headings, tables, lists, code, and KaTeX nodes', () => {
    const parsed = markdownToNoteDocument(`# 进程与线程

| 维度 | 进程 | 线程 |
| --- | --- | --- |
| 资源 | 独立 | 共享 |

- 进程强调隔离
- 线程强调执行

\`\`\`c
fork();
\`\`\`

行内公式 $T=nq$。

$$
S=\\sum_{i=1}^{n}t_i
$$`).toJSON();

    expect(parsed.content?.map((item: { type: string }) => item.type)).toEqual([
      'heading', 'table', 'bullet_list', 'code_block', 'paragraph', 'math_display',
    ]);
    expect(JSON.stringify(parsed)).toContain('math_inline');
    expect(JSON.stringify(parsed)).toContain('S=\\\\sum_{i=1}^{n}t_i');
  });

  it('edits the title in place through the versioned API without persisting it in offline drafts', async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const saveNote = vi.fn().mockResolvedValue({
      success: true,
      note: { ...note, title: '进程与线程复习', version: 4 },
      resultingVersion: 4,
      idempotent: false,
    });
    const { container } = mountEditor({ schedule, client: { saveNote } });
    const title = container.querySelector<HTMLInputElement>('input[aria-label="笔记标题"]')!;

    act(() => title.focus());
    setInputValue(title, '进程与线程复习');
    act(() => title.blur());

    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledWith('note-1', expect.objectContaining({
      title: '进程与线程复习',
      baseVersion: 3,
    })));
    expect(schedule).not.toHaveBeenCalled();
  });

  it('uploads a local image and inserts its owned preview URL into the document', async () => {
    const uploaded = {
      id: 'image-1', noteId: 'note-1', kind: 'image' as const, displayName: 'diagram.png', mimeType: 'image/png',
      sizeBytes: 8, parseStatus: 'pending' as const, parseGeneration: 1, parseStartedAt: null,
      errorCode: '', errorMessage: '', createdAt: note.createdAt, updatedAt: note.updatedAt,
    };
    const uploadAttachment = vi.fn().mockResolvedValue({ success: true, attachment: uploaded });
    const { container, view } = mountEditor({ client: { uploadAttachment } });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="从本地插入图片"]')!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'diagram.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));

    await vi.waitFor(() => expect(uploadAttachment).toHaveBeenCalledWith('note-1', file));
    await vi.waitFor(() => expect(JSON.stringify(view.state.doc.toJSON())).toContain(
      '/api/a3/notes/attachments/image-1/preview/',
    ));
  });

  it('inserts block LaTeX from a preview dialog instead of a browser prompt', () => {
    const prompt = vi.spyOn(window, 'prompt');
    const { container, view } = mountEditor();
    const formulaButton = container.querySelector<HTMLButtonElement>('button[aria-label="插入公式"]')!;
    act(() => formulaButton.click());
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="LaTeX 公式"]')!;
    setInputValue(textarea, 'E=mc^2');
    const displayButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '独立公式')!;
    act(() => displayButton.click());
    const insertButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '插入公式')!;
    act(() => insertButton.click());

    expect(prompt).not.toHaveBeenCalled();
    expect(view.state.doc.toJSON().content?.[0]).toMatchObject({ type: 'math_display', attrs: { latex: 'E=mc^2' } });
  });
});
