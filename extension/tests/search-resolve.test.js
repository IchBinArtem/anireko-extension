const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const extensionDir = path.join(__dirname, '..');
const serviceWorkerPath = process.env.ANIREKO_SW_UNDER_TEST || path.join(extensionDir, 'service-worker.js');

test('actual legacy progress fails closed without an authenticated adoption snapshot', async () => {
  const posts = [];
  const { context } = loadServiceWorker({ historyFetchImpl: async () => (
    { ok: true, status: 200, json: async () => ({}) }
  ), fetchImpl: async (_url, options) => {
    if (options.method === 'POST') posts.push(options.body);
    return { ok: true, status: 200, json: async () => ({}) };
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = { sourceOrigin: 'https://source.example', match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } };
  await context.maybeSyncProgress(state, true);
  assert.deepEqual(posts, [], 'unsupported history contract must not fall back to a legacy writer');
});

function adoptionSnapshot(adopted = false) {
  return { user_id: 18, requested_anime_id: 101, effective_anime_id: 101,
    history_adopted: adopted, readiness: 'ready',
    foreground: { anime_id: 101, generation: 0, cycle_id: null } };
}

function adoptionState() {
  return { sourceOrigin: 'https://source.example', pageUrl: 'https://source.example/watch',
    topDocumentId: 'native-document-a', navigationToken: 'navigation-a',
    recognition: { title: 'Known anime' },
    match: { status: 'ok', exact: true, animeId: 101, type: 'TV', totalEpisodes: 12,
      releaseStatus: 'FINISHED', completionMetadataReady: true },
    player: { watched: true, playbackStarted: true, episode: 2, currentTime: 1000, duration: 1200 } };
}

const controllerHistoryId = '22222222-2222-4222-8222-222222222222';
const controllerCycleId = '33333333-3333-4333-8333-333333333333';
function controllerSnapshot(started = false) {
  const current = started ? { cycle_id: controllerCycleId, status: 'active', kind: 'rewatching',
    tracked_start_ordinal: 2, episode: 3, position_sec: 600, duration_sec: 1200, voice: null } : null;
  const state = { anime_id: 101, version: started ? 1 : 0, current,
    previously_completed: true, history_before_tracking_unknown: false,
    lifetime_completed_count: 1, completed_count_lower_bound: 1, tracked_completed_count: 1 };
  return { ...adoptionSnapshot(started), primary_history_id: controllerHistoryId,
    start_anime_id: 101, start_state: state, origins: started
      ? [{ history_id: controllerHistoryId, anime_id: 101, state }] : [],
    reconciliation_token: 'a'.repeat(64), previously_completed: true,
    foreground: { anime_id: 101, generation: started ? 1 : 0, cycle_id: started ? controllerCycleId : null },
    catalog: { anime_id: 101, title: 'Known anime', season: 'SUMMER', season_year: 2026 },
    totals: { started: started ? 2 : 1, completed: 1, cancelled: 0 } };
}

function prepareController(context, chrome) {
  const state = { ...adoptionState(), tabId: 71 };
  context.testHistoryState = state;
  vm.runInContext('stateByTab[71] = testHistoryState;', context);
  context.activeSyncAccount = async () => ({ userId: 18 });
  chrome.tabs.sendMessage = async (_tabId, message, options) => {
    if (message.type !== 'anireko-detector-status') return;
    assert.equal(options.documentId, 'native-document-a');
    return { ok: true, documentUrl: state.pageUrl, documentToken: state.navigationToken };
  };
  const send = (message) => new Promise((resolve) => {
    chrome.runtime.onMessage.listener(message,
      { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/popup.html` }, resolve);
  });
  return { state, send };
}

function naturalPlayer(position = 10, observedAt = 10000, extras = {}) {
  return { episode: 1, currentTime: position, duration: 1200, observedAt, watched: false,
    playing: true, paused: false, ended: false, seeking: false, playbackStarted: true,
    reason: 'timeupdate', documentId: 'frame-document-a', frameUrl: 'https://player.example/watch',
    playerInstanceId: 'native-video-a', ...extras };
}

function observedPlayer(context, state, ...args) {
  const previous = naturalPlayer(...args);
  const current = state.player;
  state.player = previous;
  context.recordWatchObservation(context.captureProgressEvent(state), context.captureLocalWrite());
  state.player = current;
  return previous;
}

function completeControllerSnapshot(started = false) {
  const snapshot = controllerSnapshot(started);
  snapshot.page = { has_more: false, next: null, origins_total: snapshot.origins.length };
  snapshot.totals.open = started ? 1 : 0;
  return snapshot;
}

test('natural start proof rejects seek-open, pauses, synthetic media, replacements and an initial position', () => {
  const { context, chrome } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  const { state } = prepareController(context, chrome);
  state.player = naturalPlayer(15, 15000);
  const captured = () => context.captureProgressEvent(state);
  assert.ok(context.naturalWatchInterval(captured(), observedPlayer(context, state)));
  assert.equal(context.naturalWatchInterval(captured(), naturalPlayer()), null, 'unobserved samples cannot authorize Start');
  assert.equal(context.naturalWatchInterval(captured(), null), null);
  for (const change of [{ seeking: true }, { seeking: undefined }, { paused: true }, { playing: false },
    { ended: true }, { watched: true }, { reason: 'seeked' }, { episode: 2 },
    { playerInstanceId: 'replacement' }, { documentId: 'replacement' }, { currentTime: 200 }]) {
    state.player = naturalPlayer(15, 15000, change);
    assert.equal(context.naturalWatchInterval(captured(), observedPlayer(context, state)), null, JSON.stringify(change));
  }
  state.player = naturalPlayer(15, 15000);
  const saved = context.captureProgressEvent({ ...state, player: { ...state.player } }, state);
  assert.equal(context.naturalWatchInterval(saved, observedPlayer(context, state)), null);
  const stale = observedPlayer(context, state);
  context.invalidateWatchController();
  assert.equal(context.naturalWatchInterval(captured(), stale), null, 'mapping invalidation requires new samples');
  const oldAccount = observedPlayer(context, state);
  vm.runInContext('localWriteRevision = crypto.randomUUID()', context);
  assert.equal(context.naturalWatchInterval(captured(), oldAccount), null, 'another account cannot inherit playback proof');
});

test('actual automatic Start needs no popup, preserves previous completion and only future media is progress', async () => {
  const posts = []; let started = false;
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      const request = JSON.parse(options.body); posts.push(request); started = true;
      const snapshot = completeControllerSnapshot(true);
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: snapshot.foreground, state: snapshot.start_state }) };
    }
    return { ok: true, status: 200, json: async () => completeControllerSnapshot(started) };
  }, fetchImpl: async () => { throw Error('legacy_or_other_endpoint'); } });
  const { state } = prepareController(subject.context, subject.chrome);
  state.player = naturalPlayer(15, 15000);
  await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state));
  assert.deepEqual(posts.map(request => request.command), ['start']);
  assert.equal(posts[0].expected_foreground_generation, 0);
  assert.equal(posts[0].expected_version, 0);
  assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], undefined);
  state.player = naturalPlayer(20, 20000);
  await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state, 15, 15000));
  assert.deepEqual(posts.map(request => request.command), ['start', 'progress']);
  assert.equal(posts[1].position_sec, 20);
  assert.equal(completeControllerSnapshot(true).start_state.previously_completed, true);
  assert.equal(completeControllerSnapshot(true).totals.completed, 1, 'a start is not another completion');
});

test('automatic Start fails closed on partial origins, competing paused, reconciliation and unknown pagination', async () => {
  for (const defect of ['partial', 'missing-page', 'paused', 'reconciliation']) {
    const snapshot = completeControllerSnapshot();
    if (defect === 'partial') snapshot.page.has_more = true;
    if (defect === 'missing-page') delete snapshot.page;
    if (defect === 'reconciliation') snapshot.readiness = 'reconciliation_required';
    if (defect === 'paused') {
      const origin = completeControllerSnapshot(true).origins[0]; origin.state.current.status = 'paused';
      snapshot.origins = [origin]; snapshot.page.origins_total = 1; snapshot.totals.open = 1;
    }
    const posts = [];
    const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') posts.push(options.body);
      return { ok: true, status: 200, json: async () => snapshot };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
    const { state } = prepareController(subject.context, subject.chrome);
    state.player = naturalPlayer(15, 15000);
    await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state));
    assert.deepEqual(posts, [], defect);
  }
});

test('terminal barrier survives worker restart and prevents Complete80 backseek from starting the same episode', async () => {
  const posts = []; const snapshot = completeControllerSnapshot();
  const transport = { historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') posts.push(options.body);
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } };
  const first = loadServiceWorker(transport);
  const initial = prepareController(first.context, first.chrome);
  initial.state.player = naturalPlayer(960, 15000, { episode: 12, watched: true });
  await first.context.maybeSyncProgress(initial.state, true);
  const stored = (await first.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'];
  assert.equal(stored.byScope['18:101'].episode, 12);
  const second = loadServiceWorker({ ...transport, localStorage: first.storage.local });
  const restarted = prepareController(second.context, second.chrome);
  restarted.state.player = naturalPlayer(15, 25000, { episode: 12 });
  await second.context.maybeSyncProgress(restarted.state, true, undefined, restarted.state,
    observedPlayer(second.context, restarted.state, 10, 20000, { episode: 12 }));
  assert.deepEqual(posts, [], 'new document and below80 are not a new repeat proof');
});

test('episode1 at80 is not an anime-terminal barrier and natural episode2 may start ordinary tracking', async () => {
  const posts = []; let started = false;
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    const snapshot = completeControllerSnapshot(started); snapshot.previously_completed = false;
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body)); started = true;
      const current = completeControllerSnapshot(true);
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: current.foreground, state: current.start_state }) };
    }
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  const { state } = prepareController(subject.context, subject.chrome);
  state.match.totalEpisodes = 2;
  state.player = naturalPlayer(960, 15000, { watched: true });
  await subject.context.maybeSyncProgress(state, true);
  assert.equal((await subject.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'], undefined);
  state.player = naturalPlayer(15, 25000, { episode: 2 });
  await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state, 10, 20000, { episode: 2 }));
  assert.deepEqual(posts.map(request => request.command), ['start']);
});

test('lost automatic Start ACK retains one original intent and never replays or creates a replacement', async () => {
  const posts = [];
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts.push(options.body); throw Error('lost_ack'); }
    return { ok: true, status: 200, json: async () => completeControllerSnapshot() };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  const { state } = prepareController(subject.context, subject.chrome);
  state.player = naturalPlayer(15, 15000);
  await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state));
  const pending = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
  state.player = naturalPlayer(20, 20000);
  await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state, 15, 15000));
  assert.equal(posts.length, 1);
  assert.deepEqual((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], pending);
});

test('movie ended proof must belong to the original native media; opening after its end may automatically rewatch', async () => {
  for (const replacement of [false, true]) {
    const posts = [];
    const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); throw Error('retain_intent'); }
      const snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
      return { ok: true, status: 200, json: async () => snapshot };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
    const { state } = prepareController(subject.context, subject.chrome);
    state.match.type = 'MOVIE'; state.match.totalEpisodes = null;
    state.player = naturalPlayer(960, 15000, { episode: null, watched: true });
    await subject.context.maybeSyncProgress(state, true);
    state.player = naturalPlayer(1200, 20000, { episode: null, watched: true,
      playing: false, ended: true, reason: 'ended', playerInstanceId: replacement ? 'other-video' : 'native-video-a' });
    await subject.context.maybeSyncProgress(state, true);
    const barrier = (await subject.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'].byScope['18:101'];
    assert.equal(barrier.ended, !replacement);
    state.player = naturalPlayer(15, 30000, { episode: null });
    await subject.context.maybeSyncProgress(state, true, undefined, state, observedPlayer(subject.context, state, 10, 25000, { episode: null }));
    assert.deepEqual(posts.map(request => request.command), replacement ? [] : ['start']);
  }
});

test('manual Complete and explicit original retry persist the barrier before POST, and failure preserves pending', async () => {
  const posts = [];
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts.push(options.body); throw Error('lost_ack'); }
    return { ok: true, status: 200, json: async () => completeControllerSnapshot(true) };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  const { state, send } = prepareController(subject.context, subject.chrome);
  state.player = naturalPlayer(1000, 15000, { episode: 3, watched: true });
  const revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  const originalSet = subject.storage.local.set;
  subject.storage.local.set = async values => {
    if (Object.hasOwn(values, 'watch-terminal-barriers-v1')) throw Error('disk_failure');
    return originalSet(values);
  };
  const result = await send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions.find(action => action.command === 'complete').capabilityId });
  assert.equal(result.ok, false);
  assert.deepEqual(posts, [], 'storage failure cannot silently permit Complete egress');
  const pending = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
  assert.equal(pending.request.command, 'complete');
  assert.match(pending.binding.media_lineage, /^[a-f0-9]{64}$/);
  assert.match(pending.binding.top_context, /^[a-f0-9]{64}$/);
  subject.storage.local.set = originalSet;
  await send({ type: 'popup-watch-retry', expectedRevision: revision, commandId: pending.request.command_id });
  assert.equal(posts.length, 1);
  const barrier = (await subject.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'].byScope['18:101'];
  assert.equal(barrier.commandId, pending.request.command_id);
  assert.equal(barrier.ended, false, 'retry without original live source cannot borrow a later ended event');
  assert.equal(barrier.lineage, pending.binding.media_lineage, 'Retry retains only the immutable original hash');
  assert.equal(barrier.topContext, pending.binding.top_context, 'Retry retains original top context, not popup context');
});

test('Complete barrier-write/lost-ACK retry preserves original native proof and fences cached cycle authority before popup refresh', async () => {
  for (const failure of ['barrier-write', 'lost-ack']) for (const restart of [false, true]) {
    let finished = false; let started = false; let firstAck = true;
    const posts = [];
    const snapshot = () => {
      const value = completeControllerSnapshot(!finished || started);
      value.history_adopted = true;
      value.start_state.version = finished ? (started ? 3 : 2) : 1;
      value.foreground.generation = finished ? (started ? 3 : 2) : 1;
      value.totals.completed = finished ? 2 : 1;
      if (value.start_state.current) {
        Object.assign(value.start_state.current, { episode: null, position_sec: started ? 0 : 1000,
          duration_sec: 1200, cycle_id: started ? '32345678-1234-4234-8234-123456789abc' : controllerCycleId });
        value.foreground.cycle_id = value.start_state.current.cycle_id;
      }
      return value;
    };
    const transport = { historyFetchImpl: async (_url, options) => {
      if (options.method !== 'POST') return { ok: true, status: 200, json: async () => snapshot() };
      const request = JSON.parse(options.body); posts.push(request);
      if (request.command === 'complete') {
        finished = true;
        if (failure === 'lost-ack' && firstAck) { firstAck = false; throw Error('lost_ack'); }
      } else if (request.command === 'start') started = true;
      else return { ok: false, status: 409, json: async () => ({ error: 'stale_progress' }) };
      const value = snapshot();
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: value.foreground, state: value.start_state }) };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } };
    let subject = loadServiceWorker(transport);
    let controller = prepareController(subject.context, subject.chrome);
    const setMovie = () => {
      controller.state.match.type = 'MOVIE'; controller.state.match.totalEpisodes = null;
      controller.state.player = naturalPlayer(1000, 15000, { episode: null, watched: true });
    };
    setMovie();
    let revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
    const read = await controller.send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
    const originalSet = subject.storage.local.set;
    if (failure === 'barrier-write') subject.storage.local.set = async values => {
      if (Object.hasOwn(values, 'watch-terminal-barriers-v1')) throw Error('barrier_disk_failure');
      return originalSet(values);
    };
    const failed = await controller.send({ type: 'popup-watch-command', expectedRevision: revision,
      capabilityId: read.payload.actions.find(action => action.command === 'complete').capabilityId });
    assert.equal(failed.ok, false);
    if (failure === 'barrier-write') assert.deepEqual(posts, [], 'mandatory barrier failure sends no POST');
    const original = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
    assert.match(original.binding.media_lineage, /^[a-f0-9]{64}$/);
    subject.storage.local.set = originalSet;
    if (restart) {
      subject = loadServiceWorker({ ...transport, localStorage: subject.storage.local, sessionStorage: subject.storage.session });
      controller = prepareController(subject.context, subject.chrome); setMovie();
      revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
    }
    const retried = await controller.send({ type: 'popup-watch-retry', expectedRevision: revision,
      commandId: original.request.command_id });
    assert.equal(retried.ok, true);
    assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], undefined);
    const completePosts = posts.filter(request => request.command === 'complete');
    for (const wire of completePosts) {
      const { operation, ...body } = wire;
      assert.equal(operation, 'command'); assert.deepEqual(body, JSON.parse(JSON.stringify(original.request)));
    }
    // No current controller/popup GET is inserted here. Native media must not
    // rehydrate the cached pre-Complete foreground or leave stale progress pending.
    controller.state.player = naturalPlayer(1200, 20000, { episode: null, watched: true, playing: false,
      paused: true, ended: true, reason: 'ended', playerInstanceId: 'replacement-video' });
    await subject.context.maybeSyncProgress(controller.state, true);
    let barrier = (await subject.context.readWatchTerminals(subject.context.captureLocalWrite()))['18:101'];
    assert.equal(barrier.lineage, original.binding.media_lineage); assert.equal(barrier.ended, false);
    controller.state.player = naturalPlayer(1200, 25000, { episode: null, watched: true, playing: false,
      paused: true, ended: true, reason: 'ended' });
    await subject.context.maybeSyncProgress(controller.state, true);
    barrier = (await subject.context.readWatchTerminals(subject.context.captureLocalWrite()))['18:101'];
    assert.equal(barrier.ended, true, 'only the original native media can complete its proof');
    controller.state.player = naturalPlayer(15, 35000, { episode: null });
    await subject.context.maybeSyncProgress(controller.state, true, undefined, controller.state,
      observedPlayer(subject.context, controller.state, 10, 30000, { episode: null }));
    assert.deepEqual(posts.map(request => request.command), [...completePosts.map(() => 'complete'), 'start']);
    assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], undefined);
    assert.equal(snapshot().totals.completed, 2, 'Start does not add another completion');
  }
});

test('movie reopen requires a known new top context, fresh scoped Play and natural opening; legacy stays unknown', async () => {
  for (const scenario of ['new-play', 'same-document', 'no-play', 'seek', 'no-advance', 'legacy', 'corrupt']) {
    const posts = [];
    const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); throw Error('retain_intent'); }
      const snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
      return { ok: true, status: 200, json: async () => snapshot };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
    const { state } = prepareController(subject.context, subject.chrome);
    state.match.type = 'MOVIE'; state.match.totalEpisodes = null;
    state.player = naturalPlayer(1000, 15000, { episode: null, watched: true });
    const binding = subject.context.captureLocalWrite();
    const originalContext = await subject.context.watchTopContext(subject.context.captureProgressEvent(state), binding);
    await subject.context.rememberWatchTerminal(binding, { expected_user_id: 18, expected_effective_anime_id: 101,
      command_id: controllerCycleId, episode: null, duration_sec: 1200 }, subject.context.captureProgressEvent(state),
      undefined, scenario === 'legacy' ? undefined : originalContext);
    if (scenario === 'corrupt') {
      const data = (await subject.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'];
      data.byScope['18:101'].topContext = 'invalid'; await subject.storage.local.set({ 'watch-terminal-barriers-v1': data });
    }
    if (scenario !== 'same-document') {
      state.topDocumentId = 'native-document-b'; state.navigationToken = 'navigation-b';
      subject.chrome.tabs.sendMessage = async () => ({ ok: true, documentUrl: state.pageUrl, documentToken: state.navigationToken });
    }
    const playerIdentity = { episode: null, playerInstanceId: 'replacement-video' };
    if (scenario !== 'no-play') {
      state.player = naturalPlayer(0, 20000, { ...playerIdentity, reason: 'play' });
      subject.context.recordWatchObservation(subject.context.captureProgressEvent(state), binding);
    }
    state.player = naturalPlayer(scenario === 'no-advance' ? 10 : 15, 30000,
      { ...playerIdentity, ...(scenario === 'seek' ? { seeking: true, reason: 'seeked' } : {}) });
    await subject.context.maybeSyncProgress(state, true, undefined, state,
      observedPlayer(subject.context, state, 10, 25000, playerIdentity));
    assert.deepEqual(posts.map(request => request.command), scenario === 'new-play' ? ['start'] : [], scenario);
    assert.equal(completeControllerSnapshot().totals.completed, 1);
    const barrier = (await subject.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'].byScope['18:101'];
    assert.equal(barrier.ended, false, 'new playback does not invent original ended proof');
  }
});

test('newborn Complete cannot poison terminal storage or offer an ineligible capability', async () => {
  const subject = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  const { state } = prepareController(subject.context, subject.chrome);
  const binding = subject.context.captureLocalWrite();
  for (const duration of [null, 0, 299]) {
    await assert.rejects(subject.context.rememberWatchTerminal(binding, {
      expected_user_id: 18, expected_effective_anime_id: 101, episode: null, duration_sec: duration,
    }), /complete_media_ineligible/);
    assert.deepEqual(JSON.parse(JSON.stringify(await subject.context.readWatchTerminals(binding))), {});
    const snapshot = completeControllerSnapshot(true);
    Object.assign(snapshot.start_state.current, { episode: null, position_sec: 0, duration_sec: duration });
    const actions = subject.context.publishWatchCapabilities(subject.context.captureProgressEvent(state), binding, 18, snapshot);
    assert.equal(actions.actions.some(action => action.command === 'complete'), false);
  }
  await subject.context.rememberWatchTerminal(binding, {
    expected_user_id: 18, expected_effective_anime_id: 202, episode: 1, duration_sec: 600,
  });
  assert.equal((await subject.context.readWatchTerminals(binding))['18:202'].duration, 600);
});

test('unique paused repeat resumes in the middle of media without a new Start or opening requirement', async () => {
  for (const type of ['TV', 'MOVIE']) {
    const posts = []; let resumed = false;
    const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body)); resumed = true;
        const snapshot = completeControllerSnapshot(true);
        return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
          anime_id: 101, foreground: snapshot.foreground, state: snapshot.start_state }) };
      }
      const snapshot = completeControllerSnapshot(true);
      if (!resumed) {
        snapshot.foreground.cycle_id = null;
        snapshot.start_state.current.status = 'paused';
      }
      return { ok: true, status: 200, json: async () => snapshot };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
    const { state } = prepareController(subject.context, subject.chrome);
    state.match.type = type;
    await subject.context.rememberWatchTerminal(subject.context.captureLocalWrite(), {
      expected_user_id: 18, expected_effective_anime_id: 101, episode: 12, duration_sec: 1200,
    });
    state.player = naturalPlayer(605, 15000, { episode: type === 'MOVIE' ? null : 3 });
    state.progressSync = { key: `101:${type === 'MOVIE' ? 'full' : 3}`, at: Date.now(), position: 600 };
    const previous = observedPlayer(subject.context, state, 600, 10000,
      { episode: state.player.episode, reason: 'play' });
    await subject.context.maybeSyncProgress(state, false, undefined, state, previous);
    assert.deepEqual(posts.map(request => request.command), ['resume']);
    assert.equal(posts[0].cycle_id, controllerCycleId);
  }
});

test('multi-episode terminal ended cannot turn replay of only the final episode into a new anime watch', async () => {
  for (const episode of [12, 1]) {
    const posts = [];
    const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); throw Error('keep_original'); }
      const snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
      return { ok: true, status: 200, json: async () => snapshot };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
    const { state } = prepareController(subject.context, subject.chrome);
    state.player = naturalPlayer(1200, 15000, { episode: 12, watched: true, playing: false, ended: true, reason: 'ended' });
    await subject.context.maybeSyncProgress(state, true);
    assert.equal((await subject.context.readWatchTerminals(subject.context.captureLocalWrite()))['18:101'].ended, true);
    state.player = naturalPlayer(15, 25000, { episode });
    await subject.context.maybeSyncProgress(state, false, undefined, state,
      observedPlayer(subject.context, state, 10, 20000, { episode }));
    assert.deepEqual(posts.map(request => request.command), episode === 1 ? ['start'] : []);
  }
});

test('full terminal capacity remains fail-closed for an unrecorded title after worker restart', async () => {
  const posts = [];
  const transport = { historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') posts.push(options.body);
    const snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } };
  const first = loadServiceWorker(transport);
  const byScope = {};
  for (let id = 200; id < 700; id++) byScope[`18:${id}`] = { episode: 12, duration: 1200, lineage: null, commandId: null, ended: false };
  await first.storage.local.set({ 'watch-terminal-barriers-v1': { version: 1, byScope } });
  const initial = prepareController(first.context, first.chrome);
  initial.state.player = naturalPlayer(960, 15000, { episode: 12, watched: true });
  await assert.rejects(first.context.maybeSyncProgress(initial.state, true), /terminal_barrier_full/);
  const second = loadServiceWorker({ ...transport, localStorage: first.storage.local });
  const restarted = prepareController(second.context, second.chrome);
  restarted.state.player = naturalPlayer(15, 25000);
  await second.context.maybeSyncProgress(restarted.state, false, undefined, restarted.state,
    observedPlayer(second.context, restarted.state, 10, 20000));
  assert.deepEqual(posts, []);
  assert.equal(Object.keys((await second.storage.local.get('watch-terminal-barriers-v1'))['watch-terminal-barriers-v1'].byScope).length, 500);
});

test('short movie Complete80 then ended and immediate natural restart bypasses only the progress throttle', async () => {
  const posts = []; let completed = false;
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    let snapshot = completeControllerSnapshot(!completed);
    snapshot.history_adopted = true;
    if (completed) { snapshot.foreground.generation = 2; snapshot.start_state.version = 2; }
    if (options.method === 'POST') {
      const request = JSON.parse(options.body); posts.push(request);
      if (request.command === 'complete') {
        completed = true; snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
        snapshot.foreground.generation = 2; snapshot.start_state.version = 2;
      } else throw Error('retain_start');
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: snapshot.foreground, state: snapshot.start_state }) };
    }
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  const { state } = prepareController(subject.context, subject.chrome);
  state.match.type = 'MOVIE'; state.match.totalEpisodes = null;
  subject.context.testClock = Date.now();
  vm.runInContext('Date.now = () => testClock', subject.context);
  state.player = naturalPlayer(480, 10000, { episode: null, duration: 600, watched: true });
  await subject.context.loadWatchController(subject.context.captureProgressEvent(state), subject.context.captureLocalWrite(), 18);
  await subject.context.maybeSyncProgress(state, true);
  assert.deepEqual(posts.map(request => request.command), ['complete']);
  const completedSync = { ...state.progressSync };
  subject.context.testClock += 120000;
  state.player = naturalPlayer(600, 130000, { episode: null, duration: 600, watched: true, ended: true, playing: false, reason: 'ended' });
  await subject.context.maybeSyncProgress(state, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.progressSync)), completedSync, 'do not clear or fake old accepted progress');
  subject.context.testClock += 5000;
  state.player = naturalPlayer(15, 140000, { episode: null, duration: 600 });
  await subject.context.maybeSyncProgress(state, false, undefined, state,
    observedPlayer(subject.context, state, 10, 135000, { episode: null, duration: 600 }));
  assert.deepEqual(posts.map(request => request.command), ['complete', 'start']);
});

test('explicit Cancel survives worker restart on the same page; only a new play may start a fresh cycle', async () => {
  const posts = []; let snapshot = completeControllerSnapshot(true);
  const historyFetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      const request = JSON.parse(options.body); posts.push(request);
      if (request.command === 'cancel') {
        snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
        snapshot.foreground.generation = 2; snapshot.start_state.version = 2;
      } else if (request.command === 'start') {
        snapshot = completeControllerSnapshot(true); snapshot.start_state.version = 3;
        snapshot.foreground.generation = 3;
        snapshot.start_state.current.cycle_id = '44444444-4444-4444-8444-444444444444';
        snapshot.foreground.cycle_id = snapshot.start_state.current.cycle_id;
      } else throw Error('unexpected_command');
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: snapshot.foreground, state: snapshot.start_state }) };
    }
    return { ok: true, status: 200, json: async () => snapshot };
  };
  let subject = loadServiceWorker({ historyFetchImpl, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  let { state } = prepareController(subject.context, subject.chrome);
  vm.runInContext('Date.now = () => 15000', subject.context);
  state.player = naturalPlayer(15, 15000);
  const binding = subject.context.captureLocalWrite();
  const projection = await subject.context.loadWatchController(subject.context.captureProgressEvent(state), binding, 18);
  await subject.context.executeWatchCapability(projection.actions.find(action => action.command === 'cancel').capabilityId, binding);
  assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], undefined,
    'restart follows acknowledged Cancel and refreshed empty foreground');
  const storedPage = JSON.parse(JSON.stringify(state));
  await subject.storage.session.set({ 'tab:71': storedPage });
  subject = loadServiceWorker({ historyFetchImpl, localStorage: subject.storage.local,
    sessionStorage: subject.storage.session, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  ({ state } = prepareController(subject.context, subject.chrome));
  Object.assign(state, (await subject.storage.session.get('tab:71'))['tab:71']);
  state.player = naturalPlayer(20, 20000);
  await subject.context.maybeSyncProgress(state, false, undefined, state, observedPlayer(subject.context, state, 15, 15000));
  assert.deepEqual(posts.map(request => request.command), ['cancel']);
  state.player = naturalPlayer(25, 25000);
  await subject.context.maybeSyncProgress(state, false, undefined, state,
    observedPlayer(subject.context, state, 20, 20000, { reason: 'play' }));
  assert.deepEqual(posts.map(request => request.command), ['cancel', 'start']);
  assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], undefined,
    'accepted Start must refresh before clearing the manual stop');
  assert.equal((await subject.storage.session.get('watch-manual-stop:18:101:71'))['watch-manual-stop:18:101:71'], undefined,
    'accepted fresh cycle does not retain the old durable manual stop');
});

test('Cancel stop persistence failure prevents POST; original retry writes a conservative stop before delivery', async () => {
  const posts = []; let snapshot = completeControllerSnapshot(true);
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      const request = JSON.parse(options.body); posts.push(request);
      assert.ok((await subject.storage.session.get('watch-manual-stop:18:101:retry'))['watch-manual-stop:18:101:retry'],
        'original retry persists its guard before server mutation');
      snapshot = completeControllerSnapshot(); snapshot.history_adopted = true;
      snapshot.foreground.generation = 2; snapshot.start_state.version = 2;
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: snapshot.foreground, state: snapshot.start_state }) };
    }
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
  const { state } = prepareController(subject.context, subject.chrome);
  state.player = naturalPlayer(15, 15000);
  vm.runInContext('Date.now = () => 15000', subject.context);
  const binding = subject.context.captureLocalWrite();
  const projection = await subject.context.loadWatchController(subject.context.captureProgressEvent(state), binding, 18);
  const originalSet = subject.storage.session.set;
  subject.storage.session.set = async items => {
    if (Object.keys(items).some(key => key.startsWith('watch-manual-stop:'))) throw Error('session_write_failed');
    return originalSet(items);
  };
  await assert.rejects(subject.context.executeWatchCapability(
    projection.actions.find(action => action.command === 'cancel').capabilityId, binding), /session_write_failed/u);
  assert.deepEqual(posts, []);
  const pending = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
  assert.equal(pending.request.command, 'cancel');
  subject.storage.session.set = originalSet;
  await subject.context.retryWatchCommand(binding, pending.request.command_id);
  assert.deepEqual(posts.map(request => request.command), ['cancel']);
  assert.equal(posts[0].command_id, pending.request.command_id);
  assert.equal(subject.context.captureCycleProgress(subject.context.captureProgressEvent(state), binding), null,
    'a saved receipt revokes old current-document progress authority');
  await subject.context.loadWatchController(subject.context.captureProgressEvent(state), binding, 18);
  state.player = naturalPlayer(20, 20000);
  await subject.context.maybeSyncProgress(state, false, undefined, state, observedPlayer(subject.context, state, 15, 15000));
  assert.deepEqual(posts.map(request => request.command), ['cancel'], 'continued playback cannot undo an original retry');
});

test('closing a tab removes only its own session Cancel stops, preserving another tab and unresolved retry scope', async () => {
  const subject = loadServiceWorker();
  const stop = { documentId: 'native-a', navigationToken: 'navigation-a', observedAt: 15000 };
  await subject.storage.session.set({ 'watch-manual-stop:18:101:71': stop,
    'watch-manual-stop:18:101:72': stop, 'watch-manual-stop:18:101:retry': stop });
  await subject.context.finalizeRemovedTab(71);
  const remaining = await subject.storage.session.get(null);
  assert.equal(remaining['watch-manual-stop:18:101:71'], undefined);
  assert.deepEqual(remaining['watch-manual-stop:18:101:72'], stop);
  assert.deepEqual(remaining['watch-manual-stop:18:101:retry'], stop);
});

test('real play survives metadata ordering until natural advance; pause, seek and scope changes revoke it', async () => {
  for (const invalidate of [null, 'ratechange', 'pause', 'seeking', 'ended', 'document', 'player', 'episode', 'mapping', 'account']) {
    const posts = [];
    const snapshot = completeControllerSnapshot(true);
    snapshot.foreground.cycle_id = null;
    snapshot.start_state.current.status = 'paused';
    const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        const request = JSON.parse(options.body); posts.push(request);
        snapshot.foreground.cycle_id = controllerCycleId;
        snapshot.foreground.generation = 2; snapshot.start_state.version = 2;
        snapshot.start_state.current.status = 'active';
        return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
          anime_id: 101, foreground: snapshot.foreground, state: snapshot.start_state }) };
      }
      return { ok: true, status: 200, json: async () => snapshot };
    }, fetchImpl: async () => { throw Error('unexpected_endpoint'); } });
    const { context } = subject;
    const { state } = prepareController(context, subject.chrome);
    state.player = naturalPlayer(600, 10000, { reason: 'play', duration: null, episode: 3 });
    const play = state.player;
    await context.maybeSyncProgress(state, false);
    assert.deepEqual(posts, [], 'play with unknown duration is not natural advance');
    if (invalidate === 'pause' || invalidate === 'seeking' || invalidate === 'ended') {
      state.player = naturalPlayer(600, 11000, { reason: invalidate, episode: 3,
        ...(invalidate === 'pause' ? { paused: true, playing: false }
          : invalidate === 'ended' ? { ended: true, playing: false } : { seeking: true }) });
      await context.maybeSyncProgress(state, false, undefined, state, play);
    } else if (invalidate === 'mapping') context.invalidateWatchController();
    else if (invalidate === 'account') vm.runInContext("localWriteRevision = 'another-account'", context);
    const nativeDocument = invalidate === 'document' ? 'replacement-frame' : 'frame-document-a';
    const identity = { episode: invalidate === 'episode' ? 4 : 3, documentId: nativeDocument,
      playerInstanceId: invalidate === 'player' ? 'replacement-player' : 'native-video-a' };
    state.player = naturalPlayer(600, 12000, { reason: invalidate === 'ratechange' ? 'ratechange' : 'loadedmetadata', ...identity });
    const metadata = state.player;
    await context.maybeSyncProgress(state, false, undefined, state, play);
    assert.deepEqual(posts, [], 'metadata alone is not advance');
    state.player = naturalPlayer(605, 17000, identity);
    await context.maybeSyncProgress(state, false, undefined, state, metadata);
    assert.deepEqual(posts.map(request => request.command), invalidate === null || invalidate === 'ratechange' ? ['resume'] : [],
      `play→metadata→advance admission with ${invalidate || 'unchanged native scope'}`);
  }
});

function repairRow(group, origin, number) {
  return { effective_anime_id: group, anime_id: origin, history_id: controllerHistoryId,
    cycle_id: `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`,
    competing: true, tracked_start_ordinal: number, episode: number, kind: 'rewatching',
    catalog: { anime_id: group, title: `Title ${group}`, title_ru: null, title_en: null,
      season: null, season_year: null } };
}

function repairSnapshot(rows, more = false) {
  const snapshot = controllerSnapshot();
  snapshot.history_adopted = true; snapshot.readiness = 'reconciliation_required';
  snapshot.component_choices = rows;
  const last = rows.at(-1);
  snapshot.page = { choices_has_more: more, choices_next: more ? {
    after_choice: { effective_anime_id: last.effective_anime_id, anime_id: last.anime_id,
      history_id: last.history_id, cycle_id: last.cycle_id }, snapshot_token: snapshot.reconciliation_token,
  } : null };
  return snapshot;
}

test('actual SW collects complete related-group pages, requires every explicit winner and retains lost-ACK selection', async () => {
  const rows = [repairRow(101, 101, 1), repairRow(101, 102, 2),
    repairRow(202, 202, 3), repairRow(202, 203, 4)];
  const first = repairSnapshot(rows.slice(0, 2), true);
  const second = repairSnapshot(rows.slice(2));
  const posts = []; const continuation = [];
  const subject = loadServiceWorker({ historyFetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts.push(options.body); throw new Error('lost_ack'); }
    const page = new URL(url).searchParams.get('page');
    if (page) continuation.push(JSON.parse(page));
    return { ok: true, status: 200, json: async () => page ? second : first };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const { send } = prepareController(subject.context, subject.chrome);
  const revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  for (const invalid of [undefined, [], [rows[0].cycle_id], [rows[0].cycle_id, rows[0].cycle_id],
    [rows[0].cycle_id, rows[1].cycle_id], [rows[0].cycle_id, 'foreign-cycle']]) {
    const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
    assert.equal(read.ok, true);
    const action = read.payload.actions.find(item => item.command === 'reconcile');
    assert.equal(action.groups.length, 2, 'related group outside visible root included');
    const result = await send({ type: 'popup-watch-command', expectedRevision: revision,
      capabilityId: action.capabilityId, ...(invalid === undefined ? {} : { choiceCycleIds: invalid }) });
    assert.equal(result.ok, false);
    assert.equal(posts.length, 0, 'no partial or inferred winner can reach POST');
  }
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  const result = await send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions[0].capabilityId, choiceCycleIds: [rows[1].cycle_id, rows[2].cycle_id] });
  assert.equal(result.ok, false, 'lost acknowledgement is unresolved');
  assert.equal(posts.length, 1);
  const original = JSON.parse(posts[0]);
  assert.equal(original.operation, 'select'); assert.equal(original.cycle_id, null);
  assert.equal(original.anime_id, 101); assert.equal(original.expected_effective_anime_id, 101);
  assert.deepEqual(original.choices, [rows[1], rows[2]].map(row =>
    ({ history_id: row.history_id, anime_id: row.anime_id, cycle_id: row.cycle_id })));
  assert.deepEqual(continuation[0], first.page.choices_next);
  const pending = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
  assert.equal(pending.action, 'history-select');
  const retry = await send({ type: 'popup-watch-retry', expectedRevision: revision, commandId: original.command_id });
  assert.equal(retry.ok, false);
  assert.equal(posts[1], posts[0], 'explicit retry preserves UUID/CAS and all winners');
});

test('actual SW bounds complete repair collection and offers no partial action beyond 500 choices', async () => {
  const rows = Array.from({ length: 501 }, (_, index) => repairRow(101, 101, index + 1));
  const pages = Array.from({ length: 6 }, (_, index) => repairSnapshot(rows.slice(index * 100, (index + 1) * 100), index < 5));
  let reads = 0; let posts = 0;
  const subject = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') posts++;
    return { ok: true, status: 200, json: async () => pages[reads++] };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const { send } = prepareController(subject.context, subject.chrome);
  const revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(read.ok, true);
  assert.equal(reads, 6);
  assert.equal(read.payload.repairComplete, false);
  assert.equal(read.payload.actions.length, 0);
  assert.equal(posts, 0);
});

test('actual SW refuses stale token, duplicate cycles and incomplete repair pages without POST', async () => {
  for (const defect of ['token', 'duplicate', 'cursor', 'missing-page']) {
    const rows = [repairRow(101, 101, 1), repairRow(101, 102, 2)];
    const first = repairSnapshot(rows.slice(0, 1), true);
    const second = repairSnapshot(rows.slice(1));
    if (defect === 'token') second.reconciliation_token = 'b'.repeat(64);
    if (defect === 'duplicate') second.component_choices[0].cycle_id = rows[0].cycle_id;
    if (defect === 'cursor') first.page.choices_next.after_choice.anime_id = 999;
    if (defect === 'missing-page') delete second.component_choices;
    let posts = 0;
    const subject = loadServiceWorker({ historyFetchImpl: async (url, options) => {
      if (options.method === 'POST') posts++;
      return { ok: true, status: 200, json: async () => new URL(url).searchParams.has('page') ? second : first };
    }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
    const { send } = prepareController(subject.context, subject.chrome);
    const revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
    const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
    assert.equal(read.ok, false, defect);
    assert.equal(posts, 0);
  }
});

test('actual SW explicit settlement hides transferred intent and persists proof before original-root GET', async () => {
  const calls = []; let failOriginal = true; let userId = 18; let clientContext;
  const subject = loadServiceWorker({ historyFetchImpl: async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (init.method === 'POST') {
      const wire = JSON.parse(init.body);
      if (wire.operation === 'command') { if (failOriginal) throw new Error('lost_ack'); throw new Error('unexpected_retry'); }
      assert.equal(wire.operation, 'settle');
      assert.equal(wire.expected_user_id, 18, 'old expectation is immutable');
      assert.equal(init.headers['X-Anireko-Watch-Expected-User'], '19');
      const original = { ...wire }; delete original.operation;
      return { ok: true, status: 200, json: async () => ({ settlement_version: 1, outcome: 'not_applied',
        current_user_id: 19, history_id: wire.history_id, anime_id: wire.anime_id, command_id: wire.command_id,
        original_operation: 'command', command_kind: 'start',
        request_hash: await clientContext.AniRekoWatchRequestHash.hash('history-command', original) }) };
    }
    if (!failOriginal) {
      const pending = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
      assert.equal(pending.version, 2, 'proof durable before GET');
      assert.equal(pending.terminalOutcome.current_user_id, 19);
      assert.equal(new URL(url).searchParams.get('anime_id'), '101', 'original root, not current title');
    }
    const snapshot = controllerSnapshot(); snapshot.user_id = userId;
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  clientContext = subject.context;
  const { send } = prepareController(subject.context, subject.chrome);
  subject.context.activeSyncAccount = async () => ({ userId });
  const revision = (await subject.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  let read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  await send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions.find(a => a.command === 'start').capabilityId });
  const original = (await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'];
  userId = 19;
  read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(read.payload.pendingIntent, null, 'new login alone must not expose previous target/action');
  assert.equal(typeof read.payload.settlementCapabilityId, 'string');
  const before = calls.length;
  assert.equal((await send({ type: 'popup-watch-settle', expectedRevision: revision, capabilityId: 'unknown' })).ok, false);
  assert.equal(calls.length, before);
  // Revocation at admission must not revoke its own reservation, but a later
  // controller/account change during the async account read must still fence it.
  subject.context.activeSyncAccount = async () => {
    subject.context.invalidateWatchController();
    return { userId };
  };
  assert.equal((await send({ type: 'popup-watch-settle', expectedRevision: revision,
    capabilityId: read.payload.settlementCapabilityId })).ok, false);
  assert.equal(calls.length, before, 'controller change before settlement must send no request');
  assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'].request.command_id,
    original.request.command_id, 'failed reservation preserves the original command');
  subject.context.activeSyncAccount = async () => ({ userId });
  read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(typeof read.payload.settlementCapabilityId, 'string');
  failOriginal = false;
  const result = await send({ type: 'popup-watch-settle', expectedRevision: revision,
    capabilityId: read.payload.settlementCapabilityId });
  assert.equal(result.ok, true);
  assert.equal(result.payload.outcome, 'not_applied');
  assert.equal(result.payload.snapshot, undefined, 'result is not current-document publication');
  assert.equal(result.payload.originalAnimeId, undefined, 'no unnecessary previous target exposure');
  assert.equal((await subject.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'], undefined);
  const settle = JSON.parse(calls.find(c => c.body && JSON.parse(c.body).operation === 'settle').body);
  delete settle.operation;
  assert.deepEqual(settle, JSON.parse(JSON.stringify(original.request)));
});

test('cycle terminal observation requires its own scoped fresh catalog proof', async () => {
  const { context, chrome } = loadServiceWorker({ historyFetchImpl: async () => (
    { ok: true, status: 200, json: async () => controllerSnapshot(true) }
  ), fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const { state, send } = prepareController(context, chrome);
  state.player.episode = 12;
  state.player.watched = true;
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(read.ok, true);
  context.terminalState = state;
  const capture = vm.runInContext('captureCycleProgress(captureProgressEvent(terminalState), captureLocalWrite())', context);
  assert.equal(capture.intent.request.command, 'progress', 'stale FINISHED metadata cannot close a new cycle');
});

test('retained unconsumed ONGOING result cannot complete a cycle in actual producer order', async () => {
  const posts = [];
  let enteredSearch; let releaseSearch;
  const entered = new Promise((resolve) => { enteredSearch = resolve; });
  const blocked = new Promise((resolve) => { releaseSearch = resolve; });
  const transport = completionFetch({ failSearchCount: 0 });
  const { context, chrome, storage } = loadServiceWorker({
    historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
          anime_id: 101, foreground: controllerSnapshot(true).foreground, state: controllerSnapshot(true).start_state }) };
      }
      return { ok: true, status: 200, json: async () => controllerSnapshot(true) };
    }, fetchImpl: async (url, init) => {
      if (url.includes('/api/search')) {
        enteredSearch(); await blocked;
        const payload = freshFinishedSearchPayload();
        payload.data[0].id = 101; payload.data[0].title = 'Known anime';
        payload.data[0].episodes = 13; payload.data[0].release_status = 'ONGOING';
        return { ok: true, status: 200, json: async () => payload };
      }
      return transport.fetchImpl(url, init);
    },
  });
  await bindSyncAccount(storage);
  const { state, send } = prepareController(context, chrome);
  state.player.episode = 12;
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  assert.equal((await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision })).ok, true);
  const old = context.maybeAutoMark(state);
  await entered;
  state.player = { ...state.player, currentTime: 1001 };
  releaseSearch(); await old;
  assert.equal(state.match.releaseStatus, 'FINISHED', 'result retained but old observation cannot publish');
  await Promise.all([context.maybeSyncProgress(state, true), context.maybeAutoMark(state)]);
  assert.equal(state.match.releaseStatus, 'ONGOING');
  assert.ok(posts.length > 0, 'actual cycle producer reaches POST');
  assert.equal(posts.some((request) => request.command === 'complete'), false);
});

test('actual controller explicit start uses one immutable admission and fresh snapshot, not receipt', async () => {
  const posts = []; let started = false;
  const { context, chrome } = loadServiceWorker({
    historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body)); started = true;
        return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
          anime_id: 101, foreground: controllerSnapshot(true).foreground, state: controllerSnapshot(true).start_state }) };
      }
      return { ok: true, status: 200, json: async () => controllerSnapshot(started) };
    },
    fetchImpl: async () => { throw new Error('unexpected_endpoint'); },
  });
  const { state, send } = prepareController(context, chrome);
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(posts.length, 0, 'GET never implicitly starts');
  assert.equal(Object.isFrozen(state), false, 'capability must not recursively freeze live SW state');
  const start = read.payload.actions.find((action) => action.command === 'start');
  const request = { type: 'popup-watch-command', capabilityId: start.capabilityId, expectedRevision: revision };
  const results = await Promise.all([send(request), send(request)]);
  assert.equal(posts.length, 1, 'same capability has one admission/POST');
  assert.equal(posts[0].command, 'start'); assert.equal(posts[0].expected_version, 0);
  assert.equal(posts[0].expected_user_id, 18); assert.equal(posts[0].history_id, controllerHistoryId);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const fresh = results.find((result) => result.ok).payload;
  assert.equal(fresh.snapshot.history_adopted, true);
  assert.ok(fresh.actions.some((action) => action.command === 'pause'));
});

test('actual controller restart retries original persisted bytes, never starts on startup', async () => {
  const posts = [];
  const first = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts.push(options.body); throw new Error('lost_ack'); }
    const snapshot = controllerSnapshot();
    if (new URL(_url).searchParams.get('anime_id') === '202') {
      snapshot.requested_anime_id = 202; snapshot.effective_anime_id = 202; snapshot.start_anime_id = 202;
      snapshot.foreground.anime_id = 202; snapshot.start_state.anime_id = 202; snapshot.catalog.anime_id = 202;
    }
    return { ok: true, status: 200, json: async () => snapshot };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const initial = prepareController(first.context, first.chrome);
  const revision = (await first.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await initial.send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  await initial.send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions.find((action) => action.command === 'start').capabilityId });
  assert.equal(posts.length, 1);
  const persisted = await first.storage.local.get(null);
  assert.equal(persisted['watch-command-pending-v1'].acknowledged, false);
  initial.state.match = { ...initial.state.match, animeId: 202 };
  first.context.currentPendingState = initial.state;
  const descriptorRead = await initial.send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(descriptorRead.payload.pendingIntent?.animeId, 101, 'original target visible before retry on another title');
  assert.equal(descriptorRead.payload.pendingIntent?.action, 'start');
  assert.equal(descriptorRead.payload.pendingIntent?.commandId, JSON.parse(posts[0]).command_id);
  const foreign = JSON.parse(JSON.stringify(persisted['watch-command-pending-v1']));
  foreign.request.expected_user_id = 17;
  await first.storage.local.set({ 'watch-command-pending-v1': foreign });
  const foreignRead = await initial.send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(foreignRead.payload.pending, true);
  assert.equal(foreignRead.payload.pendingIntent, null, 'other account target/action stay private');
  await first.storage.local.set({ 'watch-command-pending-v1': persisted['watch-command-pending-v1'] });
  const second = loadServiceWorker({ localStorage: first.storage.local, historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      posts.push(options.body);
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: controllerSnapshot(true).foreground, state: controllerSnapshot(true).start_state }) };
    }
    return { ok: true, status: 200, json: async () => controllerSnapshot(true) };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const restarted = prepareController(second.context, second.chrome);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'startup must not replay');
  const nextRevision = (await second.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const wrong = await restarted.send({ type: 'popup-watch-retry', expectedRevision: nextRevision, commandId: 'wrong-command' });
  assert.equal(wrong.ok, false); assert.equal(posts.length, 1, 'changed/unseen intent cannot be resent');
  const result = await restarted.send({ type: 'popup-watch-retry', expectedRevision: nextRevision, commandId: JSON.parse(posts[0]).command_id });
  assert.equal(result.ok, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[1], posts[0], 'same original UUID/body/CAS after restart');
  assert.equal(result.payload.originalAnimeId, 101);
  assert.equal(result.payload.snapshot, undefined, 'retry receipt is not current-document state');
  assert.equal(Object.hasOwn(await second.storage.local.get(null), 'watch-command-pending-v1'), false);
});

test('actual acknowledged command survives restart and retries GET only', async () => {
  let acknowledged = false;
  const posts = [];
  const first = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      acknowledged = true; posts.push(options.body);
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: controllerSnapshot(true).foreground, state: controllerSnapshot(true).start_state }) };
    }
    return { ok: true, status: 200, json: async () => acknowledged ? {} : controllerSnapshot() };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const initial = prepareController(first.context, first.chrome);
  const revision = (await first.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await initial.send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  const result = await initial.send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions.find((action) => action.command === 'start').capabilityId });
  assert.equal(result.ok, false);
  assert.equal((await first.storage.local.get('watch-command-pending-v1'))['watch-command-pending-v1'].acknowledged, true);
  const second = loadServiceWorker({ localStorage: first.storage.local, historyFetchImpl: async (_url, options) => {
    assert.notEqual(options.method, 'POST', 'acknowledged original command is never resent');
    return { ok: true, status: 200, json: async () => controllerSnapshot(true) };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const restarted = prepareController(second.context, second.chrome);
  const nextRevision = (await second.context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  assert.equal((await restarted.send({ type: 'popup-watch-retry', expectedRevision: nextRevision, commandId: JSON.parse(posts[0]).command_id })).ok, true);
  assert.equal(posts.length, 1);
});

test('actual command rejects a replaced native document before durable admission', async () => {
  const posts = [];
  const { context, chrome, storage } = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') posts.push(options.body);
    return { ok: true, status: 200, json: async () => controllerSnapshot() };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const { state, send } = prepareController(context, chrome);
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  chrome.tabs.sendMessage = async () => ({ ok: true, documentUrl: state.pageUrl, documentToken: 'new-document-same-url' });
  const result = await send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions.find((action) => action.command === 'start').capabilityId });
  assert.equal(result.ok, false);
  assert.deepEqual(posts, []);
  assert.equal(Object.hasOwn(await storage.local.get(null), 'watch-command-pending-v1'), false);
});

test('actual controller obtains off-page foreground origin with the exact snapshot token', async () => {
  const pages = [];
  const full = controllerSnapshot(true);
  const { context, chrome } = loadServiceWorker({ historyFetchImpl: async (url) => {
    const page = new URL(url).searchParams.get('page');
    pages.push(page);
    return { ok: true, status: 200, json: async () => page
      ? { ...full, origins: [], selected_origin: full.origins[0] }
      : { ...full, origins: [] } };
  }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); } });
  const { send } = prepareController(context, chrome);
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const response = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(pages[1]), { selected_cycle_id: controllerCycleId, snapshot_token: 'a'.repeat(64) });
  assert.ok(response.payload.actions.some((action) => action.command === 'pause'));
});

test('actual media producer learns the cycle without retrobinding and ignores old completed history', async () => {
  const posts = [];
  const full = controllerSnapshot(true);
  const { context, chrome, storage } = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      const payload = JSON.parse(options.body); posts.push(payload);
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: full.foreground, state: { ...full.start_state, version: 2 } }) };
    }
    return { ok: true, status: 200, json: async () => full };
  }, fetchImpl: async () => { throw new Error('legacy_endpoint_must_not_be_called'); } });
  const { state } = prepareController(context, chrome);
  state.player = { ...state.player, watched: false, currentTime: 100 };
  await storage.local.set({ 'watch-history': { days: {}, records: {
    'known anime::12': { animeId: 101, episode: 12, completed: true, position: 1200, duration: 1200 },
  } } });
  await context.maybeSyncProgress(state, true);
  assert.deepEqual(posts, [], 'first observation learns foreground, never retrobinds that observation');
  state.player = { ...state.player, currentTime: 150 };
  await context.maybeSyncProgress(state, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].command, 'progress', 'previous completion cannot complete the current cycle');
  assert.equal(posts[0].cycle_id, controllerCycleId);
  assert.equal(posts[0].expected_version, 1);
  assert.equal(posts[0].position_sec, 150);
  assert.equal(posts[0].episode, 2);
});

test('authoritative episode signal mutating the same player rejects captured cycle progress', async () => {
  const posts = [];
  const full = controllerSnapshot(true);
  const { context, chrome } = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: full.foreground, state: full.start_state }) };
    }
    return { ok: true, status: 200, json: async () => full };
  }, fetchImpl: async () => { throw new Error('legacy_endpoint_must_not_be_called'); } });
  const { state, send } = prepareController(context, chrome);
  state.player.watched = false;
  state.player.documentId = 'native-document-a';
  state.player.frameId = 0; state.player.locallyVisible = true;
  state.players = { main: state.player };
  const reference = state.player;
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  assert.equal((await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision })).ok, true);
  let enteredGate; let releaseGate;
  const entered = new Promise((resolve) => { enteredGate = resolve; });
  const blocked = new Promise((resolve) => { releaseGate = resolve; });
  context.activeSyncAccount = async () => { enteredGate(); await blocked; return { userId: 18 }; };
  const pending = context.maybeSyncProgress(state, true);
  await entered;
  context.episodeSignalState = state;
  assert.equal(vm.runInContext("applyEpisodeSignal(episodeSignalState, { episode: 1, authoritative: true, sourceKind: 'playlist', topFrame: true, documentId: 'native-document-a' })", context), true);
  assert.equal(state.player, reference, 'actual signal producer mutates original object');
  assert.equal(state.player.episode, 1);
  releaseGate(); await pending;
  assert.deepEqual(posts, [], 'old captured episode cannot enter durable network command');
});

test('actual popup saved movie sync cannot complete an adopted active cycle', async () => {
  const posts = [];
  const full = controllerSnapshot(true);
  const { context, chrome, storage } = loadServiceWorker({ historyFetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ history_id: controllerHistoryId,
        anime_id: 101, foreground: full.foreground, state: full.start_state }) };
    }
    return { ok: true, status: 200, json: async () => full };
  }, fetchImpl: async (url) => {
    if (url.includes('/api/auth/session-info.php')) {
      return { ok: true, status: 200, json: async () => ({ success: true, user: { id: 18 } }) };
    }
    throw new Error('legacy_endpoint_must_not_be_called');
  } });
  await storage.local.set({ 'auto-mark': true, 'sync-account': { id: 18, boundAt: Date.now() },
    'privacy-consent': { version: 1, acceptedAt: Date.now() },
    'watch-history': { days: {}, records: { 'known anime::full': {
      animeId: 101, episode: null, position: 1200, duration: 1200, completed: true, lastWatchedAt: 2000,
    } } } });
  const { state, send } = prepareController(context, chrome);
  state.match.type = 'MOVIE';
  state.player = { player: 'iframe-shell', playbackStarted: false };
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  assert.equal((await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision })).ok, true);
  await send({ type: 'popup-sync-current', tabId: 71, expectedUserId: 18, expectedRevision: revision });
  assert.deepEqual(posts, [], 'previous saved completion cannot write current cycle');
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  const complete = read.payload.actions.find((action) => action.command === 'complete');
  assert.ok(complete, 'explicit user Complete remains available independently of playback');
  assert.equal((await send({ type: 'popup-watch-command', capabilityId: complete.capabilityId, expectedRevision: revision })).ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].command, 'complete', 'only explicitly selected capability can complete this cycle');
});

test('actual controller clear drains entered journal persistence and rejects old command callback', async () => {
  const posts = [];
  const { context, chrome, storage } = loadServiceWorker({
    historyFetchImpl: async (_url, options) => {
      if (options.method === 'POST') posts.push(options.body);
      return { ok: true, status: 200, json: async () => controllerSnapshot() };
    }, fetchImpl: async () => { throw new Error('unexpected_endpoint'); },
  });
  const { send } = prepareController(context, chrome);
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const read = await send({ type: 'popup-watch-history', tabId: 71, expectedRevision: revision });
  let release; let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  const originalSet = storage.local.set;
  storage.local.set = async (items) => {
    const captured = JSON.parse(JSON.stringify(items));
    if (Object.hasOwn(items, 'watch-command-pending-v1')) { entered(); await blocked; }
    return originalSet(captured);
  };
  const command = send({ type: 'popup-watch-command', expectedRevision: revision,
    capabilityId: read.payload.actions.find((action) => action.command === 'start').capabilityId });
  await waiting;
  let cleared = false;
  const clear = send({ type: 'popup-delete-local-data', expectedRevision: revision }).then((value) => { cleared = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared, false, 'clear must wait for entered journal storage write');
  release(); await Promise.all([command, clear]);
  assert.deepEqual(await storage.local.get(null), {});
  assert.deepEqual(posts, [], 'invalidated admission never starts network mutation');
});

test('actual progress and auto-mark require strict owner-bound unadopted history', async () => {
  for (const [name, snapshot, allowed] of [
    ['false', adoptionSnapshot(false), true],
    ['true even with zero totals', { ...adoptionSnapshot(true), totals: { started: 0, completed: 0 } }, false],
    ['unsupported', {}, false],
    ['boolean string', adoptionSnapshot('false'), false],
    ['foreign owner', { ...adoptionSnapshot(false), user_id: 19 }, false],
    ['foreign target', { ...adoptionSnapshot(false), requested_anime_id: 202 }, false],
    ['effective ID outside int4', { ...adoptionSnapshot(false), effective_anime_id: 2147483648,
      foreground: { anime_id: 2147483648, generation: 0, cycle_id: null } }, false],
    ['reconciliation', { ...adoptionSnapshot(false), readiness: 'reconciliation_required' }, false],
    ['false with active cycle', { ...adoptionSnapshot(false), foreground: {
      anime_id: 101, generation: 1, cycle_id: '11111111-1111-4111-8111-111111111111' } }, false],
  ]) {
    const posts = []; let reads = 0;
    const { context } = loadServiceWorker({
      historyFetchImpl: async () => { reads++; return { ok: true, status: 200, json: async () => snapshot }; },
      fetchImpl: async (url, options) => {
        if (options.method === 'POST') posts.push(url);
        return { ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }) };
      },
    });
    context.activeSyncAccount = async () => ({ userId: 18 });
    const state = adoptionState();
    await Promise.all([context.maybeSyncProgress(state, true), context.maybeAutoMark(state)]);
    assert.equal(reads, 1, `${name}: producers share one exact-binding read`);
    assert.equal(posts.length, allowed ? 2 : 0, `${name}: actual legacy writers`);
  }
});

test('progress conflict fences auto-mark already awaiting the old status read', async () => {
  let release; let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  const posts = [];
  const { context } = loadServiceWorker({ fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/api/anime/status.php' && options.method !== 'POST') {
      entered(); await blocked;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }) };
    }
    if (options.method === 'POST') posts.push(url);
    return { ok: false, status: 409, json: async () => ({ error: 'history_adopted' }) };
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = adoptionState();
  const marking = context.maybeAutoMark(state);
  await waiting;
  await context.maybeSyncProgress(state, true);
  release(); await marking;
  assert.equal(posts.length, 1);
  assert.ok(posts[0].includes('/progress.php'), 'status POST must not cross the observed adoption fence');
});

test('actual status conflict cannot be crossed by a queued progress admission continuation', async () => {
  const violations = [];
  for (let microtaskDelay = 0; microtaskDelay < 12; microtaskDelay++) {
    let release; let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { entered = resolve; });
    let state; let binding;
    const { context } = loadServiceWorker({ fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/api/anime/status.php') {
        if (options.method !== 'POST') return {
          ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }),
        };
        entered(); await blocked;
        return { ok: false, status: 409, json: async () => ({ error: 'history_adopted' }) };
      }
      if (options.method === 'POST'
        && !context.legacyWatchWriteStillAllowed(context.captureProgressEvent(state), binding, 18)) {
        violations.push(microtaskDelay);
      }
      return { ok: true, status: 204, json: async () => null };
    } });
    context.activeSyncAccount = async () => ({ userId: 18 });
    state = adoptionState(); binding = context.captureLocalWrite();
    await context.readWatchHistory(context.captureProgressEvent(state), binding, 18);
    const marking = context.maybeAutoMark(state, binding);
    await waiting;
    const progress = context.maybeSyncProgress(state, true, binding);
    const settleAfter = (remaining) => {
      if (remaining === 0) release();
      else queueMicrotask(() => settleAfter(remaining - 1));
    };
    settleAfter(microtaskDelay);
    await Promise.all([marking, progress]);
  }
  assert.deepEqual(violations, [], 'no actual progress POST after the shared admission has closed');
});

test('server conflict closes cached false adoption until explicit fresh read', async () => {
  let reads = 0; let posts = 0;
  const { context } = loadServiceWorker({
    historyFetchImpl: async () => { reads++; return { ok: true, status: 200, json: async () => adoptionSnapshot(false) }; },
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') posts++;
      return { ok: false, status: 409, json: async () => ({ error: 'history_adopted' }) };
    },
  });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = adoptionState();
  await context.maybeSyncProgress(state, true);
  state.player.currentTime = 1100;
  await context.maybeSyncProgress(state, true);
  assert.equal(posts, 1, 'no next-media-tick retry after adoption conflict');
  assert.equal(reads, 1, 'no automatic history polling after conflict');
  const event = context.captureProgressEvent(state);
  await context.readWatchHistory(event, context.captureLocalWrite(), 18, true);
  await context.maybeSyncProgress(state, true);
  assert.equal(reads, 2);
  assert.equal(posts, 2, 'explicit read is required; actual server fence still decides the write');
});

test('delayed adoption read cannot authorize a changed document or manual match', async () => {
  for (const change of ['document', 'match', 'account']) {
    let release; let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { entered = resolve; });
    const posts = [];
    const { context } = loadServiceWorker({
      historyFetchImpl: async () => { entered(); await blocked;
        return { ok: true, status: 200, json: async () => adoptionSnapshot(false) }; },
      fetchImpl: async (_url, options) => { posts.push(options.body);
        return { ok: true, status: 200, json: async () => ({}) }; },
    });
    context.activeSyncAccount = async () => ({ userId: 18 });
    const state = adoptionState();
    const pending = context.maybeSyncProgress(state, true);
    await reading;
    if (change === 'document') state.topDocumentId = 'same-url-new-document';
    if (change === 'match') state.match = { status: 'ok', exact: true, animeId: 202 };
    if (change === 'account') vm.runInContext('localWriteRevision = crypto.randomUUID(); localWriteBarrier.invalidate();', context);
    release(); await pending;
    assert.deepEqual(posts, [], change);
  }
});

test('popup history listener is readonly and rejects persisted-only document state', async () => {
  let reads = 0; const posts = [];
  const { context, chrome } = loadServiceWorker({
    historyFetchImpl: async () => { reads++; return { ok: true, status: 200, json: async () => adoptionSnapshot(true) }; },
    fetchImpl: async (_url, options) => { posts.push(options.body); throw new Error('unexpected_write'); },
  });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = { ...adoptionState(), tabId: 71 };
  chrome.tabs.sendMessage = async (_tabId, message, options) => {
    assert.equal(message.type, 'anireko-detector-status');
    assert.equal(options.documentId, state.topDocumentId);
    return { ok: true, documentUrl: state.pageUrl, documentToken: state.navigationToken };
  };
  context.testHistoryState = state;
  vm.runInContext('stateByTab[71] = testHistoryState;', context);
  const revision = (await context.handlePopupRequest({ type: 'popup-runtime-info' })).payload.localWriteRevision;
  const send = (tabId) => new Promise((resolve) => {
    chrome.runtime.onMessage.listener({ type: 'popup-watch-history', tabId, expectedRevision: revision },
      { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/popup.html` }, resolve);
  });
  const result = await send(71);
  assert.equal(result.status, 200); assert.equal(result.payload.snapshot.history_adopted, true);
  assert.equal((await send(72)).status, 409);
  assert.equal(reads, 1); assert.deepEqual(posts, [], 'open/read never initializes or starts a cycle');
});

test('adopted history blocks actual popup manual sync and final tab-close producers', async () => {
  for (const producer of ['popup', 'tab-close']) {
    const posts = [];
    const { context, storage } = loadServiceWorker({
      historyFetchImpl: async () => ({ ok: true, status: 200, json: async () => adoptionSnapshot(true) }),
      fetchImpl: async (url, options) => { if (options.method === 'POST') posts.push(url);
        return { ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }) }; },
    });
    context.activeSyncAccount = async () => ({ userId: 18 });
    const state = { ...adoptionState(), tabId: 71 };
    if (producer === 'popup') {
      context.testHistoryState = state;
      vm.runInContext('stateByTab[71] = testHistoryState;', context);
      const response = await context.syncPopupCurrent({ tabId: 71, expectedUserId: 18 });
      assert.equal(response.payload.progressSynced, false);
      assert.equal(response.payload.statusSynced, false);
    } else {
      await storage.session.set({ 'tab:71': state });
      await context.finalizeRemovedTab(71);
      assert.equal((await storage.session.get('tab:71'))['tab:71'], undefined);
    }
    assert.deepEqual(posts, [], producer);
  }
});

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

