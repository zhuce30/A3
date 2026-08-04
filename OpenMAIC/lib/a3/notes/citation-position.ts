import type { Node as ProseMirrorNode } from 'prosemirror-model';

interface CitationOffsets {
  paragraphIndex?: number;
  charStart?: number;
  charEnd?: number;
}

interface MappedCharacter {
  value: string;
  from: number | null;
  to: number | null;
}

export interface NoteCitationSelection {
  from: number;
  to: number;
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'code_block', 'list_item']);
const MATH_TYPES = new Set([
  'math_inline',
  'math_display',
  'inline_math',
  'block_math',
  'equation',
  'inline_equation',
  'block_equation',
]);
const PYTHON_LINE_BOUNDARIES = new Set(['\n', '\r', '\v', '\f', '\u001c', '\u001d', '\u001e', '\u0085', '\u2028', '\u2029']);

const unboundCharacters = (value: string): MappedCharacter[] => (
  Array.from(value, (character) => ({ value: character, from: null, to: null }))
);

const isWhitespace = (character: MappedCharacter) => /\s/u.test(character.value);

function trimEnd(characters: MappedCharacter[]) {
  let end = characters.length;
  while (end > 0 && isWhitespace(characters[end - 1]!)) end -= 1;
  return characters.slice(0, end);
}

function trim(characters: MappedCharacter[]) {
  let start = 0;
  let end = characters.length;
  while (start < end && isWhitespace(characters[start]!)) start += 1;
  while (end > start && isWhitespace(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end);
}

function renderNode(node: ProseMirrorNode, position: number): MappedCharacter[] {
  const type = node.type.name;
  if (node.isText) {
    const result: MappedCharacter[] = [];
    let offset = position;
    for (const character of Array.from(node.text ?? '')) {
      const width = character.length;
      result.push({ value: character, from: offset, to: offset + width });
      offset += width;
    }
    return result;
  }
  if (type === 'hard_break' || type === 'hardBreak') return unboundCharacters('\n');

  if (MATH_TYPES.has(type)) {
    const formula = node.attrs.latex || node.attrs.value || node.attrs.text;
    if (typeof formula === 'string') return unboundCharacters(formula);
  }
  if (type === 'attachment_reference' || type === 'attachment_ref') {
    return typeof node.attrs.label === 'string' ? unboundCharacters(node.attrs.label) : [];
  }
  if (type === 'image') {
    return typeof node.attrs.alt === 'string' ? unboundCharacters(node.attrs.alt) : [];
  }

  const renderedChildren: MappedCharacter[][] = [];
  node.forEach((child, offset) => {
    renderedChildren.push(renderNode(child, position + 1 + offset));
  });

  if (type === 'table_row' || type === 'tableRow') {
    const cells = renderedChildren.map(trim).filter((cell) => cell.length > 0);
    const result: MappedCharacter[] = [];
    cells.forEach((cell, index) => {
      if (index > 0) result.push(...unboundCharacters('\t'));
      result.push(...cell);
    });
    result.push(...unboundCharacters('\n'));
    return result;
  }

  const rendered = renderedChildren.flat();
  return BLOCK_TYPES.has(type)
    ? [...trimEnd(rendered), ...unboundCharacters('\n')]
    : rendered;
}

function normalizeBackendText(characters: MappedCharacter[]) {
  const lines: MappedCharacter[][] = [[]];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (PYTHON_LINE_BOUNDARIES.has(character.value)) {
      if (character.value === '\r' && characters[index + 1]?.value === '\n') index += 1;
      lines.push([]);
    } else {
      lines[lines.length - 1]!.push(character);
    }
  }
  const normalized: MappedCharacter[] = [];
  for (const line of lines.map(trimEnd).filter((item) => item.length > 0)) {
    if (normalized.length > 0) normalized.push(...unboundCharacters('\n'));
    normalized.push(...line);
  }
  return trim(normalized);
}

function paragraphBounds(characters: MappedCharacter[], paragraphIndex: number) {
  let currentParagraph = 0;
  let start = 0;
  for (let index = 0; index <= characters.length; index += 1) {
    if (index === characters.length || characters[index]!.value === '\n') {
      if (currentParagraph === paragraphIndex) return { start, end: index };
      currentParagraph += 1;
      start = index + 1;
    }
  }
  return null;
}

export function mapNoteCitationToSelection(
  documentNode: ProseMirrorNode,
  citation: CitationOffsets,
): NoteCitationSelection | null {
  const charStart = citation.charStart;
  const charEnd = citation.charEnd;
  if (
    typeof charStart !== 'number'
    || typeof charEnd !== 'number'
    || !Number.isInteger(charStart)
    || !Number.isInteger(charEnd)
    || charStart < 0
    || charEnd <= charStart
  ) {
    return null;
  }

  const flattened = normalizeBackendText(renderNode(documentNode, -1));
  if (charEnd > flattened.length) return null;
  const paragraphIndex = citation.paragraphIndex;
  if (paragraphIndex !== undefined) {
    if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) return null;
    const bounds = paragraphBounds(flattened, paragraphIndex);
    if (!bounds || charStart < bounds.start || charEnd > bounds.end) return null;
  }

  const mapped = flattened.slice(charStart, charEnd).filter((character) => (
    character.from !== null && character.to !== null
  ));
  const first = mapped[0];
  const last = mapped[mapped.length - 1];
  if (!first || !last || first.from === null || last.to === null) return null;
  return { from: first.from, to: last.to };
}
