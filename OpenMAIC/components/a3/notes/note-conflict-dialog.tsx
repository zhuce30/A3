'use client';

import { useState } from 'react';
import { Copy, GitCompareArrows, LoaderCircle, Server } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NotesDraftStore } from '@/lib/a3/notes/draft-store';
import type { NoteContent, NoteDetail } from '@/lib/a3/notes/types';

interface NoteConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteDetail;
  localContent: NoteContent;
  serverNote: NoteDetail;
  client: NotesClient;
  draftStore: Pick<NotesDraftStore, 'resolveNoteConflict'>;
  onAdoptServer: (note: NoteDetail) => void;
}

export function NoteConflictDialog({ open, onOpenChange, note, localContent, serverNote, client, draftStore, onAdoptServer }: NoteConflictDialogProps) {
  const [showDiff, setShowDiff] = useState(false);
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  const [busy, setBusy] = useState<'copy' | 'adopt' | null>(null);
  const [error, setError] = useState('');
  const [copyCreated, setCopyCreated] = useState(false);

  const preserveCopy = async () => {
    setBusy('copy');
    setError('');
    const result = await client.createNote({
      title: `${note.title || '无标题笔记'}（冲突副本）`,
      content: localContent,
      notebookId: note.notebook?.id ?? null,
      tagIds: note.tags.map((tag) => tag.id),
      isPinned: note.isPinned,
    });
    setBusy(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setCopyCreated(true);
  };

  const adoptServer = async () => {
    setBusy('adopt');
    setError('');
    try {
      await draftStore.resolveNoteConflict(note.id, { kind: 'discard' });
      onAdoptServer(serverNote);
      setConfirmAdopt(false);
      onOpenChange(false);
    } catch {
      setError('无法采用服务器版本，本地草稿仍已保留');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) { setConfirmAdopt(false); onOpenChange(next); } }}>
      <DialogContent className="w-[min(46rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>笔记版本冲突</DialogTitle>
          <DialogDescription>服务器已有更新。本地草稿会保留，选择操作后才会继续。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="冲突处理">
            <Button data-conflict-action type="button" variant="outline" onClick={() => setShowDiff((value) => !value)}><GitCompareArrows className="size-4" />查看差异</Button>
            <Button data-conflict-action type="button" variant="outline" disabled={busy !== null || copyCreated} onClick={() => void preserveCopy()}>{busy === 'copy' ? <LoaderCircle className="size-4 animate-spin" /> : <Copy className="size-4" />}保留为副本</Button>
            <Button data-conflict-action type="button" variant="outline" disabled={busy !== null} onClick={() => setConfirmAdopt(true)}><Server className="size-4" />采用服务器版本</Button>
          </div>
          {showDiff && (
            <div className="grid min-w-0 grid-cols-1 divide-y divide-border overflow-hidden rounded-md border border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0" aria-label="版本差异">
              <DiffColumn title="本地草稿" content={localContent} />
              <DiffColumn title={`服务器 v${serverNote.version}`} content={serverNote.content} />
            </div>
          )}
          {copyCreated && <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status">已创建独立副本，原笔记与本地草稿均未改动。</p>}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {confirmAdopt && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-sm text-muted-foreground">确认丢弃此笔记的本地冲突草稿并采用服务器 v{serverNote.version}？</p>
              <div className="flex gap-2"><Button variant="outline" disabled={busy !== null} onClick={() => setConfirmAdopt(false)}>取消</Button><Button variant="destructive" disabled={busy !== null} onClick={() => void adoptServer()}>{busy === 'adopt' && <LoaderCircle className="size-4 animate-spin" />}确认采用</Button></div>
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffColumn({ title, content }: { title: string; content: NoteContent }) {
  return (
    <section className="min-w-0 p-3">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">{extractText(content) || '空白内容'}</pre>
    </section>
  );
}

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'text') return typeof record.text === 'string' ? record.text : '';
  if (record.type === 'image') return `[图片：${String((record.attrs as Record<string, unknown> | undefined)?.alt || '未命名')}]`;
  if (String(record.type).includes('math') || String(record.type).includes('equation')) {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    return String(attrs?.latex || attrs?.value || attrs?.text || '');
  }
  const parts = Array.isArray(record.content) ? record.content.map(extractText) : [];
  const text = parts.join(record.type === 'table_row' ? '\t' : '');
  return ['paragraph', 'heading', 'code_block', 'list_item', 'table_row'].includes(String(record.type)) ? `${text}\n` : text;
}
