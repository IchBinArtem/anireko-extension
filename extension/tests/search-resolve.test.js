const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const extensionDir = path.join(__dirname, '..');
const serviceWorkerPath = path.join(extensionDir, 'service-worker.js');

function makeStorage() {
  const data = new Map();
  return {
    get: async (keys) => {
      if (keys == null) return Object.fromEntries(data);
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) {
        if (data.has(key)) out[key] = data.get(key);
      }
      return out;
    },
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        data.delete(key);
      }
    },
    clear: async () => data.clear(),
    setAccessLevel: async () => {},
  };
}

function loadServiceWorker({ fetchImpl } = {}) {
  const local = makeStorage();
  const session = makeStorage();
  const actionCalls = {
    icon: [],
    badgeText: [],
    badgeBackgroundColor: [],
    badgeTextColor: [],
    title: [],
  };
  void local.set({
    'privacy-consent': { version: 1, acceptedAt: Date.now() },
  });
  const chrome = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '0.0.0' }),
      onMessage: { addListener() {} },
    },
    storage: {
      local,
      session,
      setAccessLevel: async () => {},
    },
    tabs: {
      onRemoved: { addListener() {} },
      get: async (tabId) => ({ id: tabId }),
      sendMessage: async () => {},
    },
    action: {
      setBadgeText: async (value) => actionCalls.badgeText.push(value),
      setBadgeBackgroundColor: async (value) => actionCalls.badgeBackgroundColor.push(value),
      setBadgeTextColor: async (value) => actionCalls.badgeTextColor.push(value),
      setTitle: async (value) => actionCalls.title.push(value),
      setIcon: async (value) => actionCalls.icon.push(value),
    },
    i18n: {
      getMessage: (key) => ({
        extensionName: 'AniReko',
        actionRequiredTitle: 'AniReko — требуется выбрать аниме',
      }[key] || ''),
    },
  };

  const context = vm.createContext({
    console,
    URL,
    globalThis: undefined,
    AbortSignal,
    setTimeout,
    fetch: fetchImpl,
    chrome,
  });
  context.globalThis = context;
  context.importScripts = function importScripts(...urls) {
    for (const url of urls) {
      const filePath = path.resolve(extensionDir, url);
      vm.runInContext(fs.readFileSync(filePath, 'utf8'), context);
    }
  };
  vm.runInContext(fs.readFileSync(serviceWorkerPath, 'utf8'), context);
  return { context, storage: { local, session }, chrome, actionCalls };
}

test('routine progress ticks do not redraw the action icon without a semantic transition', async () => {
  const { context, actionCalls } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  context.statusIcon = (size, state) => ({ size, key: context.actionIconRenderKey(state) });
  const state = {
    recognition: { title: 'Test Anime' },
    match: { status: 'ok' },
    player: {
      playbackStarted: true,
      playing: true,
      watched: false,
      currentTime: 5,
      progress: 0.01,
      reason: 'timeupdate',
    },
  };

  await context.updateActionIcon(7, state);
  await context.updateActionIcon(7, {
    ...state,
    player: { ...state.player, currentTime: 10, progress: 0.02 },
  });
  await context.updateActionIcon(7, {
    ...state,
    player: { ...state.player, currentTime: 15, progress: 0.03 },
  });
  assert.equal(actionCalls.icon.length, 1, 'same playing state renders once');

  const paused = { ...state, player: { ...state.player, playing: false, reason: 'pause' } };
  await context.updateActionIcon(7, paused);
  await context.updateActionIcon(7, {
    ...paused,
    player: { ...paused.player, currentTime: 16, progress: 0.04, reason: 'timeupdate' },
  });
  assert.equal(actionCalls.icon.length, 2, 'pause transition renders exactly once');

  await context.updateActionIcon(7, { ...paused, match: { status: 'ambiguous' } });
  assert.equal(actionCalls.icon.length, 3, 'manual attention transition renders exactly once');
  await context.updateActionIcon(7, { ...paused, match: { status: 'ok', manual: true } });
  assert.equal(actionCalls.icon.length, 4, 'manual resolution renders exactly once');
});

test('navigation and tab removal invalidate per-tab action presentation caches', async () => {
  const { context, actionCalls } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  context.statusIcon = (size, state) => ({ size, key: context.actionIconRenderKey(state) });
  const sender = { tab: { id: 9 }, frameId: 0, documentId: 'doc-1' };
  const firstContext = {
    topFrame: true,
    documentToken: 'token-1',
    documentId: 'doc-1',
    topOrigin: 'https://anime.example',
    origin: 'https://anime.example',
  };
  const firstPage = {
    type: 'page-observed',
    url: 'https://anime.example/watch/1',
    observedAt: Date.now(),
  };

  await context.updateTabState(firstPage, sender, firstContext);
  await context.updateTabState(firstPage, sender, firstContext);
  assert.equal(actionCalls.icon.length, 1, 'same document keeps its render cache');

  await context.updateTabState(
    { ...firstPage, url: 'https://anime.example/watch/2' },
    { ...sender, documentId: 'doc-2' },
    { ...firstContext, documentToken: 'token-2', documentId: 'doc-2' },
  );
  assert.equal(actionCalls.icon.length, 2, 'new document forces one fresh render');

  await context.finalizeRemovedTab(9);
  await context.updateActionIcon(9, {});
  assert.equal(actionCalls.icon.length, 3, 'closed tab drops its presentation cache');
});

