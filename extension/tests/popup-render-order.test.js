const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const popupPath = process.env.ANIREKO_POPUP_SOURCE || path.join(__dirname, '..', 'popup.js');
const source = fs.readFileSync(popupPath, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function popup({ account, projection, syncReply, staleDocument = false, tasteUser = 18, tasteAnime = 1, cooldownAt = 0,
  recognitionTitle = 'Current anime', catalogTitle = 'Current anime', year = null, manual = false } = {}) {
  const elements = new Map();
  function element(id) {
    const node = { textContent: '', hidden: ['resume', 'resume-label', 'watch-cycle-card'].includes(id),
      disabled: id === 'auto-mark', checked: false, dataset: {}, style: {}, children: [], events: {},
      classList: { add() {}, remove() {} }, setAttribute() {},
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(type, listener) { this.events[type] = listener; },
      querySelector() { return element(); }, querySelectorAll() { return []; } };
    return node;
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const state = { navigationToken: staleDocument ? 'old' : 'current', pageUrl: 'https://example.test/anime',
    recognition: { title: recognitionTitle, episode: 3 },
    match: { status: 'ok', exact: true, manual, animeId: 1, title: catalogTitle, year, slug: 'current-anime' },
    taste: { status: 'ok', userKey: 'user:' + tasteUser, animeId: tasteAnime, percent: 87, labelKey: 'likely' },
    player: { player: 'html5', playbackStarted: true, playing: false, currentTime: 100,
      duration: 1000, episode: 3, progress: .1 } };
  const calls = [];
  let sessionListener;
  const stored = { 'privacy-consent': { version: 1, acceptedAt: 1 }, 'auto-mark': true,
    'sync-account': { id: 18 }, 'resume-sync-at': cooldownAt, 'watch-history': { records: {
      'current anime::3': { animeId: 1, episode: 3, position: 60, lastWatchedAt: 1 },
    }, days: {} } };
  const context = vm.createContext({
    URLSearchParams, navigator: { language: 'en' }, location: { search: '?tabId=1', reload() {} },
    window: { close() {} }, confirm: () => false, setTimeout: () => {},
    AniRekoActivity: { calendar: () => [] },
    document: { documentElement: {}, querySelectorAll: () => [], getElementById: get, createElement: element },
    chrome: {
      i18n: { getMessage: (key, value) => key + (value === undefined ? '' : ':' + value), getUILanguage: () => 'en' },
      tabs: { get: async () => ({ id: 1, url: state.pageUrl }),
        sendMessage: async () => ({ ok: true, documentUrl: state.pageUrl, documentToken: 'current' }) },
      storage: { local: { get: async () => stored },
        session: { get: async () => ({ 'tab:1': state }) },
        onChanged: { addListener(listener) { sessionListener = listener; } } },
      runtime: { sendMessage: async message => {
        calls.push(message);
        if (message.type === 'popup-runtime-info') return { ok: true,
          payload: { siteBase: 'https://anireko.com', localWriteRevision: 'initial' } };
        if (message.type === 'popup-session-info') return typeof account === 'function' ? account() : account;
        if (message.type === 'popup-watch-history') return typeof projection === 'function' ? projection() : projection;
        if (message.type === 'popup-sync-current') return typeof syncReply === 'function' ? syncReply() : syncReply;
        if (message.type === 'popup-progress-all') return { ok: true, payload: { progress_all: {} } };
        throw new Error('unexpected request ' + message.type);
      } },
    },
  });
  const done = vm.runInContext(source, context);
  return { get, calls, done, publishProgress(progress) {
    sessionListener({ 'tab:1': { newValue: { ...state, player: { ...state.player, progress } } } }, 'session');
  } };
}

test('actual popup avoids exact duplicate catalog title but preserves year, manual marker and distinct title', async () => {
  for (const [options, expected] of [
    [{}, ''],
    [{ year: 2024, manual: true }, '2024 · manualMatchMark'],
    [{ catalogTitle: 'Current anime 2', year: 2024 }, 'catalogPrefix Current anime 2 (2024)'],
    [{ catalogTitle: 'current anime' }, 'catalogPrefix current anime'],
  ]) {
    const ui = popup({ account: authorized(18), projection: history(true), ...options });
    await ui.done; await tick();
    assert.equal(ui.get('anireko-match').textContent, expected);
  }
});
const authorized = id => ({ ok: true, payload: {
  success: true, user: { id, name: 'TestUser' }, localWriteRevision: 'fresh' } });
const history = adopted => ({ ok: true, payload: {
  snapshot: { history_adopted: adopted, requested_anime_id: 1, readiness: 'ready',
    origins: [], foreground: { cycle_id: null } }, actions: [] } });
function localVisible(ui) {
  assert.equal(ui.get('anime-check-detail').textContent, 'Current anime');
  assert.equal(ui.get('progress').textContent, '10.0%');
  assert.equal(ui.get('episode').textContent, 'episodeLabel:3');
  assert.equal(ui.get('player').textContent, 'html5');
  assert.equal(ui.get('status').textContent, 'statusPaused');
  assert.equal(ui.get('stats-card').hidden, false);
  assert.equal(ui.get('today-time').textContent, 'activityUnknown');
}

test('actual popup renders local details before pending fresh account and keeps account actions disabled', async () => {
  const gate = deferred();
  const ui = popup({ account: gate.promise, projection: history(true) });
  try {
    await tick();
    assert.ok(ui.calls.some(call => call.type === 'popup-session-info'));
    localVisible(ui);
    assert.equal(ui.get('auto-mark').disabled, true);
    assert.equal(ui.get('resume-sync').disabled, true);
    assert.equal(ui.get('resume').hidden, true);
    assert.equal(ui.get('taste-match').children.length, 0);
    assert.ok(ui.calls.every(call => !/command|retry|sync-current|update-preferences/.test(call.type)));
  } finally { gate.resolve(authorized(18)); await ui.done; await tick(); }
});

test('actual popup renders progress before pending adopted-history response and never borrows legacy resume', async () => {
  const gate = deferred();
  const ui = popup({ account: authorized(18), projection: gate.promise });
  try {
    await tick();
    assert.ok(ui.calls.some(call => call.type === 'popup-watch-history'));
    localVisible(ui);
    assert.equal(ui.get('resume').hidden, true);
    assert.ok(!ui.calls.some(call => call.type === 'popup-progress-all'));
  } finally { gate.resolve(history(true)); await ui.done; await tick(); }
  assert.equal(ui.get('resume').hidden, true);
  assert.equal(ui.get('resume').textContent, '');
});

test('fresh changed account, guest and offline keep local details and reject old personalized taste', async () => {
  for (const account of [authorized(953), { ok: false, status: 401, payload: { localWriteRevision: 'guest' } },
    () => Promise.reject(new Error('offline'))]) {
    const ui = popup({ account, projection: history(true) });
    await ui.done; await tick();
    localVisible(ui);
    assert.equal(ui.get('taste-match').children.length, 0);
    assert.ok(!ui.calls.some(call => call.type === 'popup-watch-history'));
    assert.equal(ui.get('resume-sync').disabled, true);
  }
});

test('local-first rendering still rejects the stale native detector document before account reads', async () => {
  const ui = popup({ account: authorized(18), projection: history(true), staleDocument: true });
  await ui.done;
  assert.notEqual(ui.get('anime-check-detail').textContent, 'Current anime');
  assert.equal(ui.get('progress').textContent, '');
  assert.ok(!ui.calls.some(call => call.type === 'popup-session-info'));
});

test('fresh matching account enables sync without cooldown and publishes only its matching taste tuple', async () => {
  const ui = popup({ account: authorized(18), projection: history(true) });
  await ui.done; await tick();
  assert.equal(ui.get('resume-sync').disabled, false);
  assert.equal(ui.get('auto-mark').checked, true);
  assert.equal(ui.get('taste-match').children[0].textContent, '87%');
  assert.equal(ui.calls.find(call => call.type === 'popup-watch-history').expectedRevision, 'fresh');
  const differentAnime = popup({ account: authorized(18), projection: history(true), tasteAnime: 2 });
  await differentAnime.done; await tick();
  assert.equal(differentAnime.get('taste-match').children.length, 0);
  const cooldown = popup({ account: authorized(18), projection: history(true), cooldownAt: Date.now() });
  await cooldown.done; await tick();
  assert.equal(cooldown.get('resume-sync').disabled, true);
});

test('progress arriving while account is pending is not overwritten by the older opening snapshot', async () => {
  const gate = deferred();
  const ui = popup({ account: gate.promise, projection: history(true) });
  await tick();
  ui.publishProgress(.25);
  gate.resolve(authorized(18));
  await ui.done; await tick();
  assert.equal(ui.get('progress').textContent, '25.0%');
});

test('unknown or malformed adopted history keeps legacy resume hidden on opening', async () => {
  for (const adopted of [undefined, 'false']) {
    const ui = popup({ account: authorized(18), projection: history(adopted) });
    await ui.done; await tick();
    assert.equal(ui.get('resume').hidden, true);
    assert.equal(ui.get('resume').textContent, '');
    assert.ok(!ui.calls.some(call => call.type === 'popup-progress-all'));
  }
});

function currentCycleHistory() {
  const current = { cycle_id: '33333333-3333-4333-8333-333333333333', status: 'active',
    kind: 'watching', tracked_start_ordinal: 1, episode: 1, position_sec: 1371,
    duration_sec: 1500, voice: 'Dream Cast' };
  return { ok: true, payload: { pending: false, actions: [], snapshot: {
    user_id: 18, requested_anime_id: 1, effective_anime_id: 1, history_adopted: true,
    readiness: 'ready', origins: [{ history_id: '22222222-2222-4222-8222-222222222222',
      anime_id: 1, state: { anime_id: 1, version: 3, current } }],
    foreground: { anime_id: 1, generation: 4, cycle_id: current.cycle_id },
    page: { has_more: false, next: null, origins_total: 1 }, cycles: [],
  } } };
}

test('full popup restores current resume after every no-write Sync terminal path by a fresh read', async () => {
  for (const syncReply of [
    { ok: true, payload: { progressSynced: false, statusSynced: false, writeFailed: false } },
    { ok: true, payload: { confirmationRequired: true, animeTitle: 'Current anime' } },
    { ok: true, payload: { writeFailed: true } },
    { ok: false, payload: { error: 'offline' } },
    () => Promise.reject(new Error('transport failed')),
  ]) {
    const ui = popup({ account: authorized(18), projection: currentCycleHistory(), syncReply });
    await ui.done; await tick();
    assert.equal(ui.get('resume').hidden, false);
    await ui.get('resume-sync').events.click();
    assert.equal(ui.get('resume').hidden, false, 'unchanged current cycle remains available');
    assert.equal(ui.get('resume').textContent, 'episodeLabel:1 · 22:51 · Dream Cast');
    assert.equal(ui.calls.filter(call => call.type === 'popup-watch-history').length, 2);
    assert.equal(ui.calls.filter(call => call.type === 'popup-sync-current').length, 1);
    assert.ok(!ui.calls.some(call => /command|retry|update-preferences/.test(call.type)));
  }
});

test('no-write Sync does not restore a stale cycle when its fresh read becomes pending or foreign', async () => {
  for (const mode of ['pending', 'foreign', 'offline']) {
    let reads = 0;
    const ui = popup({ account: authorized(18), syncReply: { ok: true, payload: {} },
      projection: () => {
        if (++reads === 1) return currentCycleHistory();
        if (mode === 'offline') return Promise.reject(new Error('offline'));
        const fresh = currentCycleHistory();
        if (mode === 'pending') fresh.payload.pending = true;
        if (mode === 'foreign') fresh.payload.snapshot.user_id = 953;
        return fresh;
      } });
    await ui.done; await tick();
    assert.equal(ui.get('resume').hidden, false);
    await ui.get('resume-sync').events.click();
    assert.equal(reads, 2, mode);
    assert.equal(ui.get('resume').hidden, true, mode);
    assert.equal(ui.get('resume').textContent, '', mode);
  }
});
