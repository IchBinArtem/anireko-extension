const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const uuid = '12345678-1234-4234-8234-123456789abc';
const request = { expected_user_id: 1, anime_id: 10, expected_effective_anime_id: 10,
  history_id: uuid, command_id: uuid, command: 'start', expected_version: 0, expected_foreground_generation: 0 };
const binding = { document_id: 'document-1', navigation_token: 'navigation-1', revision: 1 };
const ack = { history_id: uuid, anime_id: 10, foreground: { anime_id: 10, generation: 1, cycle_id: uuid }, state: { anime_id: 10, version: 1 } };
const freshCycle = '22345678-1234-4234-8234-123456789abc';
const copy = (value) => structuredClone(value);
test('Complete admission retains strict original local lineage without changing wire intent or legacy records', async () => {
  const complete = { ...request, command: 'complete', cycle_id: uuid,
    episode: null, position_sec: 1000, duration_sec: 1200, voice: null };
  const subject = fixture();
  const intent = subject.journal.capture('history-command', complete, binding);
  const originalHash = await subject.hash('history-command', intent.request);
  await subject.journal.admit(intent, 'a'.repeat(64));
  assert.equal(intent.binding.media_lineage, undefined, 'captured immutable intent is not rewritten');
  assert.equal(subject.data[subject.key].binding.media_lineage, 'a'.repeat(64));
  assert.deepEqual(subject.data[subject.key].request, complete);
  assert.equal(await subject.hash('history-command', subject.data[subject.key].request), originalHash);
  await subject.journal.deliver(1);
  const wire = JSON.parse(subject.calls[0].init.body);
  assert.deepEqual(wire, { operation: 'command', ...complete });
  assert.equal(wire.media_lineage, undefined);
  assert.equal((await subject.journal.pending()).binding.media_lineage, 'a'.repeat(64));
  const legacy = copy(subject.data); delete legacy[subject.key].binding.media_lineage;
  const old = fixture({ data: legacy });
  assert.equal((await old.journal.pending()).binding.media_lineage, undefined, 'old exact binding stays valid without backfill');
});

test('Complete top context is strict, local-only, immutable and absent in legacy receipts', async () => {
  const complete = { ...request, command: 'complete', cycle_id: uuid,
    episode: null, position_sec: 1000, duration_sec: 1200, voice: null };
  const subject = fixture();
  const intent = subject.journal.capture('history-command', complete, binding);
  await subject.journal.admit(intent, 'a'.repeat(64), 'b'.repeat(64));
  assert.equal(intent.binding.top_context, undefined);
  assert.equal((await subject.journal.pending()).binding.top_context, 'b'.repeat(64));
  await subject.journal.deliver(1);
  assert.deepEqual(JSON.parse(subject.calls[0].init.body), { operation: 'command', ...complete });
  const legacy = copy(subject.data); delete legacy[subject.key].binding.top_context;
  assert.equal((await fixture({ data: legacy }).journal.pending()).binding.top_context, undefined);
  for (const context of [null, '', 'B'.repeat(64), 'b'.repeat(63), {}, 'https://example.org']) {
    const bad = fixture();
    assert.throws(() => bad.journal.admit(bad.journal.capture('history-command', complete, binding),
      undefined, context), /journal_invalid/);
    assert.deepEqual(bad.data, {});
  }
  assert.throws(() => subject.journal.capture('history-command', request,
    { ...binding, top_context: 'b'.repeat(64) }), /journal_invalid/);
});

test('local Complete lineage rejects malformed fields and preserves original capture invalidation', async () => {
  const complete = { ...request, command: 'complete', cycle_id: uuid,
    episode: null, position_sec: 1000, duration_sec: 1200, voice: null };
  for (const lineage of [null, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 42, {}, 'https://player.example/watch']) {
    const subject = fixture();
    assert.throws(() => subject.journal.capture('history-command', complete,
      { ...binding, media_lineage: lineage }), /journal_invalid/);
    const intent = subject.journal.capture('history-command', complete, binding);
    assert.throws(() => subject.journal.admit(intent, lineage), /journal_invalid/);
    assert.deepEqual(subject.data, {});
  }
  const subject = fixture();
  assert.throws(() => subject.journal.capture('history-command', request,
    { ...binding, media_lineage: 'a'.repeat(64) }), /journal_invalid/);
  const intent = subject.journal.capture('history-command', complete, binding);
  subject.journal.invalidate();
  assert.throws(() => subject.journal.admit(intent, 'a'.repeat(64)), /journal_binding_changed/);
  assert.deepEqual(subject.data, {});
});

