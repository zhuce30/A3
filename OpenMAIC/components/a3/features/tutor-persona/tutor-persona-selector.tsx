'use client';

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Blocks,
  BookOpenCheck,
  Dumbbell,
  Lightbulb,
  Loader2,
  RefreshCw,
  Square,
  Star,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { A3TutorPersona, A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';
import { useTutorVoicePreview } from './use-tutor-voice-preview';

type TutorPersonaSelectorProps = {
  personas: Array<A3TutorPersona & { enabled?: boolean }>;
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
  const voicePreview = useTutorVoicePreview();
  const optionRefs = useRef(new Map<A3TutorPersonaId, HTMLButtonElement>());
  const enabledPersonas = saving ? [] : personas.filter((persona) => persona.enabled !== false);
  const selectedEnabled = enabledPersonas.some((persona) => persona.id === selectedPersonaId);
  const rovingPersonaId = selectedEnabled ? selectedPersonaId : enabledPersonas[0]?.id;

  const handlePersonaKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    personaId: A3TutorPersonaId,
  ) => {
    const supportedKeys = new Set([
      'ArrowLeft',
      'ArrowUp',
      'ArrowRight',
      'ArrowDown',
      'Home',
      'End',
    ]);
    if (!supportedKeys.has(event.key) || enabledPersonas.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = enabledPersonas.findIndex((persona) => persona.id === personaId);
    let targetIndex = currentIndex;
    if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = enabledPersonas.length - 1;
    else {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      targetIndex = (Math.max(currentIndex, 0) + direction + enabledPersonas.length)
        % enabledPersonas.length;
    }
    const target = enabledPersonas[targetIndex];
    optionRefs.current.get(target.id)?.focus();
    void onSelect(target.id);
  };

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
          const personaEnabled = persona.enabled !== false;
          const recommended = persona.id === recommendedPersonaId;
          const Icon = PERSONA_ICONS[persona.id];
          const previewStatus = voicePreview.state.personaId === persona.id
            ? voicePreview.state.status
            : 'idle';
          const previewUnavailable = !personaEnabled || !persona.voicePreviewEnabled;
          const previewActive = previewStatus === 'loading' || previewStatus === 'playing';
          const previewLabel = previewUnavailable
            ? `${persona.name}音色试听不可用`
            : previewActive
              ? `停止试听${persona.name}音色`
              : previewStatus === 'error'
                ? `重试试听${persona.name}音色`
                : `试听${persona.name}音色`;
          const PreviewIcon = previewUnavailable
            ? VolumeX
            : previewStatus === 'loading'
              ? Loader2
              : previewStatus === 'playing'
                ? Square
                : previewStatus === 'error'
                  ? RefreshCw
                  : Volume2;
          return (
            <div
              key={persona.id}
              className={cn(
                'relative min-w-0 overflow-hidden rounded transition-colors',
                selected
                  ? 'bg-[#fffdf7] shadow-sm ring-1 ring-[#b8c6bd]'
                  : 'hover:bg-[#ebe7dc]',
              )}
            >
              <button
                ref={(node) => {
                  if (node) optionRefs.current.set(persona.id, node);
                  else optionRefs.current.delete(persona.id);
                }}
                type="button"
                role="radio"
                data-testid={`a3-tutor-persona-option-${persona.id}`}
                aria-checked={selected}
                tabIndex={rovingPersonaId === persona.id ? 0 : -1}
                disabled={saving || !personaEnabled}
                title={persona.shortDescription}
                onClick={() => void onSelect(persona.id)}
                onKeyDown={(event) => handlePersonaKeyDown(event, persona.id)}
                className={cn(
                  'block w-full px-3 pr-12 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b53] focus-visible:ring-inset disabled:cursor-wait disabled:opacity-65',
                  compact ? 'min-h-[76px] py-1.5' : 'min-h-[84px] py-2',
                  selected ? 'text-[#153f32]' : 'text-[#4f6059]',
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon className={cn('size-4 shrink-0', selected ? 'text-[#1f6b53]' : 'text-[#7a8781]')} />
                  <span className="truncate text-sm font-semibold">{persona.name}</span>
                </span>
                <span className="mt-1.5 line-clamp-2 block text-xs leading-5 text-[#6a7771]">
                  {persona.shortDescription}
                </span>
                <span className="mt-1 flex min-h-4 items-center gap-2">
                  {recommended ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8a6818]">
                      <Star className="size-3" />适合当前基础
                    </span>
                  ) : null}
                  {previewUnavailable ? (
                    <span className="text-[11px] font-medium text-[#8a7560]">不可试听</span>
                  ) : null}
                </span>
              </button>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid={`a3-tutor-voice-preview-${persona.id}`}
                    aria-label={previewLabel}
                    disabled={previewUnavailable}
                    onClick={(event) => {
                      event.stopPropagation();
                      void voicePreview.togglePreview(persona.id);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    className={cn(
                      'absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b53] focus-visible:ring-offset-1',
                      previewUnavailable
                        ? 'cursor-not-allowed border-[#d8d1c2] bg-[#eee9de] text-[#9a9082]'
                        : previewActive
                          ? 'border-[#c7a65c] bg-[#fff4d6] text-[#7a5712] hover:bg-[#f8e8bc]'
                          : 'border-[#d2c9b7] bg-[#fffaf0] text-[#52645d] hover:border-[#bda875] hover:bg-[#f6ecd4]',
                    )}
                  >
                    <PreviewIcon className={cn('size-4', previewStatus === 'loading' && 'animate-spin')} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{previewLabel}</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>

      {voicePreview.state.status === 'error' ? (
        <div
          role="alert"
          data-testid="a3-tutor-voice-preview-error"
          className="min-h-5 text-xs text-rose-700"
        >
          {voicePreview.state.error}
        </div>
      ) : null}

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
