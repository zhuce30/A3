import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const view = readFileSync(join(root, 'components/a3/features/knowledge-graph-view.tsx'), 'utf8');
const types = readFileSync(join(root, 'lib/a3/learning-types.ts'), 'utf8');

describe('A3 real knowledge graph page', () => {
  it('uses React Flow instead of a fixed SVG pseudo graph', () => {
    expect(view).toContain("from '@xyflow/react'");
    expect(view).toContain('<ReactFlow');
    expect(view).toContain('data-testid="a3-real-knowledge-graph"');
    expect(view).not.toContain('<svg className="absolute inset-0 size-full"');
    expect(view).not.toContain('function positionNodes');
  });

  it('surfaces real graph evidence and learning-loop actions', () => {
    expect(view).toContain('来源证据');
    expect(view).toContain('路径绑定');
    expect(view).toContain('/a3/today');
    expect(view).toContain('/a3/coaching?knowledgePointId=');
    expect(view).toContain('/a3/assessment?knowledgePointId=');
  });

  it('types graph schema, prerequisite edges, and node evidence', () => {
    expect(types).toContain('schemaVersion?:');
    expect(types).toContain('a3.knowledge-graph.v1');
    expect(types).toContain("type?: 'prerequisite'");
    expect(types).toContain('pathBinding?:');
    expect(types).toContain('evidence?:');
  });
});
