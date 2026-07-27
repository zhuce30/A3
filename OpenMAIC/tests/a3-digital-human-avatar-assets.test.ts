// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientRuntime = vi.hoisted(() => ({
  loaderCalls: [] as string[],
  pending: [] as Array<{
    path: string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>,
  renderers: [] as Array<{
    canvas: HTMLCanvasElement;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class TestWebGLRenderer {
    canvas: HTMLCanvasElement;
    dispose = vi.fn();
    constructor(options: { canvas: HTMLCanvasElement }) {
      this.canvas = options.canvas;
      clientRuntime.renderers.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    render() {}
  }
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class TestGltfLoader {
    register() {
      return this;
    }
    loadAsync(path: string) {
      clientRuntime.loaderCalls.push(path);
      return new Promise((resolve, reject) => {
        clientRuntime.pending.push({ path, resolve, reject });
      });
    }
  },
}));

vi.mock('@pixiv/three-vrm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pixiv/three-vrm')>();
  return {
    ...actual,
    VRMLoaderPlugin: class TestVrmLoaderPlugin {},
    VRMUtils: {
      rotateVRM0: vi.fn(),
      removeUnnecessaryVertices: vi.fn(),
    },
  };
});

import { DigitalHumanThreeStage } from '@/components/a3/features/coaching/digital-human-three-stage';
import {
  A3_DEFAULT_AVATAR_ASSET,
  AvatarAssetLoadCoordinator,
  disposeAvatarModelResources,
  resolveControlledAvatarAssetSelection,
  type AvatarAssetSelection,
} from '@/components/a3/features/coaching/digital-human-runtime';

const secondAsset: AvatarAssetSelection = {
  assetId: 'licensed-teacher-v2',
  publicPath: '/a3/assets/teacher-avatar/licensed-teacher-v2.vrm',
};

const thirdAsset: AvatarAssetSelection = {
  assetId: 'licensed-teacher-v3',
  publicPath: '/a3/assets/teacher-avatar/licensed-teacher-v3.vrm',
};

const sameIdAlternateAsset: AvatarAssetSelection = {
  assetId: A3_DEFAULT_AVATAR_ASSET.assetId,
  publicPath: '/a3/assets/teacher-avatar/teacher-alternate.vrm',
};

let mountedRoot: Root | null = null;

beforeEach(() => {
  clientRuntime.loaderCalls.length = 0;
  clientRuntime.pending.length = 0;
  clientRuntime.renderers.length = 0;
  fakeModels.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  vi.unstubAllGlobals();
});

