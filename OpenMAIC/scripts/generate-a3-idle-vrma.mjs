import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '../public/a3/assets/teacher-avatar');

const bones = [
  ['hips', null, [0, 1, 0]],
  ['spine', 'hips', [0, 0.12, 0]],
  ['chest', 'spine', [0, 0.18, 0]],
  ['upperChest', 'chest', [0, 0.18, 0]],
  ['neck', 'upperChest', [0, 0.14, 0]],
  ['head', 'neck', [0, 0.16, 0]],
  ['leftUpperLeg', 'hips', [0.1, -0.08, 0]],
  ['leftLowerLeg', 'leftUpperLeg', [0, -0.42, 0]],
  ['leftFoot', 'leftLowerLeg', [0, -0.42, 0.04]],
  ['rightUpperLeg', 'hips', [-0.1, -0.08, 0]],
  ['rightLowerLeg', 'rightUpperLeg', [0, -0.42, 0]],
  ['rightFoot', 'rightLowerLeg', [0, -0.42, 0.04]],
  ['leftShoulder', 'upperChest', [0.12, 0.1, 0]],
  ['leftUpperArm', 'leftShoulder', [0.18, -0.04, 0]],
  ['leftLowerArm', 'leftUpperArm', [0.28, 0, 0]],
  ['leftHand', 'leftLowerArm', [0.25, 0, 0]],
  ['rightShoulder', 'upperChest', [-0.12, 0.1, 0]],
  ['rightUpperArm', 'rightShoulder', [-0.18, -0.04, 0]],
  ['rightLowerArm', 'rightUpperArm', [-0.28, 0, 0]],
  ['rightHand', 'rightLowerArm', [-0.25, 0, 0]],
];

const nodeIndexByBone = new Map(bones.map(([name], index) => [name, index]));

