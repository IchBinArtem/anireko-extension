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
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, AbortSignal });
  for (const name of ['api-client.js', 'watch-command-journal.js'])
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
  return { journal: factory.create({ storage, client, authorize }), key: factory.key, data, calls };
}
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
