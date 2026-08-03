'use client';

import { AlertTriangle, Check, RotateCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { NoteWritebackPreview } from '@/lib/a3/notes/types';

interface NoteWritebackPreviewProps {
  preview: NoteWritebackPreview;
  busy: boolean;
  stale: boolean;
  error: string;
  onConfirm: () => void;
  onAbandon: () => void;
  onRegenerate: () => void;
}

export function NoteWritebackPreviewPanel({
  preview,
  busy,
  stale,
  error,
  onConfirm,
  onAbandon,
  onRegenerate,
}: NoteWritebackPreviewProps) {
  return (
    <section className="mt-4 border-y border-border/70 py-3" aria-label="AI 写回预览">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">写入{preview.targetNote.title || '无标题笔记'}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            目标版本 {preview.targetVersion} · {formatExpiry(preview.expiresAt)}到期
          </p>
        </div>
        {stale && <AlertTriangle className="size-4 shrink-0 text-amber-700" aria-hidden="true" />}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <DiffCount label="新增" value={preview.diff.additions.length} tone="text-emerald-700" />
        <DiffCount label="删除" value={preview.diff.removals.length} tone="text-rose-700" />
        <DiffCount label="修改块" value={preview.diff.changedBlocks.length} tone="text-amber-700" />
      </div>

      <div className="mt-3 max-h-52 space-y-2 overflow-y-auto text-xs">
        {preview.diff.changedBlocks.map((item) => (
          <div key={`changed-${item.index}`} className="border-l-2 border-amber-500 pl-2">
            <p className="line-through text-rose-700">{item.before || '空白块'}</p>
            <p className="mt-1 text-emerald-700">{item.after || '空白块'}</p>
          </div>
        ))}
        {preview.diff.removals.map((item) => (
          <p key={`removed-${item.index}`} className="border-l-2 border-rose-500 pl-2 text-rose-700 line-through">{item.text || '空白块'}</p>
        ))}
        {preview.diff.additions.map((item) => (
          <p key={`added-${item.index}`} className="border-l-2 border-emerald-500 pl-2 text-emerald-700">{item.text || '空白块'}</p>
        ))}
      </div>

      {error && <p className="mt-3 text-xs text-destructive" role="alert">{error}</p>}
      <div className="mt-3 flex gap-2">
        {stale ? (
          <Button type="button" size="sm" variant="outline" className="w-full rounded-md" disabled={busy} onClick={onRegenerate}>
            <RotateCw className="size-3.5" />重新生成建议
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" className="flex-1 rounded-md" disabled={busy} aria-label="放弃写回建议" onClick={onAbandon}>
              <X className="size-3.5" />放弃
            </Button>
            <Button type="button" size="sm" className="flex-1 rounded-md" disabled={busy} aria-label="确认写入笔记正文" onClick={onConfirm}>
              <Check className="size-3.5" />确认写入
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function DiffCount({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="border border-border/70 px-1 py-2"><strong className={tone}>{value}</strong><span className="ml-1 text-muted-foreground">{label}</span></div>;
}

function formatExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
