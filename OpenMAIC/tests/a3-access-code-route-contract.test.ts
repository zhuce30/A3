import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('access-code route contract', () => {
  it('keeps shared token verification outside Next route modules', () => {
    const verifyRoute = read('app/api/access-code/verify/route.ts');
    const statusRoute = read('app/api/access-code/status/route.ts');

    expect(verifyRoute).not.toContain('export function verifyAccessToken');
    expect(statusRoute).not.toContain("from '@/app/api/access-code/verify/route'");
    expect(statusRoute).toContain("from '@/lib/server/access-code'");
  });
});
