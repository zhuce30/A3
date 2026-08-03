'use client';

import { Bot, Brain, CheckCircle2, ChevronDown, ChevronRight, FilePenLine, RefreshCw, Send, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NoteAiCitation, NoteAiMessage, NoteAiScopeInput, NoteAiSession, NoteDetail, NoteMemory, NoteSummary, NoteWritebackPreview } from '@/lib/a3/notes/types';
import type { NoteEditorSnapshotValidity } from './note-editor';
import { NoteMemoryManager } from './note-memory-manager';
import { NoteWritebackPreviewPanel } from './note-writeback-preview';

interface NoteAiDrawerProps {
  client: NotesClient;
  currentNote: NoteDetail | null;
  notes: NoteSummary[];
  editorSnapshot?: NoteEditorSnapshotValidity;
  isMobile: boolean;
  onCitationNavigate: (citation: NoteAiCitation) => void;
  onWritebackApplied?: (note: NoteDetail) => void;
}

type ScopeMode = 'note' | 'selection';
type DrawerPanel = 'conversation' | 'memory';

interface WritebackOperation {
  id: number;
  generation: number;
  scopeKey: string;
  targetNoteId: string;
  previewId?: string;
  targetVersion?: number;
}

export function NoteAiDrawer({ client, currentNote, notes, editorSnapshot, isMobile, onCitationNavigate, onWritebackApplied }: NoteAiDrawerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<DrawerPanel>('conversation');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('note');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<NoteAiSession[]>([]);
  const [activeSession, setActiveSession] = useState<NoteAiSession | null>(null);
  const [activeScopeKey, setActiveScopeKey] = useState('');
  const [messages, setMessages] = useState<NoteAiMessage[]>([]);
  const [knownMemories, setKnownMemories] = useState<NoteMemory[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendState, setSendState] = useState({ scopeKey: '', busy: false });
  const [error, setError] = useState('');
  const [disconnectedMessageId, setDisconnectedMessageId] = useState('');
  const [writebackPreview, setWritebackPreview] = useState<NoteWritebackPreview | null>(null);
  const [writebackPreviewScopeKey, setWritebackPreviewScopeKey] = useState('');
  const [writebackBusyOwner, setWritebackBusyOwner] = useState<WritebackOperation | null>(null);
  const [writebackError, setWritebackError] = useState('');
  const [writebackStale, setWritebackStale] = useState(false);
  const [writebackNeedsReask, setWritebackNeedsReask] = useState(false);
  const streamCleanup = useRef<(() => void) | null>(null);
  const watchedMessageId = useRef('');
  const operationAbort = useRef<AbortController | null>(null);
  const requestGeneration = useRef(0);
  const writebackOperationCounter = useRef(0);
  const writebackOperation = useRef<WritebackOperation | null>(null);
  const mounted = useRef(true);

  const scope = useMemo<NoteAiScopeInput | null>(() => {
    if (scopeMode === 'note') return currentNote ? { type: 'note', noteIds: [currentNote.id] } : null;
    return selectedNoteIds.length ? { type: 'selection', noteIds: selectedNoteIds } : null;
  }, [currentNote, scopeMode, selectedNoteIds]);
  const scopeKey = scope ? JSON.stringify(scope) : '';
  const writebackContext = useRef({ scopeKey, targetNoteId: currentNote?.id ?? '' });
  const writebackPreviewRef = useRef(writebackPreview);
  const scopedActiveSession = activeScopeKey === scopeKey ? activeSession : null;
  const scopedMessages = activeScopeKey === scopeKey ? messages : [];
  const sending = (
    sendState.scopeKey === scopeKey
    && sendState.busy
  ) || scopedMessages.some((message) => (
    message.role === 'assistant' && (message.status === 'queued' || message.status === 'streaming')
  ));
  const writebackBusy = Boolean(
    writebackBusyOwner
    && writebackBusyOwner.scopeKey === scopeKey
    && writebackBusyOwner.targetNoteId === currentNote?.id,
  );
  const scopedSessions = sessions.filter((session) => {
    const sessionScopeKey = scopeKeyForSnapshot(session);
    return !sessionScopeKey || sessionScopeKey === scopeKey;
  });
  const writebackSource = [...scopedMessages].reverse().find((message) => (
    message.role === 'assistant' && message.status === 'succeeded' && Boolean(message.content.trim())
  ));
  const effectiveEditorSnapshot = useMemo<NoteEditorSnapshotValidity>(() => editorSnapshot ?? ({
    noteId: currentNote?.id ?? null,
    baseVersion: currentNote?.version ?? null,
    dirty: false,
    pending: false,
    conflicted: false,
  }), [currentNote?.id, currentNote?.version, editorSnapshot]);
  const getWritebackEditorIssue = (targetNoteId: string, targetVersion: number) => {
    const currentVersion = currentNote?.version;
    if (effectiveEditorSnapshot.conflicted) {
      return { blocked: true, stale: false, message: '请先解决笔记冲突，再生成/确认写回建议' };
    }
    if (
      effectiveEditorSnapshot.dirty
      || effectiveEditorSnapshot.pending
      || effectiveEditorSnapshot.noteId !== targetNoteId
      || currentNote?.id !== targetNoteId
      || currentVersion === undefined
      || effectiveEditorSnapshot.baseVersion !== currentVersion
    ) {
      return { blocked: true, stale: false, message: '请先等待笔记保存完成，再生成/确认写回建议' };
    }
    if (currentVersion !== targetVersion) {
      return { blocked: true, stale: true, message: '正文已保存为新版本，请重新生成写回建议' };
    }
    return { blocked: false, stale: false, message: '' };
  };
  const previewEditorIssue = writebackPreview
    ? getWritebackEditorIssue(writebackPreview.targetNote.id, writebackPreview.targetVersion)
    : { blocked: false, stale: false, message: '' };
  const writebackEditorContext = useRef({
    currentNoteId: currentNote?.id ?? '',
    currentNoteVersion: currentNote?.version ?? null,
    snapshot: effectiveEditorSnapshot,
  });

  useLayoutEffect(() => {
    writebackContext.current = { scopeKey, targetNoteId: currentNote?.id ?? '' };
    writebackPreviewRef.current = writebackPreview;
    writebackEditorContext.current = {
      currentNoteId: currentNote?.id ?? '',
      currentNoteVersion: currentNote?.version ?? null,
      snapshot: effectiveEditorSnapshot,
    };
  }, [
    currentNote?.id,
    currentNote?.version,
    effectiveEditorSnapshot,
    scopeKey,
    writebackPreview,
  ]);

  const invalidateAsync = useCallback(() => {
    requestGeneration.current += 1;
    operationAbort.current?.abort();
    operationAbort.current = null;
    streamCleanup.current?.();
    streamCleanup.current = null;
    watchedMessageId.current = '';
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => invalidateAsync(), [invalidateAsync, scopeKey]);

  useEffect(() => {
    if (!open) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    void client.listAiSessions().then(async (result) => {
      if (generation !== requestGeneration.current) return;
      if (!result.success) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setSessions(result.sessions);
      const session = result.sessions.find((item) => {
        const sessionScopeKey = scopeKeyForSnapshot(item);
        return !sessionScopeKey || sessionScopeKey === scopeKey;
      }) ?? null;
      setMessages([]);
      setActiveSession(session);
      setActiveScopeKey(session ? scopeKey : '');
      if (!session) {
        setMessages([]);
        setLoading(false);
        return;
      }
      const messageResult = await client.listAiMessages(session.id);
      if (generation !== requestGeneration.current) return;
      if (!messageResult.success) setError(messageResult.error);
      else setMessages(messageResult.messages);
      setLoading(false);
    });
  }, [client, open, scopeKey]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void client.listMemories().then((result) => {
      if (active && result.success) setKnownMemories(result.memories);
    });
    return () => { active = false; };
  }, [client, open]);

  const updateMessage = useCallback((message: NoteAiMessage) => {
    setMessages((current) => {
      const exists = current.some((item) => item.id === message.id);
      return exists ? current.map((item) => item.id === message.id ? message : item) : [...current, message];
    });
    if (message.status === 'succeeded' || message.status === 'failed') {
      setDisconnectedMessageId('');
      setSendState((current) => ({ ...current, busy: false }));
    }
  }, []);

  const watchMessage = useCallback((messageId: string) => {
    if (watchedMessageId.current === messageId) return;
    const generation = requestGeneration.current;
    streamCleanup.current?.();
    watchedMessageId.current = messageId;
    streamCleanup.current = client.watchAiMessage(messageId, {
      onMessage: (message) => {
        if (generation !== requestGeneration.current) return;
        updateMessage(message);
        if (message.status === 'succeeded' || message.status === 'failed') {
          watchedMessageId.current = '';
          streamCleanup.current = null;
        }
      },
      onDisconnect: () => {
        if (generation === requestGeneration.current) setDisconnectedMessageId(messageId);
      },
      onError: (message) => {
        if (generation !== requestGeneration.current) return;
        watchedMessageId.current = '';
        streamCleanup.current = null;
        setError(message);
        setSendState({ scopeKey, busy: false });
      },
    });
  }, [client, scopeKey, updateMessage]);

  useEffect(() => {
    if (!open || activeScopeKey !== scopeKey) return;
    const pending = [...messages].reverse().find((message) => (
      message.role === 'assistant' && (message.status === 'queued' || message.status === 'streaming')
    ));
    if (pending) watchMessage(pending.id);
  }, [activeScopeKey, messages, open, scopeKey, watchMessage]);

  const submit = async (rawPrompt: string, options: { forceNewSession?: boolean } = {}) => {
    const messageText = rawPrompt.trim();
    if (!messageText || !scope || sending) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    operationAbort.current?.abort();
    const controller = new AbortController();
    operationAbort.current = controller;
    streamCleanup.current?.();
    streamCleanup.current = null;
    watchedMessageId.current = '';
    setSendState({ scopeKey, busy: true });
    setError('');
    setDisconnectedMessageId('');
    let session = options.forceNewSession ? null : scopedActiveSession;
    try {
      if (!session) {
        const sessionResult = await client.createAiSession(
          { title: messageText.slice(0, 80), scope },
          { signal: controller.signal },
        );
        if (generation !== requestGeneration.current || controller.signal.aborted) return;
        if (!sessionResult.success) {
          setError(sessionResult.error);
          setSendState({ scopeKey, busy: false });
          return;
        }
        session = sessionResult.session;
        setSessions((current) => [session!, ...current.filter((item) => item.id !== session!.id)]);
        setActiveSession(session);
        setActiveScopeKey(scopeKey);
        setMessages([]);
      }
      const clientRequestId = crypto.randomUUID();
      const userMessage: NoteAiMessage = {
        id: `local-${clientRequestId}`,
        sessionId: session.id,
        role: 'user',
        content: messageText,
        status: 'queued',
        clientRequestId,
        citations: [],
        verified: false,
        claims: [],
        safety: {},
        degraded: false,
        errorCode: '',
        errorMessage: '',
        metadata: {},
        createdAt: new Date().toISOString(),
      };
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      setMessages((current) => [...current, userMessage]);
      setPrompt('');
      const result = await client.submitAiChat(
        { sessionId: session.id, clientRequestId, message: messageText },
        { signal: controller.signal },
      );
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      operationAbort.current = null;
      if (!result.success) {
        setError(result.error);
        setSendState({ scopeKey, busy: false });
        return;
      }
      updateMessage(result.message);
      if (result.message.status === 'queued' || result.message.status === 'streaming') watchMessage(result.message.id);
    } catch (submitError) {
      if (generation !== requestGeneration.current || controller.signal.aborted || isAbortError(submitError)) return;
      setError('AI 请求失败，请重试');
      setSendState({ scopeKey, busy: false });
    }
  };

  const chooseSession = async (sessionId: string) => {
    if (!sessionId) {
      invalidateAsync();
      setActiveSession(null);
      setActiveScopeKey('');
      setMessages([]);
      setError('');
      setDisconnectedMessageId('');
      setSendState({ scopeKey, busy: false });
      return;
    }
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    invalidateAsync();
    const generation = requestGeneration.current;
    setMessages([]);
    setActiveSession(session);
    setActiveScopeKey(scopeKey);
    setLoading(true);
    setError('');
    const result = await client.listAiMessages(session.id);
    if (generation !== requestGeneration.current) return;
    if (!result.success) setError(result.error);
    else setMessages(result.messages);
    setLoading(false);
  };

  const retryMessage = (failed: NoteAiMessage) => {
    const index = scopedMessages.findIndex((item) => item.id === failed.id);
    const question = scopedMessages.slice(0, index).reverse().find((item) => item.role === 'user')?.content;
    if (question) void submit(question);
  };

  const openDrawer = () => {
    setLoading(true);
    setError('');
    setOpen(true);
  };

  const closeDrawer = () => {
    invalidateAsync();
    setDisconnectedMessageId('');
    setSendState({ scopeKey, busy: false });
    setOpen(false);
  };

  const beginWritebackOperation = (targetNoteId: string, previewId?: string, targetVersion?: number) => {
    const operation: WritebackOperation = {
      id: writebackOperationCounter.current + 1,
      generation: requestGeneration.current,
      scopeKey,
      targetNoteId,
      previewId,
      targetVersion,
    };
    writebackOperationCounter.current = operation.id;
    writebackOperation.current = operation;
    setWritebackBusyOwner(operation);
    return operation;
  };

  const settleWritebackOperation = (operation: WritebackOperation) => {
    if (writebackOperation.current?.id !== operation.id) return false;
    writebackOperation.current = null;
    if (mounted.current) {
      setWritebackBusyOwner((current) => current?.id === operation.id ? null : current);
    }
    const context = writebackContext.current;
    const editorContext = writebackEditorContext.current;
    const snapshot = editorContext.snapshot;
    return (
      mounted.current
      && operation.generation === requestGeneration.current
      && operation.scopeKey === context.scopeKey
      && operation.targetNoteId === context.targetNoteId
      && (operation.targetVersion === undefined || (
        editorContext.currentNoteId === operation.targetNoteId
        && editorContext.currentNoteVersion === operation.targetVersion
        && snapshot.noteId === operation.targetNoteId
        && snapshot.baseVersion === operation.targetVersion
        && !snapshot.dirty
        && !snapshot.pending
        && !snapshot.conflicted
      ))
      && (!operation.previewId || (
        writebackPreviewRef.current?.id === operation.previewId
        && writebackPreviewRef.current.targetNote.id === operation.targetNoteId
      ))
    );
  };

  const generateWritebackPreview = async () => {
    if (!currentNote || !writebackSource || writebackBusy) return;
    const editorIssue = getWritebackEditorIssue(currentNote.id, currentNote.version);
    if (editorIssue.blocked) {
      setWritebackError(editorIssue.message);
      return;
    }
    const operation = beginWritebackOperation(currentNote.id, undefined, currentNote.version);
    setWritebackError('');
    setWritebackStale(false);
    setWritebackNeedsReask(false);
    const result = await client.createWritebackPreview({
      targetNoteId: currentNote.id,
      messageId: writebackSource.id,
    });
    if (!settleWritebackOperation(operation)) return;
    if (!result.success) {
      const stale = result.status === 409;
      setWritebackError(stale ? '正文已更新，请重新提问并生成建议' : result.error);
      setWritebackStale(stale);
      setWritebackNeedsReask(stale);
      return;
    }
    setWritebackPreview(result.preview);
    setWritebackPreviewScopeKey(operation.scopeKey);
  };

  const confirmWriteback = async () => {
    if (!writebackPreview || writebackBusy) return;
    const editorIssue = getWritebackEditorIssue(writebackPreview.targetNote.id, writebackPreview.targetVersion);
    if (editorIssue.blocked) {
      setWritebackError(editorIssue.message);
      setWritebackStale(editorIssue.stale);
      return;
    }
    const operation = beginWritebackOperation(
      writebackPreview.targetNote.id,
      writebackPreview.id,
      writebackPreview.targetVersion,
    );
    setWritebackError('');
    setWritebackNeedsReask(false);
    const result = await client.confirmWritebackPreview(writebackPreview.id);
    if (!settleWritebackOperation(operation)) return;
    if (!result.success) {
      const stale = result.status === 409;
      setWritebackError(stale ? '正文已更新，请重新提问并生成建议' : result.error);
      setWritebackStale(stale);
      setWritebackNeedsReask(stale);
      return;
    }
    setWritebackPreview(null);
    setWritebackPreviewScopeKey('');
    setWritebackStale(false);
    setWritebackNeedsReask(false);
    onWritebackApplied?.(result.note);
  };

  const abandonWriteback = async () => {
    if (!writebackPreview || writebackBusy) return;
    const operation = beginWritebackOperation(writebackPreview.targetNote.id, writebackPreview.id);
    const result = await client.abandonWritebackPreview(writebackPreview.id);
    if (!settleWritebackOperation(operation)) return;
    if (!result.success) {
      setWritebackError(result.error);
      return;
    }
    setWritebackPreview(null);
    setWritebackPreviewScopeKey('');
    setWritebackError('');
    setWritebackNeedsReask(false);
  };

  const reaskWriteback = () => {
    if (!scope || sending) return;
    setWritebackError('');
    setWritebackNeedsReask(false);
    void submit('请基于当前笔记最新正文重新生成可写回的修改建议。只提供建议，不要直接修改笔记。', { forceNewSession: true });
  };

  if (!open) {
    return (
      <aside
        data-testid="notes-ai-drawer"
        data-state="collapsed"
        className={isMobile ? 'fixed bottom-4 right-4 z-40 flex size-12' : 'flex h-full w-12 shrink-0 border-l border-border/70 bg-background'}
        aria-label="笔记 AI 已收起"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="m-auto size-10 rounded-md" aria-label="打开笔记 AI" title="打开笔记 AI" onClick={openDrawer}>
              <Bot className="size-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">打开笔记 AI</TooltipContent>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside
      data-testid="notes-ai-drawer"
      data-state="expanded"
      className={isMobile
        ? 'fixed inset-0 z-50 flex h-dvh w-screen flex-col bg-background'
        : 'flex h-full w-[clamp(320px,28vw,420px)] shrink-0 flex-col border-l border-border/70 bg-background'}
      aria-label="笔记 AI"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0" aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold">笔记 AI</h2>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" className="size-8 rounded-md" aria-label="收起笔记 AI" onClick={closeDrawer}>
          {isMobile ? <X className="size-4" /> : <ChevronRight className="size-4" />}
        </Button>
      </header>

      <div className="grid h-10 shrink-0 grid-cols-2 border-b border-border/70 p-1" role="tablist" aria-label="笔记 AI 功能">
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'conversation'}
          onClick={() => setPanel('conversation')}
          className={`rounded-sm text-xs transition-colors ${panel === 'conversation' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          对话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'memory'}
          onClick={() => setPanel('memory')}
          className={`inline-flex items-center justify-center gap-1.5 rounded-sm text-xs transition-colors ${panel === 'memory' ? 'bg-amber-100 font-medium text-amber-950 dark:bg-amber-950/50 dark:text-amber-100' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <Brain className="size-3.5" aria-hidden="true" />记忆
        </button>
      </div>

      {panel === 'memory' ? (
        <NoteMemoryManager
          client={client}
          notes={notes}
          onSourceOpen={(noteId) => {
            const source = notes.find((item) => item.id === noteId);
            onCitationNavigate({
              sourceKind: 'personal_note',
              sourceId: noteId,
              noteId,
              noteVersion: source?.version,
              title: source?.title || '来源笔记',
              location: '记忆来源',
              snippet: '',
            });
            setPanel('conversation');
          }}
          onMemoriesChange={setKnownMemories}
        />
      ) : (
        <>

      <div className="shrink-0 space-y-2 border-b border-border/70 p-3">
        <label className="block text-xs font-medium text-muted-foreground" htmlFor="note-ai-scope">作用范围</label>
        <select
          id="note-ai-scope"
          aria-label="AI 作用范围"
          value={scopeMode}
          onChange={(event) => {
            invalidateAsync();
            setScopeMode(event.target.value as ScopeMode);
            setActiveSession(null);
            setActiveScopeKey('');
            setMessages([]);
            setPrompt('');
            setSendState({ scopeKey: '', busy: false });
            setDisconnectedMessageId('');
          }}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="note">当前笔记</option>
          <option value="selection">选择多篇笔记</option>
        </select>
        {scopeMode === 'selection' && (
          <fieldset className="max-h-28 overflow-y-auto border-y border-border/70 py-2">
            <legend className="px-1 text-xs text-muted-foreground">明确选择笔记</legend>
            {notes.map((item) => (
              <label key={item.id} className="flex min-h-8 items-center gap-2 px-1 text-sm">
                <input
                  type="checkbox"
                  aria-label={`选择${item.title || '无标题笔记'}`}
                  checked={selectedNoteIds.includes(item.id)}
                  onChange={(event) => {
                    invalidateAsync();
                    setActiveSession(null);
                    setActiveScopeKey('');
                    setMessages([]);
                    setPrompt('');
                    setSendState({ scopeKey: '', busy: false });
                    setSelectedNoteIds((current) => event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id));
                  }}
                />
                <span className="truncate">{item.title || '无标题笔记'}</span>
              </label>
            ))}
          </fieldset>
        )}
        {scopedSessions.length > 0 && (
          <select
            aria-label="AI 会话"
            value={scopedActiveSession?.id ?? ''}
            onChange={(event) => void chooseSession(event.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">新会话</option>
            {scopedSessions.map((session) => <option key={session.id} value={session.id}>{session.title || '未命名会话'}</option>)}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-live="polite">
        {loading && <p className="text-sm text-muted-foreground">正在加载会话...</p>}
        {!loading && scopedMessages.length === 0 && <p className="text-sm text-muted-foreground">从当前笔记开始提问。</p>}
        <div className="space-y-5">
          {scopedMessages.map((message) => (
            <article key={message.id} className={message.role === 'user' ? 'border-l-2 border-foreground/30 pl-3' : ''}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{message.role === 'user' ? '你' : '笔记 AI'}</span>
                {message.role === 'assistant' && <MessageState message={message} />}
              </div>
              {message.content && <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>}
              {message.role === 'assistant' && (
                <MemoryUseDisclosure
                  message={message}
                  memories={knownMemories}
                  notes={notes}
                  onSourceOpen={(noteId) => {
                    const source = notes.find((item) => item.id === noteId);
                    onCitationNavigate({
                      sourceKind: 'personal_note',
                      sourceId: noteId,
                      noteId,
                      noteVersion: source?.version,
                      title: source?.title || '来源笔记',
                      location: '记忆来源',
                      snippet: '',
                    });
                  }}
                />
              )}
              {message.role === 'assistant' && (message.status === 'queued' || message.status === 'streaming') && (
                <p className="text-sm text-muted-foreground">正在生成回答...</p>
              )}
              {message.role === 'assistant' && message.status === 'failed' && (
                <div className="space-y-2">
                  <p className="text-sm text-destructive">{message.errorMessage || '回答生成失败'}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => retryMessage(message)}>
                    <RefreshCw className="size-3.5" />重试
                  </Button>
                </div>
              )}
              {message.citations.length > 0 && (
                <div className="mt-3 border-t border-border/70 pt-2">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">引用</p>
                  {message.citations.map((citation, index) => (
                    citation.noteId && !citation.attachmentId ? (
                      <button
                        key={`${citation.noteId}-${citation.paragraphIndex ?? index}`}
                        type="button"
                        aria-label={`跳转到${citation.title}${citation.location}`}
                        onClick={() => onCitationNavigate(citation)}
                        className="block w-full py-1 text-left text-xs text-foreground underline decoration-amber-500/70 underline-offset-4"
                      >
                        {citation.title} · {citation.location}
                      </button>
                    ) : (
                      <p key={`${citation.sourceId ?? 'source'}-${index}`} className="py-1 text-xs text-muted-foreground">{citation.title} · {citation.location}</p>
                    )
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
        {disconnectedMessageId && <p className="mt-3 text-xs text-amber-700" role="status">连接已中断，正在恢复回答...</p>}
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        {writebackPreview && writebackPreviewScopeKey === scopeKey && writebackPreview.targetNote.id === currentNote?.id && (
          <NoteWritebackPreviewPanel
            preview={writebackPreview}
            busy={writebackBusy}
            stale={writebackStale || previewEditorIssue.stale}
            confirmDisabled={previewEditorIssue.blocked}
            error={previewEditorIssue.message || writebackError}
            onConfirm={() => void confirmWriteback()}
            onAbandon={() => void abandonWriteback()}
            onRegenerate={reaskWriteback}
          />
        )}
        {!writebackPreview && writebackError && (
          <div className="mt-3 border-y border-border/70 py-3" role="alert">
            <p className="text-sm text-destructive">{writebackError}</p>
            {writebackNeedsReask && (
              <Button type="button" variant="outline" size="sm" className="mt-2 w-full rounded-md" onClick={reaskWriteback}>
                <RefreshCw className="size-3.5" />重新提问并生成建议
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-2 w-full justify-start rounded-md"
          disabled={!currentNote || !writebackSource || sending || writebackBusy}
          onClick={() => void generateWritebackPreview()}
        >
          <FilePenLine className="size-4" />生成写回建议
        </Button>
        <label className="sr-only" htmlFor="note-ai-prompt">向笔记 AI 提问</label>
        <textarea
          id="note-ai-prompt"
          aria-label="向笔记 AI 提问"
          value={prompt}
          maxLength={4000}
          rows={3}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit(prompt);
            }
          }}
          placeholder={scope ? '输入问题' : '请先选择至少一篇笔记'}
          className="w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" className="rounded-md" disabled={!prompt.trim() || !scope || sending} onClick={() => void submit(prompt)}>
            <Send className="size-4" />发送
          </Button>
        </div>
      </div>
        </>
      )}
    </aside>
  );
}

function MemoryUseDisclosure({ message, memories, notes, onSourceOpen }: {
  message: NoteAiMessage;
  memories: NoteMemory[];
  notes: NoteSummary[];
  onSourceOpen: (noteId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ids = Array.isArray(message.metadata.memoryIds)
    ? message.metadata.memoryIds.filter((item): item is string => typeof item === 'string')
    : [];
  const used = ids.flatMap((id) => {
    const memory = memories.find((item) => item.id === id);
    return memory && memory.status !== 'candidate' ? [memory] : [];
  });
  if (used.length === 0) return null;
  return (
    <div className="mt-2 border-y border-border/60 py-1.5 text-xs">
      <button type="button" className="flex w-full items-center justify-between gap-2 py-1 text-left text-muted-foreground hover:text-foreground" onClick={() => setExpanded((value) => !value)}>
        <span>使用了 {used.length} 条已确认记忆</span>
        <ChevronDown className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="space-y-2 pb-1 pt-2">
          {used.map((memory) => (
            <div key={memory.id} className="border-l-2 border-amber-400 pl-2">
              <p className="leading-5 text-foreground">{memory.content}</p>
              <p className="mt-0.5 text-muted-foreground">状态：{memoryStateLabel(memory.status)}</p>
              {memory.sourceNoteRefs.map((ref) => {
                const title = ref.title || notes.find((item) => item.id === ref.id)?.title || '来源笔记';
                return (
                  <button key={`${ref.id}-${ref.version ?? ''}`} type="button" className="mt-0.5 block underline decoration-amber-500/70 underline-offset-4" onClick={() => onSourceOpen(ref.id)}>
                    来源：{title}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function memoryStateLabel(status: NoteMemory['status']) {
  return {
    candidate: '待确认',
    confirmed: '已启用',
    paused: '已暂停',
    superseded: '已替换',
    deleted: '已删除',
  }[status];
}

function MessageState({ message }: { message: NoteAiMessage }) {
  if (message.status === 'failed') return <span className="inline-flex items-center gap-1 text-destructive"><ShieldAlert className="size-3" />失败</span>;
  if (message.degraded) return <span className="inline-flex items-center gap-1 text-amber-700"><ShieldAlert className="size-3" />证据不足</span>;
  if (message.verified) return <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="size-3" />已验证</span>;
  if (message.status === 'succeeded') return <span>未验证</span>;
  return <span>处理中</span>;
}

function scopeKeyForSnapshot(session: NoteAiSession) {
  const snapshot = session.scopeSnapshot;
  const noteIds = Array.isArray(snapshot.notes)
    ? snapshot.notes.flatMap((item) => typeof item === 'object' && item && 'id' in item ? [String(item.id)] : [])
    : [];
  if (session.scopeType === 'notebook') {
    return snapshot.notebookId ? JSON.stringify({ type: 'notebook', notebookId: snapshot.notebookId }) : '';
  }
  if (noteIds.length === 0) return '';
  return JSON.stringify({ type: session.scopeType, noteIds });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
