'use client';

import { Check, CirclePause, FileText, PencilLine, RotateCcw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NoteMemory, NoteMemoryUpdateInput, NoteSummary } from '@/lib/a3/notes/types';

type MemoryFilter = 'candidate' | 'active' | 'paused' | 'history';
type EditorMode = 'confirm' | 'supersede';

interface NoteMemoryManagerProps {
  client: NotesClient;
  notes: NoteSummary[];
  onSourceOpen: (noteId: string) => void;
  onMemoriesChange?: (memories: NoteMemory[]) => void;
}

interface MemoryDraft {
  content: string;
  memoryType: NoteMemory['memoryType'];
  importance: string;
  validFrom: string;
  validUntil: string;
}

const FILTERS: Array<{ id: MemoryFilter; label: string }> = [
  { id: 'candidate', label: '待确认' },
  { id: 'active', label: '已启用' },
  { id: 'paused', label: '已暂停' },
  { id: 'history', label: '历史' },
];

export function NoteMemoryManager({ client, notes, onSourceOpen, onMemoriesChange }: NoteMemoryManagerProps) {
  const [memories, setMemories] = useState<NoteMemory[]>([]);
  const [filter, setFilter] = useState<MemoryFilter>('candidate');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ memory: NoteMemory; mode: EditorMode; draft: MemoryDraft } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteMemory | null>(null);

  const publish = useCallback((next: NoteMemory[]) => {
    setMemories(next);
    onMemoriesChange?.(next);
  }, [onMemoriesChange]);

  useEffect(() => {
    let active = true;
    void client.listMemories().then((result) => {
      if (!active) return;
      if (!result.success) setError(result.error);
      else publish(result.memories);
      setLoading(false);
    });
    return () => { active = false; };
  }, [client, publish]);

  const visible = useMemo(() => memories.filter((item) => {
    if (filter === 'candidate') return item.status === 'candidate';
    if (filter === 'active') return item.status === 'confirmed';
    if (filter === 'paused') return item.status === 'paused';
    return item.status === 'superseded' || item.status === 'deleted';
  }), [filter, memories]);

  const replaceOne = (nextMemory: NoteMemory) => {
    publish(memories.map((item) => item.id === nextMemory.id ? nextMemory : item));
  };

  const runAction = async (memoryId: string, action: () => ReturnType<NotesClient['pauseMemory']>) => {
    setBusyId(memoryId);
    setError('');
    const result = await action();
    setBusyId('');
    if (!result.success) {
      setError(result.error);
      return;
    }
    replaceOne(result.memory);
  };

  const openEditor = (memory: NoteMemory, mode: EditorMode) => {
    setEditor({ memory, mode, draft: createDraft(memory) });
    setDeleteTarget(null);
    setError('');
  };

  const saveEditor = async () => {
    if (!editor || !editor.draft.content.trim()) return;
    const { memory, mode, draft } = editor;
    const input = draftInput(draft);
    setBusyId(memory.id);
    setError('');
    if (mode === 'supersede') {
      const result = await client.supersedeMemory(memory.id, input);
      setBusyId('');
      if (!result.success) {
        setError(result.error);
        return;
      }
      publish([
        result.replacement,
        ...memories.map((item) => item.id === result.memory.id ? result.memory : item),
      ]);
      setEditor(null);
      return;
    }
    const result = await client.confirmMemory(memory.id, input);
    setBusyId('');
    if (!result.success) {
      setError(result.error);
      return;
    }
    replaceOne(result.memory);
    setEditor(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const memoryId = deleteTarget.id;
    setBusyId(memoryId);
    setError('');
    const result = await client.deleteMemory(memoryId);
    setBusyId('');
    if (!result.success) {
      setError(result.error);
      return;
    }
    replaceOne(result.memory);
    setDeleteTarget(null);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="个人笔记记忆管理">
      <div className="border-b border-border/70 px-3 py-3">
        <p className="text-sm font-medium">记忆由你确认后才会生效</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">只用于个人笔记 AI，可随时暂停、更正或删除。</p>
        <div className="mt-3 grid grid-cols-4 border-y border-border/70" role="tablist" aria-label="记忆筛选">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              onClick={() => {
                setFilter(item.id);
                setEditor(null);
                setDeleteTarget(null);
              }}
              className={`h-9 text-xs transition-colors ${filter === item.id ? 'bg-amber-100 font-medium text-amber-950 dark:bg-amber-950/50 dark:text-amber-100' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <h3 className="sr-only">{filter === 'candidate' ? '待确认记忆' : FILTERS.find((item) => item.id === filter)?.label}</h3>
        {loading && <p className="py-6 text-center text-sm text-muted-foreground">正在读取记忆...</p>}
        {!loading && visible.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm font-medium">{emptyTitle(filter)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{emptyHint(filter)}</p>
          </div>
        )}
        <div className="divide-y divide-border/70">
          {visible.map((item) => (
            <MemoryRow
              key={item.id}
              memory={item}
              replacement={item.supersededById ? memories.find((candidate) => candidate.id === item.supersededById) : undefined}
              notes={notes}
              busy={busyId === item.id}
              onSourceOpen={onSourceOpen}
              onConfirm={() => openEditor(item, 'confirm')}
              onPause={() => void runAction(item.id, () => client.pauseMemory(item.id))}
              onResume={() => void runAction(item.id, () => client.resumeMemory(item.id))}
              onSupersede={() => openEditor(item, 'supersede')}
              onDelete={() => {
                setDeleteTarget(item);
                setEditor(null);
              }}
            />
          ))}
        </div>
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      </div>

      {editor && (
        <MemoryEditor
          memory={editor.memory}
          mode={editor.mode}
          draft={editor.draft}
          busy={busyId === editor.memory.id}
          onChange={(draft) => setEditor((current) => current ? { ...current, draft } : null)}
          onSave={() => void saveEditor()}
          onCancel={() => setEditor(null)}
        />
      )}
      {deleteTarget && (
        <div className="shrink-0 border-t border-destructive/30 bg-destructive/5 p-3" role="alertdialog" aria-label="确认删除记忆">
          <p className="text-sm font-medium">确认删除这条记忆？</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">删除后，今后的个人笔记 AI 对话将不再使用这条记忆。已有回答不会被改写。</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button type="button" variant="destructive" size="sm" disabled={busyId === deleteTarget.id} onClick={() => void confirmDelete()}>
              <Trash2 className="size-3.5" />确认删除
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function MemoryRow({ memory, replacement, notes, busy, onSourceOpen, onConfirm, onPause, onResume, onSupersede, onDelete }: {
  memory: NoteMemory;
  replacement?: NoteMemory;
  notes: NoteSummary[];
  busy: boolean;
  onSourceOpen: (noteId: string) => void;
  onConfirm: () => void;
  onPause: () => void;
  onResume: () => void;
  onSupersede: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{memory.memoryType === 'core' ? '长期偏好' : '阶段经历'}</span>
            <span aria-hidden="true">·</span>
            <span>{stateLabel(memory.status)}</span>
            {memory.status === 'confirmed' && <span className="text-emerald-700 dark:text-emerald-400">当前会用于回答</span>}
          </div>
          <p className="mt-1.5 text-sm leading-6">{memory.content}</p>
        </div>
      </div>
      {memory.reason && <p className="mt-2 text-xs leading-5 text-muted-foreground">提取依据：{memory.reason}</p>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>重要度 {memory.importance}/5</span>
        <span>{formatPeriod(memory.validFrom, memory.validUntil)}</span>
      </div>
      {memory.sourceNoteRefs.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <FileText className="size-3.5" aria-hidden="true" />
          <span>来源</span>
          {memory.sourceNoteRefs.map((ref) => {
            const title = ref.title || notes.find((item) => item.id === ref.id)?.title || '来源笔记';
            return (
              <button key={`${ref.id}-${ref.version ?? ''}`} type="button" aria-label={`打开来源笔记：${title}`} className="underline decoration-amber-500/70 underline-offset-4" onClick={() => onSourceOpen(ref.id)}>
                {title}{ref.version ? ` v${ref.version}` : ''}
              </button>
            );
          })}
        </div>
      )}
      {memory.status === 'superseded' && (
        <p className="mt-2 border-l-2 border-amber-400 pl-2 text-xs leading-5 text-muted-foreground">
          已由新记忆替换{replacement ? `：${replacement.content}` : ''}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {memory.status === 'candidate' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onConfirm}><Check className="size-3.5" />审核并确认</Button>}
        {memory.status === 'confirmed' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onPause}><CirclePause className="size-3.5" />暂停</Button>}
        {memory.status === 'paused' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onResume}><RotateCcw className="size-3.5" />恢复</Button>}
        {(memory.status === 'confirmed' || memory.status === 'paused') && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onSupersede}><PencilLine className="size-3.5" />更正</Button>}
        {memory.status !== 'deleted' && <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={onDelete}><Trash2 className="size-3.5" />删除记忆</Button>}
      </div>
    </article>
  );
}

function MemoryEditor({ memory, mode, draft, busy, onChange, onSave, onCancel }: {
  memory: NoteMemory;
  mode: EditorMode;
  draft: MemoryDraft;
  busy: boolean;
  onChange: (draft: MemoryDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<MemoryDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="shrink-0 border-t border-border bg-background p-3" role="dialog" aria-label={mode === 'confirm' ? '确认记忆预览' : '更正记忆'}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{mode === 'confirm' ? '确认前请检查内容' : '用新内容替换旧记忆'}</p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭编辑" onClick={onCancel}><X className="size-4" /></Button>
      </div>
      <label className="mt-3 block text-xs font-medium" htmlFor={`memory-content-${memory.id}`}>记忆内容</label>
      <textarea
        id={`memory-content-${memory.id}`}
        aria-label={mode === 'confirm' ? '记忆内容' : '更正后的记忆内容'}
        value={draft.content}
        maxLength={800}
        rows={3}
        className="mt-1 w-full resize-none rounded-md border border-input bg-background p-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => update({ content: event.target.value })}
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-xs">类型
          <select aria-label="记忆类型" value={draft.memoryType} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" onChange={(event) => update({ memoryType: event.target.value as NoteMemory['memoryType'] })}>
            <option value="core">长期偏好</option>
            <option value="episodic">阶段经历</option>
          </select>
        </label>
        <label className="text-xs">重要度
          <select aria-label="记忆重要度" value={draft.importance} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" onChange={(event) => update({ importance: event.target.value })}>
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-xs">生效日期
          <input aria-label="生效日期" type="date" value={draft.validFrom} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" onChange={(event) => update({ validFrom: event.target.value })} />
        </label>
        <label className="text-xs">失效日期（可选）
          <input aria-label="失效日期" type="date" value={draft.validUntil} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" onChange={(event) => update({ validUntil: event.target.value })} />
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button type="button" size="sm" disabled={busy || !draft.content.trim()} onClick={onSave}>{mode === 'confirm' ? '确认使用' : '保存更正'}</Button>
      </div>
    </div>
  );
}

function createDraft(memory: NoteMemory): MemoryDraft {
  return {
    content: memory.content,
    memoryType: memory.memoryType,
    importance: String(memory.importance),
    validFrom: memory.validFrom.slice(0, 10),
    validUntil: memory.validUntil?.slice(0, 10) ?? '',
  };
}

function draftInput(draft: MemoryDraft): NoteMemoryUpdateInput {
  return {
    content: draft.content.trim(),
    memoryType: draft.memoryType,
    importance: Number(draft.importance),
    validFrom: new Date(`${draft.validFrom}T00:00:00+08:00`).toISOString(),
    validUntil: draft.validUntil ? new Date(`${draft.validUntil}T23:59:59+08:00`).toISOString() : null,
  };
}

function stateLabel(status: NoteMemory['status']) {
  return {
    candidate: '待确认',
    confirmed: '已启用',
    paused: '已暂停',
    superseded: '已替换',
    deleted: '已删除',
  }[status];
}

function formatPeriod(validFrom: string, validUntil: string | null) {
  const from = validFrom.slice(0, 10);
  return validUntil ? `有效期 ${from} 至 ${validUntil.slice(0, 10)}` : `自 ${from} 起生效`;
}

function emptyTitle(filter: MemoryFilter) {
  if (filter === 'candidate') return '暂无待确认记忆';
  if (filter === 'active') return '暂无已启用记忆';
  if (filter === 'paused') return '暂无暂停记忆';
  return '暂无历史记录';
}

function emptyHint(filter: MemoryFilter) {
  return filter === 'candidate' ? 'AI 只会把明确、稳定的信息整理为候选，未经确认不会使用。' : '状态变化后会自动归入对应分类。';
}