test('failed action icon writes are retried and cached only after success', async () => {
  const { context, chrome, actionCalls } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  context.statusIcon = (size, state) => ({ size, key: context.actionIconRenderKey(state) });
  let attempts = 0;
  chrome.action.setIcon = async (value) => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary action failure');
    actionCalls.icon.push(value);
  };
  const state = {
    recognition: { title: 'Test Anime' },
    match: { status: 'ok' },
    player: { playbackStarted: true, playing: true },
  };

  assert.equal(await context.updateActionIcon(8, state), false);
  assert.equal(await context.updateActionIcon(8, state), true);
  assert.equal(await context.updateActionIcon(8, state), false);
  assert.equal(attempts, 2);
  assert.equal(actionCalls.icon.length, 1);
});

function httpErrorFetch(status = 503) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    return { ok: false, status, json: async () => ({}) };
  }
  return { fetchImpl, calls };
}

function staleCompletedMatch() {
  return {
    status: 'ok',
    query: 'Stale Title',
    animeId: 42,
    title: 'Stale Title',
    slug: 'stale-title',
    year: 2024,
    type: 'TV',
    totalEpisodes: 12,
    releaseStatus: 'FINISHED',
    completionMetadataReady: true,
    exact: true,
    resolvedAt: Date.now(),
  };
}

async function seedStaleCache({ context, storage }) {
  const key = context.titleSearchKey('Stale Title');
  await storage.local.set({
    'search-cache': {
      [key]: {
        match: staleCompletedMatch(),
        expiresAt: Date.now() + 24 * 3600 * 1000,
      },
    },
    'search-cache-version': 7,
  });
  return key;
}

test('forceRefresh returns an error on transient search failure, not a stale cached ok', async () => {
  const { fetchImpl, calls } = httpErrorFetch(503);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await seedStaleCache({ context, storage });

  const result = await context.resolveAnimeMatch('Stale Title', { forceRefresh: true });

  assert.equal(result.status, 'error');
  assert.equal(result.query, 'Stale Title');
  assert.equal(result.animeId, undefined);
  assert.match(result.error, /HTTP 503/);
  assert.equal(calls.length, 1);
});

test('forceRefresh returns an error during global backoff, not a stale cached ok', async () => {
  const { fetchImpl, calls } = httpErrorFetch(503);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await seedStaleCache({ context, storage });

  // Prime the global backoff with an unrelated title that has no cache entry.
  const primer = await context.resolveAnimeMatch('Other Title');
  assert.equal(primer.status, 'error');
  assert.match(primer.error, /HTTP 503/);
  assert.ok(calls.length >= 1);

  const callsBeforeBackoff = calls.length;
  const forced = await context.resolveAnimeMatch('Stale Title', { forceRefresh: true });

  assert.equal(forced.status, 'error');
  assert.equal(forced.error, 'search backoff');
  assert.equal(forced.animeId, undefined);
  assert.equal(
    calls.length,
    callsBeforeBackoff,
    'forced refresh must not hit the network while global backoff is active'
  );
});

// KAN-2763 end-to-end guard: the failing paths above must also stop
// maybeAutoMark from treating a stale cached match as a fresh metadata
// refresh. Here the account/trust gates are fully open (auto-mark bound,
// session-info/status-get succeed), so under the old fall-back-to-cache bug
// the stale FINISHED metadata would drive a real status-write: any completed
// write in these tests is the regression manifesting.
function freshFinishedSearchPayload() {
  return {
    data: [{
      id: 42,
      title: 'Stale Title',
      slug: 'stale-title',
      year: 2024,
      type: 'TV',
      episodes: 12,
      release_status: 'FINISHED',
    }],
  };
}

