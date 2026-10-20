import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const port = 5791;
const dataDir = path.join(os.tmpdir(), `aigc-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1480, height: 900 },
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  webServer: {
    command: `node packages/server/dist/server.cjs --port ${port} --data "${dataDir}"`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { AIGC_MOCK_TICK: '60' },
  },
});
