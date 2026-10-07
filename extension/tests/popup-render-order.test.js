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
function popup({ account, projection, staleDocument = false, tasteUser = 18, tasteAnime = 1, cooldownAt = 0 } = {}) {
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
    recognition: { title: 'Current anime', episode: 3 },
    match: { status: 'ok', exact: true, animeId: 1, title: 'Current anime' },
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
        if (message.type === 'popup-watch-history') return projection;
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
