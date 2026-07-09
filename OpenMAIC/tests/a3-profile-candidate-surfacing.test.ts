import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

describe('A3 profile update candidate surfacing', () => {
  it('surfaces fresh profile update candidates in admission diagnostic, wrong notebook and classroom flows', () => {
    const diagnostic = read('components/a3/features/admission-diagnostic-view.tsx');
    const wrongNotebook = read('components/a3/features/wrong-notebook-view.tsx');
    const classroom = read('components/a3/features/classroom-view.tsx');

    for (const source of [diagnostic, wrongNotebook, classroom]) {
      expect(source).toContain('ProfileUpdateCandidatePanel');
      expect(source).toContain("'/api/profiles/dynamic-profile/'");
      expect(source).toContain('data-testid="a3-flow-profile-candidates"');
      expect(source).toContain('/a3/profile-setup');
    }
  });

  it('keeps the reusable candidate panel evidence-rich and action-oriented', () => {
    const panel = read('components/a3/profile/profile-update-candidate-panel.tsx');

    expect(panel).toContain('summarizeProfileTimelineEntry');
    expect(panel).toContain('summarizeProfileUpdateEvidence');
    expect(panel).toContain('confirmationQueue');
    expect(panel).toContain('查看画像变化');
    expect(panel).toContain('本次学习让画像发生了变化');
  });
});
