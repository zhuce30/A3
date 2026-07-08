import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/capabilities-view.tsx');

describe('A3 capabilities material knowledge graph evidence', () => {
  it('shows material graph schema, workflow, degradation and counts from demo status', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('materialKnowledgeGraph?:');
    expect(source).toContain('data-testid="a3-material-knowledge-graph-status"');
    expect(source).toContain('a3.material-knowledge-graph.v1');
    expect(source).toContain('material_knowledge_graph');
    expect(source).toContain('workflowSchemaVersion');
    expect(source).toContain('degradedCount');
    expect(source).toContain('markdownEvidence?:');
    expect(source).toContain('markdown evidence');
    expect(source).toContain('raw preserved');
    expect(source).toContain('GET /api/kb/graph/');
  });
});
