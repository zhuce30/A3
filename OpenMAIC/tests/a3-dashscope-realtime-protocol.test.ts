import { describe, expect, it } from 'vitest';

// The realtime proxy runs directly in Node, so its protocol helpers stay in ESM JavaScript.
import { resolveRealtimeVoice } from '../scripts/a3-dashscope-realtime-protocol.mjs';

describe('A3 DashScope realtime protocol', () => {
  it('maps legacy voices to voices supported by Qwen 3.5 Omni Realtime', () => {
    expect(resolveRealtimeVoice('qwen3.5-omni-plus-realtime', 'Cherry')).toBe('Tina');
    expect(resolveRealtimeVoice('qwen3.5-omni-plus-realtime', 'Chelsie')).toBe('Tina');
    expect(resolveRealtimeVoice('qwen3.5-omni-plus-realtime', 'Serena')).toBe('Serena');
    expect(resolveRealtimeVoice('qwen3.5-omni-plus-realtime', 'Ethan')).toBe('Ethan');
  });

  it('does not rewrite voices for older realtime model families', () => {
    expect(resolveRealtimeVoice('qwen-omni-turbo-realtime', 'Cherry')).toBe('Cherry');
  });
});
