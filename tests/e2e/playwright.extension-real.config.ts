import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './extension-real-specs',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
