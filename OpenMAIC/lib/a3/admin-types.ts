export type A3AdminDataStatus = 'collected' | 'not_collected' | 'partial';
export type A3AdminServiceStatus = 'configured' | 'healthy' | 'degraded' | 'down' | 'unknown';
export type A3PresenceStatus = 'online' | 'idle' | 'offline';

export type A3AdminMetric = {
  value: number | null;
  dataStatus: A3AdminDataStatus;
  definition: string;
};

export type A3AdminOverview = {
  success: boolean;
  error?: string;
  schemaVersion: string;
  generatedAt: string;
  metrics: Record<string, A3AdminMetric>;
  services: Array<{ key: string; name: string; status: A3AdminServiceStatus; message: string }>;
  tasks: Record<string, Record<'queued' | 'running' | 'succeeded' | 'failed', number>>;
  knowledgeBase: { resources: number; failedJobs: number };
  security: { events24h: number };
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

export type A3AdminUsersResponse = {
  success: boolean;
  error?: string;
  items: A3AdminUser[];
  pagination: { page: number; pageSize: number; total: number };
};
