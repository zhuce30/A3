import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/coaching/respond/route.ts');

describe('A3 coaching respond image attachments', () => {
  it('accepts optional image attachments and delegates them to the vision helper', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain("import { answerA3TextQuestionWithVisualEvidence, answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';");
    expect(source).toContain('attachments?: CoachingAttachment[]');
    expect(source).toContain("item.type === 'image'");
    expect(source).toContain('return answerA3VisionQuestion({');
    expect(source).toContain('image: imageAttachment.dataUrl');
  });

  it('tries hybrid visual evidence for ordinary text questions before falling back to backend QA', () => {
    const source = fs.readFileSync(routePath, 'utf8');
    const visualCallIndex = source.indexOf('const visualEvidenceResponse = await tryAnswerWithVisualEvidence(cookieHeader, message);');
    const backendQaIndex = source.indexOf('const result = await fetchA3DjangoJson<BackendQaResponse>');

    expect(visualCallIndex).toBeGreaterThan(0);
    expect(backendQaIndex).toBeGreaterThan(visualCallIndex);
    expect(source).toContain('if (visualEvidenceResponse) return visualEvidenceResponse;');
  });
});