test('fresh read without authoritative boolean adoption retains acknowledged intent', async () => {
  for (const adoption of [undefined, null, 'false', 0, {}, []]) {
    const data = {};
    const { journal, key } = fixture({ data, fetchImpl: async (_url, init) => ({
      ok: true, status: 200, json: async () => init.method === 'POST' ? ack : {
        user_id: 1, requested_anime_id: 10, effective_anime_id: 10,
        readiness: 'ready', foreground: ack.foreground,
        ...(adoption === undefined ? {} : { history_adopted: adoption }),
      },
    }) });
    await journal.admit(journal.capture('history-command', request, binding));
    assert.equal((await journal.deliver(1)).acknowledged, true);
    assert.equal((await journal.refresh(1)).refreshed, false,
      'missing/unsupported adoption is unknown, not permission to release pending');
    assert.equal(data[key].acknowledged, true);
    assert.equal(data[key].request.command_id, uuid);
  }
});
test('fresh read accepts both authoritative boolean adoption values without inference', async () => {
  for (const adopted of [false, true]) {
    const data = {};
    const { journal, key } = fixture({ data, fetchImpl: async (_url, init) => ({
      ok: true, status: 200, json: async () => init.method === 'POST' ? ack : {
        user_id: 1, requested_anime_id: 10, effective_anime_id: 10,
        readiness: 'ready', foreground: ack.foreground, history_adopted: adopted,
      },
    }) });
    await journal.admit(journal.capture('history-command', request, binding));
    await journal.deliver(1);
    const result = await journal.refresh(1);
    assert.equal(result.refreshed, true);
    assert.equal(result.snapshot.history_adopted, adopted);
    assert.equal(data[key], undefined);
  }
});
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture({ data = {}, fetchImpl, authorize = async () => true, setImpl } = {}) {
  const calls = [];
  const storage = {
    async get(key) { return Object.hasOwn(data, key) ? { [key]: copy(data[key]) } : {}; },
    async set(items) { if (setImpl) await setImpl(items); Object.assign(data, copy(items)); },
    async remove(key) { delete data[key]; },
  };
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, AbortSignal, crypto: require('node:crypto').webcrypto });
  for (const name of ['api-client.js', 'watch-request-hash.js', 'watch-command-journal.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', name), 'utf8'), context);
  const client = context.AniRekoApiClient.create({ baseUrl: 'https://anireko.com', fetchImpl: async (url, init) => {
    calls.push({ url, init, persisted: copy(data) });
    if (fetchImpl) return fetchImpl(url, init);
    const payload = init.method === 'POST'
      ? ack
      : { user_id: 1, requested_anime_id: 10, effective_anime_id: 10, history_adopted: true, readiness: 'ready', foreground: { anime_id: 10, generation: 2, cycle_id: freshCycle } };
    return { ok: true, status: 200, json: async () => payload };
  } });
  const factory = context.AniRekoWatchCommandJournal;
  return { journal: factory.create({ storage, client, authorize }), key: factory.key, data, calls,
    hash: context.AniRekoWatchRequestHash.hash };
}

async function settlementProof(subject, currentUser = 1, outcome = 'not_applied') {
  return { settlement_version: 1, outcome, current_user_id: currentUser,
    history_id: request.history_id, anime_id: request.anime_id, command_id: request.command_id,
    original_operation: 'command', command_kind: request.command,
    request_hash: await subject.hash('history-command', request) };
}

test('only the exact previously stored fence allows a subsequent settlement check', async () => {
  let response;
  const subject = fixture({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => response }) });
  const proof = await settlementProof(subject);
  const { current_user_id, ...fence } = proof;
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  response = { ...fence, request_hash: 'a'.repeat(64) };
  assert.equal((await subject.journal.deliver(1)).fenced, undefined);
  response = fence;
  assert.equal((await subject.journal.deliver(1)).fenced, true);
  response = proof;
  assert.equal((await subject.journal.settle(1)).settled, true);
});

