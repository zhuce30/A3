import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MESHOPT_EXTENSION = 'EXT_meshopt_compression';
const WEBP_EXTENSION = 'EXT_texture_webp';

function align4(value) {
  return (value + 3) & ~3;
}

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== GLB_VERSION) {
    throw new Error('Expected a GLB 2.0 teacher model.');
  }
  if (buffer.readUInt32LE(8) !== buffer.length) {
    throw new Error('GLB header length does not match the teacher model size.');
  }

  let json;
  let binary;
  for (let offset = 12; offset < buffer.length; ) {
    const byteLength = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + byteLength);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8').trimEnd());
    if (type === BIN_CHUNK) binary = data;
    offset += 8 + byteLength;
  }
  if (!json || !binary) throw new Error('Teacher VRM must contain JSON and BIN chunks.');
  return { json, binary };
}

function encodeGlb(json, binary) {
  const jsonSource = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([
    jsonSource,
    Buffer.alloc(align4(jsonSource.length) - jsonSource.length, 0x20),
  ]);
  const binaryChunk = Buffer.concat([binary, Buffer.alloc(align4(binary.length) - binary.length)]);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binaryChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryChunk.length, 0);
  binaryHeader.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binaryChunk]);
}

function appendAligned(parts, payload) {
  const byteOffset = parts.reduce((total, part) => total + part.length, 0);
  const padding = align4(payload.length) - payload.length;
  parts.push(payload, Buffer.alloc(padding));
  return { byteOffset, byteLength: payload.length };
}

function accessorStride(accessor) {
  const componentBytes = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  }[accessor.componentType];
  const componentCount = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  }[accessor.type];
  if (!componentBytes || !componentCount) throw new Error('Unsupported accessor layout.');
  return componentBytes * componentCount;
}

function isLosslessTexture(image) {
  return /(?:normal|nml|mask|matcap|warp|outline|_out|none)/i.test(image.name || '');
}

async function convertImageToWebp(payload, image) {
  const pipeline = sharp(payload, { failOn: 'error' }).rotate();
  const metadata = await pipeline.metadata();
  const maxDimension = Math.max(metadata.width || 0, metadata.height || 0);
  if (maxDimension > 1024) {
    pipeline.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
  }
  return isLosslessTexture(image)
    ? pipeline.webp({ lossless: true, effort: 6 }).toBuffer()
    : pipeline.webp({ quality: 78, alphaQuality: 90, smartSubsample: true, effort: 6 }).toBuffer();
}

function collectAccessorsByBufferView(json) {
  const result = new Map();
  (json.accessors || []).forEach((accessor, index) => {
    if (!Number.isInteger(accessor.bufferView)) return;
    const values = result.get(accessor.bufferView) || [];
    values.push({ ...accessor, index });
    result.set(accessor.bufferView, values);
  });
  return result;
}

function collectImageByBufferView(json) {
  const result = new Map();
  (json.images || []).forEach((image, index) => {
    if (Number.isInteger(image.bufferView)) result.set(image.bufferView, { image, index });
  });
  return result;
}

function ensureExtension(json, key, required = false) {
  json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), key])];
  if (required) json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), key])];
}