function completionFetch({ searchStatus = 503, failSearchCount = Infinity } = {}) {
  const calls = [];
  let searchAttempts = 0;
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (url.includes('/api/search')) {
      searchAttempts += 1;
      if (searchAttempts <= failSearchCount) {
        return { ok: false, status: searchStatus, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => freshFinishedSearchPayload() };
    }
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/anime/status.php')) {
      if (init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { status: 'watching' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  return { fetchImpl, calls, searchAttempts: () => searchAttempts };
}

function terminalEpisodeState() {
  return {
    recognition: { title: 'Stale Title' },
    sourceOrigin: 'https://player.example',
    match: staleCompletedMatch(),
    player: { watched: true, episode: 12 },
  };
}

async function bindSyncAccount(storage) {
  await storage.local.set({
    'auto-mark': true,
    'sync-account': { id: 7, login: 'tester', boundAt: Date.now() },
    'privacy-consent': { version: 1, acceptedAt: Date.now() },
  });
}

function statusWrites(calls) {
  return calls.filter((call) => call.url.includes('/api/anime/status.php')
    && call.init?.method === 'POST');
}

test('maybeAutoMark does not complete from stale cache when forced refresh fails transiently', async () => {
  const { fetchImpl, calls } = completionFetch();
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await seedStaleCache({ context, storage });
  await bindSyncAccount(storage);
  const state = terminalEpisodeState();

  await context.maybeAutoMark(state);

  assert.equal(state.autoMark, undefined);
  assert.equal(statusWrites(calls).length, 0, 'no completed write from stale metadata');
  assert.equal(
    vm.runInContext("completionMetadataRefreshedInSession.has('42:12')", context),
    false,
    'failed refresh must not be recorded as fresh'
  );
  assert.equal(
    vm.runInContext("(completionMetadataRefreshRetryAt['42:12'] || 0) > Date.now()", context),
    true,
    'bounded retry is scheduled instead'
  );

  const callsAfterFirstAttempt = calls.length;
  await context.maybeAutoMark(state);
  assert.equal(
    calls.length,
    callsAfterFirstAttempt,
    'retry backoff prevents a request storm on repeated ticks'
  );
});

test('maybeAutoMark completes after the bounded retry gets fresh metadata', async () => {
  const { fetchImpl, calls, searchAttempts } = completionFetch({ failSearchCount: 1 });
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await seedStaleCache({ context, storage });
  await bindSyncAccount(storage);
  const state = terminalEpisodeState();

  await context.maybeAutoMark(state);

  assert.equal(searchAttempts(), 1);
  assert.equal(statusWrites(calls).length, 0);
  assert.equal(state.autoMark, undefined);

  // Advance only the internal retry/backoff clocks; production still waits
  // for the existing 120-second bounded retry window.
  vm.runInContext("searchBackoffUntil = 0; completionMetadataRefreshRetryAt['42:12'] = 0", context);
  await context.maybeAutoMark(state);

  assert.equal(searchAttempts(), 2);
  assert.equal(statusWrites(calls).length, 1);
  assert.equal(state.autoMark?.status, 'completed');
  assert.equal(
    vm.runInContext("completionMetadataRefreshedInSession.has('42:12')", context),
    true,
    'only the successful retry is recorded as fresh'
  );
});

test('maybeAutoMark does not complete from stale cache during global backoff', async () => {
  const { fetchImpl, calls } = completionFetch();
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await seedStaleCache({ context, storage });
  await bindSyncAccount(storage);

  // Prime global backoff via an unrelated title.
  const primer = await context.resolveAnimeMatch('Other Title');
  assert.equal(primer.status, 'error');

  const state = terminalEpisodeState();
  const callsBeforeBackoff = calls.length;
  await context.maybeAutoMark(state);

  assert.equal(state.autoMark, undefined);
  assert.equal(statusWrites(calls).length, 0);
  assert.equal(
    vm.runInContext("completionMetadataRefreshedInSession.has('42:12')", context),
    false
  );
  assert.equal(
    calls.length,
    callsBeforeBackoff,
    'forced refresh during backoff must not hit the network'
  );
});

test('maybeAutoMark completes when the forced refresh returns fresh finished metadata', async () => {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (url.includes('/api/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => freshFinishedSearchPayload(),
      };
    }
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/anime/status.php')) {
      if (init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { status: 'watching' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await bindSyncAccount(storage);
  // Cached metadata is stale: title was ONGOING with 12 planned episodes.
  const key = context.titleSearchKey('Stale Title');
  await storage.local.set({
    'search-cache': {
      [key]: {
        match: { ...staleCompletedMatch(), releaseStatus: 'ONGOING' },
        expiresAt: Date.now() + 24 * 3600 * 1000,
      },
    },
    'search-cache-version': 7,
  });
  const state = terminalEpisodeState();
  state.match = { ...staleCompletedMatch(), releaseStatus: 'ONGOING' };

  await context.maybeAutoMark(state);

  const writes = statusWrites(calls);
  assert.equal(writes.length, 1, 'fresh FINISHED metadata completes the title');
  assert.deepEqual(JSON.parse(writes[0].init.body), {
    anime_id: 42,
    status: 'completed',
    expected_user_id: 7,
  });
  assert.equal(state.autoMark?.status, 'completed');
});

test('non-forceRefresh still falls back to a stale cache during global backoff', async () => {
  const { fetchImpl, calls } = httpErrorFetch(503);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await seedStaleCache({ context, storage });

  const cached = await context.resolveAnimeMatch('Stale Title');
  assert.equal(cached.status, 'ok');
  assert.equal(cached.animeId, 42);

  const callsBeforeBackoff = calls.length;
  const primer = await context.resolveAnimeMatch('Other Title');
  assert.equal(primer.status, 'error');
  assert.equal(calls.length, callsBeforeBackoff + 1);

  const fallback = await context.resolveAnimeMatch('Stale Title');

  assert.equal(fallback.status, 'ok');
  assert.equal(fallback.animeId, 42);
  assert.equal(calls.length, callsBeforeBackoff + 1);
});

function searchFetch(rows) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (url.includes('/api/search')) {
      return { ok: true, status: 200, json: async () => ({ data: rows }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  return { fetchImpl, calls };
}

test('Russian number words make 3000 exact and exclude the 100000 lookalike', async () => {
  const { fetchImpl } = searchFetch([
    {
      id: 19119,
      title: 'Три тысячи лет практики ци',
      subtitle: 'Lian Qi Lianle 3000 Nian',
      slug: 'lian-qi-lianle-3000-nian',
      year: 2022,
      type: 'ONA',
      episodes: 16,
      release_status: 'FINISHED',
    },
    {
      id: 19120,
      title: 'Практикуя ци сто тысяч лет',
      subtitle: 'Lian Qi Shi Wan Nian',
      slug: 'lian-qi-shi-wan-nian',
      year: 2023,
      type: 'ONA',
      episodes: 360,
      release_status: 'ONGOING',
    },
  ]);
  const { context } = loadServiceWorker({ fetchImpl });

  const result = await context.resolveAnimeMatch('3000 лет практики ци');

  assert.equal(context.titleSearchKey('3000 лет практики ци'), '3000 лет практики ци');
  assert.equal(
    context.titleSearchKey('Три тысячи лет практики ци'),
    context.titleSearchKey('3000 лет практики ци'),
  );
  assert.notEqual(
    context.titleSearchKey('Практикуя ци сто тысяч лет'),
    context.titleSearchKey('3000 лет практики ци'),
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.exact, true);
  assert.equal(result.animeId, 19119);
  const mixedDigitsResult = await context.resolveAnimeMatch('3 тысячи лет практики ци');
  assert.equal(
    context.titleSearchKey('3 тысячи лет практики ци'),
    context.titleSearchKey('Три тысячи лет практики ци'),
  );
  assert.equal(mixedDigitsResult.status, 'ok');
  assert.equal(mixedDigitsResult.animeId, 19119);
  const manualSearch = await context.popupSearchAnime('Три тысячи лет практики ци');
  assert.deepEqual(
    Array.from(manualSearch.payload.candidates, (candidate) => candidate.animeId),
    [19119],
  );
  const mixedDigitsManualSearch = await context.popupSearchAnime('3 тысячи лет практики ци');
  assert.deepEqual(
    Array.from(mixedDigitsManualSearch.payload.candidates, (candidate) => candidate.animeId),
    [19119],
  );
});

test('explicit fourth season resolves through a unique catalog alias probe', async () => {
  const calls = [];
  const fourthSeason = {
    id: 13124,
    title: 'Власть книжного червя: Приёмная дочь лорда',
    subtitle: 'Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen - Ryoushu no Youjo',
    slug: 'honzuki-no-gekokujou-ryoushu-no-youjo',
    year: 2026,
    type: 'TV',
    episodes: 24,
    release_status: 'ONGOING',
    exact_alias_match: true,
  };
  const primaryRows = [
    {
      id: 13126,
      title: 'Власть книжного червя 3',
      subtitle: 'Honzuki no Gekokujou 3rd Season',
      year: 2022,
      type: 'TV',
    },
    {
      id: 13123,
      title: 'Власть книжного червя',
      subtitle: 'Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen',
      year: 2019,
      type: 'TV',
    },
    {
      id: 13125,
      title: 'Власть книжного червя 2',
      subtitle: 'Honzuki no Gekokujou 2nd Season',
      year: 2020,
      type: 'TV',
    },
    { id: 13127, title: 'Власть книжного червя OVA', year: 2020, type: 'OVA' },
    { id: 13128, title: 'Власть книжного червя: Рекапы', year: 2022, type: 'SPECIAL' },
    fourthSeason,
  ];
  async function fetchImpl(url) {
    calls.push(url);
    const query = new URL(url).searchParams.get('q');
    const rows = /4th Season$/iu.test(query) ? [fourthSeason] : primaryRows;
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  }
  const { context, storage } = loadServiceWorker({ fetchImpl });
  const wanted = context.titleSearchKey('Власть книжного червя 4 сезон');
  await storage.local.set({
    'search-cache-version': 6,
    'search-cache': {
      [wanted]: {
        match: { status: 'ambiguous', query: 'Власть книжного червя 4 сезон' },
        expiresAt: Date.now() + 24 * 3600 * 1000,
      },
    },
  });

  const result = await context.resolveAnimeMatch('Власть книжного червя 4 сезон');

  assert.equal(result.status, 'ok');
  assert.equal(result.exact, true);
  assert.equal(result.manual, false);
  assert.equal(result.seasonAlias, true);
  assert.equal(result.animeId, 13124);
  assert.equal(context.confirmedAnimeMatch(result), true);
  assert.equal((await storage.local.get('search-cache-version'))['search-cache-version'], 7);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]).searchParams.get('limit'), '20');
  assert.equal(new URL(calls[0]).searchParams.get('exact_alias'), '1');
  assert.equal(
    new URL(calls[1]).searchParams.get('q'),
    'Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen 4th Season',
  );

  const manualSearch = await context.popupSearchAnime('Власть книжного червя 4 сезон');
  assert.equal(manualSearch.ok, true);
  assert.equal(manualSearch.payload.candidates[0].animeId, 13124);
});

test('season alias probe stays ambiguous when the catalog does not confirm one unique serial', async () => {
  const primaryRows = [
    {
      id: 1,
      title: 'Тестовая сага',
      subtitle: 'Test Saga',
      year: 2020,
      type: 'TV',
    },
    { id: 4, title: 'Тестовая сага: Новая арка', subtitle: 'Test Saga: New Arc', year: 2026, type: 'TV' },
  ];
  async function fetchImpl(url) {
    const query = new URL(url).searchParams.get('q');
    const rows = /4th Season$/iu.test(query) ? [primaryRows[0]] : primaryRows;
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  }
  const { context, storage } = loadServiceWorker({ fetchImpl });
  const before = Date.now();

  const result = await context.resolveAnimeMatch('Тестовая сага 4 сезон');
  const cache = (await storage.local.get('search-cache'))['search-cache'];
  const cached = cache[context.titleSearchKey('Тестовая сага 4 сезон')];

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.animeId, undefined);
  assert.ok(cached.expiresAt >= before);
  assert.ok(cached.expiresAt <= before + 5 * 60_000 + 1000);
});

test('manual search does not probe or reorder an existing unique exact season title', async () => {
  let calls = 0;
  async function fetchImpl() {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ data: [{
      id: 4,
      title: 'Тестовая сага 4 сезон',
      subtitle: 'Test Saga Season 4',
      year: 2026,
      type: 'TV',
    }] }) };
  }
  const { context } = loadServiceWorker({ fetchImpl });

  const result = await context.popupSearchAnime('Тестовая сага 4 сезон');

  assert.equal(result.ok, true);
  assert.equal(result.payload.candidates[0].animeId, 4);
  assert.equal(calls, 1);
});

