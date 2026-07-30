const QWEN_35_VOICES = new Set([
  'Tina',
  'Serena',
  'Ethan',
]);

const QWEN_35_LEGACY_VOICE_FALLBACKS = new Map([
  ['Cherry', 'Tina'],
  ['Chelsie', 'Tina'],
]);

export function resolveRealtimeVoice(model, requestedVoice) {
  const voice = String(requestedVoice || '').trim() || 'Tina';
  if (!String(model || '').toLowerCase().startsWith('qwen3.5-omni-')) return voice;
  if (QWEN_35_VOICES.has(voice)) return voice;
  return QWEN_35_LEGACY_VOICE_FALLBACKS.get(voice) || 'Tina';
}

export function resolveTurnDetectionType(value) {
  return String(value || '').trim() || 'server_vad';
}
