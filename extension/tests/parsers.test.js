const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load(relativePath, exportedName) {
  const context = vm.createContext({ console, URL });
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  vm.runInContext(source, context);
  return context[exportedName];
}

const recognition = load('lib/recognition.js', 'AniRekoRecognition');
const progress = load('lib/progress.js', 'AniRekoProgress');

test('parses episode numbers from common label shapes', () => {
  assert.equal(recognition.parseEpisode(['Эпизод №7']), 7);
  assert.equal(recognition.parseEpisode(['2 серия']), 2);
  assert.equal(recognition.parseEpisode(['Серия 12 (1080p)']), 12);
  assert.equal(recognition.parseEpisode(['Episode 3']), 3);
  assert.equal(recognition.parseEpisode(['ep. 5']), 5);
});

test('parses live episode signals from player custom events', () => {
  assert.equal(recognition.episodeFromEventDetail({ episodeNumber: 8 }), 8);
  assert.equal(recognition.episodeFromEventDetail({ episode: { name: '12' } }), 12);
  assert.equal(recognition.episodeFromEventDetail({ episode_number: '5' }), 5);
  assert.equal(recognition.episodeFromEventDetail({ episodeNumber: 'Episode 7' }), null);
  assert.equal(recognition.episodeFromEventDetail({ episodeNumber: 0 }), null);
});

test('parses generic iframe episode messages and rejects unrelated messages', () => {
  assert.equal(recognition.episodeFromPlayerMessage({ eventType: 'selectEpisode', data: '8' }, 1), 8);
  assert.equal(recognition.episodeFromPlayerMessage({
    eventType: 'episodeChangedInFullscreen',
    data: { episodeName: '12' },
  }, 1), 12);
  assert.equal(recognition.episodeFromPlayerMessage({ eventType: 'nextEpisode' }, 8), 9);
  assert.equal(recognition.episodeFromPlayerMessage({ eventType: 'prevEpisode' }, 8), 7);
  assert.equal(recognition.episodeFromPlayerMessage({ eventType: 'timeupdate', data: 77 }, 8), null);
  assert.equal(recognition.episodeFromPlayerMessage({ eventType: 'selectEpisode', data: 'Episode 7' }, 1), null);
});

test('parses an unambiguous episode from a player URL only', () => {
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/season/2?episode=8'), 8);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?EPISODE-NUMBER=12'), 12);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?ep=5&episode=5'), 5);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?seria=3'), 3);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?episode=5&episode=6'), null);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?only_episode=true'), null);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?id=8&season=2&time=170'), null);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch#episode=8'), null);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?episode=0'), null);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?episode=99999'), null);
  assert.equal(recognition.episodeFromPlayerUrl('https://player.example/watch?episode=8.5'), null);
  assert.equal(recognition.episodeFromPlayerUrl('not a URL'), null);
});

test('normalizes explicitly labeled voice controls and rejects selector noise', () => {
  assert.equal(recognition.normalizeVoiceLabel('Озвучка AniDUB (10 эп.)', true), 'AniDUB');
  assert.equal(recognition.normalizeVoiceLabel('Translation: AniTime Voice', true), 'AniTime Voice');
  assert.equal(recognition.normalizeVoiceLabel('AniLibria'), 'AniLibria');
  assert.equal(recognition.normalizeVoiceLabel('Плеер Kodik (10 эп.)', true), '');
  assert.equal(recognition.normalizeVoiceLabel('translations: false', true), '');
  assert.equal(recognition.normalizeVoiceLabel('720', true), '');
});

test('does not misparse episode from unrelated words', () => {
  assert.equal(recognition.parseEpisode(['сериал 1080']), null);
  assert.equal(recognition.parseEpisode(['deep 5 dive']), null);
  assert.equal(recognition.parseEpisode(['september 12']), null);
  assert.equal(recognition.parseEpisode(['смотреть в 720p']), null);
});

test('detects episode markers with word boundaries', () => {
  assert.equal(recognition.hasEpisodeMarker('2 серия'), true);
  assert.equal(recognition.hasEpisodeMarker('Эпизоды'), true);
  assert.equal(recognition.hasEpisodeMarker('сериал'), false);
  assert.equal(recognition.hasEpisodeMarker('deep dive'), false);
  assert.equal(recognition.hasEpisodeMarker('September'), false);
});

test('normalizes titles: episode fragments, prefixes and suffixes', () => {
  assert.equal(recognition.normalizeTitle('Магическая битва 7 серия'), 'Магическая битва');
  assert.equal(recognition.normalizeTitle('Атака титанов — смотреть аниме онлайн'), 'Атака титанов');
  assert.equal(recognition.normalizeTitle('Чёрная кошка и класс ведьм аниме'), 'Чёрная кошка и класс ведьм');
  assert.equal(recognition.normalizeTitle('аниме Наруто'), 'Наруто');
});

test('chooseTitle picks the first meaningful candidate', () => {
  assert.equal(
    recognition.chooseTitle(['', 'Расхититель гробниц аниме', 'fallback']),
    'Расхититель гробниц'
  );
});

test('handles aggregator dual-title with progress block (animevost style)', () => {
  assert.equal(
    recognition.chooseTitle(['Игра лжецов / Liar Game [1-14 из 24+]']),
    'Игра лжецов'
  );
  assert.equal(recognition.normalizeTitle('Наруто [ТВ-1]'), 'Наруто');
  assert.equal(
    recognition.normalizeTitle('Компания «Маги-Люмьер» 2 | AniLiberty'),
    'Компания «Маги-Люмьер» 2'
  );
  // Оба хвоста сразу: pipe снимается первым, потом bracket ($-anchored).
  assert.equal(recognition.normalizeTitle('Наруто [ТВ-1] | AniLiberty'), 'Наруто');
  // Одиночный тайтл без слэша не режется.
  assert.equal(recognition.chooseTitle(['Стальной алхимик']), 'Стальной алхимик');
});

test('calculates progress and the 80 percent threshold', () => {
  assert.equal(progress.calculateProgress(80, 100), 0.8);
  assert.equal(progress.isWatched(79.9, 100), false);
  assert.equal(progress.isWatched(80, 100), true);
  assert.equal(progress.calculateProgress(1, 0), null);
});