test('manual season search keeps primary candidates when the alias probe is unavailable', async () => {
  let calls = 0;
  async function fetchImpl() {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ data: [{
        id: 1,
        title: 'Тестовая сага',
        subtitle: 'Test Saga',
        year: 2020,
        type: 'TV',
      }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  }
  const { context } = loadServiceWorker({ fetchImpl });

  const result = await context.popupSearchAnime('Тестовая сага 4 сезон');

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.payload.candidates, (candidate) => candidate.animeId), [1]);
});

test('automatic season probe failure stays ambiguous, retries soon, and does not trip global backoff', async () => {
  let calls = 0;
  async function fetchImpl() {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ data: [{
        id: 1,
        title: 'Тестовая сага',
        subtitle: 'Test Saga',
        year: 2020,
        type: 'TV',
      }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  }
  const { context, storage } = loadServiceWorker({ fetchImpl });

  const before = Date.now();
  const result = await context.resolveAnimeMatch('Тестовая сага 4 сезон');
  const cache = (await storage.local.get('search-cache'))['search-cache'];
  const cached = cache[context.titleSearchKey('Тестовая сага 4 сезон')];

  assert.equal(result.status, 'ambiguous');
  assert.equal(calls, 2);
  assert.ok(cached.expiresAt >= before);
  assert.ok(cached.expiresAt <= before + 5 * 60_000 + 1000);
  assert.equal(vm.runInContext('searchBackoffUntil', context), 0);
});

test('action badge and title stay highlighted until the user resolves the match', async () => {
  const { context, actionCalls } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const state = {
    recognition: { title: 'Неоднозначное имя' },
    match: { status: 'ambiguous' },
    taste: null,
  };

  await context.updateMatchBadge(42, state);
  assert.deepEqual({ ...actionCalls.badgeText.at(-1) }, { tabId: 42, text: '!' });
  assert.deepEqual(
    { ...actionCalls.badgeBackgroundColor.at(-1) },
    { tabId: 42, color: '#ffa502' },
  );
  assert.deepEqual({ ...actionCalls.title.at(-1) }, {
    tabId: 42,
    title: 'AniReko — требуется выбрать аниме',
  });

  state.match = { status: 'none' };
  state.taste = { status: 'ok', percent: 46, labelKey: 'mixed' };
  await context.updateMatchBadge(42, state);
  assert.deepEqual({ ...actionCalls.badgeText.at(-1) }, { tabId: 42, text: '!' });
  assert.deepEqual(
    { ...actionCalls.badgeBackgroundColor.at(-1) },
    { tabId: 42, color: '#ffa502' },
  );

  state.match = { status: 'ok', exact: true, animeId: 19119 };
  await context.updateMatchBadge(42, state);
  assert.deepEqual({ ...actionCalls.badgeText.at(-1) }, { tabId: 42, text: '46' });
  assert.deepEqual(
    { ...actionCalls.badgeBackgroundColor.at(-1) },
    { tabId: 42, color: '#ffd93d' },
  );
  assert.deepEqual({ ...actionCalls.title.at(-1) }, { tabId: 42, title: 'AniReko' });
});

test('equivalent action badge states are rendered only once', async () => {
  const { context, actionCalls } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const state = {
    recognition: { title: 'Ambiguous title' },
    match: { status: 'ambiguous' },
    taste: null,
  };

  await context.updateMatchBadge(43, state);
  state.match = { status: 'none' };
  state.taste = { status: 'ok', percent: 46, labelKey: 'mixed' };
  await context.updateMatchBadge(43, state);

  assert.deepEqual(
    {
      badgeText: actionCalls.badgeText.length,
      badgeBackgroundColor: actionCalls.badgeBackgroundColor.length,
      badgeTextColor: actionCalls.badgeTextColor.length,
      title: actionCalls.title.length,
    },
    { badgeText: 1, badgeBackgroundColor: 1, badgeTextColor: 1, title: 1 },
  );
});

test('partially failed badge writes retry the whole presentation before caching', async () => {
  const { context, chrome, actionCalls } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  let titleAttempts = 0;
  chrome.action.setTitle = async (value) => {
    titleAttempts += 1;
    if (titleAttempts === 1) throw new Error('temporary title failure');
    actionCalls.title.push(value);
  };
  const state = {
    recognition: { title: 'Ambiguous title' },
    match: { status: 'ambiguous' },
    taste: null,
  };

  assert.equal(await context.updateMatchBadge(44, state), false);
  assert.equal(await context.updateMatchBadge(44, state), true);
  assert.equal(await context.updateMatchBadge(44, state), false);
  assert.equal(titleAttempts, 2);
  assert.equal(actionCalls.badgeText.length, 2);
  assert.equal(actionCalls.badgeBackgroundColor.length, 2);
  assert.equal(actionCalls.badgeTextColor.length, 2);
  assert.equal(actionCalls.title.length, 1);
});

test('multiple exact catalog rows remain ambiguous', async () => {
  const { fetchImpl } = searchFetch([
    { id: 10, title: 'Одинаковое имя', type: 'TV', episodes: 12, release_status: 'FINISHED' },
    { id: 11, title: 'Одинаковое имя', type: 'ONA', episodes: 6, release_status: 'FINISHED' },
  ]);
  const { context } = loadServiceWorker({ fetchImpl });

  const result = await context.resolveAnimeMatch('Одинаковое имя');

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(Array.from(result.candidates, (candidate) => candidate.animeId), [10, 11]);
});

test('manual binding is local, title-scoped, and authorizes only the selected anime id', async () => {
  const { fetchImpl } = searchFetch([{
    id: 19119,
    title: 'Три тысячи лет практики ци',
    slug: 'lian-qi-lianle-3000-nian',
    year: 2022,
    type: 'ONA',
    episodes: 16,
    release_status: 'FINISHED',
  }]);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  const candidate = context.catalogCandidate({
    id: 19119,
    title: 'Три тысячи лет практики ци',
    slug: 'lian-qi-lianle-3000-nian',
    year: 2022,
    type: 'ONA',
    episodes: 16,
    release_status: 'FINISHED',
  });
  const wanted = context.titleSearchKey('3000 лет практики ци');

  await context.saveManualMatchBinding(wanted, candidate);
  const result = await context.resolveAnimeMatch('3000 лет практики ци');
  const stored = await storage.local.get('manual-match-bindings');

  assert.equal(result.status, 'ok');
  assert.equal(result.manual, true);
  assert.equal(result.exact, false);
  assert.equal(result.animeId, 19119);
  assert.equal(context.confirmedAnimeMatch(result), true);
  assert.equal(stored['manual-match-bindings'].version, 2);
  assert.deepEqual(Object.keys(stored['manual-match-bindings'].items), [wanted]);
});

test('manual binding never stores or replays the raw search query', async () => {
  const { fetchImpl, calls } = searchFetch([{
    id: 19119,
    title: 'Три тысячи лет практики ци',
    slug: 'lian-qi-lianle-3000-nian',
    year: 2022,
    type: 'ONA',
    episodes: 16,
    release_status: 'FINISHED',
  }]);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  const candidate = context.catalogCandidate({
    id: 19119,
    title: 'Три тысячи лет практики ци',
    slug: 'lian-qi-lianle-3000-nian',
    year: 2022,
    type: 'ONA',
    episodes: 16,
    release_status: 'FINISHED',
  });
  const wanted = context.titleSearchKey('3000 лет практики ци');

  await context.saveManualMatchBinding(
    wanted,
    candidate,
    'https://source.example/watch/3000-let-praktiki-ci'
  );
  const stored = await storage.local.get('manual-match-bindings');
  const serialized = JSON.stringify(stored['manual-match-bindings']);
  assert.equal(serialized.includes('source.example'), false);
  assert.equal(serialized.includes('https://'), false);

  const refreshed = await context.resolveAnimeMatch('3000 лет практики ци', { forceRefresh: true });
  const searchUrl = new URL(calls.at(-1).url);
  assert.equal(refreshed.manual, true);
  assert.equal(searchUrl.searchParams.get('q'), 'Три тысячи лет практики ци');
});

test('legacy version-1 bindings with raw lookup queries are ignored without replay', async () => {
  const { fetchImpl, calls } = searchFetch([]);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  const wanted = context.titleSearchKey('Legacy source title');
  await storage.local.set({
    'manual-match-bindings': {
      version: 1,
      items: {
        [wanted]: {
          animeId: 42,
          title: 'Catalog title',
          lookupQuery: 'https://private.example/watch/secret',
        },
      },
    },
  });

  const result = await context.resolveAnimeMatch('Legacy source title');

  assert.equal(result.status, 'none');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes('private.example'), false);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'Legacy source title');
});

