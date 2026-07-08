import type { A3MultimodalArtifact } from './recommendation-types';
import type { TeacherResourcePackArtifact, TeacherResourcePackArtifactCounts } from './teacher-types';

export type OpenMAICArtifactHistoryItem = {
  type: string;
  status: string;
  provider?: string;
  jobId?: string;
  resourcePackId?: string;
  learningGoal?: string;
  classroomUrl?: string;
  videoUrl?: string;
  resourceType?: string;
  scenesCount?: number;
  pptxExportable?: boolean;
  duration?: number;
  width?: number;
  height?: number;
  fileName?: string;
  slidesCount?: number;
  elapsedMs?: number;
  degradedReason?: string;
  completedAt?: string;
  createdAt?: string;
};

export type OpenMAICArtifactHistoryFilter = 'all' | 'classroom' | 'video' | 'pptx' | 'degraded';

export type OpenMAICArtifactHistorySummary = {
  total: number;
  classroom: number;
  classroomSucceeded: number;
  video: number;
  videoSucceeded: number;
  pptxExport: number;
  pptxExportSucceeded: number;
  degraded: number;
  latestAt: string;
};

export function summarizeOpenMAICArtifactHistory(
  artifacts: OpenMAICArtifactHistoryItem[],
): OpenMAICArtifactHistorySummary {
  const classroom = artifacts.filter((artifact) => artifact.type === 'openmaic_classroom');
  const video = artifacts.filter((artifact) => artifact.type === 'openmaic_video');
  const pptxExport = artifacts.filter((artifact) => artifact.type === 'openmaic_pptx_export');
  const sorted = sortOpenMAICArtifactHistory(artifacts);
  return {
    total: artifacts.length,
    classroom: classroom.length,
    classroomSucceeded: classroom.filter((artifact) => artifact.status === 'succeeded').length,
    video: video.length,
    videoSucceeded: video.filter((artifact) => artifact.status === 'succeeded').length,
    pptxExport: pptxExport.length,
    pptxExportSucceeded: pptxExport.filter((artifact) => artifact.status === 'succeeded').length,
    degraded: artifacts.filter(isDegradedArtifact).length,
    latestAt: artifactTimestamp(sorted[0]) || '',
  };
}

export function sortOpenMAICArtifactHistory<T extends OpenMAICArtifactHistoryItem>(artifacts: T[]): T[] {
  return [...artifacts].sort((left, right) => timestampMs(right) - timestampMs(left));
}

export function filterOpenMAICArtifactHistory<T extends OpenMAICArtifactHistoryItem>(
  artifacts: T[],
  filter: OpenMAICArtifactHistoryFilter,
): T[] {
  if (filter === 'classroom') {
    return artifacts.filter((artifact) => artifact.type === 'openmaic_classroom');
  }
  if (filter === 'video') {
    return artifacts.filter((artifact) => artifact.type === 'openmaic_video');
  }
  if (filter === 'pptx') {
    return artifacts.filter((artifact) => artifact.type === 'openmaic_pptx_export');
  }
  if (filter === 'degraded') {
    return artifacts.filter(isDegradedArtifact);
  }
  return artifacts;
}

export function teacherArtifactCountsToSummary(
  counts?: TeacherResourcePackArtifactCounts,
  artifacts: TeacherResourcePackArtifact[] = [],
): OpenMAICArtifactHistorySummary {
  const historySummary = summarizeOpenMAICArtifactHistory(artifacts);
  if (!counts) return historySummary;
  return {
    total: counts.classroom + counts.video + (counts.pptxExport ?? 0),
    classroom: counts.classroom,
    classroomSucceeded: counts.classroomSucceeded,
    video: counts.video,
    videoSucceeded: counts.videoSucceeded,
    pptxExport: counts.pptxExport ?? historySummary.pptxExport,
    pptxExportSucceeded: counts.pptxExportSucceeded ?? historySummary.pptxExportSucceeded,
    degraded: counts.videoDegraded
      + Math.max(0, counts.classroom - counts.classroomSucceeded)
      + Math.max(0, (counts.pptxExport ?? 0) - (counts.pptxExportSucceeded ?? 0)),
    latestAt: historySummary.latestAt,
  };
}

export function artifactTimestamp(artifact?: OpenMAICArtifactHistoryItem): string {
  if (!artifact) return '';
  return artifact.completedAt || artifact.createdAt || '';
}

export function formatArtifactTimestamp(artifact?: OpenMAICArtifactHistoryItem): string {
  const value = artifactTimestamp(artifact);
  if (!value) return '时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function normalizeResourcePackArtifacts(
  artifacts: A3MultimodalArtifact[] = [],
): OpenMAICArtifactHistoryItem[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    createdAt: artifact.createdAt,
  }));
}

function isDegradedArtifact(artifact: OpenMAICArtifactHistoryItem): boolean {
  return artifact.status !== 'succeeded' || Boolean(artifact.degradedReason);
}

function timestampMs(artifact?: OpenMAICArtifactHistoryItem): number {
  const value = artifactTimestamp(artifact);
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
