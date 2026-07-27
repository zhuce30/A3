import * as THREE from 'three';
import type { AvatarAssetSelection } from '@/lib/a3/digital-human-types';

export type { AvatarAssetSelection } from '@/lib/a3/digital-human-types';

export type AvatarLoadResult =
  | {
      status: 'active';
      activeAssetId: string;
      fallbackUsed: boolean;
    }
  | {
      status: 'stale' | 'cancelled';
      activeAssetId: string;
    };

export const A3_DEFAULT_AVATAR_ASSET: AvatarAssetSelection = Object.freeze({
  assetId: 'teacher-default-v1',
  publicPath: '/a3/assets/teacher-avatar/teacher.vrm',
});

const CONTROLLED_AVATAR_PATH = /^\/a3\/assets\/teacher-avatar\/[A-Za-z0-9][A-Za-z0-9._-]*\.vrm$/;
const CONTROLLED_AVATAR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveControlledAvatarAssetSelection(selection?: AvatarAssetSelection | null): {
  selection: AvatarAssetSelection;
  fallbackUsed: boolean;
} {
  if (
    !selection ||
    !CONTROLLED_AVATAR_ID.test(selection.assetId) ||
    !CONTROLLED_AVATAR_PATH.test(selection.publicPath)
  ) {
    return { selection: A3_DEFAULT_AVATAR_ASSET, fallbackUsed: true };
  }
  return { selection, fallbackUsed: false };
}

export type AvatarModelResources = {
  scene: THREE.Object3D;
  vrm?: unknown;
  mixer?: THREE.AnimationMixer | null;
  actions?: ReadonlyMap<string, THREE.AnimationAction>;
  listenerCleanups?: ReadonlyArray<() => void>;
};

function disposeTexture(texture: THREE.Texture, disposedTextures: Set<THREE.Texture>) {
  if (disposedTextures.has(texture)) return;
  disposedTextures.add(texture);
  texture.dispose();
}

function disposeNestedTextureValue(
  value: unknown,
  disposedTextures: Set<THREE.Texture>,
  visitedValues: Set<object>,
) {
  if (value instanceof THREE.Texture) {
    disposeTexture(value, disposedTextures);
    return;
  }
  if (!value || typeof value !== 'object' || visitedValues.has(value)) return;
  visitedValues.add(value);
  Object.values(value).forEach((item) =>
    disposeNestedTextureValue(item, disposedTextures, visitedValues),
  );
}

function disposeMaterialTextures(
  material: THREE.Material,
  disposedTextures: Set<THREE.Texture>,
) {
  const materialValues = material as unknown as Record<string, unknown>;
  Object.values(materialValues).forEach((value) => {
    if (value instanceof THREE.Texture) disposeTexture(value, disposedTextures);
  });
  disposeNestedTextureValue(materialValues.uniforms, disposedTextures, new Set());
}

function disposeVrm(value: unknown) {
  if (!value || typeof value !== 'object' || !('dispose' in value)) return;
  const dispose = (value as { dispose?: unknown }).dispose;
  if (typeof dispose === 'function') dispose.call(value);
}

export function disposeAvatarModelResources(resources: AvatarModelResources) {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();

  resources.listenerCleanups?.forEach((cleanup) => cleanup());
  if (resources.mixer) {
    resources.actions?.forEach((action) => {
      action.stop();
      resources.mixer?.uncacheAction(action.getClip(), action.getRoot());
    });
    resources.mixer.stopAllAction();
    resources.mixer.uncacheRoot(resources.scene);
  }
  resources.scene.removeFromParent();
  disposeVrm(resources.vrm);
  resources.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (!disposedGeometries.has(object.geometry)) {
      disposedGeometries.add(object.geometry);
      object.geometry.dispose();
    }
    if (object instanceof THREE.SkinnedMesh && object.skeleton.boneTexture) {
      disposeTexture(object.skeleton.boneTexture, disposedTextures);
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      disposeMaterialTextures(material, disposedTextures);
      material.dispose();
    });
  });
}

