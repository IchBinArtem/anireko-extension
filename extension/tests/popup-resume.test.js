const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

async function render({ match, records, playing = false, bulk = {} }) {
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
    recognition: { title: 'Naruto' },
    stored: { 'watch-history': { records } },
    dateLocale: 'en-US',
    t: (key, value) => value === undefined ? key : `${key}:${value}`,
    loadResumeBulk: async () => ({ byAnime: bulk }),
    document: { getElementById: (id) => elements[id] },
  });
  vm.runInContext(`${source.slice(start, end)}\n globalThis.run = renderResume;`, context);
  await context.run(false);
  return elements.resume;
}

const history = (animeId, position = 600) => ({ animeId, position, episode: 3, lastWatchedAt: 1 });

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
