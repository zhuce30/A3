import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = readFileSync(join(root, 'components/a3/features/assessment-view.tsx'), 'utf8');
const types = readFileSync(join(root, 'lib/a3/assessment-types.ts'), 'utf8');

describe('A3 assessment personalized variant version', () => {
  it('shows the persistent variant version and dynamic context', () => {
    expect(types).toContain('variantIndex: number');
    expect(types).toContain('variantContext:');
    expect(source).toContain('变式版本：#');
    expect(source).toContain('场景：');
    expect(source).toContain('参数：');
    expect(types).toContain('generationMode: string');
    expect(types).toContain('reasoningForm: string');
    expect(source).toContain('证据约束模型生成');
    expect(source).toContain('推理：');
  });
});
