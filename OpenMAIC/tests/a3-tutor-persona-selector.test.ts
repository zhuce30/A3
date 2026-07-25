import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { A3TutorPersona } from '@/lib/a3/tutor-persona-types';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: apiMocks.get,
  a3PatchJson: apiMocks.patch,
}));

import {
  loadTutorPersonaPreference,
  saveTutorPersonaPreference,
} from '@/components/a3/features/tutor-persona/use-tutor-persona';
import { TutorPersonaSelector } from '@/components/a3/features/tutor-persona/tutor-persona-selector';

const personas: A3TutorPersona[] = [
  persona('structured-teacher', '结构讲解', '先搭框架，再分步骤讲清概念'),
  persona('socratic-guide', '启发追问', '通过关键问题，引导你自己找到答案'),
  persona('practice-coach', '例题实战', '用例题、步骤和即时反馈巩固薄弱点'),
  persona('foundation-coach', '基础补强', '从先修概念开始，用短句和小步讲解'),
];

beforeEach(() => {
  apiMocks.get.mockReset();
  apiMocks.patch.mockReset();
});

describe('TutorPersonaSelector', () => {
  it('renders a stable loading state', () => {
    const html = renderSelector({ loading: true, personas: [] });
    expect(html).toContain('data-testid="a3-tutor-persona-loading"');
    expect(html).toContain('正在读取辅导方式');
  });

  it('renders four public options with selected and recommended states', () => {
    const html = renderSelector({
      personas,
      selectedPersonaId: 'socratic-guide',
      recommendedPersonaId: 'foundation-coach',
    });

    expect((html.match(/data-testid="a3-tutor-persona-option-/g) || []).length).toBe(4);
    expect(html).toContain('data-testid="a3-tutor-persona-option-socratic-guide"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('适合当前基础');
    expect(html).not.toContain('strategyInstruction');
    expect(html).not.toContain('openaiVoice');
    expect(html).not.toContain('dashscopeVoice');
  });

  it('renders retry recovery without hiding the options', () => {
    const html = renderSelector({ personas, error: '辅导方式暂时无法加载' });
    expect(html).toContain('辅导方式暂时无法加载');
    expect(html).toContain('data-testid="a3-tutor-persona-retry"');
    expect(html).toContain('结构讲解');
  });

  it('loads and patches the canonical preference endpoint', async () => {
    const response = {
      success: true,
      personas,
      preference: {
        personaId: 'practice-coach',
        source: 'saved',
        schemaVersion: 'a3.tutor-preference.v1',
        updatedAt: '',
      },
      selectedPersona: personas[2],
    };
    apiMocks.get.mockResolvedValue(response);
    apiMocks.patch.mockResolvedValue(response);

    await expect(loadTutorPersonaPreference()).resolves.toEqual(response);
    await expect(saveTutorPersonaPreference('practice-coach')).resolves.toEqual(response);
    expect(apiMocks.get).toHaveBeenCalledWith('/api/profiles/tutor-preference/');
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/profiles/tutor-preference/', {
      personaId: 'practice-coach',
    });
  });
});

function renderSelector(overrides: Partial<Parameters<typeof TutorPersonaSelector>[0]>) {
  return renderToStaticMarkup(createElement(TutorPersonaSelector, {
    personas: [],
    selectedPersonaId: '',
    recommendedPersonaId: '',
    loading: false,
    saving: false,
    error: '',
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }));
}

function persona(
  id: A3TutorPersona['id'],
  name: string,
  shortDescription: string,
): A3TutorPersona {
  return {
    id,
    name,
    shortDescription,
    teachingStyle: id,
    avatarAssetId: 'teacher-default-v1',
    voiceProfileId: `voice-${id}`,
    allowedWorkflows: ['coaching', 'classroom'],
    schemaVersion: 'a3.tutor-persona.v1',
  };
}

