import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const transientFileErrorCodes = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

export const A3_DIGITAL_HUMAN_CAPTURE_STYLE = `
  [data-testid="a3-digital-human-avatar"] > :not([data-testid="a3-digital-human-three-stage"]) {
    visibility: hidden !important;
  }
  [data-testid="a3-digital-human-three-stage"] {
    z-index: 2147483646 !important;
  }
  [data-testid="a3-digital-human-three-stage"] > :not([data-testid="a3-digital-human-three-canvas"]) {
    visibility: hidden !important;
  }
  [data-testid="a3-digital-human-three-canvas"] {
    background: linear-gradient(135deg, #dbeafe 0%, #9fb7da 42%, #516b91 100%) !important;
    position: relative !important;
    z-index: 2147483647 !important;
  }
`;

export async function retryTransientFileOperation(
  operation,
  { maxAttempts = 8, retryDelayMs = 150 } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const isTransient = transientFileErrorCodes.has(error?.code);
      if (!isTransient || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw new Error('Transient file operation exhausted without returning');
}

async function removeTree(target) {
  await retryTransientFileOperation(() =>
    fs.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }),
  );
}

async function renameTree(source, target) {
  await retryTransientFileOperation(() => fs.rename(source, target));
}

async function copyTree(source, target) {
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
}

function aggregateErrors(primaryError, secondaryErrors, context) {
  if (!secondaryErrors.length) return primaryError;
  const details = secondaryErrors.map((error) => error?.message ?? String(error)).join('; ');
  return new AggregateError(
    [primaryError, ...secondaryErrors],
    `${primaryError?.message ?? context}; ${context}: ${details}`,
    { cause: primaryError },
  );
}

