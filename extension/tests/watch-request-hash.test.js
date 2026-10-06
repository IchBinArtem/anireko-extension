const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
// Generated from actual PHP NormalizeRequest/RequestHash and NormalizeSelection
// at backend 7eca1a4c, then compared against WebCrypto; no server source shipped.
const vectors = require('./watch-request-hash-vectors.json');

test('every actual service-worker import is included in release and public source boundaries', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
  const calls = [...source.matchAll(/\bimportScripts\(([\s\S]*?)\);/g)];
  assert.equal(calls.length, 1, 'runtime imports must remain statically inspectable');
  const imports = [...calls[0][1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const readList = name => new Set(fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  const release = readList('release-files.txt'); const publicSource = readList('public-files.txt');
  assert(imports.includes('lib/watch-request-hash.js'));
  for (const name of imports) {
    assert(release.has(name), `release archive missing runtime import: ${name}`);
    assert(publicSource.has(`extension/${name}`), `public source missing runtime import: ${name}`);
    assert(fs.statSync(path.join(root, name)).isFile());
  }
});
function fixture(crypto = webcrypto) {
  const context = { TextEncoder, crypto };
  vm.createContext(context);
  for (const name of ['api-client.js', 'watch-request-hash.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', name), 'utf8'), context);
  }
  return context.AniRekoWatchRequestHash;
}
test('actual PHP producer byte/hash vectors for every original action', async () => {
  const producer = fixture();
  for (const vector of vectors) {
    assert.equal(producer.canonical(vector.action, vector.request), vector.canonical);
    assert.equal(await producer.hash(vector.action, vector.request), vector.hash);
  }
  assert.equal(vectors.length, 37);
});
test('account and key order excluded, omission and choice order retained', () => {
  for (let index = 0; index < 36; index += 2) assert.equal(vectors[index].hash, vectors[index + 1].hash);
  assert.notEqual(vectors[28].hash, vectors[30].hash);
  assert.notEqual(vectors[34].hash, vectors[36].hash);
});
test('line separator counterexample rejects naive JSON stringify as producer', () => {
  const vector = vectors.find((row) => row.canonical.includes('\\u2028'));
  assert(vector);
  assert.notEqual(JSON.stringify(JSON.parse(vector.canonical)), vector.canonical);
  assert.equal(fixture().canonical(vector.action, vector.request), vector.canonical);
});
test('unrepresentable original voice is never repaired or hashed as accepted', async () => {
  const producer = fixture();
  const vector = vectors.find((row) => row.request.command === 'progress');
  for (const voice of ['\ud800', '\udfff']) {
    await assert.rejects(producer.hash(vector.action, { ...vector.request, voice }), /history_hash_invalid/);
  }
  assert.equal(vector.request.voice, null);
});

test('actual PHP dotall voice grammar preserves LF and CRLF in canonical bytes', async () => {
  // Captured from actual backend NormalizeRequest/RequestHash, not a JS oracle.
  const vector = {"action":"history-command","request":{"expected_user_id":1,"anime_id":10,"expected_effective_anime_id":10,"history_id":"12345678-1234-4234-8234-123456789abc","command_id":"12345678-1234-4234-8234-123456789abc","command":"progress","expected_version":0,"expected_foreground_generation":0,"cycle_id":"12345678-1234-4234-8234-123456789abc","episode":1,"position_sec":25,"duration_sec":1200,"voice":"line\nbreak\r\nnext"},"canonical":"{\"history_id\":\"12345678-1234-4234-8234-123456789abc\",\"anime_id\":10,\"expected_effective_anime_id\":10,\"expected_foreground_generation\":0,\"command\":{\"command\":\"progress\",\"command_id\":\"12345678-1234-4234-8234-123456789abc\",\"expected_version\":0,\"cycle_id\":\"12345678-1234-4234-8234-123456789abc\",\"episode\":1,\"position_sec\":25,\"duration_sec\":1200,\"voice\":\"line\\nbreak\\r\\nnext\"}}","hash":"4a73d61f458775e1f7ac44afe84dcfc2ff24f3186b7cb6d302e9c8a11b72f111"};
  assert.equal(fixture().canonical(vector.action, vector.request), vector.canonical);
  assert.equal(await fixture().hash(vector.action, vector.request), vector.hash);
});
test('missing crypto and malformed original intent stay unavailable', async () => {
  await assert.rejects(fixture(null).hash(vectors[0].action, vectors[0].request), /history_hash_unavailable/);
  await assert.rejects(fixture().hash('history-settle', vectors[0].request), /payload_invalid/);
  await assert.rejects(fixture().hash(vectors[0].action, { ...vectors[0].request, operation:'settle' }), /payload_invalid/);
});