test('explicit settlement persists typed proof before fresh original-root GET, including transfer', async () => {
  const data = {}; let proof;
  const subject = fixture({ data, fetchImpl: async (_url, init) => ({ ok: true, status: 200,
    json: async () => init.method === 'POST' ? proof : {
      user_id: 2, requested_anime_id: 10, effective_anime_id: 10,
      history_adopted: true, readiness: 'ready', foreground: ack.foreground,
    } }) });
  proof = await settlementProof(subject, 2);
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  const original = JSON.stringify(data[subject.key].request);
  assert.equal((await subject.journal.settle(2)).settled, true);
  assert.equal(data[subject.key].version, 2);
  assert.equal(data[subject.key].acknowledged, false);
  assert.deepEqual(data[subject.key].terminalOutcome, proof);
  assert.equal(JSON.stringify(data[subject.key].request), original);
  assert.equal(subject.calls[0].init.headers['X-Anireko-Watch-Expected-User'], '2');
  assert.equal(JSON.parse(subject.calls[0].init.body).expected_user_id, 1);
  assert.equal(JSON.parse(subject.calls[0].init.body).operation, 'settle');
  assert.equal((await subject.journal.refresh(2)).refreshed, true);
  assert.deepEqual(subject.calls[1].persisted[subject.key].terminalOutcome, proof);
  assert.equal(new URL(subject.calls[1].url).searchParams.get('anime_id'), '10');
  assert.equal(data[subject.key], undefined);
});

test('unknown or incorrectly bound settlement proof never upgrades or releases v1', async () => {
  for (const mutation of [p => ({ ...p, outcome: 'unknown' }), p => ({ ...p, request_hash: 'a'.repeat(64) }),
    p => ({ ...p, current_user_id: 2 }), p => ({ ...p, anime_id: 20 }),
    p => ({ ...p, history_id: freshCycle }), p => ({ ...p, command_id: freshCycle }),
    p => ({ ...p, original_operation: 'select' }), p => ({ ...p, command_kind: 'pause' }),
    p => ({ ...p, settlement_version: '1' }), p => ({ ...p, extra: true }), () => ({})]) {
    let proof;
    const subject = fixture({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => proof }) });
    proof = mutation(await settlementProof(subject));
    await subject.journal.admit(subject.journal.capture('history-command', request, binding));
    const original = JSON.stringify(subject.data[subject.key]);
    assert.equal((await subject.journal.settle(1)).settled, false);
    assert.equal(JSON.stringify(subject.data[subject.key]), original);
    await assert.rejects(subject.journal.refresh(1), /journal_unresolved/);
    assert.equal(subject.calls.length, 1);
  }
});

test('proof persistence failure and lost settlement ACK leave exact original pending', async () => {
  for (const lost of [false, true]) {
    let proof; let writes = 0;
    const subject = fixture({ setImpl: async () => { if (++writes > 1) throw new Error('quota'); },
      fetchImpl: async () => { if (lost) throw new Error('lost settlement ACK');
        return { ok: true, status: 200, json: async () => proof }; } });
    proof = await settlementProof(subject);
    await subject.journal.admit(subject.journal.capture('history-command', request, binding));
    const original = JSON.stringify(subject.data[subject.key]);
    await assert.rejects(subject.journal.settle(1), lost ? /lost settlement ACK/ : /quota/);
    assert.equal(JSON.stringify(subject.data[subject.key]), original);
    await assert.rejects(subject.journal.refresh(1), /journal_unresolved/);
  }
});

test('terminal proof survives restart without automatic send and never replays original', async () => {
  const data = {}; let proof;
  const subject = fixture({ data, fetchImpl: async () => ({ ok: true, status: 200, json: async () => proof }) });
  proof = await settlementProof(subject);
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  await subject.journal.settle(1);
  const restarted = fixture({ data });
  assert.equal(restarted.calls.length, 0);
  await restarted.journal.deliver(1);
  assert.equal(restarted.calls.length, 0, 'durable terminal outcome must prevent original execution');
  assert.equal((await restarted.journal.refresh(1)).refreshed, true);
  assert.equal(restarted.calls.length, 1);
  assert.equal(data[restarted.key], undefined);
});

test('proof owner cannot be silently rebound by another login; explicit settlement required', async () => {
  const data = {}; let proof;
  const subject = fixture({ data, fetchImpl: async () => ({ ok: true, status: 200, json: async () => proof }) });
  proof = await settlementProof(subject, 2, 'accepted');
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  await subject.journal.settle(2);
  const restarted = fixture({ data });
  await assert.rejects(restarted.journal.refresh(3), /journal_account_changed/);
  assert.equal(restarted.calls.length, 0);
  assert.equal(data[subject.key].terminalOutcome.current_user_id, 2);
  assert.equal(data[subject.key].request.expected_user_id, 1);
});

