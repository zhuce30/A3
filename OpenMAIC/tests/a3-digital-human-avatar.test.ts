import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DigitalHumanAvatar } from '@/components/a3/features/coaching/digital-human-avatar';
import { DigitalHumanThreeStage } from '@/components/a3/features/coaching/digital-human-three-stage';
import {
  A3_DIGITAL_HUMAN_AVATAR_MODES,
  A3_DIGITAL_HUMAN_AVATAR_STATES,
} from '@/lib/a3/digital-human-types';

describe('A3 digital human avatar types', () => {
  it('defines stable avatar states and modes', () => {
    expect(A3_DIGITAL_HUMAN_AVATAR_STATES).toContain('speaking');
    expect(A3_DIGITAL_HUMAN_AVATAR_MODES).toContain('local_3d');
    expect(A3_DIGITAL_HUMAN_AVATAR_MODES).toContain('local_vrm');
  });
});

describe('DigitalHumanAvatar', () => {
  it('renders a digital human instead of a static AI label', () => {
    const html = renderToStaticMarkup(
      createElement(DigitalHumanAvatar, {
        state: 'idle',
        mode: 'local_3d',
        audioLevel: 0,
        assistantSpeaking: false,
        providerLabel: 'dashscope_qwen_omni_realtime',
        modelLabel: 'qwen3.5-omni-plus-realtime',
      }),
    );

    expect(html).toContain('data-testid="a3-digital-human-avatar"');
    expect(html).toContain('数字助教');
    expect(html).not.toContain('>AI<');
  });

  it('marks the avatar as speaking when assistant audio is active', () => {
    const avatarHtml = renderToStaticMarkup(
      createElement(DigitalHumanAvatar, {
        state: 'speaking',
        mode: 'local_3d',
        audioLevel: 0.72,
        assistantSpeaking: true,
        providerLabel: 'openai_realtime_webrtc',
        modelLabel: 'gpt-realtime-2',
      }),
    );
    const stageHtml = renderToStaticMarkup(
      createElement(DigitalHumanThreeStage, {
        state: 'speaking',
        audioLevel: 0.72,
        assistantSpeaking: true,
      }),
    );

    expect(avatarHtml).toContain('data-state="speaking"');
    expect(stageHtml).toContain('data-testid="a3-digital-human-mouth"');
    expect(stageHtml).toContain('scaleY(1.72)');
  });

  it('keeps the listening avatar silent when stale speech cues remain', () => {
    const avatarHtml = renderToStaticMarkup(
      createElement(DigitalHumanAvatar, {
        state: 'listening',
        mode: 'local_vrm',
        audioLevel: 0.8,
        assistantSpeaking: false,
        providerLabel: 'openai_realtime_webrtc',
        modelLabel: 'gpt-realtime-2',
        speechCues: [
          {
            id: 'stale-cue',
            source: 'tts_viseme',
            startsAtMs: 0,
            endsAtMs: 1_000,
            viseme: 'aa',
            energy: 1,
          },
        ],
      }),
    );
    const stageHtml = renderToStaticMarkup(
      createElement(DigitalHumanThreeStage, {
        state: 'listening',
        audioLevel: 0.8,
        assistantSpeaking: false,
        speechCues: [
          {
            id: 'stale-cue',
            source: 'tts_viseme',
            startsAtMs: 0,
            endsAtMs: 1_000,
            viseme: 'aa',
            energy: 1,
          },
        ],
      }),
    );
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );
    const resolverSource = stageSource.slice(
      stageSource.indexOf('function resolveVrmSpeechVisemes'),
      stageSource.indexOf('function resolveBlinkWeight'),
    );

    expect(avatarHtml).toContain('data-state="listening"');
    expect(stageHtml).toContain('scaleY(0.35)');
    expect(
      resolverSource.indexOf('if (!signal.assistantSpeaking) return visemeWeights;'),
    ).toBeLessThan(resolverSource.indexOf('resolveSpeechCueVisemeWeights'));
  });

  it('renders a Three.js stage for the local 3D avatar route', () => {
    const html = renderToStaticMarkup(
      createElement(DigitalHumanThreeStage, {
        state: 'listening',
        audioLevel: 0.24,
        assistantSpeaking: false,
      }),
    );

    expect(html).toContain('data-testid="a3-digital-human-three-stage"');
    expect(html).toContain('data-avatar-renderer="primitive"');
    expect(html).toContain('data-avatar-asset="/a3/assets/teacher-avatar/teacher.vrm"');
  });

  it('declares Three.js as the browser 3D avatar renderer dependency', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toHaveProperty('three');
  });

  it('declares the VRM runtime and default teacher avatar asset path', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );

    expect(packageJson.dependencies).toHaveProperty('@pixiv/three-vrm');
    expect(packageJson.dependencies).toHaveProperty('@pixiv/three-vrm-animation');
    expect(stageSource).toContain('A3_DEFAULT_TEACHER_VRM_PATH');
    expect(stageSource).toContain('/a3/assets/teacher-avatar/teacher.vrm');
    expect(stageSource).toContain('VRMLoaderPlugin');
    expect(stageSource).toContain('data-avatar-renderer={activeRenderer}');
  });

  it('loads a VRMA idle animation instead of hard-coding teacher arm bones', () => {
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );

    expect(stageSource).toContain('A3_DEFAULT_TEACHER_IDLE_VRMA_PATH');
    expect(stageSource).toContain('A3_DEFAULT_TEACHER_IDLE_VRMA_URL');
    expect(stageSource).toContain('/a3/assets/teacher-avatar/idle.vrma');
    expect(stageSource).toContain('20260710-arms-down');
    expect(stageSource).toContain('VRMAnimationLoaderPlugin');
    expect(stageSource).toContain('createVRMAnimationClip');
    expect(stageSource).toContain('new THREE.AnimationMixer(vrm.scene)');
    expect(stageSource).toContain('data-avatar-idle-animation=');
    expect(stageSource).toContain('data-avatar-idle-animation-state=');
    expect(stageSource).not.toContain("'leftUpperArm'");
    expect(stageSource).not.toContain("'rightUpperArm'");
    expect(stageSource).not.toContain("'leftLowerArm'");
    expect(stageSource).not.toContain("'rightLowerArm'");
  });

  it('keeps the generated idle VRMA asset and its reproducible source documented', () => {
    const idlePath = path.resolve(process.cwd(), 'public/a3/assets/teacher-avatar/idle.vrma');
    const generatorPath = path.resolve(process.cwd(), 'scripts/generate-a3-idle-vrma.mjs');
    const readmePath = path.resolve(process.cwd(), 'public/a3/assets/teacher-avatar/README.md');
    const idleBuffer = fs.readFileSync(idlePath);
    const generatorSource = fs.readFileSync(generatorPath, 'utf8');
    const readme = fs.readFileSync(readmePath, 'utf8');

    expect(idleBuffer.subarray(0, 4).toString('utf8')).toBe('glTF');
    expect(idleBuffer.readUInt32LE(4)).toBe(2);
    expect(generatorSource).toContain('VRMC_vrm_animation');
    expect(generatorSource).toContain('A3TeacherNaturalIdle');
    expect(readme).toContain('Idle animation creator/source: A3 project team');
    expect(readme).toContain('generate-a3-idle-vrma.mjs');
  });

  it('publishes a sanitized project-scoped teacher VRM without personal metadata', () => {
    const avatarDirectory = path.resolve(process.cwd(), 'public/a3/assets/teacher-avatar');
    const teacherPath = path.join(avatarDirectory, 'teacher.vrm');
    const teacherBuffer = fs.readFileSync(teacherPath);
    const teacherJson = readGlbJson(teacherPath);
    const meta = teacherJson.extensions?.VRMC_vrm?.meta as Record<string, unknown>;
    const model = teacherJson as typeof teacherJson & {
      buffers: Array<{ byteLength: number }>;
      bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
      images: Array<{ bufferView?: number }>;
      textures: Array<{ source?: number; sampler?: number }>;
      samplers: unknown[];
    };

    expect(teacherBuffer.readUInt32LE(8)).toBe(teacherBuffer.length);
    expect(readGlbChunkLengths(teacherBuffer).every((length) => length % 4 === 0)).toBe(true);
    expect(meta.authors).toEqual(['A3 project team']);
    expect(meta).not.toHaveProperty('contactInformation');
    expect(meta).not.toHaveProperty('thumbnailImage');
    expect(meta.avatarPermission).toBe('onlySeparatelyLicensedPerson');
    expect(meta.allowRedistribution).toBe(false);
    expect(meta.commercialUsage).toBe('personalNonProfit');
    expect(meta.modification).toBe('prohibited');
    expect(fs.statSync(teacherPath).size).toBeLessThan(17_000_000);
    expect(
      model.images.every(
        (image) => image.bufferView === undefined || image.bufferView < model.bufferViews.length,
      ),
    ).toBe(true);
    expect(
      model.textures.every(
        (texture) =>
          (texture.source === undefined || texture.source < model.images.length) &&
          (texture.sampler === undefined || texture.sampler < model.samplers.length),
      ),
    ).toBe(true);
    expect(
      model.bufferViews.every(
        (view) => (view.byteOffset || 0) + view.byteLength <= model.buffers[0].byteLength,
      ),
    ).toBe(true);

    for (const entry of fs.readdirSync(avatarDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(avatarDirectory, entry.name);
      const searchable = /\.vrma?$/.test(entry.name)
        ? JSON.stringify(readGlbJson(filePath))
        : fs.readFileSync(filePath, 'utf8');
      expect(searchable).not.toMatch(/1[3-9]\d{9}/);
    }
  });

  it('reproduces the sanitized teacher VRM byte for byte', () => {
    const teacherPath = path.resolve(process.cwd(), 'public/a3/assets/teacher-avatar/teacher.vrm');
    const sanitizerPath = path.resolve(process.cwd(), 'scripts/sanitize-a3-teacher-vrm.mjs');
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-teacher-vrm-'));
    const outputPath = path.join(temporaryDirectory, 'teacher.vrm');

    try {
      execFileSync(process.execPath, [
        sanitizerPath,
        '--input',
        teacherPath,
        '--output',
        outputPath,
      ]);
      expect(Buffer.compare(fs.readFileSync(outputPath), fs.readFileSync(teacherPath))).toBe(0);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('uses a face-to-face VRM camera profile and richer speech expressions', () => {
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );
    const readmePath = path.resolve(process.cwd(), 'public/a3/assets/teacher-avatar/README.md');

    expect(stageSource).toContain('A3_VRM_CAMERA_PROFILE');
    expect(stageSource).toContain("import('@pixiv/three-vrm')");
    expect(stageSource).toContain("import('three/examples/jsm/loaders/GLTFLoader.js')");
    expect(stageSource).not.toContain(
      "import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'",
    );
    expect(stageSource).not.toContain('import { VRMLoaderPlugin');
    expect(stageSource).toContain("framing: 'portrait_face_to_face'");
    expect(stageSource).toContain('A3_VRM_MOUTH_EXPRESSIONS');
    expect(stageSource).toContain("'aa'");
    expect(stageSource).toContain("'ih'");
    expect(stageSource).toContain("'ou'");
    expect(stageSource).toContain("'ee'");
    expect(stageSource).toContain("'oh'");
    expect(stageSource).toContain('A3_VRM_STATE_EXPRESSIONS');
    expect(stageSource).toContain('applyVrmExpressionSet');
    expect(stageSource).toContain('speechPhase');
    expect(stageSource).toContain('applyVrmTeacherRestPose');
    expect(stageSource).toContain('warmUpVrmSpringBones');
    expect(stageSource).not.toContain("'leftUpperArm'");
    expect(stageSource).not.toContain("'rightUpperArm'");
    expect(stageSource).toContain('vrm.springBoneManager?.reset()');
    expect(stageSource).toContain('vrm.update(1 / 60)');
    expect(fs.readFileSync(readmePath, 'utf8')).toContain(
      'Source: VRoid Studio self-created model',
    );
  });

  it('drives VRM lip sync and micro motion from the realtime coaching state', () => {
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );

    expect(stageSource).toContain('resolveVrmSpeechVisemes');
    expect(stageSource).toContain('resolveAvatarMotionProfile');
    expect(stageSource).toContain('applyVrmLookAtMicroMotion');
    expect(stageSource).toContain('applyVrmHeadMotion');
    expect(stageSource).toContain('resolveBlinkWeight');
    expect(stageSource).toContain('listening:');
    expect(stageSource).toContain('thinking:');
    expect(stageSource).toContain('speaking:');
    expect(stageSource).toContain('visual_focus:');
    expect(stageSource).toContain('visemeWeights');
    expect(stageSource).toContain('headNod');
    expect(stageSource).toContain('lookYaw');
    expect(stageSource).not.toContain("'leftUpperArm'");
    expect(stageSource).not.toContain("'rightUpperArm'");
    expect(stageSource).not.toContain("'leftLowerArm'");
    expect(stageSource).not.toContain("'rightLowerArm'");
  });

  it('supports TTS/audio speech cues and switchable teacher VRMA actions', () => {
    const typeSource = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/a3/digital-human-types.ts'),
      'utf8',
    );
    const hookSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/use-realtime-coaching.ts'),
      'utf8',
    );
    const avatarSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-avatar.tsx'),
      'utf8',
    );
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );
    const generatorSource = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/generate-a3-idle-vrma.mjs'),
      'utf8',
    );

    expect(typeSource).toContain('A3DigitalHumanSpeechCue');
    expect(typeSource).toContain("'tts_viseme'");
    expect(typeSource).toContain("'audio_energy'");
    expect(hookSource).toContain('speechCues');
    expect(hookSource).toContain('appendAudioEnergySpeechCue');
    expect(hookSource).toContain('extractProviderSpeechCues');
    expect(avatarSource).toContain('speechCues={speechCues}');
    expect(stageSource).toContain('speechCues?: A3DigitalHumanSpeechCue[]');
    expect(stageSource).toContain('resolveSpeechCueVisemeWeights');
    expect(stageSource).toContain('A3_TEACHER_VRMA_ACTIONS');
    expect(stageSource).toContain('resolveTeacherVrmActionKey');
    expect(stageSource).toContain('crossFadeTeacherAction');
    expect(stageSource).toContain('data-avatar-action=');
    expect(stageSource).toContain('data-avatar-action-state=');
    expect(stageSource).toContain('/a3/assets/teacher-avatar/explain.vrma');
    expect(stageSource).toContain('/a3/assets/teacher-avatar/nod.vrma');
    expect(stageSource).toContain('/a3/assets/teacher-avatar/wait.vrma');
    expect(generatorSource).toContain('A3TeacherExplain');
    expect(generatorSource).toContain('A3TeacherNod');
    expect(generatorSource).toContain('A3TeacherWait');
  });

  it('sizes the VRM teacher as the primary face-to-face coaching surface', () => {
    const avatarSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-avatar.tsx'),
      'utf8',
    );
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );
    const callSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/realtime-coaching-call.tsx'),
      'utf8',
    );
    expect(avatarSource).toContain('min-h-[580px]');
    expect(stageSource).toContain('h-[420px]');
    expect(stageSource).toContain('md:h-[500px]');
    expect(stageSource).toContain('xl:h-[560px]');
    expect(stageSource).toContain('absolute left-4 top-4 inline-flex');
    expect(stageSource).not.toContain('absolute inset-x-4 bottom-4 flex');
    expect(stageSource).toContain('modelScale: 1.72');
    expect(stageSource).toContain('new THREE.Vector3(0, 1.55, 2.05)');
    expect(stageSource).toContain('md:w-[46%]');
    expect(callSource).toContain('<RealtimeMediaStage');
    expect(callSource).toContain('data-testid="a3-realtime-video-surface"');
    expect(callSource).toContain('data-testid="a3-realtime-floating-controls"');
    expect(callSource).toContain('md:bottom-28 md:left-6');
    expect(callSource).toContain('renderSuspended={avatarCovered}');
    expect(callSource).toContain('backdrop-blur-xl');
    expect(callSource).not.toContain('2xl:grid-cols-[minmax(0,1fr)_210px]');
  });
});

function readGlbJson(filePath: string) {
  const buffer = fs.readFileSync(filePath);
  expect(buffer.subarray(0, 4).toString('utf8')).toBe('glTF');
  expect(buffer.readUInt32LE(4)).toBe(2);

  let offset = 12;
  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'JSON') {
      return JSON.parse(
        buffer
          .subarray(offset + 8, offset + 8 + chunkLength)
          .toString('utf8')
          .trimEnd(),
      ) as {
        extensions?: { VRMC_vrm?: { meta?: Record<string, unknown> } };
      };
    }
    offset += 8 + chunkLength;
  }

  throw new Error(`GLB JSON chunk missing: ${filePath}`);
}

function readGlbChunkLengths(buffer: Buffer) {
  const lengths: number[] = [];
  for (let offset = 12; offset < buffer.length; ) {
    const chunkLength = buffer.readUInt32LE(offset);
    lengths.push(chunkLength);
    offset += 8 + chunkLength;
  }
  return lengths;
}
