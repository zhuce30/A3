'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VRMAnimation } from '@pixiv/three-vrm-animation';
import type {
  A3DigitalHumanAvatarState,
  A3DigitalHumanSpeechCue,
} from '@/lib/a3/digital-human-types';
import { cn } from '@/lib/utils';
import {
  A3_DEFAULT_AVATAR_ASSET,
  AvatarAssetLoadCoordinator,
  advanceAvatarFrame,
  disposeAvatarModelResources,
  resolveTeacherActionTransition,
  resolveControlledAvatarAssetSelection,
  retainResourceUnlessDisposed,
  shouldStartAvatarAssetLoad,
  shouldRunAvatarAnimation,
  type AvatarAssetSelection,
  type AvatarLoadResult,
  type TeacherVrmActionKey,
} from './digital-human-runtime';

export const A3_DEFAULT_TEACHER_VRM_PATH = '/a3/assets/teacher-avatar/teacher.glb';
export const A3_TEACHER_STATIC_PREVIEW_PATH = '/a3/assets/teacher-avatar/teacher-preview.webp';
export const A3_AVATAR_SLOW_LOAD_MS = 12_000;
export const A3_DEFAULT_TEACHER_IDLE_VRMA_PATH = '/a3/assets/teacher-avatar/idle.vrma';
export const A3_DEFAULT_TEACHER_IDLE_VRMA_URL = `${A3_DEFAULT_TEACHER_IDLE_VRMA_PATH}?v=20260710-arms-down`;

export const A3_TEACHER_VRMA_ACTIONS = {
  wait: {
    label: '等待',
    path: '/a3/assets/teacher-avatar/wait.vrma',
    url: '/a3/assets/teacher-avatar/wait.vrma?v=20260710-actions',
  },
  explain: {
    label: '讲解',
    path: '/a3/assets/teacher-avatar/explain.vrma',
    url: '/a3/assets/teacher-avatar/explain.vrma?v=20260710-actions',
  },
  nod: {
    label: '点头',
    path: '/a3/assets/teacher-avatar/nod.vrma',
    url: '/a3/assets/teacher-avatar/nod.vrma?v=20260710-actions',
  },
  idle: {
    label: '自然站姿',
    path: A3_DEFAULT_TEACHER_IDLE_VRMA_PATH,
    url: A3_DEFAULT_TEACHER_IDLE_VRMA_URL,
  },
} as const;

export const A3_VRM_CAMERA_PROFILE = {
  framing: 'portrait_face_to_face',
  fov: 20,
  position: new THREE.Vector3(0, 1.55, 2.05),
  lookAt: new THREE.Vector3(0, 1.36, 0),
  modelPosition: new THREE.Vector3(0, -1.22, 0),
  modelScale: 1.72,
} as const;

export const A3_VRM_MOUTH_EXPRESSIONS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

export const A3_VRM_STATE_EXPRESSIONS: Record<A3DigitalHumanAvatarState, Record<string, number>> = {
  idle: { relaxed: 0.16 },
  connecting: { relaxed: 0.1 },
  listening: { relaxed: 0.22 },
  thinking: { relaxed: 0.18 },
  speaking: { happy: 0.12, relaxed: 0.1 },
  visual_focus: { surprised: 0.18 },
  degraded: { sad: 0.08, relaxed: 0.08 },
  error: { sad: 0.18 },
  ended: { relaxed: 0.2 },
};

type DigitalHumanThreeStageProps = {
  state: A3DigitalHumanAvatarState;
  audioLevel: number;
  assistantSpeaking: boolean;
  speechCues?: A3DigitalHumanSpeechCue[];
  renderSuspended?: boolean;
  avatarAsset?: AvatarAssetSelection;
};

type ActiveAvatarRenderer = 'vrm' | 'vrm_idle_animation' | 'primitive' | 'static_fallback';
type IdleAnimationState = 'pending' | 'loaded' | 'missing' | 'unavailable';
type TeacherActionState = 'pending' | 'loaded' | 'missing' | 'unavailable';

type PrimitiveAvatar = {
  root: THREE.Group;
  head: THREE.Mesh;
  mouth: THREE.Mesh;
  halo: THREE.Mesh;
};

type LoadedAvatarModel = {
  vrm: VRM;
  scene: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<TeacherVrmActionKey, THREE.AnimationAction>;
  listenerCleanups: Array<() => void>;
  disposed: boolean;
};

type AvatarSignal = {
  state: A3DigitalHumanAvatarState;
  audioLevel: number;
  assistantSpeaking: boolean;
  speechCues: A3DigitalHumanSpeechCue[];
};

type VrmMouthExpression = (typeof A3_VRM_MOUTH_EXPRESSIONS)[number];
type VrmBoneName = Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0];

type AvatarMotionProfile = {
  expressionState: A3DigitalHumanAvatarState;
  headNod: number;
  headYaw: number;
  headTilt: number;
  headPitch: number;
  lookYaw: number;
  lookPitch: number;
  blinkInterval: number;
  blinkDuration: number;
  primitiveYaw: number;
  primitiveBounce: number;
};

