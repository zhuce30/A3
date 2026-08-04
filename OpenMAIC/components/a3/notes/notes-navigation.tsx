'use client';

import {
  CalendarDays,
  Clock3,
  FileClock,
  Inbox,
  Notebook,
  Paperclip,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { NoteNotebook, NoteSummary, NoteTag } from '@/lib/a3/notes/types';
import { cn } from '@/lib/utils';

export type NotesSmartView = 'recent' | 'today' | 'daily-summaries' | 'unorganized' | 'attachments' | 'trash';

interface NotesNavigationProps {
  view: NotesSmartView;
  notebooks: NoteNotebook[];
  tags: NoteTag[];
  notes: NoteSummary[];
  selectedNotebookId: string | null;
  selectedTagId: string | null;
  selectedNoteId: string | null;
  loading: boolean;
  error: string;
  busyNoteId: string | null;
  onSelectView: (view: NotesSmartView) => void;
  onSelectNotebook: (notebookId: string) => void;
  onSelectTag: (tagId: string) => void;
  onSelectNote: (note: NoteSummary) => void;
  onCreateNote: () => void;
  onDeleteNote: (note: NoteSummary) => void;
  onRestoreNote: (note: NoteSummary) => void;
  onRetry: () => void;
  noteButtonRef?: (noteId: string, element: HTMLButtonElement | null) => void;
}

const smartViews: Array<{ id: NotesSmartView; label: string; icon: typeof Clock3 }> = [
  { id: 'recent', label: '最近编辑', icon: Clock3 },
  { id: 'today', label: '今天', icon: CalendarDays },
  { id: 'daily-summaries', label: '每日总结', icon: FileClock },
  { id: 'unorganized', label: '未整理', icon: Inbox },
  { id: 'attachments', label: '含附件', icon: Paperclip },
  { id: 'trash', label: '回收站', icon: Trash2 },
];

export function NotesNavigation({
  view,
  notebooks,
  tags,
  notes,
  selectedNotebookId,
  selectedTagId,
  selectedNoteId,
  loading,
  error,
  busyNoteId,
  onSelectView,
  onSelectNotebook,
  onSelectTag,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
  onRestoreNote,
  onRetry,
  noteButtonRef,
}: NotesNavigationProps) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label="个人笔记导航">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">个人笔记</h1>
          <p className="text-xs text-muted-foreground">{notes.length} 篇</p>
        </div>
        <Button type="button" size="icon-sm" className="size-8 rounded-md" aria-label="快速新建笔记" title="快速新建笔记" onClick={onCreateNote}>
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavigationSection label="智能视图">
          {smartViews.map((item) => (
            <NavButton
              key={item.id}
              label={item.label}
              active={view === item.id && !selectedNotebookId && !selectedTagId}
              icon={item.icon}
              onClick={() => onSelectView(item.id)}
            />
          ))}
        </NavigationSection>

        {notebooks.length > 0 && (
          <NavigationSection label="笔记本">
            {notebooks.map((item) => (
              <NavButton
                key={item.id}
                label={item.name}
                active={selectedNotebookId === item.id}
                icon={Notebook}
                count={item.noteCount}
                onClick={() => onSelectNotebook(item.id)}
              />
            ))}
          </NavigationSection>
        )}

        {tags.length > 0 && (
          <NavigationSection label="标签">
            {tags.map((item) => (
              <NavButton
                key={item.id}
                label={item.name}
                active={selectedTagId === item.id}
                icon={Tag}
                color={item.color}
                onClick={() => onSelectTag(item.id)}
              />
            ))}
          </NavigationSection>
        )}

        <section className="border-t border-border/70 py-2" aria-label="笔记列表">
          {loading ? (
            <div className="space-y-2 px-3 py-3" aria-label="正在加载笔记">
              <div className="h-12 animate-pulse rounded-md bg-muted" />
              <div className="h-12 animate-pulse rounded-md bg-muted" />
            </div>
          ) : error ? (
            <div className="px-3 py-5 text-center" role="alert">
              <p className="text-sm text-destructive">{error}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3 rounded-md" onClick={onRetry}>重试</Button>
            </div>
          ) : notes.length === 0 ? (
            <EmptyNotes view={view} onCreateNote={onCreateNote} />
          ) : (
            <div className="py-1">
              {notes.map((item) => (
                <div key={item.id} className={cn('group flex min-w-0 items-center border-l-2 pr-1', selectedNoteId === item.id ? 'border-blue-600 bg-blue-50/80 dark:bg-blue-950/30' : 'border-transparent')}>
                  <button
                    ref={(element) => noteButtonRef?.(item.id, element)}
                    type="button"
                    aria-label={item.title || '无标题笔记'}
                    onClick={() => onSelectNote(item)}
                    className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                  >
                    <span className="block truncate text-sm font-medium">{item.title || '无标题笔记'}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.contentText || formatEditedAt(item.lastEditedAt)}</span>
                  </button>
                  {view === 'trash' ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="size-8 shrink-0 rounded-md"
                      aria-label="恢复笔记"
                      disabled={busyNoteId === item.id}
                      onClick={() => onRestoreNote(item)}
                    >
                      <RotateCcw className="size-4" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="size-8 shrink-0 rounded-md opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label="移到回收站"
                      disabled={busyNoteId === item.id}
                      onClick={() => onDeleteNote(item)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function NavigationSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="px-2 py-2" aria-label={label}>
      <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{label}</h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function NavButton({ label, active, icon: Icon, count, color, onClick }: {
  label: string;
  active: boolean;
  icon: typeof Clock3;
  count?: number;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        active ? 'bg-blue-50 font-medium text-blue-800 dark:bg-blue-950/40 dark:text-blue-200' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" style={color ? { color } : undefined} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof count === 'number' && <span className="text-xs tabular-nums">{count}</span>}
    </button>
  );
}

function EmptyNotes({ view, onCreateNote }: { view: NotesSmartView; onCreateNote: () => void }) {
  const label = view === 'trash'
    ? '回收站为空'
    : view === 'daily-summaries'
      ? '暂无每日总结'
      : '还没有笔记';
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm text-muted-foreground">{label}</p>
      {view !== 'trash' && view !== 'daily-summaries' && (
        <Button type="button" size="sm" className="mt-3 rounded-md" onClick={onCreateNote}>
          <Plus className="size-4" />新建笔记
        </Button>
      )}
    </div>
  );
}

function formatEditedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '最近编辑' : date.toLocaleDateString('zh-CN');
}