test('concurrent manual bindings are serialized instead of losing one title', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => {
    throw new Error('network must not be called');
  } });
  const first = context.catalogCandidate({ id: 10, title: 'Первый', type: 'TV' });
  const second = context.catalogCandidate({ id: 11, title: 'Второй', type: 'ONA' });

  await Promise.all([
    context.saveManualMatchBinding(context.titleSearchKey('Source one'), first),
    context.saveManualMatchBinding(context.titleSearchKey('Source two'), second),
  ]);

  const stored = await storage.local.get('manual-match-bindings');
  assert.deepEqual(
    Object.keys(stored['manual-match-bindings'].items).sort(),
    ['source one', 'source two']
  );
});

test('revoked privacy consent blocks popup search and every account write gate', async () => {
  const calls = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return { ok: false, status: 500, json: async () => ({}) };
  } });
  await bindSyncAccount(storage);
  await storage.local.set({
    'privacy-consent': { version: 1, declinedAt: Date.now() },
  });

  const search = await context.popupSearchAnime('Три тысячи лет практики ци');
  await context.maybeAutoMark(terminalEpisodeState());

  assert.equal(search.status, 403);
  assert.equal(search.payload.error, 'privacy_consent_required');
  assert.equal(calls.length, 0);
});

test('manual selection immediately syncs current progress and terminal status', async () => {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (url.includes('/api/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{
          id: 19119,
          title: 'Три тысячи лет практики ци',
          slug: 'lian-qi-lianle-3000-nian',
          year: 2022,
          type: 'ONA',
          episodes: 16,
          release_status: 'FINISHED',
        }] }),
      };
    }
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/anime/19119/match')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { has_profile: false } }) };
    }
    if (url.includes('/api/extension/progress.php')) {
      return { ok: true, status: 204, json: async () => null };
    }
    if (url.includes('/api/anime/status.php')) {
      return init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ success: true }) }
        : { ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await bindSyncAccount(storage);
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: '3000 лет практики ци' },
    sourceOrigin: 'https://anime.example',
    player: {
      watched: true,
      playbackStarted: true,
      episode: 16,
      currentTime: 1260,
      duration: 1260,
      voice: 'АниСтар',
    }
  }`, context);

  const response = await context.bindPopupAnime({
    tabId: 5,
    animeId: 19119,
    query: 'Три тысячи лет практики ци',
  });

  assert.equal(response.ok, true);
  const progressWrites = calls.filter((call) => call.url.includes('/api/extension/progress.php')
    && call.init?.method === 'POST');
  const statusWritesForSelection = statusWrites(calls);
  assert.equal(progressWrites.length, 1);
  assert.equal(statusWritesForSelection.length, 1);
  assert.equal(JSON.parse(progressWrites[0].init.body).anime_id, 19119);
  assert.equal(JSON.parse(statusWritesForSelection[0].init.body).status, 'completed');
});

test('manual sync uses completed local history when a reloaded player is waiting to continue', async () => {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (url.includes('/api/search')) {
      return { ok: true, status: 200, json: async () => ({ data: [{
        id: 19119,
        title: 'Three Thousand Years of Qi Practice',
        slug: 'three-thousand-years-of-qi-practice',
        year: 2022,
        type: 'ONA',
        episodes: 16,
        release_status: 'FINISHED',
      }] }) };
    }
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/extension/progress.php')) {
      return { ok: true, status: 204, json: async () => null };
    }
    if (url.includes('/api/anime/status.php')) {
      return init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ success: true }) }
        : { ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const { context, storage } = loadServiceWorker({ fetchImpl });
  await bindSyncAccount(storage);
  await storage.local.set({
    'watch-history': {
      records: {
        'three thousand years of qi practice::16': {
          title: 'Three Thousand Years of Qi Practice',
          episode: 16,
          position: 1260,
          duration: 1260,
          progress: 1,
          completed: true,
          voice: 'AniStar',
          lastWatchedAt: Date.now() - 60_000,
        },
      },
      days: {},
    },
  });
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: 'Three Thousand Years of Qi Practice' },
    sourceOrigin: 'https://anime.example',
    match: {
      status: 'ok', exact: true, animeId: 19119,
      query: 'Three Thousand Years of Qi Practice',
      title: 'Three Thousand Years of Qi Practice',
      type: 'ONA', totalEpisodes: 16, releaseStatus: 'FINISHED',
      completionMetadataReady: true, resolvedAt: Date.now()
    },
    player: { player: 'iframe-shell', episode: 16, playbackStarted: false }
  }`, context);

  const confirmation = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 7 });
  assert.equal(confirmation.payload.confirmationRequired, true);
  assert.equal(calls.some((call) => call.init?.method === 'POST'), false);
  const response = await context.syncPopupCurrent({
    tabId: 5,
    expectedUserId: 7,
    confirmLegacyHistory: true,
  });
  const progressWrite = calls.find((call) => call.url.includes('/api/extension/progress.php')
    && call.init?.method === 'POST');
  const statusWrite = statusWrites(calls)[0];

  assert.equal(response.ok, true);
  assert.equal(response.payload.progressSynced, true);
  assert.equal(response.payload.statusSynced, true);
  assert.equal(JSON.parse(progressWrite.init.body).episode, 16);
  assert.equal(JSON.parse(progressWrite.init.body).position_sec, 1260);
  assert.equal(JSON.parse(statusWrite.init.body).status, 'completed');
  const migratedHistory = (await storage.local.get('watch-history'))['watch-history'];
  assert.equal(migratedHistory.records['three thousand years of qi practice::16'].animeId, 19119);
});