test('second transfer requires fresh proof without changing original request or prior outcome', async () => {
  const data = {}; let currentUser = 2; let proof;
  const subject = fixture({ data, fetchImpl: async (_url, init) => ({ ok: true, status: 200,
    json: async () => init.method === 'POST' ? proof : {
      user_id: currentUser, requested_anime_id: 10, effective_anime_id: 10,
      history_adopted: true, readiness: 'ready', foreground: ack.foreground,
    } }) });
  proof = await settlementProof(subject, currentUser, 'accepted');
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  await subject.journal.settle(currentUser);
  const immutable = JSON.stringify(data[subject.key].request);
  currentUser = 3; proof = await settlementProof(subject, currentUser, 'accepted');
  assert.equal((await subject.journal.settle(currentUser)).settled, true);
  assert.equal(subject.calls.length, 2, 'new owner requires explicit server authorization again');
  assert.equal(data[subject.key].terminalOutcome.current_user_id, 3);
  assert.equal(JSON.stringify(data[subject.key].request), immutable);
  assert.equal((await subject.journal.refresh(currentUser)).refreshed, true);
});

test('selection proof binds the entire ordered choice intent and preserves original selection', async () => {
  let proof;
  const subject = fixture({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => proof }) });
  const selection = { expected_user_id: 1, anime_id: 10, expected_effective_anime_id: 10,
    history_id: uuid, command_id: uuid, cycle_id: null, reconciliation_token: 'b'.repeat(64),
    choices: [{ history_id: uuid, anime_id: 20, cycle_id: freshCycle }] };
  const intent = subject.journal.capture('history-select', selection, binding);
  proof = { settlement_version: 1, outcome: 'not_applied', current_user_id: 2,
    history_id: uuid, anime_id: 10, command_id: uuid, original_operation: 'select', command_kind: 'select',
    request_hash: await subject.hash('history-select', selection) };
  await subject.journal.admit(intent);
  assert.equal((await subject.journal.settle(2)).settled, true);
  assert.deepEqual(subject.data[subject.key].request, selection);
  const wire = JSON.parse(subject.calls[0].init.body); delete wire.operation;
  assert.deepEqual(wire, selection);
});

test('malformed persisted v2 proof fails closed even when a different current owner asks to settle', async () => {
  let proof;
  const subject = fixture({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => proof }) });
  proof = await settlementProof(subject, 2);
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  await subject.journal.settle(2);
  subject.data[subject.key].terminalOutcome.request_hash = 'a'.repeat(64);
  const before = subject.calls.length;
  await assert.rejects(subject.journal.settle(3), /journal_invalid/);
  assert.equal(subject.calls.length, before, 'corrupt terminal journal is not repaired or sent');
});

test('HTTP errors with apparently valid proof and failed fresh read retain pending', async () => {
  for (const status of [401, 409, 429, 500]) {
    let proof;
    const subject = fixture({ fetchImpl: async () => ({ ok: false, status, json: async () => proof }) });
    proof = await settlementProof(subject);
    await subject.journal.admit(subject.journal.capture('history-command', request, binding));
    assert.equal((await subject.journal.settle(1)).settled, false);
    assert.equal(subject.data[subject.key].version, 1);
  }
  let proof; let allowGet = false;
  const subject = fixture({ fetchImpl: async (_url, init) => ({ ok: init.method === 'POST' || allowGet,
    status: init.method === 'POST' || allowGet ? 200 : 409, json: async () => init.method === 'POST' ? proof : {} }) });
  proof = await settlementProof(subject);
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  await subject.journal.settle(1);
  assert.equal((await subject.journal.refresh(1)).refreshed, false);
  assert.equal(subject.data[subject.key].version, 2);
  allowGet = true;
  assert.equal((await subject.journal.refresh(1)).refreshed, false, 'malformed 200 read also stays pending');
  assert.deepEqual(subject.data[subject.key].terminalOutcome, proof);
});

test('late settlement proof after epoch change cannot persist or publish', async () => {
  const entered = deferred(); const gate = deferred(); let proof;
  const subject = fixture({ fetchImpl: async () => { entered.resolve(); await gate.promise;
    return { ok: true, status: 200, json: async () => proof }; } });
  proof = await settlementProof(subject);
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  const settling = subject.journal.settle(1); await entered.promise;
  subject.journal.invalidate(); gate.resolve();
  await assert.rejects(settling, /journal_binding_changed/);
  assert.equal(subject.data[subject.key].version, 1);
});

