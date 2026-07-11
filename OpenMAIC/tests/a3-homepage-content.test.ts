import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const assetDir = path.resolve(process.cwd(), 'public/a3/assets/homepage');
const expectedAssets = [
  'profile.webp',
  'diagnostic.webp',
  'knowledge-base.webp',
  'classroom.webp',
  'teacher-workbench.webp',
  'teacher-fallback.webp',
];

describe('A3 product homepage assets', () => {
  it('ships every real product image used by the homepage', () => {
    for (const filename of expectedAssets) {
      const file = path.join(assetDir, filename);
      expect(fs.existsSync(file), filename).toBe(true);
      expect(fs.statSync(file).size, filename).toBeGreaterThan(10_000);
    }
  });

  it('ships decodable, reasonably sized, nonblank WebP images', async () => {
    for (const filename of expectedAssets) {
      const file = path.join(assetDir, filename);
      expect(fs.existsSync(file), filename).toBe(true);
      if (!fs.existsSync(file)) continue;

      const image = sharp(file);
      const metadata = await image.metadata();
      const stats = await image.stats();

      expect(metadata.format, filename).toBe('webp');
      expect(metadata.width, filename).toBeGreaterThanOrEqual(640);
      expect(metadata.height, filename).toBeGreaterThanOrEqual(360);
      expect(
        stats.channels.some((channel) => channel.max - channel.min > 24),
        filename,
      ).toBe(true);
    }
  });

  it('does not publish source documents or local path metadata', () => {
    expect(fs.existsSync(assetDir)).toBe(true);
    if (!fs.existsSync(assetDir)) return;

    const published = fs.readdirSync(assetDir);
    expect(published.some((name) => /\.(pdf|pptx?|json|txt)$/i.test(name))).toBe(false);
  });
});
