import { DOMParser as ProseMirrorDOMParser, Schema, type DOMOutputSpec, type MarkSpec, type Node as ProseMirrorNode, type NodeSpec } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';
import katex from 'katex';

import { schemaMarks, schemaNodes } from '@/lib/prosemirror/schema';

const safeHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const isSafeNoteLink = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u0020]/.test(trimmed)) return false;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('#')) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' || (url.protocol === 'mailto:' && Boolean(url.pathname));
  } catch {
    return false;
  }
};

const blockAttrs = {
  align: { default: '' },
  indent: { default: 0 },
  textIndent: { default: 0 },
};

const paragraph: NodeSpec = {
  ...schemaNodes.paragraph,
  parseDOM: schemaNodes.paragraph.parseDOM?.filter((rule) => rule.tag !== 'img'),
};

const heading: NodeSpec = {
  attrs: { level: { default: 1 }, ...blockAttrs },
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  toDOM: (node) => [`h${node.attrs.level}`, 0],
};

const codeBlock: NodeSpec = {
  attrs: { params: { default: null }, language: { default: null } },
  content: 'text*',
  marks: '',
  group: 'block',
  code: true,
  defining: true,
  parseDOM: [{
    tag: 'pre',
    preserveWhitespace: 'full',
    getAttrs: (dom) => ({ language: (dom as HTMLElement).querySelector('code')?.dataset.language ?? null }),
  }],
  toDOM: (node) => ['pre', ['code', { 'data-language': node.attrs.language }, 0]],
};

const hardBreak: NodeSpec = {
  inline: true,
  group: 'inline',
  selectable: false,
  parseDOM: [{ tag: 'br' }],
  toDOM: () => ['br'],
};

const horizontalRule: NodeSpec = {
  group: 'block',
  parseDOM: [{ tag: 'hr' }],
  toDOM: () => ['hr'],
};

const image: NodeSpec = {
  attrs: {
    src: {},
    alt: { default: null },
    title: { default: null },
    width: { default: null },
    height: { default: null },
  },
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  parseDOM: [{
    tag: 'img[src]',
    getAttrs: (dom) => {
      const element = dom as HTMLImageElement;
      const src = element.getAttribute('src') ?? '';
      if (!safeHttpUrl(src)) return false;
      return {
        src,
        alt: element.alt || null,
        title: element.title || null,
        width: element.width || null,
        height: element.height || null,
      };
    },
  }],
  toDOM: (node) => ['img', node.attrs],
};

const tableCellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
  background: { default: null },
};

const table: NodeSpec = {
  content: 'table_row+',
  group: 'block',
  tableRole: 'table',
  isolating: true,
  parseDOM: [{ tag: 'table' }],
  toDOM: () => ['div', { class: 'note-table-scroll' }, ['table', ['tbody', 0]]],
};

const tableRow: NodeSpec = {
  content: '(table_cell | table_header)+',
  tableRole: 'row',
  parseDOM: [{ tag: 'tr' }],
  toDOM: () => ['tr', 0],
};

const tableCell: NodeSpec = {
  attrs: tableCellAttrs,
  content: 'block+',
  tableRole: 'cell',
  isolating: true,
  parseDOM: [{ tag: 'td' }],
  toDOM: (node) => ['td', node.attrs, 0],
};

const tableHeader: NodeSpec = {
  ...tableCell,
  tableRole: 'header_cell',
  parseDOM: [{ tag: 'th' }],
  toDOM: (node) => ['th', node.attrs, 0],
};

const mathInline: NodeSpec = {
  attrs: { latex: { default: null }, value: { default: null }, text: { default: null } },
  inline: true,
  group: 'inline',
  atom: true,
  parseDOM: [{
    tag: '[data-note-math-inline]',
    getAttrs: (dom) => ({ latex: (dom as HTMLElement).dataset.noteMathInline || null }),
  }],
  toDOM: (node) => ['span', { 'data-note-math-inline': node.attrs.latex ?? node.attrs.value ?? node.attrs.text }, node.attrs.latex ?? node.attrs.value ?? node.attrs.text],
};

const mathDisplay: NodeSpec = {
  attrs: mathInline.attrs,
  group: 'block',
  atom: true,
  parseDOM: [{
    tag: '[data-note-math-display]',
    getAttrs: (dom) => ({ latex: (dom as HTMLElement).dataset.noteMathDisplay || null }),
  }],
  toDOM: (node) => ['div', { 'data-note-math-display': node.attrs.latex ?? node.attrs.value ?? node.attrs.text }, node.attrs.latex ?? node.attrs.value ?? node.attrs.text],
};

