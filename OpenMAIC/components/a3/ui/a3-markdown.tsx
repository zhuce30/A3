import katex from 'katex';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type A3MarkdownProps = {
  children: string;
  className?: string;
};

const PPT_SYMBOL_REPAIRS: Record<string, string> = {
  '\uf02d': '-',
  '\uf051': '-',
  '\uf061': '\u03b1',
  '\uf065': '\u03b5',
  '\uf06a': '\u03c6',
  '\uf070': '\u03c0',
  '\uf071': '\u03b8',
  '\uf072': '\u03c1',
  '\uf073': '\u03c3',
  '\uf077': '\u03c9',
  '\uf0a3': '\u2264',
  '\uf0a5': '\u221e',
  '\uf0ad': '\u2191',
  '\uf0ae': '\u2192',
  '\uf0af': '\u2193',
  '\uf0b0': '\u00b0',
  '\uf0b3': '\u2265',
  '\uf0b4': '\u00d7',
  '\uf0d0': '\u2220',
  '\uf0e5': '\u03a3',
  '□': '-',
  '�': '',
};

export function A3Markdown({ children, className }: A3MarkdownProps) {
  return (
    <div
      className={cn(
        'a3-markdown max-w-none text-sm leading-7',
        '[&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold',
        '[&_h4]:mt-3 [&_h4]:mb-2 [&_h4]:text-sm [&_h4]:font-semibold',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5',
        '[&_strong]:font-semibold [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden',
        className,
      )}
    >
      {renderMarkdown(normalizeMarkdown(children))}
    </div>
  );
}

function normalizeMarkdown(markdown: string) {
  return repairMisusedDisplayMathDelimiters(repairAssistantMarkdownNoise(repairPptSymbolFont(markdown)))
    .split(/\r?\n/)
    .map(repairInlineBlockMarkers)
    .flatMap(repairCompactPipeTableLine)
    .map(repairMixedLatexLine)
    .map(repairLooseEquationLine)
    .join('\n');
}

