import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const recommendationsPath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');
const realtimeCallPath = path.resolve(process.cwd(), 'components/a3/features/coaching/realtime-coaching-call.tsx');
const realtimeHookPath = path.resolve(process.cwd(), 'components/a3/features/coaching/use-realtime-coaching.ts');

describe('A3 long-running progress UX', () => {
  it('shows staged progress for PPT classroom and segmented video generation', () => {
    const source = fs.readFileSync(recommendationsPath, 'utf8');

    expect(source).toContain('data-testid="a3-long-running-progress"');
    expect(source).toContain('data-testid="a3-video-generation-progress"');
    expect(source).toContain('data-testid="a3-classroom-generation-progress"');
    expect(source).toContain('准备视频脚本');
    expect(source).toContain('第 1/6 段');
    expect(source).toContain('写回 A3 资源包');
    expect(source).toContain('创建 OpenMAIC 课堂');
    expect(source).toContain('同步课堂状态');
    expect(source).toContain('进入课堂导出 PPTX');
  });

  it('exposes retrieval progress while realtime coaching searches the knowledge base', () => {
    const viewSource = fs.readFileSync(realtimeCallPath, 'utf8');
    const hookSource = fs.readFileSync(realtimeHookPath, 'utf8');

    expect(hookSource).toContain('retrievalProgress');
    expect(hookSource).toContain('正在检索本地资料');
    expect(hookSource).toContain('已找到');
    expect(hookSource).toContain('检索失败');
    expect(viewSource).toContain('data-testid="a3-qa-retrieval-progress"');
    expect(viewSource).toContain('retrievalProgress.status === \'running\'');
    expect(viewSource).toContain('正在检索本地资料');
  });
});