const attachmentReference: NodeSpec = {
  attrs: {
    attachmentId: {},
    label: { default: null },
    kind: { default: null },
    mimeType: { default: null },
  },
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  parseDOM: [{
    tag: '[data-note-attachment-id]',
    getAttrs: (dom) => {
      const element = dom as HTMLElement;
      const attachmentId = element.dataset.noteAttachmentId?.trim();
      return attachmentId ? {
        attachmentId,
        label: element.dataset.noteAttachmentLabel || null,
        kind: element.dataset.noteAttachmentKind || null,
        mimeType: element.dataset.noteAttachmentMime || null,
      } : false;
    },
  }],
  toDOM: (node) => ['span', {
    'data-note-attachment-id': node.attrs.attachmentId,
    'data-note-attachment-label': node.attrs.label,
    'data-note-attachment-kind': node.attrs.kind,
    'data-note-attachment-mime': node.attrs.mimeType,
    contenteditable: 'false',
  }, `附件：${node.attrs.label || '未命名'}`],
};

const safeLink: MarkSpec = {
  ...schemaMarks.link,
  attrs: { href: {}, title: { default: null }, target: { default: '_blank' } },
  parseDOM: [{
    tag: 'a[href]',
    getAttrs: (dom: HTMLElement) => {
      const href = dom.getAttribute('href') ?? '';
      return isSafeNoteLink(href) ? { href, title: dom.getAttribute('title'), target: '_blank' } : false;
    },
  }],
  toDOM: (mark): DOMOutputSpec => ['a', { ...mark.attrs, rel: 'noopener noreferrer' }, 0],
};

export const noteEditorSchema = new Schema({
  nodes: {
    ...schemaNodes,
    paragraph,
    heading,
    code_block: codeBlock,
    hard_break: hardBreak,
    horizontal_rule: horizontalRule,
    image,
    table,
    table_row: tableRow,
    table_cell: tableCell,
    table_header: tableHeader,
    math_inline: mathInline,
    math_display: mathDisplay,
    attachment_reference: attachmentReference,
  },
  marks: { ...schemaMarks, link: safeLink },
});

export const emptyNoteDocument = () => noteEditorSchema.node('doc', null, [noteEditorSchema.node('paragraph')]);

export function parseNoteDocument(content: Record<string, unknown>): ProseMirrorNode {
  try {
    return noteEditorSchema.nodeFromJSON(sanitizeDocumentJson(content));
  } catch {
    return emptyNoteDocument();
  }
}

export function parseNoteHtml(html: string): ProseMirrorNode {
  if (typeof document === 'undefined') return emptyNoteDocument();
  const parsed = new window.DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script,style,iframe,object,embed,base,meta').forEach((element) => element.remove());
  return ProseMirrorDOMParser.fromSchema(noteEditorSchema).parse(parsed.body);
}

export function createAttachmentReference(input: { id: string; label: string; kind: string; mimeType: string }) {
  return {
    type: 'attachment_reference',
    attrs: {
      attachmentId: input.id,
      label: input.label,
      kind: input.kind,
      mimeType: input.mimeType,
    },
  };
}

export const isSafeNoteImage = safeHttpUrl;

export function createMathNodeView(node: ProseMirrorNode): NodeView {
  const displayMode = node.type.name === 'math_display';
  const dom = document.createElement(displayMode ? 'div' : 'span');
  const latex = String(node.attrs.latex ?? node.attrs.value ?? node.attrs.text ?? '');
  dom.dataset[displayMode ? 'noteMathDisplay' : 'noteMathInline'] = latex;
  dom.contentEditable = 'false';
  katex.render(latex, dom, {
    displayMode,
    throwOnError: false,
    strict: 'warn',
    trust: false,
    output: 'htmlAndMathml',
    maxExpand: 1000,
  });
  return { dom };
}

function sanitizeDocumentJson(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeNodeJson(value);
  return sanitized?.type === 'doc' ? sanitized : { type: 'doc', content: [] };
}

function sanitizeNodeJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const node = value as Record<string, unknown>;
  const type = typeof node.type === 'string' ? node.type : '';
  const attrs = node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs)
    ? { ...(node.attrs as Record<string, unknown>) }
    : undefined;
  if (type === 'image' && (typeof attrs?.src !== 'string' || !safeHttpUrl(attrs.src))) return null;
  if (type === 'attachment_reference' && (typeof attrs?.attachmentId !== 'string' || !attrs.attachmentId.trim())) return null;
  const result: Record<string, unknown> = { ...node };
  if (attrs) result.attrs = attrs;
  if (Array.isArray(node.marks)) {
    result.marks = node.marks.filter((mark) => {
      if (!mark || typeof mark !== 'object' || Array.isArray(mark)) return false;
      const record = mark as Record<string, unknown>;
      if (record.type !== 'link') return true;
      const markAttrs = record.attrs as Record<string, unknown> | undefined;
      return typeof markAttrs?.href === 'string' && isSafeNoteLink(markAttrs.href);
    });
  }
  if (Array.isArray(node.content)) {
    result.content = node.content.map(sanitizeNodeJson).filter((child): child is Record<string, unknown> => child !== null);
  }
  return result;
}
