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
      sendMessage: async () => {},
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setIcon: async () => {},
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
  return { context, storage: { local, session }, chrome };
}

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
    'search-cache-version': 3,
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
    'search-cache-version': 3,
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
