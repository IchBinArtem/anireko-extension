const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({ console });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-mark.js'), 'utf8'),
  context
);
const autoMark = context.AniRekoAutoMark;

test('completed is selected only for an authoritative finished final episode', () => {
  const finished = { type: 'TV', totalEpisodes: 12, releaseStatus: 'FINISHED' };
  assert.equal(autoMark.desiredStatus(finished, 12), 'completed');
  assert.equal(autoMark.desiredStatus(finished, 11), 'watching');
  assert.equal(autoMark.desiredStatus({ ...finished, releaseStatus: 'ONGOING' }, 12), 'watching');
  assert.equal(autoMark.desiredStatus({ ...finished, totalEpisodes: null }, 12), 'watching');
  assert.equal(autoMark.desiredStatus({ ...finished, releaseStatus: null }, 12), 'watching');
});

test('a backend-confirmed movie completes after the caller watch threshold', () => {
  assert.equal(autoMark.desiredStatus({ type: 'MOVIE', releaseStatus: 'FINISHED' }, null), 'completed');
});

test('terminal episode decisions refresh catalog metadata once instead of trusting the long cache', () => {
  const finished = {
    type: 'TV', totalEpisodes: 12, releaseStatus: 'FINISHED', completionMetadataReady: true,
  };
  assert.equal(autoMark.needsMetadataRefresh(finished, 11), false);
  assert.equal(autoMark.needsMetadataRefresh(finished, 12), true);
  assert.equal(autoMark.needsMetadataRefresh({ ...finished, releaseStatus: 'ONGOING' }, 12), true);
  assert.equal(autoMark.needsMetadataRefresh({ ...finished, totalEpisodes: null }, 12), true);
  assert.equal(autoMark.needsMetadataRefresh({ ...finished, completionMetadataReady: false }, 2), true);
  assert.equal(autoMark.needsMetadataRefresh({ ...finished, type: 'MOVIE' }, null), false);
});

test('transition matrix promotes watching but preserves manual terminal states', () => {
  for (const existing of [null, 'planned', 'watching']) {
    assert.equal(autoMark.transitionFor(existing, 'completed'), 'completed');
  }
  for (const existing of ['dropped', 'on_hold', 'completed']) {
    assert.equal(autoMark.transitionFor(existing, 'completed'), null);
  }
  assert.equal(autoMark.transitionFor(null, 'watching'), 'watching');
  assert.equal(autoMark.transitionFor('planned', 'watching'), 'watching');
  assert.equal(autoMark.transitionFor('watching', 'watching'), null);
});
