'use client';

import { CalendarDays, ExternalLink, FileClock, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { A3Markdown } from '@/components/a3/ui/a3-markdown';
import { Button } from '@/components/ui/button';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NoteDigest } from '@/lib/a3/notes/types';

interface NoteDigestViewProps {
  client: NotesClient;
  onOpenNote: (noteId: string) => void;
}

type LoadState = 'loading' | 'ready' | 'error';

export function NoteDigestView({ client, onOpenNote }: NoteDigestViewProps) {
  const [digests, setDigests] = useState<NoteDigest[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [busyOperationId, setBusyOperationId] = useState<number | null>(null);
  const operationEpoch = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const selectedDateRef = useRef('');

  const load = useCallback(async (date?: string) => {
    const operationId = ++operationEpoch.current;
    const requestedDate = date ?? '';
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setBusyOperationId(null);
    setState('loading');
    setError('');
    try {
      const result = await client.listDigests(date, { signal: controller.signal });
      if (
        operationId !== operationEpoch.current
        || controller.signal.aborted
        || (requestedDate && selectedDateRef.current !== requestedDate)
      ) return;
      if (!result.success) {
        setDigests([]);
        setState('error');
        setError(result.error);
        return;
      }
      setDigests(result.digests);
      setSelectedId((current) => result.digests.some((item) => item.id === current) ? current : result.digests[0]?.id ?? '');
      if (!date && result.digests[0]) {
        selectedDateRef.current = result.digests[0].digestDate;
        setSelectedDate(result.digests[0].digestDate);
      }
      setState('ready');
    } catch (loadError) {
      if (
        controller.signal.aborted
        || operationId !== operationEpoch.current
        || (loadError instanceof DOMException && loadError.name === 'AbortError')
      ) return;
      setDigests([]);
      setState('error');
      setError('每日总结加载失败，请重试');
    } finally {
      if (operationId === operationEpoch.current) activeController.current = null;
    }
  }, [client]);

  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(handle);
      operationEpoch.current += 1;
      activeController.current?.abort();
    };
  }, [load]);

  const selected = digests.find((item) => item.id === selectedId) ?? digests[0];
  const busy = busyOperationId !== null;

  const changeSelectedDate = (value: string) => {
    selectedDateRef.current = value;
    setSelectedDate(value);
    void load(value);
  };

  const createRevision = async () => {
    if (!selectedDate || busy) return;
    const operationDate = selectedDateRef.current || selectedDate;
    const operationId = ++operationEpoch.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setBusyOperationId(operationId);
    setError('');
    try {
      const result = await client.createManualDigest(operationDate, { signal: controller.signal });
      if (
        controller.signal.aborted
        || operationId !== operationEpoch.current
        || selectedDateRef.current !== operationDate
      ) return;
      if (!result.success) {
        setError(result.error);
        return;
      }
      if (result.digest.digestDate !== operationDate) return;
      setDigests((current) => [result.digest, ...current]);
      setSelectedId(result.digest.id);
      setState('ready');
    } catch (operationError) {
      if (!(operationError instanceof DOMException && operationError.name === 'AbortError')) {
        if (operationId === operationEpoch.current) setError('每日总结创建失败，请重试');
      }
    } finally {
      if (operationId === operationEpoch.current) activeController.current = null;
      setBusyOperationId((current) => current === operationId ? null : current);
    }
  };

  const retry = async () => {
    if (!selected || selected.status !== 'failed' || busy) return;
    const operationDate = selectedDateRef.current || selected.digestDate;
    const operationId = ++operationEpoch.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setBusyOperationId(operationId);
    setError('');
    try {
      const result = await client.retryDigest(selected.id, { signal: controller.signal });
      if (
        controller.signal.aborted
        || operationId !== operationEpoch.current
        || selectedDateRef.current !== operationDate
      ) return;
      if (!result.success) {
        setError(result.error);
        return;
      }
      if (result.digest.digestDate !== operationDate) return;
      setDigests((current) => current.map((item) => item.id === result.digest.id ? result.digest : item));
      setState('ready');
    } catch (operationError) {
      if (!(operationError instanceof DOMException && operationError.name === 'AbortError')) {
        if (operationId === operationEpoch.current) setError('每日总结重试失败，请稍后再试');
      }
    } finally {
      if (operationId === operationEpoch.current) activeController.current = null;
      setBusyOperationId((current) => current === operationId ? null : current);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="每日总结只读视图">
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
        <FileClock className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="mr-auto text-sm font-semibold">每日总结</h1>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="size-4" aria-hidden="true" />
          <span className="sr-only">总结日期</span>
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => changeSelectedDate(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <select
          aria-label="总结修订版本"
          value={selected?.id ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          disabled={!digests.length}
        >
          {digests.map((item) => <option key={item.id} value={item.id}>修订 {item.revision}</option>)}
        </select>
        <Button type="button" size="icon-sm" variant="ghost" className="size-8 rounded-md" aria-label="刷新总结状态" title="刷新总结状态" disabled={state === 'loading'} onClick={() => void load(selectedDate || undefined)}>
          <RotateCcw className="size-4" />
        </Button>
        <Button type="button" size="sm" variant="outline" className="rounded-md" disabled={!selectedDate || busy} onClick={() => void createRevision()}>
          <RefreshCw className="size-4" />生成新修订
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8">
        {state === 'loading' && <p className="text-sm text-muted-foreground">正在加载每日总结...</p>}
        {state === 'ready' && error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
        {state === 'error' && (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-destructive">{error || '每日总结加载失败'}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load(selectedDate || undefined)}>重新加载</Button>
          </div>
        )}
        {state === 'ready' && !selected && (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
            <FileClock className="size-7 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">所选日期还没有每日总结</p>
            <Button type="button" size="sm" className="rounded-md" disabled={!selectedDate || busy} onClick={() => void createRevision()}>生成第一版</Button>
          </div>
        )}
        {state === 'ready' && selected && (
          <article className="mx-auto max-w-3xl" data-readonly="true">
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="rounded border border-border px-2 py-1 text-xs font-medium">
                {selected.generatedBy === 'automatic' ? '自动生成' : '手动生成'}
              </span>
              <span className="text-xs text-muted-foreground">修订 {selected.revision}</span>
              <span className="text-xs text-muted-foreground">{selected.digestDate}</span>
              <span className="text-xs text-muted-foreground">只读</span>
            </div>
            {selected.status === 'succeeded' ? (
              <A3Markdown className="text-sm leading-7">{selected.contentMd}</A3Markdown>
            ) : selected.status === 'failed' ? (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-medium text-destructive">生成失败</p>
                <p className="mt-1 text-sm text-muted-foreground">{selected.errorMessage || '每日总结生成失败，请重试'}</p>
                <Button type="button" size="sm" variant="outline" className="mt-3 rounded-md" disabled={busy} onClick={() => void retry()}>
                  <RotateCcw className="size-4" />重试失败修订
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{selected.status === 'processing' ? '正在生成总结...' : '总结已排队，等待生成...'}</p>
            )}

            <section className="mt-8 border-t border-border/70 pt-5" aria-label="摘要来源">
              <h2 className="text-sm font-semibold">来源笔记</h2>
              <div className="mt-3 space-y-3">
                {selected.sourceSnapshot.notes.map((note) => (
                  <div key={`${note.id}:${note.version}`} className="border-l-2 border-border pl-3">
                    <button type="button" className="inline-flex items-center gap-1 text-left text-sm font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => onOpenNote(note.id)}>
                      {note.title || '未命名笔记'} · 版本 {note.version}<ExternalLink className="size-3.5" />
                    </button>
                    {note.attachments.map((attachment) => (
                      <p key={`${attachment.id}:${attachment.parseVersion}`} className="mt-1 text-xs text-muted-foreground">
                        {attachment.displayName} · 解析版本 {attachment.parseVersion}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          </article>
        )}
      </div>
    </section>
  );
}
