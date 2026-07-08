export type A3OpenMAICPageOwnership = {
  a3Page: string;
  pageName: string;
  owner: string;
  primaryOpenMAICCapability: string;
  responsibility: string;
  a3Apis: string[];
  evidence: string[];
  verification: string[];
  handoffRule: string;
};

export type A3OpenMAICPageOwnershipMetrics = {
  schemaVersion: string;
  totalPages: number;
  pagesWithBridgeApis: number;
  pagesWithVerification: number;
  ready: boolean;
};

export const A3_OPENMAIC_PAGE_OWNERSHIP: A3OpenMAICPageOwnership[] = [
  {
    a3Page: '/a3/recommendations',
    pageName: '推荐资源页',
    owner: 'ResourceSynthesisAgent',
    primaryOpenMAICCapability: '从 A3 七类资源包触发 OpenMAIC 课堂和视频 artifact',
    responsibility:
      '生成 A3 resourcePack.multimodalArtifacts，并把课堂、PPTX 提示、视频任务状态写回同一个资源包。',
    a3Apis: [
      'POST /api/resources/generate/',
      'POST /api/a3/resources/openmaic-classroom',
      'POST /api/a3/resources/openmaic-pptx-export',
      'POST /api/a3/resources/openmaic-video',
    ],
    evidence: ['resourcePack.multimodalArtifacts', 'a3-openmaic-classroom-card', 'a3-openmaic-video-card'],
    verification: [
      'pnpm vitest run tests/a3-openmaic-classroom-bridge.test.ts',
      'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
    ],
    handoffRule: 'A3 负责资源包和学习闭环，OpenMAIC 只作为课堂、PPTX 和视频生成能力底座。',
  },
  {
    a3Page: '/a3/resources/[packId]',
    pageName: '资源包详情页',
    owner: 'ResourcePackCommitAgent',
    primaryOpenMAICCapability: '展示同一资源包下全部 OpenMAIC artifact 历史',
    responsibility:
      '读取资源包详情和 OpenMAICArtifact 审计表，按历史顺序展示课堂、视频、降级记录和资源包回写证据。',
    a3Apis: ['GET /api/resources/packs/<id>/'],
    evidence: ['a3-resource-pack-artifact-history', 'a3-resource-pack-artifact-summary'],
    verification: [
      'pnpm vitest run tests/a3-openmaic-artifact-history.test.ts',
      'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
    ],
    handoffRule: 'A3 详情页保留审计历史，OpenMAIC 产物只能通过 A3 资源包入口回看。',
  },
  {
    a3Page: '/a3/classroom',
    pageName: 'AI 课堂页',
    owner: 'OpenMAICClassroomBridge',
    primaryOpenMAICCapability: '打开来自 A3 资源包的 OpenMAIC 课堂',
    responsibility:
      '根据资源包 artifact 打开 OpenMAIC classroomUrl，并提示 PPTX 导出发生在 OpenMAIC 课堂前端。',
    a3Apis: ['GET /api/resources/packs/', 'GET /api/learning/classroom/'],
    evidence: ['a3-classroom-openmaic-entry', 'a3-classroom-openmaic-pptx-hint'],
    verification: ['npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium'],
    handoffRule: 'A3 提供课堂入口和学习上下文，PPTX 导出由 OpenMAIC 课堂内现有 hook 完成。',
  },
  {
    a3Page: '/a3/teacher',
    pageName: '教师工作台',
    owner: 'TeacherWorkbenchAgent',
    primaryOpenMAICCapability: '聚合课堂、PPTX 和视频 artifact 的资源效果',
    responsibility:
      '展示班级层面的课堂成功数、视频成功数、降级记录、jobId 和资源包链接，支撑教师干预。',
    a3Apis: ['GET /api/learning/teacher/workbench/', 'POST /api/learning/teacher/tasks/execute/'],
    evidence: ['a3-teacher-openmaic-artifacts', 'a3-teacher-resource-pack-filter'],
    verification: [
      'backend/.venv/Scripts/python.exe backend/manage.py test apps.learning.tests.test_path_planner',
      'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
    ],
    handoffRule: '教师仍在 A3 工作台决策和下发任务，OpenMAIC 只贡献可追踪资源效果。',
  },
  {
    a3Page: '/a3/capabilities',
    pageName: '能力总览页',
    owner: 'CapabilityEvidenceAgent',
    primaryOpenMAICCapability: '展示 RAG、trace、artifact 审计和视频 smoke 证据',
    responsibility:
      '汇总 demo/status、OpenMAIC artifact 审计表、真实视频 smoke 报告和验收清单。',
    a3Apis: ['GET /api/demo/status/', 'GET /api/a3/system/runtime', 'POST /api/a3/resources/openmaic-pptx-export', 'POST /api/a3/resources/openmaic-video-smoke-writeback'],
    evidence: ['a3-openmaic-readable-ownership', 'a3-openmaic-artifact-audit', 'a3-openmaic-smoke-report'],
    verification: [
      'pnpm vitest run tests/a3-openmaic-page-ownership.test.ts tests/a3-openmaic-acceptance.test.ts',
      'A3_RUN_REAL_VIDEO_SMOKE=1 pnpm smoke:a3-video',
    ],
    handoffRule: 'A3 能力页只展示可验证证据，不把 OpenMAIC 原始页面当作产品完成度。',
  },
  {
    a3Page: '/a3/knowledge-base',
    pageName: '知识库页',
    owner: 'KnowledgeBaseAgent',
    primaryOpenMAICCapability: '为课堂、资源生成和视频脚本提供 RAG 来源',
    responsibility:
      '维护本地知识库上传、索引、检索和引用来源，作为 OpenMAIC 课堂与 A3 资源包生成的证据基础。',
    a3Apis: ['GET /api/kb/resources/', 'POST /api/kb/resources/upload/', 'GET /api/kb/search/'],
    evidence: ['a3-knowledge-base-resources', 'a3-kb-search-results'],
    verification: [
      'backend/.venv/Scripts/python.exe backend/manage.py evaluate_demo_retrieval --top-k 3',
      'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
    ],
    handoffRule: 'A3 知识库是 RAG 权威来源，OpenMAIC 不直接编造教材、页码或本地文件路径。',
  },
];

export function buildOpenMAICPageOwnershipMetrics(
  items: A3OpenMAICPageOwnership[],
): A3OpenMAICPageOwnershipMetrics {
  const pagesWithBridgeApis = items.filter((item) => item.a3Apis.length > 0).length;
  const pagesWithVerification = items.filter((item) => item.verification.length > 0 && item.evidence.length > 0).length;
  return {
    schemaVersion: 'a3.openmaic-page-ownership.v1',
    totalPages: items.length,
    pagesWithBridgeApis,
    pagesWithVerification,
    ready: items.length > 0 && pagesWithBridgeApis === items.length && pagesWithVerification === items.length,
  };
}
