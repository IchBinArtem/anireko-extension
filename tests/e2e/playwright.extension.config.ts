import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './extension-specs',
  globalSetup: path.resolve(__dirname, 'extension-specs/global-setup.cjs'),
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
