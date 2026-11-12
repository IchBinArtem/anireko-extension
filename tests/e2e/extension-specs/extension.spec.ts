import { test as baseTest, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourceExtensionPath = process.env.ANIREKO_EXTENSION_TEST_SOURCE
  ? path.resolve(process.env.ANIREKO_EXTENSION_TEST_SOURCE)
  : path.resolve(__dirname, '../../../extension');
const fixturePort = Number(process.env.ANIREKO_EXTENSION_FIXTURE_PORT || 4178);
const apiBase = `http://127.0.0.1:${fixturePort}`;
const siteBase = `http://127.0.0.2:${fixturePort}`;
const playerBase = `http://localhost:${fixturePort}`;

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let userDataDir: string;
let testRootDir: string;
let extensionPath: string;

async function cleanupExtensionFixture(
  close: () => Promise<void>,
  roots: [string | undefined, string][],
  remove: (root: string) => void = (root) => fs.rmSync(root, { recursive: true, force: true })
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try { await close(); } catch (error) { errors.push(error); }
  for (const [root, prefix] of roots) {
    if (!root) continue;
    try {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)
        || (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())) {
        throw new Error('unsafe_extension_fixture_cleanup_target');
      }
      remove(resolved);
    } catch (error) { errors.push(error); }
  }
  return errors;
}

const test = baseTest.extend<{}, { extensionLifecycle: void }>({
  extensionLifecycle: [async ({}, use) => {
    let setupError: unknown;
    try {
      await setupExtension();
      await use();
    } catch (error) {
      setupError = error;
      throw error;
    } finally {
      const errors = await cleanupExtensionFixture(() => context?.close() ?? Promise.resolve(),
        [[userDataDir, 'anireko-extension-e2e-'], [testRootDir, 'anireko-extension-build-']]);
      if (errors.length && setupError !== undefined) console.error('secondary extension fixture cleanup failures', errors);
      else if (errors.length) throw new AggregateError(errors, 'extension fixture cleanup failed');
    }
  }, { scope: 'worker', auto: true }],
});

test('extension fixture cleanup attempts all owned roots and preserves foreign state', async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-e2e-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-build-'));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-foreign-fixture-'));
  fs.writeFileSync(path.join(foreign, 'sentinel'), 'preserve');
  try {
    const attempted: string[] = [];
    const errors = await cleanupExtensionFixture(async () => { throw new Error('close failure'); },
      [[first, 'anireko-extension-e2e-'], [second, 'anireko-extension-build-'], [foreign, 'anireko-extension-e2e-']],
      (root) => { attempted.push(root); if (root === first) throw new Error('first delete failure'); fs.rmSync(root, { recursive: true }); });
    expect(errors).toHaveLength(3);
    expect(attempted).toEqual([first, second]);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8')).toBe('preserve');
    // Partial setup: no browser/profile yet, but an exact build directory exists.
    const partial = await cleanupExtensionFixture(async () => {}, [[undefined, 'anireko-extension-e2e-'], [first, 'anireko-extension-e2e-']]);
    expect(partial).toEqual([]);
    expect(fs.existsSync(first)).toBe(false);
  } finally {
    for (const root of [first, second, foreign]) fs.rmSync(root, { recursive: true, force: true });
  }
});

