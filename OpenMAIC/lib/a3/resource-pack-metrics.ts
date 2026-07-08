export type OpenMAICArtifactAuditMetric = {
  schemaVersion: string;
  total: number;
  classroom: number;
  classroomSucceeded: number;
  video: number;
  videoSucceeded: number;
  videoDegraded: number;
  pptxExport?: number;
  pptxExportSucceeded?: number;
  latestArtifacts: Array<{
    type: string;
    status: string;
    provider?: string;
    jobId?: string;
    resourcePackId?: string;
    packId?: string;
    createdAt?: string;
    classroomUrl?: string;
    videoUrl?: string;
    fileName?: string;
    slidesCount?: number;
    degradedReason?: string;
  }>;
};

export type ResourcePackMetrics = {
  schemaVersion: string;
  totalRuns: number;
  verifiedSourceCount: number;
  practiceStartedCount: number;
  conversionRate: number;
  converted: boolean;
  latestGoal: string;
  latestAt: string;
  message: string;
  readiness: 'ready' | 'watch';
  openmaicClassroom?: {
    schemaVersion?: string;
    status: string;
    jobId: string;
    classroomId?: string;
    classroomUrl: string;
    scenesCount: number;
    pptxExportable: boolean;
    provider?: string;
    elapsedMs?: number;
    degradedReason?: string;
    packId?: string;
    goal?: string;
  };
  openmaicVideo?: {
    schemaVersion?: string;
    status: string;
    provider?: string;
    resourceType?: string;
    videoUrl: string;
    duration: number;
    width?: number;
    height?: number;
    elapsedMs?: number;
    degradedReason?: string;
    packId?: string;
    goal?: string;
  };
  artifactAudit?: OpenMAICArtifactAuditMetric;
  nextAction: {
    label: string;
    href: string;
    reason: string;
  };
};

export type ResourcePackMetricCard = {
  label: string;
  value: string;
  detail: string;
  tone: 'green' | 'orange' | 'blue' | 'violet';
};

export function buildResourcePackMetricCards(metrics: ResourcePackMetrics): ResourcePackMetricCard[] {
  const readyTone = metrics.readiness === 'ready' ? 'green' : 'orange';
  return [
    {
      label: '闭环率',
      value: `${metrics.conversionRate}%`,
      detail: metrics.converted ? '推荐资源已转化为专项练习' : '需要先完成一个资源包并进入练习',
      tone: readyTone,
    },
    {
      label: '完成资源包',
      value: `${metrics.totalRuns}`,
      detail: metrics.latestGoal ? `最近：${metrics.latestGoal}` : '暂无资源包完成记录',
      tone: metrics.totalRuns > 0 ? 'blue' : 'orange',
    },
    {
      label: '专项练习',
      value: `${metrics.practiceStartedCount}`,
      detail: '用于证明推荐结果进入测评闭环',
      tone: metrics.practiceStartedCount > 0 ? 'violet' : 'orange',
    },
    {
      label: '验证来源',
      value: `${metrics.verifiedSourceCount}`,
      detail: '来自资源包累计引用的可信来源',
      tone: metrics.verifiedSourceCount > 0 ? 'green' : 'orange',
    },
  ];
}