function avatarAssetSelectionKey(selection: AvatarAssetSelection) {
  return `${selection.assetId}\u0000${selection.publicPath}`;
}

type AvatarAssetLoadCoordinatorOptions<T> = {
  load: (selection: AvatarAssetSelection) => Promise<T>;
  dispose: (resource: T) => void;
  activate?: (resource: T, selection: AvatarAssetSelection) => void;
};

export class AvatarAssetLoadCoordinator<T> {
  private activeResource: T | null = null;
  private activeSelection: AvatarAssetSelection | null = null;
  private requestVersion = 0;
  private cancelled = false;
  private pendingSelectionKey = '';
  private pendingPromise: Promise<AvatarLoadResult> | null = null;

  constructor(private readonly options: AvatarAssetLoadCoordinatorOptions<T>) {}

  get activeAssetId() {
    return this.activeSelection?.assetId || '';
  }

  isActiveSelection(requestedSelection?: AvatarAssetSelection | null) {
    const selection = resolveControlledAvatarAssetSelection(requestedSelection).selection;
    return Boolean(
      this.activeSelection &&
        avatarAssetSelectionKey(this.activeSelection) === avatarAssetSelectionKey(selection),
    );
  }

  select(requestedSelection?: AvatarAssetSelection | null): Promise<AvatarLoadResult> {
    const resolved = resolveControlledAvatarAssetSelection(requestedSelection);
    const selection = resolved.selection;
    const selectionKey = avatarAssetSelectionKey(selection);
    if (this.isActiveSelection(selection)) {
      return Promise.resolve({
        status: 'active',
        activeAssetId: selection.assetId,
        fallbackUsed: resolved.fallbackUsed,
      });
    }
    if (this.pendingSelectionKey === selectionKey && this.pendingPromise) {
      return this.pendingPromise;
    }

    const requestVersion = ++this.requestVersion;
    this.disposeActive();
    this.pendingSelectionKey = selectionKey;
    const pending = this.loadSelection(selection, resolved.fallbackUsed, requestVersion).finally(() => {
      if (this.pendingPromise === pending) {
        this.pendingSelectionKey = '';
        this.pendingPromise = null;
      }
    });
    this.pendingPromise = pending;
    return pending;
  }

  dispose() {
    this.cancelled = true;
    this.requestVersion += 1;
    this.pendingSelectionKey = '';
    this.pendingPromise = null;
    this.disposeActive();
  }

  private disposeActive() {
    if (this.activeResource) this.options.dispose(this.activeResource);
    this.activeResource = null;
    this.activeSelection = null;
  }

  private obsoleteResult(): AvatarLoadResult {
    return {
      status: this.cancelled ? 'cancelled' : 'stale',
      activeAssetId: this.activeAssetId,
    };
  }

  private async loadSelection(
    selection: AvatarAssetSelection,
    fallbackUsed: boolean,
    requestVersion: number,
  ): Promise<AvatarLoadResult> {
    let resource: T;
    let activeSelection = selection;
    try {
      resource = await this.options.load(selection);
    } catch (error) {
      if (requestVersion !== this.requestVersion) return this.obsoleteResult();
      if (
        avatarAssetSelectionKey(selection) ===
        avatarAssetSelectionKey(A3_DEFAULT_AVATAR_ASSET)
      ) throw error;
      activeSelection = A3_DEFAULT_AVATAR_ASSET;
      fallbackUsed = true;
      try {
        resource = await this.options.load(A3_DEFAULT_AVATAR_ASSET);
      } catch (fallbackError) {
        if (requestVersion !== this.requestVersion) return this.obsoleteResult();
        throw fallbackError;
      }
    }

    if (requestVersion !== this.requestVersion) {
      this.options.dispose(resource);
      return this.obsoleteResult();
    }
    this.activeResource = resource;
    this.activeSelection = activeSelection;
    this.options.activate?.(resource, activeSelection);
    return {
      status: 'active',
      activeAssetId: activeSelection.assetId,
      fallbackUsed,
    };
  }
}

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
