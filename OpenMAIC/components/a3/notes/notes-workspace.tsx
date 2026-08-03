'use client';

import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { Button } from '@/components/ui/button';
import { NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import { NotesClient } from '@/lib/a3/notes/client';
import { NotesDraftStore, type PersistableNoteDraft } from '@/lib/a3/notes/draft-store';
import type { NoteAiCitation, NoteAttachment, NoteDetail, NoteNotebook, NoteSummary, NoteTag } from '@/lib/a3/notes/types';
import { NoteAiDrawer } from './note-ai-drawer';
import { NoteEditor } from './note-editor';
import { NotesNavigation, type NotesSmartView } from './notes-navigation';

interface NotesWorkspaceProps {
  client?: NotesClient;
  userId?: string;
  draftStore?: NotesDraftStore;
  autosave?: NotesAutosaveController;
  onEditorReady?: (view: EditorView) => void;
}

type WorkspaceLoadState = 'loading' | 'ready' | 'error';
type PersistenceState = 'loading' | 'ready' | 'error';

export function NotesWorkspace({ client: providedClient, userId: providedUserId, draftStore: providedDraftStore, autosave: providedAutosave, onEditorReady }: NotesWorkspaceProps = {}) {
  const user = useA3CurrentUser();
  const userId = providedUserId ?? user?.id ?? '';
  const [client] = useState(() => providedClient ?? new NotesClient());
  const [draftStore] = useState(() => providedDraftStore ?? new NotesDraftStore());
  const [autosave] = useState(() => providedAutosave ?? new NotesAutosaveController({ store: draftStore, client, userId }));
  const ownsAutosave = !providedAutosave;
  const [initialized, setInitialized] = useState(false);
  const [persistenceState, setPersistenceState] = useState<PersistenceState>('loading');
  const [persistenceError, setPersistenceError] = useState('');
  const [accountSwitchRequired, setAccountSwitchRequired] = useState(false);
  const [notebooks, setNotebooks] = useState<NoteNotebook[]>([]);
  const [tags, setTags] = useState<NoteTag[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selectedNote, setSelectedNote] = useState<NoteDetail | null>(null);
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
  const [recoverableDraft, setRecoverableDraft] = useState<PersistableNoteDraft>();
  const [view, setView] = useState<NotesSmartView>('recent');
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [listState, setListState] = useState<WorkspaceLoadState>('loading');
  const [editorState, setEditorState] = useState<WorkspaceLoadState>('ready');
  const [error, setError] = useState('');
  const [editorError, setEditorError] = useState('');
  const [failedNoteId, setFailedNoteId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list');
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const noteButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectedNoteIdRef = useRef<string | null>(null);
  const noteLoadGeneration = useRef(0);
  const listLoadGeneration = useRef(0);
  const noteAbortController = useRef<AbortController | null>(null);
  const listAbortController = useRef<AbortController | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingCitation = useRef<NoteAiCitation | null>(null);

  useEffect(() => {
    selectedNoteIdRef.current = selectedNote?.id ?? null;
  }, [selectedNote?.id]);

  const initializePersistence = useCallback(async () => {
    setPersistenceState('loading');
    setPersistenceError('');
    setInitialized(false);
    try {
      const { account } = await autosave.initialize();
      if (account.warningRequired) {
        setAccountSwitchRequired(true);
        setPersistenceState('ready');
        return;
      }
      setAccountSwitchRequired(false);
      setPersistenceState('ready');
      setInitialized(true);
    } catch {
      setPersistenceState('error');
      setPersistenceError('本地草稿存储初始化失败，请重试');
    }
  }, [autosave]);

  useEffect(() => {
    const handle = window.setTimeout(() => void initializePersistence(), 0);
    return () => window.clearTimeout(handle);
  }, [initializePersistence]);

  useEffect(() => () => {
    noteLoadGeneration.current += 1;
    listLoadGeneration.current += 1;
    noteAbortController.current?.abort();
    listAbortController.current?.abort();
    if (ownsAutosave) autosave.dispose();
  }, [autosave, ownsAutosave]);

  useEffect(() => {
    const resize = () => {
      const mobile = window.innerWidth < 1028;
      setIsMobile(mobile);
      if (mobile) {
        setMobileView(new URL(window.location.href).searchParams.has('note') ? 'editor' : 'list');
      }
    };
    const frame = window.requestAnimationFrame(resize);
    window.addEventListener('resize', resize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    let alive = true;
    void Promise.all([client.listNotebooks(), client.listTags()]).then(([notebookResult, tagResult]) => {
      if (!alive) return;
      if (notebookResult.success) setNotebooks(notebookResult.notebooks);
      if (tagResult.success) setTags(tagResult.tags);
      if (!notebookResult.success || !tagResult.success) {
        setError(!notebookResult.success ? notebookResult.error : !tagResult.success ? tagResult.error : '笔记组织信息加载失败');
      }
    });
    return () => { alive = false; };
  }, [client, initialized]);

  const loadNote = useCallback(async (noteId: string) => {
    const generation = noteLoadGeneration.current + 1;
    noteLoadGeneration.current = generation;
    noteAbortController.current?.abort();
    const controller = new AbortController();
    noteAbortController.current = controller;
    setEditorState('loading');
    setEditorError('');
    setFailedNoteId(null);
    try {
      const [result, attachmentResult] = await Promise.all([
        client.getNote(noteId, { signal: controller.signal }),
        client.listAttachments(noteId, { signal: controller.signal }),
      ]);
      if (generation !== noteLoadGeneration.current || controller.signal.aborted) return;
      if (!result.success) {
        setEditorState('error');
        setEditorError(result.error);
        setFailedNoteId(noteId);
        return;
      }
      if (!attachmentResult.success) {
        setEditorState('error');
        setEditorError(attachmentResult.error);
        setFailedNoteId(noteId);
        return;
      }
      let draft: PersistableNoteDraft | undefined;
      try {
        draft = await draftStore.getDraft(noteId);
      } catch {
        if (generation !== noteLoadGeneration.current || controller.signal.aborted) return;
        setEditorState('error');
        setEditorError('本地草稿读取失败，请重试');
        setFailedNoteId(noteId);
        return;
      }
      if (generation !== noteLoadGeneration.current || controller.signal.aborted) return;
      setSelectedNote(result.note);
      setAttachments(attachmentResult.attachments);
      setRecoverableDraft(draft);
      setEditorState('ready');
    } catch (loadError) {
      if (generation !== noteLoadGeneration.current || isAbortError(loadError)) return;
      setEditorState('error');
      setEditorError('笔记加载失败，请重试');
      setFailedNoteId(noteId);
    }
  }, [client, draftStore]);

  const loadNotes = useCallback(async () => {
    if (!initialized) return;
    const generation = listLoadGeneration.current + 1;
    listLoadGeneration.current = generation;
    listAbortController.current?.abort();
    const controller = new AbortController();
    listAbortController.current = controller;
    setListState('loading');
    setError('');
    if (view === 'daily-summaries') {
      if (generation !== listLoadGeneration.current) return;
      setNotes([]);
      setSelectedNote(null);
      setListState('ready');
      return;
    }
    const query = new URLSearchParams();
    if (selectedNotebookId) query.set('notebookId', selectedNotebookId);
    else if (selectedTagId) query.set('tag', selectedTagId);
    else query.set('view', view);
    try {
      const result = await client.searchNotes(query, { signal: controller.signal });
      if (generation !== listLoadGeneration.current || controller.signal.aborted) return;
      if (!result.success) {
        setNotes([]);
        setListState('error');
        setError(result.error);
        return;
      }
      setNotes(result.notes);
      setListState('ready');
      const urlNoteId = typeof window === 'undefined' ? null : new URL(window.location.href).searchParams.get('note');
      const preferredId = urlNoteId ?? (!isMobile ? selectedNoteIdRef.current ?? result.notes[0]?.id : null);
      if (preferredId && result.notes.some((item) => item.id === preferredId) && view !== 'trash') {
        await loadNote(preferredId);
      } else if (!preferredId || !result.notes.some((item) => item.id === preferredId)) {
        noteLoadGeneration.current += 1;
        noteAbortController.current?.abort();
        setSelectedNote(null);
        setAttachments([]);
        setRecoverableDraft(undefined);
      }
    } catch (loadError) {
      if (generation !== listLoadGeneration.current || isAbortError(loadError)) return;
      setNotes([]);
      setListState('error');
      setError('笔记列表加载失败，请重试');
    }
  }, [client, initialized, isMobile, loadNote, selectedNotebookId, selectedTagId, view]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadNotes(), 0);
    return () => window.clearTimeout(handle);
  }, [loadNotes]);

  useEffect(() => {
    if (!isMobile) return;
    const popstate = () => {
      const noteId = new URL(window.location.href).searchParams.get('note');
      if (!noteId) {
        setMobileView('list');
        setFocusNoteId(selectedNoteIdRef.current);
        return;
      }
      setMobileView('editor');
      if (noteId !== selectedNoteIdRef.current) void loadNote(noteId);
    };
    window.addEventListener('popstate', popstate);
    return () => window.removeEventListener('popstate', popstate);
  }, [isMobile, loadNote]);

  useEffect(() => {
    if (mobileView !== 'list' || !focusNoteId) return;
    const frame = window.requestAnimationFrame(() => noteButtons.current.get(focusNoteId)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusNoteId, mobileView, notes]);

  const selectScope = (next: { view?: NotesSmartView; notebookId?: string; tagId?: string }) => {
    listLoadGeneration.current += 1;
    listAbortController.current?.abort();
    noteLoadGeneration.current += 1;
    noteAbortController.current?.abort();
    setView(next.view ?? 'recent');
    setSelectedNotebookId(next.notebookId ?? null);
    setSelectedTagId(next.tagId ?? null);
    setSelectedNote(null);
    setRecoverableDraft(undefined);
  };

  const openNote = async (item: NoteSummary) => {
    setFocusNoteId(item.id);
    if (view !== 'trash') await loadNote(item.id);
    if (isMobile && view !== 'trash') {
      const url = new URL(window.location.href);
      url.searchParams.set('note', item.id);
      window.history.pushState({ notesView: 'editor', noteId: item.id }, '', `${url.pathname}${url.search}${url.hash}`);
      setMobileView('editor');
    }
  };

  const returnToList = () => {
    setMobileView('list');
    setFocusNoteId(selectedNote?.id ?? focusNoteId);
    const url = new URL(window.location.href);
    if (!url.searchParams.has('note')) return;
    if (window.history.state?.notesView === 'editor') {
      window.history.back();
      return;
    }
    url.searchParams.delete('note');
    window.history.replaceState({ notesView: 'list' }, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const createNote = async () => {
    setFeedback('');
    const result = await client.createNote({ title: '无标题笔记' });
    if (!result.success) {
      setError(result.error);
      return;
    }
    setView('recent');
    setSelectedNotebookId(null);
    setSelectedTagId(null);
    setNotes((current) => [result.note, ...current.filter((item) => item.id !== result.note.id)]);
    setSelectedNote(result.note);
    setRecoverableDraft(undefined);
    setAttachments([]);
    setEditorState('ready');
    setFeedback('笔记已创建');
    if (isMobile) {
      const url = new URL(window.location.href);
      url.searchParams.set('note', result.note.id);
      window.history.pushState({ notesView: 'editor', noteId: result.note.id }, '', `${url.pathname}${url.search}${url.hash}`);
      setMobileView('editor');
    }
  };

  const deleteNote = async (item: NoteSummary) => {
    setBusyNoteId(item.id);
    const result = await client.deleteNote(item.id);
    setBusyNoteId(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setNotes((current) => current.filter((note) => note.id !== item.id));
    if (selectedNote?.id === item.id) setSelectedNote(null);
    setFeedback('笔记已移到回收站');
  };

  const restoreNote = async (item: NoteSummary) => {
    setBusyNoteId(item.id);
    const result = await client.restoreNote(item.id);
    setBusyNoteId(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setNotes((current) => current.filter((note) => note.id !== item.id));
    setFeedback('笔记已恢复');
  };

  const updateSelectedNote = (updated: NoteDetail) => {
    setSelectedNote(updated);
    setNotes((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  const revealCitation = useCallback((citation: NoteAiCitation) => {
    const view = editorViewRef.current;
    if (!view) return;
    const paragraphIndex = Math.max(0, citation.paragraphIndex ?? 0);
    let paragraphStart: number | null = null;
    let paragraphSize = 0;
    let precedingCharacters = 0;
    view.state.doc.forEach((node, offset, index) => {
      if (index === paragraphIndex && paragraphStart === null) {
        paragraphStart = offset + 1;
        paragraphSize = node.content.size;
      } else if (index < paragraphIndex) {
        precedingCharacters += node.textContent.length + 1;
      }
    });
    if (paragraphStart === null) return;
    const startOffset = Math.max(0, Math.min(paragraphSize, (citation.charStart ?? precedingCharacters) - precedingCharacters));
    const endOffset = Math.max(startOffset, Math.min(paragraphSize, (citation.charEnd ?? citation.charStart ?? precedingCharacters) - precedingCharacters));
    const from = Math.min(view.state.doc.content.size, paragraphStart + startOffset);
    const to = Math.min(view.state.doc.content.size, paragraphStart + endOffset);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).scrollIntoView());
    view.focus();
  }, []);

  const editorReady = useCallback((view: EditorView) => {
    editorViewRef.current = view;
    onEditorReady?.(view);
    const citation = pendingCitation.current;
    if (citation) {
      pendingCitation.current = null;
      window.requestAnimationFrame(() => revealCitation(citation));
    }
  }, [onEditorReady, revealCitation]);

  const navigateCitation = useCallback(async (citation: NoteAiCitation) => {
    if (!citation.noteId) return;
    if (citation.noteId === selectedNoteIdRef.current) {
      revealCitation(citation);
      return;
    }
    pendingCitation.current = citation;
    await loadNote(citation.noteId);
    if (isMobile) setMobileView('editor');
  }, [isMobile, loadNote, revealCitation]);

  const registerNoteButton = (noteId: string, element: HTMLButtonElement | null) => {
    if (element) noteButtons.current.set(noteId, element);
    else noteButtons.current.delete(noteId);
  };

  const navigation = (
    <NotesNavigation
      view={view}
      notebooks={notebooks}
      tags={tags}
      notes={notes}
      selectedNotebookId={selectedNotebookId}
      selectedTagId={selectedTagId}
      selectedNoteId={selectedNote?.id ?? null}
      loading={listState === 'loading'}
      error={error}
      busyNoteId={busyNoteId}
      onSelectView={(next) => selectScope({ view: next })}
      onSelectNotebook={(notebookId) => selectScope({ notebookId })}
      onSelectTag={(tagId) => selectScope({ tagId })}
      onSelectNote={(item) => void openNote(item)}
      onCreateNote={() => void createNote()}
      onDeleteNote={(item) => void deleteNote(item)}
      onRestoreNote={(item) => void restoreNote(item)}
      onRetry={() => void loadNotes()}
      noteButtonRef={registerNoteButton}
    />
  );

  const editor = (
    <section data-testid="notes-editor-pane" className="flex h-full min-h-0 min-w-0 flex-col bg-background [&>section]:!min-h-0 [&_[data-testid=note-editor-canvas]]:!min-h-0">
      {isMobile && (
        <div className="flex h-11 shrink-0 items-center border-b border-border/70 px-2">
          <Button type="button" variant="ghost" size="sm" className="rounded-md" aria-label="返回笔记列表" onClick={returnToList}>
            <ArrowLeft className="size-4" />返回
          </Button>
        </div>
      )}
      {selectedNote || editorState !== 'ready' ? (
        <NoteEditor
          note={selectedNote}
          client={client}
          autosave={autosave}
          draftStore={draftStore}
          attachments={attachments}
          recoverableDraft={recoverableDraft}
          loadState={editorState}
          loadError={editorError}
          onRetryLoad={() => failedNoteId && void loadNote(failedNoteId)}
          onNoteChange={updateSelectedNote}
          onAttachmentsChange={setAttachments}
          onEditorReady={editorReady}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FilePlus2 className="size-7 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">选择一篇笔记开始编辑</p>
          <Button type="button" size="sm" className="rounded-md" aria-label="在编辑区新建笔记" onClick={() => void createNote()}>新建笔记</Button>
        </div>
      )}
    </section>
  );

  if (persistenceState === 'error') {
    return (
      <section className="flex h-full items-center justify-center bg-background px-6 text-center" role="alert">
        <div className="max-w-md">
          <h1 className="font-semibold">本地草稿存储初始化失败</h1>
          <p className="mt-2 text-sm text-muted-foreground">{persistenceError || '无法打开本地草稿存储，请重试'}</p>
          <Button className="mt-4 rounded-md" onClick={() => void initializePersistence()}>重试本地存储</Button>
        </div>
      </section>
    );
  }

  if (persistenceState === 'loading') {
    return (
      <section className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground" aria-label="正在初始化本地草稿存储">
        正在准备笔记工作区...
      </section>
    );
  }

  if (accountSwitchRequired) {
    return (
      <section className="flex h-full items-center justify-center bg-background px-6 text-center" role="alert">
        <div className="max-w-md">
          <h1 className="font-semibold">发现其他账号的离线草稿</h1>
          <p className="mt-2 text-sm text-muted-foreground">为避免账号间草稿混用，需要确认清理其他账号的本地笔记后继续。</p>
          <Button className="mt-4 rounded-md" onClick={() => {
            void autosave.confirmAccountSwitch()
              .then(() => {
                setAccountSwitchRequired(false);
                setInitialized(true);
              })
              .catch(() => {
                setPersistenceState('error');
                setPersistenceError('本地草稿账号切换失败，请重试');
              });
          }}>清理并继续</Button>
        </div>
      </section>
    );
  }

  return (
    <div
      data-testid="notes-workspace"
      className="grid h-full min-h-0 min-w-0 bg-background min-[1028px]:grid-cols-[220px_minmax(560px,1fr)]"
    >
      <div className="hidden min-h-0 border-r border-border/70 min-[1028px]:block">{navigation}</div>
      <div className="hidden min-h-0 min-w-0 min-[1028px]:flex">
        <div className="min-h-0 min-w-0 flex-1">{editor}</div>
        <NoteAiDrawer client={client} currentNote={selectedNote} notes={notes} isMobile={false} onCitationNavigate={(citation) => void navigateCitation(citation)} />
      </div>
      {isMobile && mobileView === 'list' && <div data-notes-mobile-view="list" className="min-h-0 min-[1028px]:hidden">{navigation}</div>}
      {isMobile && mobileView === 'editor' && <div data-notes-mobile-view="editor" className="min-h-0 min-[1028px]:hidden">{editor}</div>}
      {isMobile && <NoteAiDrawer client={client} currentNote={selectedNote} notes={notes} isMobile onCitationNavigate={(citation) => void navigateCitation(citation)} />}
      <p className="sr-only" aria-live="polite">{feedback}</p>
    </div>
  );
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
