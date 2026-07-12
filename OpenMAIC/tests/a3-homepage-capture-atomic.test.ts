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
    retryTransientFileOperation: <T>(
      operation: () => Promise<T>,
      options?: { maxAttempts?: number; retryDelayMs?: number },
    ) => Promise<T>;
    runAtomicAssetCapture: (options: {
      outputDir: string;
      temporaryRoot: string;
      captureAssets: (temporaryDir: string) => Promise<void>;
      validateAssets: (temporaryDir: string) => Promise<void>;
      fileOperations?: {
        removeTree?: (target: string) => Promise<void>;
        renameTree?: (source: string, target: string) => Promise<void>;
        copyTree?: (source: string, target: string) => Promise<void>;
      };
      onSwitchStep?: (step: 'before-switch' | 'old-detached' | 'new-activated') => Promise<void>;
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
          },
        }),
      ).rejects.toThrow('primary capture failure');
      expect(cleanupAttempts).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a complete generation when outputDir does not exist yet', async () => {
    const { runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-publish-'));
    const outputDir = path.join(root, 'public', 'homepage');
    const temporaryRoot = path.join(root, '.tmp');

    try {
      await runAtomicAssetCapture({
        outputDir,
        temporaryRoot,
        captureAssets: async (temporaryDir) => {
          await fs.writeFile(path.join(temporaryDir, 'profile.webp'), 'new-profile');
          await fs.writeFile(path.join(temporaryDir, 'classroom.webp'), 'new-classroom');
        },
        validateAssets: async () => undefined,
      });

      await expect(fs.readFile(path.join(outputDir, 'profile.webp'), 'utf8')).resolves.toBe(
        'new-profile',
      );
      await expect(fs.readFile(path.join(outputDir, 'classroom.webp'), 'utf8')).resolves.toBe(
        'new-classroom',
      );
      expect(
        (await fs.readdir(path.dirname(outputDir))).filter((name) => name.startsWith('.homepage-')),
      ).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('switches whole directories so observers never see a mixed asset generation', async () => {
    const { runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-observer-'));
    const outputDir = path.join(root, 'public', 'homepage');
    const temporaryRoot = path.join(root, '.tmp');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'profile.webp'), 'old-profile');
    await fs.writeFile(path.join(outputDir, 'classroom.webp'), 'old-classroom');
    const observations: string[] = [];
    const observe = async () => {
      try {
        const profile = await fs.readFile(path.join(outputDir, 'profile.webp'), 'utf8');
        const classroom = await fs.readFile(path.join(outputDir, 'classroom.webp'), 'utf8');
        observations.push(`${profile}|${classroom}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        observations.push('missing');
      }
    };

    try {
      await observe();
      await runAtomicAssetCapture({
        outputDir,
        temporaryRoot,
        captureAssets: async (temporaryDir) => {
          await fs.writeFile(path.join(temporaryDir, 'profile.webp'), 'new-profile');
          await fs.writeFile(path.join(temporaryDir, 'classroom.webp'), 'new-classroom');
        },
        validateAssets: async () => undefined,
        onSwitchStep: async () => observe(),
      });

      expect(observations).toContain('old-profile|old-classroom');
      expect(observations).toContain('missing');
      expect(observations).toContain('new-profile|new-classroom');
      expect(observations).not.toContain('old-profile|new-classroom');
      expect(observations).not.toContain('new-profile|old-classroom');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('restores the complete old directory when activating the next generation fails', async () => {
    const { runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-restore-'));
    const outputDir = path.join(root, 'public', 'homepage');
    const temporaryRoot = path.join(root, '.tmp');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'profile.webp'), 'old-profile');
    await fs.writeFile(path.join(outputDir, 'classroom.webp'), 'old-classroom');
    let renameAttempts = 0;

    try {
      await expect(
        runAtomicAssetCapture({
          outputDir,
          temporaryRoot,
          captureAssets: async (temporaryDir) => {
            await fs.writeFile(path.join(temporaryDir, 'profile.webp'), 'new-profile');
            await fs.writeFile(path.join(temporaryDir, 'classroom.webp'), 'new-classroom');
          },
          validateAssets: async () => undefined,
          fileOperations: {
            renameTree: async (source, target) => {
              renameAttempts += 1;
              if (renameAttempts === 2) throw new Error('next activation failed');
              await fs.rename(source, target);
            },
          },
        }),
      ).rejects.toThrow('next activation failed');

      await expect(fs.readFile(path.join(outputDir, 'profile.webp'), 'utf8')).resolves.toBe(
        'old-profile',
      );
      await expect(fs.readFile(path.join(outputDir, 'classroom.webp'), 'utf8')).resolves.toBe(
        'old-classroom',
      );
      expect(
        (await fs.readdir(path.dirname(outputDir))).filter((name) => name.startsWith('.homepage-')),
      ).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports exhausted rename and cleanup failures together without losing the primary error', async () => {
    const { retryTransientFileOperation, runAtomicAssetCapture } = await loadAssetPipeline();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a3-homepage-errors-'));
    const outputDir = path.join(root, 'public', 'homepage');
    const temporaryRoot = path.join(root, '.tmp');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'profile.webp'), 'old-profile');

    try {
      const failure = await runAtomicAssetCapture({
        outputDir,
        temporaryRoot,
        captureAssets: async (temporaryDir) => {
          await fs.writeFile(path.join(temporaryDir, 'profile.webp'), 'new-profile');
        },
        validateAssets: async () => undefined,
        fileOperations: {
          renameTree: async () =>
            retryTransientFileOperation(
              async () => {
                throw Object.assign(new Error('rename stayed locked'), { code: 'EBUSY' });
              },
              { maxAttempts: 2, retryDelayMs: 1 },
            ),
          removeTree: async (target) => {
            if (path.basename(target).startsWith('a3-homepage-capture-')) {
              throw Object.assign(new Error('cleanup denied'), { code: 'EPERM' });
            }
            await fs.rm(target, { recursive: true, force: true });
          },
        },
      }).then(
        () => null,
        (error) => error,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toMatchObject({ code: 'EBUSY', message: 'rename stayed locked' });
      expect(failure.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'EBUSY', message: 'rename stayed locked' }),
          expect.objectContaining({ code: 'EPERM', message: 'cleanup denied' }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