function repairAssistantMarkdownNoise(markdown: string) {
  return markdown
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+>\s*$/gm, '')
    .replace(/^\s*[,，]\s*(?=(?:即|因此|所以|故|这|其中))/gm, '')
    .replace(/^\s*-\s+(?=(?:因此|所以|故|这就是|下一步|紧扣|考虑|可见|由于|其中))/gm, '')
    .replace(/^\s*>\s*---\s*(#{1,6}\s+)/gm, '$1')
    .replace(/^\s*---\s*(#{1,6}\s+)/gm, '$1')
    .replace(/([^\n])\s+---\s+(#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/([。！？；;])\s+(#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/[ \t]+\$/g, ' $')
    .replace(/\$[ \t]+/g, '$');
}

function repairMisusedDisplayMathDelimiters(markdown: string) {
  return markdown
    .split(/\r?\n/)
    .flatMap((line) => {
      let repaired = line;
      const completeDisplayMath = repaired.match(/^(\s*)\$\$\s*([\s\S]*?)\s*\$\$(\s*)$/);
      if (completeDisplayMath && !looksLikeProseWrappedByDisplayMath(completeDisplayMath[2])) {
        return [repaired];
      }
      const leading = repaired.match(/^(\s*)\$\$\s*(.*)$/);
      if (leading && looksLikeProseWrappedByDisplayMath(leading[2])) {
        repaired = `${leading[1]}${leading[2]}`;
      }
      const trailing = repaired.match(/^(.*?)(\s*)\$\$\s*$/);
      if (trailing && looksLikeProseWrappedByDisplayMath(trailing[1])) {
        repaired = `${trailing[1]}${trailing[2]}`;
      }
      repaired = repaired.replace(/([。！？；;])\s+(#{1,6}\s+)/g, '$1\n\n$2');
      return repaired.split('\n');
    })
    .join('\n');
}

function looksLikeProseWrappedByDisplayMath(value: string) {
  const text = value.trim();
  if (!text) return false;
  if (looksLikeMathExpression(text)) return false;
  if (/^(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|\*\*)/.test(text)) return true;
  return /[\u3400-\u9fff]/.test(text);
}

function looksLikeMathExpression(value: string) {
  const text = value.trim().replace(/[。．.，,；;：:]$/u, '');
  if (!text) return false;
  if (/^(?:[A-Za-z]\\?\w*|\\[a-zA-Z]+|[({\\])/.test(text) && /(?:=|\\frac|\\quad|\\omega|\\angle|\\Leftrightarrow|\\text)/.test(text)) {
    return true;
  }
  return /^[A-Za-z0-9_{}^()+\-*/=.,\s\\[\]<>|]+$/.test(text) && /(?:=|\\[a-zA-Z])/.test(text);
}

function repairPptSymbolFont(markdown: string) {
  return markdown.replace(/[\ue000-\uf8ff□�]/g, (char) => PPT_SYMBOL_REPAIRS[char] ?? '');
}

function repairInlineBlockMarkers(rawLine: string) {
  return rawLine
    .replace(/^\s*-{3,}\s+(#{1,6}\s+)/, '$1')
    .replace(/^\s*[-*]\s+(#{1,6}\s+)/, '$1');
}

function repairCompactPipeTableLine(rawLine: string) {
  const line = rawLine.replace(/^:::\s*/, '').trim();
  if (/^\$\$\s+.+/.test(line) && !/\$\$\s*$/.test(line) && /\\[a-zA-Z]+|=/.test(line)) {
    return [`${line} $$`];
  }
  if (!line.includes('|')) return [line];

  const heading = line.match(/^(#{1,3}\s+[^|]+?)\s+(\|.+)$/);
  const tableText = heading ? heading[2] : line;
  const tableLines = tableText.replace(/\|\s*\|/g, '|\n|').split('\n').map((item) => item.trim()).filter(Boolean);
  const inferredTable = inferCompactPipeTable(tableText);
  if (inferredTable) return heading ? [heading[1], '', ...inferredTable] : inferredTable;
  if (tableLines.length < 3 || !tableLines.some(isMarkdownTableSeparator)) return [line];
  return heading ? [heading[1], '', ...tableLines] : tableLines;
}

function repairMixedLatexLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes('$$') || !trimmed.includes('$')) return line;
  const dollarCount = trimmed.match(/\$/g)?.length ?? 0;
  if (dollarCount < 2) return line;
  const hasLatexCommandOutsideDollar =
    /\$[^$]+\$\s*\\[a-zA-Z]+/.test(trimmed) || /\\[a-zA-Z]+[^$]*\$[^$]+\$/.test(trimmed);
  if (!hasLatexCommandOutsideDollar) return line;
  const latex = trimmed
    .replaceAll('$', '')
    .replace(/[。．.，,；;：:]$/u, '')
    .trim();
  if (!latex || !/[=\\]/.test(latex)) return line;
  const indent = line.match(/^\s*/)?.[0] ?? '';
  return `${indent}$$${latex}$$`;
}

function inferCompactPipeTable(tableText: string) {
  if (isMarkdownTableSeparator(tableText) || tableText.includes('| ---')) return null;
  const cells = tableText
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 6) return null;
  const columnCount = [5, 4, 3, 2].find((count) => cells.length % count === 0 && cells.length / count >= 2);
  if (!columnCount) return null;
  const rows = Array.from({ length: cells.length / columnCount }, (_, rowIndex) => cells.slice(rowIndex * columnCount, rowIndex * columnCount + columnCount));
  const header = rows[0];
  if (!header) return null;
  return [formatMarkdownTableRow(header), formatMarkdownTableRow(Array.from({ length: columnCount }, () => '---')), ...rows.slice(1).map(formatMarkdownTableRow)];
}

function formatMarkdownTableRow(cells: string[]) {
  return `| ${cells.join(' | ')} |`;
}

function repairLooseEquationLine(line: string) {
  if (!line || line.includes('$$') || line.includes('\\(') || line.includes('\\[')) return line;
  return line.replace(/(^|[^$A-Za-z0-9_\u0370-\u03ff])([A-Za-z0-9_\u0370-\u03ff{}^²³⁴⁵⁶⁷⁸⁹()+=\-*/.,\s≤≥∞→↑↓×°∠Σ]+=[A-Za-z0-9_\u0370-\u03ff{}^²³⁴⁵⁶⁷⁸⁹()+=\-*/.,\s≤≥∞→↑↓×°∠Σ]+)/g, (match, prefix: string, equation: string) => {
    const latex = normalizeEquationLatex(equation);
    if (!shouldWrapEquation(latex)) return match;
    return `${prefix}$${latex}$`;
  });
}

function normalizeEquationLatex(value: string) {
  return value
    .trim()
    .replace(/[ ,，]+$/g, '')
    .replace(/\bs2(?=\s*[+\-])/g, 's^2')
    .replaceAll('²', '^2')
    .replaceAll('³', '^3')
    .replaceAll('⁴', '^4')
    .replaceAll('⁵', '^5')
    .replaceAll('⁶', '^6')
    .replaceAll('⁷', '^7')
    .replaceAll('⁸', '^8')
    .replaceAll('⁹', '^9');
}

function shouldWrapEquation(value: string) {
  const latex = value.trim();
  if (latex.length < 5) return false;
  if (/^\(\d+\)\s*[^=]+=\s*[-+]?\d+(?:\.\d+)?$/.test(latex)) return false;
  if ((latex.match(/=/g) ?? []).length > 1 && !/[+*/^Σ∑]/.test(latex)) return false;
  return /[+*/^Σ∑]|[A-Za-z]\^\d/.test(latex);
}

function renderMarkdown(markdown: string): ReactNode[] {
  const blocks = splitMathBlocks(markdown);
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let tableRows: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    nodes.push(<p key={`p-${nodes.length}`}>{renderInline(paragraph.join(' '))}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {listItems.map((item, index) => (
          <li key={`${item}-${index}`}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    const table = parseMarkdownTable(tableRows);
    if (table) {
      nodes.push(<MarkdownTable key={`table-${nodes.length}`} header={table.header} rows={table.rows} />);
    } else {
      paragraph.push(...tableRows);
    }
    tableRows = [];
  };

  for (const block of blocks) {
    if (block.type === 'math') {
      flushTable();
      flushParagraph();
      flushList();
      nodes.push(<MathBlock key={`math-${nodes.length}`} latex={block.value} />);
      continue;
    }

    for (const rawLine of block.value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        flushTable();
        flushParagraph();
        flushList();
        continue;
      }
      if (isMarkdownTableRow(line)) {
        flushParagraph();
        flushList();
        tableRows.push(line);
        continue;
      }
      flushTable();
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        nodes.push(
          heading[1].length >= 4
            ? <h4 key={`h-${nodes.length}`}>{renderInline(heading[2])}</h4>
            : <h3 key={`h-${nodes.length}`}>{renderInline(heading[2])}</h3>,
        );
        continue;
      }
      const list = line.match(/^[-*]\s+(.+)$/);
      if (list) {
        flushParagraph();
        listItems.push(list[1]);
        continue;
      }
      flushList();
      paragraph.push(line);
    }
  }

  flushTable();
  flushParagraph();
  flushList();
  return nodes;
}

function splitMathBlocks(markdown: string) {
  const parts: Array<{ type: 'text' | 'math'; value: string }> = [];
  const pattern = /(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\])/g;
  let lastIndex = 0;
  for (const match of markdown.matchAll(pattern)) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: markdown.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'math', value: (match[1] ?? match[2] ?? '').trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < markdown.length) {
    parts.push({ type: 'text', value: markdown.slice(lastIndex) });
  }
  return parts;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|\$([^$\n]+)\$|\\\(([^\n]+?)\\\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) nodes.push(...renderLooseMath(text.slice(lastIndex, match.index), `text-${match.index}`));
    if (match[2]) {
      nodes.push(<strong key={`strong-${match.index}`}>{renderLooseMath(match[2], `strong-${match.index}`)}</strong>);
    } else {
      nodes.push(<MathInline key={`math-inline-${match.index}`} latex={(match[3] ?? match[4] ?? '').trim()} />);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(...renderLooseMath(text.slice(lastIndex), `text-tail-${lastIndex}`));
  return nodes;
}

function renderLooseMath(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /([A-Za-z0-9_{}^()+\-*/=.,\s]+\\[a-zA-Z]+[A-Za-z0-9_{}^()+\-*/=.,\s\\]*)/g;
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const latex = raw.trim();
    if (!latex) continue;
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const leading = raw.match(/^\s*/)?.[0] ?? '';
    const trailing = raw.match(/\s*$/)?.[0] ?? '';
    if (leading) nodes.push(leading);
    nodes.push(<MathInline key={`${keyPrefix}-loose-${index}`} latex={latex} />);
    if (trailing) nodes.push(trailing);
    lastIndex = match.index + raw.length;
    index += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length ? nodes : [text];
}

function isMarkdownTableRow(line: string) {
  return line.startsWith('|') && line.endsWith('|') && line.slice(1, -1).includes('|');
}

function parseMarkdownTable(lines: string[]) {
  if (lines.length < 3 || !isMarkdownTableSeparator(lines[1])) return null;
  const header = parseMarkdownTableRow(lines[0]);
  const rows = lines.slice(2).map(parseMarkdownTableRow).filter((row) => row.length);
  if (header.length < 2 || rows.length === 0) return null;
  const width = header.length;
  return {
    header,
    rows: rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')),
  };
}

function parseMarkdownTableRow(line: string) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string) {
  const cells = parseMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function MarkdownTable({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="my-3 overflow-x-auto">
      <table className="a3-three-line-table w-full min-w-[520px] border-y border-slate-300 text-left text-xs leading-6">
        <thead className="border-b border-slate-300">
          <tr>
            {header.map((cell, index) => (
              <th key={`${cell}-${index}`} className="whitespace-nowrap px-3 py-2 font-semibold text-[var(--a3-text)]">
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`} className="border-b border-slate-100 last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`} className="min-w-[120px] px-3 py-2 align-top text-[var(--a3-text-muted)]">
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MathBlock({ latex }: { latex: string }) {
  return (
    <div
      dangerouslySetInnerHTML={{ __html: renderKatex(latex, true) }}
      className="my-3"
    />
  );
}

function MathInline({ latex }: { latex: string }) {
  return (
    <span
      dangerouslySetInnerHTML={{ __html: renderKatex(latex, false) }}
      className="mx-0.5 inline-block align-middle"
    />
  );
}

function renderKatex(latex: string, displayMode: boolean) {
  try {
    return katex.renderToString(normalizeKatexSymbols(latex), {
      displayMode,
      throwOnError: true,
      strict: false,
      trust: false,
    });
  } catch {
    return escapeHtml(displayMode ? `$$${latex}$$` : `$${latex}$`);
  }
}

function normalizeKatexSymbols(latex: string) {
  return latex.replace(/[✅✓✔]/gu, '\\checkmark{}');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
