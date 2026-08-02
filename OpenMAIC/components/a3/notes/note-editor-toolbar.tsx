'use client';

import type { ComponentType } from 'react';
import {
  Bold, Braces, Code2, Image as ImageIcon, Italic, List, ListOrdered,
  Redo2, RotateCcw, Sigma, Table2, Undo2,
} from 'lucide-react';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { wrapInList } from 'prosemirror-schema-list';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isSafeNoteImage, noteEditorSchema } from '@/lib/a3/notes/editor-schema';

export type NoteSaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';

interface NoteEditorToolbarProps {
  view: EditorView | null;
  saveState: NoteSaveState;
  onRetry?: () => void;
}

const saveLabels: Record<NoteSaveState, string> = {
  idle: '未修改',
  saving: '正在保存',
  saved: '已保存',
  offline: '离线待同步',
  conflict: '存在冲突',
  error: '保存失败',
};

function run(view: EditorView | null, command: Command) {
  if (!view) return false;
  const handled = command(view.state, view.dispatch, view);
  if (handled) view.focus();
  return handled;
}

export function NoteEditorToolbar({ view, saveState, onRetry }: NoteEditorToolbarProps) {
  const strong = noteEditorSchema.marks.strong;
  const em = noteEditorSchema.marks.em;
  const code = noteEditorSchema.marks.code;
  const actions: Array<{ label: string; icon: ComponentType<{ className?: string }>; command: Command }> = [
    { label: '粗体', icon: Bold, command: toggleMark(strong) },
    { label: '斜体', icon: Italic, command: toggleMark(em) },
    { label: '行内代码', icon: Braces, command: toggleMark(code) },
    { label: '无序列表', icon: List, command: wrapInList(noteEditorSchema.nodes.bullet_list) },
    { label: '有序列表', icon: ListOrdered, command: wrapInList(noteEditorSchema.nodes.ordered_list) },
    { label: '代码块', icon: Code2, command: setBlockType(noteEditorSchema.nodes.code_block, { language: null, params: null }) },
    { label: '撤销', icon: Undo2, command: undo },
    { label: '重做', icon: Redo2, command: redo },
  ];

  const insertTable = () => {
    if (!view) return;
    const paragraph = noteEditorSchema.node('paragraph');
    const cell = noteEditorSchema.node('table_cell', null, paragraph);
    const row = noteEditorSchema.node('table_row', null, [cell, cell]);
    const table = noteEditorSchema.node('table', null, [row, row]);
    view.dispatch(view.state.tr.replaceSelectionWith(table).scrollIntoView());
    view.focus();
  };

  const insertFormula = () => {
    if (!view) return;
    const latex = window.prompt('输入 LaTeX 公式')?.trim();
    if (!latex) return;
    view.dispatch(view.state.tr.replaceSelectionWith(noteEditorSchema.node('math_inline', { latex })).scrollIntoView());
    view.focus();
  };

  const insertImage = () => {
    if (!view) return;
    const src = window.prompt('输入图片 HTTPS 地址')?.trim();
    if (!src || !isSafeNoteImage(src)) return;
    const alt = window.prompt('图片说明')?.trim() || null;
    view.dispatch(view.state.tr.replaceSelectionWith(noteEditorSchema.node('image', { src, alt })).scrollIntoView());
    view.focus();
  };

  const extra = [
    { label: '插入表格', icon: Table2, action: insertTable },
    { label: '插入公式', icon: Sigma, action: insertFormula },
    { label: '插入图片', icon: ImageIcon, action: insertImage },
  ];

  return (
    <div className="flex min-h-11 min-w-0 items-center gap-1 border-b border-border/70 bg-muted/30 px-2 py-1.5" role="toolbar" aria-label="笔记格式工具">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
        {actions.map(({ label, icon: Icon, command }) => {
          const enabled = Boolean(view && command(view.state));
          return (
            <ToolbarButton key={label} label={label} disabled={!enabled} onClick={() => run(view, command)}>
              <Icon className="size-4" />
            </ToolbarButton>
          );
        })}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {extra.map(({ label, icon: Icon, action }) => (
          <ToolbarButton key={label} label={label} disabled={!view} onClick={action}>
            <Icon className="size-4" />
          </ToolbarButton>
        ))}
      </div>
      <div
        data-testid="note-save-status"
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-xs tabular-nums text-muted-foreground',
          saveState === 'conflict' && 'text-destructive',
          saveState === 'offline' && 'text-amber-700 dark:text-amber-300',
        )}
        role="status"
        aria-live="polite"
      >
        <span className={cn('size-1.5 rounded-full bg-muted-foreground/50', saveState === 'saving' && 'animate-pulse bg-amber-500', saveState === 'saved' && 'bg-emerald-600', saveState === 'conflict' && 'bg-destructive')} />
        {saveLabels[saveState]}
        {(saveState === 'offline' || saveState === 'error') && onRetry && (
          <button type="button" onClick={onRetry} className="ml-1 inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <RotateCcw className="size-3" />重试
          </button>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          className="size-8 rounded-md focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}