test('manual sync reports no writes when neither live nor saved progress is available', async () => {
  const calls = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  await bindSyncAccount(storage);
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: 'Waiting Anime' },
    sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 42 },
    player: { player: 'iframe-shell', episode: 2, playbackStarted: false }
  }`, context);

  const response = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 7 });

  assert.equal(response.ok, true);
  assert.equal(response.payload.progressSynced, false);
  assert.equal(response.payload.statusSynced, false);
  assert.equal(calls.some((call) => call.init?.method === 'POST'), false);
});

test('manual sync uses the latest saved episode when the current episode is unknown', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => {
    throw new Error('network must not be called while selecting history');
  } });
  await storage.local.set({
    'watch-history': {
      records: {
        'history selection anime::3': {
          animeId: 42,
          episode: 3,
          position: 1200,
          duration: 1200,
          completed: true,
          lastWatchedAt: 1000,
        },
        'history selection anime::4': {
          animeId: 42,
          episode: 4,
          position: 600,
          duration: 1200,
          completed: false,
          lastWatchedAt: 2000,
        },
      },
      days: {},
    },
  });
  const selected = context.historyPlayerForManualSync({
    recognition: { title: 'History Selection Anime' },
    match: { status: 'ok', exact: true, animeId: 42 },
    player: { player: 'iframe-shell', playbackStarted: false },
  }, await context.loadHistory());

  assert.equal(selected.episode, 4);
  assert.equal(selected.currentTime, 600);
  assert.equal(selected.watched, false);
});

test('manual sync never reuses a same-title history record bound to another anime', async () => {
  const { context } = loadServiceWorker({ fetchImpl: async () => {
    throw new Error('network must not be called while selecting history');
  } });
  const selected = context.historyPlayerForManualSync({
    recognition: { title: 'Fruits Basket' },
    match: { status: 'ok', exact: true, animeId: 52 },
    player: { player: 'iframe-shell', episode: 26, playbackStarted: false },
  }, {
    records: {
      'fruits basket::26': {
        animeId: 51,
        episode: 26,
        position: 1200,
        duration: 1200,
        completed: true,
        lastWatchedAt: 2000,
      },
    },
    days: {},
  });

  assert.equal(selected, null);
});

test('manual sync sends a pre-bound full-length movie history record without an episode', async () => {
  const calls = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/extension/progress.php')) {
      return { ok: true, status: 204, json: async () => null };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  await bindSyncAccount(storage);
  await storage.local.set({
    'watch-history': {
      records: {
        'history movie::full': {
          animeId: 42,
          episode: null,
          position: 600,
          duration: 1200,
          completed: false,
          lastWatchedAt: 2000,
        },
      },
      days: {},
    },
  });
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: 'History Movie' },
    sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 42, type: 'MOVIE' },
    player: { player: 'iframe-shell', playbackStarted: false }
  }`, context);

  const response = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 7 });
  const progressWrite = calls.find((call) => call.url.includes('/api/extension/progress.php')
    && call.init?.method === 'POST');

  assert.equal(response.payload.progressSynced, true);
  assert.equal(JSON.parse(progressWrite.init.body).episode, null);
  assert.equal(JSON.parse(progressWrite.init.body).position_sec, 600);
});

