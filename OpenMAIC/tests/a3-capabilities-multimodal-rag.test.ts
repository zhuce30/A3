import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/capabilities-view.tsx');

describe('A3 capabilities multimodal RAG evidence', () => {
  it('shows multimodal RAG metrics and latest visual index status from demo status', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('multimodalRag?:');
    expect(source).toContain('data-testid="a3-multimodal-rag-metrics"');
    expect(source).toContain('multimodal_rag_metrics.json');
    expect(source).toContain('visualIndex');
    expect(source).toContain('visualIndexedEntries');
  });
});