const A3_VRM_HEAD_BONE: VrmBoneName = 'head';
const A3_VRM_NECK_BONE: VrmBoneName = 'neck';

function clampAudioLevel(audioLevel: number) {
  return Math.max(0, Math.min(1, audioLevel));
}

function resolveAvatarMotionProfile(signal: AvatarSignal): AvatarMotionProfile {
  const effectiveState = signal.assistantSpeaking ? 'speaking' : signal.state;
  const profiles: Record<A3DigitalHumanAvatarState, AvatarMotionProfile> = {
    idle: {
      expressionState: 'idle',
      headNod: 0.012,
      headYaw: 0.026,
      headTilt: 0.01,
      headPitch: 0,
      lookYaw: 0,
      lookPitch: 0,
      blinkInterval: 3.9,
      blinkDuration: 0.11,
      primitiveYaw: 0.06,
      primitiveBounce: 0.014,
    },
    connecting: {
      expressionState: 'connecting',
      headNod: 0.01,
      headYaw: 0.018,
      headTilt: 0.006,
      headPitch: 0.01,
      lookYaw: 1.5,
      lookPitch: 0.6,
      blinkInterval: 3.4,
      blinkDuration: 0.1,
      primitiveYaw: 0.045,
      primitiveBounce: 0.012,
    },
    listening: {
      expressionState: 'listening',
      headNod: 0.018,
      headYaw: 0.018,
      headTilt: 0.006,
      headPitch: -0.006,
      lookYaw: -0.6,
      lookPitch: -0.4,
      blinkInterval: 3.2,
      blinkDuration: 0.1,
      primitiveYaw: 0.035,
      primitiveBounce: 0.012,
    },
    thinking: {
      expressionState: 'thinking',
      headNod: 0.008,
      headYaw: 0.012,
      headTilt: -0.026,
      headPitch: 0.028,
      lookYaw: -3.2,
      lookPitch: 2.4,
      blinkInterval: 4.8,
      blinkDuration: 0.13,
      primitiveYaw: 0.025,
      primitiveBounce: 0.008,
    },
    speaking: {
      expressionState: 'speaking',
      headNod: 0.032,
      headYaw: 0.026,
      headTilt: 0.012,
      headPitch: -0.004,
      lookYaw: 0.5,
      lookPitch: -0.8,
      blinkInterval: 3.6,
      blinkDuration: 0.1,
      primitiveYaw: 0.07,
      primitiveBounce: 0.02,
    },
    visual_focus: {
      expressionState: 'visual_focus',
      headNod: 0.01,
      headYaw: 0.018,
      headTilt: 0.018,
      headPitch: 0.02,
      lookYaw: 4.4,
      lookPitch: 2.8,
      blinkInterval: 3.8,
      blinkDuration: 0.1,
      primitiveYaw: 0.035,
      primitiveBounce: 0.01,
    },
    degraded: {
      expressionState: 'degraded',
      headNod: 0.006,
      headYaw: 0.01,
      headTilt: -0.012,
      headPitch: 0.012,
      lookYaw: 0,
      lookPitch: 1.2,
      blinkInterval: 4.3,
      blinkDuration: 0.12,
      primitiveYaw: 0.02,
      primitiveBounce: 0.006,
    },
    error: {
      expressionState: 'error',
      headNod: 0.004,
      headYaw: 0.006,
      headTilt: -0.018,
      headPitch: 0.018,
      lookYaw: 0,
      lookPitch: 1.8,
      blinkInterval: 4.6,
      blinkDuration: 0.12,
      primitiveYaw: 0.012,
      primitiveBounce: 0.004,
    },
    ended: {
      expressionState: 'ended',
      headNod: 0.008,
      headYaw: 0.012,
      headTilt: 0,
      headPitch: 0.012,
      lookYaw: 0,
      lookPitch: 0,
      blinkInterval: 4.1,
      blinkDuration: 0.11,
      primitiveYaw: 0.018,
      primitiveBounce: 0.006,
    },
  };

  return profiles[effectiveState];
}

function emptyVisemeWeights(): Record<VrmMouthExpression, number> {
  return {
    aa: 0,
    ih: 0,
    ou: 0,
    ee: 0,
    oh: 0,
  };
}

function normalizeSpeechCueViseme(cue: A3DigitalHumanSpeechCue): VrmMouthExpression | null {
  if (cue.viseme && A3_VRM_MOUTH_EXPRESSIONS.includes(cue.viseme)) return cue.viseme;
  const phoneme = cue.phoneme?.toLowerCase() || '';
  if (!phoneme) return null;
  if (/^(a|ah|ao|aw|ay)/.test(phoneme)) return 'aa';
  if (/^(i|ih|iy|y)/.test(phoneme)) return 'ih';
  if (/^(u|uw|uh|w)/.test(phoneme)) return 'ou';
  if (/^(e|eh|ey)/.test(phoneme)) return 'ee';
  if (/^(o|ow|oy)/.test(phoneme)) return 'oh';
  return null;
}

