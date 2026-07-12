export const A3_DIGITAL_HUMAN_AVATAR_STATES = [
  'idle',
  'connecting',
  'listening',
  'thinking',
  'speaking',
  'visual_focus',
  'degraded',
  'error',
  'ended',
] as const;

export type A3DigitalHumanAvatarState = (typeof A3_DIGITAL_HUMAN_AVATAR_STATES)[number];

export const A3_DIGITAL_HUMAN_AVATAR_MODES = [
  'local_vrm',
  'local_3d',
  'local_2d',
  'remote_video',
  'static_fallback',
] as const;

export type A3DigitalHumanAvatarMode = (typeof A3_DIGITAL_HUMAN_AVATAR_MODES)[number];

export type A3DigitalHumanSpeechViseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';

export type A3DigitalHumanSpeechCue = {
  id: string;
  source: 'tts_viseme' | 'tts_phoneme' | 'audio_energy';
  startsAtMs: number;
  endsAtMs: number;
  viseme?: A3DigitalHumanSpeechViseme;
  phoneme?: string;
  energy?: number;
  weights?: Partial<Record<A3DigitalHumanSpeechViseme, number>>;
};

export type A3DigitalHumanAvatarProps = {
  state: A3DigitalHumanAvatarState;
  mode?: A3DigitalHumanAvatarMode;
  audioLevel: number;
  assistantSpeaking: boolean;
  providerLabel: string;
  modelLabel: string;
  fallbackReason?: string;
  speechCues?: A3DigitalHumanSpeechCue[];
};