function validateOptimizedModel(json, outputBytes) {
  const requiredRootExtensions = ['VRMC_vrm', 'VRMC_springBone'];
  for (const extension of requiredRootExtensions) {
    if (!json.extensions?.[extension]) throw new Error(`Optimized VRM lost ${extension}.`);
  }
  if (!json.extensionsUsed?.includes('VRMC_materials_mtoon')) {
    throw new Error('Optimized VRM lost VRMC_materials_mtoon.');
  }
  if (!json.meshes?.length || !json.skins?.length || !json.images?.length) {
    throw new Error('Optimized VRM is missing meshes, skins, or images.');
  }
  const hasMorphTargets = json.meshes.some((mesh) =>
    mesh.primitives?.some((primitive) => primitive.targets?.length),
  );
  if (!hasMorphTargets) throw new Error('Optimized VRM lost humanoid morph targets.');
  if (!Object.keys(json.extensions.VRMC_vrm.expressions?.preset || {}).length) {
    throw new Error('Optimized VRM lost humanoid expressions.');
  }
  if (outputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Optimized VRM is ${outputBytes} bytes; limit is ${MAX_OUTPUT_BYTES}.`);
  }
}

async function optimizeTeacherVrm(inputBuffer) {
  const { json, binary } = parseGlb(inputBuffer);
  const accessorsByView = collectAccessorsByBufferView(json);
  const imagesByView = collectImageByBufferView(json);
  const outputParts = [];
  const textureReport = [];
  let compressedGeometryBytes = 0;

  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  for (let index = 0; index < json.bufferViews.length; index += 1) {
    const view = json.bufferViews[index];
    const start = view.byteOffset || 0;
    const original = binary.subarray(start, start + view.byteLength);
    const imageEntry = imagesByView.get(index);
    const accessors = accessorsByView.get(index) || [];

    if (imageEntry) {
      const converted = await convertImageToWebp(original, imageEntry.image);
      const location = appendAligned(outputParts, converted);
      Object.assign(view, { buffer: 0, ...location });
      delete view.extensions?.[MESHOPT_EXTENSION];
      imageEntry.image.mimeType = 'image/webp';
      textureReport.push({
        index: imageEntry.index,
        name: imageEntry.image.name || `image-${imageEntry.index}`,
        inputBytes: original.length,
        outputBytes: converted.length,
        lossless: isLosslessTexture(imageEntry.image),
      });
      continue;
    }

    if (accessors.length === 1 && !accessors[0].sparse) {
      const accessor = accessors[0];
      const stride = view.byteStride || accessorStride(accessor);
      if (accessor.count * stride !== view.byteLength || (accessor.byteOffset || 0) !== 0) {
        throw new Error(`Buffer view ${index} is not a tightly packed accessor.`);
      }
      const mode = view.target === 34963 ? 'INDICES' : 'ATTRIBUTES';
      const encoded = Buffer.from(
        MeshoptEncoder.encodeGltfBuffer(new Uint8Array(original), accessor.count, stride, mode),
      );
      const decoded = new Uint8Array(accessor.count * stride);
      MeshoptDecoder.decodeGltfBuffer(decoded, accessor.count, stride, encoded, mode, 'NONE');
      if (Buffer.compare(Buffer.from(decoded), original) !== 0) {
        throw new Error(`Meshopt round-trip changed buffer view ${index}.`);
      }
      const location = appendAligned(outputParts, encoded);
      delete view.buffer;
      delete view.byteOffset;
      view.extensions = {
        ...(view.extensions || {}),
        [MESHOPT_EXTENSION]: {
          buffer: 0,
          ...location,
          byteStride: stride,
          count: accessor.count,
          mode,
          filter: 'NONE',
        },
      };
      compressedGeometryBytes += encoded.length;
      continue;
    }

    const location = appendAligned(outputParts, original);
    Object.assign(view, { buffer: 0, ...location });
  }

  for (const texture of json.textures || []) {
    if (!Number.isInteger(texture.source)) continue;
    texture.extensions = {
      ...(texture.extensions || {}),
      [WEBP_EXTENSION]: { source: texture.source },
    };
    delete texture.source;
  }
  ensureExtension(json, MESHOPT_EXTENSION, true);
  ensureExtension(json, WEBP_EXTENSION, true);
  const outputBinary = Buffer.concat(outputParts);
  json.buffers[0].byteLength = outputBinary.length;
  const output = encodeGlb(json, outputBinary);
  validateOptimizedModel(json, output.length);

  return {
    output,
    json,
    report: {
      schemaVersion: 1,
      inputBytes: inputBuffer.length,
      outputBytes: output.length,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      compressedGeometryBytes,
      extensionsPreserved: ['VRMC_vrm', 'VRMC_springBone', 'VRMC_materials_mtoon'],
      extensionsAdded: [MESHOPT_EXTENSION, WEBP_EXTENSION],
      textures: textureReport,
    },
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const assetDirectory = path.resolve(scriptDirectory, '../public/a3/assets/teacher-avatar');
  return {
    input: path.resolve(values.get('--input') || path.join(assetDirectory, 'teacher.vrm')),
    output: path.resolve(
      values.get('--output') || path.join(assetDirectory, 'teacher.optimized.vrm'),
    ),
    report: path.resolve(
      values.get('--report') || path.join(assetDirectory, 'teacher.optimized.report.json'),
    ),
    loadingSource: path.resolve(
      values.get('--loading-source') ||
        path.resolve(scriptDirectory, '../public/a3/assets/homepage/teacher-fallback.webp'),
    ),
    loadingOutput: path.resolve(
      values.get('--loading-output') || path.join(assetDirectory, 'teacher-loading.webp'),
    ),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const optimized = await optimizeTeacherVrm(fs.readFileSync(options.input));
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, optimized.output);
  fs.writeFileSync(options.report, `${JSON.stringify(optimized.report, null, 2)}\n`);
  await sharp(options.loadingSource)
    .resize({ width: 720, height: 1080, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84, smartSubsample: true, effort: 6 })
    .toFile(options.loadingOutput);
  console.log(JSON.stringify(optimized.report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { optimizeTeacherVrm, validateOptimizedModel };
