import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const apiClientPath = path.resolve(process.cwd(), 'lib/a3/api-client.ts');

describe('A3 API client error copy', () => {
  it('uses a service diagnostic message instead of exposing fetch internals', () => {
    const source = fs.readFileSync(apiClientPath, 'utf8');

    expect(source).toContain('无法连接 A3 后端服务');
    expect(source).toContain('localhost:8000');
    expect(source).toContain('请先启动 Django 后端服务');
    expect(source).not.toContain('error instanceof Error ? error.message');
  });
});
