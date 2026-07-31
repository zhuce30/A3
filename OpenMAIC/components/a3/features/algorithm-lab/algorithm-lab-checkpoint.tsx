'use client';

import { CheckCircle2, CircleHelp } from 'lucide-react';
import { useState } from 'react';
import type { CpuCheckpointDefinition } from './cpu-scheduling-visualizer';

interface AlgorithmLabCheckpointProps {
  checkpoint: CpuCheckpointDefinition;
  submittedAnswer?: string;
  onSubmit: (answer: string) => void;
}

export function AlgorithmLabCheckpoint({
  checkpoint,
  submittedAnswer,
  onSubmit,
}: AlgorithmLabCheckpointProps) {
  const [draft, setDraft] = useState(submittedAnswer ?? '');

  const answered = typeof submittedAnswer === 'string';
  const correct = answered && submittedAnswer === checkpoint.correctAnswer;

  return (
    <section className="border-t border-[var(--a3-border)] pt-4" aria-labelledby={`${checkpoint.id}-title`}>
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div>
          <h3 id={`${checkpoint.id}-title`} className="text-sm font-semibold leading-5 text-[var(--a3-text)]">
            {checkpoint.question}
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">{checkpoint.context}</p>
        </div>
      </div>

      <fieldset className="mt-3 space-y-2" disabled={answered}>
        <legend className="sr-only">选择答案</legend>
        {checkpoint.options.map((option) => (
          <label
            key={option}
            className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors duration-200 ${draft === option ? 'border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/35 dark:text-amber-100' : 'border-[var(--a3-border)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]'}`}
          >
            <input
              type="radio"
              name={checkpoint.id}
              value={option}
              checked={draft === option}
              onChange={() => setDraft(option)}
              className="accent-amber-500"
            />
            <span>{option}</span>
          </label>
        ))}
      </fieldset>

      {!answered ? (
        <button
          type="button"
          disabled={!draft}
          onClick={() => onSubmit(draft)}
          className="mt-3 inline-flex h-9 items-center justify-center rounded-md bg-amber-500 px-3 text-xs font-semibold text-slate-950 transition-colors duration-200 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          提交答案
        </button>
      ) : (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5 ${correct ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/35 dark:text-amber-100'}`}
          aria-live="polite"
        >
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          {correct ? '回答正确。' : `本题答案：${checkpoint.correctAnswer}`}
        </div>
      )}
    </section>
  );
}
