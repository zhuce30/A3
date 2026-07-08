import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/coaching-view.tsx');

describe('A3 coaching markdown rendering', () => {
  it('renders assistant coaching replies through A3Markdown instead of plain text', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("import { A3Markdown } from '../ui/a3-markdown';");
    expect(source).toContain("message.role === 'assistant' ? <A3Markdown>{message.content}</A3Markdown>");
    expect(source).not.toContain('<p className="break-words text-[var(--a3-text)]">{message.content}</p>');
  });

  it('renders coaching claim citation snippets through A3Markdown', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('<A3Markdown className="text-xs leading-6">{claim.text}</A3Markdown>');
    expect(source).not.toContain('<div className="line-clamp-2 text-emerald-900">{claim.text}</div>');
  });

  it('labels claim_not_supported with citations as partial verification', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("'部分待核验'");
    expect(source).toContain("refusalReason === 'claim_not_supported'");
  });
});
