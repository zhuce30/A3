export function createCoachingSessionLoader<T>(
  fetchSession: (sessionId: string) => Promise<T>,
) {
  let generation = 0;

  return {
    async load(sessionId: string, commit: (result: T) => void) {
      const requestGeneration = ++generation;
      const result = await fetchSession(sessionId);
      if (requestGeneration !== generation) return null;
      commit(result);
      return result;
    },
    dispose() {
      generation += 1;
    },
  };
}

export function commitRealtimeEndedSession(
  loader: { dispose: () => void } | null,
  sessionId: string,
  commit: (sessionId: string) => void,
) {
  loader?.dispose();
  commit(sessionId);
}
