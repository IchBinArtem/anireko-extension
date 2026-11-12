const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({ Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/activity.js'), 'utf8'), context);
const { calendar, dateKey, normalizeProgressMap, accountDays } = context.AniRekoActivity;

function bookmark(watched_at = '2026-10-03T10:00:00Z') {
  return { episode: 2, position_sec: 100, duration_sec: 1200, voice: 'dub', watched_at };
}

test('calendar displays twelve calendar weeks, not the last saved activity dates', () => {
  const now = new Date(2026, 9, 3, 23, 59);
  const cells = calendar({ days: { '2025-10-03': { watchedSeconds: 5000 } } }, now);
  assert.equal(cells.length, 84);
  assert.equal(cells[0].key, '2026-07-12');
  assert.equal(cells.at(-1).key, '2026-10-03');
  assert.equal(cells.at(-1).today, true);
  assert.equal(cells.filter((cell) => cell.today).length, 1);
  assert.equal(cells.every((cell) => cell.seconds === null), true);
});

test('missing and malformed observations stay unknown; recorded zero remains distinct', () => {
  const days = {
    '2026-10-03': { watchedSeconds: 0 },
    '2026-10-02': { watchedSeconds: -4 },
    '2026-10-01': { watchedSeconds: '60' },
    '2026-09-30': { watchedSeconds: NaN },
    '2026-09-29': { watchedSeconds: Infinity },
  };
  const cells = calendar({ days }, new Date(2026, 9, 3), 1);
  assert.equal(cells.at(-1).seconds, 0);
  assert.equal(cells.at(-1).level, 0);
  assert.equal(cells.slice(0, -1).every((cell) => cell.level === null), true);
});

test('activity levels use fixed minute thresholds, independent of another busy day', () => {
  const values = [0, 1, 899, 900, 1800, 3600, 60000];
  const days = Object.fromEntries(values.map((seconds, index) => [
    `2026-10-${String(index + 1).padStart(2, '0')}`, { watchedSeconds: seconds },
  ]));
  const cells = calendar({ days }, new Date(2026, 9, 7), 1);
  assert.deepEqual(Array.from(cells, (cell) => cell.level), [0, 1, 1, 2, 3, 4, 4]);
});

test('local dates remain consecutive through month/year boundaries without UTC slicing', () => {
  const cells = calendar({}, new Date(2027, 0, 1, 0, 5), 1);
  assert.equal(cells[0].key, '2026-12-26');
  assert.equal(cells.at(-1).key, '2027-01-01');
  assert.equal(dateKey(new Date(2026, 9, 3, 0, 5)), '2026-10-03');
});

test('bulk validation rejects invalid snapshots without fabricating progress', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.ok(normalizeProgressMap({}, now));
  assert.ok(normalizeProgressMap({ 1: bookmark() }, now));
  assert.ok(normalizeProgressMap({ 1: bookmark('2026-10-03T10:00:00.123456+00:00') }, now));
  for (const invalid of [
    { 0: bookmark() }, { '01': bookmark() }, { '9007199254740992': bookmark() },
    { 1: { ...bookmark(), position_sec: '0' } }, { 1: { ...bookmark(), episode: 0 } },
    { 1: { ...bookmark(), voice: 'x'.repeat(101) } },
    { 1: { ...bookmark(), title: '😀'.repeat(301) } },
    { 1: bookmark('2026-02-30T10:00:00Z') }, { 1: bookmark('2026-10-03T10:00:00') },
    Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i + 1), bookmark()])),
    JSON.parse('{"__proto__":{}}'),
  ]) assert.equal(normalizeProgressMap(invalid, now), null);
  assert.ok(normalizeProgressMap(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i + 1), bookmark()])), now));
  const getter = { 1: bookmark() };
  Object.defineProperty(getter[1], 'position_sec', { get() { throw Error('getter invoked'); } });
  assert.equal(normalizeProgressMap(getter, now), null);
});

test('future server timestamps keep resume positions but do not create calendar marks', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const progress = { 1: bookmark('2026-10-03T12:00:01Z'), 2: bookmark('2026-10-03T10:00:00Z') };
  const normalized = normalizeProgressMap(progress);
  assert.equal(normalized[1].position_sec, 100);
  const days = accountDays({ userId: 7, byAnime: normalized }, 7, now);
  assert.equal(Object.values(days).flatMap((bucket) => bucket.records).length, 1);
  assert.equal(Object.values(days)[0].records[0].animeId, 2);
});

test('account snapshots are account-bound, replaceable, and never affect local intensity', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const saved = bookmark('2026-10-02T23:30:00-02:00');
  const key = dateKey(new Date(saved.watched_at));
  const cache = { userId: 7, byAnime: { 1: saved, 2: { ...saved, title_ru: 'Название' } } };
  const days = accountDays(cache, 7, now);
  assert.equal(days[key].count, 2);
  assert.equal(days[key].records[1].animeId, 2);
  assert.equal(days[key].records[1].title_ru, 'Название');
  assert.equal(Object.keys(accountDays(cache, 8, now)).length, 0);
  const cells = calendar({ days: { [key]: { watchedSeconds: 42, episodeKeys: ['local'] } } }, now, 12, days);
  const cell = cells.find((item) => item.key === key);
  assert.equal(cell.seconds, 42);
  assert.equal(cell.level, 1);
  assert.equal(cell.accountCount, 2);
  const moved = accountDays({ userId: 7, byAnime: { 1: bookmark('2026-10-01T10:00:00Z') } }, 7, now);
  assert.equal(moved[key], undefined);
});

test('account buckets cap rendering and use local calendar days across DST', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const row = bookmark('2026-11-01T01:30:00-04:00');
  const byAnime = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i + 1), row]));
  const days = accountDays({ userId: 'u', byAnime }, 'u', now);
  const bucket = days[dateKey(new Date(row.watched_at))];
  assert.equal(bucket.count, 33);
  assert.equal(bucket.records.length, 32);
  assert.equal(bucket.partial, true);
  assert.equal(Object.keys(accountDays({ userId: 'u', byAnime: { 1: bookmark('2026-07-01T00:00:00Z') } }, 'u', now)).length, 0);
  const midnight = bookmark('2026-11-01T00:30:00-04:00');
  const midnightDays = accountDays({ userId: 'u', byAnime: { 1: midnight } }, 'u', now);
  assert.equal(midnightDays[dateKey(new Date(midnight.watched_at))].count, 1);
});
