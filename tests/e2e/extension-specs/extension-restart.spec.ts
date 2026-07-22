import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourceExtensionPath = path.resolve(__dirname, '../../../extension');
const apiBase = 'http://127.0.0.1:4178';
const siteBase = 'http://127.0.0.2:4178';

test('browser restart preserves consent and native host access but clears URL-bearing session state', async () => {
  test.setTimeout(60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-restart-'));
  const extensionPath = path.join(root, 'extension');
  const userDataDir = path.join(root, 'profile');
  fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, `${apiBase}/*`, `${siteBase}/*`])];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(extensionPath, 'lib', 'runtime-config.js'), `
(function initRuntimeConfig(global) {
  global.AniRekoRuntimeConfig = Object.freeze({ apiBase: '${apiBase}', testMode: true });
})(typeof globalThis !== 'undefined' ? globalThis : self);
`, 'utf8');

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    let worker: Worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/popup.html?testOrigin=${encodeURIComponent(siteBase)}`);
    await setup.evaluate(async () => {
      await chrome.storage.local.set({
        'privacy-consent': { version: 1, acceptedAt: Date.now(), diagnostics: false },
      });
      await chrome.storage.session.set({
        'tab:999999': { pageUrl: 'https://private.example/watch?token=secret' },
      });
    });
    expect(await setup.evaluate(async (origin) =>
      chrome.permissions.contains({ origins: [`${origin}/*`] }), siteBase)).toBe(true);
    const cdp = await context.newCDPSession(setup);
    const closed = context.waitForEvent('close');
    await cdp.send('Browser.close');
    await closed;
    context = null;

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const page = await context.newPage();
    await page.goto(`${siteBase}/anime.html`);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    expect(new URL(worker.url()).host).toBe(extensionId);
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html?testOrigin=${encodeURIComponent(siteBase)}`);
    expect(await control.evaluate(async () =>
      (await chrome.storage.session.get('tab:999999'))['tab:999999'])).toBeUndefined();
    expect(await control.evaluate(async () => {
      const stored = await chrome.storage.local.get('privacy-consent');
      return Number(stored['privacy-consent']?.acceptedAt || 0) > 0;
    })).toBe(true);
    await expect.poll(() => control.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.values(all).some((state: any) => state?.match?.status === 'ok');
    }), { timeout: 15_000 }).toBe(true);
  } finally {
    await context?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