function resolveSpeechCueVisemeWeights(speechCues: A3DigitalHumanSpeechCue[], nowMs: number) {
  const visemeWeights = emptyVisemeWeights();
  const activeCues = speechCues.filter((cue) => cue.startsAtMs <= nowMs && cue.endsAtMs >= nowMs);
  if (!activeCues.length) return null;

  activeCues.forEach((cue) => {
    const cueProgress = Math.max(
      0,
      Math.min(1, (nowMs - cue.startsAtMs) / Math.max(1, cue.endsAtMs - cue.startsAtMs)),
    );
    const envelope = Math.sin(cueProgress * Math.PI);
    const energy = Math.max(0.14, Math.min(1, cue.energy ?? 0.35));
    if (cue.weights) {
      Object.entries(cue.weights).forEach(([name, weight]) => {
        if (A3_VRM_MOUTH_EXPRESSIONS.includes(name as VrmMouthExpression)) {
          const key = name as VrmMouthExpression;
          visemeWeights[key] = Math.max(visemeWeights[key], Math.min(1, (weight || 0) * envelope));
        }
      });
      return;
    }

    const viseme = normalizeSpeechCueViseme(cue);
    if (!viseme) return;
    visemeWeights[viseme] = Math.max(visemeWeights[viseme], Math.min(1, energy * envelope));
  });

  return visemeWeights;
}

function resolveVrmSpeechVisemes(
  signal: AvatarSignal,
  elapsedSeconds: number,
): Record<VrmMouthExpression, number> {
  const visemeWeights = emptyVisemeWeights();
  if (!signal.assistantSpeaking) return visemeWeights;

  const cueWeights =
    typeof performance !== 'undefined'
      ? resolveSpeechCueVisemeWeights(signal.speechCues, performance.now())
      : null;
  if (cueWeights) return cueWeights;

  const normalizedLevel = clampAudioLevel(signal.audioLevel);
  const envelope = Math.max(normalizedLevel, 0.16 + (Math.sin(elapsedSeconds * 18) + 1) * 0.06);
  const speechPhase = Math.floor(elapsedSeconds * 11) % A3_VRM_MOUTH_EXPRESSIONS.length;
  const primaryMouth = A3_VRM_MOUTH_EXPRESSIONS[speechPhase];
  const secondaryMouth =
    A3_VRM_MOUTH_EXPRESSIONS[(speechPhase + 1) % A3_VRM_MOUTH_EXPRESSIONS.length];
  const roundedMouth =
    A3_VRM_MOUTH_EXPRESSIONS[(speechPhase + 2) % A3_VRM_MOUTH_EXPRESSIONS.length];
  const consonantPulse = 0.5 + Math.sin(elapsedSeconds * 31) * 0.5;

  visemeWeights[primaryMouth] = Math.min(1, envelope);
  visemeWeights[secondaryMouth] = Math.min(0.5, envelope * (0.24 + consonantPulse * 0.2));
  visemeWeights[roundedMouth] = Math.min(0.3, envelope * (0.12 + (1 - consonantPulse) * 0.12));

  return visemeWeights;
}

function resolveBlinkWeight(profile: AvatarMotionProfile, elapsedSeconds: number) {
  const cyclePosition = elapsedSeconds % profile.blinkInterval;
  if (cyclePosition > profile.blinkDuration) return 0;
  const phase = cyclePosition / profile.blinkDuration;
  return Math.sin(phase * Math.PI);
}

function createPrimitiveAvatar(signal: AvatarSignal): PrimitiveAvatar {
  const root = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.78, 1.25, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x176b75, roughness: 0.62, metalness: 0.04 }),
  );
  body.position.y = -0.74;
  root.add(body);

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.25, 0.36, 24),
    new THREE.MeshStandardMaterial({ color: 0xd79a76, roughness: 0.58 }),
  );
  neck.position.y = 0.24;
  root.add(neck);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.78, 40, 28),
    new THREE.MeshStandardMaterial({ color: 0xe3ad89, roughness: 0.56 }),
  );
  head.scale.set(0.9, 1.06, 0.82);
  head.position.y = 0.97;
  root.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 40, 16, 0, Math.PI * 2, 0, Math.PI * 0.48),
    new THREE.MeshStandardMaterial({ color: 0x172033, roughness: 0.72 }),
  );
  hair.scale.set(0.94, 0.52, 0.86);
  hair.position.set(0, 1.32, 0.02);
  root.add(hair);

  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x102033, roughness: 0.35 });
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), eyeMaterial);
  leftEye.position.set(-0.25, 1.02, 0.66);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.25;
  root.add(leftEye, rightEye);

  const normalizedLevel = clampAudioLevel(signal.audioLevel);
  const mouthScale = signal.assistantSpeaking ? 1 + normalizedLevel : 0.35;
  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.06, 0.035),
    new THREE.MeshStandardMaterial({
      color: signal.assistantSpeaking ? 0xf06d7a : 0x7b2630,
      roughness: 0.5,
    }),
  );
  mouth.position.set(0, 0.76, 0.68);
  mouth.scale.y = mouthScale;
  root.add(mouth);

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(1.22, 0.012, 8, 80),
    new THREE.MeshBasicMaterial({
      color: resolveHaloColor(signal.state),
      transparent: true,
      opacity: 0.45,
    }),
  );
  halo.position.y = 0.42;
  halo.rotation.x = Math.PI / 2;
  root.add(halo);

  return { root, head, mouth, halo };
}

