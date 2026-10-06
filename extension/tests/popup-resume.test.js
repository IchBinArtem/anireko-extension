const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

async function render({ match, records, playing = false, bulk = {}, syncAccountActive = false, watchProjection = null, transition = null, duringLoad = null }) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const start = source.indexOf('  async function renderResume(force) {');
  const end = source.indexOf('  renderResume(false);', start);
  assert.ok(start >= 0 && end > start, 'execute the actual production renderer');
  const elements = {
    'resume-label': { hidden: true },
    resume: { hidden: true, textContent: '' },
  };
  const context = vm.createContext({
    animeFound: true,
    player: { playing },
    match,
    syncAccountActive,
    watchProjection,
    recognition: { title: 'Naruto' },
    stored: { 'watch-history': { records } },
    dateLocale: 'en-US',
    t: (key, value) => value === undefined ? key : `${key}:${value}`,
    loadResumeBulk: async () => {
      if (duringLoad) context.watchProjection = duringLoad;
      return { byAnime: bulk };
    },
    document: { getElementById: (id) => elements[id] },
  });
  vm.runInContext(`${source.slice(start, end)}\n globalThis.run = renderResume;`, context);
  await context.run(false);
  if (transition) {
    context.watchProjection = transition;
    await context.run(false);
    assert.equal(elements['resume-label'].hidden, true);
  }
  return elements.resume;
}

const history = (animeId, position = 600) => ({ animeId, position, episode: 3, lastWatchedAt: 1 });

test('actual repair renderer requires a human choice in every group and preserves text-only labels', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  async function renderWatchCycle() {');
  const end = source.indexOf('\n  await renderWatchCycle();\n', start);
  assert.ok(start >= 0 && end > start);
  const nodes = [];
  const element = tag => {
    const node = { tag, hidden: true, textContent: '', children: [], events: {},
      replaceChildren(...children) { this.children = children; },
      append(child) { this.children.push(child); },
      addEventListener(type, callback) { this.events[type] = callback; },
      querySelectorAll(selector) { return nodes.filter(item => item.tag === selector); } };
    nodes.push(node); return node;
  };
  const elements = new Map(['watch-completion', 'watch-current', 'watch-actions', 'watch-feedback',
    'watch-cycle-card', 'resume-label', 'resume'].map(id => [id, element('div')]));
  const groups = [101, 202].map((id, index) => ({ effectiveAnimeId: id,
    catalog: { title: index ? 'Related title' : '<img src=x onerror=alert(1)>' },
    options: [1, 2].map(n => ({ cycleId: `cycle-${id}-${n}`, historyId: `history-${n}`,
      animeId: id + n, ordinal: n, episode: n + 3, kind: 'rewatching' })) }));
  const projection = { snapshot: { requested_anime_id: 101, previously_completed: true,
    readiness: 'reconciliation_required', origins: [], foreground: { cycle_id: null } },
    repairComplete: true, actions: [{ command: 'reconcile', capabilityId: 'opaque-choice', groups }] };
  const mutations = [];
  const context = vm.createContext({ matchConfirmed: true, syncAccountActive: true, tab: { id: 71 },
    watchProjection: null, pauseSessionStateReload: false,
    watchCard: elements.get('watch-cycle-card'), watchActions: elements.get('watch-actions'),
    watchFeedback: elements.get('watch-feedback'),
    set: (id, value) => { elements.get(id).textContent = value; },
    t: (key, value) => value === undefined ? key : `${key}:${value}`,
    requestBackground: async (type, input) => {
      if (type === 'popup-watch-history') return { ok: true, payload: projection };
      mutations.push({ type, input }); return { ok: true };
    }, document: { createElement: element, getElementById: id => elements.get(id) } });
  vm.runInContext(`${source.slice(start, end)}\n globalThis.run = renderWatchCycle;`, context);
  await context.run();
  const radios = nodes.filter(node => node.tag === 'input');
  const apply = nodes.find(node => node.tag === 'button');
  assert.equal(radios.length, 4);
  assert.ok(radios.every(node => node.checked === false), 'no default winner');
  assert.equal(apply.disabled, true);
  apply.events.click();
  assert.equal(mutations.length, 0, 'even a synthetic disabled click cannot submit');
  assert.equal(nodes.find(node => node.tag === 'legend').textContent, '<img src=x onerror=alert(1)>');
  radios[1].checked = true; radios[1].events.change();
  assert.equal(apply.disabled, true, 'related group also requires selection');
  radios[2].checked = true; radios[2].events.change();
  assert.equal(apply.disabled, false);
  apply.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].type, 'popup-watch-command');
  assert.deepEqual(JSON.parse(JSON.stringify(mutations[0].input)),
    { capabilityId: 'opaque-choice', choiceCycleIds: ['cycle-101-2', 'cycle-202-1'] });
  assert.ok(elements.get('watch-completion').textContent.includes('watchPreviouslyCompleted'));
  projection.actions = []; projection.repairComplete = false;
  await context.run();
  assert.equal(elements.get('watch-actions').children.length, 0);
  assert.equal(elements.get('watch-feedback').textContent, 'watchChoicesIncomplete');
});

