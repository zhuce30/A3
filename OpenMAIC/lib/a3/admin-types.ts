export type A3AdminDataStatus = 'collected' | 'not_collected' | 'partial';
export type A3AdminServiceStatus = 'configured' | 'healthy' | 'degraded' | 'down' | 'unknown';
export type A3PresenceStatus = 'online' | 'idle' | 'offline';
export type A3AdminTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
export type A3AdminTaskKind =
  | 'resource_generation'
  | 'video_generation'
  | 'video_composition'
  | 'knowledge_index';

export type A3AdminPagination = { page: number; pageSize: number; total: number };
export type A3AdminApiResponse = { success: boolean; error?: string };
export type A3AdminPersonRef = { id: string; displayName: string };

export type A3JsonValue = string | number | boolean | null | A3JsonValue[] | A3JsonObject;
export type A3JsonObject = { [key: string]: A3JsonValue };

export type A3AdminMetric = {
  value: number | null;
  dataStatus: A3AdminDataStatus;
  definition: string;
  evidence?: { source: string; window?: string };
};

export type A3AdminMetricKey =
  | 'users'
  | 'newUsers'
  | 'activeUsers'
  | 'activeUsers24h'
  | 'coachingSessions'
  | 'coachingSessions24h'
  | 'learningEvents'
  | 'learningEvents24h'
  | 'resourcePacks'
  | 'resourcePacks24h'
  | 'agentRuns'
  | 'agentRuns24h'
  | 'agentFailureRate'
  | 'securityEvents';

export type A3AdminTaskCounts = Record<A3AdminTaskStatus, number>;

export type A3AdminOverview = A3AdminApiResponse & {
  schemaVersion: 'a3.admin-overview.v2' | string;
  generatedAt: string;
  range: '24h' | '7d' | '30d';
  dataStatus: A3AdminDataStatus;
  period: {
    startAt: string;
    endAt: string;
    startDate: string;
    endDate: string;
    timeZone: 'Asia/Shanghai' | string;
    bucketUnit: 'hour' | 'day';
  };
  metrics: Partial<Record<A3AdminMetricKey, A3AdminMetric>>;
  trends: Array<{
    date: string;
    label: string;
    activeUsers: number;
    coachingSessions: number;
    resourcePacks: number;
    agentRuns: number;
    dataStatus: A3AdminDataStatus;
    seriesDataStatus: {
      activeUsers: A3AdminDataStatus;
      coachingSessions: A3AdminDataStatus;
      resourcePacks: A3AdminDataStatus;
      agentRuns: A3AdminDataStatus;
    };
  }>;
  services: Array<{
    key: string;
    name: string;
    status: A3AdminServiceStatus;
    message: string;
    dataStatus: A3AdminDataStatus;
    evidence?: A3JsonObject;
  }>;
  tasks: {
    resource: A3AdminTaskCounts;
    video: A3AdminTaskCounts;
    knowledge: A3AdminTaskCounts;
    agent: A3AdminTaskCounts;
    totals: A3AdminTaskCounts;
  };
  taskTotals: A3AdminTaskCounts;
  alerts: Array<{
    id: string;
    type: string;
    severity: 'info' | 'warning' | 'error' | string;
    title: string;
    summary: string;
    count: number;
    dataStatus: A3AdminDataStatus;
    evidence?: A3JsonObject;
  }>;
  activity: Array<{
    id: string;
    type: string;
    summary: string;
    status: A3AdminTaskStatus;
    createdAt: string;
    dataStatus: A3AdminDataStatus;
    evidence?: A3JsonObject;
  }>;
  knowledgeBase: { resources: number; failedJobs: number; dataStatus?: A3AdminDataStatus; evidence?: A3JsonObject };
  security: { events24h: number; eventsInRange?: number; actionableInRange?: number; dataStatus?: A3AdminDataStatus };
};

export type A3AdminIpValue = {
  status: 'collected' | 'not_collected';
  masked: string;
  label: string;
};

export type A3AdminUser = {
  id: string;
  displayName: string;
  phone: string;
  email: string;
  studentId: string;
  role: 'student' | 'teacher' | 'admin';
  school: string;
  isActive: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  presence: { status: A3PresenceStatus; lastSeenAt: string | null };
  registrationIp: A3AdminIpValue;
  lastIp: A3AdminIpValue;
  country: string;
  learningProfile: { majorDirection: string; foundationLevel: string; primaryGoal: string };
  activity: { learningEvents: number; coachingSessions: number; resourcePacks: number; agentRuns: number };
};

export type A3AdminUsersResponse = A3AdminApiResponse & { items: A3AdminUser[]; pagination: A3AdminPagination };

export type A3AdminConversation = {
  id: string;
  user: A3AdminPersonRef;
  status: string;
  topicTitle: string;
  course: { id: string; code: string; title: string } | null;
  knowledgePoint: { id: string; title: string } | null;
  traceId: string;
  learningGoal: string;
  workflow: string;
  source: string;
  messageCount: number;
  verifiedMessageCount: number;
  degradedMessageCount: number;
  safetyBlockedCount: number;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  createdAt: string;
  bodyAvailable: boolean;
};

