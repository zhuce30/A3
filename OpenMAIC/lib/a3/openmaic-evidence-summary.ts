import type { A3OpenMAICPageOwnershipMetrics } from './openmaic-page-ownership';
import type { A3OpenMAICVerificationSummary } from './openmaic-verification-status';

type ArtifactAuditInput = {
  schemaVersion?: string;
  total?: number;
  classroom?: number;
  classroomSucceeded?: number;
  video?: number;
  videoSucceeded?: number;
  videoDegraded?: number;
  pptxExport?: number;
  pptxExportSucceeded?: number;
  latestArtifacts?: Array<{ type?: string; status?: string; provider?: string; resourcePackId?: string; packId?: string }>;
};

type SmokeReportInput = {
  status?: string;
  success?: boolean;
  provider?: string;
  hasVideoUrl?: boolean;
  reason?: string;
  path?: string;
};

export type OpenMAICEvidenceSummaryInput = {
  pageMetrics: A3OpenMAICPageOwnershipMetrics;
  verification: A3OpenMAICVerificationSummary;
  artifactAudit?: ArtifactAuditInput;
  smokeReport?: SmokeReportInput;
  latestTraceId?: string;
  latestRagMode?: string;
};

export type OpenMAICEvidenceSummaryCard = {
  key: 'page-ownership' | 'artifact-audit' | 'video-smoke' | 'agent-trace';
  title: string;
  value: string;
  detail: string;
  tone: 'green' | 'orange';
};

export type OpenMAICEvidenceSummary = {
  schemaVersion: 'a3.openmaic-evidence-summary.v1';
  status: 'ready' | 'warning';
  headline: string;
  cards: OpenMAICEvidenceSummaryCard[];
  proofCommands: string[];
  nextActions: string[];
};

export function buildOpenMAICEvidenceSummary(input: OpenMAICEvidenceSummaryInput): OpenMAICEvidenceSummary {
  const pageReady = input.pageMetrics.ready;
  const artifactCount = input.artifactAudit?.total ?? 0;
  const artifactReady = artifactCount > 0;
  const smokeReady = Boolean(input.smokeReport?.success && input.smokeReport.hasVideoUrl);
  const traceReady = Boolean((input.latestTraceId ?? '').trim());
  const ready = pageReady && artifactReady && smokeReady && traceReady && input.verification.warnings === 0;

  const proofCommands = uniqueCommands([
    ...input.verification.items.map((item) => item.command),
    'npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium',
  ]);

  const nextActions: string[] = [];
  if (!artifactReady) {
    nextActions.push('在推荐页生成资源包并触发课堂、PPTX 或视频 artifact 写回。');
  }
  if (!smokeReady) {
    nextActions.push('配置真实视频 provider key 后运行 pnpm smoke:a3-video。');
  }
  if (!traceReady) {
    nextActions.push('运行 Agent workflow 评测生成最新 trace。');
  }

  return {
    schemaVersion: 'a3.openmaic-evidence-summary.v1',
    status: ready ? 'ready' : 'warning',
    headline: ready
      ? 'OpenMAIC 已作为 A3 能力底座形成可追踪证据链。'
      : 'OpenMAIC 接入仍有证据缺口，需要继续补齐 artifact、smoke 或 trace。',
    cards: [
      {
        key: 'page-ownership',
        title: '页面分工',
        value: `${input.pageMetrics.pagesWithVerification}/${input.pageMetrics.totalPages}`,
        detail: pageReady ? '每个 OpenMAIC 能力都有 A3 页面、API 和验证命令。' : '仍有页面缺少 API 或验证证据。',
        tone: pageReady ? 'green' : 'orange',
      },
      {
        key: 'artifact-audit',
        title: 'Artifact 审计',
        value: `${artifactCount}`,
        detail: `课堂 ${input.artifactAudit?.classroomSucceeded ?? 0}/${input.artifactAudit?.classroom ?? 0}，PPTX ${input.artifactAudit?.pptxExportSucceeded ?? 0}/${input.artifactAudit?.pptxExport ?? 0}，视频 ${input.artifactAudit?.videoSucceeded ?? 0}/${input.artifactAudit?.video ?? 0}，降级 ${input.artifactAudit?.videoDegraded ?? 0}。`,
        tone: artifactReady ? 'green' : 'orange',
      },
      {
        key: 'video-smoke',
        title: '真实视频 smoke',
        value: input.smokeReport?.provider || '--',
        detail: smokeReady
          ? `已生成视频 URL，报告位于 ${input.smokeReport?.path || 'tmp/a3-openmaic-smoke-report.json'}。`
          : `状态 ${input.smokeReport?.status || 'not_run'}，${input.smokeReport?.reason || '尚未完成真实 provider smoke。'}`,
        tone: smokeReady ? 'green' : 'orange',
      },
      {
        key: 'agent-trace',
        title: 'Agent trace',
        value: traceReady ? input.latestTraceId!.slice(0, 10) : '--',
        detail: `最近 RAG 模式：${input.latestRagMode || 'unknown'}，trace 用于证明不是前端 mock。`,
        tone: traceReady ? 'green' : 'orange',
      },
    ],
    proofCommands,
    nextActions,
  };
}

function uniqueCommands(commands: string[]) {
  return Array.from(new Set(commands.filter((command) => command.trim())));
}
