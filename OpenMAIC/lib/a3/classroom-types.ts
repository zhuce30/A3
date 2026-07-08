export type ClassroomAgent = {
  id: string;
  name: string;
  role: string;
  description: string;
  status: 'active' | 'waiting';
  color: string;
};

export type ClassroomSource = {
  id: string;
  title: string;
  location: string;
  type: string;
  sourceTypeLabel?: string;
  sourceOrigin?: string;
  sourceScope?: string;
  score: number | null;
  snippet: string;
};

export type ClassroomRecommendation = {
  title: string;
  meta: string;
  progress: number;
  href: string;
  planTask?: {
    dayIndex: number;
    taskId: string;
    completed: boolean;
    status?: string;
  } | null;
};

export type ClassroomAction = {
  title: string;
  href: string;
  type: 'path' | 'assessment' | 'wrong';
};

export type ClassroomContext = {
  course: { id: string; title: string; edition: string } | null;
  path?: { id: string; title: string; progress: number };
  target: {
    id: string;
    title: string;
    description: string;
    chapter: { order: number; title: string };
    progress: number;
    status: 'locked' | 'current' | 'completed';
    estimatedMinutes: number;
    reason: string;
    wrongCount: number;
  } | null;
  agents: ClassroomAgent[];
  sources: ClassroomSource[];
  recommended: ClassroomRecommendation[];
  actions: ClassroomAction[];
  graphSummary: {
    total: number;
    mastered: number;
    learning: number;
    weak: number;
    locked: number;
    unstarted: number;
    masteryRate: number;
    nextCount: number;
  };
};