function resolveHaloColor(state: A3DigitalHumanAvatarState) {
  if (state === 'degraded') return 0xf6b73c;
  if (state === 'error') return 0xfb7185;
  return 0x5eead4;
}

function disposeObject(object: THREE.Object3D) {
  disposeAvatarModelResources({ scene: object });
}

function updatePrimitiveAvatar(
  avatar: PrimitiveAvatar,
  signal: AvatarSignal,
  elapsedSeconds: number,
) {
  const profile = resolveAvatarMotionProfile(signal);
  const normalizedLevel = clampAudioLevel(signal.audioLevel);
  avatar.root.rotation.y = Math.sin(elapsedSeconds * 0.9) * profile.primitiveYaw;
  avatar.head.position.y = 0.97 + Math.sin(elapsedSeconds * 1.7) * profile.primitiveBounce;
  avatar.head.rotation.z =
    profile.headTilt + Math.sin(elapsedSeconds * 0.7) * profile.headTilt * 0.4;
  avatar.head.rotation.x = profile.headPitch + Math.sin(elapsedSeconds * 1.1) * profile.headNod;
  avatar.mouth.scale.y = signal.assistantSpeaking
    ? 1 + Math.max(normalizedLevel, 0.18 + Math.sin(elapsedSeconds * 18) * 0.12)
    : 0.35;
  avatar.halo.rotation.z += 0.004;
  const haloMaterial = avatar.halo.material;
  if (haloMaterial instanceof THREE.MeshBasicMaterial) {
    haloMaterial.color.setHex(resolveHaloColor(signal.state));
  }
}

function applyVrmCameraProfile(camera: THREE.PerspectiveCamera) {
  camera.fov = A3_VRM_CAMERA_PROFILE.fov;
  camera.position.copy(A3_VRM_CAMERA_PROFILE.position);
  camera.lookAt(A3_VRM_CAMERA_PROFILE.lookAt);
  camera.updateProjectionMatrix();
}

function applyVrmExpressionSet(vrm: VRM, values: Record<string, number>) {
  Object.entries(values).forEach(([name, value]) => {
    vrm.expressionManager?.setValue(name, value);
  });
}

function applyVrmTeacherRestPose(vrm: VRM) {
  try {
    vrm.humanoid.resetNormalizedPose();
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
  } catch {
    vrm.humanoid.resetNormalizedPose();
  }
}

function warmUpVrmSpringBones(vrm: VRM) {
  try {
    vrm.springBoneManager?.reset();
    for (let index = 0; index < 30; index += 1) {
      vrm.update(1 / 60);
    }
  } catch {
    // Some exported VRM files omit spring-bone data; the avatar should still render.
  }
}

function disposeTeacherAction(mixer: THREE.AnimationMixer, action: THREE.AnimationAction) {
  action.stop();
  mixer.uncacheAction(action.getClip(), action.getRoot());
}

async function loadTeacherVrmAction(
  vrm: VRM,
  mixer: THREE.AnimationMixer,
  actionKey: TeacherVrmActionKey,
  isDisposed: () => boolean,
) {
  const [{ GLTFLoader }, { VRMAnimationLoaderPlugin, createVRMAnimationClip }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('@pixiv/three-vrm-animation'),
  ]);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const loadedGltf = await loader.loadAsync(A3_TEACHER_VRMA_ACTIONS[actionKey].url);
  const gltf = retainResourceUnlessDisposed(loadedGltf, isDisposed(), (lateGltf) =>
    disposeObject(lateGltf.scene),
  );
  if (!gltf) return null;
  const vrmAnimation = (gltf.userData as { vrmAnimations?: VRMAnimation[] }).vrmAnimations?.[0];
  if (!vrmAnimation) return null;

  const clip = createVRMAnimationClip(vrmAnimation, vrm);
  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
  action.enabled = true;
  action.setEffectiveWeight(0);
  return retainResourceUnlessDisposed(action, isDisposed(), (lateAction) =>
    disposeTeacherAction(mixer, lateAction),
  );
}

function resolveTeacherVrmActionKey(signal: AvatarSignal): TeacherVrmActionKey {
  if (signal.assistantSpeaking || signal.state === 'speaking') return 'explain';
  if (signal.state === 'listening' || signal.state === 'ended') return 'nod';
  return 'wait';
}

function crossFadeTeacherAction(
  actions: Map<TeacherVrmActionKey, THREE.AnimationAction>,
  activeActionKey: TeacherVrmActionKey | null,
  nextActionKey: TeacherVrmActionKey,
) {
  const decision = resolveTeacherActionTransition(
    nextActionKey,
    new Set(actions.keys()),
    activeActionKey,
  );
  if (!decision.actualActionKey || !decision.shouldTransition) return decision.actualActionKey;

  const nextAction = actions.get(decision.actualActionKey);
  if (!nextAction) return activeActionKey;
  const previousAction = activeActionKey ? actions.get(activeActionKey) : null;
  nextAction.reset();
  nextAction.setEffectiveWeight(1);
  nextAction.fadeIn(0.22);
  nextAction.play();
  if (previousAction && previousAction !== nextAction)
    previousAction.crossFadeTo(nextAction, 0.22, false);
  return decision.actualActionKey;
}

