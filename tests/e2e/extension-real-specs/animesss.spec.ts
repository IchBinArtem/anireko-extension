import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourceExtensionPath = path.resolve(__dirname, '../../../extension');
const pageUrl = 'https://animesss.com/aniserials/video/seinen/3278-cugai-zagrobnogo-mira.html';

test('native Chrome host access recognizes the real animesss page in all frames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-real-site-'));
  const extensionPath = path.join(root, 'extension');
  const userDataDir = path.join(root, 'profile');
  fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => chrome.storage.local.set({
      'privacy-consent': { version: 1, acceptedAt: Date.now(), diagnostics: false },
    }));
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.content_scripts?.[0]).toMatchObject({
      matches: ['<all_urls>'],
      all_frames: true,
      match_origin_as_fallback: true,
      run_at: 'document_start',
    });

    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await expect(page).toHaveTitle(/Цугаи загробного мира/u);
    const tabId = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      if (!tab?.id) throw new Error('real-site tab not found');
      return tab.id;
    }, pageUrl);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);

    const readResult = () => worker.evaluate(async (key) => {
      const state = (await chrome.storage.session.get(key))[key];
      return {
        status: state?.match?.status || null,
        title: state?.match?.title || null,
      };
    }, `tab:${tabId}`);
    try {
      await expect.poll(readResult, { timeout: 25_000 }).toMatchObject({ status: 'ok' });
    } catch (error) {
      console.log('real-site diagnostics', JSON.stringify(await worker.evaluate(async () => ({
        local: await chrome.storage.local.get(['privacy-consent']),
        session: await chrome.storage.session.get(null),
        permissions: await chrome.permissions.getAll(),
      })), null, 2));
      throw error;
    }
    const result = await readResult();
    expect(result.title).toBeTruthy();
    expect(await worker.evaluate(() =>
      chrome.permissions.contains({ origins: ['<all_urls>'] }))).toBe(true);
    await expect(popup.locator('#anime-check')).toHaveClass(/success/u);
  } finally {
    await context?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
