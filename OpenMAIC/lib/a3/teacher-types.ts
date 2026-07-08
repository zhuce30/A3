import type { A3Metric } from './types';

export type TeacherWorkbenchStudent = {
  id: string;
  name: string;
  grade: string;
  majorDirection: string;
  progress: number;
  currentPoint: string;
  wrongSignal: number;
  riskLevel: 'low' | 'medium' | 'high';
  riskReason?: string;
  resourcePack?: {
    totalRuns: number;
    verifiedSourceCount: number;
    practiceStartedCount: number;
    latestGoal: string;
    latestAt: string;
    artifactCounts?: TeacherResourcePackArtifactCounts;
    latestArtifacts?: TeacherResourcePackArtifact[];
    nextAction: {
      label: string;
      href: string;
      type: 'assessment' | 'notification';
    };
  };
  prescription?: {
    title: string;
    reason: string;
    primaryAction: {
      label: string;
      href: string;
      type: 'intervention' | 'assessment' | 'notification';
    };
    actions: Array<{
      label: string;
      href: string;
      type: 'review' | 'coaching' | 'today' | 'assessment' | 'plan' | 'report';
    }>;
  };
  interventionAction?: {
    label: string;
    href: string;
    type: 'intervention' | 'assessment' | 'notification';
  };
};

export type TeacherResourcePackArtifactCounts = {
  classroom: number;
  classroomSucceeded: number;
  video: number;
  videoSucceeded: number;
  videoDegraded: number;
  pptxExport?: number;
  pptxExportSucceeded?: number;
};

export type TeacherResourcePackArtifact = {
  type: 'openmaic_classroom' | 'openmaic_video' | 'openmaic_pptx_export' | string;
  status: string;
  provider?: string;
  jobId?: string;
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
  degradedReason?: string;
  resourcePackId?: string;
  learningGoal?: string;
  completedAt?: string;
  createdAt?: string;
};

export type TeacherWeakPoint = {
  label: string;
  meta: string;
  value: number;
  progress: number;
  tone: 'blue' | 'orange' | 'red';
};

export type TeacherDistributionItem = {
  label: string;
  count: number;
  percent: number;
  tone: 'green' | 'blue' | 'orange' | 'red';
};

export type TeacherTask = {
  title: string;
  type: 'assessment' | 'notification' | 'report' | 'intervention' | 'knowledge_base' | 'resource_pack_reminder';
  status: 'ready' | 'warning' | 'running';
};

export type TeacherWorkbench = {
  metrics: A3Metric[];
  students: TeacherWorkbenchStudent[];
  weakPoints: TeacherWeakPoint[];
  knowledgeBase: {
    totalFiles: number;
    indexedFiles: number;
    failedFiles: number;
    runningJobs: number;
  };
  resourcePackSummary?: {
    schemaVersion: string;
    totalStudents: number;
    completedStudents: number;
    completionRate: number;
    totalRuns: number;
    verifiedSourceCount: number;
    practiceStartedCount: number;
    artifactCounts?: TeacherResourcePackArtifactCounts;
    latestArtifacts?: TeacherResourcePackArtifact[];
    needsPracticeStudents: Array<{ id: string; name: string; currentPoint: string }>;
    nextAction: {
      label: string;
      href: string;
      type: 'resource_pack_reminder';
    };
  };
  tasks: TeacherTask[];
  distribution: TeacherDistributionItem[];
};
