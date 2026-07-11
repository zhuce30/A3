import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

async function loadAssetPipeline() {
  return (await import('../scripts/a3-homepage-asset-pipeline.mjs')) as {
    hasHeaderClearance: (targetTop: number, headerBottom: number, minimumGap?: number) => boolean;
    inspectRasterBuffer: (buffer: Buffer) => Promise<{
      alphaRatio: number;
      luminanceVariance: number;
      valid: boolean;
    }>;
    retryTransientFileOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    replaceFileAtomically: (source: string, target: string) => Promise<void>;
    runAtomicAssetCapture: (options: {
      outputDir: string;
      temporaryRoot: string;
      captureAssets: (temporaryDir: string) => Promise<void>;
      validateAssets: (temporaryDir: string) => Promise<void>;
      fileOperations?: {
        removeTree: (target: string) => Promise<void>;
        replaceFile: (source: string, target: string) => Promise<void>;
      };
    }) => Promise<void>;
  };
}

describe('A3 homepage atomic asset capture', () => {
  it('keeps published assets unchanged and removes temp output after a capture failure', async () => {
    const { runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-atomic-'));
    const outputDir = path.join(root, 'homepage');
    const temporaryRoot = path.join(root, 'capture-tmp');
    await fs.mkdir(outputDir);
    await fs.writeFile(path.join(outputDir, 'profile.webp'), 'old-profile');
    await fs.writeFile(path.join(outputDir, 'classroom.webp'), 'old-classroom');

    try {
      await expect(
        runAtomicAssetCapture({
          outputDir,
          temporaryRoot,
          captureAssets: async (temporaryDir) => {
            await fs.writeFile(path.join(temporaryDir, 'profile.webp'), 'new-profile');
            throw new Error('capture failed on asset 2');
          },
          validateAssets: async () => {
            throw new Error('validation must not run');
          },
        }),
      ).rejects.toThrow('capture failed on asset 2');

      await expect(fs.readFile(path.join(outputDir, 'profile.webp'), 'utf8')).resolves.toBe(
        'old-profile',
      );
      await expect(fs.readFile(path.join(outputDir, 'classroom.webp'), 'utf8')).resolves.toBe(
        'old-classroom',
      );
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith('.homepage-capture-')),
      ).toEqual([]);
      await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects transparent pixels and accepts a nonblank raster', async () => {
    const { inspectRasterBuffer } = await loadAssetPipeline();
    const transparent = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const visible = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 240, g: 240, b: 240, alpha: 1 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="32" height="64"><rect width="32" height="64" fill="#111827"/></svg>',
          ),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    await expect(inspectRasterBuffer(transparent)).resolves.toMatchObject({ valid: false });
    await expect(inspectRasterBuffer(visible)).resolves.toMatchObject({ valid: true });
  });

  it('requires captured content to clear the sticky header', async () => {
    const { hasHeaderClearance } = await loadAssetPipeline();

    expect(hasHeaderClearance(96, 72, 12)).toBe(true);
    expect(hasHeaderClearance(70, 72, 12)).toBe(false);
  });

  it('retries transient Windows file locks but fails closed for other errors', async () => {
    const { retryTransientFileOperation } = await loadAssetPipeline();
    let attempts = 0;

    await expect(
      retryTransientFileOperation(async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        return 'published';
      }),
    ).resolves.toBe('published');
    expect(attempts).toBe(3);

    let permanentAttempts = 0;
    await expect(
      retryTransientFileOperation(async () => {
        permanentAttempts += 1;
        throw Object.assign(new Error('invalid target'), { code: 'EINVAL' });
      }),
    ).rejects.toThrow('invalid target');
    expect(permanentAttempts).toBe(1);
  });

  it('preserves the primary capture error when temporary cleanup also fails', async () => {
    const { runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-primary-error-'));
    const outputDir = path.join(root, 'homepage');
    const temporaryRoot = path.join(root, 'capture-tmp');
    let cleanupAttempts = 0;

    try {
      await expect(
        runAtomicAssetCapture({
          outputDir,
          temporaryRoot,
          captureAssets: async () => {
            throw new Error('primary capture failure');
          },
          validateAssets: async () => undefined,
          fileOperations: {
            removeTree: async () => {
              cleanupAttempts += 1;
              throw Object.assign(new Error('cleanup locked'), { code: 'EBUSY' });
            },
            replaceFile: async () => undefined,
          },
        }),
      ).rejects.toThrow('primary capture failure');
      expect(cleanupAttempts).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('captures outside the published public directory and rolls back partial publication', async () => {
    const { replaceFileAtomically, runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-publish-'));
    const outputDir = path.join(root, 'public', 'homepage');
    const temporaryRoot = path.join(root, '.tmp');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'profile.webp'), 'old-profile');
    await fs.writeFile(path.join(outputDir, 'classroom.webp'), 'old-classroom');

    try {
      let observedTemporaryDir = '';
      let replacements = 0;
      await expect(
        runAtomicAssetCapture({
          outputDir,
          temporaryRoot,
          captureAssets: async (temporaryDir) => {
            observedTemporaryDir = temporaryDir;
            await fs.writeFile(path.join(temporaryDir, 'profile.webp'), 'new-profile');
            await fs.writeFile(path.join(temporaryDir, 'classroom.webp'), 'new-classroom');
          },
          validateAssets: async () => undefined,
          fileOperations: {
            removeTree: async (target) => fs.rm(target, { recursive: true, force: true }),
            replaceFile: async (source, target) => {
              replacements += 1;
              if (replacements === 2) throw new Error('second replacement failed');
              await replaceFileAtomically(source, target);
            },
          },
        }),
      ).rejects.toThrow('second replacement failed');

      expect(
        path.resolve(observedTemporaryDir).startsWith(`${path.resolve(temporaryRoot)}${path.sep}`),
      ).toBe(true);
      await expect(fs.readFile(path.join(outputDir, 'profile.webp'), 'utf8')).resolves.toBe(
        'old-profile',
      );
      await expect(fs.readFile(path.join(outputDir, 'classroom.webp'), 'utf8')).resolves.toBe(
        'old-classroom',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