test('predecessor journal cannot downgrade or hide settled pending behind a new key', async () => {
  const data = {}; let proof;
  const subject = fixture({ data, fetchImpl: async () => ({ ok: true, status: 200, json: async () => proof }) });
  proof = await settlementProof(subject);
  await subject.journal.admit(subject.journal.capture('history-command', request, binding));
  await subject.journal.settle(1);
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/api-client.js'), 'utf8'), context);
  // Actual frozen v1 producer at 6a8effe; inline fixture avoids a mutable Local
  // dependency or requiring private server source in public tests.
  const predecessor = "(function initWatchCommandJournal(global) {\r\n  const KEY = 'watch-command-pending-v1';\r\n  const MAX_BYTES = 70000;\r\n  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;\r\n  const id = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;\r\n  const version = (value) => Number.isSafeInteger(value) && value >= 0;\r\n  function foreground(value) {\r\n    return value && id(value.anime_id) && version(value.generation)\r\n      && (value.cycle_id === null || (typeof value.cycle_id === 'string' && UUID.test(value.cycle_id)));\r\n  }\r\n  const clone = (value) => JSON.parse(JSON.stringify(value));\r\n  function freeze(value) {\r\n    if (value && typeof value === 'object') {\r\n      Object.values(value).forEach(freeze);\r\n      Object.freeze(value);\r\n    }\r\n    return value;\r\n  }\r\n  function exact(value, fields) {\r\n    if (!value || typeof value !== 'object' || Array.isArray(value)\r\n      || Object.keys(value).length !== fields.length\r\n      || fields.some((key) => !Object.hasOwn(value, key))) throw new Error('journal_invalid');\r\n  }\r\n  function capture(action, request, binding) {\r\n    exact(binding, ['document_id', 'navigation_token', 'revision']);\r\n    for (const key of ['document_id', 'navigation_token']) {\r\n      if (typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 256)\r\n        throw new Error('journal_invalid');\r\n    }\r\n    if (!Number.isSafeInteger(binding.revision) || binding.revision < 0) throw new Error('journal_invalid');\r\n    const record = { version: 1, action,\r\n      request: global.AniRekoApiClient.historyIntent(action, request), binding: clone(binding), acknowledged: false };\r\n    if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_BYTES) throw new Error('journal_full');\r\n    return freeze(record);\r\n  }\r\n  function storedRecord(value) {\r\n    exact(value, ['version', 'action', 'request', 'binding', 'acknowledged']);\r\n    if (value.version !== 1 || typeof value.acknowledged !== 'boolean') throw new Error('journal_invalid');\r\n    const normalized = capture(value.action, value.request, value.binding);\r\n    // Reject malformed persisted bytes; never repair or evict an unresolved intent.\r\n    if (JSON.stringify(normalized.request) !== JSON.stringify(value.request)) throw new Error('journal_invalid');\r\n    return { ...clone(normalized), acknowledged: value.acknowledged };\r\n  }\r\n  function create({ storage, client, authorize }) {\r\n    let queue = Promise.resolve();\r\n    let epoch = 0;\r\n    let closed = false;\r\n    const captures = new WeakMap();\r\n    function serial(fn) {\r\n      const next = queue.catch(() => {}).then(fn);\r\n      queue = next;\r\n      return next;\r\n    }\r\n    function current(expectedEpoch) {\r\n      if (closed || epoch !== expectedEpoch) throw new Error('journal_binding_changed');\r\n    }\r\n    async function read() {\r\n      const data = await storage.get(KEY);\r\n      return Object.hasOwn(data, KEY) ? storedRecord(data[KEY]) : null;\r\n    }\r\n    async function account(record, userId, expectedEpoch) {\r\n      current(expectedEpoch);\r\n      if (userId !== record.request.expected_user_id || await authorize(userId) !== true)\r\n        throw new Error('journal_account_changed');\r\n      current(expectedEpoch);\r\n    }\r\n    return Object.freeze({\r\n      // Capture is synchronous. Caller must capture the event BEFORE any async gate.\r\n      capture(action, request, binding) {\r\n        const intent = capture(action, request, binding);\r\n        captures.set(intent, epoch);\r\n        return intent;\r\n      },\r\n      pending() { return serial(async () => { const value = await read(); return value && freeze(clone(value)); }); },\r\n      admit(intent) {\r\n        const captured = storedRecord(intent);\r\n        if (captured.acknowledged) throw new Error('journal_invalid');\r\n        const admittedEpoch = captures.get(intent);\r\n        current(admittedEpoch);\r\n        return serial(async () => {\r\n          current(admittedEpoch);\r\n          const existing = await read();\r\n          current(admittedEpoch);\r\n          if (existing) throw new Error('journal_full');\r\n          await storage.set({ [KEY]: captured });\r\n          current(admittedEpoch);\r\n          return freeze(clone(captured));\r\n        });\r\n      },\r\n      // Explicit retry only; UUID/body/CAS never change. No startup replay/timer.\r\n      deliver(userId) {\r\n        const admittedEpoch = epoch;\r\n        return serial(async () => {\r\n          current(admittedEpoch);\r\n          const record = await read();\r\n          if (!record) throw new Error('journal_empty');\r\n          await account(record, userId, admittedEpoch);\r\n          if (record.acknowledged) return { acknowledged: true };\r\n          const response = await client.request(record.action, clone(record.request));\r\n          current(admittedEpoch);\r\n          const payload = response?.payload;\r\n          const resultIds = record.request.command === 'start'\r\n            ? [record.request.anime_id, record.request.expected_effective_anime_id] : [record.request.anime_id];\r\n          if (response?.ok !== true || response.status !== 200\r\n            || payload?.history_id !== record.request.history_id\r\n            || !id(payload.anime_id) || !foreground(payload.foreground)\r\n            || payload.foreground.anime_id !== record.request.expected_effective_anime_id\r\n            || (record.action === 'history-command'\r\n              ? !resultIds.includes(payload.anime_id) || payload.state?.anime_id !== payload.anime_id || !version(payload.state.version)\r\n              : payload.snapshot?.user_id !== userId || !foreground(payload.snapshot.foreground))) {\r\n            return { acknowledged: false, response };\r\n          }\r\n          await storage.set({ [KEY]: { ...record, acknowledged: true } });\r\n          current(admittedEpoch);\r\n          // The historical receipt is deliberately NOT published as current state.\r\n          return { acknowledged: true };\r\n        });\r\n      },\r\n      refresh(userId) {\r\n        const admittedEpoch = epoch;\r\n        return serial(async () => {\r\n          current(admittedEpoch);\r\n          const record = await read();\r\n          if (!record?.acknowledged) throw new Error('journal_unresolved');\r\n          await account(record, userId, admittedEpoch);\r\n          const response = await client.request('history-read', {\r\n            anime_id: record.request.anime_id, expected_user_id: userId,\r\n          });\r\n          current(admittedEpoch);\r\n          const value = response?.payload;\r\n          if (response?.ok !== true || response.status !== 200 || value?.user_id !== userId\r\n            || value.requested_anime_id !== record.request.anime_id\r\n            || typeof value.history_adopted !== 'boolean'\r\n            || !id(value.effective_anime_id) || !foreground(value.foreground)\r\n            || !['ready', 'reconciliation_required'].includes(value.readiness)) {\r\n            return { refreshed: false, response };\r\n          }\r\n          await storage.remove(KEY);\r\n          current(admittedEpoch);\r\n          // Caller still verifies foreground/document/revision before event admission.\r\n          return { refreshed: true, snapshot: value };\r\n        });\r\n      },\r\n      invalidate() { epoch++; },\r\n      closeAndClear() {\r\n        closed = true;\r\n        epoch++;\r\n        // Drain previously started storage writes before deletion. Server COMMIT\r\n        // may already have happened; clearing local data does not claim cancellation.\r\n        return serial(() => storage.remove(KEY));\r\n      },\r\n    });\r\n  }\r\n  global.AniRekoWatchCommandJournal = Object.freeze({ create, capture, key: KEY });\r\n})(typeof globalThis !== 'undefined' ? globalThis : self);\r\n";
  vm.runInContext(predecessor, context);
  let sends = 0;
  const old = context.AniRekoWatchCommandJournal;
  assert.equal(old.key, subject.key);
  const journal = old.create({ storage: { get: async key => ({ [key]: copy(data[key]) }) },
    client: { request: async () => { sends++; } }, authorize: async () => true });
  await assert.rejects(journal.pending(), /journal_invalid/);
  await assert.rejects(journal.deliver(1), /journal_invalid/);
  assert.equal(sends, 0);
  assert.equal(data[subject.key].version, 2);
});
test('persist before actual client fetch; fresh GET, never receipt, closes pending', async () => {
  const { journal, key, data, calls } = fixture();
  await journal.admit(journal.capture('history-command', request, binding));
  assert.equal(calls.length, 0);
  assert.equal((await journal.deliver(1)).acknowledged, true);
  assert.equal(calls[0].persisted[key].request.command_id, uuid);
  assert.ok(data[key], 'ACK alone does not release admission');
  const fresh = await journal.refresh(1);
  assert.equal(fresh.snapshot.foreground.cycle_id, freshCycle);
  assert.equal(data[key], undefined);
  assert.equal(calls.length, 2);
});
test('lost ACK and VM restart preserve byte-identical UUID, CAS and body', async () => {
  const data = {}; let applied = 0; const receipts = new Map(); const bodies = [];
  const server = async (_url, init) => {
    bodies.push(init.body);
    const command = JSON.parse(init.body);
    if (!receipts.has(command.command_id)) {
      applied++; receipts.set(command.command_id, ack);
      throw new Error('ACK lost after synthetic commit');
    }
    return { ok: true, status: 200, json: async () => receipts.get(command.command_id) };
  };
  const first = fixture({ data, fetchImpl: server });
  await first.journal.admit(first.journal.capture('history-command', request, binding));
  await assert.rejects(first.journal.deliver(1), /ACK lost/);
  const restarted = fixture({ data, fetchImpl: server });
  assert.equal(restarted.calls.length, 0, 'startup never sends');
  await restarted.journal.deliver(1);
  assert.equal(applied, 1, 'synthetic receipt server, not PostgreSQL acceptance');
  assert.equal(bodies[0], bodies[1]);
});
test('one unresolved intent globally, never CAS-rebase or pending eviction', async () => {
  const { journal, data, key, calls } = fixture();
  await journal.admit(journal.capture('history-command', request, binding));
  const original = JSON.stringify(data[key]);
  await assert.rejects(journal.admit(journal.capture('history-command', { ...request, expected_version: 1 }, binding)), /journal_full/);
  assert.equal(JSON.stringify(data[key]), original);
  assert.equal(calls.length, 0);
});
test('capture is detached and immutable before asynchronous admission', async () => {
  const { journal, calls } = fixture(); const mutable = { ...request }; const document = { ...binding };
  const intent = journal.capture('history-command', mutable, document);
  mutable.expected_user_id = 2; mutable.anime_id = 99; document.navigation_token = 'new';
  await journal.admit(intent); await journal.deliver(1);
  const wire = JSON.parse(calls[0].init.body);
  assert.equal(wire.expected_user_id, 1); assert.equal(wire.anime_id, 10);
  assert.equal((await journal.pending()).binding.navigation_token, 'navigation-1');
  assert.equal(Object.isFrozen(intent.request), true);
});
test('persist failure prevents sends; persisted poison is retained and fail-closed', async () => {
  const failed = fixture({ setImpl: async () => { throw new Error('quota'); } });
  await assert.rejects(failed.journal.admit(failed.journal.capture('history-command', request, binding)), /quota/);
  await assert.rejects(failed.journal.deliver(1), /journal_empty/);
  assert.equal(failed.calls.length, 0);
  const poisoned = fixture(); poisoned.data[poisoned.key] = { url: 'synthetic' };
  await assert.rejects(poisoned.journal.deliver(1), /journal_invalid/);
  assert.equal(poisoned.data[poisoned.key].url, 'synthetic'); assert.equal(poisoned.calls.length, 0);
});
test('different account never rewrites or sends pending intent', async () => {
  const { journal, calls } = fixture();
  await journal.admit(journal.capture('history-command', request, binding));
  await assert.rejects(journal.deliver(2), /journal_account_changed/);
  assert.equal(calls.length, 0); assert.equal((await journal.pending()).request.expected_user_id, 1);
});
test('identity fence during authorization stops egress', async () => {
  const entered = deferred(); const gate = deferred();
  const { journal, calls } = fixture({ authorize: async () => { entered.resolve(); await gate.promise; return true; } });
  await journal.admit(journal.capture('history-command', request, binding));
  const send = journal.deliver(1); await entered.promise;
  journal.invalidate(); gate.resolve(); await assert.rejects(send, /journal_binding_changed/);
  assert.equal(calls.length, 0);
});
test('late ACK after close cannot resurrect local journal', async () => {
  const entered = deferred(); const gate = deferred();
  const { journal, data, key } = fixture({ fetchImpl: async () => {
    entered.resolve(); await gate.promise;
    return { ok: true, status: 200, json: async () => ack };
  } });
  await journal.admit(journal.capture('history-command', request, binding));
  const send = journal.deliver(1); await entered.promise;
  const cleared = journal.closeAndClear(); gate.resolve();
  await assert.rejects(send, /journal_binding_changed/); await cleared;
  assert.equal(data[key], undefined);
  await assert.rejects(journal.deliver(1), /journal_binding_changed/);
});
test('close drains storage write already started before removing journal', async () => {
  const entered = deferred(); const gate = deferred();
  const { journal, data, key } = fixture({ setImpl: async () => { entered.resolve(); await gate.promise; } });
  const admission = journal.admit(journal.capture('history-command', request, binding));
  await entered.promise; const cleared = journal.closeAndClear(); gate.resolve();
  await assert.rejects(admission, /journal_binding_changed/); await cleared;
  assert.equal(data[key], undefined);
});
test('error and malformed ACK never unlock admission', async () => {
  for (const status of [401, 409, 429, 500, 200]) {
    const { journal, data, key } = fixture({ fetchImpl: async () => ({ ok: status === 200, status, json: async () => ({}) }) });
    await journal.admit(journal.capture('history-command', request, binding));
    assert.equal((await journal.deliver(1)).acknowledged, false);
    assert.equal(data[key].acknowledged, false);
    await assert.rejects(journal.refresh(1), /journal_unresolved/);
  }
});
test('byte and field bounds reject synchronously without storage/network', () => {
  const { journal, calls, data } = fixture();
  assert.throws(() => journal.capture('history-command', { ...request, source_url: 'synthetic' }, binding), /payload_invalid/);
  assert.throws(() => journal.capture('history-command', request, { ...binding, navigation_token: 'x'.repeat(257) }), /journal_invalid/);
  const select = { expected_user_id: 1, anime_id: 10, expected_effective_anime_id: 10,
    history_id: uuid, command_id: uuid, cycle_id: null, reconciliation_token: 'a'.repeat(64),
    choices: Array(1000).fill({ anime_id: 10, history_id: uuid, cycle_id: uuid }) };
  assert.throws(() => journal.capture('history-select', select, binding), /payload_invalid/);
  assert.equal(calls.length, 0); assert.deepEqual(data, {});
});

