import type { A3OpenMAICPageOwnership } from './openmaic-page-ownership';
import type { A3OpenMAICVerificationSummary } from './openmaic-verification-status';

export type A3OpenMAICAcceptanceItem = {
  key: string;
  title: string;
  ownerPage: string;
  standard: string;
  evidence: string[];
  command: string;
  status: 'ready' | 'warning';
};

export type A3OpenMAICAcceptanceSummary = {
  total: number;
  ready: number;
  warnings: number;
  items: A3OpenMAICAcceptanceItem[];
};

export function buildOpenMAICAcceptanceSummary(
  pageOwnership: A3OpenMAICPageOwnership[],
  verification: A3OpenMAICVerificationSummary,
): A3OpenMAICAcceptanceSummary {
  const byPage = new Map(pageOwnership.map((item) => [item.a3Page, item]));
  const videoSmoke = verification.items.find((item) => item.key === 'video-smoke');
  const e2e = verification.items.find((item) => item.key === 'e2e-bridge');
  const pageOwnershipTest = verification.items.find((item) => item.key === 'page-ownership');
  const unitBridge = verification.items.find((item) => item.key === 'unit-bridge');
  const smokeWritebackReady = videoSmoke?.status === 'ready' && e2e?.status === 'ready';

  const items: A3OpenMAICAcceptanceItem[] = [
    {
      key: 'page-boundary',
      title: 'A3 页面分工清晰',
      ownerPage: '/a3/capabilities',
      standard:
        '每个 OpenMAIC 能力必须落到一个 A3 页面，并说明 owner、API、证据、验证命令和 handoff rule。',
      evidence: byPage.get('/a3/capabilities')?.evidence ?? ['a3-openmaic-readable-ownership'],
      command: pageOwnershipTest?.command ?? 'pnpm vitest run tests/a3-openmaic-page-ownership.test.ts',
      status: pageOwnershipTest?.status ?? 'warning',
    },
    {
      key: 'resource-artifact-writeback',
      title: '资源包 artifact 写回',
      ownerPage: '/a3/recommendations',
      standard:
        '课堂、PPTX、视频任务不能只停留在 OpenMAIC；必须写回 A3 resourcePack.multimodalArtifacts。',
      evidence: byPage.get('/a3/recommendations')?.evidence ?? ['resourcePack.multimodalArtifacts'],
      command: unitBridge?.command ?? 'pnpm vitest run tests/a3-openmaic-classroom-bridge.test.ts',
      status: unitBridge?.status ?? 'warning',
    },
    {
      key: 'artifact-history',
      title: '资源包详情可审计历史',
      ownerPage: '/a3/resources/[packId]',
      standard:
        '详情页展示同一资源包下全部 OpenMAIC artifact 历史，避免只看最新一次。',
      evidence: byPage.get('/a3/resources/[packId]')?.evidence ?? ['a3-resource-pack-artifact-history'],
      command: e2e?.command ?? 'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
      status: e2e?.status ?? 'warning',
    },
    {
      key: 'classroom-pptx-boundary',
      title: '课堂和 PPTX 边界正确',
      ownerPage: '/a3/classroom',
      standard:
        'A3 打开来自资源包的 OpenMAIC 课堂；Django 不直接生成 PPTX，导出由 OpenMAIC 课堂前端完成。',
      evidence: byPage.get('/a3/classroom')?.evidence ?? ['a3-classroom-openmaic-pptx-hint'],
      command: e2e?.command ?? 'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
      status: e2e?.status ?? 'warning',
    },
    {
      key: 'teacher-effect',
      title: '教师端能看资源效果',
      ownerPage: '/a3/teacher',
      standard:
        '教师端展示课堂成功数、视频成功/降级数、jobId 和资源包链接，用于后续干预。',
      evidence: byPage.get('/a3/teacher')?.evidence ?? ['a3-teacher-openmaic-artifacts'],
      command: e2e?.command ?? 'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
      status: e2e?.status ?? 'warning',
    },
    {
      key: 'video-smoke',
      title: '真实视频 provider 可验收',
      ownerPage: '/a3/capabilities',
      standard:
        '有 key 时跑真实 /api/generate/video；无 key 或 key 不可用时，必须明确展示 provider 状态并写入 smoke 报告。',
      evidence: ['a3-openmaic-video-capability', 'a3-openmaic-verification-status', 'a3-openmaic-smoke-report'],
      command: videoSmoke?.command ?? 'A3_RUN_REAL_VIDEO_SMOKE=1 pnpm smoke:a3-video',
      status: videoSmoke?.status ?? 'warning',
    },
    {
      key: 'video-smoke-writeback',
      title: '真实 smoke 视频安全写回',
      ownerPage: '/a3/capabilities',
      standard:
        '只有 smoke 报告成功且包含 videoUrl 时，才允许通过 /api/a3/resources/openmaic-video-smoke-writeback 写回资源包；未传资源包时可自动选择最近 A3 资源包。',
      evidence: ['a3-openmaic-smoke-writeback', 'tmp/a3-openmaic-smoke-report.json', 'resourcePack.multimodalArtifacts'],
      command:
        'pnpm vitest run tests/a3-openmaic-video-smoke-report.test.ts && npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
      status: smokeWritebackReady ? 'ready' : 'warning',
    },
  ];

  const ready = items.filter((item) => item.status === 'ready').length;
  return {
    total: items.length,
    ready,
    warnings: items.length - ready,
    items,
  };
}