function loadServiceWorker({ fetchImpl, historyFetchImpl, localStorage, sessionStorage } = {}) {
  const local = localStorage || makeStorage();
  const session = sessionStorage || makeStorage();
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
      onMessage: { addListener(listener) { this.listener = listener; } },
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
    crypto: require('node:crypto').webcrypto,
    URL,
    URLSearchParams,
    TextEncoder,
    globalThis: undefined,
    AbortSignal,
    setTimeout,
    // Existing legacy tests model a supported, explicitly unadopted account.
    // Adoption regressions supply their own history transport, not a bypass of
    // the actual controller/validator or writer admission.
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/api/extension/history.php') {
        if (historyFetchImpl) return historyFetchImpl(url, options);
        const query = new URL(url).searchParams;
        const animeId = Number(query.get('anime_id'));
        return { ok: true, status: 200, json: async () => ({
          user_id: Number(query.get('expected_user_id')), requested_anime_id: animeId,
          effective_anime_id: animeId, history_adopted: false, readiness: 'ready',
          foreground: { anime_id: animeId, generation: 0, cycle_id: null },
        }) };
      }
      return fetchImpl(url, options);
    },
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

test('actual popup clear drains a started history writer before reporting success', async () => {
  const { context, storage, chrome } = loadServiceWorker({
    fetchImpl: async () => { throw new Error('unexpected_network'); },
  });
  vm.runInContext("historyCache = { records: { episode: { animeId: 101, lastWatchedAt: 1 } }, days: {} };", context);
  const originalSet = storage.local.set;
  let releaseWrite;
  const blocked = new Promise((resolve) => { releaseWrite = resolve; });
  let enteredWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  storage.local.set = async (items) => {
    if (Object.hasOwn(items, 'watch-history')) {
      // Chrome storage captures values independently of later in-memory edits.
      const captured = JSON.parse(JSON.stringify(items));
      enteredWrite();
      await blocked;
      return originalSet(captured);
    }
    return originalSet(items);
  };
  const writer = context.flushHistory({ reason: 'pause' });
  await entered;
  let replied = false;
  const response = new Promise((resolve) => {
    const retained = chrome.runtime.onMessage.listener(
      { type: 'popup-delete-local-data' },
      { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/popup.html` },
      (value) => { replied = true; resolve(value); },
    );
    assert.equal(retained, true);
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replied, false, 'clear must not acknowledge while an entered writer can restore data');
  } finally {
    releaseWrite();
    await writer;
    await response;
  }
  assert.equal((await response).status, 200);
  assert.deepEqual(await storage.local.get(null), {});
});

test('queued progress cannot substitute a replacement anime and player', async () => {
  const sent = [];
  const { context } = loadServiceWorker({ fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({}) };
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = { sourceOrigin: 'https://source.example', match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } };
  const queued = context.maybeSyncProgress(state, true);
  state.match = { status: 'ok', exact: true, animeId: 202 };
  state.player = { playbackStarted: true, episode: 2, currentTime: 250, duration: 1200 };
  await queued;
  assert.deepEqual(sent, []);
});

test('stable queued identity uses the event media values captured before the queue', async () => {
  const sent = [];
  const { context } = loadServiceWorker({ fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({}) };
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = { sourceOrigin: 'https://source.example', match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200, voice: 'Original' } };
  const queued = context.maybeSyncProgress(state, true);
  state.player.currentTime = 250;
  state.player.voice = 'Later';
  await queued;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].position_sec, 10);
  assert.equal(sent[0].voice, 'Original');
});

test('late progress ACK after actual clear cannot recreate resume cache', async () => {
  let resolvePost;
  const response = new Promise((resolve) => { resolvePost = resolve; });
  let enteredPost;
  const entered = new Promise((resolve) => { enteredPost = resolve; });
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => {
    enteredPost();
    return response;
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = { sourceOrigin: 'https://source.example', match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } };
  const queued = context.maybeSyncProgress(state, true);
  await entered;
  assert.equal((await context.handlePopupRequest({ type: 'popup-delete-local-data' })).status, 200);
  resolvePost({ ok: true, status: 200, json: async () => ({}) });
  await queued;
  assert.deepEqual(await storage.local.get(null), {});
});

test('old popup preference capability cannot restore consent after clear', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  const original = await context.handlePopupRequest({ type: 'popup-runtime-info' });
  await context.handlePopupRequest({ type: 'popup-delete-local-data' });
  const response = await context.handlePopupRequest({ type: 'popup-update-preferences',
    operation: 'accept-consent', diagnostics: false, expectedRevision: original.payload.localWriteRevision });
  assert.equal(response.status, 409);
  assert.deepEqual(await storage.local.get(null), {});
  const fresh = await context.handlePopupRequest({ type: 'popup-runtime-info' });
  const accepted = await context.handlePopupRequest({ type: 'popup-update-preferences',
    operation: 'accept-consent', diagnostics: false, expectedRevision: fresh.payload.localWriteRevision });
  assert.equal(accepted.status, 200);
  assert.equal((await storage.local.get('privacy-consent'))['privacy-consent'].diagnostics, false);
});

test('local history queue captures media and match before its asynchronous turn', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  const state = { recognition: { title: 'Captured Anime', voice: 'Original' },
    match: { status: 'ok', exact: true, animeId: 101 }, topVoice: 'Original',
    player: { episode: 1, currentTime: 10, duration: 1200, progress: 0.01,
      observedAt: 1000, reason: 'pause', watched: false } };
  const queued = context.queueHistoryUpdate(state, state.player, null);
  state.player.currentTime = 250;
  state.topVoice = 'Later';
  await queued;
  const record = (await storage.local.get('watch-history'))['watch-history'].records['captured anime::1'];
  assert.equal(record.position, 10);
  assert.equal(record.voice, 'Original');
  assert.equal(record.animeId, 101);
});

test('local history queue rejects a replacement page or anime before writing', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  const state = { recognition: { title: 'Old Anime' }, navigationToken: 'old-document',
    match: { status: 'ok', exact: true, animeId: 101 },
    player: { episode: 1, currentTime: 10, duration: 1200, observedAt: 1000, reason: 'pause' } };
  const queued = context.queueHistoryUpdate(state, state.player, null);
  state.navigationToken = 'new-document';
  state.match = { status: 'ok', exact: true, animeId: 202 };
  await queued;
  assert.equal((await storage.local.get('watch-history'))['watch-history'], undefined);
});

test('unmatched first-page history remains local without inventing an anime ID', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  const state = { tabId: 5, recognition: { title: 'Unresolved Anime' }, match: { status: 'none' },
    player: { episode: 1, currentTime: 10, duration: 1200, observedAt: 1000, reason: 'pause' } };
  await context.queueHistoryUpdate(state, state.player, null);
  const record = (await storage.local.get('watch-history'))['watch-history']?.records['unresolved anime::1'];
  assert.equal(record?.animeId, null);
  assert.equal(record?.position, 10);
});

test('metadata response for a replaced player cannot publish or write completion', async () => {
  const { context } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseResolve;
  const delayed = new Promise((resolve) => { releaseResolve = resolve; });
  context.resolveAnimeMatch = async () => { enteredResolve(); return delayed; };
  const state = { recognition: { title: 'Old Anime' }, sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101, completionMetadataReady: false },
    player: { episode: 12, watched: true, currentTime: 1200, duration: 1200 } };
  const originalMatch = state.match;
  const pending = context.maybeAutoMark(state);
  await entered;
  state.player = { episode: 1, watched: false, currentTime: 10, duration: 1200 };
  releaseResolve({ status: 'ok', exact: true, animeId: 101, completionMetadataReady: true,
    releaseStatus: 'FINISHED', totalEpisodes: 12 });
  await pending;
  assert.equal(state.match, originalMatch);
  assert.equal(state.autoMark, undefined);
  assert.equal(vm.runInContext("completionMetadataRefreshedInSession.has('101:12')", context), false);
});

test('observed account replacement invalidates a late progress ACK', async () => {
  let releasePost;
  const delayed = new Promise((resolve) => { releasePost = resolve; });
  let enteredPost;
  const entered = new Promise((resolve) => { enteredPost = resolve; });
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { enteredPost(); return delayed; } });
  const session = (id) => ({ ok: true, payload: { success: true, user: { id } } });
  context.noteSessionIdentity(session(18));
  context.activeSyncAccount = async () => ({ userId: 18 });
  const state = { sourceOrigin: 'https://anime.example', match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } };
  const pending = context.maybeSyncProgress(state, true);
  await entered;
  context.noteSessionIdentity(session(19));
  releasePost({ ok: true, status: 204, json: async () => null });
  await pending;
  assert.equal((await storage.local.get('resume-bulk'))['resume-bulk'], undefined);
});

test('late taste response cannot repopulate a cache after clear', async () => {
  let releaseTaste;
  const delayed = new Promise((resolve) => { releaseTaste = resolve; });
  const { context } = loadServiceWorker({ fetchImpl: async () => delayed });
  const pending = context.resolveTasteMatch(101, 'user:18');
  const observed = assert.rejects(pending, /write_binding_changed/);
  await context.handlePopupRequest({ type: 'popup-delete-local-data' });
  releaseTaste({ ok: true, status: 200, json: async () => ({ data: {
    has_profile: true, match_percent: 90, label_key: 'very_likely', confidence_label_key: 'high' } }) });
  await observed;
  assert.equal(vm.runInContext('tasteCache.size', context), 0);
});

test('a distinct concurrent control cannot borrow the first control success', async () => {
  const { context } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let secondRan = false;
  const first = context.exclusiveLocalControl(async () => delayed);
  try {
    await assert.rejects(context.exclusiveLocalControl(async () => { secondRan = true; }), /local_control_busy/);
  } finally { release(); await first; }
  assert.equal(secondRan, false);
});

test('same-key auto mark can continue after an invalidated operation settles', async () => {
  const sent = [];
  const { context } = loadServiceWorker({ fetchImpl: async (_url, options) => {
    sent.push(options?.method || 'GET');
    return { ok: true, status: 200, json: async () => ({ success: true, data: { status: null } }) };
  } });
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let accounts = 0;
  context.activeSyncAccount = async () => { accounts++; if (accounts === 1) { enter(); await delayed; } return { userId: 18 }; };
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 18 } } });
  const state = { recognition: { title: 'Retry Anime' }, sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101, type: 'TV', totalEpisodes: 12,
      releaseStatus: 'FINISHED', completionMetadataReady: true }, player: { episode: 2, watched: true } };
  const old = context.maybeAutoMark(state);
  await entered;
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 19 } } });
  release(); await old;
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 18 } } });
  await context.maybeAutoMark(state);
  assert.equal(accounts, 2);
  assert.deepEqual(sent, ['GET', 'POST']);
});

test('old metadata cleanup cannot release a new same-key reservation', async () => {
  const { context } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  const releases = [];
  const entered = [];
  context.resolveAnimeMatch = async () => new Promise((resolve) => { releases.push(resolve); entered.shift()?.(); });
  const state = { recognition: { title: 'Reserved Anime' }, sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101, completionMetadataReady: false },
    player: { episode: 12, watched: true } };
  const waitForEntry = () => new Promise((resolve) => entered.push(resolve));
  const firstEntered = waitForEntry();
  const first = context.maybeAutoMark(state); await firstEntered;
  await context.handlePopupRequest({ type: 'popup-delete-local-data' });
  const secondEntered = waitForEntry();
  const second = context.maybeAutoMark(state);
  // One queued turn is enough to inspect admission: no timeout is the oracle.
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(releases.length, 2, 'new epoch must admit the same metadata key');
    await secondEntered;
    const reservation = vm.runInContext("completionMetadataRefreshInFlight.get('101:12')", context);
    releases[0]({ status: 'error' }); await first;
    assert.equal(vm.runInContext("completionMetadataRefreshInFlight.get('101:12')", context), reservation);
    await context.maybeAutoMark(state);
    assert.equal(releases.length, 2, 'concurrent current-epoch attempt must collapse');
  } finally {
    releases.forEach((release) => release({ status: 'error' }));
    await Promise.all([first, second]);
  }
  assert.equal(vm.runInContext('completionMetadataRefreshInFlight.size', context), 0);
});

test('tab close restores its own persisted state after a worker restart', async () => {
  const sent = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return { ok: true, status: 204, json: async () => null };
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  await storage.session.set({ 'tab:5': { tabId: 5, navigationToken: 'stored-document',
    pageUrl: 'https://anime.example/watch', sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } } });
  await context.finalizeRemovedTab(5);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].anime_id, 101);
  assert.equal(sent[0].position_sec, 10);
  assert.equal((await storage.session.get('tab:5'))['tab:5'], undefined);
});

test('tab close cannot adopt another tab ID stored under its key', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  let authorizations = 0;
  context.activeSyncAccount = async () => { authorizations++; return { userId: 18 }; };
  await storage.session.set({ 'tab:5': { tabId: 6, sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } } });
  await context.finalizeRemovedTab(5);
  assert.equal(authorizations, 0);
});

test('concurrent same-key auto-mark attempts keep a single current reservation', async () => {
  const { context } = loadServiceWorker({ fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ success: true, data: { status: 'watching' } }) }) });
  let authorizations = 0;
  context.activeSyncAccount = async () => { authorizations++; return { userId: 18 }; };
  const state = { recognition: { title: 'Concurrent Anime' }, sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101, type: 'TV', totalEpisodes: 12,
      releaseStatus: 'FINISHED', completionMetadataReady: true }, player: { episode: 2, watched: true } };
  await Promise.all([context.maybeAutoMark(state), context.maybeAutoMark(state)]);
  assert.equal(authorizations, 1);
  assert.equal(vm.runInContext('autoMarkInFlight.size', context), 0);
});

test('a successful old-account mark cannot suppress the new account same-key check', async () => {
  let reads = 0;
  const { context } = loadServiceWorker({ fetchImpl: async (_url, options) => {
    if (options?.method !== 'POST') reads++;
    return { ok: true, status: 200, json: async () => ({ success: true, data: { status: 'watching' } }) };
  } });
  let userId = 18;
  context.activeSyncAccount = async () => ({ userId });
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: userId } } });
  const state = { recognition: { title: 'Account Anime' }, sourceOrigin: 'https://anime.example',
    match: { status: 'ok', exact: true, animeId: 101, type: 'TV', totalEpisodes: 12,
      releaseStatus: 'FINISHED', completionMetadataReady: true }, player: { episode: 2, watched: true } };
  await context.maybeAutoMark(state);
  userId = 19;
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: userId } } });
  await context.maybeAutoMark(state);
  assert.equal(reads, 2);
});

test('session response binds the newly shown account to a fresh popup capability', async () => {
  const { context } = loadServiceWorker({ fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ success: true, user: { id: 19 } }) }) });
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 18 } } });
  const runtime = await context.handlePopupRequest({ type: 'popup-runtime-info' });
  const session = await context.handlePopupRequest({ type: 'popup-session-info',
    expectedRevision: runtime.payload.localWriteRevision });
  assert.equal(session.payload.user.id, 19);
  assert.equal(typeof session.payload.localWriteRevision, 'string');
  assert.notEqual(session.payload.localWriteRevision, runtime.payload.localWriteRevision);
  const result = await context.handlePopupRequest({ type: 'popup-update-preferences', operation: 'disable-sync',
    expectedRevision: session.payload.localWriteRevision });
  assert.equal(result.status, 200);
});

test('guest session refresh keeps local clear available in the actual popup account renderer', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => ({ ok: false, status: 401,
    json: async () => ({ success: false, error: 'unauthorized' }) }) });
  context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 18 } } });
  const runtime = await context.handlePopupRequest({ type: 'popup-runtime-info' });
  await storage.local.set({ sentinel: 'must-clear' });
  const elements = new Map();
  const popup = vm.createContext({
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    siteBase: 'https://anireko.com', siteLocale: 'ru', stored: {}, SYNC_ACCOUNT_KEY: 'sync-account',
    autoMarkToggle: {}, syncAccountActive: false, currentUserId: null, t: (key) => key,
    localWriteRevision: runtime.payload.localWriteRevision,
    requestBackground: (type) => context.handlePopupRequest({ type, expectedRevision: popup.localWriteRevision }),
  });
  const source = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
  const start = source.indexOf('  async function renderAccount() {');
  const end = source.indexOf('  function setCheck(', start);
  assert.ok(start >= 0 && end > start, 'extract the unchanged production account renderer');
  vm.runInContext(source.slice(start, end), popup);
  await popup.renderAccount();
  assert.notEqual(popup.localWriteRevision, runtime.payload.localWriteRevision);
  assert.equal(popup.autoMarkToggle.disabled, true, 'guest must not gain account sync');
  const result = await popup.requestBackground('popup-delete-local-data');
  assert.equal(result.status, 200);
  assert.equal((await storage.local.get('sentinel')).sentinel, undefined);
});

test('first manual sync after worker restart admits production-shaped persisted tab state', async () => {
  const sent = [];
  const { context, storage } = loadServiceWorker({ fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return { ok: true, status: 204, json: async () => null };
  } });
  context.activeSyncAccount = async () => ({ userId: 18 });
  await storage.session.set({ 'tab:5': { tabId: 5, navigationToken: 'stored-document',
    recognition: { title: 'Restored Anime' }, pageUrl: 'https://anime.example/watch',
    sourceOrigin: 'https://anime.example', match: { status: 'ok', exact: true, animeId: 101 },
    player: { playbackStarted: true, episode: 1, currentTime: 10, duration: 1200 } } });
  const response = await context.syncPopupCurrent({ tabId: 5, expectedUserId: 18 });
  assert.equal(response.status, 200);
  assert.equal(response.payload.progressSynced, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].anime_id, 101);
  assert.equal(sent[0].position_sec, 10);
});

test('popup recovery rejects a persisted state belonging to a different native tab', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  await storage.session.set({ 'tab:5': { tabId: 6 } });
  assert.equal(await context.popupTabState(5), null);
  assert.equal(vm.runInContext("stateByTab['5']", context), undefined);
});

test('popup recovery preserves a sensor publication that wins during the session read', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  let releaseRead;
  storage.session.get = async () => new Promise((resolve) => { releaseRead = resolve; });
  const pending = context.popupTabState(5);
  vm.runInContext("stateByTab['5'] = { tabId: 5, navigationToken: 'new-document' };", context);
  const winner = vm.runInContext("stateByTab['5']", context);
  releaseRead({ 'tab:5': { tabId: 5, navigationToken: 'old-document' } });
  assert.equal(await pending, winner);
  assert.equal(vm.runInContext("stateByTab['5']", context), winner);
});

test('popup recovery cannot admit a late persisted state after account invalidation', async () => {
  const { context, storage } = loadServiceWorker({ fetchImpl: async () => { throw Error('unexpected_network'); } });
  let releaseRead;
  storage.session.get = async () => new Promise((resolve) => { releaseRead = resolve; });
  const pending = context.popupTabState(5);
  vm.runInContext('localWriteBarrier.invalidate();', context);
  releaseRead({ 'tab:5': { tabId: 5 } });
  await assert.rejects(pending, /write_binding_changed/);
  assert.equal(vm.runInContext("stateByTab['5']", context), undefined);
});

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

test('delayed player interaction cannot cross a same-document navigation epoch', async () => {
  const { context, storage } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  context.statusIcon = (size, state) => ({ size, key: context.actionIconRenderKey(state) });
  const now = Date.now();
  const sender = { tab: { id: 10 }, frameId: 0, documentId: 'top-doc' };
  const topContext = {
    topFrame: true,
    documentToken: 'top-token',
    documentId: 'top-doc',
    topOrigin: 'https://anime.example',
    origin: 'https://anime.example',
  };

  await context.updateTabState({
    type: 'page-observed',
    url: 'https://anime.example/watch/old',
    observedAt: now - 2_000,
  }, sender, topContext);
  await context.updateTabState({
    type: 'page-observed',
    url: 'https://anime.example/watch/new',
    observedAt: now,
  }, sender, topContext);

  const frameSender = { tab: { id: 10 }, frameId: 1, documentId: 'player-doc' };
  const frameContext = {
    topFrame: false,
    documentToken: 'player-token',
    documentId: 'player-doc',
    topOrigin: 'https://anime.example',
    origin: 'https://player.example',
  };
  await context.updateTabState({
    type: 'player-interaction',
    interactionKind: 'pointer',
    frameUrl: 'https://player.example/embed',
    observedAt: now,
  }, frameSender, frameContext);

  let stored = (await storage.session.get('tab:10'))['tab:10'];
  assert.equal(stored.playerInteractionAt, undefined);
  assert.equal(stored.lastRejectReason, 'stale_player_interaction');

  await context.updateTabState({
    type: 'player-interaction',
    interactionKind: 'pointer',
    frameUrl: 'https://player.example/embed',
    observedAt: now + 1,
  }, frameSender, frameContext);
  stored = (await storage.session.get('tab:10'))['tab:10'];
  assert.equal(stored.playerInteractionAt, now + 1);
  assert.equal(stored.playerInteractionNavigationAt, now);
  assert.equal(stored.playerInteractionPageUrl, 'https://anime.example/watch/new');
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
    'search-cache-version': 8,
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

test('same-episode tick retains scoped forced metadata without writing the old media event', async () => {
  const transport = completionFetch({ failSearchCount: 0 });
  let releaseSearch; let enteredSearch;
  const entered = new Promise((resolve) => { enteredSearch = resolve; });
  const delayed = new Promise((resolve) => { releaseSearch = resolve; });
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    if (url.includes('/api/search')) { enteredSearch(); await delayed; }
    return transport.fetchImpl(url, init);
  } });
  await bindSyncAccount(storage);
  const state = terminalEpisodeState();
  state.player.currentTime = 260;
  const originalMatch = state.match;
  const pending = context.maybeAutoMark(state);
  await entered;
  state.player = { ...state.player, currentTime: 261 };
  releaseSearch();
  await pending;
  assert.equal(state.match, originalMatch, 'old observation does not publish');
  assert.equal(statusWrites(transport.calls).length, 0, 'old media cannot write');
  await context.maybeAutoMark(state);
  assert.equal(transport.searchAttempts(), 1, 'next current observation consumes this forced result');
  assert.equal(statusWrites(transport.calls).length, 1);
});

test('completion metadata freshness cannot be borrowed by another stale state', async () => {
  let searches = 0;
  const transport = completionFetch({ failSearchCount: 0 });
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
    if (url.includes('/api/search')) {
      searches += 1;
      const payload = freshFinishedSearchPayload();
      payload.data[0].episodes = 13;
      payload.data[0].release_status = 'ONGOING';
      return { ok: true, status: 200, json: async () => payload };
    }
    return transport.fetchImpl(url, init);
  } });
  await bindSyncAccount(storage);
  const first = terminalEpisodeState();
  const second = terminalEpisodeState();
  await context.maybeAutoMark(first);
  await context.maybeAutoMark(second);
  assert.equal(statusWrites(transport.calls).length, 0, 'both states must consume fresh ONGOING metadata');
  assert.equal(second.match.releaseStatus, 'ONGOING');
  assert.equal(searches, 2, 'independent state cannot borrow a boolean freshness proof');
});

for (const change of ['episode', 'document', 'rematch', 'account']) {
  test(`retained completion metadata is rejected after ${change} changes`, async () => {
    const transport = completionFetch({ failSearchCount: 0 });
    let releaseSearch; let enteredSearch;
    const entered = new Promise((resolve) => { enteredSearch = resolve; });
    const delayed = new Promise((resolve) => { releaseSearch = resolve; });
    const { context, storage } = loadServiceWorker({ fetchImpl: async (url, init) => {
      if (url.includes('/api/search')) { enteredSearch(); await delayed; }
      return transport.fetchImpl(url, init);
    } });
    await bindSyncAccount(storage);
    context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 7 } } });
    const state = terminalEpisodeState();
    state.topDocumentId = 'document-a';
    const pending = context.maybeAutoMark(state);
    await entered;
    if (change === 'episode') state.player = { ...state.player, episode: 1 };
    if (change === 'document') state.topDocumentId = 'document-b';
    if (change === 'rematch') state.match = { ...state.match };
    if (change === 'account') context.noteSessionIdentity({ ok: true, payload: { success: true, user: { id: 8 } } });
    const currentMatch = state.match;
    releaseSearch();
    await pending;
    assert.equal(state.match, currentMatch);
    assert.equal(statusWrites(transport.calls).length, 0);
    context.metadataScopeState = state;
    assert.equal(vm.runInContext('completionMetadataResults.has(metadataScopeState)', context), false);
  });
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
    'search-cache-version': 8,
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

test('empty explicit-season search resolves and binds the catalog-confirmed season', async () => {
  const calls = [];
  const title = 'Монолог фармацевта 3 сезон';
  const root = { id: 18555, title: 'Монолог фармацевта', subtitle: 'Kusuriya no Hitorigoto', type: 'TV' };
  const third = { id: 18558, title: 'Монолог фармацевта 3', subtitle: 'Kusuriya no Hitorigoto 3rd Season', type: 'TV', exact_alias_match: true };
  const second = { id: 18557, title: 'Монолог фармацевта 2', subtitle: 'Kusuriya no Hitorigoto 2nd Season', type: 'TV' };
  const rows = { [title]: [], [root.title]: [root, third, second], [third.subtitle]: [third] };
  const { context, storage } = loadServiceWorker({ fetchImpl: async (url) => {
    const query = new URL(url).searchParams.get('q');
    calls.push(query);
    assert.ok(Object.hasOwn(rows, query), `unexpected query: ${query}`);
    return { ok: true, status: 200, json: async () => ({ data: rows[query] }) };
  } });
  await storage.local.set({ 'search-cache-version': 7, 'search-cache': {
    [context.titleSearchKey(title)]: { match: { status: 'none', query: title }, expiresAt: Date.now() + 86400000 },
  } });
  const result = await context.resolveAnimeMatch(title);
  assert.equal(result.status, 'ok');
  assert.equal(result.animeId, third.id);
  assert.equal(result.seasonAlias, true);
  assert.deepEqual(calls, [title, root.title, third.subtitle]);
  const search = await context.popupSearchAnime(title);
  assert.equal(search.payload.candidates[0].animeId, third.id);
  vm.runInContext(`stateByTab['5'] = { recognition: { title: ${JSON.stringify(title)} } }`, context);
  const bound = await context.bindPopupAnime({ tabId: 5, animeId: third.id, query: title });
  assert.equal(bound.ok, true);
  assert.equal(vm.runInContext("stateByTab['5'].match.animeId", context), third.id);
});

test('empty season search never confirms the first or a different season without an exact alias', async () => {
  const root = { id: 1, title: 'Тестовая сага', subtitle: 'Test Saga', type: 'TV' };
  const other = { id: 2, title: 'Тестовая сага 2', subtitle: 'Test Saga 2nd Season', type: 'TV' };
  const { context } = loadServiceWorker({ fetchImpl: async (url) => {
    const query = new URL(url).searchParams.get('q');
    const rows = query === root.title ? [root, other] : [];
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  } });
  const result = await context.resolveAnimeMatch('Тестовая сага 3 сезон');
  assert.equal(result.status, 'ambiguous');
  assert.equal(context.confirmedAnimeMatch(result), false);
  assert.equal(result.animeId, undefined);
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
  assert.equal((await storage.local.get('search-cache-version'))['search-cache-version'], 8);
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

test('cached sole candidate becomes exact when only an intraword hyphen differs', async () => {
  const { fetchImpl, calls } = searchFetch([]);
  const { context, storage } = loadServiceWorker({ fetchImpl });
  const title = 'Мое анти-божественное оружие';
  const wanted = context.titleSearchKey(title);
  await storage.local.set({
    'search-cache-version': 8,
    'search-cache': {
      [wanted]: {
        match: {
          status: 'ambiguous',
          query: title,
          candidates: [{
            animeId: 37259,
            title: 'Моё антибожественное оружие',
            slug: 'wo-de-ni-tian-shen-qi',
            year: 2024,
            type: 'ONA',
            totalEpisodes: 16,
            releaseStatus: 'FINISHED',
            completionMetadataReady: true,
          }],
        },
        expiresAt: Date.now() + 60_000,
      },
    },
  });

  const result = await context.resolveAnimeMatch(title);

  assert.equal(result.status, 'ok');
  assert.equal(result.animeId, 37259);
  assert.equal(result.exact, true);
  assert.equal(result.manual, false);
  assert.equal(calls.length, 0);
});

test('one merely fuzzy catalog result still requires user confirmation', async () => {
  const { fetchImpl } = searchFetch([{
    id: 42,
    title: 'Совсем другое оружие',
    slug: 'other-weapon',
    year: 2024,
    type: 'ONA',
    episodes: 12,
    release_status: 'FINISHED',
  }]);
  const { context } = loadServiceWorker({ fetchImpl });

  const result = await context.resolveAnimeMatch('Мое анти-божественное оружие');

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(Array.from(result.candidates, (candidate) => candidate.animeId), [42]);
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
    tabId: 5,
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
