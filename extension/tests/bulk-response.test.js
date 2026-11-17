const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function client(response) {
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, AbortSignal });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/api-client.js'), 'utf8'), context);
  return context.AniRekoApiClient.create({ baseUrl: 'https://anireko.com', fetchImpl: async () => response });
}

test('bulk transport reads bounded real response stream and preserves retry admission', async () => {
  const response = await client(new Response('{"progress_all":{}}')).request('progress-all', { expectedUserId: 18 });
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(response.payload), '{"progress_all":{}}');
  const limited = await client(new Response('not json', { status: 429, headers: { 'Retry-After': '600' } }))
    .request('progress-all', { expectedUserId: 18 });
  assert.equal(limited.status, 429);
  assert.equal(limited.payload, null);
  assert.equal(limited.retryAfterMs, 600_000);
});

test('bulk transport caps declared and streamed decompressed bytes before parsing', async () => {
  let declaredCancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }),
    { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } });
  assert.equal((await client(declared).request('progress-all', { expectedUserId: 18 })).payload, null);
  assert.equal(declaredCancelled, true);
  let streamedCancelled = false;
  const streamed = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { streamedCancelled = true; },
  }));
  assert.equal((await client(streamed).request('progress-all', { expectedUserId: 18 })).payload, null);
  assert.equal(streamedCancelled, true);
});

test('invalid UTF-8 and malformed JSON never become a successful empty history', async () => {
  for (const body of [new Uint8Array([0xff]), '{']) {
    const response = await client(new Response(body)).request('progress-all', { expectedUserId: 18 });
    assert.equal(response.payload, null);
  }
});