test('manual sync prefers a usable live player over completed saved history', async () => {
  const calls = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/extension/progress.php')) {
      return { ok: true, status: 204, json: async () => null };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  await bindSyncAccount(storage);
  await storage.local.set({
    'watch-history': {
      records: {
        'rewatch anime::12': {
          animeId: 42,
          episode: 12,
          position: 1260,
          duration: 1260,
          completed: true,
          lastWatchedAt: 1000,
        },
      },
      days: {},
    },
  });
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: 'Rewatch Anime' },
    sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 42 },
    player: {
      player: 'html5', episode: 12, playbackStarted: true,
      currentTime: 300, duration: 1260, watched: false
    }
  }`, context);

  const response = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 7 });
  const progressWrite = calls.find((call) => call.url.includes('/api/extension/progress.php')
    && call.init?.method === 'POST');

  assert.equal(response.payload.progressSynced, true);
  assert.equal(response.payload.statusSynced, false);
  assert.equal(JSON.parse(progressWrite.init.body).position_sec, 300);
  assert.equal(statusWrites(calls).length, 0);
});

test('manual sync reports a failed eligible write instead of no new data', async () => {
  const calls = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    if (url.includes('/api/extension/progress.php')) {
      return { ok: false, status: 500, json: async () => ({ error: 'temporary' }) };
    }
    if (url.includes('/api/anime/status.php')) {
      return { ok: true, status: 200, json: async () => ({
        success: true,
        data: { status: 'completed' },
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  await bindSyncAccount(storage);
  await storage.local.set({
    'watch-history': {
      records: {
        'failed sync anime::12': {
          animeId: 42,
          episode: 12,
          position: 1260,
          duration: 1260,
          completed: true,
          lastWatchedAt: 2000,
        },
      },
      days: {},
    },
  });
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: 'Failed Sync Anime' },
    sourceOrigin: 'https://anime.example',
    match: {
      status: 'ok', exact: true, animeId: 42, totalEpisodes: 12,
      releaseStatus: 'FINISHED', completionMetadataReady: true
    },
    player: { player: 'iframe-shell', episode: 12, playbackStarted: false }
  }`, context);

  const response = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 7 });

  assert.equal(response.payload.progressSynced, false);
  assert.equal(response.payload.writeFailed, true);
  assert.equal(calls.some((call) => call.url.includes('/api/extension/progress.php')
    && call.init?.method === 'POST'), true);
});

