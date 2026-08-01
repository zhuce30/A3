import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveA3PlaywrightRuntime } from '@/e2e/playwright-runtime';

describe('A3 Playwright runtime', () => {
  it('never silently reuses managed frontend or backend servers', () => {
    const configSource = fs.readFileSync(path.resolve('playwright.config.ts'), 'utf8');

    expect(configSource).toContain('webServer: runtime.useExistingServers');
    expect(configSource.match(/reuseExistingServer: false/g)).toHaveLength(2);
  });

  it('starts a fresh default frontend instead of reusing an unknown server', () => {
    const runtime = resolveA3PlaywrightRuntime({}, path.resolve('OpenMAIC'));

    expect(runtime.port).toBe(3002);
    expect(runtime.baseURL).toBe('http://localhost:3002');
    expect(runtime.useExistingServers).toBe(false);
    expect(runtime.frontendCommand).toContain('-p 3002');
  });

  it('uses explicit existing-server mode without starting managed servers', () => {
    const runtime = resolveA3PlaywrightRuntime(
      {
        A3_PLAYWRIGHT_USE_EXISTING: '1',
        A3_PLAYWRIGHT_BASE_URL: 'http://localhost:3000',
      },
      path.resolve('OpenMAIC'),
    );

    expect(runtime.useExistingServers).toBe(true);
    expect(runtime.baseURL).toBe('http://localhost:3000');
    expect(runtime.port).toBe(3000);
  });

  it('rejects conflicting explicit base URL and managed ports', () => {
    expect(() =>
      resolveA3PlaywrightRuntime(
        {
          A3_PLAYWRIGHT_BASE_URL: 'http://localhost:3000',
          A3_PLAYWRIGHT_PORT: '3017',
        },
        path.resolve('OpenMAIC'),
      ),
    ).toThrow(/A3_PLAYWRIGHT_BASE_URL.*3000.*A3_PLAYWRIGHT_PORT.*3017/);
  });

  it('writes an explicit port into an HTTPS base URL without one', () => {
    const runtime = resolveA3PlaywrightRuntime(
      {
        A3_PLAYWRIGHT_USE_EXISTING: '1',
        A3_PLAYWRIGHT_BASE_URL: 'https://preview.example.test/a3',
        A3_PLAYWRIGHT_PORT: '3443',
      },
      path.resolve('OpenMAIC'),
    );

    expect(runtime.useExistingServers).toBe(true);
    expect(runtime.port).toBe(3443);
    expect(runtime.baseURL).toBe('https://preview.example.test:3443/a3');
  });

  it('writes the default managed port into a base URL without one', () => {
    const runtime = resolveA3PlaywrightRuntime(
      { A3_PLAYWRIGHT_BASE_URL: 'http://localhost/a3' },
      path.resolve('OpenMAIC'),
    );

    expect(runtime.port).toBe(3002);
    expect(runtime.baseURL).toBe('http://localhost:3002/a3');
    expect(runtime.frontendCommand).toContain('-p 3002');
  });

  it('builds backend commands from the configured project root and Python', () => {
    const backendRoot = path.resolve('D:/configured-a3');
    const python = path.resolve('D:/python/python.exe');
    const runtime = resolveA3PlaywrightRuntime(
      {
        A3_BACKEND_PROJECT_ROOT: backendRoot,
        A3_BACKEND_PYTHON: python,
        A3_PLAYWRIGHT_PORT: '3017',
      },
      path.resolve('OpenMAIC'),
    );

    expect(runtime.port).toBe(3017);
    expect(runtime.baseURL).toBe('http://localhost:3017');
    expect(runtime.backendProjectRoot).toBe(backendRoot);
    expect(runtime.backendPython).toBe(python);
    expect(runtime.backendManagePy).toBe(path.join(backendRoot, 'backend', 'manage.py'));
    expect(runtime.backendCommand).toContain(python);
    expect(runtime.backendCommand).toContain(runtime.backendManagePy);
    expect(runtime.backendCommand).toContain('set DJANGO_DEBUG=1');
    expect(runtime.backendCommand).toContain('backend.config.test_sqlite_settings');
    expect(runtime.backendCommand).toContain('migrate --noinput');
  });

  it('isolates a managed backend on an explicit port and uses webpack in local worktrees', () => {
    const runtime = resolveA3PlaywrightRuntime(
      {
        A3_PLAYWRIGHT_PORT: '3017',
        A3_PLAYWRIGHT_BACKEND_PORT: '8017',
      },
      path.resolve('OpenMAIC'),
    );

    expect(runtime.backendPort).toBe(8017);
    expect(runtime.backendURL).toBe('http://localhost:8017');
    expect(runtime.backendCommand).toContain('localhost:8017');
    expect(runtime.frontendCommand).toContain('next.CMD dev --webpack');
  });
});
