import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildA3VisionEvidenceCitations, buildA3VisionUserContent, mergeA3VisionClaimCitations } from '@/lib/server/a3-vision-answer';

const helperPath = path.resolve(process.cwd(), 'lib/server/a3-vision-answer.ts');

describe('A3 vision answer quality', () => {
  it('uses a dedicated image-solving prompt instead of the short text-coaching prompt', () => {
    const source = fs.readFileSync(helperPath, 'utf8');

    expect(source).toContain('A3_VISION_SOLVER_SYSTEM_PROMPT');
    expect(source).toContain('先完整转写图片中的题干');
    expect(source).toContain('完整解题步骤');
    expect(source).not.toContain('A3_COACHING_SYSTEM_PROMPT');
  });

  it('packs local knowledge-base visual evidence as additional vision input', () => {
    const content = buildA3VisionUserContent(
      '解释这页根轨迹课件',
      'data:image/png;base64,student',
      [
        {
          title: 'root-locus.pptx',
          location: '第 3 张幻灯片',
          snippet: 'Root locus slide OCR',
          modality: 'slide_image',
          previewUrl: '/api/kb/assets/asset-1/preview/',
          dataUrl: 'data:image/png;base64,kbslide',
        },
      ],
    );

    expect(content.filter((part) => part.type === 'image_url')).toHaveLength(2);
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,kbslide' } });
    expect(JSON.stringify(content[0])).toContain('知识库视觉证据');
    expect(JSON.stringify(content[0])).toContain('root-locus.pptx');
  });

  it('keeps multimodal evidence metadata in citations', () => {
    const citations = buildA3VisionEvidenceCitations([
      {
        title: 'root-locus.pptx',
        location: '第 3 张幻灯片',
        snippet: 'Root locus slide OCR',
        modality: 'slide_image',
        previewUrl: '/api/kb/assets/asset-1/preview/',
        dataUrl: 'data:image/png;base64,kbslide',
      },
    ]);

    expect(citations[0]).toMatchObject({
      title: 'root-locus.pptx',
      location: '第 3 张幻灯片',
      type: 'slide_image',
      previewUrl: '/api/kb/assets/asset-1/preview/',
    });
  });

  it('hydrates claim citations with visual preview metadata for the evidence gallery', () => {
    const claims = mergeA3VisionClaimCitations(
      [
        {
          id: 'claim-1',
          text: '频域响应法可用于稳定性分析。',
          verified: true,
          overlap: 8,
          citation: {
            title: '第五章 频域响应法.pptx',
            location: '第 3 张幻灯片',
            snippet: '控制系统的频率特性分析法。',
          },
        },
      ],
      [
        {
          title: '第五章 频域响应法.pptx',
          location: '第 3 张幻灯片',
          type: 'rendered_slide',
          previewUrl: '/api/kb/assets/asset-1/preview/',
          sourceOrigin: '本地知识库视觉证据',
        },
      ],
    );

    expect(claims[0].citation).toMatchObject({
      title: '第五章 频域响应法.pptx',
      location: '第 3 张幻灯片',
      previewUrl: '/api/kb/assets/asset-1/preview/',
      sourceOrigin: '本地知识库视觉证据',
    });
  });
});
