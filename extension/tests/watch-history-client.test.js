const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../lib/api-client.js'), 'utf8');
const uuid = '12345678-1234-4234-8234-123456789abc';
function fixture() {
  const calls = [];
  const context = { URL, URLSearchParams, TextEncoder, AbortSignal };
  vm.createContext(context); vm.runInContext(source, context);
  const client = context.AniRekoApiClient.create({ baseUrl: 'https://anireko.com', fetchImpl: async (url, init) => {
    calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ accepted: true }) };
  } });
  return { client, calls };
}
const start = { expected_user_id: 1, anime_id: 10, expected_effective_anime_id: 10,
  history_id: uuid, command_id: uuid, command: 'start', expected_version: 0, expected_foreground_generation: 0 };
test('explicit settlement keeps original body and separates current owner header', async () => {
  const { client, calls } = fixture();
  await client.request('history-command', start);
  await client.request('history-settle', { action:'history-command', request:start, current_user_id:2147483647 });
  const original = JSON.parse(calls[0].init.body);
  const settled = JSON.parse(calls[1].init.body);
  assert.deepEqual(settled, { ...original, operation:'settle' });
  assert.equal(settled.expected_user_id, 1);
  assert.equal(calls[1].init.headers['X-Anireko-Watch-Expected-User'], '2147483647');
  assert.equal(calls[1].init.headers['X-Anireko-Watch-History'], '1');
  await client.request('history-command', start);
  assert.equal(calls[2].init.body, calls[0].init.body);
  assert.equal(calls[2].init.headers['X-Anireko-Watch-Expected-User'], undefined);
  for (const delta of [{ current_user_id:'1' }, { current_user_id:0 }, { current_user_id:2147483648 },
    { action:'history-initialize' }, { extra:true }, { request:{...start,operation:'settle'} }]) {
    await assert.rejects(client.request('history-settle', { action:'history-command', request:start, current_user_id:1, ...delta }), /payload_invalid/);
  }
  assert.equal(calls.length, 3);
});
test('component choice cursor has exact four-field owned-root wire tuple', async () => {
  const { client, calls } = fixture();
  const page = { snapshot_token:'a'.repeat(64), after_choice: {
    effective_anime_id:10, anime_id:12, history_id:uuid, cycle_id:uuid,
  } };
  await client.request('history-read', {anime_id:10,expected_user_id:1,page});
  assert.deepEqual(JSON.parse(new URL(calls[0].url).searchParams.get('page')), page);
  for (const delta of [{ effective_anime_id:'10' }, { effective_anime_id:0 },
    { anime_id:2147483648 }, { history_id:'bad' }, { cycle_id:'bad' }, { internal_principal:1 }]) {
    await assert.rejects(client.request('history-read', {anime_id:10,expected_user_id:1,
      page:{...page,after_choice:{...page.after_choice,...delta}}}), /payload_invalid/);
  }
  await assert.rejects(client.request('history-read', {anime_id:10,expected_user_id:1,
    page:{after_choice:page.after_choice}}), /payload_invalid/);
  assert.equal(calls.length, 1);
});
test('fixed history route, immutable envelope and explicit marker', async () => {
  const { client, calls } = fixture();
  await client.request('history-command', start);
  const { url, init } = calls[0];
  assert.equal(url, 'https://anireko.com/api/extension/history.php');
  assert.equal(init.credentials, 'include'); assert.equal(init.cache, 'no-store');
  assert.equal(init.headers['X-Anireko-Watch-History'], '1');
  assert.deepEqual(JSON.parse(init.body), { operation: 'command', ...start });
  await client.request('history-command', start);
  assert.equal(calls[1].init.body, init.body);
});
test('strict identities, CAS and command fields reject before network', async () => {
  const { client, calls } = fixture();
  for (const delta of [{ expected_user_id: '1' }, { anime_id: 2147483648 }, { expected_version: 9007199254740991 },
    { expected_foreground_generation: -1 }, { command_id: uuid.toUpperCase() }, { cycle_id: uuid },
    { operation: 'initialize' }, { url: 'https://elsewhere.invalid' }, { command: 'rewatch' }]) {
    await assert.rejects(client.request('history-command', { ...start, ...delta }), /payload_invalid/);
  }
  assert.equal(calls.length, 0);
});
test('media fields preserve nulls and reject coercion', async () => {
  const { client, calls } = fixture();
  const progress = { ...start, command: 'progress', cycle_id: uuid, episode: null, position_sec: 50, duration_sec: null, voice: null };
  await client.request('history-command', progress);
  assert.deepEqual(JSON.parse(calls[0].init.body), { operation: 'command', ...progress });
  for (const delta of [{ episode: '1' }, { position_sec: 1.1 }, { duration_sec: 0 }, { voice: 'a'.repeat(101) }])
    await assert.rejects(client.request('history-command', { ...progress, ...delta }), /payload_invalid/);
  assert.equal(calls.length, 1);
});
test('selection sends complete 203-choice intent without 2KB truncation', async () => {
  const { client, calls } = fixture();
  const input = { expected_user_id: 1, anime_id: 10, expected_effective_anime_id: 10, history_id: uuid,
    command_id: uuid, cycle_id: null, reconciliation_token: 'a'.repeat(64),
    choices: Array.from({ length: 203 }, (_, i) => ({ history_id: uuid, anime_id: i + 1, cycle_id: uuid })) };
  await client.request('history-select', input);
  assert.equal(JSON.parse(calls[0].init.body).choices.length, 203);
  assert.ok(Buffer.byteLength(calls[0].init.body) > 2048);
  await assert.rejects(client.request('history-select', { ...input, choices: Array(1000).fill(input.choices[0]) }), /payload_invalid/);
  assert.equal(calls.length, 1);
});
test('GET never initializes and page travels only in fixed query', async () => {
  const { client, calls } = fixture();
  await client.request('history-read', { anime_id: 10, expected_user_id: 1, page: { limit: 100 } });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/extension/history.php');
  assert.deepEqual(JSON.parse(url.searchParams.get('page')), { limit: 100 });
  assert.equal(calls[0].init.method, undefined); assert.equal(calls[0].init.body, undefined);
  await client.request('history-initialize', { expected_user_id: 1 });
  assert.deepEqual(JSON.parse(calls[1].init.body), { operation: 'initialize', expected_user_id: 1 });
  await assert.rejects(client.request('history-read', { anime_id: 10, expected_user_id: 1, page: { limit: 101 } }), /payload_invalid/);
  await assert.rejects(client.request('history-initialize', { expected_user_id: 1, history_id: uuid }), /payload_invalid/);
});

