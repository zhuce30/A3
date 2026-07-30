import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const featureDir = path.join(root, 'components/a3/features/knowledge-graph');
const viewPath = path.join(root, 'components/a3/features/knowledge-graph-view.tsx');

describe('A3 knowledge graph evidence workbench', () => {
  it('preserves the real APIs and incremental material neighborhood loading', () => {
    const view = fs.readFileSync(viewPath, 'utf8');

    expect(fs.existsSync(path.join(featureDir, 'material-focused-flow.tsx'))).toBe(true);
    expect(view).toContain('/api/kb/graph/?');
    expect(view).toContain("'/api/learning/graph/'");
    expect(view).toContain("'/api/learning/paths/generate/'");
    expect(view).toContain("params.set('centerId', centerId)");
    expect(view).toContain('mergeMaterialGraphs');
    expect(view).not.toContain('mockMaterialGraph');
  });
});
