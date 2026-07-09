import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/resource-video-view.tsx');

describe('A3 resource video segmented playback', () => {
  it('renders one minute videos as playable ten second segments instead of a download-only artifact', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('playableSegments');
    expect(source).toContain('data-testid="a3-resource-video-segment-playlist"');
    expect(source).toContain('data-testid="a3-resource-video-segment"');
    expect(source).toContain('从头播放');
    expect(source).toContain('新窗口打开当前片段');
  });
});
