import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'app/a3/resources/[packId]/video/compose/page.tsx');
const viewPath = path.resolve(process.cwd(), 'components/a3/features/video-composition-view.tsx');
const videoPagePath = path.resolve(process.cwd(), 'components/a3/features/resource-video-view.tsx');

describe('A3 final video composition workbench', () => {
  it('has an independent route and four-stage progress', () => {
    expect(fs.readFileSync(pagePath, 'utf8')).toContain('VideoCompositionView');
    const source = fs.readFileSync(viewPath, 'utf8');
    for (const label of ['分镜', '视频片段', '旁白与字幕', '最终合并']) {
      expect(source).toContain(label);
    }
  });

  it('supports narration editing, preview, isolated retry and downloads', () => {
    const source = fs.readFileSync(viewPath, 'utf8');
    expect(source).toContain('textarea');
    expect(source).toContain('试听旁白');
    expect(source).toContain('只重试本段');
    expect(source).toContain('生成旁白');
    expect(source).toContain('合并最终视频');
    expect(source).toContain('下载 MP4');
    expect(source).toContain('下载旁白稿');
    expect(source).toContain('下载字幕');
  });

  it('adds a clear entry from the existing segment page', () => {
    const source = fs.readFileSync(videoPagePath, 'utf8');
    expect(source).toContain(`/a3/resources/\${pack.resourcePackId}/video/compose`);
    expect(source).toContain('制作最终成片');
  });
});
