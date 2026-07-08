import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/coaching-view.tsx');

describe('A3 coaching voice mode', () => {
  it('uses browser live ASR for real-time voice conversation instead of forcing keyed Qwen upload ASR', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("import { useBrowserASR");
    expect(source).toContain('voiceConversationMode');
    expect(source).toContain('browserASR.interimTranscript');
    expect(source).toContain('开启实时语音');
    expect(source).not.toContain("providerId: 'qwen-asr'");
    expect(source).not.toContain("modelId: 'qwen3-asr-flash'");
  });
});