export type A3AdminConversationMessage = {
  id: string;
  role: string;
  content: string;
  verified: boolean;
  degraded: boolean;
  safetyBlocked: boolean;
  createdAt: string;
};

export type A3AdminConversationsResponse = A3AdminApiResponse & { items: A3AdminConversation[]; pagination: A3AdminPagination };

export type A3AdminCourse = {
  id: string;
  code: string;
  title: string;
  edition: string;
  isActive: boolean;
  chapterCount: number;
  knowledgePointCount: number;
  teacherCount: number;
  studentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type A3AdminKnowledgeResource = {
  id: string;
  name: string;
  fileType: string;
  fileSize: number;
  scope: string;
  courseKey: string;
  visibility: string;
  publicationStatus: 'published' | 'offline' | 'owner_only';
  status: string;
  documentCount: number;
  chunkCount: number;
  errorSummary: string;
  owner: A3AdminPersonRef;
  indexJob: null | {
    id: string;
    type: string;
    status: string;
    progress: number;
    processedFiles: number;
    totalFiles: number;
    errorSummary: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type A3AdminCatalogCoursesResponse = A3AdminApiResponse & { items: A3AdminCourse[]; pagination: A3AdminPagination };
export type A3AdminCatalogResourcesResponse = A3AdminApiResponse & { items: A3AdminKnowledgeResource[]; pagination: A3AdminPagination };

export type A3AdminTask = {
  id: string;
  kind: A3AdminTaskKind;
  jobId: string;
  user: A3AdminPersonRef;
  status: A3AdminTaskStatus;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorSummary: string;
  traceId: string;
  eligibility: {
    retry: boolean;
    retryReason: string;
    retryEvidence: { supportedTransition?: boolean; failedSegmentExists?: boolean };
    cancel: boolean;
  };
};

export type A3AdminTasksResponse = A3AdminApiResponse & { items: A3AdminTask[]; pagination: A3AdminPagination };

export type A3AdminAgentMetadata = {
  provider?: string;
  model?: string;
  promptHash?: string;
  errorType?: string;
  latencyMs?: number;
  timedOut?: boolean;
  fallbackReason?: string;
  degraded?: boolean;
  a3EvidenceSchemaVersion?: string;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type A3AdminAgentRun = {
  traceId: string;
  user: A3AdminPersonRef;
  schemaVersion: string;
  workflow: string;
  status: string;
  fallbackStrategy: string;
  latencyMs: number;
  stepCount: number;
  spanCount: number;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: A3AdminAgentMetadata;
};

export type A3AdminAgentRunDetail = A3AdminAgentRun & {
  steps: Array<{ order: number; name: string; role: string; status: string; latencyMs: number; createdAt: string; metadata: A3AdminAgentMetadata }>;
  spans: Array<{ id: string; parentStep: string; name: string; kind: string; status: string; latencyMs: number; startedAt: string; completedAt: string | null; metadata: A3AdminAgentMetadata }>;
  stepsTruncated: boolean;
  spansTruncated: boolean;
};

export type A3AdminAgentRunsResponse = A3AdminApiResponse & { items: A3AdminAgentRun[]; pagination: A3AdminPagination };

export type A3AdminSecurityReviewStatus = 'pending' | 'confirmed' | 'false_positive' | 'resolved';
export type A3AdminSecurityEvent = {
  id: string;
  category: string;
  severity: string;
  source: string;
  summary: string;
  reviewStatus: A3AdminSecurityReviewStatus;
  reviewNote: string;
  user: A3AdminPersonRef | null;
  reviewer: A3AdminPersonRef | null;
  reviewedAt: string | null;
  createdAt: string;
};
export type A3AdminSecurityEventsResponse = A3AdminApiResponse & { items: A3AdminSecurityEvent[]; pagination: A3AdminPagination };

export type A3AdminConfigurationCheck = {
  check: string;
  label: string;
  group: 'runtime' | 'notifications' | 'providers' | 'storage' | string;
  status: 'configured' | 'not_configured' | 'healthy' | 'degraded' | 'down' | string;
  configured: boolean;
  message: string;
  lastVerifiedAt: string | null;
  evidence: {
    reachable?: boolean;
    remoteConnectionTested?: boolean;
    workerCount?: number;
    scheduleConfigured?: boolean;
    configured?: boolean;
    messageSent?: boolean;
    paidCallPerformed?: boolean;
    available?: boolean;
    absolutePathReturned?: boolean;
    remoteCallPerformed?: boolean;
  };
};
export type A3AdminConfigurationResponse = A3AdminApiResponse & { items: A3AdminConfigurationCheck[]; generatedAt: string };

export type A3AdminAuditLog = {
  id: string;
  actor: A3AdminPersonRef | null;
  action: string;
  targetType: string;
  targetId: string;
  targetUser: A3AdminPersonRef | null;
  summary: string;
  reason: string;
  success: boolean;
  before: A3JsonObject;
  after: A3JsonObject;
  metadata: A3JsonObject;
  actorIp: string | null;
  createdAt: string;
};
export type A3AdminAuditLogsResponse = A3AdminApiResponse & { items: A3AdminAuditLog[]; pagination: A3AdminPagination };
