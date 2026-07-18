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

  it('retries only failed segments while keeping successful segments playable', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('failedSegmentCount');
    expect(source).toContain('retryFailedSegments');
    expect(source).toContain("action: 'retry-failed'");
    expect(source).toContain('只重试失败片段');
    expect(source).toContain('已成功片段会保留');
    expect(source).toContain('playableSegments');
  });

  it('confirms legacy failed segment migration without sending existing media URLs', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('legacyFailedSegments');
    expect(source).toContain('legacySucceededSegments');
    expect(source).toContain('canImportLegacyFailures');
    expect(source).toContain('AlertDialogAction');
    expect(source).toContain("action: 'import-legacy-failures'");
    expect(source).toContain('buildA3VideoPrompt(pack.goal, script)');
    expect(source).toContain('补生成 {legacyFailedSegments.length} 段');
    expect(source).toContain('保留 {legacySucceededSegments.length} 段');
    expect(source).toContain('付费 Seedance');
    expect(source).not.toContain('videoUrl: segment.videoUrl');
    expect(source).not.toContain('segments: videoArtifact.segments');
  });

  it('uses one polling helper for retry, legacy import, and refresh recovery', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('pollVideoJob');
    expect(source).toContain('job.resourcePackId === packId');
    expect(source).toContain("['queued', 'running'].includes(String(job.status))");
    expect(source).toContain("a3GetJson<VideoJobResponse>('/api/a3/resources/openmaic-video')");
    expect(source).toContain('cancelled');
  });
});
