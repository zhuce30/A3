// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AlgorithmLabInputPanel } from '@/components/a3/features/algorithm-lab/algorithm-lab-input-panel';
import type { PageReplacementInput } from '@/lib/a3/algorithm-lab/contracts';
import { getAlgorithmLabDefinition } from '@/lib/a3/algorithm-lab/registry';

const definition = getAlgorithmLabDefinition('page-replacement')!;
const foundation = definition.presets.find(({ id }) => id === 'page-foundation')!;

let root: Root | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function PageInputHarness() {
  const [presetId, setPresetId] = useState(foundation.id);
  const [input, setInput] = useState<PageReplacementInput>(() => structuredClone(
    foundation.input as PageReplacementInput,
  ));

  return (
    <>
      <AlgorithmLabInputPanel
        definition={definition}
        presetId={presetId}
        selectedAlgorithms={['fifo']}
        pageInput={input}
        onSelectPreset={(nextPresetId) => {
          const preset = definition.presets.find(({ id }) => id === nextPresetId);
          if (!preset) return;
          setPresetId(preset.id);
          setInput(structuredClone(preset.input as PageReplacementInput));
        }}
        onToggleAlgorithm={() => undefined}
        onPageInputChange={(nextInput) => {
          setPresetId('custom');
          setInput(nextInput);
        }}
      />
      <button
        type="button"
        data-testid="external-reset"
        onClick={() => {
          setPresetId(foundation.id);
          setInput(structuredClone(foundation.input as PageReplacementInput));
        }}
      >
        测试重置
      </button>
    </>
  );
}

describe('page replacement input draft lifecycle', () => {
  it('keeps the textarea mounted, focused, and at the same caret when editing becomes custom', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<PageInputHarness />));

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const editedValue = `${textarea.value}, 9`;
    textarea.focus();

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        editedValue,
      );
      textarea.setSelectionRange(4, 4);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(4);
    expect(textarea.value).toBe(editedValue);
    expect(container.querySelector<HTMLSelectElement>('#algorithm-lab-preset')!.value).toBe('custom');
  });

  it('synchronizes the existing textarea only when an external preset or reset changes references', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<PageInputHarness />));

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const presetSelect = container.querySelector<HTMLSelectElement>('#algorithm-lab-preset')!;
    const misconception = definition.presets.find(({ id }) => id === 'page-misconception')!;

    act(() => {
      presetSelect.value = misconception.id;
      presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe((misconception.input as PageReplacementInput).referenceString.join(', '));

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="external-reset"]')!.click());

    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe((foundation.input as PageReplacementInput).referenceString.join(', '));
  });
});
