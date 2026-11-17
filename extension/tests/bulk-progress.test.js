const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function storage(seed = {}) {
  const data = structuredClone(seed);
  return {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => Object.hasOwn(data, k)).map(k => [k, structuredClone(data[k])])); },
    async set(items) { Object.assign(data, structuredClone(items)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async clear() { for (const key of Object.keys(data)) delete data[key]; },
    async setAccessLevel() {}, data,
  };
}
function worker(local = storage()) {
  const session = storage();
  Object.assign(local.data, { 'privacy-consent': { version: 1, acceptedAt: Date.now() },
    'auto-mark': true, 'sync-account': { id: 1 } });
  const chrome = { runtime: { id: 'id', onMessage: { addListener() {} } }, storage: { local, session },
    tabs: { onRemoved: { addListener() {} } }, action: {} };
  const context = vm.createContext({ chrome, console, crypto: require('node:crypto').webcrypto, URL, URLSearchParams,
    TextEncoder, AbortSignal, setTimeout, fetch: async () => { throw Error('unexpected fetch'); } });
  context.importScripts = (...files) => files.forEach(file => {
    if (file === 'lib/api-client.js') context.AniRekoApiClient = { create: () => ({ request: (...args) => {
      if (args[0] === 'session-info') { context.sessionRequests++; return Promise.resolve({ ok: true, payload: { success: true, user: { id: 1 } } }); }
      return context.fixtureRequest(...args);
    } }) };
    else vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), context);
  context.sessionRequests = 0;
  return context;
}
const message = { type: 'popup-progress-all', expectedUserId: 1, purpose: 'activity' };
test('coalesces concurrent callers and records admission before dispatch', async () => {
  const local = storage(), context = worker(local);
  let calls = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  context.fixtureRequest = async () => { calls++; assert.ok(local.data['resume-bulk'].attemptedAt); await wait; return { ok: true, status: 200, payload: { progress_all: {} } }; };
  const requests = [context.handlePopupRequest(message), context.handlePopupRequest({ ...message, purpose: 'resume' }), context.handlePopupRequest({ ...message, force: true })];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); release();
  for (const response of await Promise.all(requests)) assert.equal(response.ok, true);
  assert.equal(context.sessionRequests, 1);
  assert.equal(local.data['resume-bulk'].fetchedAt > 0, true);
});
test('storage failure prevents dispatch and restart respects persisted floor', async () => {
  const local = storage(), context = worker(local); let calls = 0;
  context.fixtureRequest = async () => { calls++; return { ok: true, status: 200, payload: { progress_all: {} } }; };
  const original = local.set; local.set = async () => { throw Error('storage'); };
  await assert.rejects(context.handlePopupRequest(message)); assert.equal(calls, 0);
  local.set = original; local.data['resume-bulk'] = { attemptedAt: Date.now(), retryAt: Date.now() + 60000 };
  const restarted = worker(local); restarted.fixtureRequest = context.fixtureRequest;
  const result = await restarted.handlePopupRequest({ ...message, force: true });
  assert.equal(result.status, 429); assert.equal(calls, 0);
});
test('malformed response preserves old cache and failed cooldown', async () => {
  const old = { userId: 1, byAnime: {}, fetchedAt: Date.now() - 86400001 };
  const local = storage({ 'resume-bulk': old }), context = worker(local);
  context.fixtureRequest = async () => ({ ok: true, status: 200, payload: { progress_all: [] } });
  const result = await context.handlePopupRequest(message);
  assert.equal(result.ok, true); assert.equal(result.payload.cached, true);
  assert.equal(local.data['resume-bulk'].fetchedAt, old.fetchedAt);
  assert.ok(local.data['resume-bulk'].retryAt > Date.now());
});
test('429 retry-after persists and rollback cannot bypass admission', async () => {
  const local = storage(), context = worker(local); let calls = 0;
  context.fixtureRequest = async () => { calls++; return { ok: false, status: 429, retryAfterMs: 180000, payload: null }; };
  assert.equal((await context.handlePopupRequest(message)).status, 429);
  assert.ok(local.data['resume-bulk'].retryAt >= Date.now() + 899000);
  assert.equal(local.data['resume-bulk'].fetchedAt, undefined);
  assert.equal(context.sessionRequests, 1);
  local.data['resume-bulk'].attemptedAt = Date.now() + 100000;
  local.data['resume-bulk'].retryAt = 0;
  const restarted = worker(local); restarted.fixtureRequest = context.fixtureRequest;
  assert.equal((await restarted.handlePopupRequest({ ...message, force: true })).status, 429);
  assert.equal(calls, 1);
});
test('own progress write wins against a late bulk response', async () => {
  const local = storage(), context = worker(local); let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const row = { episode: 1, position_sec: 20, duration_sec: null, voice: null, watched_at: new Date().toISOString() };
  context.fixtureRequest = async () => { entered(); await waiting; return { ok: true, status: 200, payload: { progress_all: { 2: row } } }; };
  const pending = context.handlePopupRequest(message); await started;
  await context.updateResumeCache(1, 1, row); release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.ok(local.data['resume-bulk'].byAnime['1']);
  assert.equal(local.data['resume-bulk'].byAnime['2'], undefined);
  assert.ok(local.data['resume-bulk'].attemptedAt);
});
test('revoked account while response is pending neither returns nor publishes it', async () => {
  const local = storage(), context = worker(local); let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  context.fixtureRequest = async () => { entered(); await waiting; return { ok: true, status: 200, payload: { progress_all: {} } }; };
  const pending = context.handlePopupRequest(message); await started;
  local.data['auto-mark'] = false; release();
  assert.equal((await pending).status, 409);
  assert.equal(local.data['resume-bulk'].fetchedAt, undefined);
});
test('fresh resume uses valid title-less cache; over-cap response cannot replace it', async () => {
  const row = { episode: null, position_sec: 20, duration_sec: null, voice: null, watched_at: new Date().toISOString() };
  const local = storage({ 'resume-bulk': { userId: 1, byAnime: { 1: row }, fetchedAt: Date.now() } });
  const context = worker(local); let calls = 0;
  context.fixtureRequest = async () => { calls++; return { ok: true, status: 200, payload: {
    progress_all: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i + 1), row])) } }; };
  assert.equal((await context.handlePopupRequest({ ...message, purpose: 'resume' })).payload.cached, true);
  assert.equal(calls, 0);
  assert.equal(context.sessionRequests, 1);
  assert.equal((await context.handlePopupRequest({ ...message, force: true })).payload.cached, true);
  assert.equal(calls, 1);
  assert.equal(Object.keys(local.data['resume-bulk'].byAnime).length, 1);
});
test('consent revoked during the first local read prevents session and bulk requests', async () => {
  const local = storage(), context = worker(local); let release, entered, calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const get = local.get;
  local.get = async keys => { if (Array.isArray(keys) && keys.includes('privacy-consent')) { entered(); await wait; } return get(keys); };
  context.fixtureRequest = async () => { calls++; };
  const pending = context.handlePopupRequest(message); await started;
  local.data['privacy-consent'] = { version: 1, declinedAt: Date.now() }; release();
  assert.equal((await pending).status, 409);
  assert.equal(context.sessionRequests, 0); assert.equal(calls, 0);
});
test('clear during admission invalidates the flight before dispatch', async () => {
  const local = storage(), context = worker(local); let release, entered, calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const set = local.set;
  local.set = async items => { if (items['resume-bulk']) { entered(); await wait; } return set(items); };
  context.fixtureRequest = async () => { calls++; };
  const pending = context.handlePopupRequest(message); await started;
  const clear = context.handlePopupRequest({ type: 'popup-delete-local-data' });
  release(); await clear;
  await assert.rejects(pending, /write_binding_changed/);
  assert.equal(calls, 0); assert.equal(local.data['resume-bulk'], undefined);
});
test('clear during network invalidates response without restoring deleted data', async () => {
  const local = storage(), context = worker(local); let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  context.fixtureRequest = async () => { entered(); await wait; return { ok: true, status: 200, payload: { progress_all: {} } }; };
  const pending = context.handlePopupRequest(message); await started;
  await context.handlePopupRequest({ type: 'popup-delete-local-data' }); release();
  await assert.rejects(pending, /write_binding_changed/);
  assert.equal(local.data['resume-bulk'], undefined);
});
test('reentrant call from the first storage read joins the reserved flight', async () => {
  const local = storage(), context = worker(local); let joined, calls = 0;
  const get = local.get;
  local.get = keys => {
    if (!joined) joined = context.handlePopupRequest({ ...message, force: true });
    return get(keys);
  };
  context.fixtureRequest = async () => { calls++; return { ok: true, status: 200, payload: { progress_all: {} } }; };
  const first = context.handlePopupRequest(message);
  assert.equal((await first).ok, true);
  assert.equal((await joined).ok, true);
  assert.equal(calls, 1); assert.equal(context.sessionRequests, 1);
});
for (const status of [401, 409]) test(`server ${status} never publishes the old account cache`, async () => {
  const row = { episode: 1, position_sec: 20, duration_sec: null, voice: null, watched_at: new Date().toISOString() };
  const prior = { userId: 1, byAnime: { 1: row }, fetchedAt: Date.now() };
  const local = storage({ 'resume-bulk': prior }), context = worker(local);
  context.fixtureRequest = async () => ({ ok: false, status, payload: null });
  const response = await context.handlePopupRequest({ ...message, force: true });
  assert.equal(response.ok, false); assert.equal(response.status, status);
  assert.equal(response.payload.progress_all, undefined);
  assert.deepEqual(local.data['resume-bulk'].byAnime, prior.byAnime);
  assert.equal(local.data['resume-bulk'].fetchedAt, prior.fetchedAt);
  assert.ok(local.data['resume-bulk'].retryAt > Date.now());
  const restarted = worker(local);
  restarted.fixtureRequest = async () => { throw Error('cooldown must not dispatch'); };
  const afterRestart = await restarted.handlePopupRequest(message);
  assert.equal(afterRestart.status, status);
  assert.equal(afterRestart.payload.progress_all, undefined);
});
test('own write preserves titles and evicts oldest row when adding entry 501', async () => {
  const row = { episode: 1, position_sec: 20, duration_sec: null, voice: null, watched_at: '2020-01-01T00:00:00Z' };
  const byAnime = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i + 1), { ...row }]));
  byAnime['2'] = { ...row, title: 'Title', title_ru: 'Название' };
  const local = storage({ 'resume-bulk': { userId: 1, byAnime, fetchedAt: 123, attemptedAt: 456, retryAt: 789 } });
  const context = worker(local);
  await context.updateResumeCache(1, 2, { ...row, position_sec: 30 });
  assert.equal(local.data['resume-bulk'].byAnime['2'].title, 'Title');
  assert.equal(local.data['resume-bulk'].byAnime['2'].title_ru, 'Название');
  await context.updateResumeCache(1, 501, { ...row, watched_at: new Date().toISOString() });
  assert.equal(Object.keys(local.data['resume-bulk'].byAnime).length, 500);
  assert.equal(local.data['resume-bulk'].byAnime['1'], undefined);
  assert.ok(local.data['resume-bulk'].byAnime['501']);
  assert.equal(local.data['resume-bulk'].attemptedAt, 456);
  assert.ok(context.AniRekoActivity.normalizeProgressMap(local.data['resume-bulk'].byAnime));
});