async function publishAssetDirectoryTransaction({
  sourceDir,
  outputDir,
  validateAssets,
  fileOperations,
  onSwitchStep,
}) {
  const parentDir = path.dirname(outputDir);
  const basename = path.basename(outputDir);
  const nextDir = path.join(parentDir, `.${basename}-next-${randomUUID()}`);
  const backupDir = path.join(parentDir, `.${basename}-backup-${randomUUID()}`);
  const removeTreeOperation = fileOperations.removeTree ?? removeTree;
  const renameTreeOperation = fileOperations.renameTree ?? renameTree;
  const copyTreeOperation = fileOperations.copyTree ?? copyTree;
  let primaryError;
  let oldDetached = false;
  let nextActivated = false;

  try {
    await copyTreeOperation(sourceDir, nextDir);
    await validateAssets(nextDir);
    await onSwitchStep?.('before-switch');

    try {
      if (await exists(outputDir)) {
        await renameTreeOperation(outputDir, backupDir);
        oldDetached = true;
      }
      await onSwitchStep?.('old-detached');
      await renameTreeOperation(nextDir, outputDir);
      nextActivated = true;
      await onSwitchStep?.('new-activated');
    } catch (switchError) {
      const restoreErrors = [];
      if (oldDetached && !nextActivated) {
        try {
          await renameTreeOperation(backupDir, outputDir);
          oldDetached = false;
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
      }
      throw aggregateErrors(switchError, restoreErrors, 'directory switch rollback failed');
    }

    if (oldDetached) {
      await removeTreeOperation(backupDir);
      oldDetached = false;
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (await exists(nextDir)) {
    try {
      await removeTreeOperation(nextDir);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!oldDetached && (await exists(backupDir))) {
    try {
      await removeTreeOperation(backupDir);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError) {
    throw aggregateErrors(primaryError, cleanupErrors, 'directory transaction cleanup failed');
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Directory transaction cleanup failed');
  }
}

export function hasHeaderClearance(targetTop, headerBottom, minimumGap = 8) {
  return targetTop >= headerBottom + minimumGap;
}

export async function inspectRasterBuffer(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const totalPixels = info.width * info.height;
  let visiblePixels = 0;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha <= 16) continue;
    visiblePixels += 1;
    const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
  }

  const alphaRatio = totalPixels ? visiblePixels / totalPixels : 0;
  const mean = visiblePixels ? luminanceSum / visiblePixels : 0;
  const luminanceVariance = visiblePixels
    ? Math.max(0, luminanceSquaredSum / visiblePixels - mean * mean)
    : 0;

  return {
    alphaRatio,
    luminanceVariance,
    valid: alphaRatio >= 0.05 && luminanceVariance >= 16,
  };
}

export async function captureCanvasCompositor(
  canvas,
  { maxAttempts = 6, retryDelayMs = 250, label = 'WebGL canvas', screenshotStyle } = {},
) {
  await canvas.waitFor({ state: 'visible', timeout: 60_000 });
  let lastInspection = { alphaRatio: 0, luminanceVariance: 0, valid: false };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const png = await canvas.screenshot({
      type: 'png',
      animations: 'disabled',
      style: screenshotStyle,
    });
    lastInspection = await inspectRasterBuffer(png);
    if (lastInspection.valid) return png;
    if (attempt < maxAttempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw new Error(
    `${label} stayed blank after ${maxAttempts} attempts (alpha=${lastInspection.alphaRatio.toFixed(3)}, variance=${lastInspection.luminanceVariance.toFixed(2)})`,
  );
}

export async function validateHomepageAssetDirectory({
  assetDir,
  expectedAssets,
  minimumBytes = 10_000,
  minimumWidth = 640,
  minimumHeight = 360,
}) {
  const published = (await fs.readdir(assetDir)).sort();
  const expected = [...expectedAssets].sort();
  if (published.join('\n') !== expected.join('\n')) {
    throw new Error(`Captured asset set is incomplete: ${published.join(', ')}`);
  }

  for (const filename of expectedAssets) {
    const file = path.join(assetDir, filename);
    const stat = await fs.stat(file);
    if (stat.size <= minimumBytes) throw new Error(`${filename} is only ${stat.size} bytes`);
    const buffer = await fs.readFile(file);
    const metadata = await sharp(buffer).metadata();
    if (metadata.format !== 'webp') throw new Error(`${filename} is not WebP`);
    if ((metadata.width ?? 0) < minimumWidth || (metadata.height ?? 0) < minimumHeight) {
      throw new Error(`${filename} has invalid dimensions ${metadata.width}x${metadata.height}`);
    }
    const inspection = await inspectRasterBuffer(buffer);
    if (!inspection.valid) {
      throw new Error(
        `${filename} is blank or transparent (alpha=${inspection.alphaRatio.toFixed(3)}, variance=${inspection.luminanceVariance.toFixed(2)})`,
      );
    }
  }
}

export async function runAtomicAssetCapture({
  outputDir,
  temporaryRoot,
  captureAssets,
  validateAssets,
  fileOperations = {},
  onSwitchStep,
}) {
  const removeTreeOperation = fileOperations.removeTree ?? removeTree;
  const parentDir = path.dirname(outputDir);
  await fs.mkdir(parentDir, { recursive: true });
  await fs.mkdir(temporaryRoot, { recursive: true });
  const safeTemporaryRoot = await fs.realpath(temporaryRoot);
  const temporaryDir = await fs.mkdtemp(path.join(safeTemporaryRoot, 'a3-homepage-capture-'));
  const temporaryDirResolved = await fs.realpath(temporaryDir);
  if (!temporaryDirResolved.startsWith(`${safeTemporaryRoot}${path.sep}`)) {
    throw new Error(
      `Temporary capture directory escaped its configured root: ${temporaryDirResolved}`,
    );
  }
  let primaryError;

  try {
    await captureAssets(temporaryDir);
    await validateAssets(temporaryDir);
    await publishAssetDirectoryTransaction({
      sourceDir: temporaryDir,
      outputDir,
      validateAssets,
      fileOperations,
      onSwitchStep,
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  try {
    await removeTreeOperation(temporaryDir);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  if (primaryError) {
    throw aggregateErrors(primaryError, cleanupErrors, 'capture cleanup failed');
  }
  if (cleanupErrors.length) {
    throw cleanupErrors[0];
  }
}
