const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

async function render({ match, records, playing = false, bulk = {}, syncAccountActive = false, currentUserId = 18, watchProjection = null, transition = null, duringLoad = null }) {
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
    currentUserId,
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

function cycleResumeProjection(status = 'paused') {
  const current = { cycle_id: '33333333-3333-4333-8333-333333333333', status,
    kind: 'rewatching', tracked_start_ordinal: 2, episode: 1, position_sec: 1371,
    duration_sec: 1500, voice: 'Dream Cast' };
  const origin = { history_id: '22222222-2222-4222-8222-222222222222', anime_id: 101,
    state: { anime_id: 101, version: 3, current } };
  return { pending: false, snapshot: { user_id: 18, requested_anime_id: 101, effective_anime_id: 101,
    history_adopted: true, readiness: 'ready', origins: [origin],
    foreground: { anime_id: 101, generation: 4, cycle_id: status === 'active' ? current.cycle_id : null },
    page: { has_more: false, next: null, origins_total: 1 }, cycles: [{
      history_id: origin.history_id, cycle: { ...current, anime_id: 101,
        started_at: '2026-10-04T12:00:00Z', updated_at: '2026-10-05T12:00:00Z', ended_at: null },
    }] } };
}

const renderCycleResume = (watchProjection, options = {}) => render({ match: { status: 'ok', animeId: 101 },
  records: { 'naruto::old': history(101, 600) }, bulk: { 101: { episode: 99, position_sec: 900, voice: 'Old cycle' } },
  syncAccountActive: true, watchProjection, ...options });

test('current active and sole paused cycle restore episode, position and voice without borrowing legacy', async () => {
  for (const status of ['active', 'paused']) {
    const resume = await renderCycleResume(cycleResumeProjection(status));
    assert.equal(resume.hidden, false);
    assert.ok(resume.textContent.startsWith('episodeLabel:1 · 22:51 · Dream Cast'));
    assert.ok(resume.textContent.includes('resumeCycleUpdated:'), 'date is explicitly cycle-update time');
    assert.equal(resume.textContent.includes('Old cycle'), false);
  }
});

test('cycle position survives an absent or mismatched historical timestamp row', async () => {
  for (const mode of ['absent', 'voice', 'status', 'identity', 'invalidDate']) {
    const projection = cycleResumeProjection();
    if (mode === 'absent') projection.snapshot.cycles = [];
    if (mode === 'voice') projection.snapshot.cycles[0].cycle.voice = 'Other voice';
    if (mode === 'status') projection.snapshot.cycles[0].cycle.status = 'active';
    if (mode === 'identity') projection.snapshot.cycles[0].history_id = '44444444-4444-4444-8444-444444444444';
    if (mode === 'invalidDate') projection.snapshot.cycles[0].cycle.updated_at = '2026-02-30T12:00:00Z';
    const resume = await renderCycleResume(projection);
    assert.equal(resume.hidden, false, mode);
    assert.equal(resume.textContent, 'episodeLabel:1 · 22:51 · Dream Cast', mode);
  }
});

test('off-page active foreground can use its selected origin without requiring a historical page', async () => {
  const projection = cycleResumeProjection('active');
  projection.snapshot.selected_origin = projection.snapshot.origins[0];
  projection.snapshot.origins = [];
  projection.snapshot.page.has_more = true;
  projection.snapshot.cycles = [];
  const resume = await renderCycleResume(projection);
  assert.equal(resume.hidden, false);
  assert.equal(resume.textContent, 'episodeLabel:1 · 22:51 · Dream Cast');
});

test('unknown, foreign, pending and reconciliation snapshots clear cycle resume', async () => {
  for (const mode of ['account', 'anime', 'related', 'pending', 'reconciliation', 'unknown', 'playing']) {
    const projection = cycleResumeProjection('active');
    if (mode === 'account') projection.snapshot.user_id = 953;
    if (mode === 'anime') projection.snapshot.requested_anime_id = 202;
    if (mode === 'related') {
      projection.snapshot.origins[0].anime_id = 202;
      projection.snapshot.origins[0].state.anime_id = 202;
    }
    if (mode === 'pending') projection.pending = true;
    if (mode === 'reconciliation') projection.snapshot.readiness = 'reconciliation_required';
    if (mode === 'unknown') delete projection.snapshot.history_adopted;
    const resume = await renderCycleResume(projection, { playing: mode === 'playing' });
    assert.equal(resume.hidden, true, mode);
    assert.equal(resume.textContent, '', mode);
  }
});

test('paused resume requires complete consistent origins and one unambiguous open cycle', async () => {
  for (const mode of ['more', 'missingPage', 'total', 'missingTotal', 'next', 'multiple', 'conflictingDuplicate']) {
    const projection = cycleResumeProjection();
    if (mode === 'more') projection.snapshot.page.has_more = true;
    if (mode === 'missingPage') delete projection.snapshot.page;
    if (mode === 'total') projection.snapshot.page.origins_total = 2;
    if (mode === 'missingTotal') delete projection.snapshot.page.origins_total;
    if (mode === 'next') projection.snapshot.page.next = { after_origin: {} };
    if (mode === 'multiple') {
      projection.snapshot.origins.push({ ...projection.snapshot.origins[0],
        history_id: '44444444-4444-4444-8444-444444444444',
        state: { ...projection.snapshot.origins[0].state, current: {
          ...projection.snapshot.origins[0].state.current, cycle_id: '55555555-5555-4555-8555-555555555555' } } });
      projection.snapshot.page.origins_total = 2;
    }
    if (mode === 'conflictingDuplicate') projection.snapshot.selected_origin = {
      ...projection.snapshot.origins[0], state: { ...projection.snapshot.origins[0].state,
        current: { ...projection.snapshot.origins[0].state.current, position_sec: 80 } } };
    const resume = await renderCycleResume(projection);
    assert.equal(resume.hidden, true, mode);
    assert.equal(resume.textContent, '', mode);
  }
  const duplicate = cycleResumeProjection();
  duplicate.snapshot.selected_origin = JSON.parse(JSON.stringify(duplicate.snapshot.origins[0]));
  assert.equal((await renderCycleResume(duplicate)).hidden, false, 'identical selected-origin duplication is not ambiguity');
});

test('cycle resume rejects malformed, terminal and zero-position current projections', async () => {
  for (const [field, value] of [['position_sec', '1371'], ['position_sec', true], ['position_sec', 0],
    ['position_sec', NaN], ['position_sec', -1], ['position_sec', 259201], ['episode', false],
    ['status', 'completed'], ['status', 'cancelled'], ['cycle_id', 'not-a-cycle'], ['voice', {}]]) {
    const projection = cycleResumeProjection();
    projection.snapshot.origins[0].state.current[field] = value;
    const resume = await renderCycleResume(projection);
    assert.equal(resume.hidden, true, field + ':' + value);
    assert.equal(resume.textContent, '');
  }
});

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
    watchProjection: null, pauseSessionStateReload: false, renderResume: async () => {},
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

test('failed explicit action remains visible after a fresh nonpending projection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  async function renderWatchCycle() {');
  const end = source.indexOf('\n  await renderWatchCycle();\n', start);
  const element = tag => ({ tagName: String(tag).toUpperCase(), children: [], events: {}, textContent: '',
    append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
    addEventListener(type, callback) { this.events[type] = callback; },
    querySelectorAll(selector) { return this.children.filter(child => child.tagName === selector.toUpperCase()); } });
  const elements = new Map(['watch-completion', 'watch-current', 'watch-actions', 'watch-feedback',
    'watch-cycle-card', 'resume-label', 'resume'].map(id => [id, element('div')]));
  const projection = { pending: false, snapshot: { history_adopted: true, readiness: 'ready', origins: [],
    foreground: { cycle_id: null } }, actions: [{ command: 'pause', capabilityId: 'stale-capability' }] };
  const context = vm.createContext({ matchConfirmed: true, syncAccountActive: true, tab: { id: 71 },
    watchProjection: null, pauseSessionStateReload: false, renderResume: async () => {},
    watchCard: elements.get('watch-cycle-card'), watchActions: elements.get('watch-actions'),
    watchFeedback: elements.get('watch-feedback'), set: (id, value) => { elements.get(id).textContent = value; },
    t: key => key, requestBackground: async type => type === 'popup-watch-history'
      ? { ok: true, payload: projection } : { ok: false },
    document: { createElement: element, getElementById: id => elements.get(id) } });
  vm.runInContext(`${source.slice(start, end)}\n globalThis.run = renderWatchCycle;`, context);
  await context.run();
  const button = elements.get('watch-actions').children[0].children[1];
  await button.events.click();
  assert.equal(elements.get('watch-feedback').textContent, 'watchActionFailed');
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

test('actual cycle renderer retains completion and shows only component tracked completions, not invented lifetime', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  async function renderWatchCycle() {');
  const end = source.indexOf('\n  await renderWatchCycle();\n', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const element = tag => ({ tagName: String(tag).toUpperCase(), hidden: true, textContent: '', children: [],
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
    watchProjection: null, pauseSessionStateReload: false, renderResume: async () => {},
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
  assert.equal(displayed.includes('watchTrackedCycle:2'), false);
  assert.equal(displayed.includes('watchEarlierCountUnknown'), false);
  assert.ok(displayed.includes('episodeLabel:3'));
  assert.equal(displayed.includes('SUMMER'), false, 'calendar season is not a season number');
  snapshot.start_state.completed_count_lower_bound = 1;
  snapshot.foreground.cycle_id = null;
  current.status = 'paused';
  await context.run();
  assert.equal(elements.get('watch-completion').textContent, 'watchPreviouslyCompleted');
  assert.ok(elements.get('watch-current').textContent.includes('watchPaused'));
  assert.ok(elements.get('watch-current').textContent.includes('episodeLabel:3'));
  snapshot.start_state.lifetime_completed_count = 5;
  await context.run();
  assert.equal(elements.get('watch-completion').textContent, 'watchPreviouslyCompleted', 'unknown tracking totals are not lifetime estimates');
  snapshot.totals = { completed: 1 };
  await context.run();
  assert.equal(elements.get('watch-completion').textContent, 'watchPreviouslyCompleted · watchTrackedCompletions:1');
  const retainedCurrent = { ...current, status: 'active', tracked_start_ordinal: 6 };
  snapshot.start_state.lifetime_completed_count = 1;
  snapshot.foreground.cycle_id = 'retained';
  retainedCurrent.cycle_id = 'retained';
  snapshot.origins.push({ history_id: 'same-history', anime_id: 202, state: { current: retainedCurrent,
    lifetime_completed_count: 5, completed_count_lower_bound: 5 } });
  await context.run();
  assert.equal(elements.get('watch-completion').textContent, 'watchPreviouslyCompleted · watchTrackedCompletions:1',
    'one component total, not a sum of overlapping lifetime counters');
  snapshot.origins[1].state.lifetime_completed_count = null;
  await context.run();
  assert.ok(elements.get('watch-completion').textContent.includes('watchTrackedCompletions:1'));
  assert.equal(elements.get('watch-completion').textContent.includes('watchCompletedCount:'), false, 'no invented lifetime sum');
  projection.actions = [{ command: 'pause', capabilityId: 'pause-action' }];
  await context.run();
  let manual = elements.get('watch-actions').children[0];
  assert.equal(manual.open, false, 'optional controls initially closed');
  manual.open = true;
  projection.actions = [{ command: 'resume', capabilityId: 'resume-action' }];
  await context.run();
  manual = elements.get('watch-actions').children[0];
  assert.equal(manual.open, true, 'user disclosure choice survives command/state refresh');
  assert.equal(manual.children[1].textContent, 'watchAction_resume');
  manual.open = false;
  await context.run();
  assert.equal(elements.get('watch-actions').children[0].open, false, 'user collapse is also preserved');
  projection.pending = true;
  projection.pendingIntent = { animeId: 303, action: 'start', commandId: 'original-id' };
  await context.run();
  assert.equal(elements.get('watch-feedback').textContent, 'watchCommandUnresolved');
  assert.equal(elements.get('watch-actions').children.length, 1);
  assert.equal(elements.get('watch-actions').children[0].open, false);
  assert.ok(elements.get('watch-actions').children[0].children[1].textContent.includes('watchOriginalTarget:303'));
  elements.get('watch-actions').children[0].open = true;
  await context.run();
  assert.equal(elements.get('watch-actions').children[0].open, true, 'pending details retain disclosure state');
  projection.pendingIntent = null;
  await context.run();
  assert.equal(elements.get('watch-actions').children.length, 0, 'foreign account intent offers no retry');
  assert.equal(elements.get('watch-feedback').textContent.includes('303'), false);
  projection.settlementCapabilityId = 'opaque-check';
  await context.run();
  assert.equal(elements.get('watch-actions').children.length, 1, 'generic check has one disclosure');
  assert.equal(elements.get('watch-actions').children[0].children[1].textContent, 'watchSettlementHint');
  assert.equal(elements.get('watch-actions').children[0].children[2].textContent, 'watchSettleOriginal');
  assert.equal(elements.get('watch-actions').children[0].children.length, 3, 'foreign intent details remain absent');
  assert.equal(elements.get('watch-feedback').textContent.includes('303'), false);
  projection.pendingIntent = { animeId: 303, action: 'start', commandId: 'original-id' };
  await context.run();
  assert.equal(elements.get('watch-actions').children[0].children.length, 5, 'retry and check remain distinct explicit actions');
  assert.equal(elements.get('watch-actions').children[0].open, true, 'pending disclosure survives foreign-account projection');
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
