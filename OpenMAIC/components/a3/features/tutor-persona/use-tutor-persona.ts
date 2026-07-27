'use client';

import { useCallback, useEffect, useState } from 'react';

import { a3GetJson, a3PatchJson } from '@/lib/a3/api-client';
import type {
  A3TutorPersona,
  A3TutorPersonaId,
  A3TutorPreference,
  A3TutorPreferenceResponse,
} from '@/lib/a3/tutor-persona-types';

type TutorPreferenceMutationResponse = Omit<A3TutorPreferenceResponse, 'personas'> & {
  personas?: A3TutorPersona[];
};

export function loadTutorPersonaPreference() {
  return a3GetJson<A3TutorPreferenceResponse>('/api/profiles/tutor-preference/');
}

export function saveTutorPersonaPreference(personaId: A3TutorPersonaId) {
  return a3PatchJson<TutorPreferenceMutationResponse>('/api/profiles/tutor-preference/', { personaId });
}

export function useTutorPersona() {
  const [personas, setPersonas] = useState<A3TutorPersona[]>([]);
  const [preference, setPreference] = useState<A3TutorPreference | null>(null);
  const [selectedPersonaId, setSelectedPersonaId] = useState<A3TutorPersonaId | ''>('');
  const [recommendedPersonaId, setRecommendedPersonaId] = useState<A3TutorPersonaId | ''>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await loadTutorPersonaPreference();
    if (!result.success || !Array.isArray(result.personas) || !result.preference?.personaId) {
      setError(result.error || '辅导方式暂时无法加载');
      setLoading(false);
      return;
    }
    setPersonas(result.personas);
    setPreference(result.preference);
    setSelectedPersonaId(result.preference.personaId);
    setRecommendedPersonaId(
      result.preference.source === 'profile_recommendation' ? result.preference.personaId : '',
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const selectPersona = useCallback(async (personaId: A3TutorPersonaId) => {
    if (saving || personaId === selectedPersonaId) return true;
    setSaving(true);
    setError('');
    const result = await saveTutorPersonaPreference(personaId);
    if (!result.success || !result.preference?.personaId) {
      setError(result.error || '辅导方式保存失败，请重试');
      setSaving(false);
      return false;
    }
    setPreference(result.preference);
    setSelectedPersonaId(result.preference.personaId);
    setSaving(false);
    return true;
  }, [saving, selectedPersonaId]);

  const selectedPersona = personas.find((item) => item.id === selectedPersonaId) || null;

  return {
    personas,
    preference,
    selectedPersona,
    selectedPersonaId,
    recommendedPersonaId,
    loading,
    saving,
    error,
    selectPersona,
    reload,
  };
}
