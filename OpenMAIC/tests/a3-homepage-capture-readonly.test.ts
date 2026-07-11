import http from 'node:http';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';

type CaptureRequestPolicy = {
  action: 'continue' | 'abort';
  reason: 'read' | 'login' | 'internal' | 'forbidden-write';
};

type BlockedWrite = {
  method: string;
  url: string;
};

async function loadCapturePolicy() {
  return (await import('../scripts/a3-homepage-capture-policy.mjs')) as {
    classifyCaptureRequest: (
      method: string,
      url: string,
      options: { allowedOrigin: string },
    ) => CaptureRequestPolicy;
    installCaptureRequestPolicy: (
      context: import('@playwright/test').BrowserContext,
      options: {
        allowedOrigin: string;
        onBlockedWrite: (write: BlockedWrite) => void;
      },
    ) => Promise<void>;
  };
}

describe('A3 homepage capture request policy', () => {
  it('allows reads and the exact login endpoint while denying other writes', async () => {
    const { classifyCaptureRequest } = await loadCapturePolicy();
    const classify = (method: string, url: string) =>
      classifyCaptureRequest(method, url, { allowedOrigin: 'http://127.0.0.1' });

    expect(classify('GET', 'http://127.0.0.1/api/learning/classroom/')).toEqual({
      action: 'continue',
      reason: 'read',
    });
    expect(classify('POST', 'http://127.0.0.1/api/auth/login/')).toEqual({
      action: 'continue',
      reason: 'login',
    });
    expect(classify('POST', 'http://127.0.0.1/__nextjs_original-stack-frames')).toEqual({
      action: 'continue',
      reason: 'internal',
    });
    expect(classify('DELETE', 'http://127.0.0.1/__nextjs_original-stack-frames')).toEqual({
      action: 'abort',
      reason: 'forbidden-write',
    });
    expect(classify('POST', 'http://127.0.0.1/api/business-write')).toEqual({
      action: 'abort',
      reason: 'forbidden-write',
    });
    expect(classify('PATCH', 'http://127.0.0.1/api/auth/login/')).toEqual({
      action: 'abort',
      reason: 'forbidden-write',
    });
  });

  it('blocks a login POST sent to a different origin', async () => {
    const { classifyCaptureRequest } = await loadCapturePolicy();

    expect(
      classifyCaptureRequest('POST', 'https://capture-attacker.invalid/api/auth/login/', {
        allowedOrigin: 'http://127.0.0.1:3000',
      }),
    ).toEqual({ action: 'abort', reason: 'forbidden-write' });
  });

  it('blocks an internal POST sent to a different origin', async () => {
    const { classifyCaptureRequest } = await loadCapturePolicy();

    expect(
      classifyCaptureRequest(
        'POST',
        'https://capture-attacker.invalid/__nextjs_original-stack-frames',
        { allowedOrigin: 'http://127.0.0.1:3000' },
      ),
    ).toEqual({ action: 'abort', reason: 'forbidden-write' });
  });

  it('aborts a business POST before the server receives it while allowing login', async () => {
    const { installCaptureRequestPolicy } = await loadCapturePolicy();
    const received = { login: 0, business: 0 };
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/auth/login/') {
        received.login += 1;
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'POST' && request.url === '/api/business-write') {
        received.business += 1;
        response.writeHead(204).end();
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html>');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Probe server did not bind a port');

    const browser = await chromium.launch();
    const context = await browser.newContext();
    const blockedWrites: BlockedWrite[] = [];

    try {
      await installCaptureRequestPolicy(context, {
        allowedOrigin: `http://127.0.0.1:${address.port}`,
        onBlockedWrite: (write) => blockedWrites.push(write),
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);

      const probe = await page.evaluate(async () => {
        const login = await fetch('/api/auth/login/', { method: 'POST', body: '{}' });
        let businessResult = 'resolved';
        try {
          await fetch('/api/business-write', { method: 'POST', body: '{}' });
        } catch {
          businessResult = 'rejected';
        }
        return { loginStatus: login.status, businessResult };
      });

      expect(probe).toEqual({ loginStatus: 204, businessResult: 'rejected' });
      expect(received).toEqual({ login: 1, business: 0 });
      expect(blockedWrites).toEqual([
        {
          method: 'POST',
          url: `http://127.0.0.1:${address.port}/api/business-write`,
        },
      ]);
    } finally {
      await context.close();
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);
});
