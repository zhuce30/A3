'use client';

import type { LucideIcon } from 'lucide-react';
import { Blocks, BookOpenCheck, Dumbbell, Lightbulb, Loader2, RefreshCw, Star } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { A3TutorPersona, A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';

type TutorPersonaSelectorProps = {
  personas: A3TutorPersona[];
  selectedPersonaId: A3TutorPersonaId | '';
  recommendedPersonaId?: A3TutorPersonaId | '';
  loading: boolean;
  saving: boolean;
  error?: string;
  compact?: boolean;
  onSelect: (personaId: A3TutorPersonaId) => void | Promise<unknown>;
  onRetry: () => void | Promise<unknown>;
};

const PERSONA_ICONS: Record<A3TutorPersonaId, LucideIcon> = {
  'structured-teacher': BookOpenCheck,
  'socratic-guide': Lightbulb,
  'practice-coach': Dumbbell,
  'foundation-coach': Blocks,
};

export function TutorPersonaSelector({
  personas,
  selectedPersonaId,
  recommendedPersonaId = '',
  loading,
  saving,
  error = '',
  compact = false,
  onSelect,
  onRetry,
}: TutorPersonaSelectorProps) {
  if (loading && personas.length === 0) {
    return (
      <div
        data-testid="a3-tutor-persona-loading"
        className="flex min-h-20 items-center gap-2 rounded-md border border-[#ddd8ca] bg-[#fffdf7] px-4 text-sm text-[#66736d]"
      >
        <Loader2 className="size-4 animate-spin" />
        正在读取辅导方式
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="a3-tutor-persona-selector">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <span className="text-xs font-medium text-[#52645d]">辅导方式</span>
        {saving ? (
          <span className="inline-flex items-center gap-1 text-xs text-[#68766f]" aria-live="polite">
            <Loader2 className="size-3 animate-spin" />保存中
          </span>
        ) : null}
      </div>

      <div
        role="radiogroup"
        aria-label="选择辅导方式"
        className={cn(
          'grid overflow-hidden rounded-md border border-[#d8d3c5] bg-[#f4f1e8] p-1',
          compact ? 'grid-cols-2 gap-1 lg:grid-cols-4' : 'grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-4',
        )}
      >
        {personas.map((persona) => {
          const selected = persona.id === selectedPersonaId;
          const recommended = persona.id === recommendedPersonaId;
          const Icon = PERSONA_ICONS[persona.id];
          return (
            <button
              key={persona.id}
              type="button"
              data-testid={`a3-tutor-persona-option-${persona.id}`}
              aria-pressed={selected}
              disabled={saving}
              title={persona.shortDescription}
              onClick={() => void onSelect(persona.id)}
              className={cn(
                'min-h-[72px] min-w-0 rounded px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b53] focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-65',
                selected
                  ? 'bg-[#fffdf7] text-[#153f32] shadow-sm ring-1 ring-[#b8c6bd]'
                  : 'text-[#4f6059] hover:bg-[#ebe7dc]',
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className={cn('size-4 shrink-0', selected ? 'text-[#1f6b53]' : 'text-[#7a8781]')} />
                <span className="truncate text-sm font-semibold">{persona.name}</span>
              </span>
              <span className="mt-1.5 line-clamp-2 block text-xs leading-5 text-[#6a7771]">
                {persona.shortDescription}
              </span>
              {recommended ? (
                <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-[#8a6818]">
                  <Star className="size-3" />适合当前基础
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="flex min-h-8 items-center justify-between gap-3 text-xs text-rose-700" role="alert">
          <span>{error}</span>
          <button
            type="button"
            data-testid="a3-tutor-persona-retry"
            onClick={() => void onRetry()}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 font-medium text-rose-700 hover:bg-rose-50"
          >
            <RefreshCw className="size-3" />重试
          </button>
        </div>
      ) : null}
    </div>
  );
}

