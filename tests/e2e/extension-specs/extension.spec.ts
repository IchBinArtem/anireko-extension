import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourceExtensionPath = path.resolve(__dirname, '../../../extension');
const apiBase = 'http://127.0.0.1:4178';
const siteBase = 'http://127.0.0.2:4178';
const playerBase = 'http://localhost:4178';

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let userDataDir: string;
let testRootDir: string;
let extensionPath: string;

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

test.beforeAll(async () => {
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
    apiBase: 'http://127.0.0.1:4178',
    testMode: true,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
`, 'utf8');
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anireko-extension-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
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
});

test.afterAll(async () => {
  await context?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(testRootDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await worker.evaluate(async () => {
    await fetch('http://127.0.0.1:4178/__test/reset');
    (globalThis as any).AniRekoTestHooks.resetVolatileCaches();
    const access = await chrome.storage.local.get(['privacy-consent']);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(access);
  });
});

test('recognizes anime before playback and confirms player after playback starts', async () => {
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

  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 60,
    paused: false,
  });
  await waitForPlayerProgress(tabId, 60 / 310);
  await expect.poll(async () => {
    const history = await worker.evaluate(async () => (await chrome.storage.local.get('watch-history'))['watch-history']);
    const record = Object.values(history?.records || {})[0] as { watchedSeconds?: number } | undefined;
    return record?.watchedSeconds || 0;
  }, { timeout: 25_000 }).toBeGreaterThan(3);
  await popup.reload();

  await expect(popup.locator('#player-check')).toHaveClass(/success/);
  await expect(popup.locator('#episode')).toHaveText('Серия 2');
  await expect(popup.locator('#status')).toHaveText('смотрю');
  await expect(popup.locator('#progress')).toHaveText(/\d+\.\d%/);
  await expect(popup.locator('#title')).toHaveText('Расхититель гробниц');
  await expect(popup.locator('#anireko-match')).toHaveText('В каталоге: Расхититель гробниц (2024)');
  await expect(popup.locator('#anime-primary-action')).toHaveText('Открыть в AniReko →');
  await expect(popup.locator('#anime-primary-action'))
    .toHaveAttribute('href', 'http://127.0.0.1:4178/ru/anime/tomb-raider-4242');
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

test('falls back to player URL episode and labeled combobox voice', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
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
    (await (await fetch('http://127.0.0.1:4178/__test/progress')).json()));
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
    (await (await fetch('http://127.0.0.1:4178/__test/request-counts')).json()));
  expect(before).toMatchObject({ search: 0, sessionInfo: 0, diagnostics: 0 });

  await popup.locator('#report-anime-miss').click();
  await expect(popup.locator('#report-anime-miss')).toHaveText('Отправлено, спасибо');
  const diagnostics = await worker.evaluate(async () =>
    (await (await fetch('http://127.0.0.1:4178/__test/diagnostics')).json()));
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
    (await (await fetch('http://127.0.0.1:4178/__test/request-counts')).json()));
  expect(after).toMatchObject({ search: 0, sessionInfo: 0, diagnostics: 1 });
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

test('auto-reports a diagnostic when the anime is recognized but the player is unreadable', async () => {
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
    (await (await fetch('http://127.0.0.1:4178/__test/diagnostics')).json()));
  await page.waitForTimeout(2_000);
  expect(await readDiagnostics()).toHaveLength(0);
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('privacy-consent');
    await chrome.storage.local.set({
      'privacy-consent': { ...stored['privacy-consent'], diagnostics: true },
    });
  });
  await page.reload();
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
  await secondPage.waitForTimeout(3_000);
  expect(await readDiagnostics()).toHaveLength(1);
  await secondPage.close();
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
  await popup.close();
  await page.close();
});

test('auto-marks watching on a completed episode 2+ even without earlier local history', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch('http://127.0.0.1:4178/__test/session?on=1');
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
    (await (await fetch('http://127.0.0.1:4178/__test/status-posts')).json()));
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
      'search-cache-version': 3,
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
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
    await fetch('http://127.0.0.1:4178/__test/watch-status?value=watching');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/*`);
  await page.frameLocator('#main-player').locator('#episode-select')
    .selectOption({ label: '12 серия' });
  await expect.poll(async () => (await storedTabState(tabId))?.player?.episode ?? null)
    .toBe(12);
  await setSyntheticPlayback(page.frameLocator('#main-player'), '#main-video', {
    currentTime: 260,
    paused: false,
  });

  const readPosts = () => worker.evaluate(async () =>
    (await (await fetch('http://127.0.0.1:4178/__test/status-posts')).json()));
  await expect.poll(readPosts, { timeout: 15_000 })
    .toEqual([{ anime_id: 4242, status: 'completed', expected_user_id: 18 }]);
  const countsAfterTransition = await worker.evaluate(async () =>
    (await (await fetch('http://127.0.0.1:4178/__test/request-counts')).json()));
  expect(countsAfterTransition.search).toBe(1);

  // More watched ticks are folded by the local transition key before the
  // account/session lookup, not merely before the final POST.
  await page.waitForTimeout(6_000);
  const countsAfterMoreTicks = await worker.evaluate(async () =>
    (await (await fetch('http://127.0.0.1:4178/__test/request-counts')).json()));
  expect(countsAfterMoreTicks.search).toBe(countsAfterTransition.search);
  expect(countsAfterMoreTicks.statusPosts).toBe(countsAfterTransition.statusPosts);
  await page.close();
});

