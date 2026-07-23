import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = {
  url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
  sha256: '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb',
  destination: path.join(projectRoot, 'public', 'models', 'a3-detection', 'efficientdet-lite0-int8-v1.tflite'),
};

const copies = [
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', 'public/vendor/mediapipe/tasks-vision/0.10.35/wasm/vision_wasm_internal.js'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', 'public/vendor/mediapipe/tasks-vision/0.10.35/wasm/vision_wasm_internal.wasm'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js', 'public/vendor/mediapipe/tasks-vision/0.10.35/wasm/vision_wasm_nosimd_internal.js'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm', 'public/vendor/mediapipe/tasks-vision/0.10.35/wasm/vision_wasm_nosimd_internal.wasm'],
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'public/vendor/opencv/5.0.0/opencv.js'],
];
const workerDestination = path.join(
  projectRoot,
  'public',
  'vendor',
  'a3-browser-vision',
  '1.0.0',
  'a3-object-detector.worker.js',
);

async function ensureModel() {
  let bytes;
  try {
    bytes = await readFile(model.destination);
  } catch {
    const response = await fetch(model.url);
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(model.destination), { recursive: true });
    await writeFile(model.destination, bytes);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== model.sha256) throw new Error(`Unexpected EfficientDet model SHA-256: ${hash}`);
}

await ensureModel();
for (const [source, destination] of copies) {
  const absoluteDestination = path.join(projectRoot, destination);
  await mkdir(path.dirname(absoluteDestination), { recursive: true });
  await copyFile(path.join(projectRoot, source), absoluteDestination);
}
await mkdir(path.dirname(workerDestination), { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, 'workers', 'a3-object-detector.worker.ts')],
  outfile: workerDestination,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
});
console.log('A3 browser vision assets are ready.');
