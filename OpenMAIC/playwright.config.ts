import { defineConfig, devices } from '@playwright/test';

const useExistingServers = process.env.A3_PLAYWRIGHT_USE_EXISTING === '1';
const baseURL = process.env.A3_PLAYWRIGHT_BASE_URL ?? 'http://localhost:3002';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: useExistingServers ? undefined : [
    {
      command: process.env.CI ? 'pnpm build && pnpm start -- -p 3002' : 'cmd /c node_modules\\.bin\\next.CMD dev -p 3002',
      url: 'http://localhost:3002',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'cmd /c set A3_KB_SYNC_INDEX_ON_UPLOAD=1&& ..\\backend\\.venv\\Scripts\\python.exe ..\\backend\\manage.py runserver 127.0.0.1:8000 --noreload',
      url: 'http://localhost:8000/api/auth/csrf/',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
