'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { History, Paperclip, RefreshCw } from 'lucide-react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { Button } from '@/components/ui/button';
import { buildPlugins } from '@/lib/prosemirror/plugins';
import type { EditableNoteDraft, NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NotesDraftStore } from '@/lib/a3/notes/draft-store';
import type { NoteAttachment, NoteContent, NoteDetail } from '@/lib/a3/notes/types';
import { noteEditorSchema, parseNoteDocument } from '@/lib/a3/notes/editor-schema';
import { NoteAttachments } from './note-attachments';
import { NoteConflictDialog } from './note-conflict-dialog';
import { NoteEditorToolbar, type NoteSaveState } from './note-editor-toolbar';
import { NoteHistoryDialog } from './note-history-dialog';

interface NoteEditorProps {
  note: NoteDetail | null;
  client: NotesClient;
  autosave: NotesAutosaveController;
  attachments: NoteAttachment[];
  draftStore?: NotesDraftStore;
  saveState?: NoteSaveState;
  loadState?: 'loading' | 'ready' | 'error';
  loadError?: string;
  recoverableDraft?: EditableNoteDraft;
  conflictServerNote?: NoteDetail;
  onEditorReady?: (view: EditorView) => void;
  onNoteChange?: (note: NoteDetail) => void;
  onAttachmentsChange?: (attachments: NoteAttachment[]) => void;
  onRetryLoad?: () => void;
}

