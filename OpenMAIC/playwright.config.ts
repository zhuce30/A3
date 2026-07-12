import { defineConfig, devices } from '@playwright/test';
import { resolveA3PlaywrightRuntime } from './e2e/playwright-runtime';

const runtime = resolveA3PlaywrightRuntime();

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: runtime.baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: runtime.useExistingServers
    ? undefined
    : [
        {
          command: runtime.frontendCommand,
          url: runtime.baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: runtime.backendCommand,
          url: 'http://localhost:8000/api/auth/csrf/',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});
