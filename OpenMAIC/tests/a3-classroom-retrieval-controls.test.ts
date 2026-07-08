import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const classroomPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx');

describe('A3 classroom retrieval controls', () => {
  it('exposes fast/deep retrieval controls, material scope, and trace status', () => {
    const source = fs.readFileSync(classroomPath, 'utf8');

    expect(source).toContain('data-testid="a3-classroom-retrieval-controls"');
    expect(source).toContain('快速回答');
    expect(source).toContain('深度检索');
    expect(source).toContain("'personal'");
    expect(source).toContain("'teacher'");
    expect(source).toContain("'class'");
    expect(source).toContain("'global'");
    expect(source).toContain('data-testid="a3-classroom-retrieval-status"');
    expect(source).toContain('traceId');
    expect(source).toContain('retrievalMode');
  });
});
