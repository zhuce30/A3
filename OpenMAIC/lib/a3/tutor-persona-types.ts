export type A3TutorPersonaId =
  | 'structured-teacher'
  | 'socratic-guide'
  | 'practice-coach'
  | 'foundation-coach';

export type A3TutorPersona = {
  id: A3TutorPersonaId;
  name: string;
  shortDescription: string;
  teachingStyle: string;
  avatarAssetId: string;
  avatarPublicPath: string;
  voiceProfileId: string;
  voicePreviewEnabled: boolean;
  allowedWorkflows: string[];
  schemaVersion: string;
};

export type A3TutorVoicePreviewState = {
  personaId: A3TutorPersonaId | null;
  status: 'idle' | 'loading' | 'playing' | 'error';
  error: string;
};

export type A3TutorPreference = {
  personaId: A3TutorPersonaId;
  source: 'saved' | 'profile_recommendation' | 'default';
  schemaVersion: string;
  updatedAt: string;
};

export type A3TutorPreferenceResponse = {
  success: boolean;
  error?: string;
  personas: A3TutorPersona[];
  preference: A3TutorPreference;
  selectedPersona: A3TutorPersona;
};