test('scopes taste cache to the live AniReko account', async () => {
  await worker.evaluate(async () => {
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
  });
  const page = await context.newPage();
  await page.goto(`${siteBase}/anime.html`);
  const tabId = await extensionTabId(`${siteBase}/anime.html`);
  await expect.poll(async () => (await storedTabState(tabId))?.taste?.percent ?? null).toBe(87);

  await worker.evaluate(async () => {
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=953');
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
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
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
    (await (await fetch('http://127.0.0.1:4178/__test/progress')).json()));
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
  await syncButton.click();
  await expect(syncButton).toHaveText('✓ обновлено');
  await expect(syncButton).toBeDisabled();
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
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
    const state = {
      sourceOrigin: 'http://127.0.0.2:4178',
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
    (await (await fetch('http://127.0.0.1:4178/__test/request-counts')).json()));
  expect(counts.maxProgressPostsInFlight).toBe(1);
  const directPosts = await worker.evaluate(async () =>
    (await (await fetch('http://127.0.0.1:4178/__test/progress')).json()));
  expect(directPosts.map((post: { position_sec: number }) => post.position_sec)).toEqual([100, 200]);

  const coldTabId = 987654;
  await worker.evaluate(async ({ id, key }) => {
    const state = {
      sourceOrigin: 'http://127.0.0.2:4178',
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
      (await (await fetch('http://127.0.0.1:4178/__test/progress')).json()));
    return posts.at(-1)?.position_sec ?? null;
  }, { timeout: 10_000 }).toBe(240);
});

test('pauses sync when the site cookie switches to another account until explicit rebind', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      'auto-mark': true,
      'sync-account': { id: 18, name: 'TestUser' },
    });
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=953');
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
    (await (await fetch('http://127.0.0.1:4178/__test/progress')).json()).length);
  await worker.evaluate(async () => {
    await eval('maybeSyncProgress')({
      match: { status: 'ok', exact: true, animeId: 4242 },
      player: { playbackStarted: true, currentTime: 123, duration: 310, episode: 4 },
      recognition: { voice: 'AniTime Voice' },
    }, true);
  });
  await page.waitForTimeout(300);
  const afterBlocked = await worker.evaluate(async () =>
    (await (await fetch('http://127.0.0.1:4178/__test/progress')).json()).length);
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
    await fetch('http://127.0.0.1:4178/__test/session?on=1&user=18');
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
  const unseenOrigin = 'http://127.0.0.3:4178';
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
