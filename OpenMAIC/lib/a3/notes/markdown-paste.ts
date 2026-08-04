import { marked } from 'marked';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

import { parseNoteHtml } from './editor-schema';

const MARKDOWN_SIGNAL = /(^|\n)\s{0,3}(#{1,6}\s+|[-+*]\s+|\d+\.\s+|>\s+|```|~~~|\|.+\|\s*$)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\$\$[\s\S]+?\$\$|\$[^\n$]+\$/m;

export function looksLikeMarkdown(value: string) {
  const text = value.trim();
  if (!text || text.length > 500_000) return false;
  return MARKDOWN_SIGNAL.test(text);
}

export function markdownToNoteDocument(markdown: string): ProseMirrorNode {
  const withMath = replaceMathWithNoteNodes(markdown);
  const html = marked.parse(withMath, {
    async: false,
    breaks: false,
    gfm: true,
  }) as string;
  return parseNoteHtml(html);
}

function replaceMathWithNoteNodes(markdown: string) {
  const protectedFragments: string[] = [];
  const protect = (value: string) => {
    const index = protectedFragments.push(value) - 1;
    return `A3NOTEPROTECTED${index}TOKEN`;
  };
  let result = markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, protect)
    .replace(/`[^`\n]*`/g, protect);

  result = result
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_, latex: string) => mathNode('display', latex))
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, latex: string) => mathNode('display', latex))
    .replace(/\\\(\s*([^\n]*?)\s*\\\)/g, (_, latex: string) => mathNode('inline', latex))
    .replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_, prefix: string, latex: string) => `${prefix}${mathNode('inline', latex)}`);

  return result.replace(/A3NOTEPROTECTED(\d+)TOKEN/g, (_, index: string) => protectedFragments[Number(index)] ?? '');
}

function mathNode(mode: 'inline' | 'display', latex: string) {
  const normalized = latex.trim();
  if (!normalized) return '';
  const attribute = escapeHtmlAttribute(normalized);
  return mode === 'display'
    ? `\n<div data-note-math-display="${attribute}"></div>\n`
    : `<span data-note-math-inline="${attribute}"></span>`;
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