async function setSyntheticPlayback(
  frame: ReturnType<Page['frameLocator']>,
  selector: string,
  state: { currentTime: number; paused: boolean }
) {
  await frame.locator(selector).evaluate((video, next) => {
    return new Promise<void>((resolve, reject) => {
      const media = video as HTMLVideoElement;
      const run = async () => {
        try {
          media.muted = true;
          if (!next.paused) await media.play();
          else media.pause();
          if (Math.abs(media.currentTime - next.currentTime) > 0.05) {
            await new Promise<void>((seeked) => {
              media.addEventListener('seeked', () => seeked(), { once: true });
              media.currentTime = next.currentTime;
            });
          }
          media.dispatchEvent(new Event('timeupdate'));
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      if (media.readyState >= HTMLMediaElement.HAVE_METADATA) void run();
      else media.addEventListener('loadedmetadata', () => void run(), { once: true });
    });
  }, state);
}

async function extensionTabId(urlPattern: string): Promise<number> {
  return worker.evaluate(async (pattern) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    if (tab?.id == null) throw new Error(`Extension test tab not found: ${pattern}`);
    return tab.id;
  }, urlPattern);
}

async function openPopup(tabId: number, origin = siteBase): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}&testOrigin=${encodeURIComponent(origin)}`);
  return popup;
}

async function storedTabState(tabId: number) {
  return worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `tab:${tabId}`);
}

async function waitForPlayerProgress(tabId: number, expectedProgress: number) {
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return state?.player?.progress ?? null;
  }).toBeCloseTo(expectedProgress, 4);
}

async function waitForDetectorReady(tabId: number) {
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return Object.keys(state?.players || {}).length;
  }, { timeout: 10_000 }).toBeGreaterThan(0);
}

async function setupExtension() {
  expect(fs.existsSync(path.join(sourceExtensionPath, 'manifest.json'))).toBe(true);
  testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-build-'));
  extensionPath = path.join(testRootDir, 'extension');
  fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
  const testManifestPath = path.join(extensionPath, 'manifest.json');
  const testManifest = JSON.parse(fs.readFileSync(testManifestPath, 'utf8'));
  testManifest.host_permissions = [...new Set([
    ...testManifest.host_permissions,
    `${apiBase}/*`, `${siteBase}/*`, `${playerBase}/*`, '<all_urls>',
  ])];
  fs.writeFileSync(testManifestPath, `${JSON.stringify(testManifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(extensionPath, 'lib', 'runtime-config.js'), `
(function initRuntimeConfig(global) {
  global.AniRekoRuntimeConfig = Object.freeze({
    apiBase: '${apiBase}',
    testMode: true,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
`, 'utf8');
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: 'ru-RU',
    args: [
      '--lang=ru',
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  const setupPopup = await context.newPage();
  await setupPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(setupPopup.locator('.brand-mark')).toHaveAttribute('src', 'brand-mark.svg');
  await expect(setupPopup.locator('.brand-mark')).toBeVisible();
  await expect.poll(() => setupPopup.locator('.brand-mark').evaluate((image: HTMLImageElement) => ({
    complete: image.complete,
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ complete: true, width: 64, height: 64 });
  await expect(setupPopup.locator('#privacy-disclosure')).toBeVisible();
  await setupPopup.locator('#privacy-accept').click();
  await expect.poll(() => worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('privacy-consent');
    return Number(stored['privacy-consent']?.acceptedAt || 0);
  })).toBeGreaterThan(0);
  const setupPage = await context.newPage();
  await setupPage.goto(`${siteBase}/anime.html`);
  const setupTabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(setupTabId))?.match?.status ?? null).toBe('ok');
  await setupPage.close();
}

test.beforeEach(async () => {
  await worker.evaluate(async () => {
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/reset');
    (globalThis as any).AniRekoTestHooks.resetVolatileCaches();
    const access = await chrome.storage.local.get(['privacy-consent']);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(access);
  });
});

async function popupReadGate(kind: 'session' | 'history', query = '') {
  return worker.evaluate(async ({ kind, query }) => {
    const response = await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase
      + '/__test/popup-read-gate?kind=' + kind + query);
    return response.json();
  }, { kind, query });
}

async function localPopupPage() {
  await worker.evaluate(async () => {
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  await waitForDetectorReady(tabId);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', { currentTime: 1, paused: false });
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', { currentTime: 1, paused: true });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.playing).toBe(false);
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    await (globalThis as any).AniRekoTestHooks.seedLocalHistory({ records: {}, days: {
      [key]: { watchedSeconds: 600, episodeKeys: ['local::2'] },
    } });
  });
  return { page, tabId };
}

for (const status of ['active', 'paused', 'noDate'] as const) {
  test(`popup current-cycle resume restores saved position and voice (${status})`, async ({}, testInfo) => {
    const { page, tabId } = await localPopupPage();
    let popup: Page | null = null;
    try {
      await worker.evaluate(async (mode) => {
        const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
        await fetch(base + '/__test/cycle-history?resume=' + (mode === 'noDate' ? 'paused&noDate=1' : mode));
      }, status);
      popup = await openPopup(tabId);
      await expect(popup.locator('#resume-label')).toHaveText('Где остановился');
      await expect(popup.locator('#resume')).toBeVisible();
      await expect(popup.locator('#resume')).toContainText('Серия 1 · 22:51 · Dream Cast');
      if (status === 'noDate') await expect(popup.locator('#resume')).toHaveText('Серия 1 · 22:51 · Dream Cast');
      else await expect(popup.locator('#resume')).toContainText('Обновлено:');
      const resumeBox = await popup.locator('#anime-fields').boundingBox();
      const statsBox = await popup.locator('#stats-card').boundingBox();
      expect(resumeBox).not.toBeNull(); expect(statsBox).not.toBeNull();
      expect(resumeBox!.y).toBeLessThan(statsBox!.y);
      const commands = () => worker.evaluate(async () => (await (await fetch(
        (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history')).json()).posts);
      expect(await commands()).toEqual([], 'read-only resume opening cannot start, adopt or migrate');
      await popup.setViewportSize({ width: 390, height: 850 });
      const resumeScreenshot = testInfo.outputPath('current-cycle-resume.png');
      await popup.screenshot({ path: resumeScreenshot, fullPage: true });
      await testInfo.attach('current-cycle-resume', { path: resumeScreenshot, contentType: 'image/png' });
      if (status === 'active') {
        await popup.getByText('Управление вручную', { exact: true }).click();
        await popup.getByRole('button', { name: /^Приостановить просмотр/ }).click();
        await expect(popup.locator('#watch-current')).toContainText('Просмотр на паузе');
        await expect(popup.locator('#resume')).toContainText('Серия 1 · 22:51 · Dream Cast');
        expect((await commands()).map((item: any) => item.command)).toEqual(['pause']);
      }
      await popup.close();
      popup = await openPopup(tabId);
      await expect(popup.locator('#resume')).toContainText('Серия 1 · 22:51 · Dream Cast');
    } finally {
      await popup?.close();
      await page.close();
    }
  });
}

test('popup manual Sync refreshes the authoritative cycle resume in the same popup', async () => {
  const { page, tabId } = await localPopupPage();
  let popup: Page | null = null;
  try {
    await worker.evaluate(async () => { await fetch(
      (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history?resume=active'); });
    popup = await openPopup(tabId);
    await expect(popup.locator('#resume')).toContainText('22:51 · Dream Cast');
    await expect(popup.locator('#resume-sync')).toBeEnabled();
    await popup.locator('#resume-sync').click();
    await expect(popup.locator('#resume-sync')).toHaveText('✓ обновлено');
    await expect(popup.locator('#resume')).toContainText('Серия 2 · 0:01 · AniTime Voice');
    await expect(popup.locator('#resume')).not.toContainText('Dream Cast');
    const commands = await worker.evaluate(async () => (await (await fetch(
      (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history')).json()).posts);
    expect(commands.filter((item: any) => item.command === 'progress')).toHaveLength(1);
    expect(commands.find((item: any) => item.command === 'progress')).toMatchObject({ episode: 2, position_sec: 1, voice: 'AniTime Voice' });
  } finally {
    await popup?.close();
    await page.close();
  }
});

for (const kind of ['session', 'history'] as const) {
  for (const warm of [false, true]) {
    test(`popup local fields precede held ${kind} HTTP response (${warm ? 'warm' : 'cold'})`, async ({}, testInfo) => {
      const { page, tabId } = await localPopupPage();
      let popup: Page | null = null;
      try {
        if (warm) {
          const first = await openPopup(tabId);
          await expect(first.locator('#watch-completion')).toContainText('Уже просмотрено');
          await first.close();
        }
        const postsBefore = await worker.evaluate(async () => (await (await fetch(
          (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history')).json()).posts);
        await popupReadGate(kind, '&hold=1');
        popup = await context.newPage();
        await popup.addInitScript(() => {
          const observer = new MutationObserver(() => {
            const title = document.getElementById('anime-check-detail')?.textContent;
            const progress = document.getElementById('progress')?.textContent;
            if (title && progress && progress.includes('%') && (window as any).__localFirstMs == null) {
              (window as any).__localFirstMs = performance.now();
              observer.disconnect();
            }
          });
          observer.observe(document, { subtree: true, childList: true, characterData: true });
        });
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
        await expect.poll(async () => (await popupReadGate(kind)).pending).toBeGreaterThan(0);
        await expect(popup.locator('#anime-check-detail')).toContainText('Расхититель гробниц', { timeout: 1500 });
        await expect(popup.locator('#progress')).toHaveText(/\d+\.\d%/, { timeout: 1500 });
        await expect(popup.locator('#episode')).toContainText('2');
        await expect(popup.locator('#player')).not.toHaveText('—');
        await expect(popup.locator('#status')).not.toHaveText('—');
        await expect(popup.locator('#week-chart .activity-cell')).toHaveCount(84);
        await expect(popup.locator('#today-time')).toHaveText('10 мин');
        await expect(popup.locator('#resume')).toBeHidden();
        await expect(popup.locator('#resume-sync')).toBeDisabled();
        if (kind === 'session') {
          await expect(popup.locator('#auto-mark')).toBeDisabled();
          await expect(popup.locator('#taste-match')).toHaveText('—');
          await expect(popup.locator('#watch-cycle-card')).toBeHidden();
        }
        const held = await popupReadGate(kind);
        expect(held.held).toBe(true);
        expect(held.pending).toBeGreaterThan(0);
        const localFirstMs = await popup.evaluate(() => (window as any).__localFirstMs);
        expect(Number.isFinite(localFirstMs)).toBe(true);
        await testInfo.attach('local-before-network', { body: JSON.stringify({ kind, warm, localFirstMs, held }),
          contentType: 'application/json' });
        console.log('popup local-before-network ' + JSON.stringify({ kind, warm, localFirstMs }));
        await popupReadGate(kind, '&hold=0');
        await expect(popup.locator('#watch-completion')).toContainText('Уже просмотрено');
        await expect(popup.locator('#resume-sync')).toBeEnabled();
        await expect(popup.locator('#resume')).toBeHidden();
        const postsAfter = await worker.evaluate(async () => (await (await fetch(
          (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history')).json()).posts);
        expect(postsAfter).toEqual(postsBefore, 'popup opening only reads, including warm cache');
      } finally {
        await popupReadGate(kind, '&hold=0&status=200');
        await popup?.close();
        await page.close();
      }
    });
  }
}

test('popup keeps local UI on failed session and rejects old taste after an account switch during the read', async () => {
  const { page, tabId } = await localPopupPage();
  let popup: Page | null = null;
  try {
    await popupReadGate('session', '&hold=1');
    popup = await openPopup(tabId);
    await expect.poll(async () => (await popupReadGate('session')).pending).toBeGreaterThan(0);
    await expect(popup.locator('#progress')).toHaveText(/\d+\.\d%/, { timeout: 1500 });
    await worker.evaluate(async () => {
      await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=953');
    });
    await popupReadGate('session', '&hold=0');
    await expect(popup.locator('#account-label')).toContainText('Demo YooKassa');
    await expect(popup.locator('#account-warning')).toBeVisible();
    await expect(popup.locator('#resume-sync')).toBeDisabled();
    await expect(popup.locator('#taste-match')).not.toContainText('87%');
    await popup.close();
    await popupReadGate('session', '&hold=1&status=503');
    popup = await openPopup(tabId);
    await expect.poll(async () => (await popupReadGate('session')).pending).toBeGreaterThan(0);
    await expect(popup.locator('#progress')).toHaveText(/\d+\.\d%/, { timeout: 1500 });
    await popupReadGate('session', '&hold=0');
    await expect(popup.locator('#account-login')).toBeVisible();
    await expect(popup.locator('#auto-mark')).toBeDisabled();
    await expect(popup.locator('#resume-sync')).toBeDisabled();
    await expect(popup.locator('#taste-match')).not.toContainText('%');
  } finally {
    await popupReadGate('session', '&hold=0&status=200');
    await popup?.close();
    await page.close();
  }
});

test('paused playback preserves previous completion and exposes optional manual controls', async ({}, testInfo) => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history');
  });
  const page = await context.newPage();
  let popup: Page | null = null;
  try {
    await page.goto(`${siteBase}/anime.html`);
    const tabId = await extensionTabId(`${siteBase}/*`);
    await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
    popup = await openPopup(tabId);
    await popup.setViewportSize({ width: 390, height: 600 });
    await expect(popup.locator('#watch-cycle-card')).toBeVisible();
    await expect(popup.locator('#watch-completion')).toHaveText('Уже просмотрено · Завершено с начала учёта: 1');
    await expect(popup.locator('#watch-current')).toContainText('просмотр учтётся автоматически');
    const commands = () => worker.evaluate(async () => {
      const response = await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history');
      return (await response.json()).posts;
    });
    expect(await commands()).toEqual([]);
    await popup.getByText('Управление вручную', { exact: true }).click();
    await popup.getByRole('button', { name: 'Начать новый просмотр', exact: true }).click();
    await expect(popup.locator('#watch-current')).toContainText('Пересматриваю');
    await expect(popup.locator('#watch-actions details')).toHaveAttribute('open', '');
    const completionBox = await popup.locator('#watch-completion').boundingBox();
    const activityBox = await popup.locator('#stats-card').boundingBox();
    expect(completionBox).not.toBeNull(); expect(activityBox).not.toBeNull();
    expect(completionBox!.y + completionBox!.height).toBeLessThanOrEqual(600);
    expect(completionBox!.y).toBeLessThan(activityBox!.y);
    await expect(popup.locator('#watch-current')).not.toContainText('Цикл');
    await expect(popup.locator('#watch-completion')).toHaveText('Уже просмотрено · Завершено с начала учёта: 1');
    expect((await commands()).map((command: any) => command.command)).toEqual(['start']);
    const screenshotPath = testInfo.outputPath('watch-cycle-popup.png');
    await popup.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('watch-cycle-popup', { path: screenshotPath, contentType: 'image/png' });
    await popup.getByRole('button', { name: /Приостановить просмотр/ }).click();
    await expect(popup.locator('#watch-current')).toContainText('Просмотр на паузе');
    await expect(popup.locator('#watch-actions details')).toHaveAttribute('open', '');
    await expect(popup.getByRole('button', { name: /Продолжить просмотр/ })).toBeVisible();
    await expect(popup.locator('#watch-completion')).toHaveText('Уже просмотрено · Завершено с начала учёта: 1');
    await expect(popup.locator('#watch-current')).toContainText('Просмотр на паузе');
    expect((await commands()).map((command: any) => command.command)).toEqual(['start', 'pause']);
    await expect(popup.locator('#resume')).toBeHidden();
  } finally {
    await popup?.close();
    await page.close();
  }
});

test('natural playback starts a repeat without popup and later confirms already watched', async ({}, testInfo) => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history');
  });
  const page = await context.newPage(); let popup: Page | null = null;
  const commands = () => worker.evaluate(async () => (await (await fetch(
    (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history')).json()).posts);
  try {
    await page.goto(`${siteBase}/anime.html`);
    const tabId = await extensionTabId(`${siteBase}/*`);
    await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
    await waitForDetectorReady(tabId);
    expect(await commands()).toEqual([], 'opening a paused page is not a new watch');
    await page.frameLocator('#main-player').locator('#episode-select').selectOption({ label: '1 серия' });
    await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', { currentTime: 0, paused: false });
    await expect.poll(async () => (await commands()).filter((request: any) => request.command === 'start').length,
      { timeout: 18000 }).toBe(1);
    expect((await commands())[0].command).toBe('start', 'no retrobound progress before Start');
    popup = await openPopup(tabId);
    await popup.setViewportSize({ width: 390, height: 600 });
    await expect(popup.locator('#watch-completion')).toHaveText('Уже просмотрено · Завершено с начала учёта: 1');
    await expect(popup.locator('#watch-current')).toContainText('Пересматриваю');
    const completionBox = await popup.locator('#watch-completion').boundingBox();
    const activityBox = await popup.locator('#stats-card').boundingBox();
    expect(completionBox).not.toBeNull(); expect(activityBox).not.toBeNull();
    expect(completionBox!.y + completionBox!.height).toBeLessThanOrEqual(600);
    expect(completionBox!.y).toBeLessThan(activityBox!.y);
    await expect(popup.getByRole('button', { name: 'Начать новый просмотр', exact: true })).toBeHidden();
    const screenshotPath = testInfo.outputPath('automatic-repeat-popup.png');
    await popup.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('automatic-repeat-popup', { path: screenshotPath, contentType: 'image/png' });
    expect((await commands()).filter((request: any) => request.command === 'start')).toHaveLength(1);
  } finally { await popup?.close(); await page.close(); }
});

test('native movie Complete80 then close/reopen starts one repeat without popup and preserves completion', async () => {
  test.setTimeout(45000);
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history?movie=1');
  });
  const commands = () => worker.evaluate(async () => (await (await fetch(
    (globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history')).json()).posts);
  let page = await context.newPage(); let popup: Page | null = null;
  try {
    await page.goto(`${siteBase}/movie-anime.html`);
    let tabId = await extensionTabId(`${siteBase}/movie-anime.html`);
    await waitForDetectorReady(tabId);
    await setSyntheticPlayback(page.frameLocator('#movie-player'), '#movie-video', { currentTime: 0, paused: false });
    await expect.poll(async () => (await commands()).filter((r: any) => r.command === 'start').length,
      { timeout: 18000 }).toBe(1);
    await setSyntheticPlayback(page.frameLocator('#movie-player'), '#movie-video', { currentTime: 255, paused: false });
    await expect.poll(async () => (await commands()).filter((r: any) => r.command === 'complete').length,
      { timeout: 12000 }).toBe(1);
    expect(await page.frameLocator('#movie-player').locator('#movie-video').evaluate(v => (v as HTMLVideoElement).ended)).toBe(false);
    await page.close(); page = await context.newPage();
    await page.goto(`${siteBase}/movie-anime.html`);
    tabId = await extensionTabId(`${siteBase}/movie-anime.html`);
    await waitForDetectorReady(tabId);
    expect((await commands()).filter((r: any) => r.command === 'start')).toHaveLength(1);
    await setSyntheticPlayback(page.frameLocator('#movie-player'), '#movie-video', { currentTime: 0, paused: false });
    await expect.poll(async () => (await commands()).filter((r: any) => r.command === 'start').length,
      { timeout: 18000 }).toBe(2);
    popup = await openPopup(tabId);
    await expect(popup.locator('#watch-completion')).toHaveText('Уже просмотрено · Завершено с начала учёта: 2');
    await expect(popup.locator('#watch-current')).toContainText('Пересматриваю');
    expect((await commands()).filter((r: any) => r.command === 'complete')).toHaveLength(1);
  } finally { await popup?.close(); await page.close(); }
});

test('cycle settlement preserves lost-ACK intent across account transfer and popup reopen', async ({}, testInfo) => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history?lostAck=1');
  });
  const page = await context.newPage(); let popup: Page | null = null;
  const pending = () => worker.evaluate(async () =>
    (await chrome.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1']);
  const receipts = () => worker.evaluate(async () => {
    const response = await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history');
    return response.json();
  });
  try {
    await page.goto(`${siteBase}/anime.html`);
    const tabId = await extensionTabId(`${siteBase}/*`);
    await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
    popup = await openPopup(tabId);
    await popup.getByText('Управление вручную', { exact: true }).click();
    await popup.getByRole('button', { name: 'Начать новый просмотр', exact: true }).click();
    await expect(popup.locator('#watch-feedback')).toHaveText('Сохранение не подтверждено.');
    await expect(popup.locator('#watch-current')).not.toContainText('Запустите видео');
    expect(await popup.locator('#watch-feedback').evaluate(node => ({
      top: getComputedStyle(node).marginTop, bottom: getComputedStyle(node).marginBottom,
    }))).toEqual({ top: '4px', bottom: '4px' });
    const original = await pending();
    expect(original.version).toBe(1);
    expect(original.acknowledged).toBe(false);
    expect((await receipts()).posts).toHaveLength(1);
    const pendingDetails = popup.locator('#watch-actions details');
    await expect(pendingDetails).not.toHaveAttribute('open', '');
    await expect(popup.getByRole('button', { name: 'Проверить результат', exact: true })).toBeHidden();
    await expect(popup.getByRole('button', { name: 'Повторить исходную команду' })).toBeHidden();
    await expect(pendingDetails.locator('.watch-choice-hint')).toBeHidden();
    await popup.setViewportSize({ width: 390, height: 850 });
    const pendingScreenshot = testInfo.outputPath('pending-collapsed-ru.png');
    await popup.screenshot({ path: pendingScreenshot, fullPage: true });
    await testInfo.attach('pending-collapsed-ru', { path: pendingScreenshot, contentType: 'image/png' });
    await pendingDetails.locator('summary').click();
    await expect(pendingDetails).toHaveAttribute('open', '');
    await expect(pendingDetails.locator('.watch-choice-hint')).toBeVisible();
    await expect(pendingDetails.locator('.watch-choice-hint')).toContainText('позднее выполнение будет запрещено');
    await expect(popup.getByRole('button', { name: 'Проверить результат', exact: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Повторить исходную команду' })).toBeVisible();
    const expandedScreenshot = testInfo.outputPath('pending-expanded-ru.png');
    await popup.screenshot({ path: expandedScreenshot, fullPage: true });
    await testInfo.attach('pending-expanded-ru', { path: expandedScreenshot, contentType: 'image/png' });
    expect((await receipts()).posts).toHaveLength(1, 'opening details does not retry');
    expect((await receipts()).settlementPosts).toEqual([], 'opening details does not settle');
    await popup.close(); popup = null;
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ 'sync-account': { id: 19, name: 'MergedOwner' } });
      await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=19');
    });
    popup = await openPopup(tabId);
    await expect(popup.locator('#watch-feedback')).toContainText('Неподтверждённое сохранение связано с другим аккаунтом');
    const settle = () => popup!.getByRole('button', { name: 'Проверить результат', exact: true });
    await popup.getByText('Подробнее', { exact: true }).click();
    await expect(settle()).toBeVisible();
    expect(await pending()).toEqual(original);
    expect((await receipts()).settlementPosts).toEqual([]);
    await settle().click();
    await expect(settle()).toBeEnabled();
    await expect.poll(async () => (await receipts()).settlementPosts.length).toBe(1);
    expect(await pending()).toEqual(original);
    await popup.close(); popup = await openPopup(tabId);
    await popup.getByText('Подробнее', { exact: true }).click();
    await expect(settle()).toBeVisible();
    expect((await receipts()).settlementPosts).toHaveLength(1);
    expect((await receipts()).posts).toHaveLength(1);
    await settle().click();
    await expect.poll(pending).toBeUndefined();
    await expect(popup.locator('#watch-current')).toContainText('Пересматриваю');
    await expect(popup.locator('#watch-completion')).toContainText('Уже просмотрено');
    const observed = await receipts();
    expect(observed.posts).toHaveLength(1);
    expect(observed.settlementPosts).toHaveLength(2);
    for (const attempt of observed.settlementPosts) {
      expect(attempt.currentUser).toBe(19);
      expect(attempt.payload).toEqual({ ...observed.posts[0], operation: 'settle' });
      expect(attempt.payload.expected_user_id).toBe(18);
    }
  } finally { await popup?.close(); await page.close(); }
});

test('Cancel survives actual MV3 worker stop while the same video keeps playing', async ({}, testInfo) => {
  // Includes two fresh detector intervals after a real worker stop and another
  // real play; this new lifecycle scenario has a bounded 45s budget, no retries.
  test.setTimeout(45000);
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history');
  });
  const page = await context.newPage(); let popup: Page | null = null; let observer: Page | null = null;
  const commands = () => (observer || popup || worker).evaluate(async base =>
    (await (await fetch(base + '/__test/cycle-history')).json()).posts, apiBase);
  const session = await context.newCDPSession(page);
  try {
    await page.goto(`${siteBase}/anime.html`);
    await page.frameLocator('#main-player').locator('#episode-select').selectOption({ label: '1 серия' });
    const tabId = await extensionTabId(`${siteBase}/*`);
    await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
    popup = await openPopup(tabId);
    await popup.getByText('Управление вручную', { exact: true }).click();
    await popup.getByRole('button', { name: 'Начать новый просмотр', exact: true }).click();
    await expect(popup.locator('#watch-current')).toContainText('Пересматриваю');
    await popup.close(); popup = null;
    await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', { currentTime: 0, paused: false });
    await expect.poll(async () => (await storedTabState(tabId))?.player?.playing).toBe(true);
    popup = await openPopup(tabId);
    await popup.getByText('Управление вручную', { exact: true }).click();
    await popup.getByRole('button', { name: /Отменить этот просмотр/ }).click();
    await expect(popup.locator('#watch-current')).toContainText('просмотр учтётся автоматически');
    await expect(popup.locator('#watch-completion')).toContainText('Уже просмотрено');
    expect((await commands()).filter((request: any) => request.command === 'cancel')).toHaveLength(1);
    await expect.poll(() => worker.evaluate(async () =>
      (await chrome.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'])).toBeUndefined();
    const original = await storedTabState(tabId);
    const originalRevision = await popup.evaluate(async () =>
      (await chrome.runtime.sendMessage({ type: 'popup-runtime-info' })).payload.localWriteRevision);
    await popup.close(); popup = null;
    let versionId: string | undefined;
    let stopped = false;
    session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const own = versions.find(version => version.scriptURL === `chrome-extension://${extensionId}/service-worker.js`);
      if (own) { versionId = own.versionId; if (own.runningStatus === 'stopped') stopped = true; }
    });
    await session.send('ServiceWorker.enable');
    await expect.poll(() => versionId).toBeTruthy();
    stopped = false;
    await session.send('ServiceWorker.stopWorker', { versionId: versionId! });
    await expect.poll(() => stopped).toBe(true);
    // Explicitly wake the stopped registration; this tests a real worker restart,
    // not extension reload or automatic wake-up behavior.
    await session.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionId}/` });
    // The old Playwright Worker handle does not follow a new execution context.
    // Read through a real popup; require a changed runtime revision as proof.
    popup = await openPopup(tabId);
    const newRevision = await popup.evaluate(async () =>
      (await chrome.runtime.sendMessage({ type: 'popup-runtime-info' })).payload.localWriteRevision);
    expect(newRevision).not.toBe(originalRevision);
    await popup.close(); popup = null;
    // Read-only native extension storage observer, in the disposable fixture
    // copy only. No popup reload subscription and no emulated Chrome APIs.
    fs.writeFileSync(path.join(extensionPath, 'fixture-observer.html'), '<!doctype html><html><body>Read-only test observer</body></html>');
    observer = await context.newPage();
    await observer.goto(`chrome-extension://${extensionId}/fixture-observer.html`);
    const freshState = () => observer!.evaluate(async key =>
      (await chrome.storage.session.get(key))[key], `tab:${tabId}`);
    const firstFresh = await freshState();
    await expect.poll(async () => (await freshState())?.player?.observedAt,
      { timeout: 18000 }).toBeGreaterThan(firstFresh.player.observedAt + 5500);
    const current = await freshState();
    expect(current.topDocumentId).toBe(original.topDocumentId);
    expect(current.navigationToken).toBe(original.navigationToken);
    expect(current.player.playerInstanceId).toBe(original.player.playerInstanceId);
    expect(current.player.currentTime).toBeGreaterThan(original.player.currentTime);
    expect((await commands()).filter((request: any) => request.command === 'start')).toHaveLength(1);
    await page.frameLocator('#main-player').locator('#main-video').evaluate(video => (video as HTMLVideoElement).pause());
    await expect.poll(async () => (await freshState())?.player?.paused).toBe(true);
    await page.frameLocator('#main-player').locator('#main-video').evaluate(async video => (video as HTMLVideoElement).play());
    await expect.poll(async () => (await commands()).filter((request: any) => request.command === 'start').length,
      { timeout: 18000 }).toBe(2);
  } catch (error) {
    if (popup && !popup.isClosed()) {
      const artifact = testInfo.outputPath('cancel-restart-popup.png');
      await popup.screenshot({ path: artifact, fullPage: true });
      await testInfo.attach('cancel-restart-popup', { path: artifact, contentType: 'image/png' });
    }
    throw error;
  } finally {
    await session.detach(); await observer?.close(); await popup?.close(); await page.close();
    // Only after the assertions: restore the shared fixture's Playwright worker
    // handle using its already-supported loader, without uninstall/data clearing.
    const loader = await context.browser()!.newBrowserCDPSession();
    try {
      const restored = context.waitForEvent('serviceworker');
      const loaded = await loader.send('Extensions.loadUnpacked', { path: extensionPath });
      expect(loaded.id).toBe(extensionId);
      worker = await restored;
    } finally { await loader.detach(); }
  }
});

test('cycle repair requires separate explicit choices for complete related groups', async ({}, testInfo) => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    await fetch(base + '/__test/cycle-history?repair=1');
  });
  const page = await context.newPage(); let popup: Page | null = null;
  try {
    await page.goto(`${siteBase}/anime.html`);
    const tabId = await extensionTabId(`${siteBase}/*`);
    await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
    popup = await openPopup(tabId);
    const groups = popup.locator('.watch-choice-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(1).locator('legend')).toHaveText('Связанный тайтл');
    const apply = popup.getByRole('button', { name: 'Выбрать историю просмотра', exact: true });
    await expect(apply).toBeDisabled();
    expect(await popup.locator('.watch-choice-group input:checked').count()).toBe(0);
    await groups.nth(0).getByRole('radio').nth(1).check();
    await expect(apply).toBeDisabled();
    await groups.nth(1).getByRole('radio').nth(0).check();
    await expect(apply).toBeEnabled();
    await expect(popup.locator('#watch-completion')).toContainText('Уже просмотрено');
    const screenshotPath = testInfo.outputPath('watch-choice-popup.png');
    await popup.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('watch-choice-popup', { path: screenshotPath, contentType: 'image/png' });
    await apply.click();
    await expect(groups).toHaveCount(0);
    await expect(popup.locator('#watch-completion')).toContainText('Уже просмотрено');
    const posts = await worker.evaluate(async () => {
      const response = await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/cycle-history');
      return (await response.json()).posts;
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].operation).toBe('select');
    expect(posts[0].choices.map((choice: any) => choice.cycle_id)).toEqual([
      '33333333-3333-4333-8333-000000000002', '33333333-3333-4333-8333-000000000003']);
  } finally { await popup?.close(); await page.close(); }
});

test('renders browser-local activity as a calm calendar with honest missing days', async ({}, testInfo) => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  await worker.evaluate(async () => {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const boundaryDays = Object.fromEntries([899, 1799, 3599].map((seconds, index) => {
      const day = new Date(now);
      day.setDate(day.getDate() - index - 1);
      const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      return [date, { watchedSeconds: seconds, episodeKeys: [] }];
    }));
    await (globalThis as any).AniRekoTestHooks.seedLocalHistory({ records: {
      'first::1': { title: 'Mutable decoy', voice: 'Wrong voice', position: 9999, lastWatchedAt: Date.now() },
    }, days: {
      [key]: { watchedSeconds: 3600, episodeKeys: ['first::1', 'second::2'], detailsPartial: true,
        details: [
          { animeId: 101, titleKey: null, title: 'Первое аниме', episode: 1, voice: 'Озвучка А', watchedSeconds: 300, position: 120, duration: 1200, observedAt: Date.now() },
          { animeId: 101, titleKey: null, title: 'Первое аниме', episode: 3, voice: 'Озвучка В', watchedSeconds: 40, position: 80, duration: 1200, observedAt: Date.now() },
          { animeId: null, titleKey: 'second', title: 'Второе аниме', episode: 2, voice: 'Озвучка Б', watchedSeconds: 0, position: 20, duration: 900, observedAt: Date.now() },
        ] },
      ...boundaryDays,
      '2025-01-01': { watchedSeconds: 100000, episodeKeys: [] },
    } });
    (globalThis as any).AniRekoTestHooks.resetVolatileCaches();
  });
  const popup = await openPopup(tabId);
  await popup.setViewportSize({ width: 390, height: 900 });
  expect(await popup.evaluate(async () => Object.keys((await chrome.storage.local.get('watch-history'))['watch-history'].days))).toHaveLength(5);
  await expect(popup.locator('#week-chart .activity-cell')).toHaveCount(84);
  const grid = await popup.locator('#week-chart').boundingBox();
  const firstCell = await popup.locator('#week-chart .activity-cell').first().boundingBox();
  const lastCell = await popup.locator('#week-chart .activity-cell').last().boundingBox();
  expect(grid).not.toBeNull(); expect(firstCell).not.toBeNull(); expect(lastCell).not.toBeNull();
  expect(Math.abs(firstCell!.width - firstCell!.height)).toBeLessThan(1);
  expect(Math.abs(lastCell!.x + lastCell!.width - (grid!.x + grid!.width))).toBeLessThan(1);
  expect(firstCell!.width).toBeGreaterThan(12);
  await expect(popup.locator('#week-chart .level-unknown')).toHaveCount(80);
  await expect(popup.locator('.activity-cell.level-1')).toHaveAttribute('aria-label', /14 мин/);
  await expect(popup.locator('.activity-cell.level-2')).toHaveAttribute('aria-label', /29 мин/);
  await expect(popup.locator('.activity-cell.level-3')).toHaveAttribute('aria-label', /59 мин/);
  await expect(popup.locator('.activity-heading')).toContainText('этот браузер');
  await expect(popup.locator('.activity-cell.today')).toHaveClass(/level-4/);
  await popup.locator('.activity-cell.today').click();
  await expect(popup.locator('#activity-detail')).toContainText('60 мин');
  await expect(popup.locator('.activity-cell.today')).toHaveAttribute('aria-pressed', 'true');
  await expect(popup.locator('#activity-entries')).toContainText('Подробности за этот день неполные');
  await expect(popup.locator('.activity-entry').nth(0).locator('strong')).toHaveText('Первое аниме');
  await expect(popup.locator('.activity-entry').nth(0).locator('strong')).toHaveCount(1);
  await expect(popup.locator('.activity-entry').nth(0).locator('.activity-observation')).toHaveCount(2);
  await expect(popup.locator('.activity-entry').nth(0).locator('p').first()).toContainText('Серия 1 · Озвучка А');
  await expect(popup.locator('.activity-entry').nth(0).locator('.activity-observation').nth(1)).toContainText('Серия 3 · Озвучка В');
  await expect(popup.locator('.activity-entry').nth(1).locator('strong')).toHaveText('Второе аниме');
  await expect(popup.locator('.activity-entry').nth(1).locator('p').first()).toContainText('Серия 2 · Озвучка Б');
  await expect(popup.locator('#activity-entries')).toContainText('Зафиксировано без времени просмотра');
  await expect(popup.locator('#activity-entries')).toContainText('Последняя позиция: 2:00 из 20:00');
  await expect(popup.locator('#activity-entries')).not.toContainText('Mutable decoy');
  await expect(popup.locator('#activity-entries')).not.toContainText('Wrong voice');
  for (const width of [360, 390]) {
    await popup.setViewportSize({ width, height: 900 });
    const detailScreenshot = testInfo.outputPath(`activity-day-detail-grouped-ru-${width}.png`);
    await popup.screenshot({ path: detailScreenshot, fullPage: true });
    await testInfo.attach(`activity-day-detail-grouped-ru-${width}`, { path: detailScreenshot, contentType: 'image/png' });
  }
  await popup.locator('.activity-cell.today').press('ArrowUp');
  await expect(popup.locator('#activity-entries')).toContainText('Подробности за этот день недоступны');
  await expect(popup.locator('.activity-cell[tabindex="0"]')).toHaveAttribute('aria-pressed', 'true');
  await popup.locator('.activity-cell[tabindex="0"]').press('ArrowDown');
  await expect(popup.locator('#activity-entries')).toContainText('Первое аниме');
  await expect(popup.locator('#today-episodes')).toHaveAttribute('title', /не обязательно досмотренные/);
  await expect(popup.locator('.activity-cell.today')).toHaveCSS('background-color', 'rgb(52, 211, 153)');
  await expect(popup.locator('.activity-cell[tabindex="0"]')).toHaveCount(1);
  await popup.locator('.activity-cell.today').press('ArrowLeft');
  await expect(popup.locator('#activity-detail')).toContainText('Нет записи');
  await popup.locator('.activity-cell.level-unknown').first().focus();
  await expect(popup.locator('#activity-detail')).toContainText('Нет записи');
  await popup.screenshot({ path: test.info().outputPath('activity-heatmap.png'), fullPage: true });
  await popup.close();
  await page.close();
});

for (const kind of ['session', 'history'] as const) {
  test(`account UI rejects held ${kind} after preference revocation`, async () => {
    const originalConsent = await worker.evaluate(async () => (await chrome.storage.local.get('privacy-consent'))['privacy-consent']);
    const { page, tabId } = await localPopupPage();
    let popup: Page | null = null;
    try {
      await worker.evaluate(async () => {
        await chrome.storage.local.set({ 'resume-bulk': { userId: 18, fetchedAt: Date.now(), byAnime: {
          4343: { title: 'Remote-only record', episode: 7, position_sec: 1260, duration_sec: 1440,
            voice: 'Remote-only voice', watched_at: new Date().toISOString() },
        } } });
      });
      await popupReadGate(kind, '&hold=1');
      popup = await context.newPage();
      await popup.addInitScript(() => {
        const runtime = (chrome as any).runtime;
        const send = runtime.sendMessage.bind(runtime);
        (window as any).__settledAccountReads = {};
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && (changes['auto-mark'] || changes['privacy-consent'])) (window as any).__preferenceSeen = true;
        });
        runtime.sendMessage = (...args: any[]) => {
          const pending = send(...args);
          const type = args[0]?.type;
          if (!['popup-session-info', 'popup-watch-history'].includes(type)) return pending;
          return pending.then((response: any) => {
            (window as any).__settledAccountReads[type] = true;
            return response;
          });
        };
      });
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
      await expect.poll(async () => (await popupReadGate(kind)).pending).toBeGreaterThan(0);
      await worker.evaluate(async (kind) => {
        await chrome.storage.local.set(kind === 'session'
          ? { 'privacy-consent': { version: 1, declinedAt: Date.now() } }
          : { 'auto-mark': false });
      }, kind);
      await popup.waitForFunction(() => (window as any).__preferenceSeen === true);
      await popupReadGate(kind, '&hold=0');
      await popup.waitForFunction((kind) => (window as any).__settledAccountReads[
        kind === 'session' ? 'popup-session-info' : 'popup-watch-history'] === true, kind);
      await expect(popup.locator('#watch-cycle-card')).toBeHidden();
      await expect(popup.locator('#resume-sync')).toBeDisabled();
      await expect(popup.locator('.activity-account-entry')).toHaveCount(0);
      await expect(popup.locator('#resume')).not.toContainText('Remote-only voice');
      await expect(popup.locator('#today-time')).toHaveText('10 мин');
    } finally {
      await popupReadGate(kind, '&hold=0&status=200');
      await popup?.close(); await page.close();
      await worker.evaluate(async (consent) => {
        if (consent === undefined) await chrome.storage.local.remove('privacy-consent');
        else await chrome.storage.local.set({ 'privacy-consent': consent });
      }, originalConsent);
    }
  });
}

test('account calendar reuses one bounded bulk read and hides records after opt-out', async ({}, testInfo) => {
  await worker.evaluate(async () => {
    const base = (globalThis as any).AniRekoRuntimeConfig.apiBase;
    await fetch(base + '/__test/session?on=1&user=18');
    const seed = await fetch(base + '/api/extension/progress.php', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        expected_user_id: 18, anime_id: 4343, episode: 7, position_sec: 1260, duration_sec: 1440, voice: 'Account Voice',
      }) });
    if (!seed.ok) throw new Error('synthetic_progress_seed_failed');
  });
  const page = await context.newPage();
  let popup: Page | null = null;
  try {
    await page.goto(`${siteBase}/anime.html`);
    const tabId = await extensionTabId(`${siteBase}/*`);
    await waitForDetectorReady(tabId);
    popup = await openPopup(tabId);
    const localTime = await popup.locator('#today-time').innerText();
    await expect(popup.locator('.activity-account-entry')).toHaveCount(0);
    await popup.close(); popup = null;
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, name: 'TestUser' } });
    });
    const reads = () => worker.evaluate(async () => {
      const response = await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress-read-count');
      return (await response.json()).reads;
    });
    popup = await openPopup(tabId);
    await expect(popup.locator('#activity-heading')).toContainText('браузер + аккаунт');
    await expect(popup.locator('#week-chart .has-account-records')).toHaveCount(1);
    await expect(popup.locator('.activity-account-entry')).toHaveCount(1);
    await expect(popup.locator('.activity-account-entry')).toContainText('Аниме из аккаунта');
    await expect(popup.locator('.activity-account-entry')).toContainText('Серия 7');
    await expect(popup.locator('.activity-account-entry')).toContainText('Account Voice');
    await expect(popup.locator('.activity-account-entry')).toContainText('Сохранённая позиция: 21:00 из 24:00');
    await expect(popup.locator('#resume')).toBeHidden();
    await expect(popup.locator('#today-time')).toHaveText(localTime);
    expect(await reads()).toBe(1);
    await popup.close(); popup = await openPopup(tabId);
    await expect(popup.locator('.activity-account-entry')).toHaveCount(1);
    expect(await reads()).toBe(1, 'reopening reuses the same account snapshot, not another GET');
    const stored = await worker.evaluate(async () => (await chrome.storage.local.get('resume-bulk'))['resume-bulk']);
    expect(stored.userId).toBe(18);
    expect(Object.keys(stored.byAnime)).toEqual(['4343']);
    await popup.setViewportSize({ width: 390, height: 850 });
    await popup.screenshot({ path: testInfo.outputPath('account-calendar-ru.png'), fullPage: true });
    await worker.evaluate(async () => { await chrome.storage.local.set({ 'auto-mark': false }); });
    await expect(popup.locator('.activity-account-entry')).toHaveCount(0);
    await expect(popup.locator('#week-chart .has-account-records')).toHaveCount(0);
    expect(await reads()).toBe(1);
  } finally { await popup?.close(); await page.close(); }
});

test('renders the English manifest and popup for an English Chrome UI', async ({}, testInfo) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-en-'));
  const englishExtensionPath = path.join(root, 'extension');
  const englishProfilePath = path.join(root, 'profile');
  fs.cpSync(sourceExtensionPath, englishExtensionPath, { recursive: true });
  let englishContext: BrowserContext | null = null;
  try {
    englishContext = await chromium.launchPersistentContext(englishProfilePath, {
      channel: 'chromium',
      headless: true,
      locale: 'en-US',
      args: [
        '--lang=en-US',
        `--disable-extensions-except=${englishExtensionPath}`,
        `--load-extension=${englishExtensionPath}`,
      ],
    });
    const englishWorker = englishContext.serviceWorkers()[0]
      || await englishContext.waitForEvent('serviceworker');
    const englishExtensionId = new URL(englishWorker.url()).host;
    const englishPopup = await englishContext.newPage();
    await englishPopup.goto(`chrome-extension://${englishExtensionId}/popup.html`);

    await expect(englishPopup.locator('html')).toHaveAttribute('lang', 'en');
    await expect(englishPopup.locator('.brand h1')).toHaveText('AniReko');
    await expect(englishPopup.locator('#privacy-accept')).toHaveText('Got it, enable AniReko');
    await expect(englishPopup.locator('#anime-check-title')).toHaveText('Enable AniReko');
    await expect(englishPopup.locator('#page-recovery')).toBeHidden();
    await expect(englishPopup.locator('#privacy-policy')).toHaveAttribute(
      'href', 'https://anireko.com/en/privacy#browser-extension',
    );
    await expect.poll(() => englishWorker.evaluate(() => chrome.runtime.getManifest().name))
      .toBe('AniReko — Anime Tracker');
    // Presentation-only fixture: the real popup renderer and English i18n with
    // deterministic local state; no matcher or live service claim is made.
    const preview = await englishContext.newPage();
    await preview.addInitScript(() => {
      const title = 'A very long anime title which should remain fully readable and leave enough room for the primary action';
      const pageUrl = 'https://layout.example.test/watch';
      const state = { navigationToken: 'fixture-token', pageUrl, recognition: { title, episode: 1 },
        match: { status: 'ok', exact: true, animeId: 1, slug: 'fixture', title, year: 2024 },
        player: { player: 'HTML5', playing: false, playbackStarted: true, episode: 1,
          currentTime: 20, duration: 1200, progress: 20 / 1200 } };
      chrome.tabs.get = async () => ({ id: 1, url: pageUrl } as chrome.tabs.Tab);
      chrome.tabs.sendMessage = async () => ({ ok: true, documentUrl: pageUrl, documentToken: 'fixture-token' });
      chrome.storage.local.get = async () => ({ 'privacy-consent': { version: 1, acceptedAt: 1 }, 'watch-history': { records: {}, days: {} } });
      chrome.storage.session.get = async () => ({ 'tab:1': state });
      chrome.runtime.sendMessage = async (message: any) => message.type === 'popup-runtime-info'
        ? { ok: true, payload: { siteBase: 'https://anireko.com', localWriteRevision: 'fixture' } }
        : { ok: false };
    });
    await preview.goto(`chrome-extension://${englishExtensionId}/popup.html?tabId=1`);
    await expect(preview.locator('#title')).toContainText('A very long anime title');
    const englishGeometry = [];
    for (const width of [360, 390]) {
      await preview.setViewportSize({ width, height: 850 });
      const geometry = await preview.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        return { header: box('.brand'), anime: box('#anime-check'), title: box('#title'),
          player: box('#player-check'), button: box('#anime-primary-action'),
          viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
      });
      await testInfo.attach(`compact-geometry-en-${width}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
      const screenshot = testInfo.outputPath(`compact-long-title-en-${width}.png`);
      await preview.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`compact-long-title-en-${width}`, { path: screenshot, contentType: 'image/png' });
      englishGeometry.push(geometry);
    }
    await expect(englishPopup.locator('.brand span')).toHaveCount(0);
    for (const geometry of englishGeometry) {
      expect(geometry.header.height).toBeLessThanOrEqual(32);
      expect(geometry.button.height).toBeGreaterThanOrEqual(38);
      expect(geometry.title.x - geometry.anime.x).toBeLessThan(16);
      expect(geometry.player.height).toBeLessThanOrEqual(81);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport);
    }
    await preview.locator('#anime-primary-action').focus();
    await expect(preview.locator('#anime-primary-action')).toBeFocused();
  } finally {
    await englishContext?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact popup keeps a long recognized title and action usable at 360 and 390', async ({}, testInfo) => {
  const { page, tabId } = await localPopupPage();
  let popup: Page | null = null;
  const longTitle = 'Очень длинное название аниме, которое должно полностью помещаться без обрезки и освобождать место для основной кнопки';
  try {
    await worker.evaluate(async ({ key, title }) => {
      const stored = await chrome.storage.session.get(key);
      const state = structuredClone(stored[key]);
      state.recognition.title = title;
      state.match.title = title;
      await chrome.storage.session.set({ [key]: state });
    }, { key: `tab:${tabId}`, title: longTitle });
    popup = await openPopup(tabId);
    await expect(popup.locator('#title')).toHaveText(longTitle);
    const geometries = [];
    for (const width of [360, 390]) {
      await popup.setViewportSize({ width, height: 850 });
      const geometry = await popup.evaluate(() => {
        const rect = (selector: string) => {
          const bounds = document.querySelector(selector)!.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        };
        return { header: rect('.brand'), anime: rect('#anime-check'), title: rect('#title'),
          player: rect('#player-check'), button: rect('#anime-primary-action'),
          viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
      });
      await testInfo.attach(`compact-geometry-${width}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
      const screenshot = testInfo.outputPath(`compact-long-title-ru-${width}.png`);
      await popup.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`compact-long-title-ru-${width}`, { path: screenshot, contentType: 'image/png' });
      geometries.push(geometry);
    }
    for (const geometry of geometries) {
      expect(geometry.header.height).toBeLessThanOrEqual(32);
      expect(geometry.button.height).toBeGreaterThanOrEqual(38);
      expect(geometry.title.x - geometry.anime.x).toBeLessThan(16);
      expect(geometry.button.width).toBeGreaterThan(geometry.anime.width - 30);
      expect(geometry.player.height).toBeLessThanOrEqual(81);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport);
    }
    await popup.locator('#anime-primary-action').focus();
    await expect(popup.locator('#anime-primary-action')).toBeFocused();
    await expect(popup.locator('#match-change')).toBeVisible();
  } finally { await popup?.close(); await page.close(); }
});

test('recognizes anime before playback and confirms player after playback starts', async ({}, testInfo) => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  // The popup renders once at load; wait for recognition (incl. the search
  // API mapping) to be persisted before opening it.
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');
  await waitForDetectorReady(tabId);

  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check')).toHaveClass(/success/);
  await expect(popup.locator('#anime-check')).toHaveClass(/anime-card/);
  await expect(popup.locator('#anime-check .recognized-only')).toBeVisible();
  await expect(popup.locator('#anime-check-detail')).toHaveText('Расхититель гробниц');
  await expect(popup.locator('#player-check')).not.toHaveClass(/success/);
  for (const width of [390, 360]) {
    await popup.setViewportSize({ width, height: 850 });
    const geometry = await popup.evaluate(() => {
      const brand = document.querySelector('.brand')!.getBoundingClientRect();
      const card = document.querySelector('#anime-check')!.getBoundingClientRect();
      const title = document.querySelector('#title')!.getBoundingClientRect();
      const status = document.createRange();
      status.selectNodeContents(document.querySelector('#anime-check-title')!);
      return { cardTop: card.top, brandInside: brand.top >= card.top && brand.right <= card.right,
        aboveTitle: brand.bottom <= title.top,
        overlapsStatus: [...status.getClientRects()].some(rect => rect.left < brand.right && rect.right > brand.left
          && rect.top < brand.bottom && rect.bottom > brand.top) };
    });
    expect(geometry).toEqual({ cardTop: 16, brandInside: true, aboveTitle: true, overlapsStatus: false });
  }
  await expect(popup.locator('#hint')).toBeHidden();
  await popup.setViewportSize({ width: 360, height: 850 });
  expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const waitingScreenshot = testInfo.outputPath('compact-player-waiting-ru.png');
  await popup.screenshot({ path: waitingScreenshot, fullPage: true });
  await testInfo.attach('compact-player-waiting-ru', { path: waitingScreenshot, contentType: 'image/png' });

  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 60,
    paused: true,
  });
  // Assert exact seek while the real media clock is stationary, then start it.
  await waitForPlayerProgress(tabId, 60 / 310);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 60,
    paused: false,
  });
  await expect.poll(async () => {
    const history = await worker.evaluate(async () => (await chrome.storage.local.get('watch-history'))['watch-history']);
    const record = Object.values(history?.records || {})[0] as { watchedSeconds?: number } | undefined;
    return record?.watchedSeconds || 0;
  }, { timeout: 25_000 }).toBeGreaterThan(3);
  // The popup owns semantic-transition reloads through storage.onChanged.
  // A second test-driven reload races the extension navigation and can abort it.
  await expect(popup.locator('#player-check')).toHaveClass(/success/);
  await expect(popup.locator('#episode')).toHaveText('Серия 2');
  await expect(popup.locator('#status')).toHaveText('смотрю');
  await expect(popup.locator('#progress')).toHaveText(/\d+\.\d%/);
  let popupReloads = 0;
  popup.on('framenavigated', (frame) => {
    if (frame === popup.mainFrame()) popupReloads += 1;
  });
  await worker.evaluate(async (key) => {
    const stored = await chrome.storage.session.get(key);
    const next = structuredClone(stored[key]);
    next.player.currentTime = next.player.duration * 0.42;
    next.player.progress = 0.42;
    await chrome.storage.session.set({ [key]: next });
  }, `tab:${tabId}`);
  await expect(popup.locator('#progress')).toHaveText('42.0%');
  await popup.waitForTimeout(250);
  expect(popupReloads).toBe(0);
  await expect(popup.locator('#title')).toHaveText('Расхититель гробниц');
  await expect(popup.locator('.anime-meta #anime-year')).toHaveText('2024');
  await expect(popup.locator('#anireko-match')).toBeHidden();
  const yearBox = await popup.locator('#anime-year').boundingBox();
  const actionBox = await popup.locator('#anime-primary-action').boundingBox();
  expect(yearBox!.y + yearBox!.height).toBeLessThanOrEqual(actionBox!.y);
  await expect(popup.locator('#anime-primary-action')).toHaveText('Открыть в AniReko →');
  await expect(popup.locator('#anime-primary-action'))
    .toHaveAttribute('href', `${apiBase}/ru/anime/tomb-raider-4242`);
  await expect(popup.locator('#voice')).toHaveText('AniTime Voice');
  await expect(popup.locator('.local-pill')).toHaveText('локально');
  await expect(popup.locator('#account-label')).toHaveText('Авторизация — через сайт AniReko');
  await expect(popup.locator('#account-login')).toBeVisible();
  await expect(popup.locator('#auto-mark')).toBeDisabled();
  // Fail closed: до явной привязки аккаунта синхронизация выключена.
  await expect(popup.locator('#auto-mark')).not.toBeChecked();
  // Guest session → no % but a login hint instead.
  await expect(popup.locator('#taste-match')).toHaveText('войди на сайте, чтобы увидеть %');
  const history = await worker.evaluate(async () => (await chrome.storage.local.get('watch-history'))['watch-history']);
  const record = Object.values(history.records)[0] as {
    voice?: string;
    mediaSeconds?: number;
    skips?: Array<{ from: number; to: number; opening: boolean }>;
    playbackRate?: number;
  };
  expect(record.voice).toBe('AniTime Voice');
  // KAN-702 behavioral profiling is deliberately absent until it has a real
  // product consumer and its own consent.
  expect(record.skips).toBeUndefined();
  expect(record.mediaSeconds).toBeUndefined();
  expect(record.playbackRate).toBeUndefined();
  await popup.close();
  await page.close();
});

test('connects playback through a visible two-level cross-origin iframe chain', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/nested-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');

  const nestedPlayer = page.frameLocator('#outer-player').frameLocator('#nested-video-frame');
  await setSyntheticPlayback(nestedPlayer, '#nested-video', {
    currentTime: 155,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 0.5);

  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      frameVisible: state?.player?.frameVisible ?? null,
      playbackStarted: state?.player?.playbackStarted ?? false,
      episode: state?.player?.episode ?? null,
    };
  }).toEqual({ frameVisible: true, playbackStarted: true, episode: 2 });

  const popup = await openPopup(tabId);
  await expect(popup.locator('#player-check')).toHaveClass(/success/);
  await expect(popup.locator('#progress')).toHaveText('50.0%');
  await expect(popup.locator('#episode')).toHaveText('Серия 2');

  await page.frameLocator('#outer-player').locator('#nested-video-frame').evaluate((frame) => {
    (frame as HTMLIFrameElement).style.display = 'none';
  });
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    const nested = Object.values(state?.players || {}).find((player: any) => (
      player.frameUrl === `${apiBase}/nested-video.html`
    )) as { frameVisible?: boolean } | undefined;
    return nested?.frameVisible ?? null;
  }, { timeout: 10_000 }).not.toBe(true);
  // Observe the product-owned semantic reload; do not start a competing navigation.
  await expect(popup.locator('#player-check')).not.toHaveClass(/success/);
  await page.close();
  await popup.close();
});

test('activates a neutral wrapper when its nested player appears after the settled probes', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/lazy-nested-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');

  const nestedPlayer = page.frameLocator('#outer-player').frameLocator('#nested-video-frame');
  await expect(nestedPlayer.locator('#nested-video')).toBeVisible({ timeout: 15_000 });
  await setSyntheticPlayback(nestedPlayer, '#nested-video', {
    currentTime: 155,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 0.5);
  await expect.poll(async () => (await storedTabState(tabId))?.player?.frameVisible ?? null)
    .toBe(true);
  await page.close();
});

test('falls back to player URL episode and labeled combobox voice', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/url-metadata-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/url-metadata-anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');
  await waitForDetectorReady(tabId);

  await setSyntheticPlayback(page.frameLocator('#main-player'), '#url-video', {
    currentTime: 60,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 60 / 310);
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      episode: state?.player?.episode ?? null,
      voice: state?.voice || state?.recognition?.voice || null,
    };
  }).toEqual({ episode: 8, voice: 'AniDUB' });

  await page.frameLocator('#main-player').locator('#url-video')
    .evaluate((video) => (video as HTMLVideoElement).pause());
  const readProgress = () => worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
  await expect.poll(async () => (await readProgress()).at(-1)?.episode ?? null).toBe(8);
  const urlDerivedProgress = (await readProgress()).at(-1);
  expect(urlDerivedProgress.voice).toBe('AniDUB');
  expect(JSON.stringify(urlDerivedProgress)).not.toContain('127.0.0.1');
  expect(JSON.stringify(urlDerivedProgress)).not.toContain('http');

  const popup = await openPopup(tabId);
  await expect(popup.locator('#episode')).toHaveText('Серия 8');
  await expect(popup.locator('#voice')).toHaveText('AniDUB');
  await popup.close();

  // A player navigation must recompute the fallback, while a later live
  // player message remains authoritative over the URL value.
  await page.locator('#main-player').evaluate((frame, src) => {
    frame.setAttribute('src', src);
  }, `${playerBase}/url-player.html?episode=9&translations=false`);
  await page.frameLocator('#main-player').locator('#url-video').waitFor();
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#url-video', {
    currentTime: 70,
    paused: false,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null).toBe(9);
  await page.frameLocator('#main-player').locator('body').evaluate(() => {
    window.parent.postMessage({ eventType: 'selectEpisode', data: '5' }, '*');
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null).toBe(5);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#url-video', {
    currentTime: 80,
    paused: false,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.currentTime ?? null)
    .toBeCloseTo(80, 1);
  expect((await storedTabState(tabId))?.player?.episode).toBe(5);
  // Same-document player SPA navigation invalidates the earlier authoritative
  // signal and recomputes the episode from the new document URL.
  await page.frameLocator('#main-player').locator('body').evaluate(() => {
    history.pushState({}, '', '/url-player.html?episode=10&translations=false');
  });
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#url-video', {
    currentTime: 90,
    paused: false,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null).toBe(10);
  await page.close();
});

test('shows only an anime-not-found state and manually reports a recognition miss', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/generic-video.html`);
  const tabId = await extensionTabId(`${siteBase}/generic-video.html`);
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      videos: state?.probe?.videos ?? 0,
    };
  }, { timeout: 10_000 }).toEqual({ title: null, videos: 4 });

  // A previous tab may finish an already-dispatched session-info request just
  // after beforeEach reset. Clear counters at this test's observation boundary
  // so only requests caused by this generic-page popup are measured.
  await worker.evaluate(async () => {
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/reset');
  });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Аниме не найдено');
  await expect(popup.locator('#anime-check')).toHaveClass(/anime-card/);
  await expect(popup.locator('#anime-check .recognized-only')).toBeHidden();
  await expect(popup.locator('#not-found-report')).toBeVisible();
  for (const selector of [
    '#player-check', '#stats-card', '#anime-fields', '#hint', '#account', '#automark',
  ]) {
    await expect(popup.locator(selector)).toBeHidden();
  }

  const before = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(before).toMatchObject({ search: 0, sessionInfo: 0, diagnostics: 0 });

  await popup.locator('#report-anime-miss').click();
  await expect(popup.locator('#report-anime-miss')).toHaveText('Отправлено, спасибо');
  const diagnostics = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/diagnostics')).json()));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    report_kind: 'recognition_miss',
    host: '127.0.0.2',
    probe: { videos: 4 },
  });
  expect(diagnostics[0]).not.toHaveProperty('anime_id');
  expect(diagnostics[0]).not.toHaveProperty('title');
  const serialized = JSON.stringify(diagnostics[0]);
  expect(serialized).not.toContain('generic-video.html');
  expect(serialized).not.toContain('Kimi WebBridge');

  const after = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(after).toMatchObject({ search: 0, sessionInfo: 0, diagnostics: 1 });
  await popup.close();
  await page.close();
});

test('detects a disconnected old document despite saved recognition and recovers only after confirmation', async ({}, testInfo) => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  const savedTitle = (await storedTabState(tabId)).recognition.title;
  // Use the production shutdown path: its old document remains mounted and
  // session recognition remains saved, but the detector no longer responds.
  await worker.evaluate(async (id) => {
    await chrome.tabs.sendMessage(id, { type: 'anireko-disable-detector' }, { frameId: 0 });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/reset');
  }, tabId);
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Нет подключения к странице');
  await popup.setViewportSize({ width: 360, height: 850 });
  expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const disconnectedScreenshot = testInfo.outputPath('compact-disconnected-ru.png');
  await popup.screenshot({ path: disconnectedScreenshot, fullPage: true });
  await testInfo.attach('compact-disconnected-ru', { path: disconnectedScreenshot, contentType: 'image/png' });
  await expect(popup.locator('#not-found-report')).toBeHidden();
  await expect(popup.locator('#report-anime-miss')).toBeDisabled();
  await expect(popup.locator('#automark')).toBeHidden();
  expect((await storedTabState(tabId)).recognition.title).toBe(savedTitle);
  expect(navigations).toBe(0);

  const cancelDialog = new Promise<void>((resolve) => popup.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('прервёт воспроизведение');
    await dialog.dismiss();
    resolve();
  }));
  await popup.locator('#reload-page').click();
  await cancelDialog;
  expect(navigations).toBe(0);
  const counts = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(counts.diagnostics).toBe(0);

  const navigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  popup.once('dialog', (dialog) => void dialog.accept());
  await popup.locator('#reload-page').click();
  await navigation;
  await expect.poll(() => worker.evaluate(async (id) => {
    const reply = await chrome.tabs.sendMessage(id, { type: 'anireko-detector-status' }, { frameId: 0 });
    return reply?.ok;
  }, tabId)).toBe(true);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  const recoveredPopup = await openPopup(tabId);
  await expect(recoveredPopup.locator('#anime-check-title')).toHaveText('Аниме найдено');
  await expect(recoveredPopup.locator('#page-recovery')).toBeHidden();
  await recoveredPopup.close();
  if (!popup.isClosed()) await popup.close();
  await page.close();
});

test('does not render old-document recognition when a new detector is connected at the same URL', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  await waitForDetectorReady(tabId);
  const oldState = await storedTabState(tabId);
  await worker.evaluate(async () => {
    (globalThis as any).AniRekoTestHooks.resetVolatileCaches();
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/taste-hold?on=1');
  });
  try {
    // A real old-document sensor message blocks on the held taste API response.
    await page.frameLocator('#main-player').locator('#episode-select').selectOption({ label: '12 серия' });
    await expect.poll(() => worker.evaluate(async () =>
      (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/taste-hold')).json()).pending)).toBeGreaterThan(0);
    await page.reload();
    await expect.poll(() => worker.evaluate(async (id) =>
      (await chrome.tabs.sendMessage(id, { type: 'anireko-detector-status' }, { frameId: 0 })).documentToken,
    tabId)).not.toBe(oldState.navigationToken);
    expect((await storedTabState(tabId)).navigationToken).toBe(oldState.navigationToken);
    const popup = await openPopup(tabId);
    await expect(popup.locator('#anime-check-title')).toHaveText('Ищем страницу аниме');
    await expect(popup.locator('#anime-check .recognized-only')).toBeHidden();
    await expect(popup.locator('#not-found-report')).toBeHidden();
    await expect(popup.locator('#automark')).toBeHidden();
    await worker.evaluate(async () => {
      await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/taste-hold?on=0');
    });
    await expect(popup.locator('#anime-check-title')).toHaveText('Аниме найдено');
    await popup.close();
  } finally {
    await worker.evaluate(async () => {
      await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/taste-hold?on=0');
    });
    await page.close();
  }
});

test('detects actual extension reload in an already-open tab and restores on page reload', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  const session = await context.browser()!.newBrowserCDPSession();
  const restarted = context.waitForEvent('serviceworker');
  // Loading the same unpacked path reloads it through the browser's extension
  // loader, without uninstalling or clearing the test profile's local data.
  const loaded = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  expect(loaded.id).toBe(extensionId);
  const openingPopup = openPopup(tabId);
  worker = await restarted;
  const popup = await openingPopup;
  await expect(popup.locator('#anime-check-title')).toHaveText('Нет подключения к странице');
  await expect(popup.locator('#not-found-report')).toBeHidden();
  await popup.close();
  await page.reload();
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('ok');
  const recovered = await openPopup(tabId);
  await expect(recovered.locator('#anime-check-title')).toHaveText('Аниме найдено');
  await recovered.close();
  await page.close();
});

test('does not mistake a restricted browser page for an anime recognition miss', async () => {
  const page = await context.newPage();
  // Without the tabs permission Chrome redacts restricted-page URLs. Capture
  // the exact ID while the tab is still an authorized HTTP document.
  await page.goto(`${siteBase}/generic-video.html`);
  const tabId = await extensionTabId(`${siteBase}/generic-video.html`);
  await page.goto('about:blank');
  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Эта страница недоступна расширению');
  await expect(popup.locator('#not-found-report')).toBeHidden();
  await expect(popup.locator('#page-recovery')).toBeHidden();
  await popup.close();
  await page.close();
});

test('requires a choice for duplicate exact matches, stores it locally, and syncs immediately', async ({}, testInfo) => {
  await worker.evaluate(async () => {
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/ambiguous-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/ambiguous-anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null)
    .toBe('ambiguous');
  await waitForDetectorReady(tabId);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 300,
    paused: true,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.watched ?? false)
    .toBe(true);

  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Нужно подтвердить аниме');
  await expect(popup.locator('#anireko-match')).toHaveText('Совпадение в каталоге ещё не подтверждено');
  await expect(popup.locator('.match-candidate')).toHaveCount(2);
  await popup.setViewportSize({ width: 360, height: 850 });
  expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const ambiguousScreenshot = testInfo.outputPath('compact-ambiguous-ru.png');
  await popup.screenshot({ path: ambiguousScreenshot, fullPage: true });
  await testInfo.attach('compact-ambiguous-ru', { path: ambiguousScreenshot, contentType: 'image/png' });
  const chosenCandidate = popup.locator('.match-candidate').filter({ hasText: '2022 · ONA' });
  await expect(chosenCandidate).toHaveCount(1);
  await expect.poll(() => worker.evaluate(
    (id) => chrome.action.getBadgeText({ tabId: id }),
    tabId,
  )).toBe('!');
  await chosenCandidate.click();

  await expect(popup.locator('#anime-check-title')).toHaveText('Аниме найдено');
  await expect(popup.locator('#anireko-match')).toContainText('выбрано вручную');
  await expect.poll(async () => (await storedTabState(tabId))?.match ?? null)
    .toMatchObject({ status: 'ok', animeId: 19119, manual: true, exact: false });
  await expect.poll(() => worker.evaluate(
    (id) => chrome.action.getBadgeText({ tabId: id }),
    tabId,
  )).not.toBe('!');
  await expect.poll(async () => {
    const posts = await worker.evaluate(async () =>
      (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
    return posts.at(-1)?.anime_id ?? null;
  }).toBe(19119);
  await expect.poll(async () => {
    const posts = await worker.evaluate(async () =>
      (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/status-posts')).json()));
    return posts.at(-1)?.status ?? null;
  }).toBe('watching');

  await expect(popup.locator('#match-change')).toBeVisible();
  await expect(popup.locator('#match-resolution')).toBeHidden();
  await popup.locator('#match-change').click();
  await expect(popup.locator('#match-resolution')).toBeVisible();
  await expect(popup.locator('#match-resolution-title')).toHaveText('Исправить совпадение');
  await expect(popup.locator('#match-reset')).toBeVisible();
  await popup.locator('#match-reset').click();
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null)
    .toBe('ambiguous');
  await expect(popup.locator('#anime-check-title')).toHaveText('Нужно подтвердить аниме');
  await popup.close();
  await page.close();
});

test('accepts an intraword hyphen variant as exact and still lets the user correct it', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/hyphen-title-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/hyphen-title-anime.html`);

  await expect.poll(async () => (await storedTabState(tabId))?.match ?? null)
    .toMatchObject({ status: 'ok', animeId: 37259, exact: true, manual: false });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Аниме найдено');
  await expect(popup.locator('#anireko-match')).toContainText('Моё антибожественное оружие');
  await expect(popup.locator('#match-change')).toBeVisible();
  await expect(popup.locator('#match-resolution')).toBeHidden();

  await popup.locator('#match-change').click();
  await expect(popup.locator('#match-resolution')).toBeVisible();
  await expect(popup.locator('#match-resolution-title')).toHaveText('Исправить совпадение');
  await expect(popup.locator('#match-resolution-detail')).toContainText('только в этом браузере');
  await expect(popup.locator('#match-reset')).toBeHidden();
  await popup.locator('#match-search-query').fill('Одинаковое имя');
  await popup.locator('#match-search').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(popup.locator('.match-candidate')).toHaveCount(2);
  await popup.locator('.match-candidate').filter({ hasText: '2022 · ONA' }).click();
  await expect.poll(async () => (await storedTabState(tabId))?.match ?? null)
    .toMatchObject({ status: 'ok', animeId: 19119, exact: false, manual: true });
  await expect(popup.locator('#anireko-match')).toContainText('выбрано вручную');
  await popup.close();
  await page.close();
});

test('treats Russian number words as exact and excludes the 100000 lookalike', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/numeric-title-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/numeric-title-anime.html`);

  await expect.poll(async () => (await storedTabState(tabId))?.match ?? null)
    .toMatchObject({ status: 'ok', animeId: 19119, exact: true, manual: false });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Аниме найдено');
  await expect(popup.locator('#anireko-match')).toContainText('Три тысячи лет практики ци');
  await expect(popup.locator('.match-candidate')).toHaveCount(0);
  await popup.close();
  await page.close();
});

test('resolves a numbered season through the catalog alias without asking for a choice', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/bookworm-season-4.html`);
  const tabId = await extensionTabId(`${siteBase}/bookworm-season-4.html`);

  await expect.poll(async () => (await storedTabState(tabId))?.match ?? null)
    .toMatchObject({
      status: 'ok',
      animeId: 13124,
      exact: true,
      manual: false,
      seasonAlias: true,
    });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#anime-check-title')).toHaveText('Аниме найдено');
  await expect(popup.locator('#anireko-match')).toContainText('Власть книжного червя: Приёмная дочь лорда');
  await expect(popup.locator('.match-candidate')).toHaveCount(0);
  await popup.close();
  await page.close();
});

test('prefers a later episode H1 over duplicated site-brand headings', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/site-brand-before-episode.html`);
  const tabId = await extensionTabId(`${siteBase}/site-brand-before-episode.html`);

  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      animeId: state?.match?.animeId ?? null,
    };
  }).toEqual({ title: 'Saimin Jutsu 2', animeId: 23001 });
  await page.close();
});

test('current-title aliases hydrate on the same URL, exclude recommendations, and revoke ambiguous scope', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/title-alternatives.html`);
  const tabId = await extensionTabId(`${siteBase}/title-alternatives.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('none');
  // Even a same-title .titles block inside recommendations cannot authorize aliases.
  await page.locator('aside').evaluate(block => {
    block.innerHTML = '<div class="titles"><h1>Водное поло на грани фола</h1>'
      + '<ul class="alt-names-list"><li>Hantsu x Trash</li></ul></div>';
  });
  await expect.poll(async () => (await storedTabState(tabId))?.recognition?.alternativeTitles).toEqual([]);
  await page.locator('.content-page .titles .alt-names-list').evaluate((list) => {
    list.innerHTML = '<li>Hantsu x Torasshu</li><li>Hantsu x Trash</li><li>…</li>'
      + '<li><a href="/other">Linked recommendation</a></li><li>ハンツー×トラッシュ</li>';
  });
  await expect.poll(async () => (await storedTabState(tabId))?.match?.animeId).toBe(11758);
  expect((await storedTabState(tabId)).recognition.alternativeTitles)
    .toEqual(['Hantsu x Torasshu', 'Hantsu x Trash', 'ハンツー×トラッシュ']);
  // Several unchanged DOM rescans must not issue another search.
  const before = await page.request.get(`${apiBase}/__test/request-counts`).then(r => r.json());
  for (let index = 0; index < 3; index++) await page.evaluate(() => document.body.append(document.createElement('span')));
  expect(await page.request.get(`${apiBase}/__test/request-counts`).then(r => r.json())).toMatchObject({ searchQueries: before.searchQueries });
  expect(before.searchQueries).toEqual(['Водное поло на грани фола', 'Водное поло на грани фола',
    'Hantsu x Torasshu', 'Hantsu x Trash', 'ハンツー×トラッシュ']);
  await page.locator('.content-page .titles').evaluate(block => block.after(block.cloneNode(true)));
  await expect.poll(async () => (await storedTabState(tabId))?.recognition?.alternativeTitles).toEqual([]);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('none');
  await page.close();
});

test('same-title recommendation block cannot supply aliases for the actual primary H1', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/title-alternatives-decoy.html`);
  const tabId = await extensionTabId(`${siteBase}/title-alternatives-decoy.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status).toBe('none');
  expect((await storedTabState(tabId)).recognition.alternativeTitles).toEqual([]);
  const counts = await page.request.get(`${apiBase}/__test/request-counts`).then(r => r.json());
  expect(counts.searchQueries).toEqual(['Водное поло на грани фола']);
  await page.close();
});

test('does not promote a recommendation episode H1 over the primary title', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/primary-title-with-decoy-episode.html`);
  const tabId = await extensionTabId(`${siteBase}/primary-title-with-decoy-episode.html`);

  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      matchStatus: state?.match?.status ?? null,
      animeId: state?.match?.animeId ?? null,
    };
  }).toEqual({
    title: 'Saimin Jutsu The Animation',
    matchStatus: 'none',
    animeId: null,
  });
  await page.close();
});

test('does not recognize or bind an anime from a secondary episode H1 alone', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/secondary-episode-only.html`);
  const tabId = await extensionTabId(`${siteBase}/secondary-episode-only.html`);

  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      animeId: state?.match?.animeId ?? null,
    };
  }).toEqual({ title: null, animeId: null });
  await page.close();
});

test('lets the user search AniReko when the recognized title has no catalog result', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/missing-catalog-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/missing-catalog-anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('none');

  const popup = await openPopup(tabId);
  await expect(popup.locator('#anireko-match')).toContainText(
    'По названию «Совсем неизвестное» ничего не найдено',
  );
  await expect(popup.locator('#match-resolution-title')).toHaveText('Найдите аниме вручную');
  await popup.locator('#match-search-query').fill('Три тысячи лет практики ци');
  await popup.locator('#match-search').getByRole('button', { name: 'Найти' }).click();
  await expect(popup.locator('.match-candidate')).toContainText('Три тысячи лет практики ци');
  await popup.locator('.match-candidate').click();

  await expect.poll(async () => (await storedTabState(tabId))?.match ?? null)
    .toMatchObject({ status: 'ok', animeId: 19119, manual: true });
  await expect(popup.locator('#anireko-match')).toContainText('выбрано вручную');
  await popup.close();
  await page.close();
});

test('re-recognizes the page after SPA navigation without reload', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.recognition?.title ?? null)
    .toBe('Расхититель гробниц');

  await page.evaluate(() => {
    history.pushState({}, '', '/spa-next-title');
    document.title = 'Восхождение героя щита — аниме';
    document.querySelector('h1')!.textContent = 'Восхождение героя щита аниме';
  });
  await page.mouse.click(10, 10);

  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return { title: state?.recognition?.title ?? null, match: state?.match?.status ?? null };
  }).toEqual({ title: 'Восхождение героя щита', match: 'none' });
  await page.close();
});

test('detects a shadow-DOM web-component player and joins the host episode attribute', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/shadow-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/shadow-anime.html`);

  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      players: Object.keys(state?.players || {}).length,
    };
  }).toEqual({ title: 'Расхититель гробниц', players: 1 });

  // Playwright locators pierce open shadow roots — drive the video inside
  // the shadow-hosted iframe.
  await setSyntheticPlayback(page.frameLocator('iframe'), '#shadow-video', {
    currentTime: 60,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 60 / 310);
  const state = await storedTabState(tabId);
  // Episode is only an attribute on the <fake-player> host in the top page;
  // the frame itself reports episode=null and must be backfilled.
  expect(state.player.episode).toBe(3);

  // A top-page script cannot forge player state with postMessage.
  await page.evaluate(() => {
    window.postMessage({ eventType: 'selectEpisode', data: '77' }, '*');
  });
  await page.waitForTimeout(100);
  expect((await storedTabState(tabId))?.player?.episode).toBe(3);

  // Manual selection in VideoHub is an iframe -> parent protocol message;
  // unlike auto-switch, it does not emit episodeChange on the host element.
  await page.frameLocator('iframe').locator('body').evaluate(() => {
    window.parent.postMessage({ eventType: 'selectEpisode', data: '5' }, '*');
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null).toBe(5);

  // The frame starts reporting a stale DOM label as episode 1. Neither that
  // mutation nor a later progress tick may overwrite the authoritative 5.
  await page.frameLocator('iframe').locator('body').evaluate((body) => {
    body.insertAdjacentHTML('afterbegin', '<div class="episode"><span class="selected">1 серия</span></div>');
  });
  await setSyntheticPlayback(page.frameLocator('iframe'), '#shadow-video', {
    currentTime: 70,
    paused: false,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.currentTime ?? null).toBeCloseTo(70, 1);
  expect((await storedTabState(tabId))?.player?.episode).toBe(5);
  await expect(page.locator('fake-player')).toHaveAttribute('episode', '3');
  await page.close();
});

test('auto-report requires a confirmed anime and a real player interaction', async () => {
  // Diagnostics are a separate opt-in. Shrink the grace period so the test
  // can first prove default-off, then enable it explicitly.
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('privacy-consent');
    await chrome.storage.local.set({
      'diag-grace-ms': 1500,
      'privacy-consent': { ...stored['privacy-consent'], diagnostics: false },
    });
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/broken-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/broken-anime.html`);

  // Wait for the settled DOM probe (sent ~4s after load) so the report is useful.
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      probeIframes: state?.probe?.iframes?.length ?? 0,
    };
  }, { timeout: 10_000 }).toEqual({ title: 'Расхититель гробниц', probeIframes: 1 });

  // Auto-report (KAN-2715): exactly one anonymous POST, hostname only.
  const readDiagnostics = () => worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/diagnostics')).json()));
  await page.waitForTimeout(2_000);
  expect(await readDiagnostics()).toHaveLength(0);
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('privacy-consent');
    await chrome.storage.local.set({
      'privacy-consent': { ...stored['privacy-consent'], diagnostics: true },
    });
  });
  await page.reload();
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return state?.match?.status ?? null;
  }, { timeout: 10_000 }).toBe('ok');
  await page.waitForTimeout(2_000);
  expect(await readDiagnostics()).toHaveLength(0);

  // A generic CSS class containing "play" (display-flex) is not playback
  // intent and must not re-open the noisy pre-play diagnostic path.
  await page.locator('#unrelated-action').click();
  await page.waitForTimeout(2_000);
  expect(await readDiagnostics()).toHaveLength(0);

  await page.frameLocator('#opaque-player').locator('#start-player').click();
  await expect.poll(readDiagnostics, { timeout: 10_000 }).toHaveLength(1);
  const [diagnostic] = await readDiagnostics();
  expect(diagnostic.host).toBe('127.0.0.2');
  expect(diagnostic).not.toHaveProperty('anime_id');
  expect(diagnostic).not.toHaveProperty('title');
  expect(diagnostic.probe.iframeHosts).toEqual(['localhost']);
  expect(JSON.stringify(diagnostic)).not.toContain('broken-anime.html');
  await page.close();

  // Repeat visit to the same host must NOT produce a second report (7d dedup).
  const secondPage = await context.newPage();
  await secondPage.goto(`${siteBase}/broken-anime.html`);
  await secondPage.frameLocator('#opaque-player').locator('#start-player').click();
  await secondPage.waitForTimeout(3_000);
  expect(await readDiagnostics()).toHaveLength(1);
  await secondPage.close();
});

test('does not report a click-to-load player that becomes readable after interaction', async () => {
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('privacy-consent');
    await chrome.storage.local.set({
      'diag-grace-ms': 1500,
      'privacy-consent': { ...stored['privacy-consent'], diagnostics: true },
    });
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/click-to-play-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/click-to-play-anime.html`);
  const readDiagnostics = () => worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/diagnostics')).json()));

  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null, {
    timeout: 10_000,
  }).toBe('ok');
  await page.waitForTimeout(2_000);
  expect(await readDiagnostics()).toHaveLength(0);
  await page.frameLocator('#click-player').locator('#start-player').click();
  await expect.poll(async () => (await storedTabState(tabId))?.player?.duration ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);
  expect(await readDiagnostics()).toHaveLength(0);
  await page.close();
});

test('does not report an interacted player when catalog recognition is unconfirmed', async () => {
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('privacy-consent');
    await chrome.storage.local.set({
      'diag-grace-ms': 1500,
      'privacy-consent': { ...stored['privacy-consent'], diagnostics: true },
    });
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/missing-catalog-broken-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/missing-catalog-broken-anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null, {
    timeout: 10_000,
  }).toBe('none');

  await page.frameLocator('#opaque-player').locator('#start-player').click();
  await page.waitForTimeout(3_000);
  const diagnostics = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/diagnostics')).json()));
  expect(diagnostics).toHaveLength(0);
  await page.close();
});

test('tracks a full-length movie without any episode markup', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/movie-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/movie-anime.html`);
  await waitForDetectorReady(tabId);

  await setSyntheticPlayback(page.frameLocator('#movie-player'), '#movie-video', {
    currentTime: 60,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 60 / 310);

  const popup = await openPopup(tabId);
  await expect(popup.locator('#player-check')).toHaveClass(/success/);
  await expect(popup.locator('#player-check-detail')).toContainText('Фильм / серия не размечена');
  await popup.close();

  // Episode-less record lands under the ::full key (duration 310s >= 300s guard).
  await expect.poll(async () => {
    const history = await worker.evaluate(async () =>
      (await chrome.storage.local.get('watch-history'))['watch-history']);
    return Object.keys(history?.records || {}).some((key) => key.endsWith('::full'));
  }, { timeout: 10_000 }).toBe(true);
  await page.close();
});

test('shows episode and voice from an unstarted proprietary iframe shell', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/shell-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/shell-anime.html`);
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      kind: state?.player?.player ?? null,
      episode: state?.player?.episode ?? null,
      voice: state?.voice ?? null,
    };
  }).toEqual({ kind: 'iframe-shell', episode: 6, voice: 'AniTime Voice' });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#player-check')).toHaveClass(/waiting/u);
  await expect(popup.locator('#episode')).toHaveText('Серия 6');
  await expect(popup.locator('#voice')).toHaveText('AniTime Voice');
  await expect(popup.locator('#player-count')).toHaveText('1');
  const syncButton = popup.locator('#resume-sync');
  await expect(syncButton).toBeEnabled();
  await syncButton.click();
  await expect(syncButton).toHaveText('Нет новых данных для отправки');
  await expect(syncButton).toBeEnabled({ timeout: 5_000 });
  await popup.close();
  await page.close();
});

test('manual sync sends saved terminal progress after reload leaves the player unstarted', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/shell-terminal-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/shell-terminal-anime.html`);
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return {
      title: state?.recognition?.title ?? null,
      kind: state?.player?.player ?? null,
      episode: state?.player?.episode ?? null,
      started: state?.player?.playbackStarted ?? null,
    };
  }).toMatchObject({ kind: 'iframe-shell', episode: 12, started: false });
  await worker.evaluate(async (id) => {
    const state = (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`];
    const title = String(state.recognition.title);
    const titleKey = title.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
    await chrome.storage.local.set({
      'watch-history': {
        records: {
          [`${titleKey}::12`]: {
            title,
            episode: 12,
            position: 310,
            duration: 310,
            progress: 1,
            completed: true,
            voice: 'AniTime Voice',
            lastWatchedAt: Date.now() - 60_000,
          },
        },
        days: {},
      },
    });
    (globalThis as any).AniRekoTestHooks.resetVolatileCaches();
  }, tabId);
  const popup = await openPopup(tabId);
  const syncButton = popup.locator('#resume-sync');
  await expect(syncButton).toBeEnabled();
  popup.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Расхититель гробниц');
    await dialog.accept();
  });
  await syncButton.click();
  await expect(syncButton).toHaveText('✓ обновлено');
  const progress = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
  expect(progress.at(-1)).toMatchObject({
    anime_id: 4242,
    episode: 12,
    position_sec: 310,
    duration_sec: 310,
    expected_user_id: 18,
  });
  const status = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/status-posts')).json()));
  expect(status).toEqual([{ anime_id: 4242, status: 'completed', expected_user_id: 18 }]);
  const migratedAnimeId = await worker.evaluate(async () => {
    const history = (await chrome.storage.local.get('watch-history'))['watch-history'];
    return (Object.values(history.records) as any[])[0]?.animeId ?? null;
  });
  expect(migratedAnimeId).toBe(4242);

  await popup.close();
  await page.close();
});

test('manual sync shows a failure when saved progress exists but the write is rejected', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/fail-progress-writes?on=1');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/shell-terminal-anime.html`);
  const tabId = await extensionTabId(`${siteBase}/shell-terminal-anime.html`);
  await expect.poll(async () => {
    const state = await storedTabState(tabId);
    return { episode: state?.player?.episode ?? null, started: state?.player?.playbackStarted ?? null };
  }).toEqual({ episode: 12, started: false });
  await worker.evaluate(async (id) => {
    const state = (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`];
    const title = String(state.recognition.title);
    const titleKey = title.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
    await chrome.storage.local.set({
      'watch-history': {
        records: {
          [`${titleKey}::12`]: {
            title,
            episode: 12,
            position: 310,
            duration: 310,
            progress: 1,
            completed: true,
            lastWatchedAt: Date.now(),
          },
        },
        days: {},
      },
    });
    (globalThis as any).AniRekoTestHooks.resetVolatileCaches();
  }, tabId);

  const popup = await openPopup(tabId);
  const syncButton = popup.locator('#resume-sync');
  await expect(syncButton).toBeEnabled();
  popup.once('dialog', async (dialog) => dialog.accept());
  await syncButton.click();
  await expect(syncButton).toHaveText('Не удалось синхронизировать');
  const progress = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
  expect(progress).toEqual([]);

  await popup.close();
  await page.close();
});

test('auto-marks watching on a completed episode 2+ even without earlier local history', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);

  // A completed episode 1 alone still means «попробовал», not «смотрю».
  await page.frameLocator('#main-player').locator('#episode-select')
    .selectOption({ label: '1 серия' });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null)
    .toBe(1);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 260,
    paused: false,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.watched ?? false)
    .toBe(true);
  const readPosts = () => worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/status-posts')).json()));
  await page.waitForTimeout(2_000);
  expect(await readPosts()).toHaveLength(0);

  // Simulate a late install: extension has no episode 1 history for the next
  // title/session, but a completed episode 2+ is sufficient evidence of watching.
  await page.frameLocator('#main-player').locator('#main-video')
    .evaluate((video) => { (video as HTMLVideoElement).currentTime = 0; });
  await page.frameLocator('#main-player').locator('#episode-select')
    .selectOption({ label: '2 серия' });
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 260,
    paused: false,
  });
  await expect.poll(readPosts, { timeout: 15_000 })
    .toEqual([{ anime_id: 4242, status: 'watching', expected_user_id: 18 }]);

  // Further watched ticks must not produce duplicate POSTs.
  await page.waitForTimeout(6_000);
  expect(await readPosts()).toHaveLength(1);

  // Logged-in session → match% resolved for the badge/popup row.
  await expect.poll(async () => (await storedTabState(tabId))?.taste ?? null)
    .toMatchObject({ status: 'ok', percent: 87, labelKey: 'very_likely' });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#taste-match')).toHaveText('87% · очень подходит');
  await expect(popup.locator('#taste-match a')).toHaveCount(0);
  await popup.close();
  await page.close();
});

test('promotes watching to completed once on finished episode 12 of 12', async () => {
  await worker.evaluate(async () => {
    const resolvedAt = Date.now();
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
      'search-cache-version': 8,
      'search-cache': {
        'расхититель гробниц': {
          match: {
            status: 'ok',
            query: 'Расхититель гробниц',
            animeId: 4242,
            title: 'Расхититель гробниц',
            slug: 'tomb-raider',
            year: 2024,
            type: 'TV',
            totalEpisodes: null,
            releaseStatus: null,
            completionMetadataReady: false,
            exact: true,
            resolvedAt,
          },
          expiresAt: resolvedAt + 7 * 24 * 3600 * 1000,
        },
      },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/watch-status?value=watching');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await page.frameLocator('#main-player').locator('#episode-select')
    .selectOption({ label: '12 серия' });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null)
    .toBe(12);
  const countsBeforePlayback = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(countsBeforePlayback.search, 'seeded partial cache should serve recognition without a search').toBe(0);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 260,
    paused: false,
  });

  const readPosts = () => worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/status-posts')).json()));
  await expect.poll(readPosts, { timeout: 15_000 })
    .toEqual([{ anime_id: 4242, status: 'completed', expected_user_id: 18 }]);
  const countsAfterTransition = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(countsAfterTransition.search, JSON.stringify(countsAfterTransition.searchQueries)).toBe(1);

  // More watched ticks are folded by the local transition key before the
  // account/session lookup, not merely before the final POST.
  await page.waitForTimeout(6_000);
  const countsAfterMoreTicks = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(countsAfterMoreTicks.search).toBe(countsAfterTransition.search);
  expect(countsAfterMoreTicks.statusPosts).toBe(countsAfterTransition.statusPosts);
  await page.close();
});

test('scopes taste cache to the live AniReko account', async () => {
  await worker.evaluate(async () => {
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.taste?.percent ?? null).toBe(87);

  await worker.evaluate(async () => {
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=953');
  });
  const accountPopup = await openPopup(tabId);
  await expect(accountPopup.locator('#account-label')).toContainText('Demo YooKassa');
  await accountPopup.close();
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 40,
    paused: false,
  });
  await expect.poll(async () => (await storedTabState(tabId))?.taste ?? null)
    .toMatchObject({ userKey: 'user:953', percent: 12, labelKey: 'unlikely' });
  const popup = await openPopup(tabId);
  await expect(popup.locator('#taste-match')).toContainText('12%');
  await popup.close();
  await page.close();
});

test('syncs resume progress on pause (episode, position, voice — no URL)', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');
  await waitForDetectorReady(tabId);

  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 100,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 100 / 310);
  await page.frameLocator('#main-player').locator('#main-video')
    .evaluate((video) => (video as HTMLVideoElement).pause());

  const readProgress = () => worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
  await expect.poll(async () => {
    const progress = await readProgress();
    return progress[progress.length - 1]?.position_sec ?? null;
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(100);
  const posts = await readProgress();
  const last = posts[posts.length - 1];
  expect(last.anime_id).toBe(4242);
  expect(last.episode).toBe(2);
  expect(last.position_sec).toBeGreaterThanOrEqual(100);
  expect(last.duration_sec).toBe(310);
  expect(last.voice).toBe('AniTime Voice');
  expect(last.expected_user_id).toBe(18);
  // Юр-инвариант: ни URL, ни хоста источника в payload.
  expect(JSON.stringify(last)).not.toContain('127.0.0.1');
  expect(JSON.stringify(last)).not.toContain('http');

  // Попап показывает «где остановился» (resume-bulk кэш / bulk-GET).
  const popup = await openPopup(tabId);
  await expect(popup.locator('#resume')).toBeVisible();
  await expect(popup.locator('#resume')).toContainText(/Серия 2 · \d+:\d{2} · AniTime Voice · сегодня/);

  // Кнопка ручного синка: работает и уходит в кулдаун (защита от закликивания).
  const syncButton = popup.locator('#resume-sync');
  await expect(syncButton).toBeEnabled();
  const postsBeforeManualSync = (await readProgress()).length;
  await worker.evaluate((id) => {
    const state = (globalThis as any).AniRekoTestHooks.stateForTab(id);
    state.progressSync.at = Date.now() - 20_000;
  }, tabId);
  await syncButton.click();
  await expect(syncButton).toHaveText('✓ обновлено');
  await expect(syncButton).toBeDisabled();
  await expect.poll(async () => (await readProgress()).length).toBeGreaterThan(postsBeforeManualSync);
  expect((await readProgress()).at(-1)?.position_sec).toBeGreaterThanOrEqual(100);
  // Кулдаун переживает переоткрытие попапа (timestamp в storage).
  const popup2 = await openPopup(tabId);
  await expect(popup2.locator('#resume-sync')).toBeDisabled();
  await popup2.close();
  await popup.close();
  await page.close();
});

test('serializes progress writes and restores the final state after a cold worker restart', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
    // A preceding closed tab can observe the fixture's reset guest session.
    // Observe the new account through the production read/epoch path before
    // capturing direct-writer bindings; never suppress write_binding_changed.
    const session = await (globalThis as any).handlePopupRequest({ type: 'popup-session-info' });
    if (!session.ok || session.payload?.user?.id !== 18) throw new Error('fixture_account_not_ready');
    const state = {
      sourceOrigin: (globalThis as any).AniRekoRuntimeConfig.apiBase.replace('127.0.0.1', '127.0.0.2'),
      match: { status: 'ok', exact: true, animeId: 4242 },
      player: { playbackStarted: true, currentTime: 100, duration: 310, episode: 2, voice: 'AniTime Voice' },
      recognition: { voice: 'AniTime Voice' },
    };
    const first = (globalThis as any).AniRekoTestHooks.syncProgress(state, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.player.currentTime = 200;
    const second = (globalThis as any).AniRekoTestHooks.syncProgress(state, true);
    await Promise.all([first, second]);
  });
  const counts = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/request-counts')).json()));
  expect(counts.maxProgressPostsInFlight).toBe(1);
  const directPosts = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
  expect(directPosts.map((post: { position_sec: number }) => post.position_sec)).toEqual([100, 200]);

  const coldTabId = 987654;
  await worker.evaluate(async ({ id, key }) => {
    const state = {
      sourceOrigin: (globalThis as any).AniRekoRuntimeConfig.apiBase.replace('127.0.0.1', '127.0.0.2'),
      match: { status: 'ok', exact: true, animeId: 4242 },
      recognition: { voice: 'AniTime Voice' },
      player: {
      playbackStarted: true,
      currentTime: 240,
      duration: 310,
      episode: 2,
      voice: 'AniTime Voice',
      },
      progressSync: { key: '4242:2', at: Date.now() - 20_000, position: 200 },
    };
    await chrome.storage.session.set({ [key]: state });
    (globalThis as any).AniRekoTestHooks.dropTabState(id);
    await (globalThis as any).AniRekoTestHooks.finalizeRemovedTab(id);
  }, { id: coldTabId, key: `tab:${coldTabId}` });
  await expect.poll(async () => {
    const posts = await worker.evaluate(async () =>
      (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()));
    return posts.at(-1)?.position_sec ?? null;
  }, { timeout: 10_000 }).toBe(240);
});

test('pauses sync when the site cookie switches to another account until explicit rebind', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=953');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  const popup = await openPopup(tabId);

  await expect(popup.locator('#account-label')).toContainText('Demo YooKassa');
  await expect(popup.locator('#account-warning')).toContainText('Синхронизация приостановлена');
  await expect(popup.locator('#auto-mark')).not.toBeChecked();
  await expect(popup.locator('#resume-sync')).toBeDisabled();

  const before = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()).length);
  await worker.evaluate(async () => {
    await eval('maybeSyncProgress')({
      match: { status: 'ok', exact: true, animeId: 4242 },
      player: { playbackStarted: true, currentTime: 123, duration: 310, episode: 4 },
      recognition: { voice: 'AniTime Voice' },
    }, true);
  });
  await page.waitForTimeout(300);
  const afterBlocked = await worker.evaluate(async () =>
    (await (await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/progress')).json()).length);
  expect(afterBlocked).toBe(before);

  popup.once('dialog', (dialog) => dialog.accept());
  await popup.locator('#auto-mark').click();
  await expect.poll(async () => worker.evaluate(async () =>
    (await chrome.storage.local.get('sync-account'))['sync-account']?.id)).toBe(953);
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch((globalThis as any).AniRekoRuntimeConfig.apiBase + '/__test/session?on=1&user=18');
  });
  await popup.close();
  await page.close();
});

test('keeps the visible episodic player active when a hidden short video is also playing', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await waitForDetectorReady(tabId);

  await setSyntheticPlayback(page.frameLocator('#hidden-player'), '#hidden-video', {
    currentTime: 20,
    paused: false,
  });
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 155,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 0.5);
  await page.frameLocator('#hidden-player').locator('body').evaluate(() => {
    window.parent.postMessage({ eventType: 'selectEpisode', data: '77' }, '*');
  });
  await page.waitForTimeout(150);

  const popup = await openPopup(tabId);
  await expect(popup.locator('#player-count')).toHaveText('2');
  await expect(popup.locator('#episode')).toHaveText('Серия 2');
  await expect(popup.locator('#progress')).toHaveText('50.0%');
  await expect(popup.locator('#status')).toHaveText('смотрю');
  await expect(popup.locator('#voice')).toHaveText('AniTime Voice');
  expect((await storedTabState(tabId))?.player?.episode).toBe(2);
  await popup.close();
  await page.close();
});

test('native Chrome host access detects an unseen site and its cross-origin player', async () => {
  const unseenOrigin = `http://127.0.0.3:${fixturePort}`;
  const page = await context.newPage();
  await page.goto(`${unseenOrigin}/anime.html`);
  const tabId = await extensionTabId(`${unseenOrigin}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');
  await waitForDetectorReady(tabId);
  await page.close();
});

test('does not duplicate Chrome site-access controls in the popup', async () => {
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');
  const popup = await openPopup(tabId);
  await expect(popup.locator('#site-access')).toHaveCount(0);
  await expect(popup.getByText('Доступом к сайтам управляет Chrome')).toHaveCount(0);
  await popup.close();
  await page.close();
});

test('deletes local history, caches, account binding, settings and tab state', async () => {
  await worker.evaluate(() => chrome.storage.local.set({
    'watch-history': { records: { sample: { title: 'Secret title' } }, days: {} },
    'resume-bulk': { userId: 18, byAnime: { 1: {} } },
    'auto-mark': true,
    'sync-account': { id: 18, name: 'TestUser' },
  }));
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await expect.poll(async () => (await storedTabState(tabId))?.match?.status ?? null).toBe('ok');
  const popup = await openPopup(tabId);
  popup.once('dialog', (dialog) => void dialog.accept());
  await expect(popup.locator('#delete-local-data')).toHaveAttribute('data-ready', 'true');
  await popup.locator('#delete-local-data').click();
  await expect.poll(() => worker.evaluate(async () =>
    (await chrome.storage.local.get('privacy-consent'))['privacy-consent'])).toBeUndefined();
  await expect(popup.locator('#privacy-disclosure')).toBeVisible();
  const cleanup = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return {
      local,
      sessionKeys: Object.keys(session),
    };
  });
  for (const key of ['watch-history', 'resume-bulk', 'auto-mark', 'sync-account', 'privacy-consent']) {
    expect(cleanup.local[key]).toBeUndefined();
  }
  expect(cleanup.sessionKeys.filter((key) => key.startsWith('tab:'))).toHaveLength(0);
  await popup.close();
  await page.close();
});