describe('controlled tutor avatar assets', () => {
  it('uses a cache-friendly GLB URL while accepting the legacy default VRM path', () => {
    expect(A3_DEFAULT_AVATAR_ASSET.publicPath).toBe(
      '/a3/assets/teacher-avatar/teacher.glb',
    );

    expect(
      resolveControlledAvatarAssetSelection({
        assetId: A3_DEFAULT_AVATAR_ASSET.assetId,
        publicPath: '/a3/assets/teacher-avatar/teacher.vrm',
      }),
    ).toEqual({ selection: A3_DEFAULT_AVATAR_ASSET, fallbackUsed: false });
  });

  it.each([
    'https://example.com/teacher.vrm',
    '//example.com/teacher.vrm',
    '/a3/assets/teacher-avatar/../secret.vrm',
    '/a3/assets/teacher-avatar/nested/teacher.vrm',
    '/a3/assets/teacher-avatar/teacher.vrm?token=secret',
    '/avatars/teacher.vrm',
  ])('rejects an untrusted public path: %s', (publicPath) => {
    const resolved = resolveControlledAvatarAssetSelection({
      assetId: 'untrusted',
      publicPath,
    });

    expect(resolved).toEqual({ selection: A3_DEFAULT_AVATAR_ASSET, fallbackUsed: true });
  });

  it('does not reload when the canonical asset selection is unchanged', async () => {
    const load = vi.fn(async (selection: AvatarAssetSelection) => ({ id: selection.assetId }));
    const dispose = vi.fn();
    const coordinator = new AvatarAssetLoadCoordinator({ load, dispose });

    await coordinator.select(A3_DEFAULT_AVATAR_ASSET);
    const result = await coordinator.select({ ...A3_DEFAULT_AVATAR_ASSET });

    expect(load).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'active',
      activeAssetId: 'teacher-default-v1',
      fallbackUsed: false,
    });
  });

  it('prevents a slow stale request from replacing the latest model and disposes it', async () => {
    const completions = new Map<string, (resource: { id: string }) => void>();
    const load = vi.fn(
      (selection: AvatarAssetSelection) =>
        new Promise<{ id: string }>((resolve) => completions.set(selection.assetId, resolve)),
    );
    const dispose = vi.fn();
    const activate = vi.fn();
    const coordinator = new AvatarAssetLoadCoordinator({ load, dispose, activate });

    const slow = coordinator.select(A3_DEFAULT_AVATAR_ASSET);
    const latest = coordinator.select(secondAsset);
    completions.get(secondAsset.assetId)?.({ id: secondAsset.assetId });
    await latest;
    completions.get(A3_DEFAULT_AVATAR_ASSET.assetId)?.({ id: A3_DEFAULT_AVATAR_ASSET.assetId });
    await expect(slow).resolves.toEqual({
      status: 'stale',
      activeAssetId: secondAsset.assetId,
    });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({ id: secondAsset.assetId }, secondAsset);
    expect(dispose).toHaveBeenCalledWith({ id: A3_DEFAULT_AVATAR_ASSET.assetId });
    expect(coordinator.activeAssetId).toBe(secondAsset.assetId);
  });

  it('reports a pending load as cancelled and disposes its late resource', async () => {
    let completeLoad: ((resource: { id: string }) => void) | undefined;
    const dispose = vi.fn();
    const coordinator = new AvatarAssetLoadCoordinator({
      load: vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            completeLoad = resolve;
          }),
      ),
      dispose,
    });

    const pending = coordinator.select(secondAsset);
    coordinator.dispose();
    const lateResource = { id: secondAsset.assetId };
    completeLoad?.(lateResource);

    await expect(pending).resolves.toEqual({ status: 'cancelled', activeAssetId: '' });
    expect(dispose).toHaveBeenCalledWith(lateResource);
    expect(coordinator.activeAssetId).toBe('');
  });

  it('falls back once to the default asset and reports the active result', async () => {
    const load = vi.fn(async (selection: AvatarAssetSelection) => {
      if (selection.assetId === secondAsset.assetId) throw new Error('VRM parse failed');
      return { id: selection.assetId };
    });
    const coordinator = new AvatarAssetLoadCoordinator({ load, dispose: vi.fn() });

    await expect(coordinator.select(secondAsset)).resolves.toEqual({
      status: 'active',
      activeAssetId: A3_DEFAULT_AVATAR_ASSET.assetId,
      fallbackUsed: true,
    });
    expect(load).toHaveBeenCalledTimes(2);

    const defaultFailure = new AvatarAssetLoadCoordinator({
      load: vi.fn(async () => {
        throw new Error('default unavailable');
      }),
      dispose: vi.fn(),
    });
    await expect(defaultFailure.select(secondAsset)).rejects.toThrow('default unavailable');
  });

  it('disposes geometry, material textures, mixer state, and model listeners', () => {
    const geometry = new THREE.BufferGeometry();
    const texture = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(geometry, material));
    const mixer = new THREE.AnimationMixer(scene);
    const clip = new THREE.AnimationClip('idle', 1, []);
    const action = mixer.clipAction(clip);
    const listenerCleanup = vi.fn();
    const spies = {
      geometry: vi.spyOn(geometry, 'dispose'),
      material: vi.spyOn(material, 'dispose'),
      texture: vi.spyOn(texture, 'dispose'),
      stopAll: vi.spyOn(mixer, 'stopAllAction'),
      uncacheRoot: vi.spyOn(mixer, 'uncacheRoot'),
    };

    disposeAvatarModelResources({
      scene,
      mixer,
      actions: new Map([['idle', action]]),
      listenerCleanups: [listenerCleanup],
    });

    expect(spies.geometry).toHaveBeenCalledOnce();
    expect(spies.material).toHaveBeenCalledOnce();
    expect(spies.texture).toHaveBeenCalledOnce();
    expect(spies.stopAll).toHaveBeenCalledOnce();
    expect(spies.uncacheRoot).toHaveBeenCalledWith(scene);
    expect(listenerCleanup).toHaveBeenCalledOnce();
  });

  it('disposes nested shader textures, bone textures, shared resources, and the VRM once', () => {
    const sharedGeometry = new THREE.BufferGeometry();
    const skinnedGeometry = new THREE.BufferGeometry();
    const sharedTexture = new THREE.Texture();
    const nestedTexture = new THREE.Texture();
    const boneTexture = new THREE.DataTexture();
    const rendererSharedTexture = new THREE.Texture();
    const cyclicUniformValue: Record<string, unknown> = { nestedTexture };
    cyclicUniformValue.self = cyclicUniformValue;
    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        direct: { value: sharedTexture },
        nested: {
          value: [
            sharedTexture,
            { deeper: { value: nestedTexture } },
            cyclicUniformValue,
          ],
        },
      },
    });
    Object.assign(shaderMaterial, { map: sharedTexture });
    const standardMaterial = new THREE.MeshStandardMaterial({ map: sharedTexture });
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(sharedGeometry, shaderMaterial));
    scene.add(new THREE.Mesh(sharedGeometry, [shaderMaterial, standardMaterial]));
    const skinnedMesh = new THREE.SkinnedMesh(skinnedGeometry, shaderMaterial);
    skinnedMesh.skeleton = new THREE.Skeleton([]);
    skinnedMesh.skeleton.boneTexture = boneTexture;
    scene.add(skinnedMesh);
    const mixer = new THREE.AnimationMixer(scene);
    const listenerCleanup = vi.fn();
    const vrmDispose = vi.fn();
    const spies = {
      sharedGeometry: vi.spyOn(sharedGeometry, 'dispose'),
      skinnedGeometry: vi.spyOn(skinnedGeometry, 'dispose'),
      shaderMaterial: vi.spyOn(shaderMaterial, 'dispose'),
      standardMaterial: vi.spyOn(standardMaterial, 'dispose'),
      sharedTexture: vi.spyOn(sharedTexture, 'dispose'),
      nestedTexture: vi.spyOn(nestedTexture, 'dispose'),
      boneTexture: vi.spyOn(boneTexture, 'dispose'),
      rendererSharedTexture: vi.spyOn(rendererSharedTexture, 'dispose'),
      stopAll: vi.spyOn(mixer, 'stopAllAction'),
    };

    disposeAvatarModelResources({
      scene,
      mixer,
      listenerCleanups: [listenerCleanup],
      vrm: { dispose: vrmDispose },
    });

    expect(spies.sharedGeometry).toHaveBeenCalledOnce();
    expect(spies.skinnedGeometry).toHaveBeenCalledOnce();
    expect(spies.shaderMaterial).toHaveBeenCalledOnce();
    expect(spies.standardMaterial).toHaveBeenCalledOnce();
    expect(spies.sharedTexture).toHaveBeenCalledOnce();
    expect(spies.nestedTexture).toHaveBeenCalledOnce();
    expect(spies.boneTexture).toHaveBeenCalledOnce();
    expect(spies.rendererSharedTexture).not.toHaveBeenCalled();
    expect(vrmDispose).toHaveBeenCalledOnce();
    expect(listenerCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      vrmDispose.mock.invocationCallOrder[0],
    );
    expect(spies.stopAll.mock.invocationCallOrder[0]).toBeLessThan(
      vrmDispose.mock.invocationCallOrder[0],
    );
    expect(vrmDispose.mock.invocationCallOrder[0]).toBeLessThan(
      spies.sharedGeometry.mock.invocationCallOrder[0],
    );
  });

  it('keeps one fixed-size Canvas with an overlay while an asset is loading', () => {
    const html = renderToStaticMarkup(
      createElement(DigitalHumanThreeStage, {
        state: 'idle',
        audioLevel: 0,
        assistantSpeaking: false,
        avatarAsset: secondAsset,
      }),
    );

    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).toContain('data-testid="a3-avatar-loading-overlay"');
    expect(html).toContain('data-testid="a3-avatar-static-preview"');
    expect(html).toContain('src="/a3/assets/teacher-avatar/teacher-preview.webp"');
    expect(html).toContain('h-[420px]');
    expect(html).toContain('md:h-[500px]');
    expect(html).toContain('xl:h-[560px]');
  });

  it('ends the blocking loading state and keeps the static tutor when the VRM is slow', async () => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
      if (Number(timeout) >= 10_000) {
        queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return nativeSetTimeout(() => undefined, 0) as unknown as ReturnType<typeof globalThis.setTimeout>;
      }
      return nativeSetTimeout(handler, timeout, ...args) as unknown as ReturnType<typeof globalThis.setTimeout>;
    });

    const container = await mountStage(secondAsset);
    await act(async () => flushEffects());

    expect(container.querySelector('[data-testid="a3-avatar-loading-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="a3-avatar-static-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="a3-avatar-load-error"]')?.textContent).toContain(
      '已先显示静态导师',
    );
    timeoutSpy.mockRestore();
  });

  it('keeps the Canvas and renderer when the same asset id only changes persona behavior', async () => {
    const container = await mountStage(A3_DEFAULT_AVATAR_ASSET);
    const model = await resolveVrm(A3_DEFAULT_AVATAR_ASSET.publicPath);
    const canvas = container.querySelector('canvas');
    const renderer = clientRuntime.renderers[0];

    await renderStage({ ...A3_DEFAULT_AVATAR_ASSET }, 'listening');

    expect(vrmLoadCalls()).toEqual([A3_DEFAULT_AVATAR_ASSET.publicPath]);
    expect(container.querySelector('canvas')).toBe(canvas);
    expect(clientRuntime.renderers).toEqual([renderer]);
    expect(activeVrmModels()).toEqual([model]);
  });

  it('switches between valid and invalid paths with the same original asset id', async () => {
    const container = await mountStage(sameIdAlternateAsset);
    const alternate = await resolveVrm(sameIdAlternateAsset.publicPath);

    await renderStage({
      assetId: sameIdAlternateAsset.assetId,
      publicPath: 'https://example.com/untrusted.vrm',
    });
    await waitUntilPending(A3_DEFAULT_AVATAR_ASSET.publicPath);
    expect(alternate.spies.geometry).toHaveBeenCalledOnce();
    expect(stage(container).dataset.avatarAsset).toBe(A3_DEFAULT_AVATAR_ASSET.publicPath);
    const fallback = await resolveVrm(A3_DEFAULT_AVATAR_ASSET.publicPath);
    expect(stage(container).dataset.avatarActiveAssetId).toBe(A3_DEFAULT_AVATAR_ASSET.assetId);
    expect(stage(container).dataset.avatarFallbackUsed).toBe('true');
    expect(activeVrmModels()).toEqual([fallback]);

    await renderStage(sameIdAlternateAsset);
    await waitUntilPending(sameIdAlternateAsset.publicPath);
    expect(fallback.spies.geometry).toHaveBeenCalledOnce();
    const reloadedAlternate = await resolveVrm(sameIdAlternateAsset.publicPath);
    expect(stage(container).dataset.avatarAsset).toBe(sameIdAlternateAsset.publicPath);
    expect(stage(container).dataset.avatarActiveAssetId).toBe(sameIdAlternateAsset.assetId);
    expect(stage(container).dataset.avatarFallbackUsed).toBe('false');
    expect(activeVrmModels()).toEqual([reloadedAlternate]);
    expect(vrmLoadCalls()).toEqual([
      sameIdAlternateAsset.publicPath,
      A3_DEFAULT_AVATAR_ASSET.publicPath,
      sameIdAlternateAsset.publicPath,
    ]);
  });

  it('switches assets with one Canvas, one renderer, and at most one active VRM', async () => {
    const container = await mountStage(A3_DEFAULT_AVATAR_ASSET);
    const first = await resolveVrm(A3_DEFAULT_AVATAR_ASSET.publicPath);
    const canvas = container.querySelector('canvas');
    const renderer = clientRuntime.renderers[0];

    await renderStage(secondAsset);
    expect(activeVrmModels()).toHaveLength(0);
    expect(first.spies.geometry).toHaveBeenCalledOnce();
    expect(first.spies.material).toHaveBeenCalledOnce();
    expect(first.spies.texture).toHaveBeenCalledOnce();

    const second = await resolveVrm(secondAsset.publicPath);
    expect(container.querySelector('canvas')).toBe(canvas);
    expect(clientRuntime.renderers).toEqual([renderer]);
    expect(activeVrmModels()).toEqual([second]);
  });

  it('keeps the latest loading UI when an older request resolves first', async () => {
    const container = await mountStage(secondAsset);
    await renderStage(thirdAsset);

    const stale = await resolveVrm(secondAsset.publicPath);
    expect(stale.spies.geometry).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="a3-avatar-loading-overlay"]')).not.toBeNull();
    expect(stage(container).dataset.avatarActiveAssetId).toBe('');

    await resolveVrm(thirdAsset.publicPath);
    expect(stage(container).dataset.avatarActiveAssetId).toBe(thirdAsset.assetId);
    expect(stage(container).dataset.avatarRenderer).toBe('vrm');
  });

  it('ignores an old fallback failure after a newer asset becomes active', async () => {
    const container = await mountStage(secondAsset);
    await rejectVrm(secondAsset.publicPath, new Error('old requested asset failed'));
    await waitUntilPending(A3_DEFAULT_AVATAR_ASSET.publicPath);

    await renderStage(thirdAsset);
    const latest = await resolveVrm(thirdAsset.publicPath);
    await rejectVrm(A3_DEFAULT_AVATAR_ASSET.publicPath, new Error('old fallback failed'));

    expect(stage(container).dataset.avatarActiveAssetId).toBe(thirdAsset.assetId);
    expect(stage(container).dataset.avatarFallbackUsed).toBe('false');
    expect(stage(container).dataset.avatarRenderer).toBe('vrm');
    expect(container.querySelector('[data-testid="a3-avatar-load-error"]')).toBeNull();
    expect(activeVrmModels()).toEqual([latest]);
  });

  it('disposes the active and late models and renderer without updating after unmount', async () => {
    await mountStage(secondAsset);
    const active = await resolveVrm(secondAsset.publicPath);
    const renderer = clientRuntime.renderers[0];

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(active.spies.geometry).toHaveBeenCalledOnce();
    expect(active.spies.material).toHaveBeenCalledOnce();
    expect(active.spies.texture).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();

    await mountStage(thirdAsset);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    const late = await resolveVrm(thirdAsset.publicPath);
    expect(late.spies.geometry).toHaveBeenCalledOnce();
    expect(late.spies.material).toHaveBeenCalledOnce();
    expect(late.spies.texture).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

type FakeVrmModel = ReturnType<typeof createFakeVrmModel>;
const fakeModels: FakeVrmModel[] = [];

async function mountStage(asset: AvatarAssetSelection) {
  const container = document.querySelector('#root');
  if (!(container instanceof HTMLElement)) throw new Error('Missing test root');
  mountedRoot = createRoot(container);
  await renderStage(asset);
  await waitUntilPending(resolveControlledAvatarAssetSelection(asset).selection.publicPath);
  return container;
}

async function renderStage(asset: AvatarAssetSelection, state: 'idle' | 'listening' = 'idle') {
  await act(async () => {
    mountedRoot?.render(createElement(DigitalHumanThreeStage, {
      state,
      audioLevel: 0,
      assistantSpeaking: false,
      avatarAsset: asset,
    }));
    await flushEffects();
  });
}

async function resolveVrm(path: string) {
  const pending = await waitForPending(path);
  const model = createFakeVrmModel(path);
  fakeModels.push(model);
  await act(async () => {
    pending.resolve({ scene: model.scene, userData: { vrm: model.vrm } });
    await flushEffects();
  });
  return model;
}

async function rejectVrm(path: string, error: Error) {
  const pending = await waitForPending(path);
  await act(async () => {
    pending.reject(error);
    await flushEffects();
  });
}

async function waitForPending(path: string) {
  await waitUntilPending(path);
  const found = clientRuntime.pending.find((item) => item.path === path);
  if (!found) throw new Error(`Loader request disappeared: ${path}`);
  clientRuntime.pending.splice(clientRuntime.pending.indexOf(found), 1);
  return found;
}

async function waitUntilPending(path: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = clientRuntime.pending.find((item) => item.path === path);
    if (found) return;
    await act(async () => flushEffects());
  }
  throw new Error(
    `Loader request was not created: ${path}; calls=${clientRuntime.loaderCalls.join(',')}; renderers=${clientRuntime.renderers.length}; html=${document.body.innerHTML}`,
  );
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeVrmModel(path: string) {
  const geometry = new THREE.BufferGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const scene = new THREE.Group();
  scene.userData.avatarAssetPath = path;
  scene.add(new THREE.Mesh(geometry, material));
  const spies = {
    geometry: vi.spyOn(geometry, 'dispose'),
    material: vi.spyOn(material, 'dispose'),
    texture: vi.spyOn(texture, 'dispose'),
  };
  const vrm = {
    scene,
    humanoid: {
      resetNormalizedPose: vi.fn(),
      update: vi.fn(),
      getNormalizedBoneNode: vi.fn(() => null),
    },
    expressionManager: { setValue: vi.fn() },
    springBoneManager: null,
    lookAt: null,
    update: vi.fn(),
  };
  return { path, scene, vrm, spies };
}

function activeVrmModels() {
  return fakeModels.filter((model) => model.scene.parent !== null);
}

function vrmLoadCalls() {
  return clientRuntime.loaderCalls.filter((path) => /\.(?:vrm|glb)$/.test(path));
}

function stage(container: Element) {
  const element = container.querySelector('[data-testid="a3-digital-human-three-stage"]');
  if (!(element instanceof HTMLElement)) throw new Error('Stage is missing');
  return element;
}
