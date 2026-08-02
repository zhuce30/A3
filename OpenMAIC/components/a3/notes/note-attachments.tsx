'use client';

import { useRef, useState } from 'react';
import {
  Download, ExternalLink, File, FileImage, FileText, Link as LinkIcon,
  LoaderCircle, Paperclip, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { NotesClient } from '@/lib/a3/notes/client';
import { createAttachmentReference } from '@/lib/a3/notes/editor-schema';
import type { NoteAttachment } from '@/lib/a3/notes/types';
import { cn } from '@/lib/utils';

interface NoteAttachmentsProps {
  noteId: string;
  attachments: NoteAttachment[];
  client: NotesClient;
  onInsert: (node: Record<string, unknown>) => void;
  onChange?: (attachments: NoteAttachment[]) => void;
}

export function NoteAttachments({ noteId, attachments, client, onInsert, onChange }: NoteAttachmentsProps) {
  const [localItems, setLocalItems] = useState<NoteAttachment[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkName, setLinkName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const items = localItems ?? attachments;

  const update = (next: NoteAttachment[]) => {
    setLocalItems(next);
    onChange?.(next);
  };

  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setError('');
    const result = await client.uploadAttachment(noteId, file);
    setUploading(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    update([...items, result.attachment]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const createLink = async () => {
    const url = linkUrl.trim();
    if (!url) return;
    setBusyId('link');
    setError('');
    const result = await client.createLinkAttachment(noteId, { url, displayName: linkName.trim() || undefined });
    setBusyId(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    update([...items, result.attachment]);
    setLinkUrl('');
    setLinkName('');
    setLinkOpen(false);
  };

  const reparse = async (attachment: NoteAttachment) => {
    setBusyId(attachment.id);
    setError('');
    const result = await client.reparseAttachment(attachment.id);
    setBusyId(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    update(items.map((item) => item.id === attachment.id ? result.attachment : item));
  };

  const remove = async (attachment: NoteAttachment) => {
    setBusyId(attachment.id);
    setError('');
    const result = await client.deleteAttachment(attachment.id);
    setBusyId(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setConfirmDeleteId(null);
    update(items.filter((item) => item.id !== attachment.id));
  };

  return (
    <aside className="border-b border-border bg-muted/20" aria-label="笔记附件">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">附件 {items.length}</span>
        <div className="flex items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            aria-label="上传附件"
            className="sr-only"
            onChange={(event) => void upload(event.currentTarget.files?.[0])}
          />
          <Button type="button" variant="ghost" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {uploading ? '上传中' : '上传'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setLinkOpen((value) => !value)}>
            <LinkIcon className="size-4" />链接
          </Button>
        </div>
      </div>
      {linkOpen && (
        <div className="grid min-w-0 grid-cols-1 gap-2 border-t border-border/60 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,.45fr)_auto]">
          <Input aria-label="链接地址" type="url" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://" />
          <Input aria-label="链接名称" value={linkName} onChange={(event) => setLinkName(event.target.value)} placeholder="显示名称" />
          <Button type="button" disabled={!linkUrl.trim() || busyId === 'link'} onClick={() => void createLink()}>{busyId === 'link' && <LoaderCircle className="size-4 animate-spin" />}添加</Button>
        </div>
      )}
      {error && <p className="border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
      {items.length === 0 && !uploading ? (
        <div className="border-t border-border/60 px-3 py-4 text-center text-sm text-muted-foreground">暂无附件</div>
      ) : (
        <div className="border-t border-border/60">
          {items.map((attachment) => (
            <AttachmentRow
              key={attachment.id}
              attachment={attachment}
              busy={busyId === attachment.id}
              confirmingDelete={confirmDeleteId === attachment.id}
              onInsert={() => onInsert(createAttachmentReference({ id: attachment.id, label: attachment.displayName, kind: attachment.kind, mimeType: attachment.mimeType }))}
              onReparse={() => void reparse(attachment)}
              onRequestDelete={() => setConfirmDeleteId(attachment.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onDelete={() => void remove(attachment)}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function AttachmentRow({ attachment, busy, confirmingDelete, onInsert, onReparse, onRequestDelete, onCancelDelete, onDelete }: {
  attachment: NoteAttachment;
  busy: boolean;
  confirmingDelete: boolean;
  onInsert: () => void;
  onReparse: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const Icon = attachment.kind === 'link' ? LinkIcon : attachment.kind === 'image' ? FileImage : attachment.mimeType.includes('text') || attachment.mimeType.includes('pdf') ? FileText : File;
  const sourceUrl = (attachment as NoteAttachment & { sourceUrl?: string }).sourceUrl;
  const status = {
    pending: '等待解析', processing: '解析中', succeeded: '已解析', failed: '解析失败',
  }[attachment.parseStatus];

  return (
    <div data-testid="note-attachment-row" className="flex h-12 min-w-0 items-center gap-2 border-b border-border/50 px-3 last:border-b-0">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{attachment.displayName}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{attachment.kind === 'link' ? '链接' : formatSize(attachment.sizeBytes)}</span>
          <span className={cn(attachment.parseStatus === 'failed' && 'text-destructive')}>{status}</span>
          {(attachment.parseStatus === 'processing' || busy) && <LoaderCircle className="size-3 animate-spin" aria-label="处理中" />}
        </div>
      </div>
      {confirmingDelete ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onDelete}>确认删除</Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="取消删除" onClick={onCancelDelete}><X className="size-4" /></Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="插入附件引用" onClick={onInsert}><Paperclip className="size-4" /></Button>
          {attachment.kind === 'link' && sourceUrl ? (
            <Button asChild size="icon-sm" variant="ghost"><a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="打开链接"><ExternalLink className="size-4" /></a></Button>
          ) : attachment.kind !== 'link' ? (
            <Button asChild size="icon-sm" variant="ghost"><a href={`/api/a3/notes/attachments/${encodeURIComponent(attachment.id)}/download/`} download aria-label="下载附件"><Download className="size-4" /></a></Button>
          ) : null}
          {attachment.parseStatus === 'failed' && <Button type="button" size="icon-sm" variant="ghost" aria-label="重试解析" disabled={busy} onClick={onReparse}><RefreshCw className="size-4" /></Button>}
          <Button type="button" size="icon-sm" variant="ghost" aria-label="删除附件" disabled={busy} onClick={onRequestDelete}><Trash2 className="size-4" /></Button>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
