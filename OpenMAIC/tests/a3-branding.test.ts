import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appLayoutPath = path.resolve(process.cwd(), 'app/layout.tsx');
const manifestPath = path.resolve(process.cwd(), 'app/manifest.ts');
const homepageContentPath = path.resolve(process.cwd(), 'components/a3/marketing/a3-homepage-content.ts');
const shellPath = path.resolve(process.cwd(), 'components/a3/layout/a3-shell.tsx');
const authPagesPath = path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx');
const privacyPath = path.resolve(process.cwd(), 'components/a3/auth/privacy-consent-page.tsx');
const brandAssetPath = path.resolve(process.cwd(), 'public/a3-brand-icon.png');

describe('A3 product branding', () => {
  it('uses 智学引擎 as the exact browser and installable-app title', () => {
    const layout = fs.readFileSync(appLayoutPath, 'utf8');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const homepage = fs.readFileSync(homepageContentPath, 'utf8');

    expect(layout).toContain("title: '智学引擎'");
    expect(layout).toContain("url: '/a3-brand-icon.png'");
    expect(manifest).toContain("name: '智学引擎'");
    expect(manifest).toContain("short_name: '智学引擎'");
    expect(homepage).not.toContain("title: '智学引擎 |");
  });

  it('replaces literal A product marks with the supplied image while retaining the existing size classes', () => {
    const sources = [shellPath, authPagesPath, privacyPath].map((file) => fs.readFileSync(file, 'utf8'));
    const combined = sources.join('\n');

    expect(fs.existsSync(brandAssetPath)).toBe(true);
    expect(combined).toContain('src="/a3-brand-icon.png"');
    expect(combined).toContain('priority unoptimized');
    expect(combined).toContain('size-12');
    expect(combined).toContain('size-10');
    expect(combined).not.toMatch(/>\s*A\s*</);
    expect(combined).not.toContain('scale-');
  });
});