test('history fallback still fails closed for an untrusted source origin', async () => {
  const calls = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 7 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  await bindSyncAccount(storage);
  await storage.local.set({
    'watch-history': {
      records: {
        'untrusted anime::2': {
          animeId: 42,
          episode: 2,
          position: 600,
          duration: 600,
          completed: true,
          lastWatchedAt: 2000,
        },
      },
      days: {},
    },
  });
  vm.runInContext(`stateByTab['5'] = {
    recognition: { title: 'Untrusted Anime' },
    sourceOrigin: 'chrome-extension://malicious',
    match: { status: 'ok', exact: true, animeId: 42 },
    player: { player: 'iframe-shell', episode: 2, playbackStarted: false }
  }`, context);

  const response = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 7 });

  assert.equal(response.payload.progressSynced, false);
  assert.equal(response.payload.statusSynced, false);
  assert.equal(calls.some((call) => call.init?.method === 'POST'), false);
});

test('manual sync for a stale tab catches the tabs.get rejection and performs no write', async () => {
  const { context, storage, chrome } = loadServiceWorker({ fetchImpl: async () => {
    throw new Error('network must not be called');
  } });
  await storage.local.set({
    'auto-mark': true,
    'sync-account': { id: 7 },
    'privacy-consent': { version: 1, acceptedAt: Date.now() },
  });
  await storage.session.set({
    'tab:999': {
      recognition: { title: 'Closed tab anime' },
      sourceOrigin: 'https://anime.example',
      match: { status: 'ok', exact: true, animeId: 42 },
      player: { playbackStarted: true, currentTime: 100, duration: 310, episode: 2 },
    },
  });
  chrome.tabs.get = async () => { throw new Error('No tab with id: 999'); };

  const response = await context.syncPopupCurrent({ tabId: 999, expectedUserId: 7 });

  assert.equal(response.ok, false);
  assert.equal(response.status, 404);
  assert.equal(response.payload.error, 'tab_not_found');
});