export function NoteEditor({
  note,
  client,
  autosave,
  attachments,
  draftStore,
  saveState,
  loadState = 'ready',
  loadError,
  recoverableDraft,
  conflictServerNote,
  onEditorReady,
  onNoteChange,
  onAttachmentsChange,
  onRetryLoad,
}: NoteEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const draftRef = useRef<EditableNoteDraft | null>(null);
  const baseVersionRef = useRef(note?.version ?? 0);
  const [view, setView] = useState<EditorView | null>(null);
  const selectedVersion = note ? `${note.id}:${note.version}` : '';
  const [contentSnapshot, setContentSnapshot] = useState({ selectedVersion, content: note?.content ?? {} });
  if (contentSnapshot.selectedVersion !== selectedVersion) {
    setContentSnapshot({ selectedVersion, content: note?.content ?? {} });
  }
  const [localSaveState, setLocalSaveState] = useState<NoteSaveState>('idle');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const conflictKey = conflictServerNote ? `${conflictServerNote.id}:${conflictServerNote.version}` : '';
  const [conflictVisibility, setConflictVisibility] = useState({ key: conflictKey, open: Boolean(conflictKey) });
  if (conflictVisibility.key !== conflictKey) {
    setConflictVisibility({ key: conflictKey, open: Boolean(conflictKey) });
  }

  useLayoutEffect(() => {
    if (!mountRef.current || !note || loadState !== 'ready') return;
    baseVersionRef.current = note.version;
    draftRef.current = null;
    const editorView = new EditorView(mountRef.current, {
      state: EditorState.create({
        schema: noteEditorSchema,
        doc: parseNoteDocument(note.content),
        plugins: buildPlugins(noteEditorSchema, { placeholder: '开始记录…' }),
      }),
      attributes: {
        'aria-label': `${note.title || '无标题笔记'}正文`,
        class: 'min-h-[34rem] w-full max-w-none px-5 py-8 text-[15px] leading-7 text-foreground outline-none sm:px-10 lg:px-16',
      },
      dispatchTransaction(transaction) {
        const nextState = editorView.state.apply(transaction);
        editorView.updateState(nextState);
        setView(editorView);
        if (!transaction.docChanged) return;
        const draft: EditableNoteDraft = {
          noteId: note.id,
          content: nextState.doc.toJSON() as NoteContent,
          baseVersion: baseVersionRef.current,
          clientMutationId: crypto.randomUUID(),
          updatedAt: new Date().toISOString(),
        };
        draftRef.current = draft;
        setContentSnapshot({ selectedVersion: `${note.id}:${baseVersionRef.current}`, content: draft.content });
        setLocalSaveState('saving');
        void autosave.schedule(draft);
      },
      transformPastedHTML(html) {
        return html;
      },
    });
    viewRef.current = editorView;
    setView(editorView);
    onEditorReady?.(editorView);
    return () => {
      if (viewRef.current === editorView) viewRef.current = null;
      setView((current) => current === editorView ? null : current);
      editorView.destroy();
    };
  }, [autosave, loadState, note, onEditorReady]);

  const retrySave = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    setLocalSaveState('saving');
    const result = await autosave.flush(current);
    if (result.kind === 'saved') {
      baseVersionRef.current = result.resultingVersion;
      setLocalSaveState('saved');
    } else if (result.kind === 'conflict') {
      setLocalSaveState('conflict');
      setConflictVisibility({ key: conflictKey, open: true });
    } else if (result.kind === 'queued') {
      setLocalSaveState('offline');
    } else if (result.kind === 'permanent-error') {
      setLocalSaveState('error');
    }
  }, [autosave, conflictKey]);

  const recoverDraft = () => {
    const current = viewRef.current;
    if (!current || !recoverableDraft || recoverableDraft.noteId !== note?.id) return;
    const recovered = parseNoteDocument(recoverableDraft.content);
    current.dispatch(current.state.tr.replaceWith(0, current.state.doc.content.size, recovered.content).scrollIntoView());
  };

  const insertAttachment = (nodeJson: Record<string, unknown>) => {
    const current = viewRef.current;
    if (!current) return;
    const node = noteEditorSchema.nodeFromJSON(nodeJson);
    current.dispatch(current.state.tr.replaceSelectionWith(node).scrollIntoView());
    current.focus();
  };

  if (loadState === 'loading') {
    return (
      <section className="min-h-[42rem] animate-pulse bg-background" aria-label="正在加载笔记">
        <div className="h-11 border-b border-border bg-muted/40" />
        <div className="mx-auto mt-12 h-4 w-2/3 rounded bg-muted" />
        <div className="mx-auto mt-5 h-4 w-1/2 rounded bg-muted" />
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <section className="flex min-h-[42rem] flex-col items-center justify-center gap-3 bg-background px-6 text-center" role="alert">
        <p className="font-medium text-foreground">笔记暂时无法加载</p>
        <p className="max-w-md text-sm text-muted-foreground">{loadError || '请检查网络后重试'}</p>
        {onRetryLoad && <Button variant="outline" onClick={onRetryLoad}><RefreshCw className="size-4" />重试</Button>}
      </section>
    );
  }

  if (!note) {
    return <section className="flex min-h-[42rem] items-center justify-center bg-background text-sm text-muted-foreground">选择一篇笔记开始编辑</section>;
  }

  return (
    <section className="flex min-h-[42rem] min-w-0 flex-col overflow-hidden bg-background text-foreground" aria-label="笔记编辑器">
      <div className="flex min-h-11 min-w-0 items-center justify-between gap-2 border-b border-border/70 bg-background px-3">
        <h2 className="min-w-0 truncate text-sm font-semibold">{note.title || '无标题笔记'}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="版本历史" onClick={() => setHistoryOpen(true)} className="size-8 rounded-md"><History className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="附件" aria-expanded={attachmentsOpen} onClick={() => setAttachmentsOpen((value) => !value)} className="size-8 rounded-md"><Paperclip className="size-4" /></Button>
        </div>
      </div>
      <NoteEditorToolbar view={view} saveState={saveState ?? localSaveState} onRetry={() => void retrySave()} />
      {recoverableDraft && recoverableDraft.noteId === note.id && (
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/35 dark:text-amber-100" role="status">
          <span>发现本地草稿</span>
          <Button size="sm" variant="outline" onClick={recoverDraft}>恢复草稿</Button>
        </div>
      )}
      {attachmentsOpen && (
        <NoteAttachments
          key={note.id}
          noteId={note.id}
          attachments={attachments}
          client={client}
          onInsert={insertAttachment}
          onChange={onAttachmentsChange}
        />
      )}
      <article
        data-testid="note-editor-canvas"
        className="min-h-[36rem] min-w-0 flex-1 overflow-y-auto bg-[linear-gradient(to_bottom,hsl(var(--background)),hsl(var(--background)))] [&_.ProseMirror>*]:mx-auto [&_.ProseMirror>*]:max-w-[46rem] [&_.ProseMirror_a]:text-foreground [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:decoration-amber-500/70 [&_.ProseMirror_a]:underline-offset-4 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-amber-400 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_code]:rounded-sm [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h3]:text-lg [&_.ProseMirror_img]:my-4 [&_.ProseMirror_img]:max-h-[32rem] [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:rounded-md [&_.ProseMirror_li]:ml-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_pre]:my-5 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:bg-muted [&_.ProseMirror_pre]:p-4 [&_.ProseMirror_table]:my-5 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:p-2 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:bg-muted [&_.ProseMirror_th]:p-2 [&_.ProseMirror_ul]:list-disc [&_[data-note-attachment-id]]:rounded-sm [&_[data-note-attachment-id]]:bg-amber-100 [&_[data-note-attachment-id]]:px-1.5 [&_[data-note-attachment-id]]:py-0.5 [&_[data-note-attachment-id]]:text-amber-950 dark:[&_[data-note-attachment-id]]:bg-amber-900/40 dark:[&_[data-note-attachment-id]]:text-amber-100 [&_[data-note-math-display]]:my-5 [&_[data-note-math-display]]:overflow-x-auto [&_[data-note-math-display]]:border-y [&_[data-note-math-display]]:border-border [&_[data-note-math-display]]:py-4 [&_[data-note-math-display]]:text-center [&_[data-note-math-inline]]:font-mono"
      >
        <div ref={mountRef} />
      </article>
      <NoteHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} note={note} client={client} onRestored={(restored) => { baseVersionRef.current = restored.version; onNoteChange?.(restored); }} />
      {draftStore && conflictServerNote && (
        <NoteConflictDialog
          open={conflictVisibility.open}
          onOpenChange={(open) => setConflictVisibility({ key: conflictKey, open })}
          note={note}
          localContent={contentSnapshot.content}
          serverNote={conflictServerNote}
          client={client}
          draftStore={draftStore}
          onAdoptServer={(server) => { baseVersionRef.current = server.version; onNoteChange?.(server); }}
        />
      )}
    </section>
  );
}
