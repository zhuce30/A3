import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/resources/video-composition/route.ts');
const assetRoutePath = path.resolve(process.cwd(), 'app/api/a3/resources/video-composition/[asset]/route.ts');

describe('A3 video composition proxy contract', () => {
  it('proxies state, edits, narration and compose operations to Django', () => {
    const source = fs.readFileSync(routePath, 'utf8');
    expect(source).toContain('export async function GET');
    expect(source).toContain('export async function PATCH');
    expect(source).toContain('export async function POST');
    expect(source).toContain('/composition/`');
    expect(source).toContain('/composition/generate-narration/`');
    expect(source).toContain('/composition/compose/`');
    expect(source).not.toContain('apiKey');
    expect(source).not.toContain('stored_path');
  });

  it('uses an allowlist for authenticated media assets', () => {
    const source = fs.readFileSync(assetRoutePath, 'utf8');
    expect(source).toContain("new Set(['final', 'narration', 'subtitles', 'audio'])");
    expect(source).toContain("request.headers.get('cookie')");
    expect(source).toContain('resolveA3DjangoEndpoint');
    expect(source).not.toContain('A3_VIDEO_TTS_API_KEY');
  });
});
