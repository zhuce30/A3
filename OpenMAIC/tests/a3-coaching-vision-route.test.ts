import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/coaching/vision/route.ts');

describe('A3 coaching vision route', () => {
  it('delegates multimodal answering to the shared vision helper', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain("import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';");
    expect(source).toContain('return answerA3VisionQuestion({');
    expect(source).not.toContain('const MAX_IMAGE_DATA_URL_LENGTH');
    expect(source).not.toContain('fetch(`${baseUrl}/chat/completions`');
  });
});
