import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-base-view.tsx');

describe('A3 knowledge base deep retrieval evidence', () => {
  it('surfaces route reason, wiki evidence, and graph evidence from the search API', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('type RetrievalPlan');
    expect(source).toContain('type WikiEvidence');
    expect(source).toContain('type GraphEvidence');
    expect(source).toContain('setRetrieval(result.retrieval');
    expect(source).toContain('setWikiEvidence(result.wikiEvidence');
    expect(source).toContain('setGraphEvidence(result.graphEvidence');
    expect(source).toContain('data-testid="a3-kb-retrieval-route"');
    expect(source).toContain('data-testid="a3-kb-wiki-evidence"');
    expect(source).toContain('data-testid="a3-kb-graph-evidence"');
    expect(source).toContain('pathLabels');
    expect(source).toContain('relations');
    expect(source).toContain('data-testid="a3-kb-graph-path-evidence"');
  });

  it('shows Wiki build status and exposes a real rebuild action on the knowledge-base page', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('wiki?: KnowledgeWikiSummary');
    expect(source).toContain('data-testid="a3-kb-wiki-status"');
    expect(source).toContain('data-testid="a3-kb-rebuild-wiki"');
    expect(source).toContain('/api/kb/resources/${resource.id}/wiki/rebuild/');
    expect(source).toContain('rebuildResourceWiki');
  });

  it('queues batch Wiki rebuild jobs from the knowledge-base page', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("type: 'upload' | 'rebuild' | 'parse' | 'wiki'");
    expect(source).toContain('data-testid="a3-kb-batch-rebuild-wiki"');
    expect(source).toContain('/api/kb/wiki/rebuild/');
    expect(source).toContain('batchRebuildWiki');
    expect(source).toContain("job.type === 'wiki'");
  });

  it('renders retrieved source context before short hit text', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('contextSnippet?: string');
    expect(source).toContain('contextBlocks?: Array');
    expect(source).toContain('命中上下文');
    expect(source).toContain('searchResultSnippet(result)');
    expect(source).toContain('result.contextSnippet ||');
  });

  it('wires the search console controls to real search API parameters', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('type SearchConfig');
    expect(source).toContain('searchConfig.topK');
    expect(source).toContain('searchConfig.includeAssets');
    expect(source).toContain('searchConfig.mode');
    expect(source).toContain('searchConfig.fast');
    expect(source).toContain('searchConfig.similarityThreshold');
    expect(source).toContain('searchConfig.bm25Candidates');
    expect(source).toContain('searchConfig.vectorWeight');
    expect(source).toContain('searchConfig.bm25Weight');
    expect(source).toContain('data-testid="a3-kb-search-top-k"');
    expect(source).toContain('data-testid="a3-kb-search-include-assets"');
    expect(source).toContain('data-testid="a3-kb-search-mode"');
    expect(source).toContain('data-testid="a3-kb-search-fast"');
    expect(source).toContain('testId="a3-kb-search-similarity-threshold"');
    expect(source).toContain('testId="a3-kb-search-bm25-candidates"');
    expect(source).toContain('testId="a3-kb-search-vector-weight"');
    expect(source).toContain('testId="a3-kb-search-bm25-weight"');
    expect(source).toContain('top_k=${searchConfig.topK}');
    expect(source).toContain("include_assets=${searchConfig.includeAssets ? '1' : '0'}");
    expect(source).toContain('mode=${searchConfig.mode}');
    expect(source).toContain("fast=${searchConfig.fast ? '1' : '0'}");
    expect(source).toContain('similarity_threshold=${searchConfig.similarityThreshold}');
    expect(source).toContain('bm25_candidates=${searchConfig.bm25Candidates}');
    expect(source).toContain('vector_weight=${searchConfig.vectorWeight}');
    expect(source).toContain('bm25_weight=${searchConfig.bm25Weight}');
    expect(source).not.toContain('top_k=5&include_assets=1`');
    expect(source).not.toContain('后端参数待接入');
  });
});
