export type A3FavoriteType = 'video' | 'courseware' | 'knowledge_card' | 'exercise' | 'note';

export type A3Favorite = {
  id: string;
  title: string;
  type: A3FavoriteType;
  typeLabel: string;
  source: string;
  url: string;
  group: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type A3FavoriteSummary = {
  total: number;
  groups: Array<{ name: string; count: number }>;
  types: Array<{ type: A3FavoriteType; label: string; count: number }>;
};

export type A3FavoritesResponse = {
  success: boolean;
  error?: string;
  favorites: A3Favorite[];
  summary: A3FavoriteSummary;
};

export type A3NotificationType = 'learning_task' | 'assessment' | 'knowledge_base' | 'system' | 'teacher';
export type A3NotificationActionKind = 'today' | 'review' | 'plan' | 'assessment' | 'report';
export type A3NotificationPlanChange = {
  schemaVersion: string;
  currentChange?: import('./learning-types').StudyPlanAdjustment;
  nextAction?: { label?: string; href?: string; reason?: string };
};

export type A3Notification = {
  id: string;
  title: string;
  detail: string;
  type: A3NotificationType;
  typeLabel: string;
  unread: boolean;
  actionUrl: string;
  payload: Record<string, unknown>;
  learningLoop?: {
    schemaVersion: string;
    kind: A3NotificationActionKind;
    reason: string;
    expectedFeedback: string;
    nextAction: { label: string; href: string };
    planChange?: A3NotificationPlanChange;
  };
  createdAt: string;
  readAt: string | null;
};

export type A3NotificationSummary = {
  total: number;
  unread: number;
  byType: Array<{ type: A3NotificationType; label: string; count: number }>;
};

export type A3NotificationActionGroup = {
  kind: A3NotificationActionKind;
  label: string;
  count: number;
  unread: number;
  description: string;
  primaryAction: { label: string; href: string; reason: string };
  learningLoop?: A3Notification['learningLoop'];
  recent: A3Notification;
  priority: number;
};

export type A3NotificationsResponse = {
  success: boolean;
  error?: string;
  notifications: A3Notification[];
  summary: A3NotificationSummary;
  actionGroups?: A3NotificationActionGroup[];
};