test('nested cursors reject extra data before egress', async () => {
  const { client, calls } = fixture();
  const page = { snapshot_token: 'a'.repeat(64), after_cycle: {
    anime_id: 10, history_id: uuid, cycle_id: uuid,
    source_url: 'https://third-party.invalid/watch/private-path?session=synthetic',
  } };
  await assert.rejects(client.request('history-read', { anime_id: 10, expected_user_id: 1, page }), /payload_invalid/);
  assert.equal(calls.length, 0);
});

test('all public next-page cursor shapes roundtrip exactly', async () => {
  const { client, calls } = fixture();
  const token = 'a'.repeat(64);
  const pages = [
    { after_anime_id: 10, after_history_id: uuid, snapshot_token: token },
    { after_evidence: { anime_id: 10, history_id: uuid, evidence_kind: 'watchlist' }, snapshot_token: token },
    { after_legacy: { anime_id: 10, evidence_kind: 'legacy_rating' }, snapshot_token: token },
    { after_cycle: { anime_id: 10, history_id: uuid, cycle_id: uuid }, snapshot_token: token },
    { selected_cycle_id: uuid, limit: 1 },
  ];
  for (const page of pages) {
    await client.request('history-read', { anime_id: 10, expected_user_id: 1, page });
    assert.deepEqual(JSON.parse(new URL(calls.at(-1).url).searchParams.get('page')), page);
  }
});

test('cursor IDs, tokens, enums and required combinations reject without network', async () => {
  const { client, calls } = fixture();
  const token = 'a'.repeat(64);
  for (const page of [
    { snapshot_token: 'invalid' }, { snapshot_token: null }, { selected_cycle_id: 'invalid' },
    { after_anime_id: 10 }, { after_history_id: uuid, snapshot_token: token },
    { after_anime_id: '10', after_history_id: uuid, snapshot_token: token },
    { after_cycle: { anime_id: 10, history_id: uuid, cycle_id: uuid } },
    { after_cycle: { anime_id: 2147483648, history_id: uuid, cycle_id: uuid }, snapshot_token: token },
    { after_evidence: { anime_id: 10, history_id: uuid, evidence_kind: 'unknown' }, snapshot_token: token },
    { after_legacy: { anime_id: 10, evidence_kind: 'watchlist', url: 'synthetic' }, snapshot_token: token },
    { after_legacy: null, snapshot_token: token },
  ]) await assert.rejects(client.request('history-read', { anime_id: 10, expected_user_id: 1, page }), /payload_invalid/);
  assert.equal(calls.length, 0);
});
