import type { A3OpenMAICPageOwnership } from './openmaic-page-ownership';

export type A3OpenMAICVerificationItem = {
  key: string;
  title: string;
  status: 'ready' | 'warning';
  evidence: string;
  command: string;
  covers: string[];
};

export type A3OpenMAICVerificationSummary = {
  total: number;
  ready: number;
  warnings: number;
  coverage: number;
  items: A3OpenMAICVerificationItem[];
};

export function buildOpenMAICVerificationSummary(
  pageOwnership: A3OpenMAICPageOwnership[],
  videoProviderConfigured: boolean,
): A3OpenMAICVerificationSummary {
  const pages = pageOwnership.map((item) => item.a3Page);
  const items: A3OpenMAICVerificationItem[] = [
    {
      key: 'unit-bridge',
      title: 'Bridge 单元测试',
      status: 'ready',
      evidence: '验证 A3 resource-pack 上下文可以转换为 OpenMAIC 课堂和视频 artifact payload。',
      command: 'pnpm vitest run tests/a3-openmaic-classroom-bridge.test.ts',
      covers: ['/a3/recommendations', '/a3/resources/[packId]'],
    },
    {
      key: 'page-ownership',
      title: '页面分工测试',
      status: 'ready',
      evidence: '验证每个 OpenMAIC 能力都有 A3 页面、API、证据和测试归属。',
      command: 'pnpm vitest run tests/a3-openmaic-page-ownership.test.ts',
      covers: pages,
    },
    {
      key: 'e2e-bridge',
      title: '端到端桥接测试',
      status: 'ready',
      evidence: '覆盖资源包生成、课堂成功/失败写回、视频降级写回、资源详情、课堂页、教师端和能力页。',
      command: 'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
      covers: ['/a3/recommendations', '/a3/resources/[packId]', '/a3/classroom', '/a3/teacher', '/a3/capabilities'],
    },
    {
      key: 'video-smoke',
      title: '真实视频 provider 冒烟',
      status: videoProviderConfigured ? 'ready' : 'warning',
      evidence: videoProviderConfigured
        ? 'Next runtime 检测到视频 provider key，可执行真实 /api/generate/video 冒烟。'
        : '未检测到视频 provider key；系统会把视频任务写回 failed/degraded artifact，而不是伪造成成功。',
      command: 'A3_RUN_REAL_VIDEO_SMOKE=1 pnpm smoke:a3-video',
      covers: ['/a3/recommendations', '/a3/resources/[packId]', '/a3/capabilities'],
    },
  ];
  const ready = items.filter((item) => item.status === 'ready').length;
  return {
    total: items.length,
    ready,
    warnings: items.length - ready,
    coverage: Math.round((ready / items.length) * 100),
    items,
  };
}