function quatFromEuler(x, y, z) {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

const naturalArms = {
  leftUpperArm: [
    quatFromEuler(0.04, 0.08, -1.22),
    quatFromEuler(0.035, 0.08, -1.2),
    quatFromEuler(0.04, 0.08, -1.22),
  ],
  leftLowerArm: [
    quatFromEuler(0, -0.1, -0.18),
    quatFromEuler(0, -0.08, -0.2),
    quatFromEuler(0, -0.1, -0.18),
  ],
  leftHand: [
    quatFromEuler(0.03, 0, -0.05),
    quatFromEuler(0.02, 0, -0.04),
    quatFromEuler(0.03, 0, -0.05),
  ],
  rightUpperArm: [
    quatFromEuler(0.04, -0.08, 1.22),
    quatFromEuler(0.035, -0.08, 1.2),
    quatFromEuler(0.04, -0.08, 1.22),
  ],
  rightLowerArm: [
    quatFromEuler(0, 0.1, 0.18),
    quatFromEuler(0, 0.08, 0.2),
    quatFromEuler(0, 0.1, 0.18),
  ],
  rightHand: [
    quatFromEuler(0.03, 0, 0.05),
    quatFromEuler(0.02, 0, 0.04),
    quatFromEuler(0.03, 0, 0.05),
  ],
};

const actions = [
  {
    fileName: 'idle.vrma',
    animationName: 'A3TeacherNaturalIdle',
    duration: 3.6,
    pose: {
      spine: [quatFromEuler(0.02, 0, 0), quatFromEuler(0.035, 0, 0), quatFromEuler(0.02, 0, 0)],
      chest: [quatFromEuler(-0.015, 0, 0), quatFromEuler(-0.03, 0, 0), quatFromEuler(-0.015, 0, 0)],
      head: [quatFromEuler(0.01, 0, 0), quatFromEuler(0.0, 0.015, 0), quatFromEuler(0.01, 0, 0)],
      ...naturalArms,
    },
  },
  {
    fileName: 'wait.vrma',
    animationName: 'A3TeacherWait',
    duration: 4.2,
    pose: {
      spine: [quatFromEuler(0.018, 0, 0), quatFromEuler(0.026, 0, 0), quatFromEuler(0.018, 0, 0)],
      chest: [quatFromEuler(-0.012, 0, 0), quatFromEuler(-0.018, 0, 0), quatFromEuler(-0.012, 0, 0)],
      head: [quatFromEuler(0.008, -0.01, 0), quatFromEuler(0.0, 0.012, 0.006), quatFromEuler(0.008, -0.01, 0)],
      ...naturalArms,
    },
  },
  {
    fileName: 'explain.vrma',
    animationName: 'A3TeacherExplain',
    duration: 2.4,
    pose: {
      spine: [quatFromEuler(0.018, -0.008, 0), quatFromEuler(0.032, 0.01, 0), quatFromEuler(0.018, -0.008, 0)],
      chest: [quatFromEuler(-0.018, 0.008, 0), quatFromEuler(-0.034, -0.008, 0), quatFromEuler(-0.018, 0.008, 0)],
      neck: [quatFromEuler(0.004, 0.006, 0), quatFromEuler(-0.012, -0.006, 0), quatFromEuler(0.004, 0.006, 0)],
      head: [quatFromEuler(-0.004, 0.018, 0.004), quatFromEuler(-0.03, -0.014, -0.004), quatFromEuler(-0.004, 0.018, 0.004)],
      ...naturalArms,
    },
  },
  {
    fileName: 'nod.vrma',
    animationName: 'A3TeacherNod',
    duration: 1.8,
    pose: {
      spine: [quatFromEuler(0.016, 0, 0), quatFromEuler(0.024, 0, 0), quatFromEuler(0.016, 0, 0)],
      chest: [quatFromEuler(-0.012, 0, 0), quatFromEuler(-0.02, 0, 0), quatFromEuler(-0.012, 0, 0)],
      neck: [quatFromEuler(0.0, 0, 0), quatFromEuler(0.018, 0, 0), quatFromEuler(0.0, 0, 0)],
      head: [quatFromEuler(-0.012, 0, 0), quatFromEuler(0.045, 0, 0), quatFromEuler(-0.012, 0, 0)],
      ...naturalArms,
    },
  },
];

function align4(value) {
  return (value + 3) & ~3;
}

function createNodes() {
  return bones.map(([name, _parent, translation]) => {
    const children = bones
      .map(([_childName, childParent], index) => (childParent === name ? index : null))
      .filter((index) => index !== null);
    return {
      name,
      translation,
      ...(children.length ? { children } : {}),
    };
  });
}

function writeVrmAnimationFile(action) {
  const times = new Float32Array([0, action.duration / 2, action.duration]);
  const bufferViews = [];
  const accessors = [];
  const chunks = [];

  function pushBufferView(typedArray) {
    const source = Buffer.from(typedArray.buffer);
    const offset = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const alignedOffset = align4(offset);
    if (alignedOffset > offset) chunks.push(Buffer.alloc(alignedOffset - offset));
    chunks.push(source);
    const byteOffset = alignedOffset;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: source.byteLength });
    return bufferViews.length - 1;
  }

  function pushAccessor(typedArray, type, min, max) {
    const bufferView = pushBufferView(typedArray);
    accessors.push({
      bufferView,
      componentType: 5126,
      count: type === 'SCALAR' ? typedArray.length : typedArray.length / 4,
      type,
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
    });
    return accessors.length - 1;
  }

  const timeAccessor = pushAccessor(times, 'SCALAR', [0], [action.duration]);
  const samplers = [];
  const channels = [];

  Object.entries(action.pose).forEach(([boneName, quaternions]) => {
    const values = new Float32Array(quaternions.flat());
    const output = pushAccessor(values, 'VEC4');
    const samplerIndex = samplers.length;
    samplers.push({ input: timeAccessor, interpolation: 'LINEAR', output });
    channels.push({
      sampler: samplerIndex,
      target: { node: nodeIndexByBone.get(boneName), path: 'rotation' },
    });
  });

  const humanBones = Object.fromEntries(bones.map(([name], index) => [name, { node: index }]));
  const binaryBuffer = Buffer.concat(chunks);
  const json = {
    asset: {
      version: '2.0',
      generator: 'A3 generate-a3-idle-vrma.mjs',
    },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: createNodes(),
    animations: [{ name: action.animationName, samplers, channels }],
    buffers: [{ byteLength: binaryBuffer.byteLength }],
    bufferViews,
    accessors,
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json));
  const jsonPadding = align4(jsonBuffer.byteLength) - jsonBuffer.byteLength;
  const binPadding = align4(binaryBuffer.byteLength) - binaryBuffer.byteLength;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]);
  const paddedBin = Buffer.concat([binaryBuffer, Buffer.alloc(binPadding)]);
  const totalLength = 12 + 8 + paddedJson.byteLength + 8 + paddedBin.byteLength;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.byteLength, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedBin.byteLength, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  const outputPath = resolve(outputDir, action.fileName);
  writeFileSync(outputPath, Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin]));
  console.log(`Generated ${outputPath}`);
}

actions.forEach(writeVrmAnimationFile);