function resetVrmSpeechAndStateExpressions(vrm: VRM) {
  [...A3_VRM_MOUTH_EXPRESSIONS, 'happy', 'relaxed', 'surprised', 'sad', 'blink'].forEach((name) => {
    vrm.expressionManager?.setValue(name, 0);
  });
}

function applyVrmHeadMotion(
  vrm: VRM,
  signal: AvatarSignal,
  elapsedSeconds: number,
  audioLevel: number,
) {
  const profile = resolveAvatarMotionProfile(signal);
  const normalizedLevel = clampAudioLevel(audioLevel);
  const speakingNod = signal.assistantSpeaking ? normalizedLevel * 0.018 : 0;
  const head = vrm.humanoid.getNormalizedBoneNode(A3_VRM_HEAD_BONE);
  const neck = vrm.humanoid.getNormalizedBoneNode(A3_VRM_NECK_BONE);
  const headPitch =
    profile.headPitch + Math.sin(elapsedSeconds * 2.1) * profile.headNod + speakingNod;
  const headYaw = Math.sin(elapsedSeconds * 0.74) * profile.headYaw;
  const headTilt = profile.headTilt + Math.sin(elapsedSeconds * 0.58) * profile.headTilt * 0.35;

  if (neck) {
    neck.rotation.x = headPitch * 0.36;
    neck.rotation.y = headYaw * 0.28;
    neck.rotation.z = headTilt * 0.24;
  }

  if (head) {
    head.rotation.x = headPitch;
    head.rotation.y = headYaw;
    head.rotation.z = headTilt;
  }
}

function applyVrmLookAtMicroMotion(vrm: VRM, signal: AvatarSignal, elapsedSeconds: number) {
  const profile = resolveAvatarMotionProfile(signal);
  if (!vrm.lookAt) return;

  vrm.lookAt.autoUpdate = false;
  vrm.lookAt.yaw = profile.lookYaw + Math.sin(elapsedSeconds * 0.62) * 0.8;
  vrm.lookAt.pitch = profile.lookPitch + Math.sin(elapsedSeconds * 0.84) * 0.5;
}

function updateVrmAvatar(vrm: VRM, signal: AvatarSignal, elapsedSeconds: number) {
  const profile = resolveAvatarMotionProfile(signal);
  const visemeWeights = resolveVrmSpeechVisemes(signal, elapsedSeconds);

  resetVrmSpeechAndStateExpressions(vrm);
  applyVrmExpressionSet(vrm, visemeWeights);
  applyVrmExpressionSet(vrm, A3_VRM_STATE_EXPRESSIONS[profile.expressionState]);
  vrm.expressionManager?.setValue('blink', resolveBlinkWeight(profile, elapsedSeconds));
  applyVrmHeadMotion(vrm, signal, elapsedSeconds, signal.audioLevel);
  applyVrmLookAtMicroMotion(vrm, signal, elapsedSeconds);
  vrm.scene.rotation.y = Math.sin(elapsedSeconds * 0.45) * profile.primitiveYaw * 0.5;
}