test('start accepts actual resolved canonical or preserved alias receipt without rewriting intent', async () => {
  // ExecuteCommand resolves a fresh alias, but retains an existing alias ledger.
  for (const resultId of [10, 20]) {
    const original = { ...request, anime_id: 20, expected_effective_anime_id: 10 };
    const receipt = { ...ack, anime_id: resultId, state: { anime_id: resultId, version: 1 } };
    const { journal, calls } = fixture({ fetchImpl: async (_url, init) => ({ ok: true, status: 200,
      json: async () => init.method === 'POST' ? receipt : {
        user_id: 1, requested_anime_id: 20, effective_anime_id: 10, history_adopted: true, readiness: 'ready', foreground: ack.foreground,
      } }) });
    await journal.admit(journal.capture('history-command', original, binding));
    assert.equal((await journal.deliver(1)).acknowledged, true);
    assert.equal((await journal.pending()).request.anime_id, 20);
    assert.equal(JSON.parse(calls[0].init.body).anime_id, 20);
    assert.equal((await journal.refresh(1)).refreshed, true);
  }
});

test('canonical relaxation is start-only and bound to observed effective group', async () => {
  for (const [command, resultId, groupId] of [['start', 99, 10], ['start', 10, 99], ['pause', 10, 10]]) {
    const input = { ...request, anime_id: 20, expected_effective_anime_id: 10, command };
    if (command !== 'start') input.cycle_id = uuid;
    const receipt = { ...ack, anime_id: resultId, state: { anime_id: resultId, version: 1 },
      foreground: { ...ack.foreground, anime_id: groupId } };
    const { journal } = fixture({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => receipt }) });
    await journal.admit(journal.capture('history-command', input, binding));
    assert.equal((await journal.deliver(1)).acknowledged, false);
    assert.equal((await journal.pending()).acknowledged, false);
  }
});

test('capture before invalidate is rejected even if admission starts afterward', () => {
  const { journal, calls } = fixture();
  const old = journal.capture('history-command', request, binding);
  journal.invalidate();
  assert.throws(() => journal.admit(old), /journal_binding_changed/);
  assert.equal(calls.length, 0);
});
