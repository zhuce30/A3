'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NoteDetail, NoteRevision } from '@/lib/a3/notes/types';

interface NoteHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteDetail;
  client: NotesClient;
  onRestored: (note: NoteDetail) => void;
}

const sourceLabels: Record<NoteRevision['source'], string> = {
  checkpoint: '自动存档',
  manual: '手动保存',
  ai_writeback: 'AI 写回',
  restore: '历史恢复',
};

export function NoteHistoryDialog({ open, onOpenChange, note, client, onRestored }: NoteHistoryDialogProps) {
  const [revisions, setRevisions] = useState<NoteRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<NoteRevision | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    const result = await client.listRevisions(note.id);
    setLoading(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setRevisions(result.revisions);
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return undefined;
      setLoading(true);
      setError('');
      return client.listRevisions(note.id);
    }).then((result) => {
      if (!result) return;
      if (!active) return;
      setLoading(false);
      if (!result.success) setError(result.error);
      else setRevisions(result.revisions);
    });
    return () => { active = false; };
  }, [client, note.id, open]);

  const restore = async () => {
    if (!selected) return;
    setRestoring(true);
    setError('');
    const result = await client.restoreRevision(note.id, selected.id, {
      baseVersion: note.version,
      clientMutationId: crypto.randomUUID(),
    });
    setRestoring(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setSelected(null);
    onRestored(result.note);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!restoring) { setSelected(null); onOpenChange(next); } }}>
      <DialogContent className="max-h-[min(42rem,88dvh)] w-[min(42rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>版本历史</DialogTitle>
          <DialogDescription>恢复将在服务器创建新版本，当前内容不会被静默替换。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-3 py-2">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />正在加载</div>
          ) : error ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3 text-center" role="alert"><span className="text-sm text-destructive">{error}</span><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="size-4" />重试</Button></div>
          ) : revisions.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">暂无历史版本</div>
          ) : (
            <div className="divide-y divide-border">
              {revisions.map((revision) => (
                <div key={revision.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 px-2 py-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{revision.title || '无标题笔记'}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">v{revision.version}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{revision.contentText || '空白版本'}</p>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground"><time dateTime={revision.createdAt}>{formatDate(revision.createdAt)}</time><span>{sourceLabels[revision.source]}</span></div>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(revision)}><RotateCcw className="size-4" />恢复此版本</Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border px-5 py-3">
          {selected ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">确认恢复 v{selected.version}？</span>
              <div className="flex gap-2"><Button variant="outline" onClick={() => setSelected(null)} disabled={restoring}>取消</Button><Button onClick={() => void restore()} disabled={restoring}>{restoring && <LoaderCircle className="size-4 animate-spin" />}确认恢复</Button></div>
            </div>
          ) : <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
