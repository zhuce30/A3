export type CoachingUiState =
  | 'idle'
  | 'restoring'
  | 'recording'
  | 'transcribing'
  | 'answering'
  | 'speaking'
  | 'saving'
  | 'ended'
  | 'error';

export type CoachingCitation = {
  id?: string;
  title?: string;
  location?: string;
  type?: string;
  sourceTypeLabel?: string;
  sourceOrigin?: string;
  score?: number | null;
  snippet?: string;
};

export type CoachingClaim = {
  id: string;
  text: string;
  verified: boolean;
  overlap?: number;
  citation?: CoachingCitation | null;
};

export type CoachingSafetyStatus = {
  safe: boolean;
  category: string;
  reason: string;
};

export type CoachingMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  verified?: boolean;
  citations?: CoachingCitation[];
  claims?: CoachingClaim[];
  safety?: CoachingSafetyStatus | null;
  refusalReason?: string;
  degraded?: boolean;
  createdAt?: string;
};

export type CoachingSessionSummary = {
  questionCount: number;
  assistantReplyCount: number;
  verifiedReplyCount: number;
  unverifiedReplyCount: number;
  citationCount: number;
  weakPointSignals: string[];
  latestQuestions: string[];
  nextAction: {
    label: string;
    href: string;
    reason: string;
  };
};

export type CoachingSessionListItem = {
  id: string;
  status: 'active' | 'ended' | 'archived';
  topicTitle: string;
  summary: string;
  questionCount: number;
  verifiedReplyCount: number;
  citationCount: number;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
};
