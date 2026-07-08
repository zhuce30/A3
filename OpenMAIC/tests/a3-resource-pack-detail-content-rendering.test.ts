import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/resource-pack-detail-view.tsx');

describe('A3 resource pack detail content rendering', () => {
  it('renders generated mind map content as a visible product, not only a summary card', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('ResourceContentPreview');
    expect(source).toContain('MindMapPreview');
    expect(source).toContain('data-testid="a3-resource-content-preview"');
    expect(source).toContain('data-testid="a3-mind-map-preview"');
    expect(source).toContain('查看成品');
    expect(source).toContain("resource.type === 'mind_map'");
  });

  it('has a dedicated preview renderer for every generated resource type', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('LectureDocPreview');
    expect(source).toContain('MindMapPreview');
    expect(source).toContain('PracticeSetPreview');
    expect(source).toContain('CaseStudyPreview');
    expect(source).toContain('CodeLabPreview');
    expect(source).toContain('VideoScriptPreview');
    expect(source).toContain('KnowledgeCardPreview');
    expect(source).toContain("resource.type === 'case_study'");
  });

  it('keeps PPT and real video outputs represented as OpenMAIC artifact products', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('OpenMAIC artifact 历史');
    expect(source).toContain('PPTX 导出');
    expect(source).toContain('OpenMAIC 视频');
    expect(source).toContain('打开产物');
    expect(source).toContain("artifact.type === 'openmaic_video'");
    expect(source).toContain("artifact.type === 'openmaic_pptx_export'");
  });
});
