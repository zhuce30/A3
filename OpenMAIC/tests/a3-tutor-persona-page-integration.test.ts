import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(root, relativePath), 'utf8');
}

function occurrences(source: string, value: string) {
  return source.split(value).length - 1;
}

describe('A3 tutor persona page integration', () => {
  it('shares one coaching persona across realtime and text QA', () => {
    const coaching = read('components/a3/features/coaching-view.tsx');

    expect(occurrences(coaching, 'useTutorPersona()')).toBe(1);
    expect(occurrences(coaching, '<TutorPersonaSelector')).toBe(1);
    expect(coaching).toContain('tutorPersonaId={tutorPersona.selectedPersonaId}');
    expect(coaching).toContain('personaId={tutorPersona.selectedPersonaId}');
    expect(coaching).toContain('personaId,');
  });

  it('sends the selected persona and persisted session id through realtime startup', () => {
    const hook = read('components/a3/features/coaching/use-realtime-coaching.ts');

    expect(hook).toContain("export function useRealtimeCoaching(personaId");
    expect(hook).toContain("JSON.stringify({ mode: 'voice_video', personaId })");
    expect(hook).toContain('coachingSessionId: realtime.coachingSessionId');
  });

  it('renders a compact classroom selector and sends the same persona to QA', () => {
    const classroom = read('components/a3/features/classroom-view-redesign.tsx');

    expect(occurrences(classroom, 'useTutorPersona()')).toBe(1);
    expect(occurrences(classroom, '<TutorPersonaSelector')).toBe(1);
    expect(classroom).toContain('compact');
    expect(classroom).toContain('personaId: tutorPersona.selectedPersonaId');
  });

  it('forwards only persona id to Django and returns the public resolution', () => {
    const route = read('app/api/a3/coaching/respond/route.ts');

    expect(route).toContain('personaId?: string');
    expect(route).toContain("query.set('persona_id', personaId)");
    expect(route).toContain('resolvedPersona: result.resolvedPersona');
    expect(route).not.toContain('systemInstruction');
    expect(route).not.toContain('openaiVoice');
  });

  it('does not add duplicate digital-human canvases to either page', () => {
    const coaching = read('components/a3/features/coaching-view.tsx');
    const realtime = read('components/a3/features/coaching/realtime-coaching-call.tsx');
    const classroom = read('components/a3/features/classroom-view-redesign.tsx');

    expect(occurrences(coaching, '<DigitalHumanAvatar')).toBe(0);
    expect(occurrences(realtime, '<DigitalHumanAvatar')).toBe(1);
    expect(occurrences(classroom, '<DigitalHumanAvatar')).toBe(0);
  });
});

