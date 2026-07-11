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

export async function replaceFileAtomically(source, target) {
  const staged = `${target}.publish-${randomUUID()}`;
  try {
    await fs.copyFile(source, staged);
    await renameTree(staged, target);
  } finally {
    if (await exists(staged)) await removeTree(staged);
  }
}

async function publishAssetFiles(sourceDir, targetDir, replaceFile = replaceFileAtomically) {
  const filenames = (await fs.readdir(sourceDir)).sort();
  const originals = new Map();
  for (const filename of filenames) {
    const target = path.join(targetDir, filename);
    originals.set(filename, (await exists(target)) ? await fs.readFile(target) : null);
  }

  try {
    for (const filename of filenames) {
      await replaceFile(path.join(sourceDir, filename), path.join(targetDir, filename));
    }
  } catch (publishError) {
    const rollbackErrors = [];
    for (const [filename, original] of originals) {
      const target = path.join(targetDir, filename);
      try {
        if (original === null) {
          if (await exists(target)) await removeTree(target);
        } else {
          const restoreSource = path.join(sourceDir, `.restore-${randomUUID()}-${filename}`);
          await fs.writeFile(restoreSource, original);
          try {
            await replaceFile(restoreSource, target);
          } finally {
            if (await exists(restoreSource)) await removeTree(restoreSource);
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError(
        [publishError, ...rollbackErrors],
        'Asset publication failed and rollback was incomplete',
        { cause: publishError },
      );
    }
    throw publishError;
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
}) {
  const removeTreeOperation = fileOperations.removeTree ?? removeTree;
  const replaceFileOperation = fileOperations.replaceFile ?? replaceFileAtomically;
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
    await publishAssetFiles(temporaryDir, outputDir, replaceFileOperation);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await removeTreeOperation(temporaryDir);
    } catch (cleanupError) {
      if (primaryError) {
        primaryError.cleanupError = cleanupError;
      } else {
        throw cleanupError;
      }
    }
  }
}
