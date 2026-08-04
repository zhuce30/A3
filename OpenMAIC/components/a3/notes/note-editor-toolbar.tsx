'use client';

import { useMemo, useRef, useState, type ComponentType } from 'react';
import {
  Bold, Braces, Code2, Image as ImageIcon, Italic, List, ListOrdered,
  LoaderCircle, Redo2, RotateCcw, Sigma, Table2, Undo2,
} from 'lucide-react';
import katex from 'katex';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { wrapInList } from 'prosemirror-schema-list';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { noteEditorSchema } from '@/lib/a3/notes/editor-schema';

export type NoteSaveState = 'idle' | 'scheduled' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';

interface NoteEditorToolbarProps {
  view: EditorView | null;
  saveState: NoteSaveState;
  imageUploadState?: 'idle' | 'uploading' | 'error';
  imageUploadError?: string;
  onUploadImage?: (file: File) => void | Promise<void>;
  onRetry?: () => void;
}

const saveLabels: Record<NoteSaveState, string> = {
  idle: '未修改',
  scheduled: '等待保存',
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

export function NoteEditorToolbar({
  view,
  saveState,
  imageUploadState = 'idle',
  imageUploadError = '',
  onUploadImage,
  onRetry,
}: NoteEditorToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaMode, setFormulaMode] = useState<'inline' | 'display'>('inline');
  const [latex, setLatex] = useState('');
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
    const value = latex.trim();
    if (!view || !value) return;
    const nodeType = formulaMode === 'display' ? 'math_display' : 'math_inline';
    view.dispatch(view.state.tr.replaceSelectionWith(noteEditorSchema.node(nodeType, { latex: value })).scrollIntoView());
    view.focus();
    setFormulaOpen(false);
    setLatex('');
  };

  const selectImage = (file?: File) => {
    if (!file || !onUploadImage) return;
    void onUploadImage(file);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const extra = [
    { label: '插入表格', icon: Table2, action: insertTable },
    { label: '插入公式', icon: Sigma, action: () => setFormulaOpen(true) },
  ];

  const formulaPreview = useMemo(() => {
    if (!latex.trim()) return '';
    try {
      return katex.renderToString(latex.trim(), {
        displayMode: formulaMode === 'display',
        throwOnError: false,
        strict: 'warn',
        trust: false,
        output: 'htmlAndMathml',
        maxExpand: 1000,
      });
    } catch {
      return '';
    }
  }, [formulaMode, latex]);

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
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="从本地插入图片"
          className="sr-only"
          onChange={(event) => selectImage(event.currentTarget.files?.[0])}
        />
        <ToolbarButton
          label={imageUploadState === 'uploading' ? '图片上传中' : '从本地插入图片'}
          disabled={!view || !onUploadImage || imageUploadState === 'uploading'}
          onClick={() => imageInputRef.current?.click()}
        >
          {imageUploadState === 'uploading' ? <LoaderCircle className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
        </ToolbarButton>
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
      <Dialog open={formulaOpen} onOpenChange={setFormulaOpen}>
        <DialogContent className="w-[min(34rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>插入 LaTeX 公式</DialogTitle>
            <DialogDescription>输入 LaTeX 内容并预览，粘贴笔记时也支持 $...$ 和 $$...$$。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-5 py-4">
            <div className="inline-flex h-9 rounded-md bg-muted p-1" aria-label="公式显示方式">
              {(['inline', 'display'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFormulaMode(mode)}
                  className={cn(
                    'h-7 rounded px-3 text-sm transition-colors',
                    formulaMode === mode ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {mode === 'inline' ? '行内公式' : '独立公式'}
                </button>
              ))}
            </div>
            <Textarea
              aria-label="LaTeX 公式"
              value={latex}
              onChange={(event) => setLatex(event.target.value)}
              placeholder="例如：E=mc^2 或 \\sum_{i=1}^{n} x_i"
              className="min-h-24 resize-y font-mono"
            />
            <div className="flex flex-wrap gap-2" aria-label="公式示例">
              {['\\frac{a}{b}', '\\sum_{i=1}^{n}x_i', '\\sqrt{x^2+y^2}', 'P(A\\mid B)'].map((value) => (
                <button key={value} type="button" onClick={() => setLatex(value)} className="rounded border border-border px-2.5 py-1.5 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  {value}
                </button>
              ))}
            </div>
            <div className="flex min-h-24 items-center justify-center overflow-x-auto rounded-md border border-border bg-muted/20 px-4 py-5" aria-label="公式预览">
              {formulaPreview
                ? <div dangerouslySetInnerHTML={{ __html: formulaPreview }} />
                : <span className="text-sm text-muted-foreground">公式预览</span>}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-5 py-3">
            <Button type="button" variant="outline" onClick={() => setFormulaOpen(false)}>取消</Button>
            <Button type="button" disabled={!latex.trim() || !view} onClick={insertFormula}>插入公式</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {imageUploadState === 'error' && imageUploadError && (
        <span className="sr-only" role="alert">{imageUploadError}</span>
      )}
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