test('same popup clears previously visible legacy resume after adoption or unknown history', async () => {
  for (const transition of [{ snapshot: { history_adopted: true } }, { snapshot: {} }]) {
    const result = await render({ match: { status: 'ok', animeId: 1 }, records: { 'naruto::3': history(1) },
      syncAccountActive: true, watchProjection: { snapshot: { history_adopted: false } }, transition });
    assert.equal(result.hidden, true);
    assert.equal(result.textContent, '');
  }
});

test('late legacy bulk response cannot restore resume after adoption', async () => {
  const result = await render({ match: { status: 'ok', animeId: 1 }, records: { 'naruto::3': history(1) },
    syncAccountActive: true, bulk: { 1: { episode: 12, position_sec: 1000 } },
    watchProjection: { snapshot: { history_adopted: false } }, duringLoad: { snapshot: { history_adopted: true } } });
  assert.equal(result.hidden, true);
  assert.equal(result.textContent, '');
});

test('actual cycle renderer retains completion and labels unknown lifetime as tracked, not second watch', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  async function renderWatchCycle() {');
  const end = source.indexOf('\n  await renderWatchCycle();\n', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const element = () => ({ hidden: true, textContent: '', children: [],
    replaceChildren(...children) { this.children = children; },
    append(child) { this.children.push(child); }, addEventListener() {}, querySelectorAll() { return this.children; } });
  for (const id of ['watch-completion', 'watch-current', 'watch-actions', 'watch-feedback', 'watch-cycle-card', 'resume-label', 'resume']) elements.set(id, element());
  const current = { cycle_id: 'cycle', status: 'active', kind: 'rewatching', tracked_start_ordinal: 2, episode: 3 };
  const snapshot = { requested_anime_id: 101, previously_completed: true, readiness: 'ready',
    start_state: { history_before_tracking_unknown: true }, foreground: { cycle_id: 'cycle' },
    origins: [{ history_id: 'same-history', anime_id: 101, state: { current } }], catalog: { season: 'SUMMER', season_year: 2026 } };
  snapshot.start_state.current = current;
  snapshot.origins[0].state = snapshot.start_state;
  const projection = { snapshot, actions: [] };
  const context = vm.createContext({ matchConfirmed: true, syncAccountActive: true, tab: { id: 71 },
    watchProjection: null, pauseSessionStateReload: false,
    watchCard: elements.get('watch-cycle-card'), watchActions: elements.get('watch-actions'),
    watchFeedback: elements.get('watch-feedback'),
    set: (id, value) => { elements.get(id).textContent = value; },
    t: (key, value) => value === undefined ? key : `${key}:${value}`,
    requestBackground: async (type) => {
      assert.equal(type, 'popup-watch-history', 'opening popup only reads');
      return { ok: true, payload: projection };
    }, document: { createElement: element, getElementById: (id) => elements.get(id) },
  });
  vm.runInContext(`${source.slice(start, end)}\n globalThis.run = renderWatchCycle;`, context);
  await context.run();
  assert.equal(elements.get('watch-completion').textContent, 'watchPreviouslyCompleted');
  const displayed = elements.get('watch-current').textContent;
  assert.ok(displayed.includes('watchRewatching'));
  assert.ok(displayed.includes('watchTrackedCycle:2'));
  assert.ok(displayed.includes('watchEarlierCountUnknown'));
  assert.ok(displayed.includes('episodeLabel:3'));
  assert.equal(displayed.includes('SUMMER'), false, 'calendar season is not a season number');
  snapshot.start_state.completed_count_lower_bound = 1;
  snapshot.foreground.cycle_id = null;
  current.status = 'paused';
  await context.run();
  assert.ok(elements.get('watch-completion').textContent.includes('watchCompletedLowerBound:1'));
  assert.ok(elements.get('watch-current').textContent.includes('watchPaused'));
  assert.ok(elements.get('watch-current').textContent.includes('episodeLabel:3'));
  snapshot.start_state.lifetime_completed_count = 5;
  await context.run();
  assert.ok(elements.get('watch-completion').textContent.includes('watchCompletedCount:5'));
  assert.equal(elements.get('watch-completion').textContent.includes('watchCompletedLowerBound'), false);
  const retainedCurrent = { ...current, status: 'active', tracked_start_ordinal: 6 };
  snapshot.start_state.lifetime_completed_count = 1;
  snapshot.foreground.cycle_id = 'retained';
  retainedCurrent.cycle_id = 'retained';
  snapshot.origins.push({ history_id: 'same-history', anime_id: 202, state: { current: retainedCurrent,
    lifetime_completed_count: 5, completed_count_lower_bound: 5 } });
  await context.run();
  assert.ok(elements.get('watch-completion').textContent.includes('watchCompletedCount:5'),
    'foreground history counter, not unrelated primary history count');
  assert.ok(elements.get('watch-completion').textContent.includes('watchCurrentHistoryCount'), 'scope explicitly labelled');
  snapshot.origins[1].state.lifetime_completed_count = null;
  await context.run();
  assert.ok(elements.get('watch-completion').textContent.includes('watchCompletedLowerBound:5'));
  assert.equal(elements.get('watch-completion').textContent.includes('watchCompletedCount:'), false, 'no invented lifetime sum');
  projection.pending = true;
  projection.pendingIntent = { animeId: 303, action: 'start', commandId: 'original-id' };
  await context.run();
  assert.ok(elements.get('watch-feedback').textContent.includes('watchOriginalTarget:303'));
  assert.ok(elements.get('watch-feedback').textContent.includes('watchAction_start'));
  assert.equal(elements.get('watch-actions').children.length, 1);
  projection.pendingIntent = null;
  await context.run();
  assert.equal(elements.get('watch-actions').children.length, 0, 'foreign account intent offers no retry');
  assert.equal(elements.get('watch-feedback').textContent.includes('303'), false);
  projection.settlementCapabilityId = 'opaque-check';
  await context.run();
  assert.equal(elements.get('watch-actions').children.length, 1, 'generic check does not disclose a foreign intent');
  assert.equal(elements.get('watch-actions').children[0].textContent, 'watchSettleOriginal');
  assert.equal(elements.get('watch-actions').children[0].title, 'watchSettlementHint');
  assert.equal(elements.get('watch-feedback').textContent.includes('303'), false);
  projection.pendingIntent = { animeId: 303, action: 'start', commandId: 'original-id' };
  await context.run();
  assert.equal(elements.get('watch-actions').children.length, 2, 'retry and outcome check are distinct explicit actions');
});

test('adopted or unknown account history never substitutes legacy resume into a cycle', async () => {
  for (const watchProjection of [null, { snapshot: { history_adopted: true } },
    { snapshot: {} }, { snapshot: { history_adopted: 'false' } }]) {
    const result = await render({ match: { status: 'ok', animeId: 1 },
      records: { 'naruto::3': history(1) }, bulk: { 1: { position_sec: 600 } },
      syncAccountActive: true, watchProjection });
    assert.equal(result.hidden, true);
  }
  const result = await render({ match: { status: 'ok', animeId: 1 },
    records: { 'naruto::3': history(1) }, syncAccountActive: true,
    watchProjection: { snapshot: { history_adopted: false } } });
  assert.equal(result.hidden, false);
});

test('confirmed catalog ID rejects same-title progress from another anime', async () => {
  const result = await render({ match: { status: 'ok', animeId: 1 }, records: { 'naruto::3': history(999) } });
  assert.equal(result.hidden, true);
});

test('confirmed catalog ID rejects unbound legacy same-title progress', async () => {
  const result = await render({ match: { status: 'ok', animeId: 1 }, records: { 'naruto::3': history(undefined) } });
  assert.equal(result.hidden, true);
});

test('confirmed catalog identity retains progress despite a changed display title', async () => {
  const result = await render({ match: { status: 'ok', animeId: 1 }, records: { 'different alias::3': history(1) } });
  assert.equal(result.hidden, false);
  assert.ok(result.textContent.includes('10:00'));
});

test('same-ID local progress wins over newer same-title foreign history', async () => {
  const result = await render({ match: { status: 'ok', animeId: 1 }, records: {
    'naruto::3': history(1, 300),
    'naruto::4': { ...history(999), lastWatchedAt: 2 },
  } });
  assert.ok(result.textContent.includes('5:00'));
});

test('unconfirmed guest retains title-bound browser-only legacy progress', async () => {
  const result = await render({ match: { status: 'none' }, records: { 'naruto::3': history(undefined) } });
  assert.equal(result.hidden, false);
  assert.ok(result.textContent.includes('10:00'));
});

test('malformed confirmed identity fails closed rather than returning to title matching', async () => {
  for (const animeId of [null, 0, -1, 'invalid', 1.5, true]) {
    const result = await render({ match: { status: 'ok', animeId }, records: { 'naruto::3': history(undefined) } });
    assert.equal(result.hidden, true);
  }
});

test('boolean local identity is not coerced into a real catalog ID', async () => {
  const result = await render({ match: { status: 'ok', animeId: 1 }, records: { 'naruto::3': history(true) } });
  assert.equal(result.hidden, true);
});

test('server same-ID progress keeps priority over local and active playback hides resume', async () => {
  const match = { status: 'ok', animeId: 1 };
  const records = { 'naruto::3': history(1) };
  const result = await render({ match, records, bulk: { 1: { episode: 4, position_sec: 120, watched_at: '2026-01-01T00:00:00Z' } } });
  assert.ok(result.textContent.includes('2:00'));
  assert.equal((await render({ match, records, playing: true })).hidden, true);
});
