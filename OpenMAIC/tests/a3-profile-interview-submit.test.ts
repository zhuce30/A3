import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx');

describe('A3 profile interview submit payload', () => {
  it('posts only the current interview input instead of replaying the full dialogue history', () => {
    const source = fs.readFileSync(pagePath, 'utf8');

    expect(source).toContain("const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { message: messageText });");
    expect(source).not.toContain('{ message: dialogue }');
    expect(source).not.toContain("const dialogue = nextMessages.map");
  });
});
