import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx');

describe('A3 classroom image attachment UI', () => {
  it('supports local image upload as a chat attachment', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('ImageIcon');
    expect(source).toContain('const [imageAttachment, setImageAttachment]');
    expect(source).toContain('data-testid="a3-classroom-image-upload"');
    expect(source).toContain('accept="image/*"');
    expect(source).toContain('readImageAttachment');
    expect(source).toContain('attachments: imageAttachment');
    expect(source).toContain('data-testid="a3-classroom-image-preview"');
    expect(source).toContain('data-testid="a3-classroom-image-remove"');
    expect(source).toContain('degraded?: boolean');
    expect(source).toContain('degraded: Boolean(result.degraded)');
    expect(source).toContain('data-testid="a3-classroom-vision-degraded"');
  });
});
