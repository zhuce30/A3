export type TeacherVrmActionKey = 'wait' | 'explain' | 'nod' | 'idle';

export type AvatarFrameTiming = {
  deltaSeconds: number;
  elapsedSeconds: number;
};

export function advanceAvatarFrame(
  elapsedSeconds: number,
  rawDeltaSeconds: number,
): AvatarFrameTiming {
  const deltaSeconds = Number.isFinite(rawDeltaSeconds)
    ? Math.max(0, Math.min(0.1, rawDeltaSeconds))
    : 0;
  return {
    deltaSeconds,
    elapsedSeconds: elapsedSeconds + deltaSeconds,
  };
}

export function resolveTeacherActionTransition(
  requestedActionKey: TeacherVrmActionKey,
  availableActionKeys: ReadonlySet<string>,
  activeActionKey: TeacherVrmActionKey | null,
) {
  const actualActionKey = availableActionKeys.has(requestedActionKey)
    ? requestedActionKey
    : availableActionKeys.has('wait')
      ? 'wait'
      : availableActionKeys.has('idle')
        ? 'idle'
        : null;
  return {
    actualActionKey: actualActionKey as TeacherVrmActionKey | null,
    requestedActionAvailable: availableActionKeys.has(requestedActionKey),
    shouldTransition: actualActionKey !== null && actualActionKey !== activeActionKey,
  };
}

export function retainResourceUnlessDisposed<T>(
  resource: T,
  disposed: boolean,
  dispose: (resource: T) => void,
): T | null {
  if (!disposed) return resource;
  dispose(resource);
  return null;
}

export function shouldRunAvatarAnimation(state: {
  disposed: boolean;
  documentVisible: boolean;
  intersecting: boolean;
}) {
  return !state.disposed && state.documentVisible && state.intersecting;
}

export function shouldStartAvatarAssetLoad(state: {
  disposed: boolean;
  documentVisible: boolean;
  intersecting: boolean;
  loadStarted: boolean;
}) {
  return !state.loadStarted && shouldRunAvatarAnimation(state);
}
