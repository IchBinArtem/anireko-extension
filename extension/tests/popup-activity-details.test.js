const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('resume follows anime and precedes player, history controls and activity', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.ok(html.indexOf('id="anime-check"') < html.indexOf('id="anime-fields"'));
  assert.ok(html.indexOf('id="anime-fields"') < html.indexOf('id="player-check"'));
  assert.ok(html.indexOf('id="anime-fields"') < html.indexOf('id="watch-cycle-card"'));
  assert.ok(html.indexOf('id="anime-fields"') < html.indexOf('id="stats-card"'));
});

test('production activity renderer selects days and preserves selection on refresh', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const start = source.indexOf('  function dateKey(date) {');
  const end = source.indexOf('  const reportSection', start);
  assert.ok(start >= 0 && end > start);
  function element() {
    return { children: [], attrs: {}, events: {}, textContent: '',
      append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(key, fn) { this.events[key] = fn; }, focus() { this.events.focus?.(); } };
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const days = [{ date: yesterday, seconds: 60, level: 1 }, { date: today, seconds: 0, level: 0, today: true }];
  const history = { days: { [key(yesterday)]: { watchedSeconds: 60, episodeKeys: ['x'], detailsPartial: true,
    details: [{ animeId: 101, title: '<unsafe>', episode: 1, voice: 'Voice A', watchedSeconds: 60, position: 12, duration: 1200 },
      { animeId: 101, title: '<unsafe>', episode: 2, voice: 'Voice B', watchedSeconds: 61, position: 55, duration: 900 },
      { animeId: 202, title: '<unsafe>', episode: 3, voice: 'Other ID', watchedSeconds: 60, position: 0, duration: 900 },
      { animeId: null, titleKey: '<unsafe>', title: '<unsafe>', episode: 4, voice: 'Unbound', watchedSeconds: 1, position: 1, duration: 900 },
      { title: 'Second', episode: null, voice: 'Voice B', watchedSeconds: 0, position: 0, duration: 900 },
      { title: 'Short one', episode: 1, watchedSeconds: 1, position: 1, duration: 900 },
      { title: 'Short fifty-nine', episode: 1, watchedSeconds: 59, position: 59, duration: 900 }] },
    [key(today)]: { watchedSeconds: 0, episodeKeys: [] } } };
  const context = vm.createContext({ document: { getElementById: get, createElement: element },
    AniRekoActivity: { calendar: () => days }, dateLocale: 'en-US',
    set: (id, value) => { get(id).textContent = value; }, countLabel: () => '',
    t: (id, value) => value === undefined ? id : `${id}:${value}` });
  const original = JSON.stringify(history);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.render = renderStats;`, context);
  context.render(history);
  assert.equal(get('activity-entries').children[0].textContent, 'activityDetailsUnavailable');
  const chart = get('week-chart');
  assert.equal(chart.children[1].attrs['aria-pressed'], 'true');
  chart.children[0].events.click();
  assert.equal(chart.children[0].attrs['aria-pressed'], 'true');
  assert.equal(get('activity-entries').children[0].textContent, 'activityDetailsPartial');
  assert.equal(get('activity-entries').children[1].children[0].textContent, '<unsafe>');
  assert.equal(get('activity-entries').children[1].children.length, 3, 'same ID has one heading and two observations');
  assert.ok(get('activity-entries').children[1].children[1].children[0].textContent.includes('Voice A'));
  assert.ok(get('activity-entries').children[1].children[2].children[0].textContent.includes('Voice B'));
  assert.equal(get('activity-entries').children[1].children[2].children[1].textContent, 'activityPositionWithDuration:0:55,15:00');
  assert.equal(get('activity-entries').children[2].children[0].textContent, '<unsafe>', 'different ID remains separate');
  assert.equal(get('activity-entries').children.length, 3, 'zero and sub-minute observations are hidden');
  assert.equal(get('activity-entries').children[2].children[1].children[1].textContent, 'activityPositionWithDuration:0:00,15:00');
  context.render(history);
  assert.equal(chart.children[0].attrs['aria-pressed'], 'true');
  assert.equal(chart.children[0].tabIndex, 0);
  assert.ok(get('activity-entries').children[1].children[1].children[0].textContent.includes('Voice A'));
  assert.equal(JSON.stringify(history), original, 'rendering does not write or mutate history');
});

test('account bookmarks add neutral saved-progress details without creating local minutes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const start = source.indexOf('  function dateKey(date) {');
  const end = source.indexOf('  const reportSection', start);
  const elements = new Map();
  function element() {
    return { children: [], attrs: {}, events: {}, textContent: '',
      append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, value) { this.events[key] = value; } };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const fixedTime = new Date(2026, 10, 12, 12).getTime();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  }
  const context = vm.createContext({ Date: Clock, document: { getElementById: get, createElement: element },
    dateLocale: 'en-US', set: (id, value) => { get(id).textContent = value; }, countLabel: () => '',
    t: (id, value) => value === undefined ? id : `${id}:${value}` });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/activity.js'), 'utf8'), context);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.render = renderStats;`, context);
  const now = new Clock();
  const savedAt = new Date(now.getTime() - 1000).toISOString();
  const cache = { userId: 18, byAnime: {
    42: { title: '<unsafe>', episode: 3, voice: 'Voice', position_sec: 1260, duration_sec: 1440, watched_at: savedAt },
    43: { episode: 4, voice: '', position_sec: 0, duration_sec: null, watched_at: savedAt },
  } };
  const local = { days: {} };
  const original = JSON.stringify(local);
  context.render(local, cache, 18);
  const cell = get('week-chart').children.at(-1);
  assert.ok(cell.className.includes('level-unknown'));
  assert.ok(cell.className.includes('account-only'));
  assert.equal(get('today-time').textContent, 'activityUnknown');
  assert.ok(get('activity-legend').textContent.includes('activityAccountLegend'));
  const entries = get('activity-entries').children;
  assert.equal(entries[0].textContent, 'activityAccountNote');
  assert.equal(entries[1].children[0].textContent, '<unsafe>');
  assert.ok(entries[1].children[1].textContent.includes('Voice'));
  assert.equal(entries[1].children[2].textContent, 'activityAccountPositionDuration:21:00,24:00');
  assert.equal(entries[2].children[0].textContent, 'activityAccountAnime:43');
  assert.equal(entries[2].children[2].textContent, 'activityAccountPosition:0:00');
  assert.equal(JSON.stringify(local), original);
  context.render(local, { ...cache, authRejectedUserId: 18, authRejectedStatus: 409 }, 18);
  assert.equal(get('week-chart').children.some(cell => cell.className.includes('has-account-records')), false,
    'server rejection metadata must also hide the popup initial-cache path');
  context.render(local, cache, 19);
  assert.equal(get('week-chart').children.some(cell => cell.className.includes('has-account-records')), false);
  assert.equal(get('activity-entries').children[0].textContent, 'activityDetailsUnavailable');
});
