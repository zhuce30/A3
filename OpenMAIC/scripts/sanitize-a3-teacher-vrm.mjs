import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function align4(value) {
  return (value + 3) & ~3;
}

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== GLB_VERSION) {
    throw new Error('Expected a GLB 2.0 file.');
  }
  if (buffer.readUInt32LE(8) !== buffer.length) {
    throw new Error('GLB header length does not match the file size.');
  }

  const chunks = [];
  for (let offset = 12; offset < buffer.length; ) {
    const byteLength = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + byteLength;
    if (end > buffer.length) throw new Error('GLB chunk exceeds file length.');
    chunks.push({ type, data: buffer.subarray(offset + 8, end) });
    offset = end;
  }
  return chunks;
}

function encodeGlb(chunks) {
  const encodedChunks = chunks.map(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(data.length, 0);
    header.writeUInt32LE(type, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = 12 + encodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(totalLength, 8);
  return Buffer.concat([header, ...encodedChunks]);
}

function encodeJsonChunk(json) {
  const source = Buffer.from(JSON.stringify(json));
  return Buffer.concat([source, Buffer.alloc(align4(source.length) - source.length, 0x20)]);
}

function collectMaterialTextureIndexes(materials) {
  const indexes = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'index' && Number.isInteger(child)) indexes.add(child);
      else visit(child);
    }
  };
  materials.forEach(visit);
  return indexes;
}

function remapIndexes(value, keyName, removedIndexes) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === keyName && Number.isInteger(child)) {
      const shift = removedIndexes.filter((removed) => removed < child).length;
      value[key] = child - shift;
    } else {
      remapIndexes(child, keyName, removedIndexes);
    }
  }
}

function removeThumbnailPayload(json, binary) {
  const meta = json.extensions?.VRMC_vrm?.meta;
  const imageIndex = meta?.thumbnailImage;
  delete meta?.thumbnailImage;
  if (!Number.isInteger(imageIndex) || !json.images?.[imageIndex]) return binary;

  const targetTextureIndexes = (json.textures || [])
    .map((texture, index) => ({ texture, index }))
    .filter(({ texture }) => texture.source === imageIndex)
    .map(({ index }) => index);
  const usedTextureIndexes = collectMaterialTextureIndexes(json.materials || []);
  if (targetTextureIndexes.some((index) => usedTextureIndexes.has(index))) return binary;

  const bufferViewIndex = json.images[imageIndex].bufferView;
  if (!Number.isInteger(bufferViewIndex) || !json.bufferViews?.[bufferViewIndex]) return binary;

  const removedTextures = targetTextureIndexes.map((index) => json.textures[index]).filter(Boolean);
  for (const index of [...targetTextureIndexes].sort((a, b) => b - a))
    json.textures.splice(index, 1);
  remapIndexes(json.materials || [], 'index', targetTextureIndexes);

  json.images.splice(imageIndex, 1);
  for (const texture of json.textures || []) {
    if (texture.source > imageIndex) texture.source -= 1;
  }

  const removableSamplers = [
    ...new Set(removedTextures.map((texture) => texture.sampler).filter(Number.isInteger)),
  ].filter(
    (samplerIndex) => !(json.textures || []).some((texture) => texture.sampler === samplerIndex),
  );
  for (const index of [...removableSamplers].sort((a, b) => b - a)) json.samplers?.splice(index, 1);
  for (const texture of json.textures || []) {
    if (!Number.isInteger(texture.sampler)) continue;
    texture.sampler -= removableSamplers.filter((removed) => removed < texture.sampler).length;
  }

  let remainingBufferViewReferences = 0;
  const countReferences = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'bufferViews') continue;
      if (key === 'bufferView' && child === bufferViewIndex) remainingBufferViewReferences += 1;
      else countReferences(child);
    }
  };
  countReferences(json);
  if (remainingBufferViewReferences) {
    throw new Error('Thumbnail bufferView is still referenced after removing thumbnail metadata.');
  }

  const view = json.bufferViews[bufferViewIndex];
  const start = view.byteOffset || 0;
  const nextOffset = Math.min(
    ...json.bufferViews
      .filter((_, index) => index !== bufferViewIndex)
      .map((candidate) => candidate.byteOffset || 0)
      .filter((offset) => offset > start),
    binary.length,
  );
  const end = Math.max(start + view.byteLength, nextOffset);
  const removedByteLength = end - start;
  if (removedByteLength % 4 !== 0) throw new Error('Thumbnail binary range is not 4-byte aligned.');

  json.bufferViews.splice(bufferViewIndex, 1);
  remapIndexes(json, 'bufferView', [bufferViewIndex]);
  for (const candidate of json.bufferViews) {
    if ((candidate.byteOffset || 0) >= end) candidate.byteOffset -= removedByteLength;
  }
  if (json.buffers?.[0]) json.buffers[0].byteLength -= removedByteLength;
  return Buffer.concat([binary.subarray(0, start), binary.subarray(end)]);
}

export function sanitizeTeacherVrmBuffer(buffer) {
  const chunks = parseGlb(buffer);
  const jsonIndex = chunks.findIndex((chunk) => chunk.type === JSON_CHUNK);
  const binaryIndex = chunks.findIndex((chunk) => chunk.type === BIN_CHUNK);
  if (jsonIndex < 0 || binaryIndex < 0)
    throw new Error('Teacher VRM must contain JSON and BIN chunks.');

  const json = JSON.parse(chunks[jsonIndex].data.toString('utf8').trimEnd());
  const meta = json.extensions?.VRMC_vrm?.meta;
  if (!meta) throw new Error('VRMC_vrm.meta is missing.');

  meta.authors = ['A3 project team'];
  delete meta.contactInformation;
  meta.avatarPermission = 'onlySeparatelyLicensedPerson';
  meta.allowExcessivelyViolentUsage = false;
  meta.allowExcessivelySexualUsage = false;
  meta.commercialUsage = 'personalNonProfit';
  meta.allowPoliticalOrReligiousUsage = false;
  meta.allowAntisocialOrHateUsage = false;
  meta.creditNotation = 'required';
  meta.allowRedistribution = false;
  meta.modification = 'prohibited';

  chunks[binaryIndex] = {
    type: BIN_CHUNK,
    data: removeThumbnailPayload(json, chunks[binaryIndex].data),
  };
  chunks[jsonIndex] = { type: JSON_CHUNK, data: encodeJsonChunk(json) };
  return encodeGlb(chunks);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const defaultPath = path.resolve(
    scriptDirectory,
    '../public/a3/assets/teacher-avatar/teacher.vrm',
  );
  return {
    input: path.resolve(values.get('--input') || defaultPath),
    output: path.resolve(values.get('--output') || values.get('--input') || defaultPath),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { input, output } = parseArguments(process.argv.slice(2));
  const sanitized = sanitizeTeacherVrmBuffer(fs.readFileSync(input));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sanitized);
  console.log(`Sanitized ${output} (${sanitized.length} bytes)`);
}
