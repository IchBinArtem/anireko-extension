const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({ Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/activity.js'), 'utf8'), context);
const { calendar, dateKey } = context.AniRekoActivity;

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