export function DigitalHumanThreeStage({
  state,
  audioLevel,
  assistantSpeaking,
  speechCues = [],
  renderSuspended = false,
  avatarAsset = A3_DEFAULT_AVATAR_ASSET,
}: DigitalHumanThreeStageProps) {
  const controlledAvatarAsset = resolveControlledAvatarAssetSelection(avatarAsset);
  const canonicalAvatarAsset = controlledAvatarAsset.selection;
  const canonicalAvatarAssetId = canonicalAvatarAsset.assetId;
  const canonicalAvatarAssetPath = canonicalAvatarAsset.publicPath;
  const canonicalAvatarFallbackUsed = controlledAvatarAsset.fallbackUsed;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const signalRef = useRef<AvatarSignal>({ state, audioLevel, assistantSpeaking, speechCues });
  const avatarAssetRef = useRef<AvatarAssetSelection>(canonicalAvatarAsset);
  const avatarAssetFallbackUsedRef = useRef(canonicalAvatarFallbackUsed);
  const requestAvatarAssetRef = useRef<
    (selection: AvatarAssetSelection, fallbackUsed: boolean) => void
  >(() => undefined);
  const avatarRequestVersionRef = useRef(0);
  const renderSuspendedRef = useRef(renderSuspended);
  const syncAnimationRef = useRef<() => void>(() => undefined);
  const [activeRenderer, setActiveRenderer] = useState<ActiveAvatarRenderer>('primitive');
  const [idleAnimationState, setIdleAnimationState] = useState<IdleAnimationState>('pending');
  const [activeAction, setActiveAction] = useState<TeacherVrmActionKey>('idle');
  const [activeActionState, setActiveActionState] = useState<TeacherActionState>('pending');
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const [avatarLoading, setAvatarLoading] = useState(true);
  const [avatarLoadError, setAvatarLoadError] = useState('');
  const [avatarLoadResult, setAvatarLoadResult] = useState<Pick<Extract<AvatarLoadResult, { status: 'active' }>, 'activeAssetId' | 'fallbackUsed'>>({
    activeAssetId: '',
    fallbackUsed: false,
  });
  const normalizedLevel = clampAudioLevel(audioLevel);
  const mouthScale = assistantSpeaking ? 1 + normalizedLevel : 0.35;

  useEffect(() => {
    signalRef.current = { state, audioLevel, assistantSpeaking, speechCues };
  }, [assistantSpeaking, audioLevel, speechCues, state]);

  useEffect(() => {
    renderSuspendedRef.current = renderSuspended;
    syncAnimationRef.current();
  }, [renderSuspended]);

  useEffect(() => {
    avatarAssetRef.current = {
      assetId: canonicalAvatarAssetId,
      publicPath: canonicalAvatarAssetPath,
    };
    avatarAssetFallbackUsedRef.current = canonicalAvatarFallbackUsed;
  }, [canonicalAvatarAssetId, canonicalAvatarAssetPath, canonicalAvatarFallbackUsed]);

  useEffect(() => {
    requestAvatarAssetRef.current(
      avatarAssetRef.current,
      avatarAssetFallbackUsedRef.current,
    );
  }, [canonicalAvatarAssetId, canonicalAvatarAssetPath, canonicalAvatarFallbackUsed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let raf = 0;
    let activeVrm: VRM | null = null;
    let activeMixer: THREE.AnimationMixer | null = null;
    let activeTeacherActionKey: TeacherVrmActionKey | null = null;
    let avatarLoadStarted = false;
    let avatarSlowTimer: number | null = null;
    let teacherActions = new Map<TeacherVrmActionKey, THREE.AnimationAction>();
    setIdleAnimationState('pending');
    setActiveActionState('pending');

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      setActiveRenderer('static_fallback');
      setIdleAnimationState('unavailable');
      setActiveActionState('unavailable');
      setWebglUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(canvas.clientWidth || 360, canvas.clientHeight || 280, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(A3_VRM_CAMERA_PROFILE.fov, 1, 0.1, 100);
    applyVrmCameraProfile(camera);

    const keyLight = new THREE.DirectionalLight(0xe6fff8, 2.6);
    keyLight.position.set(2.6, 4, 3);
    scene.add(keyLight);
    scene.add(new THREE.AmbientLight(0x8bb8c8, 1.2));

    const primitiveAvatar = createPrimitiveAvatar(signalRef.current);
    scene.add(primitiveAvatar.root);

    async function loadVrmModel(selection: AvatarAssetSelection): Promise<LoadedAvatarModel> {
      const [{ GLTFLoader }, { VRMLoaderPlugin, VRMUtils }] = await Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('@pixiv/three-vrm'),
      ]);
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(selection.publicPath);
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) {
        disposeObject(gltf.scene);
        throw new Error('VRM model data is missing');
      }
      VRMUtils.rotateVRM0(vrm);
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      applyVrmTeacherRestPose(vrm);
      warmUpVrmSpringBones(vrm);
      vrm.scene.position.copy(A3_VRM_CAMERA_PROFILE.modelPosition);
      vrm.scene.scale.setScalar(A3_VRM_CAMERA_PROFILE.modelScale);
      return {
        vrm,
        scene: vrm.scene,
        mixer: new THREE.AnimationMixer(vrm.scene),
        actions: new Map<TeacherVrmActionKey, THREE.AnimationAction>(),
        listenerCleanups: [],
        disposed: false,
      };
    }

    function disposeVrmModel(model: LoadedAvatarModel) {
      model.disposed = true;
      if (activeVrm === model.vrm) {
        activeVrm = null;
        activeMixer = null;
        activeTeacherActionKey = null;
        teacherActions = new Map();
        if (!primitiveAvatar.root.parent) scene.add(primitiveAvatar.root);
        if (!disposed) setActiveRenderer('primitive');
      }
      disposeAvatarModelResources(model);
    }

    function loadTeacherActions(model: LoadedAvatarModel) {
      const isDisposed = () => disposed || model.disposed || activeVrm !== model.vrm;
      void loadTeacherVrmAction(model.vrm, model.mixer, 'idle', isDisposed)
        .then((idleAction) => {
          if (!idleAction || isDisposed()) return;
          model.actions.set('idle', idleAction);
          activeTeacherActionKey = crossFadeTeacherAction(
            model.actions,
            activeTeacherActionKey,
            'idle',
          );
          setActiveAction('idle');
          setActiveActionState('loaded');
          setIdleAnimationState('loaded');
          setActiveRenderer('vrm_idle_animation');
        })
        .catch(() => {
          if (!isDisposed()) {
            setActiveActionState('missing');
            setIdleAnimationState('missing');
          }
        });
      void Promise.all(
        (['wait', 'explain', 'nod'] as TeacherVrmActionKey[]).map(async (actionKey) => {
          const action = await loadTeacherVrmAction(
            model.vrm,
            model.mixer,
            actionKey,
            isDisposed,
          ).catch(() => null);
          if (action && !isDisposed()) model.actions.set(actionKey, action);
        }),
      );
    }

    const assetCoordinator = new AvatarAssetLoadCoordinator<LoadedAvatarModel>({
      load: loadVrmModel,
      dispose: disposeVrmModel,
      activate: (model) => {
        primitiveAvatar.root.removeFromParent();
        scene.add(model.scene);
        activeVrm = model.vrm;
        activeMixer = model.mixer;
        activeTeacherActionKey = null;
        teacherActions = model.actions;
        setActiveRenderer('vrm');
        loadTeacherActions(model);
      },
    });

    const clearAvatarSlowTimer = () => {
      if (avatarSlowTimer !== null) window.clearTimeout(avatarSlowTimer);
      avatarSlowTimer = null;
    };

    async function selectAvatarAsset(
      selection: AvatarAssetSelection,
      selectionFallbackUsed: boolean,
    ) {
      if (assetCoordinator.isActiveSelection(selection)) {
        setAvatarLoadResult({ activeAssetId: selection.assetId, fallbackUsed: selectionFallbackUsed });
        setAvatarLoadError(
          selectionFallbackUsed ? '导师形象加载失败，已切换为默认形象' : '',
        );
        return;
      }
      const requestVersion = avatarRequestVersionRef.current + 1;
      avatarRequestVersionRef.current = requestVersion;
      setAvatarLoading(true);
      setAvatarLoadError('');
      setIdleAnimationState('pending');
      setActiveActionState('pending');
      clearAvatarSlowTimer();
      avatarSlowTimer = window.setTimeout(() => {
        if (
          disposed ||
          requestVersion !== avatarRequestVersionRef.current ||
          assetCoordinator.isActiveSelection(selection)
        ) return;
        setAvatarLoading(false);
        setAvatarLoadError('3D 导师加载较慢，已先显示静态导师，加载完成后会自动切换');
      }, A3_AVATAR_SLOW_LOAD_MS);
      try {
        const result = await assetCoordinator.select(selection);
        if (
          disposed ||
          requestVersion !== avatarRequestVersionRef.current ||
          result.status !== 'active'
        ) return;
        clearAvatarSlowTimer();
        setAvatarLoadResult({
          activeAssetId: result.activeAssetId,
          fallbackUsed: selectionFallbackUsed || result.fallbackUsed,
        });
        setAvatarLoading(false);
        if (selectionFallbackUsed || result.fallbackUsed) {
          setAvatarLoadError('导师形象加载失败，已切换为默认形象');
        } else {
          setAvatarLoadError('');
        }
      } catch {
        if (disposed || requestVersion !== avatarRequestVersionRef.current) return;
        clearAvatarSlowTimer();
        setAvatarLoadResult({ activeAssetId: '', fallbackUsed: true });
        setAvatarLoading(false);
        setAvatarLoadError('导师形象暂时无法加载');
        setActiveRenderer('primitive');
        setIdleAnimationState('unavailable');
        setActiveActionState('unavailable');
      }
    }

    const resize = () => {
      const width = canvas.clientWidth || 360;
      const height = canvas.clientHeight || 280;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const timer = new THREE.Timer();
    timer.connect(document);
    let elapsedSeconds = 0;
    let intersecting = typeof IntersectionObserver === 'undefined';
    let documentVisible = document.visibilityState === 'visible';

    const canAnimate = () => !renderSuspendedRef.current && shouldRunAvatarAnimation({ disposed, documentVisible, intersecting });
    const stopAnimation = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };
    const animate = (timestamp: number) => {
      raf = 0;
      if (!canAnimate()) return;
      timer.update(timestamp);
      const timing = advanceAvatarFrame(elapsedSeconds, timer.getDelta());
      elapsedSeconds = timing.elapsedSeconds;
      const delta = timing.deltaSeconds;
      const signal = signalRef.current;
      if (activeVrm) {
        const nextTeacherAction = resolveTeacherVrmActionKey(signal);
        const resolvedTeacherAction = crossFadeTeacherAction(
          teacherActions,
          activeTeacherActionKey,
          nextTeacherAction,
        );
        if (resolvedTeacherAction !== activeTeacherActionKey) {
          activeTeacherActionKey = resolvedTeacherAction;
          setActiveAction(resolvedTeacherAction || 'wait');
          setActiveActionState(teacherActions.has(nextTeacherAction) ? 'loaded' : 'missing');
        }
        activeMixer?.update(delta);
        updateVrmAvatar(activeVrm, signal, elapsedSeconds);
        activeVrm.update(delta);
      } else {
        updatePrimitiveAvatar(primitiveAvatar, signal, elapsedSeconds);
      }
      renderer.render(scene, camera);
      if (canAnimate()) raf = window.requestAnimationFrame(animate);
    };
    const syncAnimation = () => {
      if (!canAnimate()) {
        stopAnimation();
        return;
      }
      if (
        shouldStartAvatarAssetLoad({
          disposed,
          documentVisible,
          intersecting,
          loadStarted: avatarLoadStarted,
        })
      ) {
        avatarLoadStarted = true;
        void selectAvatarAsset(
          avatarAssetRef.current,
          avatarAssetFallbackUsedRef.current,
        );
      }
      if (!raf) {
        timer.reset();
        raf = window.requestAnimationFrame(animate);
      }
    };
    syncAnimationRef.current = syncAnimation;
    requestAvatarAssetRef.current = (selection, fallbackUsed) => {
      avatarAssetRef.current = selection;
      avatarAssetFallbackUsedRef.current = fallbackUsed;
      avatarLoadStarted = false;
      syncAnimation();
    };
    const handleVisibilityChange = () => {
      documentVisible = document.visibilityState === 'visible';
      syncAnimation();
    };
    const intersectionObserver =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              intersecting = entries.at(-1)?.isIntersecting ?? false;
              syncAnimation();
            },
            { rootMargin: '200px' },
          );
    intersectionObserver?.observe(canvas);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('resize', resize);
    syncAnimation();

    return () => {
      disposed = true;
      avatarRequestVersionRef.current += 1;
      syncAnimationRef.current = () => undefined;
      requestAvatarAssetRef.current = () => undefined;
      stopAnimation();
      clearAvatarSlowTimer();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('resize', resize);
      timer.dispose();
      assetCoordinator.dispose();
      disposeObject(primitiveAvatar.root);
      renderer.dispose();
    };
  }, []);

  return (
    <div
      data-testid="a3-digital-human-three-stage"
      data-avatar-renderer={activeRenderer}
      data-avatar-asset={canonicalAvatarAssetPath}
      data-avatar-active-asset-id={avatarLoadResult.activeAssetId}
      data-avatar-fallback-used={avatarLoadResult.fallbackUsed}
      data-avatar-idle-animation={A3_DEFAULT_TEACHER_IDLE_VRMA_PATH}
      data-avatar-idle-animation-state={idleAnimationState}
      data-avatar-action={activeAction}
      data-avatar-action-state={activeActionState}
      className="relative z-10 h-[420px] w-full max-w-[820px] overflow-hidden bg-transparent md:h-[500px] xl:h-[560px]"
    >
      {webglUnavailable ? (
        <div
          data-testid="a3-digital-human-static-fallback"
          role="img"
          aria-label="静态数字助教"
          className="flex h-full w-full flex-col items-center justify-center px-6 text-white"
        >
          <div className="flex size-32 items-center justify-center rounded-full border border-white/35 bg-slate-950/35 text-4xl font-semibold shadow-[0_20px_70px_rgba(15,23,42,0.3)] backdrop-blur-xl">
            智
          </div>
          <p className="mt-4 rounded-full border border-white/20 bg-slate-950/40 px-4 py-2 text-xs backdrop-blur-lg">
            当前设备暂以静态教师形象显示
          </p>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          data-testid="a3-digital-human-three-canvas"
          className="mx-auto block h-full w-full md:w-[46%] md:min-w-[360px] md:max-w-[460px]"
          aria-label="3D 数字助教"
        />
      )}
      {!webglUnavailable && (avatarLoading || activeRenderer === 'primitive') ? (
        <div
          data-testid="a3-avatar-static-preview"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8 pb-10 pt-12"
        >
          <Image
            src={A3_TEACHER_STATIC_PREVIEW_PATH}
            alt="静态导师形象"
            width={512}
            height={512}
            unoptimized
            className="h-auto w-[min(72%,360px)] drop-shadow-[0_24px_55px_rgba(15,23,42,0.28)]"
          />
        </div>
      ) : null}
      {avatarLoading && !webglUnavailable ? (
        <div
          data-testid="a3-avatar-loading-overlay"
          role="status"
          aria-label="导师形象加载中"
          className="pointer-events-none absolute inset-0 z-20 flex items-end justify-center pb-16"
        >
          <span className="rounded-full border border-white/20 bg-slate-950/55 px-3 py-1.5 text-xs text-white backdrop-blur-lg">
            导师形象加载中
          </span>
        </div>
      ) : null}
      {avatarLoadError ? (
        <div
          data-testid="a3-avatar-load-error"
          role="alert"
          className="pointer-events-none absolute inset-x-4 bottom-4 z-20 rounded-lg border border-amber-200/40 bg-amber-950/70 px-3 py-2 text-xs text-amber-50 backdrop-blur-lg"
        >
          {avatarLoadError}
        </div>
      ) : null}
      <div className="pointer-events-none absolute left-4 top-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/55 px-3 py-1.5 text-xs text-slate-200 shadow-lg shadow-slate-950/20">
        <span
          className={cn(
            'size-2 rounded-full',
            assistantSpeaking
              ? 'bg-emerald-400'
              : state === 'degraded'
                ? 'bg-amber-400'
                : 'bg-slate-500',
          )}
        />
        <span>
          {activeRenderer === 'vrm_idle_animation'
            ? 'VRM 自然站姿'
            : activeRenderer === 'vrm'
              ? 'VRM 教师形象'
              : assistantSpeaking
                ? '讲解中'
                : state === 'listening'
                  ? '正在听'
                  : '待命'}
        </span>
      </div>
      <div
        aria-hidden="true"
        data-testid="a3-digital-human-mouth"
        className="sr-only"
        style={{ transform: `scaleY(${mouthScale})` }}
      />
    </div>
  );
}
